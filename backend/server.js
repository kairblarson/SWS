// server.js (Express Backend)
import express from "express";
import fetch from "node-fetch";
import cron from "node-cron";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
const dataPath = path.resolve("./alertStats.json");

dotenv.config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_URL = "https://api.weather.gov/alerts/active";
const ALERT_THRESHOLD = 400;
const RESET_THRESHOLD = 350;
let lastScore = 0;
let scoreWentBelowReset = true;
let cachedData = { score: 0, alerts: [] };

// Create Nodemailer transporter with Gmail App Password
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_EMAIL,
    pass: process.env.GMAIL_PASSWORD, // Use your generated App Password here
  },
});

// Initial stats JSON structure
const defaultStats = {
  pdsCount: 0,
  torECount: 0,
  highestScore: 0,
};

function calculateScore(alerts) {
  let score = 0;

  alerts.forEach((alert) => {
    const type = alert.properties.event?.toLowerCase() || "";
    const certainty = alert.properties.certainty?.toLowerCase();
    const desc = alert.properties.description?.toLowerCase();

    if (type === "severe thunderstorm warning") score += 2;
    else if (type === "tornado watch") score += 5;
    else if (type === "tornado warning" && certainty === "observed")
      score += 75;
    else if (type === "tornado warning") score += 50;
    else if (type.includes("particularly dangerous")) score += 150;
    else if (type.includes("emergency")) score += 300;
  });

  return score;
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
        "tornado watch",
        "tornado warning",
        "particularly dangerous situation",
        "tornado emergency",
      ].includes(type);
    });

    const score = calculateScore(relevantAlerts);
    cachedData = { score, alerts: relevantAlerts };
    updateScoreHistory(score);

    await updateStats(relevantAlerts, score);

    if (score < RESET_THRESHOLD) {
      scoreWentBelowReset = true;
    }

    if (score >= ALERT_THRESHOLD && scoreWentBelowReset) {
      console.log("Sending email...");
      // Generate the dynamic email content
      const emailContent = generateEmailContent(score, relevantAlerts);

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
          console.log("Error sending email:", error);
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
function generateEmailContent(score, alerts) {
  return `
      <h1 style="font-family: Arial, sans-serif; color: #333;">🚨 Severe Weather Alert</h1>
      <div style="background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);">
        <h2>Current Score: ${score}</h2>
      </div>
    `;
}

// Update stats based on current alerts and score
async function updateStats(alerts, score) {
  const stats = await readStats();

  alerts.forEach((a) => {
    const event = a.properties.event.toLowerCase();
    if (event.includes("particularly dangerous situation")) stats.pdsCount++;
    if (event.includes("tornado emergency")) stats.torECount++;
  });

  if (score > stats.highestScore) stats.highestScore = score;

  await fs.writeFile(dataPath, JSON.stringify(stats, null, 2));
}

let scoreHistory = [];

function updateScoreHistory(score) {
  const now = Date.now();
  scoreHistory.push({ timestamp: now, score });

  // Remove entries older than 1 hour
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

    if (cachedData.alerts.length == 0) {
      await fetchAlertsAndUpdate();
    }
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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
