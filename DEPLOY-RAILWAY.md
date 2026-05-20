# Deploy BinBuddy from VS Code (Railway)

Git push only updates GitHub. If Railway shows **QUEUED** and never starts Build, deploy **from your PC** with the Railway CLI instead.

## One-time setup (VS Code terminal)

1. Open terminal: **Terminal → New Terminal** (`` Ctrl+` ``).
2. Login (opens browser):

   ```bash
   npm run railway:login
   ```

3. Link this folder to your Railway **binbuddy** service:

   ```bash
   npm run railway:link
   ```

   Pick your project → environment (e.g. production) → the **web service** that runs BinBuddy.

## Deploy every time (from VS Code)

**Option A — Task (easiest)**

1. **Terminal → Run Task…**
2. Run **`3. Railway — Deploy from VS Code (railway up)`**

**Option B — Terminal command**

```bash
npm run deploy:railway
```

This uploads your local code and starts a deploy on Railway (does not wait on the GitHub queue).

## Environment variables

In [Railway Dashboard](https://railway.app) → your service → **Variables**, set:

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `JWT_SECRET`
- `NODE_ENV` = `production`

Railway sets `PORT` automatically.

## Verify

Open `https://<your-app>.up.railway.app/api/health` — should return JSON with `"ok": true`.

## If GitHub deploys stay QUEUED

1. Cancel the queued deployment in Railway.
2. Use **Deploy from VS Code** above.
3. In service **Settings → Source**, confirm repo root is empty (not `server` only).
4. Optional: **Settings → Deploy** → turn off overlapping deploys or clear build cache.

## CI token (optional, no browser)

1. Railway → Project → **Settings** → **Tokens** → create project token.
2. In VS Code terminal:

   ```powershell
   $env:RAILWAY_TOKEN="your-token-here"
   npm run deploy:railway
   ```
