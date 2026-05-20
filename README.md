# ♻️ BinBuddy – Smart Waste Tracking & Rewards Platform

> **Technopreneurship Final Project**  
> Team: **Powerpuff w/ Mojo Jojo** | AY 2025–2026

---

## 📌 Project Overview

**BinBuddy** is a mobile-first web application designed to help households in **Quezon City, Philippines** properly segregate their waste and earn rewards for doing so. The platform connects three key stakeholders: households, waste collectors, and barangay administrators — aligned with **Republic Act No. 9003** and **UN SDG 12 (Responsible Consumption and Production)**.

---

## 👥 Team Members

| Name | Role |
|------|------|
| *(Member 1)* | Frontend Developer / UI Designer |
| *(Member 2)* | Backend Developer / Database Architect |
| *(Member 3)* | Business Model / Pitching |
| *(Member 4)* | Documentation / Research |
| *(Member 5)* | QA / Testing / Presentation |

---

## 🎯 System Description

BinBuddy is a **Smart Waste Tracking & Rewards Platform** that:

- Allows households to **log waste disposal** (biodegradable, recyclable, residual, special) via QR scan or manual entry
- Awards **EcoPoints** for proper segregation, verified by waste collectors
- Enables users to **redeem EcoPoints** for mobile load, vouchers, and discounts
- Provides **waste collectors** with digital pickup lists and verification tools
- Gives **barangay administrators** real-time dashboards with compliance metrics
- Includes a **Smart Segregation Guide** with a "Is this recyclable?" checker
- Features **gamification**: streaks, badges, challenges, and a community leaderboard

### Why BinBuddy?

- Metro Manila generates **9,500 tons of waste per day**
- Only **30% is properly recycled**
- **12 million households** in Metro Manila, concentrated in Quezon City
- RA 9003 mandates waste segregation at source — BinBuddy makes this rewarding and trackable

---

## 📁 Project Folder Structure

```
/binbuddy
├── index.html              ← Main SPA (Single Page Application)
├── xml-viewer.html         ← XML/XSLT data report viewer
├── /css
│   └── style.css           ← Complete stylesheet (responsive, mobile-first)
├── /js
│   └── app.js              ← All JavaScript logic (screens, state, rendering)
├── /xml
│   └── binbuddy-data.xml   ← XML data structure (users, logs, rewards, barangays)
├── /xsl
│   └── binbuddy-transform.xsl ← XSLT stylesheet for XML → HTML transformation
├── /sql
│   └── binbuddy-schema.sql ← Full DB schema + CRUD queries + sample data
└── README.md               ← This file
```

---

## ⚙️ Technologies Used

| Technology | Usage |
|------------|-------|
| **HTML5** | Multi-screen SPA structure, semantic tags, forms |
| **CSS3** | External stylesheet, responsive design, animations, CSS variables |
| **JavaScript (Vanilla)** | App state management, DOM rendering, navigation, events |
| **XML** | Waste data structure, user data, rewards catalog |
| **XSL/XSLT** | Transforms XML into readable HTML report (via browser XSLTProcessor API) |
| **SQL** | MySQL schema with 7 tables, SELECT/INSERT/UPDATE/DELETE queries |

---

## ✅ Features Implemented (30%+ Completed)

### 🔐 Authentication
- [x] Splash screen with animated logo and loader
- [x] Login/Register with tabs
- [x] Role selection: Household / Collector / Admin
- [x] "Continue as Guest" option
- [x] Role-based routing to appropriate dashboard

### 🏠 Household Dashboard
- [x] Welcome banner with EcoPoints balance and streak counter
- [x] Stats grid (waste by type, total logs, points)
- [x] Eco Tip of the Day (randomized)
- [x] Sponsor banner (local business ad)
- [x] National stats (12M households, 9,500T waste, 30% recycled)
- [x] Quick access navigation tiles
- [x] Recent activity log

### 📦 Waste Tracking
- [x] Manual logging with waste type selection
- [x] Quantity selector (±0.1 kg increments)
- [x] QR scanner simulation (mock camera)
- [x] Photo upload mock
- [x] Full disposal history list
- [x] Auto-EcoPoints award on log submission

### 📚 Smart Segregation Guide
- [x] Searchable category list (Biodegradable, Recyclable, Residual, Special)
- [x] "Is this recyclable?" checker
- [x] Category detail modal

### ⭐ EcoPoints & Rewards
- [x] Live EcoPoints balance display
- [x] Challenges with progress bars
- [x] Rewards catalog (6 rewards with claim functionality)
- [x] Points deduction on redemption
- [x] Confetti animation on points earned / reward claimed
- [x] Barangay leaderboard

### 🚛 Waste Collector
- [x] Daily pickup list with status indicators
- [x] Mark as Properly Segregated ✅ or Not Segregated ❌
- [x] QR scan button
- [x] Photo proof upload mock

### 🏢 Barangay Admin Dashboard
- [x] KPI cards (waste collected, segregation %, recycling rate, active users)
- [x] Weekly waste chart (bar visualization)
- [x] EcoPoints distribution tracker
- [x] Top households list
- [x] Admin tools: CSV export, broadcast, user management
- [x] Subscription plan display

### 👤 Profile
- [x] QR code (procedurally generated)
- [x] Badges with earned/unearned states
- [x] Stats (points, streak, logs)
- [x] Profile menu navigation

### 📱 Additional Screens
- [x] Notifications screen
- [x] Education / Articles
- [x] About & Legal (RA 9003, SDG 12, business model)
- [x] XML/XSLT Viewer screen
- [x] Leaderboard screen

### 🎮 Gamification
- [x] Confetti animation on points earned
- [x] Streak counter
- [x] Badges (6 types, earned/unearned)
- [x] Progress bars for challenges
- [x] Success modal with encouraging messages

---

## 🚀 How to Run

1. **Open directly:** Double-click `index.html` in a browser (Chrome, Edge, Firefox)
2. **With local server** (for XSLT support):
   ```bash
   # Python 3
   python -m http.server 8000
   # Then open: http://localhost:8000
   ```
3. Navigate using the bottom navigation bar
4. Use the **❓ Help button** (bottom-right) for a guided demo tour
5. Login with any role to see the role-based dashboard

---

## 🌐 Deploy (Cloud hosting)

### What Aiven does (and doesn’t)
- **Aiven hosts the MySQL database** (shared, cloud, non-local).
- **You still need to host the Node.js app/API** somewhere (Render/Railway/Fly/VPS). This repo already serves both the UI + API from `server/server.js`.

### Recommended: Render
This repo includes `render.yaml` for one-click deploy.

- **Build command**: `npm --prefix server ci --omit=dev`
- **Start command**: `npm --prefix server start`
- **Health check**: `/api/health`

Set these environment variables in your host (use your Aiven connection parameters):
- `DB_HOST` (example: `mysql-3d4b176a-kirbyfos69-59bd.h.aivencloud.com`)
- `DB_PORT` (Aiven MySQL port, commonly `17100`)
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME` (example: `defaultdb`)
- `JWT_SECRET` (set a strong random secret)

SSL:
- Prefer setting `DB_CA_PEM` (paste the Aiven CA certificate PEM). If unset, the server will use `server/ca.pem` when present.

## 🗄️ Database (SQL)

Full schema in `/sql/binbuddy-schema.sql`:
- **7 Tables:** users, waste_logs, rewards_catalog, transactions, barangays, challenges, user_challenges, announcements
- **2 Views:** v_user_ecopoints, v_barangay_summary
- Includes: SELECT, INSERT, UPDATE, DELETE examples
- Seeded with realistic Quezon City data

---

## 📄 XML & XSLT

- `/xml/binbuddy-data.xml` — Structured data for users, logs, rewards, barangays, announcements
- `/xsl/binbuddy-transform.xsl` — XSLT that transforms XML into an HTML table report
- Open `xml-viewer.html` (via local server) to see the live XSLT transformation

---

## 💰 Business Model

| Revenue Stream | Description |
|---------------|-------------|
| **Barangay Subscriptions** | Free / Basic (₱1,500/mo) / Premium (₱5,000/mo) |
| **Sponsorship Banners** | Local businesses advertise to eco-conscious households |
| **Recycling Analytics** | Commission data for junk shops and recycling partners |

---

## ⚖️ Legal & SDG Alignment

- **RA 9003** – Ecological Solid Waste Management Act of 2000
- **SDG 12** – Responsible Consumption and Production
- **DENR** – Compliant with waste classification guidelines
- **Quezon City** – 142 barangays, 3.1M population

---

## 📊 Key Philippine Statistics Referenced

| Metric | Value |
|--------|-------|
| Households in Metro Manila | 12 million |
| Daily waste generated | 9,500 tons |
| Current recycling rate | 30% |
| QC 2030 recycling target | 80% |
| Barangays in Quezon City | 142 |

---

## 🔧 Full-stack backend (API + SQLite)

The repository includes a Node.js REST API with JWT authentication, role-based routes, and persistent SQLite storage (`server/data/binbuddy.db`). The existing web UI in `index.html` is unchanged; `js/app.js` talks to `/api` when the app is served from the server.

### Run locally

```bash
cd server
cp .env.example .env   # set JWT_SECRET to a long random string in production
npm install
npm start
```

Open **http://localhost:3000** (API routes are under `/api`). Seed accounts after first boot:

| Role | Email | Password |
|------|--------|----------|
| Household | maria@email.com | password123 |
| Collector | collector@email.com | password123 |
| Admin | admin@email.com | password123 |

New registrations create **household** accounts only (collector/admin accounts are seeded or provisioned separately). **Continue as Guest** signs in as the demo household when `ALLOW_GUEST_LOGIN` is not `false`.

Optional: override the API URL from the browser with `window.BINBUDDY_API_BASE = 'https://your-host/api'` before loading `js/app.js`.

---

*BinBuddy v1.0 · © 2026 · Powerpuff w/ Mojo Jojo · Made with 💚 for the Philippines*
