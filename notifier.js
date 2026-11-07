
const https = require("https");

function sendDiscord(message) {
  return new Promise((resolve) => {
    const webhook = process.env.DISCORD_WEBHOOK_URL;

    if (!webhook) {
      return resolve({
        sent: false,
        error: "Missing DISCORD_WEBHOOK_URL",
      });
    }

    let url;
    try {
      url = new URL(webhook);
      if (
        url.protocol !== "https:" ||
        !["discord.com", "discordapp.com"].includes(url.hostname) ||
        !url.pathname.startsWith("/api/webhooks/")
      ) {
        throw new Error("Invalid Discord webhook URL");
      }
    } catch {
      return resolve({
        sent: false,
        error: "Invalid Discord webhook URL",
      });
    }

    const data = JSON.stringify({
      content: message.slice(0, 2000),
      allowed_mentions: { parse: [] },
    });

    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: 10000,
      },
      (response) => {
        let body = "";
        response.on("data", chunk => body += chunk);
        response.on("end", () => {
          resolve({
            sent: response.statusCode >= 200 &&
                  response.statusCode < 300,
            error: response.statusCode >= 300
              ? `Discord HTTP ${response.statusCode}: ${body.slice(0, 300)}`
              : undefined,
          });
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Discord request timed out"));
    });

    request.on("error", error => {
      resolve({ sent: false, error: error.message });
    });

    request.write(data);
    request.end();
  });
}

function formatProduct(product) {
  const retailer = product.retailer || product.store ||
                   product.source || "Unknown retailer";
  const name = product.name || product.title || "Pokemon product";
  const url = product.url || product.link || "";
  const price = product.price || product.currentPrice || "";

  let message = "🚨 **POKÉMON RESTOCK ALERT** 🚨\n\n" +
                `🏪 ${retailer}\n📦 ${name}`;

  if (price) message += `\n💰 ${price}`;
  if (url) message += `\n🔗 ${url}`;

  return message;
}

async function notify(products) {
  if (!products || products.length === 0) {
    return { discord: { sent: false } };
  }

  let result = { sent: false };

  for (const product of products) {
    result = await sendDiscord(formatProduct(product));
    if (result.error) console.error("Discord:", result.error);
    await new Promise(resolve => setTimeout(resolve, 1200));
  }

  return { discord: result };
}

async function notifyCritical(queueEvent) {
  let message = "🚨🚨 **POKÉMON CENTER QUEUE DETECTED** 🚨🚨\n\n" +
                "Pokémon Center may be preparing for a release or restock.";

  if (queueEvent?.position != null) {
    message += `\n📍 Position: ${queueEvent.position}`;
  }
  if (queueEvent?.waitTime) {
    message += `\n⏱️ Wait: ${queueEvent.waitTime}`;
  }

  return { discord: await sendDiscord(message) };
}

module.exports = {
  notify,
  notifyCritical,
  sendDiscord,
};
