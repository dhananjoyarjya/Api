const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v23.0";

// Serve your existing index.html from the repository root.
app.use(express.static(path.join(__dirname)));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "WhatsApp Inbox backend" });
});

// Meta webhook verification (configure this URL in Meta Developers).
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Incoming messages and delivery/read status notifications.
// This starter logs events to Render logs; persistent chat storage is not set up yet.
app.post("/webhook", (req, res) => {
  console.log("WhatsApp webhook event:", JSON.stringify(req.body));
  res.sendStatus(200);
});

// Send a text message through WhatsApp Cloud API.
// POST /api/messages  JSON: { "to": "91XXXXXXXXXX", "text": "Hello" }
app.post("/api/messages", async (req, res) => {
  try {
    if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
      return res.status(500).json({
        error: "Server setup incomplete. Add WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in Render Environment."
      });
    }

    const to = String(req.body.to || "").replace(/[^\d]/g, "");
    const text = String(req.body.text || "").trim();

    if (!to || !text) {
      return res.status(400).json({ error: 'Send both "to" (country code + number, digits only) and "text".' });
    }

    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: text }
      })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Meta API error:", JSON.stringify(result));
      return res.status(response.status).json({ error: "WhatsApp API request failed", details: result });
    }

    return res.json({ ok: true, result });
  } catch (error) {
    console.error("Send message error:", error);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp Inbox backend running on port ${PORT}`);
});
