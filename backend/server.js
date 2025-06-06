// server.js (Express Backend)
import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import bigCities from "./bigCities.js";
import { JSDOM } from "jsdom";
import { features } from "process";
const dataPath = path.resolve("./alertStats.json");
const riskPath = path.resolve("./risk_snapshot.json");

dotenv.config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_URL = "https://api.weather.gov/alerts/active";
const SEVERE_WEATHER_ALERT_THRESHOLD = 250;
const SEVERE_WEATHER_RESET_THRESHOLD = 200;
let scoreWentBelowSevereWeatherReset = true;
const TORNADO_OUTBREAK_ALERT_THRESHOLD = 5;
const TORNADO_BREAKOUT_RESET_THRESHOLD = 2;
let scoreWentBelowTornadoOutbreakReset = true;
let isTorEActive = false;
let cachedData = { score: 0, alerts: [] };

// Create Nodemailer transporter with Gmail App Password
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_EMAIL,
    pass: process.env.GMAIL_PASSWORD,
  },
});

async function fetchDay1Outlook() {
  try {
    const response = await fetch(
      "https://www.spc.noaa.gov/products/outlook/day1otlk.html"
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // Get the response text
    const data = await response.text();
    const dom = new JSDOM(data);

    // Extract the text within the <pre> tag where the outlook text is located
    const text =
      dom.window.document.querySelector("pre")?.textContent ||
      "No outlook text found";

    // Try matching the general risk level (e.g., "SLIGHT", "ENHANCED")
    const riskMatch = text.match(/THERE IS (?:A|AN) (.+?) RISK OF/i);
    const riskLevel = riskMatch ? riskMatch[1].trim() : "No risk found";

    // Check for tornado risk mentioned in the outlook text (a general mention of tornadoes)
    const tornadoResponse = await fetch(
      "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer/3/query?where=1%3D1&outFields=*&f=geojson"
    );

    const tornadoData = await tornadoResponse.json();

    if (!tornadoData.features.length) {
      console.log("No tornado probability data found.");
      return;
    }

    const probs = tornadoData.features.map((f) => f.properties.dn);
    const tornadoProbability = Math.max(...probs);

    const todaysRisk = await readRiskSnapshot();

    const now = new Date();
    const prev = new Date(todaysRisk.timestamp);
    const isNewDay =
      now.toDateString() !== prev.toDateString() && now.getHours() >= 6;

    if (todaysRisk.risk != riskLevel || isNewDay) {
      console.log("update the file and send email");
      await fs.writeFile(
        riskPath,
        JSON.stringify(
          { risk: riskLevel, timestamp: new Date().toISOString() },
          null,
          2
        )
      );

      //right now we are not saving the probability and sending an email if it does update throughout the day because its assumed if it does update so will
      //the spc outlook so no need to check for both
      const emailContent = generateRiskOutlookContent(
        riskLevel,
        text.substring(0, 200),
        tornadoProbability
      );

      // Email options
      const mailOptions = {
        from: "kairblarson@gmail.com",
        to: "kairblarson@gmail.com", // The recipient email address
        subject: "SPC Day 1 Outlook",
        html: emailContent, // Pass the generated HTML content here
      };

      // Send email with Nodemailer
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.log("Error sending severe weather email:", error);
        } else {
          console.log("Email sent:", info.response);
        }
      });
    }
  } catch (err) {
    console.log("Failed to fetch SPC outlook:", err);
  }
}

//maybe use cape values that are described in mesoscale discussions to determine the potential for the day
function calculateScore(alert) {
  const {
    event = "",
    description = "",
    headline = "",
    areaDesc = "",
    onset = "",
    sent = "",
    expires = "",
  } = alert.properties;

  const desc = description.toLowerCase();
  const head = headline.toLowerCase();
  const eventLower = event.toLowerCase();

  // --- Special Flags from Text ---
  const isTornadoWarning = eventLower.includes("tornado warning");
  const isPDS =
    desc.includes("particularly dangerous situation") ||
    head.includes("particularly dangerous situation");
  const isEmergency =
    desc.includes("tornado emergency") || head.includes("tornado emergency");

  // --- Base Score ---
  let baseScore = 0;
  if (isEmergency) baseScore = 150;
  else if (isPDS) baseScore = 100;
  else if (isTornadoWarning) baseScore = 25;
  else if (eventLower.includes("severe thunderstorm warning")) baseScore = 10;
  else if (eventLower.includes("tornado watch")) baseScore = 5;
  else return 0; // Skip other events

  // --- Confirmation Bonuses (Radar/Observed) ---
  if (desc.includes("radar confirmed") || desc.includes("observed tornado"))
    baseScore += 30;
  if (desc.includes("tornado debris signature") || desc.includes("tds"))
    baseScore += 50;

  // --- Wind Bonus ---
  const windMatch = desc.match(/winds? (up to |near )?(\d{2,3}) ?mph/);
  if (windMatch) {
    const windSpeed = parseInt(windMatch[2]);
    if (windSpeed >= 130) baseScore += 50;
    else if (windSpeed >= 100) baseScore += 25;
    else if (windSpeed >= 70) baseScore += 10;
  }

  // --- Hail Bonus ---
  const hailMatch = desc.match(/hail up to (\d+(\.\d+)?) ?(inch|in)/);
  if (hailMatch) {
    const hail = parseFloat(hailMatch[1]);
    if (hail >= 2) baseScore += 25;
    else if (hail >= 1) baseScore += 10;
  }

  // --- Wedge / Width ---
  if (desc.includes("wedge tornado")) baseScore += 40;
  const widthMatch = desc.match(
    /(width|wide)[^\d]*(\d{1,2}(\.\d+)?)( ?mile|mi)/
  );
  if (widthMatch) {
    const width = parseFloat(widthMatch[2]);
    if (width >= 1) baseScore += 30;
    else if (width >= 0.5) baseScore += 15;
  }

  // --- Conditional Bonuses for Tornado Warnings ---
  if (isTornadoWarning) {
    const motionMatch = desc.match(/moving (at )?(\d{2,3}) ?mph/);
    if (motionMatch) {
      const speed = parseInt(motionMatch[2]);
      if (speed >= 70) baseScore += 20;
      else if (speed >= 50) baseScore += 10;
    }

    const onsetHour = onset ? new Date(onset).getHours() : null;
    if (onsetHour !== null && (onsetHour < 6 || onsetHour >= 20))
      baseScore += 25;

    if (bigCities.some((city) => desc.includes(city))) baseScore += 20;

    if (sent) {
      const now = Date.now();
      const sentTime = new Date(sent).getTime();
      const minutesAgo = (now - sentTime) / 60000;
      if (minutesAgo <= 5) baseScore += 10;
    }
  }

  // --- Affected Area Size ---
  const counties = areaDesc.split(";").length;
  if (counties >= 10) baseScore += 20;
  else if (counties >= 5) baseScore += 10;

  // --- Decay Over Time ---
  if (!eventLower.includes("tornado watch") && sent && expires) {
    const now = Date.now();
    const sentTime = new Date(sent).getTime();
    const expiresTime = new Date(expires).getTime();
    const duration = expiresTime - sentTime;
    const elapsed = now - sentTime;
    if (duration > 0 && elapsed > 0) {
      const decaySteps = Math.floor(elapsed / (duration / 10));
      baseScore = Math.max(0, baseScore - decaySteps);
    }
  }

  return baseScore;
}

async function fetchAlertsAndUpdate() {
  try {
    const response = await fetch(API_URL, {
      headers: {
        "User-Agent": "(severeweatherscore.com, kairblarson@gmail.com)",
      },
    });

    const data = await response.json();
    if (data.status == 502) {
      console.log("NWS Ran into an error...");
      return;
    }

    // All relevant alerts => tornado watch is used for score but not counted/displayed
    const relevantAlerts = data.features.filter((alert) => {
      const event = alert.properties.event?.toLowerCase() || "";
      const description = alert.properties.description?.toLowerCase() || "";

      return (
        event.includes("tornado warning") ||
        event.includes("severe thunderstorm warning") ||
        description.includes("particularly dangerous situation") ||
        description.includes("tornado emergency")
      );
    });

    // Tornado-specific alerts (used for display)
    const tornadoSpecificAlerts = data.features.filter((alert) => {
      const event = alert.properties.event?.toLowerCase() || "";
      const description = alert.properties.description?.toLowerCase() || "";

      return (
        event.includes("tornado warning") ||
        description.includes("particularly dangerous situation") ||
        description.includes("tornado emergency")
      );
    });

    let score = 0;
    let torEAlerts = 0; //initializes everytime so we dont need to manually reset it

    relevantAlerts.forEach((alert) => {
      score += calculateScore(alert);
      const event = alert.properties.event.toLowerCase();

      if (event.includes("tornado emergency")) {
        torEAlerts++;

        //logic that determines if torE alert has already been sent or not
        if (!isTorEActive) {
          console.log("Sending email for a Tornado Emergency...");
          // Generate the dynamic email content
          const emailContent = generateTorEEmailContent(event);

          // Email options
          const mailOptions = {
            from: "kairblarson@gmail.com",
            to: "kairblarson@gmail.com",
            subject: "Tornado Emergency Issued",
            html: emailContent,
          };

          // Send email with Nodemailer
          transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
              console.log("Error sending tor e email:", error);
            } else {
              console.log("Email sent:", info.response);
            }
          });
          isTorEActive = true;
        }
      }
    });

    if (torEAlerts == 0) {
      isTorEActive = false;
    }

    cachedData = { score, alerts: relevantAlerts };
    updateScoreHistory(score);

    await updateStats(relevantAlerts, score);

    if (score < SEVERE_WEATHER_RESET_THRESHOLD) {
      scoreWentBelowSevereWeatherReset = true;
    }

    if (tornadoSpecificAlerts.length < TORNADO_BREAKOUT_RESET_THRESHOLD) {
      scoreWentBelowTornadoOutbreakReset = true;
    }

    if (
      tornadoSpecificAlerts.length >= TORNADO_OUTBREAK_ALERT_THRESHOLD &&
      scoreWentBelowTornadoOutbreakReset
    ) {
      console.log("Sending email for tornado outbreak...");
      // Generate the dynamic email content
      const emailContent = generateTornadoOutbreakEmailContent(
        tornadoSpecificAlerts
      );

      // Email options
      const mailOptions = {
        from: "kairblarson@gmail.com",
        to: "kairblarson@gmail.com", // The recipient email address
        subject: "Tornado Outbreak Alert",
        html: emailContent, // Pass the generated HTML content here
      };

      // Send email with Nodemailer
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.log("Error sending severe weather email:", error);
        } else {
          console.log("Email sent:", info.response);
        }
      });

      scoreWentBelowTornadoOutbreakReset = false;
    } else if (
      score >= SEVERE_WEATHER_ALERT_THRESHOLD &&
      scoreWentBelowSevereWeatherReset
    ) {
      console.log("Sending email for severe weather breakout...");

      // Generate the dynamic email content
      const emailContent = generateSevereWeatherEmailContent(
        score,
        relevantAlerts
      );

      // Email options
      const mailOptions = {
        from: "kairblarson@gmail.com",
        to: "kairblarson@gmail.com", // The recipient email address
        subject: "Severe Weather Alert",
        html: emailContent, // Pass the generated HTML content here
      };

      // Send email with Nodemailer
      transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
          console.log("Error sending severe weather email:", error);
        } else {
          console.log("Email sent:", info.response);
        }
      });

      scoreWentBelowSevereWeatherReset = false;
    }
  } catch (error) {
    console.error("Error fetching alerts:", error);
  }
}

// Read stats from file or create it if missing
async function readStats() {
  try {
    const file = await fs.readFile(dataPath, "utf-8");
    return JSON.parse(file);
  } catch {
    await fs.writeFile(dataPath, JSON.stringify(defaultStats, null, 2));
    return defaultStats;
  }
}

async function readRiskSnapshot() {
  try {
    const file = await fs.readFile(riskPath, "utf-8");
    return JSON.parse(file);
  } catch {
    await fs.writeFile(
      riskPath,
      JSON.stringify(
        { risk: "none", timestamp: new Date().toISOString() },
        null,
        2
      )
    );
    return { risk: "none", timestamp: new Date().toISOString() };
  }
}

// Function to generate HTML email content dynamically
function generateSevereWeatherEmailContent(score, alerts) {
  let areasAffectedString = "";
  const areasAffectedSet = new Set();

  alerts.forEach((alert) => {
    let i = 0;
    let currentAreaString = "";

    for (i; i < alert.properties.areaDesc.length; i++) {
      if (alert.properties.areaDesc[i] == ";") {
        areasAffectedSet.add(currentAreaString.trim());
        currentAreaString = "";
      } else {
        currentAreaString += alert.properties.areaDesc[i];
      }
    }
  });

  [...areasAffectedSet].forEach((area, index) => {
    areasAffectedString += area;

    if (index < areasAffectedSet.size - 1) {
      areasAffectedString += "; ";
    }
  });

  return `
      <h1 style="font-family: Arial, sans-serif; color: #333;">Severe Weather Breakout Alert</h1>
      <div style="background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);">
        <h2>Current Score: ${score}</h2>
        <p>There is currently a severe weather breakout occuring accross: ${areasAffectedString}</p>
      </div>
    `;
}

function generateTornadoOutbreakEmailContent(alerts) {
  let areasAffectedString = "";
  const areasAffectedSet = new Set();

  //this logic is not really necessary but it just formats stuff a little cleaner (no repeats)
  alerts.forEach((alert) => {
    let i = 0;
    let currentAreaString = "";

    for (i; i < alert.properties.areaDesc.length; i++) {
      if (alert.properties.areaDesc[i] == ";") {
        areasAffectedSet.add(currentAreaString.trim());
        currentAreaString = "";
      } else {
        currentAreaString += alert.properties.areaDesc[i];
      }
    }
  });

  [...areasAffectedSet].forEach((area, index) => {
    areasAffectedString += area;

    if (index < areasAffectedSet.size - 1) {
      areasAffectedString += "; ";
    }
  });

  return `
    <div style="background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);">
      <h2>Number of tornado related warnings: ${alerts.length}</h2>
      <h2>There is currently a tornado outbreak occuring accross: ${areasAffectedString}</h2>
    </div>
  `;
}

function generateTorEEmailContent(alert) {
  return `
    <div style="background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);">
      <h2>A Tornado Emergency Issued for: ${alert.properties.areaDesc}</h2>
    </div>
  `;
}

function generateRiskOutlookContent(risk, text, tornadoProbability) {
  let riskTextColor = "black";

  if (risk == "MARGINAL") {
    console.log("Changing color to MARGINAL");
    riskTextColor = "#008000";
  } else if (risk == "SLIGHT") {
    console.log("Changing color to SLIGHT");
    riskTextColor = "#FFFF00";
  } else if (risk == "ENHANCED") {
    console.log("Changing color to ENHANCED");
    riskTextColor = "#FFA500";
  } else if (risk == "MODERATE") {
    console.log("Changing color to MODERATE");
    riskTextColor = "#FF0000";
  } else if (risk == "HIGH") {
    console.log("Changing color to HIGH");
    riskTextColor = "#FF00FF";
  }

  return `
    <div style="background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);">
      <h2>Today's risk outlook is <span style="color: ${riskTextColor}">${risk}</span> with a ${tornadoProbability}% tornado probability</h2>
      <br>
      <h2>${text}</h2>
    </div>
  `;
}

// Update stats based on current alerts and score
async function updateStats(alerts, score) {
  const stats = await readStats(); // Assuming this reads the existing stats

  // Initialize new stats structure if undefined
  if (!stats.pdsTornadoes) stats.pdsTornadoes = [];
  if (!stats.torETornadoes) stats.torETornadoes = [];
  if (!stats.highestScoreEver) stats.highestScoreEver = { date: "", score: 0 };

  // Process alerts
  alerts.forEach((a) => {
    const description = a.properties.description?.toLowerCase() || "";

    if (description.includes("particularly dangerous situation")) {
      stats.pdsTornadoes.push({
        date: a.properties.eventDate,
        eventDetails: a.properties.description,
      });
    }

    if (description.includes("tornado emergency")) {
      stats.torETornadoes.push({
        date: a.properties.eventDate,
        eventDetails: a.properties.description,
      });
    }
  });

  if (score > stats.highestScoreEver.score) {
    stats.highestScoreEver = {
      date: new Date().toISOString(), // Use current date
      score: score,
    };
  }

  // Write the updated stats to the file
  await fs.writeFile(dataPath, JSON.stringify(stats, null, 2)); // Pretty-print the JSON
}

let scoreHistory = [];

function updateScoreHistory(score) {
  const now = Date.now();
  scoreHistory.push({ timestamp: now, score });
  const oneHourAgo = now - 60 * 60 * 1000;
  scoreHistory = scoreHistory.filter((entry) => entry.timestamp >= oneHourAgo);
}

function getMaxScoreLastHour() {
  return Math.max(...scoreHistory.map((entry) => entry.score), 0);
}

// Run every minute
cron.schedule("* * * * *", fetchAlertsAndUpdate);
cron.schedule("* * * * *", fetchDay1Outlook);

// Combined endpoint for score + alerts + historical stats
app.get("/weather-score", async (req, res) => {
  console.log("fetching score...");

  try {
    const stats = await readStats();

    const maxLastHour = getMaxScoreLastHour();

    res.json({
      score: cachedData.score,
      alerts: cachedData.alerts,
      stats,
      history: scoreHistory,
      maxLastHour,
    });
  } catch (err) {
    console.error("Error fetching stats:", err);
    res.status(500).json({ error: "Failed to retrieve stats" });
  }
});

(async () => {
  await fetchAlertsAndUpdate(); // Prime cache once
})();

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
