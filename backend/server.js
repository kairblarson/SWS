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

function calculateScore(alert) {
  const {
    event,
    description = "",
    areaDesc = "",
    onset = "",
  } = alert.properties;
  const desc = description.toLowerCase();
  let score = 0;

  // --- Base event type weighting ---
  if (event.toLowerCase().includes("tornado warning")) score += 50;
  if (event.toLowerCase().includes("tornado emergency")) score += 100;
  if (event.toLowerCase().includes("particularly dangerous situation"))
    score += 100;
  if (event.toLowerCase().includes("severe thunderstorm warning")) return 0; // ignore
  if (event.toLowerCase().includes("tornado Watch")) return 0; // ignore

  // --- Radar/observed confirmation ---
  if (
    desc.toLowerCase().includes("radar confirmed") ||
    desc.toLowerCase().includes("observed tornado")
  )
    score += 30;
  if (
    desc.toLowerCase().includes("tornado debris signature") ||
    desc.toLowerCase().includes("tds")
  )
    score += 50;

  // --- Wind speed (estimated) ---
  const windMatch = desc
    .toLowerCase()
    .match(/winds? (up to |near )?(\d{2,3}) ?mph/);
  if (windMatch) {
    const windSpeed = parseInt(windMatch[2]);
    if (windSpeed >= 130) score += 50;
    else if (windSpeed >= 100) score += 25;
    else if (windSpeed >= 70) score += 10;
  }

  // --- Tornado size or wedge ---
  if (desc.toLowerCase().includes("wedge tornado")) score += 40;
  const widthMatch = desc
    .toLowerCase()
    .match(/(width|wide)[^\d]*(\d{1,2}(\.\d+)?)( ?mile|mi)/);
  if (widthMatch) {
    const width = parseFloat(widthMatch[2]);
    if (width >= 1) score += 30;
    else if (width >= 0.5) score += 15;
  }

  // --- Storm speed ---
  const motionMatch = desc.toLowerCase().match(/moving (at )?(\d{2,3}) ?mph/);
  if (motionMatch) {
    const speed = parseInt(motionMatch[2]);
    if (speed >= 70) score += 20;
    else if (speed >= 50) score += 10;
  }

  // --- Time of day (nighttime tornado) ---
  const onsetHour = onset ? new Date(onset).getHours() : null;
  if (onsetHour !== null && (onsetHour < 6 || onsetHour >= 20)) score += 25;

  // --- Affected area size ---
  const counties = areaDesc.toLowerCase().split(";").length;
  if (counties >= 10) score += 20;
  else if (counties >= 5) score += 10;

  // --- Large cities mentioned ---
  const bigCities = [
    "new york",
    "los angeles",
    "chicago",
    "houston",
    "phoenix",
    "philadelphia",
    "san antonio",
    "san diego",
    "dallas",
    "austin",
    "jacksonville",
    "fort worth",
    "columbus",
    "charlotte",
    "san francisco",
    "indianapolis",
    "seattle",
    "denver",
    "washington",
    "boston",
    "el paso",
    "nashville",
    "detroit",
    "oklahoma city",
    "portland",
    "las vegas",
    "memphis",
    "louisville",
    "baltimore",
    "milwaukee",
    "albuquerque",
    "tucson",
    "fresno",
    "mesa",
    "sacramento",
    "atlanta",
    "kansas city",
    "colorado springs",
    "miami",
    "raleigh",
    "omaha",
    "long beach",
    "virginia beach",
    "oakland",
    "minneapolis",
    "tulsa",
    "arlington",
    "new orleans",
    "wichita",
    "cleveland",
  ];
  if (bigCities.some((city) => desc.includes(city))) score += 20;

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
        "tornado warning",
        "particularly dangerous situation",
        "tornado emergency",
        "severe thunderstorm warning", //do not display these just show a number of how many their are but DO display the rest along with how many their are
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
      <h1 style="font-family: Arial, sans-serif; color: #333;">Severe Weather Alert</h1>
      <div style="background: #fff; padding: 1.5rem; border-radius: 8px; box-shadow: 0 2px 5px rgba(0, 0, 0, 0.1);">
        <h2>Current Score: ${score}</h2>
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
