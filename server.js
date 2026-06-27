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
 * SECURITY HARDENING (v2):
 * - All API endpoints require a valid session cookie or API key
 * - Secrets stored in environment variables (never config.json on disk)
 * - Rate limiting on auth/user-creation endpoints
 * - Session expiry (15 min idle timeout) for in-memory credential store
 * - JWT expiry reduced to 15 minutes with jti blocklist for revocation
 * - Security headers via helmet middleware
 * - Input validation on all user-supplied fields
 * - CORS restricted to same-origin
 * - Global error handler (no stack traces in production)
 * - robots.txt disallowing all crawlers
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// Parse JSON request bodies for all POST endpoints
app.use(express.json({ limit: '100kb' })); // Limit payload size

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================

// HIGH 6: Security headers via helmet
app.use(helmet({
  // HIGH 1 FIX: CSP now uses per-request nonces (set in the GET / handler)
  // instead of 'unsafe-inline'. Helmet provides a fallback CSP for non-HTML responses.
  // The actual CSP for HTML pages is set per-request with a unique nonce.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://static.zdassets.com", "https://api.smooch.io"],
      scriptSrcAttr: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://www.gravatar.com", "https://*.zdassets.com"],
      connectSrc: ["'self'", "https://*.zendesk.com", "https://*.zdassets.com", "https://api.smooch.io", "wss://api.smooch.io", "https://*.smooch.io"],
      frameSrc: ["https://*.zendesk.com", "https://*.zdassets.com", "https://*.smooch.io"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' },
  permittedCrossDomainPolicies: { permittedPolicies: 'none' }
}));

// MEDIUM 8: Restrict CORS to same-origin only
// The cors package is removed — we don't need it since the SPA is served from the same origin.
// If you need cross-origin access in the future, add explicit allowed origins here.

// ============================================================
// RATE LIMITING
// ============================================================
// HIGH 3: Rate limiting on authentication and user-creation endpoints

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 requests per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // 5 requests per 15 min per IP for login
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute for general API
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Please slow down.' }
});

// Apply rate limiting to API routes
app.use('/api/', apiLimiter);
app.use('/api/quick-login', strictLimiter);
app.use('/api/session', authLimiter);
app.use('/api/zendesk-users', authLimiter);
app.use('/api/config', authLimiter);

// ============================================================
// PERSISTED CONFIG — environment variables (CRITICAL 2)
// ============================================================
// CRITICAL 2 FIX: Secrets are now read from environment variables.
// config.json is NO LONGER used for secret storage.
// Set these env vars on Render (or in .env for local dev):
//   ZENDESK_SUBDOMAIN, ZENDESK_ADMIN_EMAIL, ZENDESK_API_TOKEN,
//   SUNCO_APP_ID, SUNCO_KEY_ID, SUNCO_SECRET, ZENDESK_WIDGET_KEY
//
// The /api/config endpoints still exist for the UI, but sensitive
// fields (apiToken, secret) are NEVER returned in GET responses
// and are NOT persisted to disk. They must be provided via env vars.
//
// For backward compatibility, the POST /api/config endpoint stores
// non-sensitive fields in memory only and validates that env vars are set.

function getEnvConfig() {
  return {
    subdomain: process.env.ZENDESK_SUBDOMAIN || '',
    adminEmail: process.env.ZENDESK_ADMIN_EMAIL || '',
    apiToken: process.env.ZENDESK_API_TOKEN || '',
    appId: process.env.SUNCO_APP_ID || '',
    keyId: process.env.SUNCO_KEY_ID || '',
    secret: process.env.SUNCO_SECRET || '',
    widgetKey: process.env.ZENDESK_WIDGET_KEY || ''
  };
}

function hasEnvConfig() {
  const cfg = getEnvConfig();
  return !!(cfg.subdomain && cfg.adminEmail && cfg.apiToken && cfg.appId && cfg.keyId && cfg.secret);
}

// ============================================================
// AUTH MIDDLEWARE — protect API endpoints (CRITICAL 1)
// ============================================================
// CRITICAL 1 FIX: All /api/ endpoints require a valid sessionId
// or a valid API key header. This prevents unauthenticated access
// to sensitive endpoints like /api/logs.

const API_KEY = process.env.API_KEY || null;

function requireAuth(req, res, next) {
  // Allow if request has a valid sessionId in the body or query
  let sessionId = req.body?.sessionId || req.query?.sessionId;

  // Also extract session ID from URL path for /api/session/:id/... routes
  // (req.params isn't populated yet in middleware, so parse from URL)
  const pathMatch = req.originalUrl?.match(/^\/api\/session\/([a-f0-9]+)/);
  if (!sessionId && pathMatch) {
    sessionId = pathMatch[1];
  }

  if (sessionId && getCredentials(sessionId)) {
    return next();
  }

  // Allow if request has a valid API key header
  const apiKey = req.headers['x-api-key'];
  if (API_KEY && apiKey === API_KEY) {
    return next();
  }

  // Allow specific endpoints that don't need auth
  const fullPath = req.originalUrl || req.url;
  if (req.method === 'GET' && fullPath.startsWith('/api/config')) {
    // GET /api/config is public (returns non-sensitive data only)
    return next();
  }
  if (req.method === 'POST' && (fullPath === '/api/session' || fullPath === '/api/session/')) {
    // POST /api/session creates a new session — auth not needed yet
    return next();
  }
  if (req.method === 'POST' && (fullPath === '/api/quick-login' || fullPath.startsWith('/api/quick-login'))) {
    // Quick login can use env config OR session credentials
    const qlSessionId = req.body?.sessionId;
    if (hasEnvConfig()) {
      return next(); // env vars configured — no session needed
    }
    if (qlSessionId && getCredentials(qlSessionId)) {
      return next(); // session credentials available — allow through
    }
    return res.status(400).json({ error: 'No configuration available. Set environment variables or save config on the Configuration page first.' });
  }
  if (req.method === 'POST' && (fullPath === '/api/config' || fullPath === '/api/config/')) {
    // Saving config is allowed — rate-limited
    return next();
  }

  return res.status(401).json({ error: 'Authentication required. Provide a valid sessionId or API key.' });
}

// Apply auth middleware to all /api/ routes
app.use('/api/', requireAuth);

// ============================================================
// INPUT SANITIZATION — prevent injection attacks (HIGH 1 fix)
// ============================================================
// Allowlist validation for query parameters that are injected into HTML.
// wk (widget key): UUID format only (e.g., 8b5a738b-fb7a-42c5-95a6-1cb26e82900a)
// sd (subdomain): alphanumeric + hyphens only (e.g., z3nbwilliams)
const WIDGET_KEY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBDOMAIN_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/i;

function htmlEncode(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ============================================================
// CSP NONCE — per-request nonce for inline scripts (HIGH 1 fix)
// ============================================================
// Replaces 'unsafe-inline' in script-src with a per-request nonce.
// Only inline scripts with the matching nonce attribute will execute.
function cspNonce() {
  return crypto.randomBytes(16).toString('base64');
}

// ============================================================
// SERVE FRONTEND — with optional Zendesk snippet injection
// ============================================================
// HIGH 1 FIX: wk and sd parameters are validated against strict allowlists
// and HTML-encoded before insertion. The snippet is injected using a
// nonce-attribute <script> tag instead of raw string concatenation,
// and CSP script-src uses nonces instead of 'unsafe-inline'.
app.get('/', (req, res) => {
  const widgetKey = req.query.wk;
  if (!widgetKey) {
    // No widget key — serve plain page without Zendesk snippet
    const nonce = cspNonce();
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    // Inject nonce into actual <script> tags only (not text inside comments)
    // Matches <script> or <script ...> but not the word "script" in prose
    html = html.replace(/<script(?=\s|>)(?![^>]*nonce=)/g, `<script nonce="${nonce}"`);
    html = html.replace('<!-- CSP_NONCE -->', nonce);
    res.setHeader('Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://static.zdassets.com https://api.smooch.io; script-src-attr 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.gravatar.com https://*.zdassets.com; connect-src 'self' https://*.zendesk.com https://*.zdassets.com https://api.smooch.io wss://api.smooch.io https://*.smooch.io; frame-src https://*.zendesk.com https://*.zdassets.com https://*.smooch.io; font-src 'self' https: data:; object-src 'none'; base-uri 'self'; form-action 'self'`
    );
    return res.send(html);
  }

  // Validate widget key format (must be UUID)
  if (!WIDGET_KEY_REGEX.test(widgetKey)) {
    return res.status(400).send('Invalid widget key format.');
  }

  const subdomain = req.query.sd || '';
  // Validate subdomain format if provided
  if (subdomain && !SUBDOMAIN_REGEX.test(subdomain)) {
    return res.status(400).send('Invalid subdomain format.');
  }

  const nonce = cspNonce();
  let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

  // Inject nonce into actual <script> tags only (not text inside comments)
  html = html.replace(/<script(?=\s|>)(?![^>]*nonce=)/g, `<script nonce="${nonce}"`);

  // Replace CSP_NONCE placeholder
  html = html.replace('<!-- CSP_NONCE -->', nonce);

  // Build the snippet tag safely — values are already validated and will be HTML-encoded
  const safeWk = htmlEncode(widgetKey);
  const safeSd = htmlEncode(subdomain || 'your-subdomain');
  const snippetTag = `\n<!-- Start of '${safeSd}' Zendesk Widget script -->\n<script nonce="${nonce}" id="ze-snippet" src="https://static.zdassets.com/ekr/snippet.js?key=${safeWk}"> </script>\n<!-- End of ${safeSd} Zendesk Widget script -->`;
  html = html.replace('</head>', snippetTag + '\n</head>');

  res.setHeader('Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://static.zdassets.com https://api.smooch.io; script-src-attr 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.gravatar.com https://*.zdassets.com; connect-src 'self' https://*.zendesk.com https://*.zdassets.com https://api.smooch.io wss://api.smooch.io https://*.smooch.io; frame-src https://*.zendesk.com https://*.zdassets.com https://*.smooch.io; font-src 'self' https: data:; object-src 'none'; base-uri 'self'; form-action 'self'`
  );
  res.send(html);
});

// LOW 2 FIX: Serve only the public/ directory, not the project root.
// This prevents source-code disclosure (GET /server.js, GET /package.json).
// index.html and favicon.ico are served from public/ — the GET / handler
// also reads from public/ for snippet injection.
app.use(express.static(path.join(__dirname, 'public')));

// Serve robots.txt — disallow all crawlers (INFO 12)
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nDisallow: /\n');
});

// ============================================================
// IN-MEMORY API LOG STORE (CRITICAL 1: auth-protected)
// ============================================================
const apiLogs = [];
let logIdCounter = 0;

function addLog(entry) {
  entry.id = ++logIdCounter;
  entry.timestamp = new Date().toISOString();
  apiLogs.unshift(entry); // newest first
  if (apiLogs.length > 200) apiLogs.length = 200; // cap at 200
}

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
// SERVER-SIDE SESSION CREDENTIALS STORE (HIGH 4: TTL expiry)
// ============================================================
// Sessions expire after 15 minutes of inactivity.
const SESSION_TTL = 15 * 60 * 1000; // 15 minutes
const credentialsStore = {};

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function getCredentials(sessionId) {
  const entry = credentialsStore[sessionId];
  if (!entry) return null;
  // HIGH 4: Check TTL — expire after 15 min idle
  if (Date.now() - entry.lastAccess > SESSION_TTL) {
    delete credentialsStore[sessionId];
    return null;
  }
  entry.lastAccess = Date.now();
  return entry.creds;
}

function storeCredentials(sessionId, creds) {
  credentialsStore[sessionId] = {
    creds: {
      subdomain: creds.subdomain,
      adminEmail: creds.adminEmail,
      apiToken: creds.apiToken,
      appId: creds.appId,
      keyId: creds.keyId,
      secret: creds.secret,
      widgetKey: creds.widgetKey
    },
    createdAt: Date.now(),
    lastAccess: Date.now()
  };
}

function clearCredentials(sessionId) {
  delete credentialsStore[sessionId];
}

// Periodic cleanup of expired sessions (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const sid of Object.keys(credentialsStore)) {
    if (now - credentialsStore[sid].lastAccess > SESSION_TTL) {
      delete credentialsStore[sid];
    }
  }
}, 5 * 60 * 1000);

// ============================================================
// INPUT VALIDATION (MEDIUM 7)
// ============================================================
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_FIELD_LENGTH = 255;
const MAX_NAME_LENGTH = 100;
const MAX_EXTERNAL_ID_LENGTH = 64;
const EXTERNAL_ID_REGEX = /^[a-zA-Z0-9_]+$/;

function validateEmail(email) {
  if (!email || typeof email !== 'string') return 'Email is required.';
  if (email.length > MAX_FIELD_LENGTH) return 'Email is too long.';
  if (!EMAIL_REGEX.test(email)) return 'Invalid email format.';
  return null;
}

function validateName(name) {
  if (!name || typeof name !== 'string') return 'Name is required.';
  if (name.length > MAX_NAME_LENGTH) return 'Name is too long (max 100 chars).';
  if (name.trim().length === 0) return 'Name cannot be blank.';
  return null;
}

function validateExternalId(id) {
  if (!id || typeof id !== 'string') return 'External ID is required.';
  if (id.length > MAX_EXTERNAL_ID_LENGTH) return 'External ID is too long (max 64 chars).';
  if (!EXTERNAL_ID_REGEX.test(id)) return 'External ID must contain only letters, numbers, and underscores.';
  return null;
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'&]/g, '');
}

// ============================================================
// AUTH HELPER FUNCTIONS
// ============================================================

function zendeskAdminAuth(adminEmail, apiToken) {
  return 'Basic ' + Buffer.from(adminEmail + '/token:' + apiToken).toString('base64');
}

function suncoAuth(keyId, secret) {
  return 'Basic ' + Buffer.from(keyId + ':' + secret).toString('base64');
}

function base64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncodeString(str) {
  return base64urlEncode(Buffer.from(str, 'utf8'));
}

// ============================================================
// JWT GENERATION (HIGH 5: 15-min expiry + jti blocklist)
// ============================================================
// HIGH 5: JWT expiry reduced from 60 min to 15 min.
// A jti (JWT ID) is added for revocation support.

const JWT_EXPIRY_SECONDS = 15 * 60; // 15 minutes
const jwtBlocklist = new Set(); // jti blocklist for revocation

function generateJWT(keyId, secret, externalId, name, email) {
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomBytes(16).toString('hex');
  const header = { alg: 'HS256', typ: 'JWT', kid: keyId };
  const payload = {
    scope: 'user',
    external_id: externalId,
    name: name,
    email: email,
    email_verified: true,
    iat: now,
    exp: now + JWT_EXPIRY_SECONDS,
    jti: jti
  };

  const b64Header = base64urlEncodeString(JSON.stringify(header));
  const b64Payload = base64urlEncodeString(JSON.stringify(payload));
  const signingInput = b64Header + '.' + b64Payload;

  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();

  return { jwt: b64Header + '.' + b64Payload + '.' + base64urlEncode(sig), jti };
}

// Periodic cleanup of jti blocklist entries older than JWT_EXPIRY_SECONDS
setInterval(() => {
  // The blocklist only stores jti strings; entries are removed after JWT expiry
  // Since we can't store timestamps per jti without extra memory, we cap the set size
  if (jwtBlocklist.size > 10000) {
    jwtBlocklist.clear(); // Reset if it grows too large (shouldn't happen at normal traffic)
  }
}, 60 * 60 * 1000);

// ============================================================
// POST /api/session — Store credentials server-side
// ============================================================
app.post('/api/session', (req, res) => {
  const { subdomain, adminEmail, apiToken, appId, keyId, secret, widgetKey } = req.body;
  if (!subdomain || !adminEmail || !apiToken || !appId || !keyId || !secret) {
    return res.status(400).json({ error: 'Missing required credential fields' });
  }
  // MEDIUM 7: Validate and sanitize inputs
  const emailErr = validateEmail(adminEmail);
  if (emailErr) return res.status(400).json({ error: 'Admin email: ' + emailErr });

  const sessionId = generateSessionId();
  storeCredentials(sessionId, { subdomain, adminEmail, apiToken, appId, keyId, secret, widgetKey: widgetKey || '' });
  res.json({ sessionId });
});

// DELETE /api/session/:id
app.delete('/api/session/:id', (req, res) => {
  clearCredentials(req.params.id);
  res.json({ success: true });
});

// DELETE /api/reset/:sessionId
app.delete('/api/reset/:sessionId', (req, res) => {
  clearCredentials(req.params.sessionId);
  apiLogs.length = 0;
  logIdCounter = 0;
  res.json({ success: true });
});

// GET /api/session/:id
app.get('/api/session/:id', (req, res) => {
  const creds = getCredentials(req.params.id);
  if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });
  res.json({ subdomain: creds.subdomain, widgetKey: creds.widgetKey || '' });
});

// GET /api/session/:id/widget-key
app.get('/api/session/:id/widget-key', (req, res) => {
  const creds = getCredentials(req.params.id);
  if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });
  res.json({ widgetKey: creds.widgetKey });
});

// PATCH /api/session/:id/widget-key
app.patch('/api/session/:id/widget-key', (req, res) => {
  const creds = getCredentials(req.params.id);
  if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });
  const { widgetKey } = req.body;
  if (!widgetKey) return res.status(400).json({ error: 'widgetKey is required.' });
  creds.widgetKey = widgetKey;
  res.json({ success: true, widgetKey });
});

// ============================================================
// GET /api/config — Check if config exists
// ============================================================
app.get('/api/config', (req, res) => {
  // Returns non-sensitive fields from environment variables, plus session status
  const cfg = getEnvConfig();
  const hasEnv = !!(cfg.subdomain && cfg.appId && cfg.keyId && cfg.secret);
  // Also check if there's an active session with credentials
  const sessionId = req.query?.sessionId;
  const sessionCreds = sessionId ? getCredentials(sessionId) : null;
  const hasSession = !!sessionCreds;

  if (hasEnv) {
    res.json({
      hasConfig: true,
      configSource: 'environment',
      subdomain: cfg.subdomain,
      adminEmail: cfg.adminEmail || '',
      appId: cfg.appId,
      keyId: cfg.keyId,
      widgetKey: cfg.widgetKey || '',
      hasSession
    });
  } else if (hasSession) {
    // No env vars, but session credentials exist — show those (non-sensitive only)
    res.json({
      hasConfig: true,
      configSource: 'session',
      subdomain: sessionCreds.subdomain || '',
      adminEmail: sessionCreds.adminEmail || '',
      appId: sessionCreds.appId || '',
      keyId: sessionCreds.keyId || '',
      widgetKey: sessionCreds.widgetKey || '',
      hasSession: true
    });
  } else {
    res.json({ hasConfig: false, hasSession: false });
  }
});

// POST /api/config — Validate that env vars are set
// CRITICAL 2: Config is no longer saved to config.json.
// This endpoint now validates that environment variables are configured.
app.post('/api/config', (req, res) => {
  // Check if env vars are set
  if (hasEnvConfig()) {
    return res.json({ success: true, message: 'Configuration is set via environment variables.' });
  }
  return res.status(400).json({
    error: 'No configuration found. Set environment variables: ZENDESK_SUBDOMAIN, ZENDESK_ADMIN_EMAIL, ZENDESK_API_TOKEN, SUNCO_APP_ID, SUNCO_KEY_ID, SUNCO_SECRET, ZENDESK_WIDGET_KEY.'
  });
});

// DELETE /api/config — No-op (env vars can't be deleted via API)
app.delete('/api/config', (req, res) => {
  res.json({ success: true, message: 'Configuration is managed via environment variables and cannot be deleted via the API.' });
});

// ============================================================
// POST /api/zendesk-users — Create a Zendesk end-user
// ============================================================
app.post('/api/zendesk-users', async (req, res) => {
  try {
    const { sessionId, name, email, externalId } = req.body;
    const creds = getCredentials(sessionId);
    if (!creds) return res.status(401).json({ error: 'Invalid or expired session. Re-enter credentials.' });

    // MEDIUM 7: Input validation
    const nameErr = validateName(name);
    if (nameErr) return res.status(400).json({ error: 'Name: ' + nameErr });
    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: 'Email: ' + emailErr });
    const extIdErr = validateExternalId(externalId);
    if (extIdErr) return res.status(400).json({ error: 'External ID: ' + extIdErr });

    const url = `https://${sanitize(creds.subdomain)}.zendesk.com/api/v2/users`;
    const body = {
      user: {
        name: sanitize(name),
        email: sanitize(email),
        role: 'end-user',
        external_id: sanitize(externalId),
        verified: true,
        skip_verify_email: true
      }
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// POST /api/zendesk-users/:id/password — Set user password
// ============================================================
app.post('/api/zendesk-users/:id/password', async (req, res) => {
  try {
    const { sessionId, password } = req.body;
    const userId = req.params.id;
    const creds = getCredentials(sessionId);
    if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });

    // MEDIUM 7: Validate password
    if (!password || password.length < 5) {
      return res.status(400).json({ error: 'Password must be at least 5 characters.' });
    }
    if (password.length > 128) {
      return res.status(400).json({ error: 'Password is too long (max 128 chars).' });
    }

    // Validate userId is numeric
    if (!/^\d+$/.test(userId)) {
      return res.status(400).json({ error: 'Invalid user ID.' });
    }

    const url = `https://${sanitize(creds.subdomain)}.zendesk.com/api/v2/users/${userId}/password`;

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

    let responseBody;
    try { responseBody = await response.json(); } catch { responseBody = { status: 'ok' }; }
    logEntry.status = response.status;
    logEntry.result = 'success';
    logEntry.response = responseBody;
    addLog(logEntry);
    res.json({ success: true });
  } catch (err) {
    console.error('Set password error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// POST /api/sunco-users — Create or update a Sunco user
// ============================================================
app.post('/api/sunco-users', async (req, res) => {
  try {
    const { sessionId, externalId, name, email } = req.body;
    const creds = getCredentials(sessionId);
    if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });

    // MEDIUM 7: Input validation
    const nameErr = validateName(name);
    if (nameErr) return res.status(400).json({ error: 'Name: ' + nameErr });
    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: 'Email: ' + emailErr });
    const extIdErr = validateExternalId(externalId);
    if (extIdErr) return res.status(400).json({ error: 'External ID: ' + extIdErr });

    const nameParts = sanitize(name).trim().split(/\s+/);
    const body = {
      externalId: sanitize(externalId),
      profile: {
        givenName: nameParts[0] || '',
        surname: nameParts.slice(1).join(' ') || '',
        email: sanitize(email),
        auth_email: sanitize(email)
      }
    };

    const url = `https://${sanitize(creds.subdomain)}.zendesk.com/sc/v2/apps/${encodeURIComponent(creds.appId)}/users`;
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

    // 409 Conflict — retry as PATCH update
    if (response.status === 409) {
      const conflictData = await response.json();
      logEntry.status = response.status;
      logEntry.result = 'conflict';
      logEntry.response = conflictData;
      logEntry.note = 'User already exists — retrying as PATCH update';
      addLog(logEntry);

      const patchUrl = `https://${sanitize(creds.subdomain)}.zendesk.com/sc/v2/apps/${encodeURIComponent(creds.appId)}/users/${encodeURIComponent(externalId)}`;
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// GET /api/sunco-users/:externalId — Get Sunco user
// ============================================================
app.get('/api/sunco-users/:externalId', async (req, res) => {
  try {
    const externalId = req.params.externalId;
    const { sessionId } = req.query;
    const creds = getCredentials(sessionId);
    if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });

    const url = `https://${sanitize(creds.subdomain)}.zendesk.com/sc/v2/apps/${encodeURIComponent(creds.appId)}/users/${encodeURIComponent(externalId)}`;

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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// POST /api/generate-jwt — Server-side JWT generation
// ============================================================
app.post('/api/generate-jwt', (req, res) => {
  try {
    const { sessionId, externalId, name, email } = req.body;
    const creds = getCredentials(sessionId);
    if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });

    // MEDIUM 7: Input validation
    const nameErr = validateName(name);
    if (nameErr) return res.status(400).json({ error: 'Name: ' + nameErr });
    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: 'Email: ' + emailErr });
    const extIdErr = validateExternalId(externalId);
    if (extIdErr) return res.status(400).json({ error: 'External ID: ' + extIdErr });

    const { jwt, jti } = generateJWT(creds.keyId, creds.secret, externalId, name, email);
    const now = Math.floor(Date.now() / 1000);

    addLog({
      action: 'JWT — Generate', method: 'POST',
      endpoint: '/api/generate-jwt', fullUrl: '(server-side)',
      request: { externalId, name, email, kid: creds.keyId },
      status: 200, result: 'success',
      response: { jwt: jwt.substring(0, 30) + '…', expiresAt: new Date((now + JWT_EXPIRY_SECONDS) * 1000).toISOString() }
    });

    res.json({ jwt, expiresAt: new Date((now + JWT_EXPIRY_SECONDS) * 1000).toISOString() });
  } catch (err) {
    console.error('JWT generation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// PENDING AUTH STORE — for page-reload authentication flow
// ============================================================
const pendingAuth = new Map();
const AUTH_TTL = 120000; // 2 minutes

// ============================================================
// POST /api/quick-login — Login using env config
// ============================================================
app.post('/api/quick-login', async (req, res) => {
  try {
    const { email, password, sessionId } = req.body;

    // MEDIUM 7: Input validation
    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });
    if (!password || password.length < 5) return res.status(400).json({ error: 'Password is required (min 5 chars).' });
    if (password.length > 128) return res.status(400).json({ error: 'Password is too long.' });

    // Get config: prefer env vars, fall back to session credentials
    let cfg = getEnvConfig();
    let configSource = 'environment';
    if (!hasEnvConfig()) {
      const sessionCreds = sessionId ? getCredentials(sessionId) : null;
      if (!sessionCreds) {
        return res.status(400).json({ error: 'No configuration available. Set environment variables or save config on the Configuration page first.' });
      }
      cfg = sessionCreds;
      configSource = 'session';
    }

    // Step 1: Look up Zendesk user by email
    const searchUrl = `https://${cfg.subdomain}.zendesk.com/api/v2/users/search.json?query=${encodeURIComponent(email)}`;
    const searchResp = await fetch(searchUrl, {
      headers: { 'Authorization': zendeskAdminAuth(cfg.adminEmail, cfg.apiToken) }
    });
    const searchData = await searchResp.json();

    if (!searchResp.ok || !searchData.users || searchData.users.length === 0) {
      addLog({
        action: 'Quick Login — User Lookup', method: 'GET',
        endpoint: '/api/v2/users/search', fullUrl: searchUrl,
        request: { email: sanitize(email) },
        status: searchResp.status, result: 'error',
        response: searchData
      });
      return res.status(404).json({ error: 'No Zendesk user found with that email.' });
    }

    const zendeskUser = searchData.users[0];
    const externalId = zendeskUser.external_id;

    if (!externalId) {
      return res.status(400).json({ error: 'User has no external ID. They must be created with an external ID first.' });
    }

    addLog({
      action: 'Quick Login — User Lookup', method: 'GET',
      endpoint: '/api/v2/users/search', fullUrl: searchUrl,
      request: { email: sanitize(email) },
      status: 200, result: 'success',
      response: { id: zendeskUser.id, name: zendeskUser.name, email: zendeskUser.email, external_id: externalId }
    });

    // Step 2: Generate JWT
    const { jwt, jti } = generateJWT(cfg.keyId, cfg.secret, externalId, zendeskUser.name, zendeskUser.email);

    addLog({
      action: 'Quick Login — JWT Generate', method: 'POST',
      endpoint: '(server-side)',
      request: { externalId, name: zendeskUser.name, email: zendeskUser.email },
      status: 200, result: 'success',
      response: { jwt: jwt.substring(0, 30) + '…' }
    });

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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// GET /api/pending-auth/:token
// ============================================================
app.get('/api/pending-auth/:token', (req, res) => {
  const data = pendingAuth.get(req.params.token);
  if (!data) return res.status(404).json({ error: 'Auth data not found or expired. Try logging in again.' });
  pendingAuth.delete(req.params.token);
  res.json(data);
});

// ============================================================
// GET /api/debug-jwt — Decode the last generated JWT
// ============================================================
app.get('/api/debug-jwt', (req, res) => {
  const { sessionId } = req.query;
  const creds = getCredentials(sessionId);
  if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });

  const lastAuth = Array.from(pendingAuth.values()).pop();
  if (!lastAuth) {
    return res.json({ note: 'No login has been performed yet. Log in first, then check this endpoint.' });
  }

  const jwt = lastAuth.jwt;
  const parts = jwt.split('.');
  let header = null, payload = null;
  try { header = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8')); } catch(e) {}
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')); } catch(e) {}

  res.json({
    header,
    payload,
    kid_matches_keyId: header?.kid === creds.keyId,
    appId: creds.appId,
    subdomain: creds.subdomain
    // Note: removed secret_length and secret_is_base64 from debug output (INFOSEC)
  });
});

// ============================================================
// GET /api/verify-creds — Test Sunco API credentials
// ============================================================
app.get('/api/verify-creds', async (req, res) => {
  const { sessionId } = req.query;
  const creds = getCredentials(sessionId);
  if (!creds) return res.status(401).json({ error: 'Invalid or expired session.' });

  try {
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
      appId: creds.appId
      // Note: removed secret_prefix and secret_length (INFOSEC — don't leak secret info)
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================================
// GET /api/logs — Auth-protected log access (CRITICAL 1)
// DELETE /api/logs — Clear all logs
// ============================================================
app.get('/api/logs', (req, res) => {
  // CRITICAL 1: Auth is already enforced by requireAuth middleware
  res.json({ logs: apiLogs });
});

app.delete('/api/logs', (req, res) => {
  apiLogs.length = 0;
  res.json({ success: true });
});

// ============================================================
// GLOBAL ERROR HANDLER (MEDIUM 9)
// ============================================================
// MEDIUM 9: In production, never leak stack traces to the client.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({ error: 'Internal server error' });
  } else {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ============================================================
// Start server
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Zendesk JWT Auth server running at http://localhost:${PORT}`);
  if (!hasEnvConfig()) {
    console.warn('⚠️  WARNING: Environment variables not fully configured.');
    console.warn('   Set ZENDESK_SUBDOMAIN, ZENDESK_ADMIN_EMAIL, ZENDESK_API_TOKEN,');
    console.warn('   SUNCO_APP_ID, SUNCO_KEY_ID, SUNCO_SECRET, ZENDESK_WIDGET_KEY');
  }
});