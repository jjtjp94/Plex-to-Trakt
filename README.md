# Plex to Trakt

Automatically sync your Plex watch history to Trakt.tv using webhooks — with **live scrobbling**, so Trakt shows what you're watching right now with an accurate time-remaining countdown.

> **⚠️ Disclaimer:** This project was generated 100% by AI. I just needed multi-user support and the ability for users to add their own Trakt credentials for this type of sync and I couldn't find any project that fit my needs.

> **🍴 Fork note:** This fork of [bunducdragos/Plex-to-Trakt](https://github.com/bunducdragos/Plex-to-Trakt) replaces the original one-shot "add to history at 90%" sync with full live scrobbling via Trakt's scrobble API. Everything from the original (multi-user, per-user Trakt credentials, token refresh, Docker) still works the same.

## What This Fork Adds

- ⏱ **Live "watching now" on Trakt** — pressing play in Plex immediately shows you as watching on Trakt, with a time-remaining countdown that ticks down in real time
- ⏸ **Pause/resume mirroring** — pausing in Plex saves your resume point to Trakt's playback progress, resuming restores the watching status
- 🎯 **Seek correction** (optional) — Plex webhooks don't fire when you skip around; with `PLEX_SERVER_URL` set, the app polls your Plex server during playback and corrects Trakt whenever the position drifts
- 🛟 **Reliability fallbacks** — watches are still recorded if the stop webhook never arrives (client crash, lost webhook), and the original `/sync/history` call remains as a fallback if a scrobble fails
- 🧪 **Local test harness** — mock Plex and Trakt servers so you can exercise the full scrobble lifecycle without touching real accounts

## Features

- 🎬 Live scrobbling from Plex to Trakt via webhooks (watching now, pause, resume, watched)
- 📺 Supports both movies, TV shows and Anime
- 🔄 Automatic token refresh (access tokens every 24h, refresh tokens kept alive)
- 🐳 Docker support for easy deployment
- 🔐 Secure user authentication with Plex and Trakt
- 📊 Multi-user support - only users with access to your Plex server can login and add their Trakt credentials

![App](/photos/app.png)

## Prerequisites

- Plex Media Server with Plex Pass (required for webhooks)
- Trakt.tv account (a free account is fine — scrobbling does not require VIP)
- Trakt API application credentials ([Create one here](https://trakt.tv/oauth/applications))
- *(Optional, for seek correction)* Your Plex server's URL and a Plex token ([how to find your token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/))

## Quick Start with Docker

1. Clone the repository:

```bash
git clone https://github.com/jjtjp94/Plex-to-Trakt.git
cd Plex-to-Trakt
```

2. Create a `.env` file from the example:

```bash
cp .env.example .env
```

3. Edit `.env` and fill in your configuration:

   - `EXTERNAL_URL`: Your domain if behind reverse proxy (e.g., `https://plex-trakt.yourdomain.com`) or `http://localhost:3000` for local
   - `PLEX_CLIENT_ID`: Generate a unique identifier (e.g., UUID)
   - `PLEX_SERVER_ID`: Your Plex server machine identifier (for server access verification)
   - `PLEX_SERVER_IP`: Your Plex server IP address (for webhook security)
   - `SESSION_SECRET`: A random secret string for session encryption
   - *(Optional)* `PLEX_SERVER_URL`: Base URL of your Plex server (e.g., `http://192.168.1.100:32400`) — enables seek correction
   - *(Optional)* `PLEX_TOKEN`: Plex token used for seek correction; the server owner's token can see all users' sessions

4. Build and start with Docker:

```bash
docker-compose up -d
```

The Docker container will automatically initialize the database on first run.

5. Open http://localhost:3000 (or your configured external URL) in your browser

6. Authenticate with Plex and configure your Trakt credentials

7. Set up the Plex webhook:
   - In Plex Settings → Webhooks
   - Add webhook URL: `http://your-server:3000/webhooks/plex` (or your external URL)

## Deploy with Portainer

Two options depending on how you like to run stacks:

### Option A: Stack from this repository (Portainer builds the image)

1. In Portainer go to **Stacks → Add stack**
2. Name it `plex-to-trakt`
3. Choose **Repository** as the build method:
   - **Repository URL**: `https://github.com/jjtjp94/Plex-to-Trakt`
   - **Compose path**: `docker-compose.yml`
4. Under **Environment variables**, add: `EXTERNAL_URL`, `PLEX_CLIENT_ID`, `PLEX_SERVER_ID`, `PLEX_SERVER_IP`, `SESSION_SECRET`, and optionally `PLEX_SERVER_URL` and `PLEX_TOKEN`
5. Click **Deploy the stack** — Portainer clones the repo and builds the image from the Dockerfile

> Note: with repository stacks, the `./data` bind mount lives inside Portainer's compose directory. If you prefer a named volume, use the compose file from Option B.

### Option B: Web editor with a pre-built image

Build the image once on the Docker host:

```bash
git clone https://github.com/jjtjp94/Plex-to-Trakt.git
cd Plex-to-Trakt
docker build -t plex-to-trakt:latest .
```

Then in **Stacks → Add stack → Web editor**, paste:

```yaml
services:
  plex-to-trakt:
    image: plex-to-trakt:latest
    container_name: plex-to-trakt
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - plex-to-trakt-data:/app/data
    environment:
      - NODE_ENV=production
      - DATABASE_URL=file:/app/data/data.db
      - EXTERNAL_URL=${EXTERNAL_URL:-http://localhost:3000}
      - PLEX_CLIENT_ID=${PLEX_CLIENT_ID}
      - PLEX_SERVER_ID=${PLEX_SERVER_ID}
      - PLEX_SERVER_IP=${PLEX_SERVER_IP}
      - SESSION_SECRET=${SESSION_SECRET}
      - PLEX_SERVER_URL=${PLEX_SERVER_URL:-}
      - PLEX_TOKEN=${PLEX_TOKEN:-}

volumes:
  plex-to-trakt-data:
```

Add the same environment variables in Portainer's **Environment variables** section, then deploy. The named volume keeps your SQLite database across container updates.

## Manual Installation

1. Install dependencies:

```bash
npm install
```

2. Set up environment variables in `.env` file

3. Initialize the database:

```bash
npm run prisma:migrate
```

**Important**: This must be run before starting the server for the first time.

```bash
npm run prisma:generate
```

4. Start the application:

```bash
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## Configuration

### Environment Variables

| Variable          | Description                                                                                                                            | Required |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `EXTERNAL_URL`    | External URL for the application (e.g., https://yourdomain.com or http://localhost:3000)                                               | Yes      |
| `PLEX_CLIENT_ID`  | Unique client identifier for Plex OAuth                                                                                                | Yes      |
| `PLEX_SERVER_ID`  | Your Plex server Machine Identifier (see below for how to find it)                                                                     | Yes      |
| `PLEX_SERVER_IP`  | IP address of your Plex server for webhook security                                                                                    | No       |
| `SESSION_SECRET`  | Secret key for session encryption                                                                                                      | Yes      |
| `PLEX_SERVER_URL` | Base URL of your Plex server (e.g., http://192.168.1.100:32400). Enables seek correction by polling `/status/sessions` during playback | No       |
| `PLEX_TOKEN`      | Plex token for the seek-correction poll (the server owner's token sees all sessions). Falls back to the watching user's own token      | No       |
| `TRAKT_API_URL`   | Override the Trakt API base URL — only used for local testing against the mock server                                                  | No       |

### Finding Your Plex Server ID

To find your Plex server machine identifier:

1. Open `http://your-plex-server-ip:32400/identity` in your browser
2. Copy the `machineIdentifier` value from the XML response

### Setting Up Trakt API

1. Go to https://trakt.tv/oauth/applications
2. Create a new application
3. Each user will need to provide their own Trakt Client ID and Secret in the web interface

## How It Works

1. **Authentication**: Users authenticate with Plex and configure their Trakt API credentials
2. **Webhooks**: Plex sends webhook events on every playback state change
3. **Live scrobbling**: The full playback lifecycle is mirrored to Trakt's scrobble API:
   - Play/resume sends `scrobble/start`, so Trakt shows you as **watching now** with a live time-remaining countdown (Trakt extrapolates from the progress we send)
   - Pause sends `scrobble/pause`, saving your resume point on Trakt
   - Stop sends `scrobble/stop` — at 80%+ progress Trakt records a watched play, below that it saves resumable progress
   - Plex's 90% "scrobble" event is deferred to the real stop so the watching status isn't cleared early; a fallback timer records the watch even if the stop webhook never arrives
4. **Seek correction** (optional): Plex webhooks don't fire on seeks. With `PLEX_SERVER_URL` set, the app polls `/status/sessions` every 15s during active playback and re-syncs Trakt when the playback position drifts (e.g., you skipped ahead) or the session disappears
5. **Token Management**:
   - Access tokens are refreshed automatically when expired (24h)
   - Refresh tokens are kept alive with weekly maintenance (90d expiration)

## Local Testing

The `test/` folder contains mock servers so you can exercise the full scrobble lifecycle without a real Plex server or Trakt account:

```bash
# Fake api.trakt.tv on :8400 — logs every scrobble call it receives
node test/mockTrakt.mjs

# Fake Plex /status/sessions on :8401 — serves /tmp/mock-plex-sessions.json
node test/mockPlex.mjs

# Seed a test user (plexId 999001) into the database
npx tsx test/seedUser.mjs
```

Point the app at the mocks in your `.env`, then POST simulated webhook payloads to `/webhooks/plex`:

```bash
TRAKT_API_URL=http://localhost:8400
PLEX_SERVER_URL=http://localhost:8401
PLEX_TOKEN=test-token
```

## Docker Volumes

The application uses a volume for persistent data:

- `./data:/app/data` - SQLite database storage

## License

MIT

## Contributing

Pull requests are welcome! Please open an issue first to discuss major changes.
