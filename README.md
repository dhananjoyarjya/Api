# WhatsApp Inbox backend starter

This is a starter backend, not a complete production inbox yet.

## What it currently does
- Serves `index.html` from the repository root.
- Provides `GET /health`.
- Provides Meta webhook verification at `GET /webhook`.
- Accepts webhook events at `POST /webhook` and logs them to Render logs.
- Sends WhatsApp text messages through `POST /api/messages`.

## Important limitations
- Incoming messages are logged only; they are not saved in a database or shown in the inbox yet.
- Your existing `index.html` may need small changes to call `POST /api/messages`.
- Do not put the WhatsApp access token in HTML, GitHub, or a public repository.
- Do not deploy until the environment variables are added in Render.

## Render settings
- Runtime/language: Node
- Root Directory: leave blank
- Build Command: `npm install`
- Start Command: `npm start`

## Environment variables in Render
Add these under the service's Environment section:
- `WHATSAPP_ACCESS_TOKEN` =EAGcZCr8dNqJYBS5Ye9RvpiSPZAXSoDmjtgGeybIdUG8uCu6orTVgxyKx9hVqyYbCN9lGfHZBZCgWCi2x7tAR8GGiAddj8n69wLXh8HqFficV1yZBMhFbrbRryH8gmfUDaPyH4eB4vvJMBEWDNRHjbsoPk1gthL4ISy5mWIJPRetFpwc9qX59yY2oNtZCPy0VgMZBZCscTQ5CbZBmA678PJIbk0h2JiQ8EVkLj
- `WHATSAPP_PHONE_NUMBER_ID` =1392350110630223
- `WEBHOOK_VERIFY_TOKEN` =https://api-0cvf.onrender.com/webhook
- `GRAPH_API_VERSION` = `v23.0` (change if your Meta app uses a different supported version)

## Webhook setup
After deployment, use `https://YOUR-SERVICE.onrender.com/webhook` as the callback URL in Meta Developers.
Use the same `WEBHOOK_VERIFY_TOKEN` value in Meta and Render.
Subscribe the WhatsApp webhook fields needed for your app, especially `messages`.

## API test
POST `https://YOUR-SERVICE.onrender.com/api/messages`
Content-Type: application/json

{
  "to": "918822883262",
  "text": "Hello from my inbox"
}

Use a recipient who has opted in, and remember that WhatsApp messaging rules and template requirements apply outside the customer service window.
