# Zendesk JWT Auth

A privacy-first, self-hosted web application for authenticating users with Zendesk Messaging widgets using JWT (JSON Web Tokens). Built with Express.js and styled with a shadCN UI-inspired light theme.

## How It Works

This app generates signed JWT tokens that authenticate your users with Zendesk's Messaging widget, so your support conversations are tied to real user identities instead of anonymous sessions.

### Authentication Flow

```
1. User visits /setup.html → Enters their Zendesk credentials
2. Credentials saved to browser sessionStorage (never on the server)
3. User visits / (home page) → Enters name, email
4. App creates a JWT token and calls Zendesk's messenger API to authenticate the user
5. The Zendesk widget now knows who this user is
```

### Key Privacy Feature

**Credentials are never saved on the server.** The JWT Secret, Key ID, and Widget Key are stored exclusively in your browser's `sessionStorage`. They are:

- Sent with each API request for token generation (used in-memory only)
- Automatically erased when you close the browser tab
- Never written to disk, cookies, or a database

For production deployments, you can set credentials as environment variables on your server (see [Environment Variables](#environment-variables)).

## Getting Started

### Prerequisites

- Node.js 18+
- A Zendesk account with Messaging enabled
- A Conversations API key (Key ID + Secret Key) from your Zendesk admin

### Finding Your Zendesk Credentials

You need three pieces of information from your Zendesk account:

#### 1. Widget Key

Go to **Admin Center → Channels → Messaging and Social → Messaging → click your widget link → Installation**

Find the `key=` value in the snippet:

```html
<script id="ze-snippet" src="https://static.zdassets.com/ekr/snippet.js?key=your_widget_key_here"> </script>
```

#### 2. Key ID and Secret Key

Go to **Admin Center → Apps and integrations → APIs → Conversations API**

1. Click **Add key**
2. Enter a name (e.g., "JWT Auth")
3. Click Create
4. Copy the **Key ID** (e.g., `app_67097c94d8a020e6a236ae87`)
5. Copy the **Secret Key** (shown only once!)

> ⚠️ The Secret Key is only shown once when you create it. If you lose it, you'll need to create a new key.

See the [Zendesk Conversations API keys documentation](https://support.zendesk.com/hc/en-us/articles/4576088682266) for more details.

### Installation

```bash
git clone https://github.com/bwilliams4428/zendesk-jwt-auth.git
cd zendesk-jwt-auth
npm install
npm start
```

The app runs on **port 3000** by default (configurable via the `PORT` environment variable).

### Quick Start

1. Open `http://localhost:3000/setup.html`
2. Enter your **Widget Key**, **Key ID**, **Secret Key**, and **Zendesk Subdomain**
3. Click **Save & Launch** — credentials are stored in your browser only
4. Enter a name and email on the home page
5. Click **Create User & Authenticate**

## Pages

| Page | URL | Description |
|------|-----|-------------|
| Home | `/` | Create authenticated users and generate JWT tokens |
| Setup | `/setup.html` | Configure your Zendesk credentials |
| Debug | `/debug.html` | Generate, inspect, and verify JWT tokens |
| Messaging | `/messaging.html` | Authenticate users via the Zendesk Messaging widget |
| Login | `/login.html` | Demo login page for testing |

## API Endpoints

### `POST /api/auth/token`

Generate a JWT token for a user.

**Request body (with sessionStorage credentials):**

```json
{
  "userId": "user_abc123",
  "name": "John Smith",
  "email": "john@example.com",
  "jwtSecret": "your_secret_key",
  "kid": "app_67097c94d8a020e6a236ae87"
}
```

**Response:**

```json
{
  "status": "success",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_at": 1779419772,
  "issued_at": 1779333372
}
```

### `POST /api/auth/verify`

Verify a JWT token.

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### `POST /api/auth/login`

Create or retrieve a user session (demo endpoint).

```json
{
  "email": "john@example.com",
  "password": "any_password"
}
```

### `GET /api/config/status`

Check whether credentials are configured (via environment variables). Returns `ephemeral: true` when no server-side config exists.

### `GET /api/config/public`

Returns `widgetKey` and `kid` from environment variables (if set). The Secret Key is never exposed.

## Environment Variables

For production deployments, set these environment variables instead of using the setup page:

| Variable | Description |
|----------|-------------|
| `ZENDESK_JWT_SECRET` | Your Conversations API Secret Key |
| `ZENDESK_KID` | Your Conversations API Key ID |
| `ZENDESK_WIDGET_KEY` | Your Zendesk Messaging Widget Key |
| `ZENDESK_ACCOUNT` | Your Zendesk subdomain (e.g., `mycompany.zendesk.com`) |
| `PORT` | Server port (default: 3000) |

Environment variables take priority over session credentials. When set, the setup page is optional.

## Deployment

### Render

The included `render.yaml` makes deployment to [Render](https://render.com) one click:

1. Fork this repo
2. Create a new Web Service on Render, pointing to your fork
3. Set environment variables in Render's dashboard
4. Deploy

### Other Platforms

This is a standard Express.js app — deploy it anywhere that supports Node.js:

```bash
npm install
npm start
```

See `DEPLOY_CHECKLIST.md` for a detailed deployment walkthrough.

## Architecture

```
zendesk-jwt-auth/
├── server/
│   └── server.js          # Express server, JWT generation, API endpoints
├── public/
│   ├── css/
│   │   └── radix-theme.css # shadCN UI-inspired light theme
│   ├── js/
│   │   └── zendesk-loader.js  # Dynamic widget script loader
│   ├── index.html          # Home — create users & authenticate
│   ├── setup.html          # Configure credentials (sessionStorage)
│   ├── debug.html          # Token generation & verification
│   ├── messaging.html      # Messenger widget authentication
│   ├── login.html           # Demo login page
│   └── app.js              # Shared client-side logic
├── .env.example            # Environment variable template
├── render.yaml             # Render deployment config
├── DEPLOY_CHECKLIST.md    # Deployment guide
└── package.json
```

### JWT Token Structure

The generated JWT tokens follow Zendesk's specification:

- **Algorithm**: HS256
- **Header**: Includes `kid` (Key ID) for Zendesk to identify which signing key to use
- **Payload**: Contains `scope`, `external_id`, `name`, `email`, and `iat`/`exp` timestamps
- **Signing**: Uses your Secret Key from the Conversations API

### Client-Side Authentication

The Zendesk Messaging widget is authenticated via:

```javascript
zE("messenger", "loginUser", function (callback) {
    callback(jwtToken);
});
```

This tells Zendesk who the user is, linking their conversation history to their identity.

## Security Considerations

- **JWT Secret never leaves the browser** when using sessionStorage mode
- **No server-side credential storage** — no config files, no database reads
- **HTTPS recommended** for production — credentials traverse the network in request bodies
- **sessionStorage scope** — credentials are per-tab and vanish when the tab closes
- **Clear All Data** button on the home page immediately erases all stored credentials

## License

MIT