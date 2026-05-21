# Zendesk JWT Auth — Setup & Deploy Guide

## How It Works

**Privacy-first design:** Your Zendesk credentials (JWT Secret, KID, Widget Key) are stored **only in your browser's sessionStorage**. They are:

- ✅ Sent to the server only during JWT token generation (in-memory, never written to disk)
- ✅ Automatically erased when you close the browser tab
- ✅ Never logged, never persisted on any server

There is also a **"Clear All Data"** button on the setup page for immediate erasure.

---

## Quick Start (Any Zendesk Account)

1. **Run locally:**
   ```bash
   git clone https://github.com/bwilliams4428/zendesk-jwt-auth.git
   cd zendesk-jwt-auth
   npm install
   npm start
   ```

2. **Open http://localhost:3000/setup.html**

3. **Enter your Zendesk credentials:**
   - **Widget Key** — Found in Zendesk Admin → Channels → Messaging → Web Widget (the `key=` value)
   - **JWT Shared Secret** — Found in Zendesk Admin → Channels → Messaging → Settings → JWT Authentication
   - **Key ID (kid)** — Same JWT settings page
   - **Account** (optional) — Your Zendesk subdomain

4. **Click "Save & Launch"** — you're ready to go!

---

## Production Deployment (Render)

### Environment Variables (Server-Persistent Config)

For production, you can set credentials as environment variables instead of relying on sessionStorage:

| Variable | Required | Description |
|----------|----------|-------------|
| `ZENDESK_JWT_SECRET` | Yes* | Your Zendesk JWT shared secret |
| `ZENDESK_KID` | Yes* | Your Zendesk Key ID |
| `ZENDESK_WIDGET_KEY` | Yes* | Your web widget key |
| `ZENDESK_ACCOUNT` | No | Your Zendesk subdomain |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Set to `production` |

\* Required only if not entering via `/setup.html` each session.

### Deploy to Render

1. Push to GitHub
2. Create a new Web Service on Render, connect your repo
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add environment variables in Render dashboard

---

## Finding Your Zendesk Credentials

1. Go to your **Zendesk Admin Center** (e.g. `https://mycompany.zendesk.com/admin`)
2. Click **Channels** → **Messaging**
3. Find your **Web Widget key** in the widget snippet
4. Go to **Settings** → **JWT Authentication**
5. Enable JWT, then copy:
   - The **Shared Secret**
   - The **Key ID (kid)**

---

## Troubleshooting

### Widget Not Loading
- Check browser console for `[zendesk-loader]` messages
- Verify your Widget Key at `/setup.html`
- Make sure you've saved credentials in the current tab (sessionStorage is per-tab)

### JWT Token Generation Fails
- Verify your JWT Secret and KID at `/setup.html`
- Check the Debug page (`/debug.html`) for detailed logs
- Credentials are per-session — if you open a new tab, re-enter them

### Widget Not Authenticating
- Open browser DevTools → Console
- Verify the JWT Secret matches the one in Zendesk Admin
- Ensure the KID matches exactly (case-sensitive)
- Check the token payload in Debug for correct fields

### "No credentials" Warning
- Visit `/setup.html` and enter your credentials
- Or set `ZENDESK_JWT_SECRET`, `ZENDESK_KID`, `ZENDESK_WIDGET_KEY` env vars

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/config/status` | GET | Check if env-var config is available |
| `/api/config/widget-key` | GET | Get env-var widget key (for dynamic loading) |
| `/api/auth/token` | POST | Generate JWT (accepts `jwtSecret`/`kid` in body for per-request credentials) |
| `/api/auth/verify` | POST | Verify a JWT (accepts `jwtSecret` in body) |
| `/api/auth/login` | POST | Demo login (generates user from email) |

---

✅ **Privacy-first, works with any Zendesk account, no server-side secret storage.**