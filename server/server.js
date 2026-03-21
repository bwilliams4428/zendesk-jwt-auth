const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Static files
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

// Redirect root to index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

/**
 * JWT Token generation endpoint for Zendesk Messaging
 * Includes kid (Key ID) in header as required by Zendesk
 */
app.post('/api/auth/token', (req, res) => {
  const { userId, email, name } = req.body;

  if (!userId || !email || !name) {
    return res.status(400).json({
      status: 'error',
      message: 'userId, email, and name are required'
    });
  }

  const jwtSecret = process.env.ZENDESK_JWT_SECRET;
  if (!jwtSecret) {
    return res.status(500).json({
      status: 'error',
      message: 'ZENDESK_JWT_SECRET not configured'
    });
  }

  const now = Math.floor(Date.now() / 1000);
  
  // Build JWT payload
  const payload = {
    jti: crypto.randomBytes(16).toString('base64url'),
    iat: now,
    exp: now + (24 * 60 * 60),
    name: name,
    external_id: userId,
    email_verified: true,
    email: email,
    scope: 'user',
    id: userId
  };

  try {
    // Include kid in header - this is the Key ID from Zendesk, NOT the JWT secret
    // The kid should be obtained from your Zendesk Admin panel
    const kid = process.env.ZENDESK_KID || 'app_67097c94d8a020e6a236ae87'; // Default from your Python script
    const token = jwt.sign(payload, jwtSecret, { 
      algorithm: 'HS256',
      header: {
        alg: 'HS256',
        typ: 'JWT',
        kid: kid
      }
    });

    res.json({
      status: 'success',
      token: token,
      expires_at: payload.exp,
      issued_at: payload.iat
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Failed to generate token: ' + error.message
    });
  }
});

/**
 * Verify JWT token endpoint
 */
app.post('/api/auth/verify', (req, res) => {
  const { token } = req.body;
  const jwtSecret = process.env.ZENDESK_JWT_SECRET;

  if (!token) {
    return res.status(400).json({ status: 'error', message: 'Token required' });
  }

  try {
    const decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    res.json({
      status: 'success',
      decoded: decoded,
      valid: true
    });
  } catch (error) {
    res.status(400).json({
      status: 'error',
      message: error.message,
      valid: false
    });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
