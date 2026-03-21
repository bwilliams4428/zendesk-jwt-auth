# Render Deployment Checklist

## Method 1: Blueprint Deploy (Recommended - 1 Click) ⭐

1. [**Click Deploy to Render Button**](https://render.com/deploy?repo=https://github.com/YOUR_USERNAME/zendesk-jwt-auth)
   - Update `YOUR_USERNAME` in README.md first!
   
2. **Sign up or log in** to Render

3. **Configure the Secret** (Required!):
   - Go to your new service → Environment
   - Add `ZENDESK_JWT_SECRET` with your actual Zendesk secret
   - Click "Save Changes"
   - Click "Manual Deploy" → "Deploy Latest Commit"

✅ Done!

---

## Method 2: Manual Git Deploy

1. **Create Git Repository**:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/zendesk-jwt-auth.git
   git push -u origin main
   ```

2. **Create Render Web Service**:
   - Go to [render.com](https://render.com)
   - Click "New +" → "Web Service"
   - Connect your GitHub account
   - Select `zendesk-jwt-auth` repo

3. **Configure Settings**:
   - **Name**: `zendesk-jwt-auth`
   - **Environment**: `Node`
   - **Build Command**: `cd server && npm install`
   - **Start Command**: `node server/server.js`
   
4. **Add Environment Variables**:
   ```
   ZENDESJ_JWT_SECRET=your_secret_here
   NODE_ENV=production
   ZENDESK_WIDGET_KEY=8b5a738b-fb7a-42c5-95a6-1cb26e82900a
   ZENDESK_ACCOUNT=z3nbwilliams.zendesk.com
   ```

5. **Deploy!**

---

## Quick Verification Steps

1. **Visit Your URL** (e.g., `https://zendesk-jwt-auth-api.onrender.com`)
2. **Login** with demo credentials:
   - Email: `user@example.com`
   - Password: `password123`
3. **Check Console** for "Zendesk widget authenticated with JWT"
4. **Test Widget** - Click the chat icon in bottom-right corner
5. **Verify JWT Token** - Look for authenticated status badge

---

## Environment Variables Reference

| Variable | Source | Example |
|----------|--------|---------|
| `ZENDESK_JWT_SECRET` | Zendesk Admin Center | `sk_abc123...` |
| `ZENDESK_WIDGET_KEY` | Zendesk Admin Center | `8b5a738b-fb7a-42c5-95a6-1cb26e82900a` |
| `ZENDESK_ACCOUNT` | Your Zendesk URL | `z3nbwilliams.zendesk.com` |
| `NODE_ENV` | Set manually | `production` |

### Getting Your JWT Secret from Zendesk

1. Go to [Zendesk Admin Center](https://z3nbwilliams.zendesk.com/admin)
2. Click **Channels** in left sidebar
3. Click **Messaging**
4. Select your messaging channel
5. Go to **Settings** tab
6. Scroll to **JWT Authentication**
7. Enable JWT
8. Copy the **Shared Secret**
9. Paste into Render environment variables

---

## Troubleshooting

### Service Won't Start

- Check logs: Render Dashboard → Service → Logs
- Verify `ZENDESK_JWT_SECRET` is set
- Ensure `NODE_ENV=production`

### Widget Not Authenticating

- Open browser DevTools (F12)
- Check Console for JWT errors
- Verify JWT secret is correct (not placeholder)
- Check CORS headers in Network tab

### CORS Errors

- Already configured! Should work out-of-box
- If issues: Add your domain to `corsOptions` in `server.js`

### Static Files Not Loading

- Check `render.yaml` Build command: `npm install`
- Verify Start command: `npm start`
- Check logs for static path errors

---

## GitHub Integration

After first deploy, pushes to `main` branch automatically redeploy!

```bash
git add .
git commit -m "Your changes"
git push origin main
```

---

✅ **Ready to deploy!**