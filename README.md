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

Every Zendesk and Sunco API call made by the server is logged with full request/response details (credentials redacted). Requires authentication to view.

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
│  • Credentials from environment variables          │
│  • Session store: in-memory with 15-min TTL       │
│  • Proxies Zendesk & Sunco API calls (CORS)       │
│  • Signs JWTs server-side (Secret Key never       │
│    reaches the browser)                           │
│  • Injects Zendesk widget snippet into <head>     │
│    when ?wk= query param is present               │
│  • Rate limiting, helmet, input validation         │
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
| `POST` | `/api/session` | Create an ephemeral session (credentials held in memory, 15-min TTL) |
| `GET` | `/api/session/:id` | Get session data (subdomain, widgetKey) |
| `DELETE` | `/api/session/:id` | Clear session credentials |
| `GET` | `/api/config` | Check if env vars are configured (returns non-sensitive fields) |
| `POST` | `/api/config` | Validate env vars are set |
| `POST` | `/api/zendesk-users` | Create a Zendesk end-user |
| `POST` | `/api/zendesk-users/:id/password` | Set a user's password |
| `POST` | `/api/sunco-users` | Create/update a Sunco user profile (auto-retries as PATCH on 409) |
| `GET` | `/api/sunco-users/:externalId` | Look up a Sunco user by externalId |
| `POST` | `/api/generate-jwt` | Sign a JWT using session credentials |
| `POST` | `/api/quick-login` | End-to-end login: look up user by email, generate JWT, return auth data (uses env vars) |
| `GET` | `/api/logs` | Get all logged API calls (requires auth) |
| `DELETE` | `/api/logs` | Clear API logs (requires auth) |

All `/api/` endpoints require authentication (valid sessionId or `X-API-Key` header) except:
- `GET /api/config` — public, returns non-sensitive config status only
- `POST /api/session` — creates a new session
- `POST /api/quick-login` — uses env var credentials
- `POST /api/config` — validates env vars

## Setup

### What you'll need

- **Zendesk subdomain** (e.g., `mycompany`)
- **Zendesk Admin email + API token** — for creating users and setting passwords via the Admin API
- **Sunco App ID** — from Sunshine Conversations settings
- **Sunco Key ID + Secret Key** — for creating Sunco user profiles and signing JWTs (Conversations API key token)
- **Widget Key** — from Admin Center → Channels → Messaging → Web Widget → Installation

### Environment Variables

Set these on your hosting platform (Render → Environment, or in `.env` for local dev):

| Variable | Description |
|----------|-------------|
| `ZENDESK_SUBDOMAIN` | Your Zendesk subdomain (e.g., `mycompany`) |
| `ZENDESK_ADMIN_EMAIL` | Admin email for API calls |
| `ZENDESK_API_TOKEN` | Zendesk API token (secret) |
| `SUNCO_APP_ID` | Sunshine Conversations App ID |
| `SUNCO_KEY_ID` | Conversations API key ID (e.g., `app_xxx`) |
| `SUNCO_SECRET` | Secret Key for JWT signing (secret, used as raw string) |
| `ZENDESK_WIDGET_KEY` | Web Widget key for snippet injection |
| `API_KEY` | *(Optional)* API key for programmatic access to `/api/logs` |
| `NODE_ENV` | Set to `production` for hardened error handling |

### Local Development

```bash
git clone https://github.com/bwilliams4428/zendesk-jwt-auth.git
cd zendesk-jwt-auth
npm install

# Set environment variables (choose one method):
# Option 1: .env file
cat > .env << 'EOF'
ZENDESK_SUBDOMAIN=your-subdomain
ZENDESK_ADMIN_EMAIL=admin@example.com
ZENDESK_API_TOKEN=your-api-token
SUNCO_APP_ID=your-app-id
SUNCO_KEY_ID=app_your-key-id
SUNCO_SECRET=your-secret-key
ZENDESK_WIDGET_KEY=your-widget-key
EOF

# Option 2: export directly
export ZENDESK_SUBDOMAIN=your-subdomain
# ... etc

npm start
# Open http://localhost:3000
```

### Deploy to Render

1. Create a new **Web Service** on [Render](https://render.com)
2. Connect your GitHub repo
3. Render will auto-detect the `render.yaml`
4. **Set environment variables** in Render → Environment:
   - `ZENDESK_SUBDOMAIN`, `ZENDESK_ADMIN_EMAIL`, `ZENDESK_API_TOKEN`
   - `SUNCO_APP_ID`, `SUNCO_KEY_ID`, `SUNCO_SECRET`
   - `ZENDESK_WIDGET_KEY`
   - `NODE_ENV=production`
5. Mark `ZENDESK_API_TOKEN`, `SUNCO_SECRET` as **secret** values
6. Deploy — your app will be live at your Render URL

### Deploy Anywhere

This is a standard Node.js/Express app — deploy it anywhere that supports Node 18+:

```bash
npm install
npm start
```

The server listens on `PORT` (defaults to 3000). Render sets this automatically.

## Security

- **Credentials stored in environment variables** — never in `config.json` or client-side storage
- **JWTs are signed server-side** — the Secret Key never reaches the browser
- **API endpoints require authentication** — sessionId or API key header
- **API logs redact** all password, token, and secret values
- **Sessions expire after 15 minutes** of inactivity (in-memory TTL)
- **JWTs expire after 15 minutes** — reduced from 1 hour
- **Rate limiting** on auth and user-creation endpoints (5–20 req/15min per IP)
- **Security headers** via helmet middleware (CSP, X-Frame-Options, etc.)
- **Input validation** on email, name, external ID, and password fields
- **Production error handling** — no stack traces leaked to clients
- **robots.txt** disallows all crawler access

## License

MIT