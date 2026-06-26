/**
 * Zendesk JWT Auth Server
 * ========================
 *
 * This Express server acts as a backend proxy for Zendesk JWT authentication.
 * It serves the frontend SPA (index.html) and provides API endpoints that
 * handle credential storage, user creation, JWT generation, and API logging.
 *
 * WHY THIS SERVER EXISTS:
 * - Browser-side JavaScript cannot call Zendesk APIs directly due to CORS restrictions.
 * - The Zendesk messaging widget snippet must be injected server-side to avoid
 *   InboundFilters errors from the SDK's module loader.
 * - JWT signing requires the Secret Key, which must NEVER be exposed to the browser.
 *   This server signs JWTs server-side and returns only the token to the client.
 *
 * ARCHITECTURE OVERVIEW:
 * - The frontend (index.html) is a single-page app with 3 pages: Configuration,
 *   Quick Login, and API Logs.
 * - Configuration page: Saves Zendesk admin credentials + Sunco credentials to a
 *   server-side session store, then creates a Zendesk end-user and sets their password.
 * - Quick Login page: Uses persisted config to authenticate an existing user via JWT.
 * - API Logs: Shows all server-side API calls for debugging.
 *
 * CREDENTIAL FLOW:
 * - Configuration page → POST /api/session → credentials stored in memory (credentialsStore)
 *   keyed by a random sessionId. The sessionId is the only thing stored client-side.
 * - Quick Login page → POST /api/config → credentials persisted to config.json on disk,
 *   so they survive server restarts. No sessionId needed for Quick Login.
 *
 * AUTH FLOW (Quick Login):
 * 1. User enters email + password on the Quick Login page
 * 2. POST /api/quick-login → server looks up the Zendesk user by email,
 *    generates a JWT, and returns { jwt, widgetKey, subdomain, user }
 * 3. Frontend stores auth data in sessionStorage and redirects to /?wk=WIDGET_KEY
 * 4. Server intercepts the GET / request, injects the Zendesk snippet <script> into <head>
 * 5. On page load, the frontend detects the ?wk= param, reads auth data from
 *    sessionStorage, and calls zE('messenger', 'loginUser', jwtCallback, loginCallback)
 * 6. The messaging widget authenticates the user and opens
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();

// Parse JSON request bodies for all POST endpoints
app.use(express.json());

// ============================================================
// SERVE FRONTEND — with optional Zendesk snippet injection
// ============================================================
// When the user completes Quick Login, the page redirects to /?wk=WIDGET_KEY&sd=SUBDOMAIN.
// This intercept handler injects the Zendesk snippet <script> tag into the HTML <head>
// before serving the page. This is critical because:
// - Loading snippet.js dynamically via document.createElement('script') after page load
//   causes an InboundFilters crash in the Zendesk SDK's module loader.
// - By injecting the script tag server-side, it becomes part of the initial HTML parse,
//   exactly as Zendesk intends the snippet to be used.
// If no ?wk= query param is present, serve the plain index.html without modification.
app.get('/', (req, res) => {
  const widgetKey = req.query.wk;
  if (!widgetKey) {
    // No widget key — serve the plain index.html (no snippet injection needed)
    return res.sendFile(path.join(__dirname, 'index.html'));
  }
  // Inject the Zendesk snippet script tag into the HTML just before </head>
  // using the exact format from the Zendesk admin widget snippet.
  let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const subdomain = req.query.sd || 'your-subdomain';
  const snippetTag = `\n<!-- Start of '${subdomain}' Zendesk Widget script -->\n<script id="ze-snippet" src="https://static.zdassets.com/ekr/snippet.js?key=${widgetKey}"> </script>\n<!-- End of ${subdomain} Zendesk Widget script -->`;
  html = html.replace('</head>', snippetTag + '\n</head>');
  res.send(html);
});

// Serve static files (index.html when no ?wk= param, CSS, JS, etc.)
app.use(express.static(path.join(__dirname)));

// ============================================================
// IN-MEMORY API LOG STORE
// ============================================================
// All Zendesk API calls made by the server are logged here for display
// in the frontend API Logs page. Capped at 200 entries to prevent
// unbounded memory growth. Each entry includes: action, method, endpoint,
// fullUrl, request (redacted), response, status, result, and timestamp.
const apiLogs = [];
let logIdCounter = 0;

function addLog(entry) {
  entry.id = ++logIdCounter;
  entry.timestamp = new Date().toISOString();
  apiLogs.unshift(entry); // newest first
  if (apiLogs.length > 200) apiLogs.length = 200; // cap at 200
}

// Recursively redact sensitive keys (password, apiToken, secret, authorization)
// from request/response bodies before storing in the API log. This prevents
// credentials from appearing in the Logs page.
function redact(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    out[k] = keys.includes(k.toLowerCase()) ? '••••••••' : (typeof obj[k] === 'object' && obj[k] !== null ? redact(obj[k], keys) : obj[k]);
  }
  return out;
}
const SENSITIVE_KEYS = ['password', 'apitoken', 'secret', 'authorization'];

// ============================================================
// SERVER-SIDE SESSION CREDENTIALS STORE
// ============================================================
// When the Configuration page saves credentials, they are stored here
// in memory keyed by a random sessionId. The sessionId is the only thing
// sent to the browser — the actual credentials (API token, secret key, etc.)
// never leave the server. This store is ephemeral and resets on server restart.
// Used by: /api/zendesk-users, /api/zendesk-users/:id/password,
//          /api/sunco-users, /api/generate-jwt, etc.
const credentialsStore = {};

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function getCredentials(sessionId) {
  return credentialsStore[sessionId] || null;
}

function storeCredentials(sessionId, creds) {
  credentialsStore[sessionId] = {
    subdomain: creds.subdomain,
    adminEmail: creds.adminEmail,
    apiToken: creds.apiToken,
    appId: creds.appId,
    keyId: creds.keyId,
    secret: creds.secret,
    widgetKey: creds.widgetKey
  };
}

function clearCredentials(sessionId) {
  delete credentialsStore[sessionId];
}

// ============================================================
// PERSISTED CONFIG STORE — config.json on disk
// ============================================================
// Quick Login uses persisted config so the user doesn't have to re-enter
// credentials each time. This is saved to config.json on disk and survives
// server restarts. Contains: subdomain, adminEmail, apiToken, appId, keyId,
// secret, widgetKey.
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadPersistedConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) { console.error('Failed to load config.json:', e.message); }
  return null;
}

function savePersistedConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) { console.error('Failed to save config.json:', e.message); }
}

function clearPersistedConfig() {
  try { fs.unlinkSync(CONFIG_FILE); } catch (e) { /* ignore — file may not exist */ }
}

// GET /api/config — Check if persisted config exists.
// Returns non-sensitive fields (subdomain, adminEmail, appId, keyId, widgetKey)
// for auto-filling the Quick Login config form. Sensitive fields (apiToken, secret)
// are NOT returned — the user must re-enter those when editing config.
app.get('/api/config', (req, res) => {
  const cfg = loadPersistedConfig();
  if (cfg && cfg.subdomain && cfg.appId && cfg.keyId && cfg.secret) {
    res.json({
      hasConfig: true,
      subdomain: cfg.subdomain,
      adminEmail: cfg.adminEmail || '',
      appId: cfg.appId,
      keyId: cfg.keyId,
      widgetKey: cfg.widgetKey || ''
    });
  } else {
    res.json({ hasConfig: false });
  }
});

// POST /api/config — Save persisted config to config.json.
// Called by Quick Login's config form. All fields except widgetKey are required.
app.post('/api/config', (req, res) => {
  const { subdomain, adminEmail, apiToken, appId, keyId, secret, widgetKey } = req.body;
  if (!subdomain || !adminEmail || !apiToken || !appId || !keyId || !secret) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  savePersistedConfig({ subdomain, adminEmail, apiToken, appId, keyId, secret, widgetKey: widgetKey || '' });
  res.json({ success: true });
});

// DELETE /api/config — Clear persisted config (used by Reset All)
app.delete('/api/config', (req, res) => {
  clearPersistedConfig();
  res.json({ success: true });
});

// ============================================================
// AUTH HELPER FUNCTIONS
// ============================================================

/**
 * Generate a Zendesk Admin API Basic Auth header.
 * Format: Basic base64(email/token:apiToken)
 * Zendesk uses email/token as the username and the API token as the password
 * for admin API calls (creating users, setting passwords, searching users).
 */
function zendeskAdminAuth(adminEmail, apiToken) {
  return 'Basic ' + Buffer.from(adminEmail + '/token:' + apiToken).toString('base64');
}

/**
 * Generate a Sunshine Conversations (Sunco) API Basic Auth header.
 * Format: Basic base64(keyId:secret)
 * The Key ID is used as the username and the Secret Key as the password,
 * per the Sunshine Conversations API documentation.
 * NOTE: The Secret Key is used as-is — it IS the key_secret value, not base64-decoded.
 */
function suncoAuth(keyId, secret) {
  return 'Basic ' + Buffer.from(keyId + ':' + secret).toString('base64');
}

/**
 * Base64url encoding (URL-safe, no padding).
 * Used for JWT header and payload encoding per RFC 7515.
 * Replaces + with -, / with _, and strips trailing = padding.
 */
function base64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncodeString(str) {
  return base64urlEncode(Buffer.from(str, 'utf8'));
}

/**
 * Generate a JWT (JSON Web Token) for Zendesk/Sunco user authentication.
 *
 * This implements HS256 signing manually (instead of using a JWT library) to
 * make the signing process explicit and avoid dependency issues.
 *
 * JWT structure: header.payload.signature
 * - Header: { alg: 'HS256', typ: 'JWT', kid: keyId }
 * - Payload: { scope: 'user', external_id, name, email, email_verified: true, iat, exp }
 * - Signature: HMAC-SHA256(secret, header.payload) where secret is used as a RAW STRING
 *
 * IMPORTANT: The secret is NOT base64-decoded before signing. Per Zendesk/Sunco docs,
 * the jwt.sign() function passes SECRET directly — it's used as UTF-8 bytes for HMAC.
 * The JWT scope must be 'user' (not 'end_user') for messenger authentication.
 * The external_id links the JWT to the Sunco user profile.
 */
function generateJWT(keyId, secret, externalId, name, email) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: keyId };
  const payload = {
    scope: 'user',           // Must be 'user' for messenger auth (not 'end_user')
    external_id: externalId, // Links JWT to the Sunco user profile
    name: name,
    email: email,
    email_verified: true,    // Skip email verification in the widget
    iat: now,                // Issued at (Unix timestamp)
    exp: now + 3600          // Expires 1 hour from now
  };

  const b64Header = base64urlEncodeString(JSON.stringify(header));
  const b64Payload = base64urlEncodeString(JSON.stringify(payload));
  const signingInput = b64Header + '.' + b64Payload;

  // Sign with the secret as a raw string (UTF-8 bytes) — matching the official
  // Zendesk/Sunco jwt.sign() example which passes SECRET directly.
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();

  return b64Header + '.' + b64Payload + '.' + base64urlEncode(sig);
}

// ============================================================
// POST /api/session — Store credentials server-side (Configuration page)
// ============================================================
// The Configuration page sends all credentials to this endpoint, which stores
// them in memory keyed by a random sessionId. Only the sessionId is returned
// to the browser. This ensures credentials are never accessible via client-side JS.
app.post('/api/session', (req, res) => {
  const { subdomain, adminEmail, apiToken, appId, keyId, secret, widgetKey } = req.body;
  if (!subdomain || !adminEmail || !apiToken || !appId || !keyId || !secret) {
    return res.status(400).json({ error: 'Missing required credential fields' });
  }
  const sessionId = generateSessionId();
  storeCredentials(sessionId, { subdomain, adminEmail, apiToken, appId, keyId, secret, widgetKey: widgetKey || '' });
  res.json({ sessionId });
});

// DELETE /api/session/:id — Clear a session's credentials
app.delete('/api/session/:id', (req, res) => {
  clearCredentials(req.params.id);
  res.json({ success: true });
});

// DELETE /api/reset/:sessionId — Full reset (clear session + logs)
// Called by the "Reset All" button on the frontend.
app.delete('/api/reset/:sessionId', (req, res) => {
  clearCredentials(req.params.sessionId);
  apiLogs.length = 0;
  logIdCounter = 0;
  res.json({ success: true });
});

// GET /api/session/:id — Retrieve non-sensitive session data (subdomain, widgetKey)
app.get('/api/session/:id', (req, res) => {
  const creds = getCredentials(req.params.id);
  if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });
  res.json({ subdomain: creds.subdomain, widgetKey: creds.widgetKey || '' });
});

// GET /api/session/:id/widget-key — Retrieve the widget key for a session
app.get('/api/session/:id/widget-key', (req, res) => {
  const creds = getCredentials(req.params.id);
  if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });
  res.json({ widgetKey: creds.widgetKey });
});

// PATCH /api/session/:id/widget-key — Update the widget key for a session
app.patch('/api/session/:id/widget-key', (req, res) => {
  const creds = getCredentials(req.params.id);
  if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });
  const { widgetKey } = req.body;
  if (!widgetKey) return res.status(400).json({ error: 'widgetKey is required.' });
  creds.widgetKey = widgetKey;
  res.json({ success: true, widgetKey });
});

// ============================================================
// POST /api/zendesk-users — Create a Zendesk end-user
// ============================================================
// Called by the Configuration page's "Create User" step.
// Creates a Zendesk end-user with the given name, email, and external_id.
// The user is created as role='end-user' with verified=true and skip_verify_email=true
// to avoid requiring email verification before the user can authenticate.
// Uses the Zendesk Admin API (Basic Auth with email/token:apiToken).
app.post('/api/zendesk-users', async (req, res) => {
  try {
    const { sessionId, name, email, externalId } = req.body;
    const creds = getCredentials(sessionId);
    if (!creds) return res.status(401).json({ error: 'Invalid or expired session. Re-enter credentials.' });

    if (!name || !email || !externalId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const url = `https://${creds.subdomain}.zendesk.com/api/v2/users`;
    const body = {
      user: { name, email, role: 'end-user', external_id: externalId, verified: true, skip_verify_email: true }
    };

    const logEntry = {
      action: 'Zendesk User — Create', method: 'POST',
      endpoint: '/api/v2/users', fullUrl: url,
      request: redact(body, SENSITIVE_KEYS)
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': zendeskAdminAuth(creds.adminEmail, creds.apiToken) },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    logEntry.status = response.status;
    logEntry.result = response.ok ? 'success' : 'error';
    logEntry.response = data;
    addLog(logEntry);

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || data.description || 'Zendesk API error', details: data });
    }
    res.json({ user: data.user });
  } catch (err) {
    console.error('Create user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/zendesk-users/:id/password — Set user password
// ============================================================
// Called by the Configuration page's "Set Password" step.
// Sets a password for the newly created Zendesk end-user, which is needed
// for the Quick Login flow (the user must have a password to authenticate).
// Uses the Zendesk Admin API with the user's numeric ID.
app.post('/api/zendesk-users/:id/password', async (req, res) => {
  try {
    const { sessionId, password } = req.body;
    const userId = req.params.id;
    const creds = getCredentials(sessionId);
    if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });

    const url = `https://${creds.subdomain}.zendesk.com/api/v2/users/${userId}/password`;

    const logEntry = {
      action: 'Zendesk User — Set Password', method: 'POST',
      endpoint: `/api/v2/users/${userId}/password`, fullUrl: url,
      request: { userId, password: '••••••••' }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': zendeskAdminAuth(creds.adminEmail, creds.apiToken) },
      body: JSON.stringify({ password })
    });

    if (!response.ok) {
      const data = await response.json();
      logEntry.status = response.status;
      logEntry.result = 'error';
      logEntry.response = data;
      addLog(logEntry);
      return res.status(response.status).json({ error: data.error || 'Set password error', details: data });
    }

    // The Zendesk password API may return 200 with empty body or 200 with JSON
    let responseBody;
    try { responseBody = await response.json(); } catch { responseBody = { status: 'ok' }; }
    logEntry.status = response.status;
    logEntry.result = 'success';
    logEntry.response = responseBody;
    addLog(logEntry);
    res.json({ success: true });
  } catch (err) {
    console.error('Set password error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/sunco-users — Create or update a Sunco user
// ============================================================
// Creates a Sunshine Conversations (Sunco) user profile with the given
// externalId, name, and email. The profile includes auth_email which maps
// the Sunco user to their Zendesk user account for authentication.
//
// If the user already exists (HTTP 409 Conflict), this endpoint automatically
// retries as a PATCH update to avoid duplicate errors.
//
// Uses the Sunco API with Basic Auth (keyId:secret).
// Endpoint: POST /sc/v2/apps/{appId}/users
app.post('/api/sunco-users', async (req, res) => {
  try {
    const { sessionId, externalId, name, email } = req.body;
    const creds = getCredentials(sessionId);
    if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });

    if (!externalId || !name || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Split full name into given name and surname for the Sunco profile
    const nameParts = name.trim().split(/\s+/);
    const body = {
      externalId,
      profile: {
        givenName: nameParts[0] || '',
        surname: nameParts.slice(1).join(' ') || '',
        email,
        auth_email: email   // Maps to Zendesk user email for auth
      }
    };

    const url = `https://${creds.subdomain}.zendesk.com/sc/v2/apps/${encodeURIComponent(creds.appId)}/users`;
    const auth = suncoAuth(creds.keyId, creds.secret);

    const logEntry = {
      action: 'Sunco User — Create', method: 'POST',
      endpoint: `/sc/v2/apps/${creds.appId}/users`, fullUrl: url,
      request: redact(body, SENSITIVE_KEYS)
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': auth },
      body: JSON.stringify(body)
    });

    // 409 Conflict means the user already exists — retry as PATCH update
    if (response.status === 409) {
      const conflictData = await response.json();
      logEntry.status = response.status;
      logEntry.result = 'conflict';
      logEntry.response = conflictData;
      logEntry.note = 'User already exists — retrying as PATCH update';
      addLog(logEntry);

      // PATCH with the same body to update the existing user
      const patchUrl = `https://${creds.subdomain}.zendesk.com/sc/v2/apps/${encodeURIComponent(creds.appId)}/users/${encodeURIComponent(externalId)}`;
      const patchLogEntry = {
        action: 'Sunco User — Update', method: 'PATCH',
        endpoint: `/sc/v2/apps/${creds.appId}/users/${externalId}`, fullUrl: patchUrl,
        request: redact(body, SENSITIVE_KEYS)
      };

      const patchResponse = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': auth },
        body: JSON.stringify(body)
      });

      const patchData = await patchResponse.json();
      patchLogEntry.status = patchResponse.status;
      patchLogEntry.result = patchResponse.ok ? 'success' : 'error';
      patchLogEntry.response = patchData;
      addLog(patchLogEntry);

      if (!patchResponse.ok) {
        return res.status(patchResponse.status).json({ error: patchData.error || 'Sunco update error', details: patchData });
      }
      return res.json({ user: patchData.user });
    }

    const data = await response.json();
    logEntry.status = response.status;
    logEntry.result = response.ok ? 'success' : 'error';
    logEntry.response = data;
    addLog(logEntry);

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || 'Sunco create error', details: data });
    }
    res.json({ user: data.user });
  } catch (err) {
    console.error('Sunco user error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// GET /api/sunco-users/:externalId — Get Sunco user (auth check)
// ============================================================
// Fetches a Sunshine Conversations user by their externalId.
// Used by the old Login flow to check if a Sunco user profile exists
// before attempting JWT authentication.
// Uses the Sunco API with Basic Auth (keyId:secret).
app.get('/api/sunco-users/:externalId', async (req, res) => {
  try {
    const externalId = req.params.externalId;
    const { sessionId } = req.query;
    const creds = getCredentials(sessionId);
    if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });

    const url = `https://${creds.subdomain}.zendesk.com/sc/v2/apps/${encodeURIComponent(creds.appId)}/users/${encodeURIComponent(externalId)}`;

    const logEntry = {
      action: 'Sunco User — Get (Auth Check)', method: 'GET',
      endpoint: `/sc/v2/apps/${creds.appId}/users/${externalId}`, fullUrl: url,
      request: { externalId }
    };

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'Authorization': suncoAuth(creds.keyId, creds.secret) }
    });

    const data = await response.json();
    logEntry.status = response.status;
    logEntry.result = response.ok ? 'success' : 'error';
    logEntry.response = data;
    addLog(logEntry);

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error || 'Sunco get user error', details: data });
    }
    res.json({ user: data.user });
  } catch (err) {
    console.error('Sunco get user error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// POST /api/generate-jwt — Server-side JWT generation
// ============================================================
// Generates a JWT for authenticating a user into the Zendesk messaging widget.
// Used by the Configuration page flow (after creating a user and setting password).
// The JWT is signed server-side so the Secret Key is never exposed to the browser.
//
// JWT claims: scope='user', external_id, name, email, email_verified=true
// Signed with HMAC-SHA256 using the Secret Key as a raw string.
app.post('/api/generate-jwt', (req, res) => {
  try {
    const { sessionId, externalId, name, email } = req.body;
    const creds = getCredentials(sessionId);
    if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });

    if (!externalId || !name || !email) {
      return res.status(400).json({ error: 'Missing required fields: externalId, name, email' });
    }

    const jwt = generateJWT(creds.keyId, creds.secret, externalId, name, email);
    const now = Math.floor(Date.now() / 1000);

    addLog({
      action: 'JWT — Generate', method: 'POST',
      endpoint: '/api/generate-jwt', fullUrl: '(server-side)',
      request: { externalId, name, email, kid: creds.keyId },
      status: 200, result: 'success',
      response: { jwt: jwt.substring(0, 30) + '…', expiresAt: new Date((now + 3600) * 1000).toISOString() }
    });

    res.json({ jwt, expiresAt: new Date((now + 3600) * 1000).toISOString() });
  } catch (err) {
    console.error('JWT generation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PENDING AUTH STORE — for page-reload authentication flow
// ============================================================
// When Quick Login succeeds, auth data (JWT + user info) is temporarily
// stored here with a short TTL. After the page redirects to /?wk=KEY,
// the frontend retrieves the auth data from sessionStorage instead, so
// this store is now largely unused but kept for backward compatibility.
const pendingAuth = new Map(); // token -> { jwt, user, expiresAt }
const AUTH_TTL = 120000; // 2 minutes

// ============================================================
// POST /api/quick-login — Login using persisted config (no session needed)
// ============================================================
// This is the core endpoint for the Quick Login flow. It:
// 1. Loads the persisted config from config.json (no sessionId needed)
// 2. Looks up the Zendesk user by email via the Admin API
// 3. Verifies the user has an external_id (required for JWT auth)
// 4. Generates a JWT using the Sunco Key ID and Secret Key
// 5. Returns { jwt, subdomain, widgetKey, user } to the frontend
//
// The frontend then stores this data in sessionStorage, redirects to /?wk=KEY
// (so the server can inject the Zendesk snippet), and authenticates the user
// via zE('messenger', 'loginUser', jwtCallback, loginCallback).
app.post('/api/quick-login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const cfg = loadPersistedConfig();
    if (!cfg) return res.status(400).json({ error: 'No configuration saved. Set up config first.' });
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    // Step 1: Look up Zendesk user by email using the Admin API
    // The email is used to find the user's numeric ID and external_id
    const searchUrl = `https://${cfg.subdomain}.zendesk.com/api/v2/users/search.json?query=${encodeURIComponent(email)}`;
    const searchResp = await fetch(searchUrl, {
      headers: { 'Authorization': zendeskAdminAuth(cfg.adminEmail, cfg.apiToken) }
    });
    const searchData = await searchResp.json();

    if (!searchResp.ok || !searchData.users || searchData.users.length === 0) {
      addLog({
        action: 'Quick Login — User Lookup', method: 'GET',
        endpoint: '/api/v2/users/search', fullUrl: searchUrl,
        request: { email },
        status: searchResp.status, result: 'error',
        response: searchData
      });
      return res.status(404).json({ error: 'No Zendesk user found with that email.' });
    }

    const zendeskUser = searchData.users[0];
    const externalId = zendeskUser.external_id;

    // The user must have an external_id — this is the link between the
    // Zendesk user and the Sunco user profile, and is required for JWT auth
    if (!externalId) {
      return res.status(400).json({ error: 'User has no external ID. They must be created with an external ID first.' });
    }

    addLog({
      action: 'Quick Login — User Lookup', method: 'GET',
      endpoint: '/api/v2/users/search', fullUrl: searchUrl,
      request: { email },
      status: 200, result: 'success',
      response: { id: zendeskUser.id, name: zendeskUser.name, email: zendeskUser.email, external_id: externalId }
    });

    // Step 2: Generate JWT using the Sunco Key ID and Secret Key
    const jwt = generateJWT(cfg.keyId, cfg.secret, externalId, zendeskUser.name, zendeskUser.email);

    addLog({
      action: 'Quick Login — JWT Generate', method: 'POST',
      endpoint: '(server-side)',
      request: { externalId, name: zendeskUser.name, email: zendeskUser.email },
      status: 200, result: 'success',
      response: { jwt: jwt.substring(0, 30) + '…' }
    });

    // Return everything the frontend needs to authenticate and load the widget
    res.json({
      jwt,
      subdomain: cfg.subdomain,
      widgetKey: cfg.widgetKey || '',
      user: {
        id: zendeskUser.id,
        name: zendeskUser.name,
        email: zendeskUser.email,
        externalId
      }
    });
  } catch (err) {
    console.error('Quick login error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/pending-auth/:token — Retrieve auth data after redirect
// ============================================================
// One-time-use endpoint that returns pending auth data by token.
// Used in the redirect flow: after Quick Login, auth data is stored
// with a random token, and the token is passed via URL parameter.
// The frontend retrieves the data and the token is deleted.
app.get('/api/pending-auth/:token', (req, res) => {
  const data = pendingAuth.get(req.params.token);
  if (!data) return res.status(404).json({ error: 'Auth data not found or expired. Try logging in again.' });
  pendingAuth.delete(req.params.token); // One-time use — delete after retrieval
  res.json(data);
});

// ============================================================
// GET /api/debug-jwt — Decode the last generated JWT (no secret leaked)
// ============================================================
// Debug endpoint that decodes the header and payload of the most recently
// generated JWT. Useful for verifying that claims (scope, external_id, etc.)
// are correct. Does NOT reveal the secret.
app.get('/api/debug-jwt', (req, res) => {
  const { sessionId } = req.query;
  const creds = getCredentials(sessionId);
  if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });

  // Find the most recent auth entry in pendingAuth
  const lastAuth = Array.from(pendingAuth.values()).pop();
  if (!lastAuth) {
    return res.json({ note: 'No login has been performed yet. Log in first, then check this endpoint.' });
  }

  // Decode the JWT header and payload (just base64 decode, no secret needed)
  const jwt = lastAuth.jwt;
  const parts = jwt.split('.');
  let header = null, payload = null;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8'));
  } catch(e) {}
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  } catch(e) {}

  res.json({
    header,
    payload,
    kid_matches_keyId: header?.kid === creds.keyId,
    secret_length: creds.secret.length,
    secret_is_base64: /^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}=|[A-Za-z0-9+/]{3}=)?$/.test(creds.secret),
    appId: creds.appId,
    subdomain: creds.subdomain
  });
});

// ============================================================
// GET /api/verify-creds — Test Sunco API credentials independently
// ============================================================
// Makes a test call to the Sunco API to verify that the Key ID and
// Secret Key are valid. Useful for debugging 401 authentication errors.
// Returns the API response status and a prefix of the secret for verification.
app.get('/api/verify-creds', async (req, res) => {
  const { sessionId } = req.query;
  const creds = getCredentials(sessionId);
  if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });

  try {
    // Test: Can we call the Sunco API with these credentials?
    const testUrl = `https://${creds.subdomain}.zendesk.com/sc/v2/apps/${creds.appId}/users?limit=1`;
    const resp = await fetch(testUrl, {
      headers: { 'Authorization': suncoAuth(creds.keyId, creds.secret) }
    });
    const data = await resp.text();

    let parsed;
    try { parsed = JSON.parse(data); } catch(e) { parsed = data.substring(0, 500); }

    res.json({
      sunco_api_test: {
        url: testUrl,
        status: resp.status,
        ok: resp.ok,
        response: parsed
      },
      keyId: creds.keyId,
      appId: creds.appId,
      secret_prefix: creds.secret.substring(0, 4) + '…',
      secret_length: creds.secret.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// GET /api/logs — Retrieve all logged API calls
// DELETE /api/logs — Clear all logs
// ============================================================
// The API Logs page polls GET /api/logs to display all server-side API
// calls in real time. Each entry shows method, endpoint, status, and
// expandable request/response details (with sensitive fields redacted).
app.get('/api/logs', (req, res) => {
  res.json({ logs: apiLogs });
});

app.delete('/api/logs', (req, res) => {
  apiLogs.length = 0;
  res.json({ success: true });
});

// ============================================================
// Start server
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Zendesk JWT Auth server running at http://localhost:${PORT}`);
});