const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ─── In-Memory Config (ephemeral — gone on restart) ──────────
// Env vars are the ONLY persistent source. Anything set via /setup.html
// lives in the browser's sessionStorage and is sent per-request.
// Nothing is written to disk.

function getEnvConfig() {
  return {
    jwtSecret: process.env.ZENDESK_JWT_SECRET || '',
    kid: process.env.ZENDESK_KID || '',
    widgetKey: process.env.ZENDESK_WIDGET_KEY || '',
    account: process.env.ZENDESK_ACCOUNT || '',
  };
}

function isEnvConfigured() {
  const c = getEnvConfig();
  return !!(c.jwtSecret && c.kid && c.widgetKey);
}

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Static files
const publicPath = path.join(__dirname, '..', 'public');
app.use(express.static(publicPath));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// ─── Config Endpoints ───────────────────────────────────────

/**
 * GET /api/config/status — check if env-var config is available
 * The setup page works even without this — credentials come from the browser.
 */
app.get('/api/config/status', (req, res) => {
  const config = getEnvConfig();
  res.json({
    configured: isEnvConfigured(),
    widgetKey: config.widgetKey || null,
    account: config.account || null,
    kid: config.kid ? config.kid.slice(0, 8) + '...' : null,
    hasSecret: !!config.jwtSecret,
    ephemeral: true, // signals the UI that nothing is persisted
  });
});

/**
 * GET /api/config/widget-key — return env-var widget key if set
 */
app.get('/api/config/widget-key', (req, res) => {
  const config = getEnvConfig();
  if (!config.widgetKey) {
    return res.status(404).json({ status: 'error', message: 'Widget key not configured via env vars. Enter it on the setup page.' });
  }
  res.json({ widgetKey: config.widgetKey });
});

// ─── Auth Endpoints ──────────────────────────────────────────

/**
 * POST /api/auth/login — demo login (no real auth)
 */
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      status: 'error',
      message: 'Email and password are required',
    });
  }

  const userId = 'user_' + crypto.createHash('md5').update(email.toLowerCase().trim()).digest('hex').slice(0, 9);
  const name = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  res.json({
    status: 'success',
    user: { id: userId, email: email.trim().toLowerCase(), name },
  });
});

/**
 * POST /api/auth/token — generate JWT
 *
 * Credentials are resolved in priority order:
 *   1. Request body (sent from browser sessionStorage — ephemeral)
 *   2. Environment variables (for production deployments)
 *
 * Nothing is written to disk.
 */
app.post('/api/auth/token', (req, res) => {
  const { userId, email, name, jwtSecret, kid } = req.body;

  if (!userId || !email || !name) {
    return res.status(400).json({
      status: 'error',
      message: 'userId, email, and name are required',
    });
  }

  // Resolve secrets: request body first, then env vars
  const envConfig = getEnvConfig();
  const secret = jwtSecret || envConfig.jwtSecret;
  const keyId = kid || envConfig.kid;

  if (!secret) {
    return res.status(500).json({
      status: 'error',
      message: 'JWT secret not configured. Enter it on the setup page or set ZENDESK_JWT_SECRET env var.',
    });
  }
  if (!keyId) {
    return res.status(500).json({
      status: 'error',
      message: 'Key ID (kid) not configured. Enter it on the setup page or set ZENDESK_KID env var.',
    });
  }

  if (!email.includes('@')) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid email format',
    });
  }

  const now = Math.floor(Date.now() / 1000);

  const payload = {
    jti: crypto.randomBytes(16).toString('base64url'),
    iat: now,
    exp: now + (24 * 60 * 60),
    name: name,
    external_id: userId,
    email_verified: true,
    email: email.trim().toLowerCase(),
    scope: 'user',
    id: userId,
  };

  try {
    const token = jwt.sign(payload, secret, {
      algorithm: 'HS256',
      header: {
        alg: 'HS256',
        typ: 'JWT',
        kid: keyId,
      },
    });

    res.json({
      status: 'success',
      token,
      expires_at: payload.exp,
      issued_at: payload.iat,
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate token: ' + error.message,
    });
  }
});

/**
 * POST /api/auth/verify — verify a JWT token
 */
app.post('/api/auth/verify', (req, res) => {
  const { token, jwtSecret } = req.body;

  // Resolve secret: request body first, then env
  const secret = jwtSecret || getEnvConfig().jwtSecret;

  if (!token) {
    return res.status(400).json({ status: 'error', message: 'Token required' });
  }
  if (!secret) {
    return res.status(500).json({ status: 'error', message: 'JWT secret not configured' });
  }

  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    res.json({ status: 'success', decoded, valid: true });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message, valid: false });
  }
});

// ─── Locales Endpoint ────────────────────────────────────────

/**
 * GET /api/locales — proxy Zendesk public locales API
 * Returns all locales supported by the Zendesk messaging widget.
 */
app.get('/api/locales', async (req, res) => {
  try {
    const https = require('https');
    const url = 'https://support.zendesk.com/api/v2/locales/public.json';

    https.get(url, (apiRes) => {
      let data = '';
      apiRes.on('data', (chunk) => { data += chunk; });
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          res.json(parsed);
        } catch (e) {
          res.status(500).json({ status: 'error', message: 'Failed to parse locales response' });
        }
      });
    }).on('error', (err) => {
      res.status(502).json({ status: 'error', message: 'Failed to fetch locales: ' + err.message });
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ─── Page Routes ──────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  const config = getEnvConfig();
  console.log(`Server running on port ${PORT}`);
  console.log(`Env config: ${isEnvConfigured() ? 'Available' : 'Not set — use /setup.html'}`);
  console.log(`⚠️  No credentials are stored on the server. They live in browser sessionStorage only.`);
});