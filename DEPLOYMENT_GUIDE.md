# PAYPOINT DEPLOYMENT GUIDE - STEP BY STEP

---

## STEP 1: PUSH CODE TO GITHUB ✅

**Copy-paste these commands ONE BY ONE in VS Code terminal:**

```
cd "C:\Users\Emmanuel Nwani\Desktop\paypoint-backend"

git add .

git commit -m "Initial deployment setup with Render backend integration"

git branch -M main

git remote add origin https://github.com/emmanuelnwani2008-design/paypoint-backend.git

git push -u origin main
```

**What to expect:** Green checkmarks, code uploaded to GitHub.

---

## STEP 2: DEPLOY BACKEND TO RENDER ✅

### On Render.com:

1. Go to: https://render.com/dashboard
2. Click **"New +"** → **"Web Service"**
3. Click **"Connect a repository"** → Find `paypoint-backend`
4. Fill in:
   - **Name**: `paypoint-backend`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm run start:prod`
   - **Plan**: Free
5. Click **"Advanced"** and add these Environment Variables:

```
SUPABASE_URL = https://mqggkwhdbwkaftmewdca.supabase.co
SUPABASE_ANON_KEY = sb_publishable_ulAg_qpF5L8LbHc6ZzYnxQ_z4w3ExhV
PAYSTACK_SECRET_KEY = sk_test_272bd56a30ebfb3a214e39c6d7030bb4dc256571
FRONTEND_URL = YOUR_NETLIFY_URL (fill after Netlify setup)
ALLOWED_ORIGINS = YOUR_NETLIFY_URL,https://paypoint-backend-9m63.onrender.com
JWT_SECRET = your_super_secret_jwt_key_12345_change_this_later
NODE_ENV = production
PORT = 3000
```

6. Click **"Create Web Service"**
7. Wait 5-10 minutes for deployment. When done, you'll see: **"Live"** in green.

**Your Render URL**: `https://paypoint-backend-9m63.onrender.com`

---

## STEP 3: DEPLOY FRONTEND TO NETLIFY ✅

### On Netlify.com:

1. Go to: https://app.netlify.com
2. Click **"Add new site"** → **"Import an existing project"**
3. Select **GitHub** → Authorize → Choose `paypoint-backend` repo
4. Fill in:
   - **Build command**: (leave empty)
   - **Publish directory**: `.`
5. Click **"Deploy"**
6. Wait 1-2 minutes for deployment.

**Your Netlify URL**: Will look like `https://paypoint-backend-12345.netlify.app`

### After Netlify deploys:
1. Copy your Netlify URL
2. Go back to Render Dashboard
3. Go to your `paypoint-backend` service → **Settings**
4. Update `FRONTEND_URL` and `ALLOWED_ORIGINS` with your Netlify URL
5. Click **"Save"**

---

## STEP 4: UPDATE ENVIRONMENT VARIABLES ✅

### What's already fixed in your code:
✅ `config.js` - Automatically uses Render URL in production
✅ All HTML files - Using `window.__API_URL__`
✅ `netlify.toml` - Updated with Render backend URL

### NO additional code changes needed! ✅

---

## STEP 5: CONFIGURE PAYSTACK WEBHOOK ✅

### On Paystack Dashboard:

1. Go to: https://dashboard.paystack.co/settings/developers
2. Click **"API Keys & Webhooks"**
3. Find **"Webhook URL"** section
4. Paste this URL:
   ```
   https://paypoint-backend-9m63.onrender.com/api/payments/webhook
   ```
5. Select **"Events"**: Check these boxes:
   - ✅ charge.success
   - ✅ charge.failed
6. Click **"Save"**

---

## STEP 6: TESTING CHECKLIST ✅

### Test 1: Frontend Loads
- [ ] Open your Netlify URL
- [ ] Login page appears (no errors in browser console)

### Test 2: Login Works
- [ ] Click **"Sign Up"**
- [ ] Create test account with email/password
- [ ] Click **"Verify Email"** (check spam folder for Supabase email)
- [ ] Login with credentials
- [ ] You see dashboard

### Test 3: API Calls Work
- [ ] Dashboard shows data loading
- [ ] Click on **"Deals"** page
- [ ] Try clicking **"Add Deal"**
- [ ] Try filling form and clicking **"Save"**
- [ ] Check browser console (F12) - no red errors

### Test 4: Paystack Payment
- [ ] On Deals page, find a deal
- [ ] Click **"Pay Now"**
- [ ] Paystack popup appears
- [ ] Fill test card: `4111 1111 1111 1111`
- [ ] Expiry: Any future date
- [ ] CVV: Any 3 digits
- [ ] Click **"Pay"**
- [ ] Should redirect to success page

### Test 5: Check Logs
- [ ] Render Dashboard → Your service → **"Logs"**
- [ ] Look for `200` status codes (green = good)
- [ ] No red `500` or `404` errors

### If you see errors:
- [ ] Check `.env` variables on Render match exactly
- [ ] Check Netlify's CORS headers
- [ ] Restart both Render and Netlify services

---

## FINAL CHECKLIST

- [ ] Code pushed to GitHub
- [ ] Backend deployed on Render (shows "Live")
- [ ] Frontend deployed on Netlify
- [ ] All environment variables set on both platforms
- [ ] Paystack webhook configured
- [ ] Login test successful
- [ ] Payment test successful
- [ ] Logs show no errors

**If everything is green: YOU'RE LIVE! 🎉**

---

## TROUBLESHOOTING QUICK FIXES

| Problem | Solution |
|---------|----------|
| "Cannot GET /api/..." | Check ALLOWED_ORIGINS on Render |
| Login not working | Check SUPABASE keys on Render |
| Payment fails | Check PAYSTACK_SECRET_KEY on Render |
| "CORS error" | Restart Render service, wait 2 mins |
| Netlify says "Not Found" | Make sure `netlify.toml` is in root folder |

---

## SUPPORT LINKS
- Render Docs: https://render.com/docs
- Netlify Docs: https://docs.netlify.com
- Paystack Webhooks: https://paystack.com/docs/payments/webhooks/
