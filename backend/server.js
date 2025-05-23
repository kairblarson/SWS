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
const ALERT_THRESHOLD = 200;
const RESET_THRESHOLD = 150;
let scoreWentBelowReset = true;
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

//set it up to send an email RIGHT AWAY when a tornado emergency is issued
//maybe add a small score to a tornado watch? like 1-5?

function calculateScore(alert) {
  const {
    event,
    description = "",
    areaDesc = "",
    onset = "",
    sent = "",
  } = alert.properties;

  const desc = description.toLowerCase();
  let baseScore = 0;

  // --- Base event type weighting ---
  if (event.toLowerCase().includes("tornado emergency")) baseScore += 150;
  if (event.toLowerCase().includes("particularly dangerous situation"))
    baseScore += 100;
  if (event.toLowerCase().includes("tornado warning")) baseScore += 25;
  if (event.toLowerCase().includes("severe thunderstorm warning"))
    baseScore += 10;
  if (event.toLowerCase().includes("tornado watch")) return 2; // ignore

  // --- Radar/observed confirmation ---
  if (desc.includes("radar confirmed") || desc.includes("observed tornado"))
    baseScore += 30;
  if (desc.includes("tornado debris signature") || desc.includes("tds"))
    baseScore += 50;

  // --- Wind speed (estimated) ---
  const windMatch = desc.match(/winds? (up to |near )?(\d{2,3}) ?mph/);
  if (windMatch) {
    const windSpeed = parseInt(windMatch[2]);
    if (windSpeed >= 130) baseScore += 50;
    else if (windSpeed >= 100) baseScore += 25;
    else if (windSpeed >= 70) baseScore += 10;
  }

  // --- Tornado size or wedge ---
  if (desc.includes("wedge tornado")) baseScore += 40;
  const widthMatch = desc.match(
    /(width|wide)[^\d]*(\d{1,2}(\.\d+)?)( ?mile|mi)/
  );
  if (widthMatch) {
    const width = parseFloat(widthMatch[2]);
    if (width >= 1) baseScore += 30;
    else if (width >= 0.5) baseScore += 15;
  }

  // --- Storm speed ---
  const motionMatch = desc.match(/moving (at )?(\d{2,3}) ?mph/);
  if (motionMatch) {
    const speed = parseInt(motionMatch[2]);
    if (speed >= 70) baseScore += 20;
    else if (speed >= 50) baseScore += 10;
  }

  // --- Time of day (nighttime tornado) ---
  const onsetHour = onset ? new Date(onset).getHours() : null;
  if (onsetHour !== null && (onsetHour < 6 || onsetHour >= 20)) baseScore += 25;

  // --- Affected area size ---
  const counties = areaDesc.toLowerCase().split(";").length;
  if (counties >= 10) baseScore += 20;
  else if (counties >= 5) baseScore += 10;

  // --- Large cities mentioned ---
  if (bigCities.some((city) => desc.includes(city))) baseScore += 20;

  // --- Time decay ---
  let decay = 0;
  if (sent) {
    const sentTime = new Date(sent);
    const now = new Date();
    const minutesElapsed = Math.floor((now - sentTime) / (1000 * 60));
    decay = Math.max(0, minutesElapsed);
  }

  const finalScore = Math.max(0, baseScore - decay);
  return finalScore;
}

async function fetchAlertsAndUpdate() {
  try {
    const response = await fetch(API_URL, {
      headers: {
        "User-Agent": "(severeweatherscore.com, kairblarson@gmail.com)",
      },
    });

    const data = await response.json();
    const relevantAlerts = data.features.filter((alert) => {
      const type = alert.properties.event?.toLowerCase();
      return [
        "tornado warning",
        "particularly dangerous situation",
        "tornado emergency",
        "severe thunderstorm warning", //not displayed but does affect score
      ].includes(type);
    });

    let score = 0;

    relevantAlerts.forEach((alert) => {
      score += calculateScore(alert);
    });
    cachedData = { score, alerts: relevantAlerts };
    updateScoreHistory(score);

    await updateStats(relevantAlerts, score);

    if (score < RESET_THRESHOLD) {
      scoreWentBelowReset = true;
    }

    if (score >= ALERT_THRESHOLD && scoreWentBelowReset) {
      console.log("Sending email for severe weather breaking...");
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
      scoreWentBelowReset = false;
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

// Function to generate HTML email content dynamically
function generateSevereWeatherEmailContent(score, alerts) {
  const statesAffected = new Set();

  alerts.forEach((alert) => {
    statesAffected.add(
      alert.properties.areaDesc.substring(
        alert.properties.areaDesc.indexOf(",") + 2,
        alert.properties.areaDesc.length
      )
    );
  });

  return `
      <h1 style="font-family: Arial, sans-serif; color: #333;">Severe Weather Breakout Alert</h1>
      <div style="background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);">
        <h2>Current Score: ${score}</h2>
        <p>There is currently a severe weather breakout occuring accross: ${statesAffected}</p>
      </div>
    `;
}

function generateTorEEmailContent(alert) {
  return `
    <h1 style="font-family: Arial, sans-serif; color: #333;">Severe Weather Alert</h1>
    <div style="background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);">
      <h2>Tornado Emergency Issued for ${alert.properties.areaDesc}</h2>
    </div>
  `;
}

// Update stats based on current alerts and score
async function updateStats(alerts, score) {
  const stats = await readStats(); // Assuming this reads the existing stats
  let torEAlerts = 0; //initializes everytime so we dont need to manually reset it

  generateSevereWeatherEmailContent(score, alerts); //HERE FOR TESTING PURPOSES

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
      torEAlerts++;

      stats.torETornadoes.push({
        date: a.properties.eventDate,
        eventDetails: a.properties.description,
      });

      //logic that determines if torE alert has already been sent or not
      if (!isTorEActive) {
        console.log("Sending email for a Tornado Emergency...");
        // Generate the dynamic email content
        const emailContent = generateTorEEmailContent(a.properties.event);

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
  // Update highestScoreEver if the current score is higher
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
