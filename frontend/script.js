const threshold = 250;

$("#fetchAlerts").click(async function () {
  const apiUrl = "https://api.weather.gov/alerts/active";

  const eventWeights = {
    "severe thunderstorm warning": 10,
    "tornado watch": 20,
    "tornado warning (radar)": 50,
    "tornado warning (observed)": 75,
    "particularly dangerous situation": 150,
    "tornado emergency": 300,
  };

  try {
    const response = await fetch(apiUrl, {
      headers: {
        "User-Agent": "(severeweatherscore.com, kairblarson@gmail.com)",
      },
    });

    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    const data = await response.json();

    const tornadoAlerts = data.features.filter((alert) => {
      const type = alert.properties.event?.trim().toLowerCase();
      return [
        "tornado watch",
        "tornado warning",
        "particularly dangerous situation",
        "tornado emergency",
        "tornado advisory", // Not weighted right now
        "severe thunderstorm warning",
      ].includes(type);
    });

    let totalScore = 0;
    const points = [];

    tornadoAlerts.forEach((alert) => {
      const eventType = alert.properties.event.trim().toLowerCase();
      let key = eventType;

      if (eventType === "tornado warning") {
        const desc = alert.properties.description?.toLowerCase() || "";
        const headline = alert.properties.headline?.toLowerCase() || "";
        const tags = alert.properties.response || [];

        const isObserved =
          desc.includes("tornado...observed") || headline.includes("observed");
        key += isObserved ? " (observed)" : " (radar)";
      }

      const weight = eventWeights[key] || 0;
      totalScore += weight;

      // Collect point for proximity scoring
      if (alert.geometry && alert.geometry.type === "Point") {
        points.push(turf.point(alert.geometry.coordinates));
      } else if (alert.geometry && alert.geometry.type === "Polygon") {
        const centroid = turf.centroid(alert);
        points.push(centroid);
      }
    });

    // Add proximity weighting
    let proximityMultiplier = 1;
    if (points.length > 1) {
      let totalDistance = 0;
      let comparisons = 0;

      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          totalDistance += turf.distance(points[i], points[j]);
          comparisons++;
        }
      }

      const avgDistance = totalDistance / comparisons;
      proximityMultiplier = Math.max(1.1, 100 / avgDistance); // Closer = higher multiplier
      proximityMultiplier = Math.min(proximityMultiplier, 5); // Cap it to avoid absurd scores
    }

    const weightedScore = Math.round(totalScore * proximityMultiplier);

    // if (weightedScore >= threshold) {
    //   emailjs
    //     .send("YOUR_SERVICE_ID", "YOUR_TEMPLATE_ID", {
    //       to_email: "your@email.com",
    //       subject: "🚨 High Severe Weather Score Alert",
    //       message: `Current severe weather score is ${weightedScore}. Tune into radar/live coverage.`,
    //     })
    //     .then(() => {
    //       console.log("Email sent successfully!");
    //     })
    //     .catch((error) => {
    //       console.error("Email sending failed:", error);
    //     });
    // }

    $("#alertData").html(`
        <p><strong>Total Alerts:</strong> ${tornadoAlerts.length}</p>
        <p><strong>Base Score:</strong> ${totalScore}</p>
        <p><strong>Proximity Multiplier:</strong> ${proximityMultiplier.toFixed(
          2
        )}</p>
        <p><strong><span style="color:red;">Final Score:</span></strong> ${weightedScore}</p>
        <pre>${JSON.stringify(
          tornadoAlerts.map((a) => a.properties.event),
          null,
          2
        )}</pre>
      `);
  } catch (error) {
    $("#alertData").text(`Error: ${error.message}`);
  }
});

//Severe Weather Score scoring parameters
//1. Total number of alerts => weight = 5*x (x being number of total number of tornado related events)
//2. Severe thunderstorm warning => weight = 10
//3. Tornado watch => weight: 20
//4. Tornado warning, radar indicated => weight: 50
//5. Tornado warning, observed => weight: 75
//6. PDS => weight: 150
//7. Tor E => weight: 300
