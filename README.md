# Zendesk JWT Authentication Web App

A web application for JWT authentication with Zendesk Messaging.

## Features

- ✅ Generate JWT tokens for Zendesk authentication
- ✅ Create new authenticated users via form
- ✅ Web SDK integration with `zE("messenger", "loginUser")`
- ✅ Real-time user authentication

## Deployment to Render

### Option 1: Using render.yaml (Blueprint)

1. **Push this repository to GitHub**

2. **Create a new Web Service on Render:**
   - Go to https://dashboard.render.com/
   - Click "New +" → "Web Service"
   - Connect your GitHub repository
   - Render will automatically detect the `render.yaml` file

3. **Set Environment Variables in Render Dashboard:**
   - Go to your service → "Environment" tab
   - Add these variables:
   
   | Variable | Value |
   |----------|-------|
   | `ZENDESK_JWT_SECRET` | `VBWPokvnM7N7L_Xw3jNjnjWcRZwvds7uxphglHEl_TKdsNG9xePuBdoX-oK883xNRnOLITQpQw853KCKS1ADhg` |
   | `ZENDESK_KID` | `app_67097c94d8a020e6a236ae87` |
   | `ZENDESK_WIDGET_KEY` | `8b5a738b-fb7a-42c5-95a6-1cb26e82900a` |
   | `ZENDESK_ACCOUNT` | `z3nbwilliams.zendesk.com` |

4. **Deploy!** Render will automatically build and deploy your app.

### Option 2: Manual Configuration

1. **Create a new Web Service:**
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`

2. **Set the environment variables as shown above**

3. **Deploy**

## Local Development

```bash
npm install
npm start
# Open http://localhost:3000
```

## Usage

1. Open the deployed URL
2. Fill in the "Create New Authenticated User" form
3. Click "Create User & Authenticate"
4. Click "Open Messenger" to start chatting

## Environment Variables

- `ZENDESK_JWT_SECRET` - Your JWT signing secret from Zendesk Admin
- `ZENDESK_KID` - Your Key ID from Zendesk Admin
- `ZENDESK_WIDGET_KEY` - Your widget/snippet key
- `ZENDESK_ACCOUNT` - Your Zendesk subdomain

## License

MIT