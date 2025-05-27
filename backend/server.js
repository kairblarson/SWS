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
const dataPath = path.resolve("./alertStats.json");

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

function calculateScore(alert) {
  const {
    event = "",
    description = "",
    areaDesc = "",
    onset = "",
    sent = "",
    expires = "",
  } = alert.properties;

  const desc = description.toLowerCase();
  const eventLower = event.toLowerCase();
  const isTornadoWarning =
    eventLower.includes("tornado emergency") ||
    eventLower.includes("particularly dangerous situation") ||
    eventLower.includes("tornado warning");

  // --- Base Score ---
  let baseScore = 0;
  if (eventLower.includes("tornado emergency")) baseScore = 150;
  else if (eventLower.includes("particularly dangerous situation"))
    baseScore = 100;
  else if (eventLower.includes("tornado warning")) baseScore = 25;
  else if (eventLower.includes("severe thunderstorm warning")) baseScore = 10;
  else if (eventLower.includes("tornado watch")) baseScore = 5;
  else return 0; // Skip others (e.g. tornado watch)

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

  // --- Hail Bonus (optional) ---
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

  // --- Conditional Multipliers (Tornado warnings only) ---
  if (isTornadoWarning) {
    // Storm motion
    const motionMatch = desc.match(/moving (at )?(\d{2,3}) ?mph/);
    if (motionMatch) {
      const speed = parseInt(motionMatch[2]);
      if (speed >= 70) baseScore += 20;
      else if (speed >= 50) baseScore += 10;
    }

    // Time of day (nighttime)
    const onsetHour = onset ? new Date(onset).getHours() : null;
    if (onsetHour !== null && (onsetHour < 6 || onsetHour >= 20))
      baseScore += 25;

    // Big cities mentioned
    if (bigCities.some((city) => desc.includes(city))) baseScore += 20;

    // Recency boost
    if (sent) {
      const now = Date.now();
      const sentTime = new Date(sent).getTime();
      const minutesAgo = (now - sentTime) / 60000;
      if (minutesAgo <= 5) baseScore += 10;
    }
  }

  // --- Affected area size ---
  const counties = areaDesc.split(";").length;
  if (counties >= 10) baseScore += 20;
  else if (counties >= 5) baseScore += 10;

  // --- Decay ---
  if (!eventLower.includes("tornado watch") && sent && expires) {
    const now = Date.now();
    const sentTime = new Date(sent).getTime();
    const expiresTime = new Date(expires).getTime();
    const duration = expiresTime - sentTime;
    const elapsed = now - sentTime;
    if (duration > 0 && elapsed > 0) {
      const decaySteps = Math.floor(elapsed / (duration / 10)); // 10% steps
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
    // console.log("DATA: "+JSON.stringify(data));
    if (data.status == 502) {
      console.log("NWS Ran into an error...");
      return;
    }

    //all relevant alerts
    const relevantAlerts = data.features.filter((alert) => {
      const type = alert.properties.event?.toLowerCase();
      return [
        "tornado warning",
        "particularly dangerous situation",
        "tornado emergency",
        "severe thunderstorm warning", //not displayed but does affect score
      ].includes(type);
    });
    //tornado only alerts
    const tornadoSpecificAlerts = data.features.filter((alert) => {
      const type = alert.properties.event?.toLowerCase();
      return [
        "tornado warning",
        "particularly dangerous situation",
        "tornado emergency",
      ].includes(type);
    });

    let score = 0;
    let torEAlerts = 0; //initializes everytime so we dont need to manually reset it

    relevantAlerts.forEach((alert) => {
      score += calculateScore(alert);
      const event = alert.properties.event.toLowerCase();

      if (event.includes("tornado emergency")) {
        torEAlerts++;

        //logic that determines if torE alert has already been sent or not
        //tor e logic needs to be here because we are just using the same loop that calculates the score but we can easily move it out i guess and create another loop
        if (!isTorEActive) {
          console.log("Sending email for a Tornado Emergency...");
          // Generate the dynamic email content
          const emailContent = generateTorEEmailContent(event);

          // Email options
          const mailOptions = {
            from: "kairblarson@gmail.com",
            to: "kairblarson@gmail.com", // The recipient email address
            subject: "Tornado Emergency Issued",
            html: emailContent, // Pass the generated HTML content here
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

    // console.log(generateTornadoOutbreakEmailContent(relevantAlerts)); //REMOVE IN PROD
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
    <h1 style="font-family: Arial, sans-serif; color: #333;">Severe Weather Alert</h1>
    <div style="background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);">
      <h2>Number of tornado related warnings: ${alerts.length}</h2>
      <h2>There is currently a tornado outbreak occuring accross: ${areasAffectedString}</h2>
    </div>
  `;
}

function generateTorEEmailContent(alert) {
  return `
    <h1 style="font-family: Arial, sans-serif; color: #333;">Severe Weather Alert</h1>
    <div style="background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);">
      <h2>Tornado Emergency Issued for: ${alert.properties.areaDesc}</h2>
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
    const event = a.properties.event.toLowerCase();

    if (event.includes("particularly dangerous situation")) {
      stats.pdsTornadoes.push({
        date: a.properties.eventDate,
        eventDetails: a.properties.description,
      });
    }

    if (event.includes("tornado emergency")) {
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
