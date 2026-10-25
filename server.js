const express = require("express");
const admin = require("firebase-admin");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

let db = null;

// Initialize Firebase using the service account stored securely in Render.
try {
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

if (serviceAccountJson) {
const serviceAccount = JSON.parse(serviceAccountJson);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

db = admin.firestore();
console.log("Firebase connected");

} else {
console.warn("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
}
} catch (error) {
console.error("Firebase initialization failed:", error.message);
}

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;

function requireDatabase(res) {
if (!db) {
res.status(503).json({
error: "Firebase is not configured on the server"
});
return false;
}
return true;
}

// Serve the inbox website.
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health check.
app.get("/health", (req, res) => {
res.json({
ok: true,
service: "WhatsApp Inbox backend"
});
});

// Frontend connection status.
app.get("/api/status", (req, res) => {
res.json({
firebaseReady: Boolean(db),
whatsappConfigured: Boolean(WHATSAPP_TOKEN && PHONE_NUMBER_ID)
});
});

// Meta webhook verification.
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

// Save an incoming WhatsApp message to Firestore.
async function saveIncomingMessage(message, contact) {
if (!db || !message || !message.from) return;

const phone = String(message.from);
const chatRef = db.collection("chats").doc(phone);
const messageRef = chatRef.collection("messages").doc(
String(message.id || "${Date.now()}_${Math.random()}")
);

let messageText = "";

if (message.type === "text") {
messageText = message.text?.body || "";
} else if (message.type === "button") {
messageText = message.button?.text || "[Button message]";
} else if (message.type === "interactive") {
messageText =
message.interactive?.button_reply?.title ||
message.interactive?.list_reply?.title ||
"[Interactive message]";
} else {
messageText = "[${message.type || "Unknown"} message]";
}

const contactName =
contact?.profile?.name || phone;

const timestamp = message.timestamp
? new Date(Number(message.timestamp) * 1000).toISOString()
: new Date().toISOString();

await db.runTransaction(async transaction => {
const chatSnapshot = await transaction.get(chatRef);
const oldChat = chatSnapshot.exists ? chatSnapshot.data() : {};

transaction.set(chatRef, {
  phone,
  name: contactName,
  lastMessage: messageText,
  lastMessageAt: timestamp,
  unreadCount: Number(oldChat.unreadCount || 0) + 1,
  updatedAt: admin.firestore.FieldValue.serverTimestamp()
}, { merge: true });

transaction.set(messageRef, {
  id: String(message.id || ""),
  phone,
  text: messageText,
  type: message.type || "unknown",
  direction: "incoming",
  timestamp,
  createdAt: admin.firestore.FieldValue.serverTimestamp()
}, { merge: true });

});
}

// Receive WhatsApp webhook events.
// Return HTTP 200 quickly so Meta does not repeatedly retry the event.
app.post("/webhook", (req, res) => {
res.sendStatus(200);

(async () => {
try {
const body = req.body;

  if (body?.object !== "whatsapp_business_account") return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || [];
      const contacts = value.contacts || [];

      for (const message of value.messages || []) {
        const contact = contacts.find(
          item => item.wa_id === message.from
        );

        await saveIncomingMessage(message, contact);
      }

      // Delivery/read statuses can be stored later if needed.
    }
  }
} catch (error) {
  console.error("Webhook processing failed:", error.message);
}

})();
});

// List conversations.
app.get("/api/chats", async (req, res) => {
if (!requireDatabase(res)) return;

try {
const snapshot = await db.collection("chats")
.orderBy("updatedAt", "desc")
.limit(200)
.get();

const chats = snapshot.docs.map(doc => ({
  id: doc.id,
  ...doc.data()
}));

res.json(chats);

} catch (error) {
console.error("Loading chats failed:", error.message);
res.status(500).json({ error: "Could not load conversations" });
}
});

// List messages for one conversation.
app.get("/api/chats/:phone/messages", async (req, res) => {
if (!requireDatabase(res)) return;

try {
const phone = String(req.params.phone);
const snapshot = await db.collection("chats")
.doc(phone)
.collection("messages")
.orderBy("timestamp", "asc")
.limit(500)
.get();

res.json(snapshot.docs.map(doc => ({
  id: doc.id,
  ...doc.data()
})));

} catch (error) {
console.error("Loading messages failed:", error.message);
res.status(500).json({ error: "Could not load messages" });
}
});

// Mark a conversation as read in this inbox.
app.post("/api/chats/:phone/read", async (req, res) => {
if (!requireDatabase(res)) return;

try {
await db.collection("chats")
.doc(String(req.params.phone))
.set({ unreadCount: 0 }, { merge: true });

res.json({ ok: true });

} catch (error) {
console.error("Marking chat read failed:", error.message);
res.status(500).json({ error: "Could not mark conversation as read" });
}
});

// Send a WhatsApp text message.
app.post("/api/messages", async (req, res) => {
if (!db) {
return res.status(503).json({
error: "Firebase is not configured on the server"
});
}

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
return res.status(503).json({
error: "WhatsApp API is not configured on the server"
});
}

const to = String(req.body?.to || "").trim();
const text = String(req.body?.text || "").trim();

if (!/^\d{7,15}$/.test(to)) {
return res.status(400).json({
error: "Recipient phone number must contain 7–15 digits, including country code"
});
}

if (!text || text.length > 4096) {
return res.status(400).json({
error: "Message must contain 1–4096 characters"
});
}

try {
const response = await fetch(
"https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}/messages",
{
method: "POST",
headers: {
Authorization: "Bearer ${WHATSAPP_TOKEN}",
"Content-Type": "application/json"
},
body: JSON.stringify({
messaging_product: "whatsapp",
recipient_type: "individual",
to,
type: "text",
text: { body: text }
})
}
);

const result = await response.json();

if (!response.ok) {
  console.error("WhatsApp API error:", JSON.stringify(result));
  return res.status(response.status).json({
    error: result.error?.message || "WhatsApp could not send the message"
  });
}

const timestamp = new Date().toISOString();
const messageId = result.messages?.[0]?.id ||
  `out_${Date.now()}`;

const chatRef = db.collection("chats").doc(to);
const messageRef = chatRef.collection("messages").doc(messageId);

await db.runTransaction(async transaction => {
  const chatSnapshot = await transaction.get(chatRef);
  const oldChat = chatSnapshot.exists ? chatSnapshot.data() : {};

  transaction.set(chatRef, {
    phone: to,
    name: oldChat.name || to,
    lastMessage: text,
    lastMessageAt: timestamp,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  transaction.set(messageRef, {
    id: messageId,
    phone: to,
    text,
    type: "text",
    direction: "outgoing",
    timestamp,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
});

return res.json({
  ok: true,
  messageId
});

} catch (error) {
console.error("Sending message failed:", error.message);
return res.status(500).json({
error: "Could not send message"
});
}
});

// Do not expose stack traces or environment secrets.
app.use((err, req, res, next) => {
console.error("Server error:", err.message);
res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
console.log("WhatsApp Inbox backend listening on port ${PORT}");
});
