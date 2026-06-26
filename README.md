# Zendesk JWT Auth

A self-hosted web tool that simplifies authenticated user access for **Zendesk AI Agents (Advanced/Ultimate)**. It bridges the Sunshine Conversations (Sunco) API and the Zendesk Admin API so you can create end-users, set passwords, and authenticate them via JWT — all from a single page.

## Why This Exists

Zendesk AI Agents Advanced and Ultimate plans support **authenticated messaging**: the widget verifies who the user is before the conversation starts. To make this work, you need to:

1. **Create a Zendesk end-user** with an `external_id` that links to a Sunshine Conversations profile
2. **Set a password** on that Zendesk account
3. **Sign a JWT** using your Secret Key and Key ID — and the signing must happen server-side (the Secret Key must never reach the browser)
4. **Inject the Zendesk widget snippet** server-side (dynamic injection crashes the SDK's InboundFilters module)
5. **Authenticate the user** via `zE('messenger', 'loginUser')` with the signed JWT

This app automates all of that. It acts as a lightweight proxy server that keeps your credentials secure and walks you through the process step by step.

## How It Works

### Configuration Page (3-Step Wizard)

| Step | What happens | APIs used |
|------|-------------|-----------|
| **1 — Create User** | Enter a name and email (external ID is auto-generated). The app creates a Zendesk end-user and a matching Sunco user profile. | Zendesk Admin API `POST /api/v2/users` + Sunco API `POST /v2/apps/{appId}/users` |
| **2 — Set Password** | Set a password on the newly created Zendesk account. | Zendesk Admin API `POST /api/v2/users/{id}/password` |
| **3 — Login & Open Widget** | The server signs a JWT and redirects to the authenticated messaging widget. | Sunco API `GET /v2/apps/{appId}/users/{externalId}` + JWT signing |

Each step locks after completion — fields become read-only to prevent accidental changes. The page only resets when you click **Reset All**.

### Quick Login Page

For users you've already created. Enter email + password → the server looks up the Zendesk user, signs a JWT, and opens the authenticated widget.

### API Logs Page

Every Zendesk and Sunco API call made by the server is logged with full request/response details (credentials redacted). Useful for debugging.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Browser (index.html SPA)                        │
│  ┌────────────┐ ┌────────────┐ ┌─────────────┐ │
│  │ Config      │ │ Quick Login│ │ API Logs     │ │
│  │ 3-step      │ │ Email+Pass │ │ Debug view   │ │
│  │ wizard      │ │ → JWT auth │ │              │ │
│  └──────┬──────┘ └─────┬──────┘ └──────────────┘ │
│         │              │                          │
└─────────┼──────────────┼──────────────────────────┘
          │ HTTP (sessionId only)                   
          ▼                                         
┌──────────────────────────────────────────────────┐
│  Express Server (server.js)                       │
│                                                   │
│  • Stores credentials server-side (never sent    │
│    to the browser — only a random sessionId)     │
│  • Proxies Zendesk & Sunco API calls (CORS)      │
│  • Signs JWTs server-side (Secret Key never      │
│    reaches the browser)                          │
│  • Injects Zendesk widget snippet into <head>    │
│    when ?wk= query param is present              │
│  • Persists config to config.json (optional)     │
└──────────────────────────────────────────────────┘
          │                          
          ▼                          
┌──────────────────────────────────────────────────┐
│  Zendesk Admin API     Sunshine Conversations API │
│  (Basic Auth)           (Basic Auth keyId:secret) │
└──────────────────────────────────────────────────┘
```

### Why a proxy server?

- **CORS**: The Zendesk REST API (both `/api/v2/` and `/sc/v2/`) blocks browser-side `fetch()` — no CORS headers. All API calls must go through a backend.
- **JWT signing**: The Secret Key must never be exposed to the browser. The server signs JWTs and returns only the token.
- **Widget snippet**: Loading `snippet.js` dynamically via `document.createElement('script')` crashes the Zendesk SDK's InboundFilters module. The server injects the `<script>` tag into `<head>` before serving the HTML.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/session` | Create an ephemeral session (credentials held in memory) |
| `GET` | `/api/session/:id` | Get session data (subdomain, widgetKey) |
| `DELETE` | `/api/session/:id` | Clear session credentials |
| `POST` | `/api/config` | Save credentials to `config.json` (persists across restarts) |
| `GET` | `/api/config` | Read saved config (credentials redacted) |
| `DELETE` | `/api/config` | Delete saved config |
| `POST` | `/api/zendesk-users` | Create a Zendesk end-user |
| `POST` | `/api/zendesk-users/:id/password` | Set a user's password |
| `POST` | `/api/sunco-users` | Create/update a Sunco user profile (auto-retries as PATCH on 409) |
| `GET` | `/api/sunco-users/:externalId` | Look up a Sunco user by externalId |
| `POST` | `/api/generate-jwt` | Sign a JWT using session credentials |
| `POST` | `/api/quick-login` | End-to-end login: look up user by email, generate JWT, return auth data (uses persisted config) |
| `GET` | `/api/logs` | Get all logged API calls |
| `DELETE` | `/api/logs` | Clear API logs |

## Setup

### What you'll need

- **Zendesk subdomain** (e.g., `mycompany`)
- **Zendesk Admin email + API token** — for creating users and setting passwords via the Admin API
- **Sunco App ID** — from Sunshine Conversations settings
- **Sunco Key ID + Secret Key** — for creating Sunco user profiles and signing JWTs (Conversations API key token)
- **Widget Key** — from Admin Center → Channels → Messaging → Web Widget → Installation

### Local Development

```bash
git clone https://github.com/bwilliams4428/zendesk-jwt-auth.git
cd zendesk-jwt-auth
npm install
npm start
# Open http://localhost:3000
```

No environment variables needed — all credentials are entered through the web UI.

### Deploy to Render

1. Create a new **Web Service** on [Render](https://render.com)
2. Connect your GitHub repo
3. Render will auto-detect the `render.yaml`:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. No environment variables required — configure credentials through the web UI after deploy
5. Your app will be live at `https://zendesk-jwt-auth.onrender.com`

### Deploy Anywhere

This is a standard Node.js/Express app — deploy it anywhere that supports Node 18+:

```bash
npm install
npm start
```

The server listens on `PORT` (defaults to 3000). Render sets this automatically.

## Security Notes

- **Credentials never reach the browser** — only a random `sessionId` is stored client-side
- **JWTs are signed server-side** — the Secret Key never leaves the server
- **API logs redact** all password, token, and secret values
- **The proxy is required** — Zendesk APIs don't support CORS, so browser-side calls are impossible
- Sessions are ephemeral (in-memory, reset on server restart). Use **Quick Login** with saved config for persistence.

## License

MIT