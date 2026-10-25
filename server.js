const express = require("express");
const admin = require("firebase-admin");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const API_VERSION = process.env.GRAPH_API_VERSION || "v23.0";

let db = null;

// Firebase Admin initialization
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    );

    admin.initializeApp({
      credential: admin.credential.cert(credentials)
    });

    db = admin.firestore();
    console.log("Firebase connected successfully.");
  } else {
    console.warn("Firebase credentials are missing.");
  }
} catch (error) {
  console.error("Firebase initialization failed:", error.message);
}

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "WhatsApp Inbox Backend",
    firebaseReady: Boolean(db)
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    firebaseReady: Boolean(db),
    whatsappConfigured: Boolean(ACCESS_TOKEN && PHONE_NUMBER_ID)
  });
});

// Meta webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    VERIFY_TOKEN &&
    token === VERIFY_TOKEN
  ) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Save incoming WhatsApp message in Firestore
async function saveIncomingMessage(message, contact) {
  if (!db) return;

  const phone = String(message.from || "");
  if (!phone) return;

  const timestamp = Number(
    message.timestamp || Math.floor(Date.now() / 1000)
  );

  const type = message.type || "unknown";

  let text = "";

  if (type === "text") {
    text = message.text?.body || "";
  } else if (type === "image") {
    text = message.image?.caption || "[Image]";
  } else if (type === "document") {
    text = message.document?.filename || "[Document]";
  } else if (type === "audio") {
    text = "[Audio]";
  } else if (type === "video") {
    text = message.video?.caption || "[Video]";
  } else {
    text = `[${type} message]`;
  }

  const chatRef = db.collection("chats").doc(phone);

  const messageId =
    message.id || `${timestamp}_${Date.now()}`;

  await db.runTransaction(async (transaction) => {
    const chatSnapshot = await transaction.get(chatRef);

    const previous = chatSnapshot.exists
      ? chatSnapshot.data()
      : {};

    transaction.set(
      chatRef,
      {
        phone,
        name:
          contact?.profile?.name ||
          previous.name ||
          phone,
        lastMessage: text,
        lastMessageTimestamp: timestamp,
        unreadCount: Number(previous.unreadCount || 0) + 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    transaction.set(
      chatRef.collection("messages").doc(messageId),
      {
        id: messageId,
        from: phone,
        direction: "in",
        type,
        text,
        timestamp,
        status: "received"
      },
      { merge: true }
    );
  });
}

// Incoming messages webhook
app.post("/webhook", (req, res) => {
  // Acknowledge Meta quickly.
  res.sendStatus(200);

  (async () => {
    try {
      if (
        req.body?.object !== "whatsapp_business_account"
      ) {
        return;
      }

      for (const entry of req.body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          const contacts = value.contacts || [];

          for (const message of value.messages || []) {
            const contact =
              contacts.find(
                (item) => item.wa_id === message.from
              ) ||
              contacts[0] ||
              null;

            await saveIncomingMessage(message, contact);
          }
        }
      }
    } catch (error) {
      console.error("Webhook error:", error);
    }
  })();
});

// Load customer chats
app.get("/api/chats", async (req, res) => {
  if (!db) {
    return res.status(503).json({
      error: "Firebase credentials are not configured."
    });
  }

  try {
    const snapshot = await db
      .collection("chats")
      .orderBy("lastMessageTimestamp", "desc")
      .limit(200)
      .get();

    res.json({
      chats: snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data()
      }))
    });
  } catch (error) {
    console.error("Load chats error:", error);
    res.status(500).json({
      error: "Unable to load chats."
    });
  }
});

// Load messages for a customer
app.get("/api/chats/:phone/messages", async (req, res) => {
  if (!db) {
    return res.status(503).json({
      error: "Firebase credentials are not configured."
    });
  }

  try {
    const phone = req.params.phone.replace(/[^\d]/g, "");

    const snapshot = await db
      .collection("chats")
      .doc(phone)
      .collection("messages")
      .orderBy("timestamp", "asc")
      .limit(500)
      .get();

    res.json({
      messages: snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data()
      }))
    });
  } catch (error) {
    console.error("Load messages error:", error);
    res.status(500).json({
      error: "Unable to load messages."
    });
  }
});

// Mark a chat as read
app.post("/api/chats/:phone/read", async (req, res) => {
  if (!db) {
    return res.status(503).json({
      error: "Firebase is not configured."
    });
  }

  try {
    const phone = req.params.phone.replace(/[^\d]/g, "");

    await db.collection("chats").doc(phone).set(
      { unreadCount: 0 },
      { merge: true }
    );

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({
      error: "Unable to mark chat as read."
    });
  }
});

// Send a WhatsApp text message
app.post("/api/messages", async (req, res) => {
  try {
    if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
      return res.status(500).json({
        error: "WhatsApp API credentials are missing in Render."
      });
    }

    const to = String(req.body.to || "").replace(/[^\d]/g, "");
    const text = String(req.body.text || "").trim();

    if (!to || !text) {
      return res.status(400).json({
        error: 'Both "to" and "text" are required.'
      });
    }

    const response = await fetch(
      `https://graph.facebook.com/${API_VERSION}/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: {
            preview_url: false,
            body: text
          }
        })
      }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error("WhatsApp API error:", result);

      return res.status(response.status).json({
        error: "WhatsApp could not send the message.",
        details: result
      });
    }

    const messageId =
      result.messages?.[0]?.id || `out_${Date.now()}`;

    const timestamp = Math.floor(Date.now() / 1000);

    if (db) {
      const chatRef = db.collection("chats").doc(to);

      await chatRef.set(
        {
          phone: to,
          name: to,
          lastMessage: text,
          lastMessageTimestamp: timestamp,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      await chatRef.collection("messages").doc(messageId).set({
        id: messageId,
        from: PHONE_NUMBER_ID,
        to,
        direction: "out",
        type: "text",
        text,
        timestamp,
        status: "sent"
      });
    }

    res.json({
      ok: true,
      saved: Boolean(db),
      result
    });
  } catch (error) {
    console.error("Send message error:", error);

    res.status(500).json({
      error: "Unexpected server error."
    });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp Inbox running on port ${PORT}`);
});
