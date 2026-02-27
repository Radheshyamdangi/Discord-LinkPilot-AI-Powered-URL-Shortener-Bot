# Discord LinkPilot: AI-Powered URL Shortener Bot

A production-style Discord bot that creates short URLs, tracks visits in MongoDB, exposes a lightweight web dashboard, and supports Gemini-based AI replies (including attachments).

## Project Summary

This project combines:
- A Discord bot for URL and AI commands
- An Express server for redirects and admin dashboard
- A MongoDB data layer for URL history and ownership

It is designed to show practical backend engineering for interview/panel demos: real-time bot interactions, persistent storage, API routes, and clean environment-based configuration.

## Key Features

- URL shortener directly from Discord (`create <url>`)
- User-specific URL listing (`myurls`)
- Safe delete flow with ownership checks (`delete <shortId>`)
- Public redirect route with visit tracking
- Web dashboard to view and delete URL records
- AI command support through Gemini (`ai gemini <prompt>`)
- Attachment-aware AI handling (text extraction, file-size guards)
- Discord reply chunking for long model responses
- Single-instance lock (`.bot.lock`) to avoid duplicate bot sessions

## Tech Stack

- Node.js (ES Modules)
- discord.js
- Express
- MongoDB + Mongoose
- dotenv
- Gemini API (via HTTP endpoint)

## Architecture (High Level)

1. Discord message arrives (`messageCreate`).
2. Command parser routes to URL or AI handlers.
3. URL operations persist to MongoDB.
4. Express serves:
   - `GET /` dashboard
   - `GET /api/urls` URL list
   - `DELETE /api/urls/:shortId` delete
   - `GET /:shortId` redirect + visit tracking
5. AI requests call Gemini and send chunked Discord replies.

## Project Structure

```text
.
|- index.js           # Bot runtime + command handlers + startup flow
|- server.js          # Express routes and dashboard serving
|- connect.js         # MongoDB connection
|- loadEnv.js         # .env loader with fallback behavior
|- models/
|  \- url.js          # URL schema (creator + visit history)
|- services/
|  \- ai.js           # Gemini integration and attachment processing
|- public/
|  \- index.html      # Dashboard UI
|- package.json
\- .gitignore
```

## Local Setup

### Prerequisites

- Node.js 18+ (Node 20 recommended)
- MongoDB (local or Atlas)
- Discord bot token
- Gemini API key (optional, only for AI features)

### Install and Run

```bash
npm install
npm start
```

Current `start` script uses `nodemon` for development.  
For production, run `node index.js` (always-on process manager/service).

## Environment Variables

Create a `.env` file in the project root.

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
MONGO_URI=mongodb://localhost:27017/URL_shortner

PORT=8000
PUBLIC_BASE_URL=http://localhost:8000

GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
GEMINI_FALLBACK_MODELS=gemini-2.0-flash

AI_MAX_ATTACHMENT_BYTES=8388608
AI_MAX_TEXT_CHARS=12000
DISCORD_REPLY_CHUNK_SIZE=1900
AI_MAX_REPLY_CHUNKS=8
```

### Required vs Optional

- Required:
  - `DISCORD_BOT_TOKEN` for bot login
  - `MONGO_URI` for URL persistence
- Optional:
  - Gemini variables (only needed for AI commands)
  - `PUBLIC_BASE_URL` (recommended in production)
  - tuning variables for chunk/attachment limits

## Bot Commands

- `create <url>`: create short URL
- `myurls`: list your latest URLs
- `delete <shortId or shortUrl>`: delete your own URL
- `dashboard`: return dashboard link
- `ai gemini <prompt>`: prompt Gemini explicitly
- `gemini <prompt>`: Gemini shortcut
- `help`: show command menu

## HTTP Endpoints

- `GET /`: dashboard page
- `GET /api/urls`: list URLs with metadata
- `DELETE /api/urls/:shortId`: delete URL by short ID
- `GET /:shortId`: redirect to original URL + append visit history

## Production Deployment Notes (24/7)

- Use an always-on host for Discord Gateway bots (Render/Railway/Fly.io/VM/container).
- Avoid deploying the bot runtime to serverless-only environments for continuous sessions.
- Set `PUBLIC_BASE_URL` to your production domain.
- Ensure Discord privileged intent configuration matches your bot behavior.

## Security Notes

- Keep `.env` private (already covered by `.gitignore`).
- Never commit bot tokens or API keys.
- Rotate keys immediately if exposed.

## Interview Talking Points

- Designed a single process that combines bot events + web API.
- Implemented ownership-based deletion and visit analytics.
- Built resilience features (single-instance lock, de-duplication window, fallback AI models).
- Added practical Discord constraints handling (message chunking/truncation).

Developed by 🔥Radheshyam
