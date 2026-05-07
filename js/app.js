/* ====================================================
   BINBUDDY - APP ENGINE (Workflow-Driven Backend Logic)
   ==================================================== */

const STORAGE_KEY = "binbuddy-state-v2";
const SESSION_KEY = "binbuddy-session-v1";
const API_BASE_STORAGE_KEY = "binbuddy-api-base";
/**
 * Resolve the API base URL robustly so the browser always reaches the Node API (which writes to Aiven).
 *
 * Priority:
 * 1) explicit override via `window.BINBUDDY_API_BASE`
 * 2) persisted override via localStorage `binbuddy-api-base`
 * 3) <meta name="binbuddy-api-base" content="...">
 * 4) same-origin `/api`
 * 5) `api.` subdomain (e.g. https://api.example.com/api)
 */
let resolvedApiBase = null;
let resolvingApiBasePromise = null;
/** Did at least one /health probe succeed with JSON `{ ok/success }`? (false = static host or API down.) */
let apiProbesHadHealthyHit = false;

function isFileProtocol() {
  try {
    return typeof location !== "undefined" && String(location.protocol || "").toLowerCase() === "file:";
  } catch (_e) {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/** Tutorial / typo URLs saved in meta or localStorage break discovery — strip them like empty. */
function isPlaceholderApiBase(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return false;
  if (s.includes("your-api-host")) return true;
  if (s.includes("example.com")) return true;
  if (/\bchangeme\b/.test(s) || /\bplaceholder\b/.test(s)) return true;
  return false;
}

function normalizeApiBase(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed || isPlaceholderApiBase(trimmed)) return "";
  const s = trimmed.replace(/\/+$/, "");
  if (!s) return "";
  return s.endsWith("/api") ? s : `${s}/api`;
}

/** True for URLs pointing at loopback hosts (stored meta/localStorage commonly ship these). */
function isLoopbackApiUrl(candidate) {
  return /(^|\/)localhost\b|(^|\/)127\.0\.0\.1\b|^https?:\/\/localhost\b|^https?:\/\/127\.0\.0\.1\b/i.test(
    String(candidate || "")
  );
}

/**
 * On production hosts, never prioritize localhost-ish bases (dev leftovers in localStorage).
 */
function finalizeApiCandidateOrder(candidates) {
  const host = String(window.location?.hostname || "").trim();
  const isLocalPage = host === "localhost" || host === "127.0.0.1";
  if (isLocalPage) return candidates;
  const front = [];
  const tail = [];
  for (const c of candidates) {
    if (isLoopbackApiUrl(c)) tail.push(c);
    else front.push(c);
  }
  return front.length ? [...front, ...tail] : [...candidates];
}

/** When health checks all fail / time out — prefer same-origin /api over a random dev URL. */
function pickApiBaseFallback(candidates) {
  const cs = candidates && candidates.length ? candidates : ["/api"];
  const host = String(window.location?.hostname || "").trim();
  const isLocalPage = host === "localhost" || host === "127.0.0.1";
  const origin = String(window.location?.origin || "").trim();
  const originApi = origin && /^https?:/i.test(origin) ? `${origin}/api` : "";
  if (!isLocalPage) {
    if (originApi && cs.includes(originApi)) return originApi;
    const hit = cs.find(c => /^https?:/i.test(c) && !isLoopbackApiUrl(c));
    if (hit) return hit;
    if (originApi) return originApi;
    const sameRel = cs.find(c => String(c).startsWith("/"));
    if (sameRel) return sameRel;
  }
  return cs[0] || "/api";
}

function candidateApiBases() {
  const list = [];
  try {
    const w = typeof window !== "undefined" ? window : null;
    if (!w) return finalizeApiCandidateOrder(["/api"]);
    const explicit = normalizeApiBase(w.BINBUDDY_API_BASE);
    if (explicit) list.push(explicit);
    const host = String(w.location?.hostname || "").trim();
    const isLocalHost = host === "localhost" || host === "127.0.0.1";
    const stored = normalizeApiBase(w.localStorage?.getItem(API_BASE_STORAGE_KEY));
    if (stored) {
      if (!isLocalHost && isLoopbackApiUrl(stored)) {
        /* Saved from local dev — wrong for Netlify/GitHub Pages; skip */
      } else {
        list.push(stored);
      }
    }

    const meta = w.document?.querySelector?.('meta[name="binbuddy-api-base"]')?.getAttribute?.("content");
    const metaNorm = normalizeApiBase(meta);
    const proto = String(w.location?.protocol || "https:").trim();
    const origin = String(w.location?.origin || "").trim();
    const originApi = origin && /^https?:/i.test(origin) ? `${origin}/api` : "";

    /**
     * Local dev: probe meta/dev API early. Hosted: prefer same-origin /api first; loopback URLs go last via finalize().
     */
    if (isLocalHost) {
      if (metaNorm) list.push(metaNorm);
      if (originApi) list.push(originApi);
    } else {
      if (originApi) list.push(originApi);
      if (metaNorm && !isLoopbackApiUrl(metaNorm)) list.push(metaNorm);
      else if (metaNorm) list.push(metaNorm);
    }

    if (host && !host.startsWith("api.")) {
      list.push(`${proto}//api.${host}/api`);
    }
  } catch (_e) {
    // ignore
  }
  list.push("/api");

  const seen = new Set();
  const deduped = list.filter(x => (x && !seen.has(x) ? (seen.add(x), true) : false));
  return finalizeApiCandidateOrder(deduped);
}

/** Health check for one API base. Keep timeout short — many candidates may be tried in parallel. */
async function probeApiBase(base, timeoutMs = 1600) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/health`, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return false;
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return false;
    }
    return Boolean(data && typeof data === "object" && (data.ok === true || data.success === true));
  } catch (_e) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function getApiBase() {
  if (isFileProtocol()) {
    resolvedApiBase = "/api";
    apiProbesHadHealthyHit = false;
    return resolvedApiBase;
  }
  if (resolvedApiBase) return resolvedApiBase;
  if (resolvingApiBasePromise) return resolvingApiBasePromise;
  resolvingApiBasePromise = (async () => {
    const candidates = candidateApiBases();
    if (!candidates.length) {
      resolvedApiBase = "/api";
      apiProbesHadHealthyHit = false;
      return resolvedApiBase;
    }
    /**
     * Parallel probes with a strict wall clock — static hosts fail fast so startup + login are not delayed.
     */
    const API_BASE_PROBE_BUDGET_MS = 2800;
    const perProbeMs = 1600;
    const probeBatch = Promise.all(candidates.map(c => probeApiBase(c, perProbeMs).then(ok => ({ c, ok })))).then(
      rows => ({ kind: "rows", rows })
    );
    const raced = await Promise.race([
      probeBatch,
      sleep(API_BASE_PROBE_BUDGET_MS).then(() => ({ kind: "timeout" }))
    ]);
    if (raced.kind === "timeout") {
      apiProbesHadHealthyHit = false;
      resolvedApiBase = pickApiBaseFallback(candidates);
      return resolvedApiBase;
    }
    const hit = raced.rows.find(r => r.ok);
    apiProbesHadHealthyHit = Boolean(hit);
    resolvedApiBase = hit ? hit.c : pickApiBaseFallback(candidates);
    return resolvedApiBase;
  })();
  return resolvingApiBasePromise;
}

function setApiBaseOverride(baseUrl) {
  try {
    const b = normalizeApiBase(baseUrl);
    if (!b) {
      localStorage.removeItem(API_BASE_STORAGE_KEY);
      resolvedApiBase = null;
      resolvingApiBasePromise = null;
      apiProbesHadHealthyHit = false;
      return true;
    }
    localStorage.setItem(API_BASE_STORAGE_KEY, b);
    resolvedApiBase = b;
    resolvingApiBasePromise = null;
    apiProbesHadHealthyHit = false;
    return true;
  } catch (_e) {
    return false;
  }
}

// Expose for ops/support: run `setApiBaseOverride("https://your-api-host")` in the console.
if (typeof window !== "undefined") window.setApiBaseOverride = setApiBaseOverride;

const TOKEN_KEY = "binbuddy-jwt";

/** Align with server `passwordPolicy`: 8–128 chars, letters + numbers. */
const AUTH_PASSWORD_REGEX = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/;
const AUTH_PHONE_REGEX = /^(\+63\d{10}|\d{10,11})$/;

function validateRegisterPasswordClient(pw) {
  if (!AUTH_PASSWORD_REGEX.test(pw)) {
    return "Password must be 8–128 characters and include at least one letter and one number.";
  }
  return "";
}

function validateLoginPasswordPresence(pw) {
  if (!pw || typeof pw !== "string") return "Password is required.";
  if (pw.length > 128) return "Password is too long.";
  return "";
}

function validateRegisterPhoneClient(phoneNumber) {
  const phone = String(phoneNumber || "").trim();
  if (!phone) return "Phone number is required.";
  if (!AUTH_PHONE_REGEX.test(phone)) {
    return "Phone number must be numeric and can use +63 format.";
  }
  return "";
}

function validateRegisterAddressClient(address) {
  if (!address || !String(address).trim()) return "Address is required.";
  return "";
}

function validateRegisterGenderClient(gender) {
  const g = String(gender || "").trim().toLowerCase();
  if (g !== "male" && g !== "female") return "Please select your gender (Male or Female).";
  return "";
}

function profileAvatarEmoji(user) {
  if (!user) return "👤";
  const g = String(user.gender || "").trim().toLowerCase();
  if (g === "male") return "👨";
  if (g === "female") return "👩";
  return "👤";
}

const NO_ADDRESS_LABEL = "No address provided";

function extractBarangaySegment(address) {
  const s = String(address || "").trim();
  if (!s) return "";
  const m = s.match(/(?:Brgy\.?|Barangay)\s*([^,]+)/i);
  if (m) return m[1].trim().slice(0, 120);
  const first = s.split(",")[0].trim();
  return first.replace(/^(?:Brgy\.?|Barangay)\s*/i, "").trim().slice(0, 120) || first.slice(0, 120);
}

function formatBarangayLabel(part) {
  const x = String(part || "").trim();
  if (!x) return "";
  if (/^(brgy\.?|barangay)\b/i.test(x)) {
    return x.charAt(0).toUpperCase() + x.slice(1);
  }
  return `Brgy. ${x}`;
}

/** Same barangay line for Dashboard, Rewards, and Profile — from stored address / barangay. */
function getUserBarangayLabel(user) {
  if (!user) return NO_ADDRESS_LABEL;
  const fromAddr = extractBarangaySegment(user.address);
  if (fromAddr) return formatBarangayLabel(fromAddr);
  const br = String(user.barangay || "").trim();
  if (br) return formatBarangayLabel(br);
  const raw = String(user.address || "").trim();
  if (raw) return raw;
  return NO_ADDRESS_LABEL;
}

/** Lowercase key so households in the same barangay group together for rankings. */
function userBarangayRankKey(user) {
  if (!user) return "";
  const br = String(user.barangay || "").trim().toLowerCase();
  const cleanedBr = br.replace(/^(?:brgy\.?|barangay)\s*/i, "").trim();
  if (cleanedBr) return cleanedBr;
  const seg = extractBarangaySegment(user.address);
  return String(seg || "")
    .trim()
    .toLowerCase()
    .replace(/^(?:brgy\.?|barangay)\s*/i, "")
    .trim();
}

function isLogStatusCompleted(status) {
  return String(status || "").toLowerCase() === "completed";
}

function completedVerifiedDisposalCount(userId) {
  const sid = userId != null ? String(userId) : "";
  const row = AppState.users.find(u => String(u.id) === sid);
  if (row && Object.prototype.hasOwnProperty.call(row, "completedDisposals")) {
    return Number(row.completedDisposals) || 0;
  }
  return AppState.logs.filter(l => String(l.userId) === sid && isLogStatusCompleted(l.status)).length;
}

function completedVerifiedDisposalKg(userId) {
  const sid = userId != null ? String(userId) : "";
  const row = AppState.users.find(u => String(u.id) === sid);
  if (row && Object.prototype.hasOwnProperty.call(row, "completedKg")) {
    return Number(row.completedKg) || 0;
  }
  return AppState.logs
    .filter(l => String(l.userId) === sid && isLogStatusCompleted(l.status))
    .reduce((sum, l) => sum + (Number(l.weight) || 0), 0);
}

function householdCohortForDisposalRank(user) {
  const households = AppState.users.filter(u => normalizeRole(u.role) === "household");
  const key = userBarangayRankKey(user);
  if (!key) return households;
  return households.filter(u => userBarangayRankKey(u) === key);
}

/**
 * Rank among household accounts in the same barangay (or all households if barangay unknown)
 * by verified disposals: Completed logs, then kg, then EcoPoints as tie-breakers.
 */
function computeHouseholdDisposalRank(user) {
  if (!user || normalizeRole(user.role) !== "household") return null;
  const cohort = householdCohortForDisposalRank(user);
  const rows = cohort.map(u => ({
    id: String(u.id),
    count: completedVerifiedDisposalCount(u.id),
    kg: completedVerifiedDisposalKg(u.id),
    pts: Number(u.ecoPoints) || 0
  }));
  rows.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (b.kg !== a.kg) return b.kg - a.kg;
    return b.pts - a.pts;
  });
  const myId = String(user.id);
  let assignedRank = 1;
  let myRank = null;
  let myCount = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) {
      const cur = rows[i];
      const prev = rows[i - 1];
      if (cur.count !== prev.count || cur.kg !== prev.kg || cur.pts !== prev.pts) assignedRank = i + 1;
    }
    if (String(rows[i].id) === myId) {
      myRank = assignedRank;
      myCount = rows[i].count;
    }
  }
  return { rank: myRank, total: cohort.length, verifiedCount: myCount };
}

const NO_RECENT_ACTIVITY_TEXT = "No recent activity yet.";

/** Normalize identity checks (API/DB often mix numeric vs string IDs). */
function sameUserId(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

/** Waste logs tied to the authenticated user (numeric id or user_code must match). */
function wasteLogsForUser(user) {
  if (!user) return [];
  const uid = String(user.id);
  return AppState.logs.filter(l => String(l.userId) === uid);
}

/** Notifications scoped to the authenticated user (local entries must include userId). */
function notificationsForUser(user) {
  if (!user) return [];
  const uid = String(user.id);
  return AppState.notifications.filter(n => n.userId != null && String(n.userId) === uid);
}

function sanitizeRegisterName(email, derived) {
  const raw = (derived || "").trim() || email.split("@")[0].replace(/[.@]+/g, " ").trim() || "User";
  return raw.slice(0, 100);
}

function summarizeApiValidationMessage(data) {
  const errs = data?.errors;
  if (!Array.isArray(errs) || errs.length === 0) return null;
  const row = errs.find(e => e && typeof e.msg === "string" && e.msg.trim());
  return row ? row.msg : null;
}

function setViewportAuthLock(locked) {
  document.getElementById("app")?.classList.toggle("bb-auth-lock", !!locked);
}

let apiMode = false;
let adminAnalyticsCache = null;

/** Path routes (SPA, requires server to serve index for these paths when using HTTP) */
const ROUTES = { LOGIN: "/login", DASHBOARD: "/dashboard" };
let detachedLoginPhase = null;
let suppressSplashTransitions = false;

function pathRoutingEnabled() {
  try {
    const p = window.location.protocol;
    return p === "http:" || p === "https:";
  } catch (_e) {
    return false;
  }
}

function normalizePath(forPath) {
  try {
    let p =
      forPath != null ? String(forPath).replace(/\/+$/, "") || "/" : String(window.location.pathname || "/").replace(/\/+$/, "") || "/";
    if (p.endsWith("/index.html")) p = "/";
    return p;
  } catch (_e) {
    return "/";
  }
}

function setDashboardPhaseVisible(visible) {
  const dash = document.getElementById("mount-dashboard-phase");
  if (!dash) return;
  dash.hidden = !visible;
  if (visible) {
    dash.removeAttribute("aria-hidden");
    dash.removeAttribute("inert");
  } else {
    dash.setAttribute("aria-hidden", "true");
    dash.setAttribute("inert", "");
  }
}

function dashboardScreensDeactivateAll() {
  document.querySelectorAll("#mount-dashboard-phase .screen").forEach(el => el.classList.remove("active"));
}

function showSplashOnly() {
  setViewportAuthLock(true);
  document.querySelectorAll("#mount-login-phase .screen").forEach(el => el.classList.remove("active"));
  document.getElementById("screen-splash")?.classList.add("active");
}

function showLoginFormOnly() {
  setViewportAuthLock(true);
  document.querySelectorAll("#mount-login-phase .screen").forEach(el => el.classList.remove("active"));
  document.getElementById("screen-auth")?.classList.add("active");
}

function detachLoginPhase() {
  const el = document.getElementById("mount-login-phase");
  if (!el?.parentNode) return;
  detachedLoginPhase = el;
  el.remove();
}

function attachLoginPhase() {
  const app = document.getElementById("app");
  const dash = document.getElementById("mount-dashboard-phase");
  if (!app || !detachedLoginPhase) return;
  if (detachedLoginPhase.parentNode === app) return;
  app.insertBefore(detachedLoginPhase, dash);
}

function exitAuthenticatedMount() {
  setDashboardPhaseVisible(false);
  dashboardScreensDeactivateAll();
  attachLoginPhase();
  showLoginFormOnly();
}

/** In-app stack for Back navigation (does not replace browser history). */
const navStack = [];

function clearNavStack() {
  navStack.length = 0;
}

function enterAuthenticatedMount() {
  clearNavStack();
  detachLoginPhase();
  setDashboardPhaseVisible(true);
  setViewportAuthLock(false);
}

function historySyncAuthenticated(screen, replace = false) {
  const state = { screen, authenticated: true };
  if (!pathRoutingEnabled()) {
    window.history[replace ? "replaceState" : "pushState"](state, "", window.location.href.split("#")[0]);
    return;
  }
  window.history[replace ? "replaceState" : "pushState"](state, "", ROUTES.DASHBOARD);
}

function historySyncLogin() {
  const state = { screen: "auth", authenticated: false };
  if (!pathRoutingEnabled()) {
    window.history.replaceState(state, "", window.location.href.split("#")[0]);
    return;
  }
  window.history.replaceState(state, "", ROUTES.LOGIN);
}

function historySplashOnLoginRoute() {
  if (!pathRoutingEnabled()) return;
  window.history.replaceState({ screen: "splash", authenticated: false }, "", ROUTES.LOGIN);
}

function finalizeAuthenticatedEntry(firstScreen, { replaceHistory = true } = {}) {
  suppressSplashTransitions = true;
  enterAuthenticatedMount();
  const screen = firstScreen || "home";
  goTo(screen, { trackHistory: false, skipAuthenticatedHistory: true, skipNavStack: true });
  historySyncAuthenticated(screen, replaceHistory);
}

function runInitialUrlRouting(_restoredFromToken) {
  const user = AuthService.currentUser();
  const path = normalizePath();

  if (user) {
    suppressSplashTransitions = true;
    let targetScreen =
      history.state && history.state.screen ? history.state.screen : RoleGuard.getHomeScreen(user.role);
    if (!RoleGuard.canAccess(user.role, targetScreen)) {
      targetScreen = RoleGuard.getHomeScreen(user.role);
    }
    finalizeAuthenticatedEntry(targetScreen, { replaceHistory: true });
    return;
  }

  setDashboardPhaseVisible(false);
  dashboardScreensDeactivateAll();
  attachLoginPhase();

  if (!pathRoutingEnabled()) {
    return;
  }

  if (path === ROUTES.DASHBOARD) {
    suppressSplashTransitions = true;
    window.history.replaceState({ screen: "auth", authenticated: false }, "", ROUTES.LOGIN);
    showLoginFormOnly();
    return;
  }

  /** Bookmarked `/login`: show split auth immediately (logged-in users already redirected above). */
  if (path === ROUTES.LOGIN && pathRoutingEnabled()) {
    suppressSplashTransitions = true;
    showLoginFormOnly();
    return;
  }

  if (path === "/") {
    if (pathRoutingEnabled()) {
      window.history.replaceState({ screen: "splash", authenticated: false }, "", ROUTES.LOGIN);
    }
    return;
  }

  window.history.replaceState({ screen: "splash", authenticated: false }, "", ROUTES.LOGIN);
}
const ROLE_ALIASES = {
  user: "household",
  household: "household",
  collector: "collector",
  admin: "admin"
};

const ROLE_HOME_SCREEN = {
  household: "home",
  collector: "collector",
  admin: "admin"
};

const ROLE_ALLOWED_SCREENS = {
  household: new Set([
    "home",
    "track",
    "guide",
    "rewards",
    "profile",
    "leaderboard",
    "notifications",
    "about"
  ]),
  collector: new Set(["collector", "collector-history", "collector-profile"]),
  admin: new Set(["admin", "admin-profile"])
};

const BADGE_LEVELS = [
  { min: 0, label: "Eco Starter" },
  { min: 100, label: "Eco Supporter" },
  { min: 300, label: "BinBuddy" },
  { min: 700, label: "Eco Hero" }
];

/** Copy for the floating ❓ tutorial (shown after login, per role). */
const HELP_TOUR_STEPS_HOUSEHOLD = [
  {
    icon: "🏠",
    title: "Welcome, household",
    desc:
      "Log each recyclable pickup (PET or HDPE) with weight and optional photo. When a collector verifies it, you earn EcoPoints you can later spend on rewards."
  },
  {
    icon: "📊",
    title: "Dashboard",
    desc:
      "Your home screen shows rank, address, EcoPoints, and recent activity. Open the menu (☰ or top bar) to switch screens on smaller layouts."
  },
  {
    icon: "♻️",
    title: "Log Disposal",
    desc:
      "Go to Log Disposal: choose PET or HDPE, set kilograms, add a photo if you like, pick the date, then submit. New entries stay Pending until verified."
  },
  {
    icon: "📚",
    title: "Segregation guide",
    desc:
      "From Dashboard, tap the Seg. Guide card to see what counts as PET vs HDPE before you submit so your log matches your actual bags or bottles."
  },
  {
    icon: "🎁",
    title: "Rewards & Activity",
    desc:
      "Rewards lists what you can redeem with EcoPoints. Activity Log keeps your app notifications handy in one place."
  },
  {
    icon: "👤",
    title: "Profile",
    desc:
      "Profile shows your stats and totals. Keeping your barangay and contact details accurate helps admins and collectors support your area."
  }
];

const HELP_TOUR_STEPS_COLLECTOR = [
  {
    icon: "🚛",
    title: "Welcome, collector",
    desc:
      "You review pickups households submitted online. Verified logs award them EcoPoints; your job is to confirm the waste matches the log (using their photo when they attached one)."
  },
  {
    icon: "📥",
    title: "Unverified vs Verified",
    desc:
      "Use Unverified in the menu for the pickup queue, and Verified to see completed verifications this year. The same tabs appear on your Pickup queue screen."
  },
  {
    icon: "🔍",
    title: "How to verify",
    desc:
      "Open each card, check household details and optional photo proof, then tap Verify. Cards leave Unverified after you verify—they move to Verified and History."
  },
  {
    icon: "📋",
    title: "History & profile",
    desc:
      "History is read-only verified data for the whole year; Profile summarizes pickups tied to your account."
  },
  {
    icon: "⏳",
    title: "Stats",
    desc:
      "Verified counts completed logs this year; Pending counts logs still waiting in the household queue—you can clear them from the Unverified tab."
  }
];

const HELP_TOUR_STEPS_ADMIN = [
  {
    icon: "⚙️",
    title: "Welcome, admin",
    desc:
      "You oversee platform data at a glance: household activity, totals, and recent waste submissions."
  },
  {
    icon: "📈",
    title: "Analytics",
    desc:
      "The admin dashboard summarizes disposals, EcoPoints, and trends. Use it to monitor program health and barangay participation."
  },
  {
    icon: "📄",
    title: "Waste logs",
    desc:
      "Review the combined log list for status and verification context. Collectors and households act in their own apps; you get the full picture here."
  },
  {
    icon: "👤",
    title: "Profile & security",
    desc:
      "Use Profile for your admin account. Log out from the menu when you finish on a shared device."
  }
];

let helpTourIndex = 0;
let helpTourStepsActive = [];

const AppState = {
  currentScreen: "auth",
  role: "household",
  authMode: "login",
  logType: "bio",
  logQty: 1.0,
  currentUserId: null,
  currentUserName: null,
  users: [],
  logs: [],
  redemptions: [],
  /** Local-only: reward redeemals with QR proof for admin download (data URL). */
  rewardQrSubmissions: [],
  notifications: [],
  /** Collector pickup screen: pending/rejected vs completed. */
  collectorPickupTab: "unverified"
};

function normalizeRole(role) {
  return ROLE_ALIASES[role] || "household";
}

function selectedRegisterRole() {
  const selected = document.querySelector(".role-card.selected");
  const role = selected?.dataset?.role;
  const n = normalizeRole(role);
  return n === "collector" ? "collector" : "household";
}

const SessionManager = {
  save(session) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  },
  load() {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_err) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
  },
  clear() {
    sessionStorage.removeItem(SESSION_KEY);
  },
  clearAppCache() {
    localStorage.removeItem(STORAGE_KEY);
  },
  resetForFreshStart() {
    // Force login every app launch/reload.
    this.clear();
  }
};

const RoleGuard = {
  getAllowedScreens(role) {
    const normalizedRole = normalizeRole(role);
    return ROLE_ALLOWED_SCREENS[normalizedRole] || new Set([getRoleHomeScreen(normalizedRole)]);
  },
  getHomeScreen(role) {
    return getRoleHomeScreen(normalizeRole(role));
  },
  canAccess(role, screen) {
    return this.getAllowedScreens(role).has(screen);
  }
};

function handlePopNavigate() {
  const user = AuthService.currentUser();
  const path = normalizePath();
  const st = window.history.state || {};

  if (!user) {
    if (pathRoutingEnabled() && path === ROUTES.DASHBOARD) {
      window.history.replaceState({ screen: "auth", authenticated: false }, "", ROUTES.LOGIN);
    }
    exitAuthenticatedMount();
    dashboardScreensDeactivateAll();
    const topNav = document.getElementById("top-nav");
    if (topNav) {
      topNav.hidden = true;
      topNav.setAttribute("aria-hidden", "true");
    }
    refreshUI();
    const ae = document.getElementById("screen-auth");
    if (ae) resetViewportScroll(ae);
    return;
  }

  if (pathRoutingEnabled() && path === ROUTES.LOGIN) {
    enterAuthenticatedMount();
    historySyncAuthenticated(RoleGuard.getHomeScreen(user.role), true);
  }

  let safe = st.screen || RoleGuard.getHomeScreen(user.role);
  if (!RoleGuard.canAccess(user.role, safe)) safe = RoleGuard.getHomeScreen(user.role);
  goTo(safe, { trackHistory: false, skipAuthenticatedHistory: true, skipNavStack: true });
}

const HistoryGuard = {
  init() {
    window.addEventListener("popstate", handlePopNavigate);
  },
  push(screen) {
    if (!AuthService.currentUser()) return;
    historySyncAuthenticated(screen, false);
  },
  resetToLoginUrl() {
    historySyncLogin();
  }
};

function nowIso() {
  return new Date().toISOString();
}

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString();
}

function logReferenceInstant(log) {
  return new Date(log.logDate || log.createdAt);
}

function logCalendarYear(log) {
  const d = logReferenceInstant(log);
  return Number.isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
}

function isLogInCalendarYear(log, year) {
  return logCalendarYear(log) === year;
}

function collectorYearlyLogs(logs, year = new Date().getFullYear()) {
  return logs.filter(l => isLogInCalendarYear(l, year));
}

function computeCollectorDashboardStats(logs) {
  const year = new Date().getFullYear();
  const y = collectorYearlyLogs(logs, year);
  const verifiedCount = y.filter(l => l.status === "Completed").length;
  const pending = y.filter(l => l.status === "Pending").length;
  return { year, verifiedCount, pending };
}

function sortedVerifiedLogsYear(logs, year = new Date().getFullYear()) {
  return collectorYearlyLogs(logs, year)
    .filter(l => l.status === "Completed")
    .slice()
    .sort((a, b) => String(b.completedAt || b.createdAt).localeCompare(String(a.completedAt || a.createdAt)));
}

function verifiedLogsHandledByCollector(logs, collectorId, year = new Date().getFullYear()) {
  const cid = String(collectorId || "");
  return sortedVerifiedLogsYear(logs, year).filter(l => String(l.verifiedBy || "") === cid);
}

async function setAuthenticatedImageSrc(img, apiRelativePath) {
  if (!img || !apiRelativePath) return;
  const prev = img.dataset.bbBlobUrl;
  if (prev) {
    try {
      URL.revokeObjectURL(prev);
    } catch (_e) {
      /* ignore */
    }
    delete img.dataset.bbBlobUrl;
  }
  const base = await getApiBase();
  const tok = getToken();
  if (!tok) return;
  const res = await fetch(`${base}${apiRelativePath}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok) {
    img.alt = "Photo unavailable";
    img.classList.add("collector-proof-img--missing");
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  img.dataset.bbBlobUrl = url;
  img.src = url;
}

/** Photo proof submitted with the household log (collector / offline local). */
function collectorProofMarkup(log) {
  const id = String(log.id || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const hasData = log.photoPath && String(log.photoPath).startsWith("data:image/");
  if (apiMode && getToken() && log.hasPhoto && id) {
    return `<div class="bb-proof-wrap">
        <p class="bb-proof-label"><small>Household photo</small></p>
        <div class="bb-proof-mount" data-log-id="${id}" data-auth-photo="1"></div>
      </div>`;
  }
  if (hasData) {
    return `<div class="bb-proof-wrap">
        <p class="bb-proof-label"><small>Household photo</small></p>
        <img class="collector-proof-img" alt="Household photo proof" src=${JSON.stringify(log.photoPath)} />
      </div>`;
  }
  return "";
}

/** Human-readable verifier for log cards (signed-in collector, API `verifiedByName`, AppState users, else id). */
function wasteLogVerifierDisplayName(log) {
  if (!log || log.verifiedBy == null || log.verifiedBy === "") return "";
  const cur = AuthService.currentUser();
  if (cur && sameUserId(log.verifiedBy, cur.id)) {
    const selfName = String(cur.name || cur.email || "").trim();
    if (selfName) return selfName;
  }
  const fromApi =
    log.verifiedByName != null && String(log.verifiedByName).trim() !== ""
      ? String(log.verifiedByName).trim()
      : "";
  if (fromApi) return fromApi;
  const uid = log.verifiedBy;
  const u = (AppState.users || []).find(usr => sameUserId(usr.id, uid));
  if (u && u.name) return String(u.name).trim();
  return String(uid);
}

async function hydrateCollectorLogPhotoMounts() {
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "collector") return;
  if (!apiMode || !getToken()) return;
  const roots = document.querySelectorAll(
    "#screen-collector, #screen-collector-history, #screen-collector-profile"
  );
  for (const root of roots) {
    const mounts = root.querySelectorAll('.bb-proof-mount[data-auth-photo="1"]');
    for (const mount of mounts) {
      if (mount.querySelector("img")) continue;
      const rawId = mount.getAttribute("data-log-id");
      if (!rawId) continue;
      const img = document.createElement("img");
      img.className = "collector-proof-img";
      img.alt = "Household photo proof";
      mount.appendChild(img);
      await setAuthenticatedImageSrc(img, `/logs/${encodeURIComponent(rawId)}/photo`);
    }
  }
}

function htmlVerifiedLogCardReadOnly(log, opts = {}) {
  const showVerifier = opts.showVerifier !== false;
  const vName = showVerifier ? wasteLogVerifierDisplayName(log) : "";
  const verifier = vName ? ` · Verified by ${vName}` : "";
  const proof = collectorProofMarkup(log);
  return `
      <div class="card" style="margin-bottom:8px">
        <strong>${log.userName}</strong> • ${log.type} • ${log.weight} kg<br/>
        ${proof}
        <small>${formatDateTime(log.completedAt || log.createdAt)}${log.ecoPointsAwarded ? ` · +${log.ecoPointsAwarded} pts` : ""}${verifier}</small>
      </div>
    `;
}

function renderCollectorHistoryPage() {
  const el = document.getElementById("collector-history-page-list");
  const yearEl = document.getElementById("collector-history-year-label");
  const user = AuthService.currentUser();
  if (!el || !user || normalizeRole(user.role) !== "collector") return;
  const year = new Date().getFullYear();
  if (yearEl) yearEl.textContent = String(year);
  const logs = sortedVerifiedLogsYear(AppState.logs, year);
  el.innerHTML = logs.length
    ? logs.map(l => htmlVerifiedLogCardReadOnly(l)).join("")
    : `<p style="font-size:0.88rem;color:var(--text-muted);margin:0">No verified logs for ${year}.</p>`;
}

function renderCollectorProfileShell() {
  const user = AuthService.currentUser();
  const sec = document.getElementById("screen-collector-profile");
  if (!sec || !user || normalizeRole(user.role) !== "collector") return;
  const nameEl = sec.querySelector(".profile-name");
  const roleEl = sec.querySelector(".profile-role");
  if (nameEl) nameEl.textContent = user.name || "Collector";
  if (roleEl) roleEl.textContent = `Collector · ${getUserBarangayLabel(user)}`;

  const hist = document.getElementById("collector-profile-history-list");
  if (!hist) return;
  const year = new Date().getFullYear();
  const mine = verifiedLogsHandledByCollector(AppState.logs, user.id, year);
  hist.innerHTML = mine.length
    ? mine.map(l => htmlVerifiedLogCardReadOnly(l, { showVerifier: true })).join("")
    : `<p style="font-size:0.88rem;color:var(--text-muted);margin:0">No verified pickups assigned to you for ${year} yet.</p>`;
}

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}

function setToken(t) {
  if (t) sessionStorage.setItem(TOKEN_KEY, t);
  else sessionStorage.removeItem(TOKEN_KEY);
}

function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

async function apiFetch(path, options = {}) {
  if (isFileProtocol()) {
    const err = new Error(
      "This page was opened as a local file. Open your hosted BinBuddy URL or run npm start so the /api backend is available."
    );
    err.code = "FILE_PROTOCOL";
    throw err;
  }
  const timeoutMs = options.timeoutMs != null ? Number(options.timeoutMs) : 25000;
  const { timeoutMs: _omit, ...fetchOpts } = options;
  const headers = { "Content-Type": "application/json", ...(fetchOpts.headers || {}) };
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const base = await getApiBase();
    const res = await fetch(`${base}${path}`, { ...fetchOpts, headers, signal: ctrl.signal });
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    const headerSaysJson = contentType.includes("json");
    const bodyLooksJson =
      typeof data === "object" &&
      data !== null &&
      !Array.isArray(data) &&
      text &&
      /^\s*\{/.test(text);
    const isJson = headerSaysJson || bodyLooksJson;
    if (!res.ok) {
      const detail = summarizeApiValidationMessage(data) || data.message;
      const err = new Error(detail || res.statusText || "Request failed");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    if (!isJson) {
      const err = new Error(
        "BinBuddy API is not reachable from this page. If UI and API are on different hosts, set BINBUDDY_API_BASE (or call setApiBaseOverride(...)) to your Node API base URL."
      );
      err.status = res.status || 0;
      err.code = "BAD_API_RESPONSE";
      throw err;
    }
    return data;
  } catch (e) {
    if (e && e.name === "AbortError") {
      const err = new Error("Request timed out. Check that the BinBuddy server is running and reachable.");
      err.status = 0;
      err.code = "TIMEOUT";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** POST multipart (e.g. QR photo). Do not set Content-Type — browser sets boundary. */
async function apiFetchMultipart(path, formData, options = {}) {
  if (isFileProtocol()) {
    const err = new Error(
      "This page was opened as a local file. Use your hosted URL or npm start so uploads can reach the API."
    );
    err.code = "FILE_PROTOCOL";
    throw err;
  }
  const timeoutMs = options.timeoutMs != null ? Number(options.timeoutMs) : 60000;
  const { timeoutMs: _omit, ...fetchOpts } = options;
  const headers = { ...(fetchOpts.headers || {}) };
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const base = await getApiBase();
    const res = await fetch(`${base}${path}`, {
      ...fetchOpts,
      method: fetchOpts.method || "POST",
      body: formData,
      headers,
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = summarizeApiValidationMessage(data) || data.message;
      const err = new Error(detail || res.statusText || "Request failed");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } catch (e) {
    if (e && e.name === "AbortError") {
      const err = new Error("Upload timed out. Try a smaller image.");
      err.status = 0;
      err.code = "TIMEOUT";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function syncFromServer(options = {}) {
  const token = getToken();
  if (!token) {
    apiMode = false;
    return false;
  }
  if (isFileProtocol()) {
    apiMode = false;
    clearToken();
    SessionManager.clear();
    clearRuntimeUserContext();
    return false;
  }
  const tOpt = options.perRequestTimeoutMs != null ? { timeoutMs: options.perRequestTimeoutMs } : {};
  try {
    const me = await apiFetch("/auth/me", tOpt);
    const user = me.user;
    AppState.currentUserId = user.id;
    AppState.currentUserName = user.name;
    AppState.role = normalizeRole(user.role);

    const role = normalizeRole(user.role);

    const mapNotifications = nd =>
      (nd.notifications || []).map(n => ({
        text: n.text,
        createdAt: n.createdAt || n.created_at,
        userId: user.id
      }));

    if (role === "household") {
      const [logsData, notifData, lb] = await Promise.all([
        apiFetch("/logs", tOpt),
        apiFetch("/notifications", tOpt),
        apiFetch("/leaderboard", tOpt)
      ]);
      AppState.logs = logsData.logs || [];
      AppState.notifications = mapNotifications(notifData);
      const rows = lb.leaderboard || [];
      const myIdStr = String(user.id);
      const myLb = rows.find(r => String(r.id) === myIdStr);

      const myLogsFiltered = AppState.logs.filter(
        l => String(l.userId) === myIdStr && isLogStatusCompleted(l.status)
      );

      const meRow = {
        id: user.id,
        name: user.name || user.email || "User",
        email: user.email || "",
        phoneNumber: user.phoneNumber || "",
        address: user.address || "",
        gender: user.gender || "",
        role: "household",
        ecoPoints: Number(user.ecoPoints) || 0,
        streak: Number(user.streak) || 0,
        badge: user.badge || "Eco Starter",
        barangay: user.barangay || "Lipa City",
        password: "",
        completedDisposals: myLb
          ? Number(myLb.completedDisposals) || 0
          : myLogsFiltered.length,
        completedKg: myLb
          ? Number(myLb.completedKg) || 0
          : myLogsFiltered.reduce((s, l) => s + (Number(l.weight) || 0), 0)
      };
      const others = rows
        .filter(r => String(r.id) !== myIdStr)
        .map(r => ({
          id: r.id,
          name: r.name || "User",
          email: "",
          phoneNumber: "",
          address: "",
          gender: "",
          role: "household",
          ecoPoints: Number(r.ecoPoints) || 0,
          streak: 0,
          badge: "Eco Starter",
          barangay: r.barangay != null ? String(r.barangay) : "",
          password: "",
          completedDisposals: Number(r.completedDisposals) || 0,
          completedKg: Number(r.completedKg) || 0
        }));
      AppState.users = [meRow, ...others];
      adminAnalyticsCache = null;
    } else if (role === "admin") {
      const [logsData, notifData, analytics, usersOrNull] = await Promise.all([
        apiFetch("/logs", tOpt),
        apiFetch("/notifications", tOpt),
        apiFetch("/admin/analytics", tOpt),
        apiFetch("/admin/users", tOpt).catch(() => null)
      ]);
      AppState.logs = logsData.logs || [];
      AppState.notifications = mapNotifications(notifData);
      adminAnalyticsCache = analytics;

      AppState.users = [
        {
          id: user.id,
          name: user.name,
          email: user.email || "",
          phoneNumber: user.phoneNumber || "",
          address: user.address || "",
          gender: user.gender || "",
          role: user.role,
          ecoPoints: user.ecoPoints || 0,
          streak: user.streak || 0,
          badge: user.badge || "",
          barangay: user.barangay || "",
          password: ""
        }
      ];
      const rawUsers = usersOrNull && usersOrNull.users ? usersOrNull.users : [];
      const mappedAdminUsers = rawUsers.map(u => ({
        id: u.id,
        name: u.name,
        email: u.email || "",
        phoneNumber: u.phoneNumber || "",
        address: u.address || "",
        gender: u.gender || "",
        role: u.role,
        ecoPoints: Number(u.ecoPoints) || 0,
        streak: Number(u.streak) || 0,
        badge: u.badge || "",
        barangay: u.barangay || "",
        password: ""
      }));
      if (mappedAdminUsers.length) AppState.users = mappedAdminUsers;
    } else {
      const [logsData, notifData] = await Promise.all([
        apiFetch("/logs", tOpt),
        apiFetch("/notifications", tOpt)
      ]);
      AppState.logs = logsData.logs || [];
      AppState.notifications = mapNotifications(notifData);
      AppState.users = [
        {
          id: user.id,
          name: user.name,
          email: user.email || "",
          phoneNumber: user.phoneNumber || "",
          address: user.address || "",
          gender: user.gender || "",
          role: user.role,
          ecoPoints: user.ecoPoints || 0,
          streak: user.streak || 0,
          badge: user.badge || "",
          barangay: user.barangay || "Lipa City",
          password: ""
        }
      ];
      adminAnalyticsCache = null;
    }

    SessionManager.save({
      currentUserId: AppState.currentUserId,
      role: normalizeRole(AppState.role),
      name: AppState.currentUserName
    });

    apiMode = true;
    return true;
  } catch (e) {
    console.warn(e);
    apiMode = false;
    const status = e && typeof e.status === "number" ? e.status : null;
    if (status === 401 || status === 403) {
      clearToken();
      clearSession();
      if (typeof clearRuntimeUserContext === "function") clearRuntimeUserContext();
    }
    return false;
  }
}

/** First paint after reload: bounded per-request timeouts; overall UI wait must stay short for hosted static sites. */
const BOOTSTRAP_SYNC_PER_REQUEST_MS = 7000;
const BOOTSTRAP_SYNC_UI_WAIT_MS = 16000;

function uiApplySuccessfulServerHydration() {
  suppressSplashTransitions = true;
  runInitialUrlRouting(true);
  refreshUI();
}

async function runInitialSessionHydrationFromToken() {
  /** While JWT sync runs, don't block the sign-in screen behind the splash. */
  const peelIfStillOnSplash = window.setTimeout(() => {
    try {
      if (AuthService.currentUser()) return;
      const splash = document.getElementById("screen-splash");
      if (splash?.classList.contains("active")) forceShowLoginShell();
    } catch (_e) {
      /* ignore */
    }
  }, 900);

  try {
    const syncPromise = syncFromServer({
      perRequestTimeoutMs: BOOTSTRAP_SYNC_PER_REQUEST_MS
    }).then(ok => ({
      finished: true,
      ok: Boolean(ok)
    }));

    const raced = await Promise.race([
      syncPromise,
      sleep(BOOTSTRAP_SYNC_UI_WAIT_MS).then(() => ({ timedOut: true }))
    ]);

    if (raced.finished && raced.ok) {
      window.clearTimeout(peelIfStillOnSplash);
      uiApplySuccessfulServerHydration();
      return;
    }

    void syncPromise.then(outcome => {
      if (outcome && outcome.ok) {
        window.clearTimeout(peelIfStillOnSplash);
        uiApplySuccessfulServerHydration();
      }
    });

    apiMode = false;

    if (AuthService.currentUser()) {
      window.clearTimeout(peelIfStillOnSplash);
      recoverSplashIfLoggedIn();
      refreshUI();
      if (raced.timedOut) {
        showToast("Server slow — showing saved data until we reconnect.");
      }
      return;
    }

    window.clearTimeout(peelIfStillOnSplash);
    attachLoginPhase();
    showLoginFormOnly();
    suppressSplashTransitions = true;
    showToast("Still connecting… If this persists, tap Check connection on the sign-in page.");
    refreshUI();
  } catch (err) {
    window.clearTimeout(peelIfStillOnSplash);
    console.error("[runInitialSessionHydrationFromToken]", err);
    try {
      attachLoginPhase();
      forceShowLoginShell();
    } catch (_e) {
      /* ignore */
    }
  }
}

/** When the server accepted auth but full sync failed (network/503), keep the JWT and mirror API user into AppState so the UI can load. */
function applySessionFromAuthUser(user) {
  if (!user || user.id == null) return;
  AppState.currentUserId = user.id;
  AppState.currentUserName = user.name || user.email || "User";
  AppState.role = normalizeRole(user.role);
  const local = {
    id: user.id,
    name: user.name || user.email || "User",
    email: user.email || "",
    phoneNumber: user.phoneNumber || "",
    address: user.address || "",
    gender: user.gender || "",
    role: user.role,
    ecoPoints: Number(user.ecoPoints) || 0,
    streak: Number(user.streak) || 0,
    badge: user.badge || "Eco Starter",
    barangay: user.barangay || "",
    password: ""
  };
  AppState.users = [local];
  AppState.logs = [];
  AppState.notifications = [];
  SessionManager.save({
    currentUserId: AppState.currentUserId,
    role: normalizeRole(AppState.role),
    name: AppState.currentUserName
  });
  apiMode = true;
}

function updateHomeStats() {
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "household") return;
  const logs = wasteLogsForUser(user);
  const today = new Date().toDateString();
  let petToday = 0;
  let hdpeToday = 0;
  logs.forEach(l => {
    if (new Date(l.createdAt).toDateString() !== today) return;
    if (l.type === "PET") petToday += Number(l.weight) || 0;
    if (l.type === "HDPE") hdpeToday += Number(l.weight) || 0;
  });
  const stats = document.querySelectorAll("#screen-home .stats-grid .stat-value");
  if (stats[0]) stats[0].innerHTML = `${petToday.toFixed(1)}<span style="font-size:0.8rem">kg</span>`;
  if (stats[1]) stats[1].innerHTML = `${hdpeToday.toFixed(1)}<span style="font-size:0.8rem">kg</span>`;
  const ecoPts = Number(user.ecoPoints) || 0;
  if (stats[2]) stats[2].textContent = ecoPts;
  if (stats[3]) stats[3].textContent = logs.length;

}

function buildSeedState() {
  return {
    users: [
      {
        id: "USR001",
        name: "Maria Santos",
        email: "maria@email.com",
        password: "password123",
        role: "household",
        ecoPoints: 1245,
        streak: 7,
        badge: "Eco Hero",
        barangay: "Lipa City",
        phoneNumber: "09171234567",
        address: "Lipa City, Philippines",
        gender: "female"
      },
      {
        id: "COL001",
        name: "Roberto Cruz",
        email: "collector@email.com",
        password: "password123",
        role: "collector",
        ecoPoints: 0,
        streak: 0,
        badge: "Collector",
        barangay: "Lipa City",
        phoneNumber: "09171230000",
        address: "Lipa City, Philippines",
        gender: "male"
      },
      {
        id: "ADM001",
        name: "Barangay Administrator",
        email: "admin@email.com",
        password: "password123",
        role: "admin",
        ecoPoints: 0,
        streak: 0,
        badge: "Admin",
        barangay: "Lipa City",
        phoneNumber: "09179990000",
        address: "Lipa City, Philippines",
        gender: "male"
      }
    ],
    logs: [
      {
        id: "LOG001",
        userId: "USR001",
        userName: "Maria Santos",
        type: "PET",
        weight: 1.2,
        createdAt: nowIso(),
        logDate: nowIso(),
        status: "Completed",
        verifiedBy: "COL001",
        completedAt: nowIso(),
        ecoPointsAwarded: 24
      },
      {
        id: "LOG002",
        userId: "USR001",
        userName: "Maria Santos",
        type: "HDPE",
        weight: 0.8,
        createdAt: nowIso(),
        logDate: nowIso(),
        status: "Pending",
        verifiedBy: null,
        completedAt: null,
        ecoPointsAwarded: 0
      },
      {
        id: "LOG003",
        userId: "USR001",
        userName: "Maria Santos",
        type: "PET",
        weight: 0.5,
        createdAt: nowIso(),
        logDate: nowIso(),
        status: "Rejected",
        verifiedBy: "COL001",
        completedAt: null,
        ecoPointsAwarded: 0
      }
    ],
    redemptions: [],
    notifications: []
  };
}

function persistState() {
  if (apiMode) return;
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      users: AppState.users,
      logs: AppState.logs,
      redemptions: AppState.redemptions,
      rewardQrSubmissions: AppState.rewardQrSubmissions,
      notifications: AppState.notifications
    })
  );
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const seed = buildSeedState();
    AppState.users = seed.users;
    AppState.logs = seed.logs;
    AppState.redemptions = seed.redemptions;
    AppState.rewardQrSubmissions = [];
    AppState.notifications = seed.notifications;
    persistState();
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    AppState.users = parsed.users || [];
    AppState.logs = parsed.logs || [];
    AppState.redemptions = parsed.redemptions || [];
    AppState.rewardQrSubmissions = parsed.rewardQrSubmissions || [];
    AppState.notifications = parsed.notifications || [];
  } catch (_err) {
    const fallback = buildSeedState();
    AppState.users = fallback.users;
    AppState.logs = fallback.logs;
    AppState.redemptions = fallback.redemptions;
    AppState.rewardQrSubmissions = [];
    AppState.notifications = fallback.notifications;
    persistState();
  }
}

function persistSession() {
  SessionManager.save({
    currentUserId: AppState.currentUserId,
    role: normalizeRole(AppState.role),
    name: AppState.currentUserName
  });
}

function clearSession() {
  AppState.currentUserId = null;
  AppState.currentUserName = null;
  AppState.role = "household";
  SessionManager.clear();
}

function loadSession() {
  const parsed = SessionManager.load();
  if (!parsed || !parsed.currentUserId) return;
  const user = AppState.users.find(u => sameUserId(u.id, parsed.currentUserId));
  if (!user) {
    SessionManager.clear();
    return;
  }
  const sessionRole = normalizeRole(parsed.role);
  const userRole = normalizeRole(user.role);
  if (sessionRole !== userRole) {
    SessionManager.clear();
    return;
  }
  AppState.currentUserId = user.id;
  AppState.currentUserName = user.name || "User";
  AppState.role = userRole;
}

function getRoleHomeScreen(role) {
  return ROLE_HOME_SCREEN[normalizeRole(role)] || "home";
}

const AuthService = {
  register(payload) {
    const { email, password, role } = payload;
    const pwErr = validateRegisterPasswordClient(password);
    if (pwErr) return { ok: false, message: pwErr };
    const phoneErr = validateRegisterPhoneClient(payload.phoneNumber);
    if (phoneErr) return { ok: false, message: phoneErr };
    const addressErr = validateRegisterAddressClient(payload.address);
    if (addressErr) return { ok: false, message: addressErr };
    const genderErr = validateRegisterGenderClient(payload.gender);
    if (genderErr) return { ok: false, message: genderErr };
    const existing = AppState.users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (existing) return { ok: false, message: "Account already exists for this role." };
    const idPrefix = role === "collector" ? "COL" : role === "admin" ? "ADM" : "USR";
    const id = `${idPrefix}${String(AppState.users.length + 1).padStart(3, "0")}`;
    const addrRaw = String(payload.address || "").trim();
    const gender = String(payload.gender || "").trim().toLowerCase();
    const user = {
      id,
      name: (payload.name || email.split("@")[0].replace(/\./g, " ")).trim() || "User",
      email,
      password,
      role,
      ecoPoints: 0,
      streak: 0,
      badge: "Eco Starter",
      barangay: extractBarangaySegment(addrRaw),
      phoneNumber: String(payload.phoneNumber || "").trim(),
      address: addrRaw,
      gender: gender === "male" || gender === "female" ? gender : ""
    };
    AppState.users.push(user);
    persistState();
    return { ok: true, user };
  },
  login(payload) {
    const { email, password } = payload;
    const user = AppState.users.find(
      u =>
        u.email.toLowerCase() === email.toLowerCase() &&
        u.password === password
    );
    if (!user) {
      const exists = AppState.users.find(u => u.email.toLowerCase() === email.toLowerCase());
      return { ok: false, message: exists ? "Incorrect password." : "Account does not exist." };
    }
    AppState.currentUserId = user.id;
    AppState.currentUserName = user.name || "User";
    AppState.role = normalizeRole(user.role);
    persistSession();
    return { ok: true, user };
  },
  currentUser() {
    if (AppState.currentUserId == null) return null;
    return AppState.users.find(u => sameUserId(u.id, AppState.currentUserId)) || null;
  }
};

const WasteLogService = {
  normalizeWasteType(rawType) {
    if (rawType === "PET" || rawType === "pet") return "PET";
    if (rawType === "HDPE" || rawType === "hdpe") return "HDPE";
    if (rawType === "bio") return "PET";
    if (rawType === "rec") return "HDPE";
    return null;
  },
  validate(weight, rawType, user) {
    if (!user) return "Login required.";
    const normalizedType = this.normalizeWasteType(rawType);
    if (!normalizedType) return "Waste type selection is required (PET or HDPE only).";
    if (weight === null || weight === undefined || Number.isNaN(weight)) return "Weight is required and must be numeric.";
    if (weight <= 0) return "Weight must be greater than zero.";
    return null;
  },
  createLog({ user, rawType, weight, logDate, photoPath }) {
    const log = {
      id: `LOG${String(Date.now()).slice(-6)}`,
      userId: user.id,
      userName: user.name,
      type: this.normalizeWasteType(rawType),
      weight: Number(weight.toFixed(2)),
      createdAt: nowIso(),
      logDate: logDate || nowIso(),
      status: "Pending",
      verifiedBy: null,
      completedAt: null,
      ecoPointsAwarded: 0,
      photoPath: photoPath || null
    };
    AppState.logs.unshift(log);
    AppState.notifications.unshift({
      text: `Log submitted (${log.type}, ${log.weight} kg). Status: Pending.`,
      createdAt: nowIso(),
      userId: user.id
    });
    persistState();
    return log;
  }
};

const VerificationService = {
  verifyLog(logId, isVerified, collectorId, collectorDisplayName) {
    const log = AppState.logs.find(l => l.id === logId);
    if (!log) return null;
    const verifierLabel = (() => {
      const s = collectorDisplayName != null ? String(collectorDisplayName).trim() : "";
      if (s) return s;
      const cur = AuthService.currentUser();
      if (cur && sameUserId(cur.id, collectorId)) {
        return String(cur.name || cur.email || "").trim();
      }
      return "";
    })();
    if (!isVerified) {
      if (log.status === "Completed") return log;
      log.status = "Rejected";
      log.verifiedBy = collectorId;
      if (verifierLabel) log.verifiedByName = verifierLabel;
      log.completedAt = null;
      log.ecoPointsAwarded = 0;
      AppState.notifications.unshift({
        text: `Log ${log.id} marked as not segregated (household notified).`,
        createdAt: nowIso(),
        userId: log.userId
      });
      persistState();
      return log;
    }
    if (log.status === "Completed") return log;
    log.status = "Completed";
    log.verifiedBy = collectorId;
    if (verifierLabel) log.verifiedByName = verifierLabel;
    log.completedAt = nowIso();
    log.ecoPointsAwarded = Math.round(log.weight * (log.type === "PET" ? 20 : 25));
    const user = AppState.users.find(u => sameUserId(u.id, log.userId));
    if (user) {
      user.ecoPoints += log.ecoPointsAwarded;
      user.badge = BADGE_LEVELS.reduce((acc, level) => (user.ecoPoints >= level.min ? level.label : acc), "Eco Starter");
      AppState.notifications.unshift({
        text: `Log ${log.id} completed. +${log.ecoPointsAwarded} EcoPoints awarded.`,
        createdAt: nowIso(),
        userId: log.userId
      });
    }
    persistState();
    return log;
  }
};

const RewardsService = {
  catalog() {
    return [
      { id: "RWD-LOAD-50", name: "Mobile Load", display: "₱50 Load", cost: 500 },
      { id: "RWD-VOUCH-100", name: "Voucher", display: "₱100 Voucher", cost: 1000 },
      { id: "RWD-GCASH-75", name: "GCash", display: "₱75 GCash", cost: 750 }
    ];
  },
  redeem(rewardId, user, qrDataUrl = null) {
    const reward = this.catalog().find(r => r.id === rewardId);
    if (!reward) return { ok: false, message: "Reward not found." };
    if (!user) return { ok: false, message: "Login required." };
    if (user.ecoPoints < reward.cost) return { ok: false, message: "Not enough EcoPoints." };
    user.ecoPoints -= reward.cost;
    const rdmId = `RDM${Date.now()}`;
    AppState.redemptions.unshift({
      id: rdmId,
      userId: user.id,
      rewardId: reward.id,
      rewardName: reward.display,
      cost: reward.cost,
      createdAt: nowIso()
    });
    if (qrDataUrl) {
      AppState.rewardQrSubmissions.unshift({
        id: rdmId,
        userId: user.id,
        userName: user.name || "User",
        rewardId: reward.id,
        rewardDisplay: reward.display,
        cost: reward.cost,
        qrDataUrl,
        createdAt: nowIso()
      });
    }
    AppState.notifications.unshift({
      text: `Redeemed ${reward.display} for ${reward.cost} points.`,
      createdAt: nowIso(),
      userId: user.id
    });
    persistState();
    return { ok: true, reward };
  }
};

const AnalyticsService = {
  metrics() {
    const total = AppState.logs.length;
    const completed = AppState.logs.filter(l => l.status === "Completed").length;
    const pending = AppState.logs.filter(l => l.status === "Pending").length;
    const rejected = AppState.logs.filter(l => l.status === "Rejected").length;
    const completedKg = AppState.logs
      .filter(l => l.status === "Completed")
      .reduce((sum, l) => sum + Number(l.weight) || 0, 0);
    const allDecidedKg = AppState.logs
      .filter(l => ["Completed", "Pending", "Rejected"].includes(l.status))
      .reduce((sum, l) => sum + Number(l.weight) || 0, 0);
    const recyclableCompletedKg = AppState.logs
      .filter(l => l.status === "Completed" && ["PET", "HDPE"].includes(l.type))
      .reduce((sum, l) => sum + Number(l.weight) || 0, 0);
    const decided = completed + pending + rejected;
    const compliance = decided > 0 ? Math.round((completed / decided) * 100) : 0;
    const recyclingRate =
      allDecidedKg > 0 ? Math.round((recyclableCompletedKg / allDecidedKg) * 100) : completedKg > 0 ? 100 : 0;
    const ecoPointsDistributed = AppState.logs.reduce((sum, l) => sum + (l.ecoPointsAwarded || 0), 0);
    const activeUsers = (AppState.users || []).filter(u =>
      ["household", "collector"].includes(normalizeRole(u.role))
    ).length;
    return {
      totalLogs: total,
      completedLogs: completed,
      pendingLogs: pending,
      rejectedLogs: rejected,
      totalCollectedKg: Number(completedKg.toFixed(1)),
      compliance,
      recyclingRate,
      ecoPointsDistributed,
      activeUsers
    };
  },
  /** Last 7 calendar days — kg from completed pickups (prefer completedAt). */
  weeklySeries() {
    const pad2 = n => String(n).padStart(2, "0");
    const ymd = dt => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const buckets = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = ymd(d);
      const label = d.toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric" });
      buckets.push({ key, label, val: 0 });
    }
    AppState.logs.forEach(log => {
      if (log.status !== "Completed") return;
      const iso = log.completedAt || log.createdAt;
      if (!iso) return;
      const t = new Date(iso);
      if (Number.isNaN(t.getTime())) return;
      const key = ymd(t);
      const b = buckets.find(x => x.key === key);
      if (b) b.val += Number(log.weight) || 0;
    });
    return buckets.map(({ label, val }) => ({ day: label, val: Number(val.toFixed(1)) }));
  },
  rollingWeekCaption() {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(end.getDate() - 6);
    const fmt = d =>
      d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `${fmt(start)} – ${fmt(end)}`;
  }
};

function resetViewportScroll(activeScreenEl) {
  const flush = () => {
    window.scrollTo(0, 0);
    if (document.documentElement) document.documentElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
    const app = document.getElementById("app");
    if (app) app.scrollTop = 0;
    if (activeScreenEl && activeScreenEl.scrollTop !== undefined) {
      activeScreenEl.scrollTop = 0;
    }
  };
  flush();
  requestAnimationFrame(() => requestAnimationFrame(flush));
}

/** If splash never hands off (timer starved, bugs), user must still reach the sign-in UI. */
function forceShowLoginShell() {
  try {
    const mount = document.getElementById("mount-login-phase");
    const login = document.getElementById("screen-auth");
    if (!mount || !mount.parentNode || !login) return;
    if (AuthService.currentUser()) return;
    suppressSplashTransitions = true;
    mount.querySelectorAll(".screen").forEach(el => el.classList.remove("active"));
    login.classList.add("active");
    setViewportAuthLock(true);
    resetViewportScroll(login);
    if (pathRoutingEnabled()) {
      try {
        window.history.replaceState({ screen: "auth", authenticated: false }, "", ROUTES.LOGIN);
      } catch (_e) {
        /* ignore */
      }
    }
  } catch (e) {
    console.warn("[forceShowLoginShell]", e);
  }
}

/** Multiple deadlines — hosting/CDN must never leave only the animated splash visible. */
function scheduleSplashAuthFailsafes() {
  [120, 400, 850, 1700, 3500].forEach(ms => {
    window.setTimeout(() => {
      try {
        if (suppressSplashTransitions) return;
        if (AuthService.currentUser()) return;
        const splash = document.getElementById("screen-splash");
        if (splash && splash.classList.contains("active")) {
          forceShowLoginShell();
        }
      } catch (_e) {
        /* ignore */
      }
    }, ms);
  });
}

/** If we have a restored user but the splash is still showing, recover (e.g. routing exception). */
function recoverSplashIfLoggedIn() {
  try {
    const u = AuthService.currentUser();
    if (!u) return;
    const sp = document.getElementById("screen-splash");
    if (!sp?.isConnected || !sp.classList.contains("active")) return;
    suppressSplashTransitions = true;
    finalizeAuthenticatedEntry(RoleGuard.getHomeScreen(u.role), { replaceHistory: true });
  } catch (err) {
    console.error("[recoverSplashIfLoggedIn]", err);
  }
}

function tryShowAuthApiHint() {
  const el = document.getElementById("auth-api-hint");
  if (!el) return;
  if (isFileProtocol()) {
    el.hidden = false;
    el.classList.add("auth-api-hint--warn");
    el.textContent =
      "This page was opened from disk (file://). Run npm start or open your HTTPS site URL so BinBuddy can reach its API.";
    return;
  }
  if (apiProbesHadHealthyHit) {
    el.hidden = true;
    return;
  }
  const explicit = typeof window !== "undefined" && String(window.BINBUDDY_API_BASE || "").trim();
  let stored = "";
  try {
    stored = typeof localStorage !== "undefined" ? String(localStorage.getItem(API_BASE_STORAGE_KEY) || "").trim() : "";
  } catch (_e) {
    stored = "";
  }
  const metaEl =
    typeof document !== "undefined" ? document.querySelector('meta[name="binbuddy-api-base"]') : null;
  const metaNorm = normalizeApiBase(metaEl?.getAttribute?.("content") || "");
  const hasOverride = Boolean(explicit || stored || metaNorm);
  el.hidden = false;
  if (hasOverride) {
    el.textContent =
      "Saved API URL did not respond to /health JSON. Confirm the Node server is running on that host, HTTPS matches, CORS allows this site, and the URL ends with /api — then Reset API link + Check connection.";
  } else {
    el.innerHTML =
      "<strong>No API on this origin.</strong> If you deployed only HTML (Netlify/GitHub Pages, etc.), the Node backend must live at its own URL. Set <code>window.BINBUDDY_API_BASE = \"https://your-server.com/api\"</code> in a script tag, or proxy <code>/api</code> to your API, then tap <strong>Check connection</strong>.";
  }
}

function wireSplashTapToSkip() {
  const sp = document.getElementById("screen-splash");
  if (!sp || sp.dataset.bbSkipWired) return;
  sp.dataset.bbSkipWired = "1";
  sp.setAttribute("role", "button");
  sp.setAttribute("tabindex", "0");
  sp.setAttribute("aria-label", "Skip to sign in");
  try {
    sp.style.touchAction = "manipulation";
  } catch (_e) {
    /* ignore */
  }
  const go = () => {
    try {
      if (AuthService.currentUser()) {
        recoverSplashIfLoggedIn();
        return;
      }
      forceShowLoginShell();
    } catch (_e) {
      /* ignore */
    }
  };
  sp.addEventListener("click", go);
  /** Some mobile WebViews are slow or flaky delivering `click` on full-screen sections; `touchend` is reliable. */
  sp.addEventListener(
    "touchend",
    e => {
      if (!sp.classList.contains("active")) return;
      e.preventDefault();
      go();
    },
    { passive: false }
  );
  sp.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  });
}

function initSplash(_restoredSession) {
  const splashScreen = document.getElementById("screen-splash");
  wireSplashTapToSkip();

  if (isFileProtocol()) {
    suppressSplashTransitions = true;
    showLoginFormOnly();
    if (pathRoutingEnabled()) {
      window.history.replaceState({ screen: "auth", authenticated: false }, "", ROUTES.LOGIN);
    }
    const ae = document.getElementById("screen-auth");
    if (ae) resetViewportScroll(ae);
    return;
  }

  if (!splashScreen && !AuthService.currentUser()) {
    showLoginFormOnly();
    return;
  }
  if (!splashScreen) return;

  if (suppressSplashTransitions || AuthService.currentUser()) {
    recoverSplashIfLoggedIn();
    /**
     * `/login` and `/dashboard` guests set `suppressSplashTransitions` and already call `showLoginFormOnly`.
     * If splash is still active (race or partial init), never leave guests trapped on the splash.
     */
    if (!AuthService.currentUser()) {
      const splash = document.getElementById("screen-splash");
      const auth = document.getElementById("screen-auth");
      if (splash?.classList.contains("active") && (!auth || !auth.classList.contains("active"))) {
        showLoginFormOnly();
        if (pathRoutingEnabled()) {
          try {
            window.history.replaceState({ screen: "auth", authenticated: false }, "", ROUTES.LOGIN);
          } catch (_e) {
            /* ignore */
          }
        }
        if (auth) resetViewportScroll(auth);
      }
    }
    return;
  }

  showSplashOnly();
  if (pathRoutingEnabled()) {
    historySplashOnLoginRoute();
  }

  scheduleSplashAuthFailsafes();

  window.setTimeout(() => {
    const u = AuthService.currentUser();
    if (u) {
      recoverSplashIfLoggedIn();
      return;
    }

    showLoginFormOnly();
    if (pathRoutingEnabled()) {
      window.history.replaceState({ screen: "auth", authenticated: false }, "", ROUTES.LOGIN);
    }
    const ae = document.getElementById("screen-auth");
    if (ae) resetViewportScroll(ae);
  }, 220);

  window.setTimeout(() => {
    try {
      if (suppressSplashTransitions) return;
      if (AuthService.currentUser()) return;
      const splash = document.getElementById("screen-splash");
      if (splash?.classList.contains("active")) forceShowLoginShell();
    } catch (_e) {
      /* ignore */
    }
  }, 2800);
}

function syncTrackScreenSubView(screen, trackSubView) {
  const el = document.getElementById("screen-track");
  if (!el) return;
  const historyOnly = screen === "track" && trackSubView === "history";
  el.classList.toggle("track-history-only", historyOnly);
  const h1 = el.querySelector(".page-header h1");
  const sub = el.querySelector(".page-header-sub");
  if (h1) h1.textContent = historyOnly ? "Disposal History" : "Log Your Disposal";
  if (sub) sub.textContent = historyOnly ? "📋 Your past disposals" : "📦 Waste Tracking";
}

function goTo(screen, options = {}) {
  const {
    trackHistory = true,
    skipAuthenticatedHistory = false,
    trackSubView,
    skipNavStack = false
  } = options;
  const user = AuthService.currentUser();
  const fromScreen = AppState.currentScreen;
  const fromTrackHistory =
    fromScreen === "track" &&
    Boolean(document.getElementById("screen-track")?.classList.contains("track-history-only"));

  if (screen !== "auth" && screen !== "splash" && !user) {
    showToast("Please login first.");
    suppressSplashTransitions = true;
    exitAuthenticatedMount();
    goToAuthScreen(false);
    historySyncLogin();
    return;
  }
  if (user) {
    const userRole = normalizeRole(user.role);
    if (!RoleGuard.canAccess(userRole, screen)) {
      const safeScreen = RoleGuard.getHomeScreen(userRole);
      if (screen !== safeScreen) {
        showToast(`${userRole === "household" ? "User" : userRole} dashboard only.`);
      }
      screen = safeScreen;
    }
  } else if (screen !== "auth" && screen !== "splash") {
    screen = "auth";
  }
  if (screen === "auth") {
    logout(false);
    return;
  }

  const dash = document.getElementById("mount-dashboard-phase");
  dash?.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  const target = document.getElementById(`screen-${screen}`);
  if (!target || !dash || !dash.contains(target)) return;

  target.classList.add("active");
  AppState.currentScreen = screen;
  syncTrackScreenSubView(screen, trackSubView);

  if (
    !skipNavStack &&
    user &&
    fromScreen &&
    fromScreen !== screen &&
    !["auth", "splash"].includes(String(fromScreen)) &&
    !["auth", "splash"].includes(String(screen)) &&
    trackHistory &&
    !skipAuthenticatedHistory
  ) {
    const entry = { screen: fromScreen, trackSubView: fromTrackHistory ? "history" : undefined };
    const tail = navStack[navStack.length - 1];
    if (!tail || tail.screen !== entry.screen || tail.trackSubView !== entry.trackSubView) {
      while (navStack.length >= 40) navStack.shift();
      navStack.push(entry);
    }
  }

  if (trackHistory && AuthService.currentUser() && !skipAuthenticatedHistory) {
    HistoryGuard.push(screen);
  }
  syncBottomNav(user, screen);
  refreshUI();
  resetViewportScroll(target);
  if (screen === "admin" && apiMode && getToken()) {
    void syncFromServer().then(ok => {
      if (ok) refreshUI();
    });
  }
}

function navGoBack() {
  const user = AuthService.currentUser();
  if (!user) return;
  const home = RoleGuard.getHomeScreen(normalizeRole(user.role));
  if (navStack.length === 0) {
    goTo(home, { trackHistory: false, skipAuthenticatedHistory: true, skipNavStack: true });
    return;
  }
  const entry = navStack.pop();
  const prev = entry?.screen;
  if (!prev || !RoleGuard.canAccess(user.role, prev)) {
    goTo(home, { trackHistory: false, skipAuthenticatedHistory: true, skipNavStack: true });
    return;
  }
  const opts = {
    trackHistory: false,
    skipAuthenticatedHistory: true,
    skipNavStack: true
  };
  if (prev === "track" && entry.trackSubView === "history") opts.trackSubView = "history";
  goTo(prev, opts);
}

function initDashboardBackButtons() {
  const dash = document.getElementById("mount-dashboard-phase");
  if (!dash) return;
  dash.querySelectorAll("section.screen").forEach(section => {
    if (
      section.id === "screen-home" ||
      section.id === "screen-collector" ||
      section.id === "screen-collector-history" ||
      section.id === "screen-admin"
    )
      return;
    if (section.querySelector(".page-back-btn")) return;
    const profileIds = new Set(["screen-profile", "screen-collector-profile", "screen-admin-profile"]);
    if (profileIds.has(section.id)) {
      const hero = section.querySelector(".profile-hero");
      if (!hero) return;
      const row = document.createElement("div");
      row.className = "profile-back-row";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "page-back-btn page-back-btn--profile";
      btn.textContent = "← Back";
      btn.setAttribute("aria-label", "Go back");
      btn.addEventListener("click", () => navGoBack());
      row.appendChild(btn);
      section.insertBefore(row, hero);
      return;
    }
    const ph = section.querySelector(".page-header");
    if (!ph) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "page-back-btn";
    btn.textContent = "← Back";
    btn.setAttribute("aria-label", "Go back");
    btn.addEventListener("click", () => navGoBack());
    ph.insertBefore(btn, ph.firstChild);
  });
}

function syncBottomNav(user, screen) {
  const role = user ? normalizeRole(user.role) : null;
  const header = document.getElementById("top-nav");
  if (header) {
    const shouldHide = screen === "auth" || screen === "splash" || !user;
    header.hidden = shouldHide;
    header.setAttribute("aria-hidden", String(shouldHide));
  }
  document.querySelectorAll(".top-nav-item").forEach(btn => {
    const itemRole = btn.dataset.role || "household";
    const isRoleMatch = Boolean(role) && itemRole === role;
    btn.classList.toggle("hidden", !isRoleMatch);
    const action = btn.dataset.action || "";
    const targetScreen = btn.dataset.nav || "";
    const pickupTab = btn.dataset.collectorTab;
    let isActive = isRoleMatch && !action && targetScreen === screen;
    if (isActive && screen === "collector" && pickupTab !== undefined && pickupTab !== "") {
      const cur = AppState.collectorPickupTab === "verified" ? "verified" : "unverified";
      isActive = pickupTab === cur;
    }
    btn.classList.toggle("active", isActive);
  });
}

function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

function openLogModal() {
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "household") {
    showToast("Household login required.");
    return;
  }
  const modalDate = document.getElementById("modal-log-date");
  if (modalDate && !modalDate.value) {
    modalDate.value = todayInputValue();
  }
  document.getElementById("log-modal").classList.add("active");
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("active");
}

function updateQtyUI() {
  const qty = document.getElementById("qty-display");
  if (qty) qty.textContent = AppState.logQty.toFixed(1);
  const modalQty = document.getElementById("modal-qty");
  if (modalQty) modalQty.textContent = AppState.logQty.toFixed(1);
}

function setupWasteTypeSelectors() {
  const restrictChips = scopeSelector => {
    const chips = document.querySelectorAll(`${scopeSelector} .waste-chip`);
    chips.forEach(chip => {
      const type = chip.dataset.type;
      if (type === "bio") chip.textContent = "PET";
      if (type === "rec") chip.textContent = "HDPE";
      if (type === "res" || type === "spc") chip.style.display = "none";
    });
  };

  restrictChips("#manual-panel");
  restrictChips("#log-modal");

  const manualChips = document.querySelectorAll("#manual-panel .waste-chip");
  manualChips.forEach(chip => chip.classList.remove("active"));
  const defaultManual = document.querySelector("#manual-panel .waste-chip[data-type='bio']");
  if (defaultManual) defaultManual.classList.add("active");

  const modalChips = document.querySelectorAll("#log-modal .waste-chip");
  modalChips.forEach(chip => chip.classList.remove("active"));
  const defaultModal = document.querySelector("#log-modal .waste-chip[data-type='bio']");
  if (defaultModal) defaultModal.classList.add("active");

  AppState.logType = "bio";
}

function increaseQty() {
  AppState.logQty = Math.round((AppState.logQty + 0.1) * 10) / 10;
  updateQtyUI();
}

function decreaseQty() {
  AppState.logQty = Math.max(0.1, Math.round((AppState.logQty - 0.1) * 10) / 10);
  updateQtyUI();
}

function getManualInputWeight() {
  const qtyDisplay = document.getElementById("qty-display");
  const parsedQty = qtyDisplay ? Number.parseFloat(qtyDisplay.textContent) : AppState.logQty;
  return Number.isFinite(parsedQty) ? parsedQty : NaN;
}

function resolveLogDateValue() {
  const manualDate = document.getElementById("manual-log-date");
  const modalDate = document.getElementById("modal-log-date");
  const value = (modalDate?.value || manualDate?.value || "").trim();
  return value || todayInputValue();
}

function updatePhotoLabel(fileName) {
  const label = document.getElementById("manual-photo-label");
  if (!label) return;
  label.textContent = fileName ? `Selected: ${fileName}` : "Tap to add photo proof (JPG/PNG)";
}

async function readSelectedLogPhoto() {
  const manualInput = document.getElementById("manual-log-photo");
  const modalInput = document.getElementById("modal-log-photo");
  const file = (modalInput && modalInput.files && modalInput.files[0]) || (manualInput && manualInput.files && manualInput.files[0]) || null;
  if (!file) return { dataUrl: null, fileName: null };
  if (!["image/jpeg", "image/png"].includes(file.type)) {
    throw new Error("Only JPG and PNG images are allowed.");
  }
  if (file.size > 2 * 1024 * 1024) {
    throw new Error("Image size must be 2MB or less.");
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read selected image."));
    reader.readAsDataURL(file);
  });
  return { dataUrl, fileName: file.name };
}

function resetLogInputs() {
  const notesEl = document.querySelector("#manual-panel textarea");
  const manualDate = document.getElementById("manual-log-date");
  const modalDate = document.getElementById("modal-log-date");
  const manualPhoto = document.getElementById("manual-log-photo");
  const modalPhoto = document.getElementById("modal-log-photo");
  if (notesEl) notesEl.value = "";
  if (manualDate) manualDate.value = todayInputValue();
  if (modalDate) modalDate.value = todayInputValue();
  if (manualPhoto) manualPhoto.value = "";
  if (modalPhoto) modalPhoto.value = "";
  updatePhotoLabel("");
}

function cancelLogSubmission() {
  if (!window.confirm("Are you sure you want to cancel?")) return;
  resetLogInputs();
  closeModal("log-modal");
}

async function submitLog() {
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "household") {
    showToast("Only household users can submit logs.");
    return;
  }
  const weight = Number.isFinite(AppState.logQty) ? AppState.logQty : getManualInputWeight();
  const error = WasteLogService.validate(weight, AppState.logType, user);
  if (error) {
    showToast(error);
    return;
  }
  const notesEl = document.querySelector("#manual-panel textarea");
  const notes = notesEl ? notesEl.value.trim() : "";
  const logDate = resolveLogDateValue();
  let photoDataUrl = null;
  let photoFileName = null;
  try {
    const selected = await readSelectedLogPhoto();
    photoDataUrl = selected.dataUrl;
    photoFileName = selected.fileName;
  } catch (photoError) {
    showToast(photoError.message || "Invalid photo upload.");
    return;
  }

  if (apiMode && getToken()) {
    try {
      const payload = {
        wasteType: AppState.logType,
        weight,
        notes,
        logDate,
        photoDataUrl,
        photoFileName
      };
      const created = await apiFetch("/logs", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      closeModal("log-modal");
      openSuccessModal(created.log);
      resetLogInputs();
      await syncFromServer();
      refreshUI();
      return;
    } catch (e) {
      showToast(e.message || "Could not submit log.");
      return;
    }
  }
  const log = WasteLogService.createLog({
    user,
    rawType: AppState.logType,
    weight,
    logDate: new Date(logDate).toISOString(),
    photoPath: photoDataUrl || null
  });
  closeModal("log-modal");
  openSuccessModal(log);
  resetLogInputs();
  refreshUI();
}

function openSuccessModal(log) {
  const type = document.getElementById("success-type");
  const qty = document.getElementById("success-qty");
  const pts = document.getElementById("success-pts");
  if (type) type.textContent = log.type;
  if (qty) qty.textContent = `${log.weight} kg logged`;
  if (pts) pts.textContent = "Status: Pending";
  const modal = document.getElementById("success-modal");
  if (modal) modal.classList.add("active");
}

function renderRecentLogs() {
  const user = AuthService.currentUser();
  const mine = user ? wasteLogsForUser(user) : [];
  const recent = document.getElementById("recent-logs");
  if (recent) {
    if (!user || mine.length === 0) {
      recent.innerHTML = `<p style="font-size:0.88rem;color:var(--text-muted);margin:0">${NO_RECENT_ACTIVITY_TEXT}</p>`;
    } else {
      recent.innerHTML = mine.slice(0, 5).map(l => `
      <div class="card" style="margin-bottom:8px">
        <strong>${l.type}</strong><br/>
        ${l.weight} kg • <strong>${l.status}</strong><br/>
        <small>${formatDateTime(l.createdAt)}</small>
      </div>
    `).join("");
    }
  }
}

function renderNotifications() {
  const el = document.getElementById("notif-list");
  const historyEl = document.getElementById("activity-disposal-history");
  if (!el) return;
  const user = AuthService.currentUser();
  const rows = notificationsForUser(user).slice(0, 20);
  el.innerHTML = rows
    .map(
      n => `
    <div class="card">
      ${n.text}<br/>
      <small>${formatDateTime(n.createdAt || n.created_at)}</small>
    </div>
  `
    )
    .join("");

  if (historyEl) {
    const logs = user ? wasteLogsForUser(user) : [];
    if (!logs.length) {
      historyEl.innerHTML = `<p style="font-size:0.88rem;color:var(--text-muted);margin:0">${NO_RECENT_ACTIVITY_TEXT}</p>`;
    } else {
      historyEl.innerHTML = logs
        .slice()
        .sort((a, b) => logReferenceInstant(b).getTime() - logReferenceInstant(a).getTime())
        .map(
          l => `
      <div class="card" style="margin-bottom:8px">
        <strong>${l.type}</strong><br/>
        ${l.weight} kg • <strong>${l.status}</strong>
        ${l.status === "Completed" ? `• +${l.ecoPointsAwarded} pts` : ""}<br/>
        <small>${formatDateTime(l.createdAt)}</small>
      </div>
    `
        )
        .join("");
    }
  }
}

/** Dense ranking by EcoPoints: ties share a rank (1, 1, 2 …). */
function assignEcoPointsCompetitionRank(sortedHouseholds) {
  let rank = 1;
  return sortedHouseholds.map((u, i) => {
    const pts = Number(u.ecoPoints) || 0;
    if (i > 0 && pts !== (Number(sortedHouseholds[i - 1].ecoPoints) || 0)) rank += 1;
    return { ...u, ecoPoints: pts, ecoRank: rank };
  });
}

function computeHouseholdEcoPointsRank(user) {
  if (!user || normalizeRole(user.role) !== "household") return null;
  const sorted = AppState.users
    .filter(u => normalizeRole(u.role) === "household")
    .slice()
    .sort((a, b) => (Number(b.ecoPoints) || 0) - (Number(a.ecoPoints) || 0));
  const ranked = assignEcoPointsCompetitionRank(sorted);
  const mine = ranked.find(r => sameUserId(r.id, user.id));
  if (!mine) return null;
  return { rank: Number(mine.ecoRank) || 0, total: ranked.length, points: Number(mine.ecoPoints) || 0 };
}

function renderLeaderboard() {
  const sorted = AppState.users
    .filter(u => normalizeRole(u.role) === "household")
    .slice()
    .sort((a, b) => (Number(b.ecoPoints) || 0) - (Number(a.ecoPoints) || 0));

  const ranked = assignEcoPointsCompetitionRank(sorted).slice(0, 10);

  const lists = Array.from(document.querySelectorAll("[data-leaderboard-list]"));
  if (!lists.length) return;

  const html = ranked.length
    ? ranked
        .map(u => {
          const disposals = completedVerifiedDisposalCount(u.id);
          const kg = completedVerifiedDisposalKg(u.id);
          return `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px">
      <span style="min-width:0">
        <strong>#${u.ecoRank}</strong> ${u.name || "User"}
        <div style="font-size:0.78rem;color:var(--text-muted);margin-top:3px;line-height:1.25">
          ${disposals} verified disposal${disposals === 1 ? "" : "s"} · ${Number(kg).toFixed(1)} kg
        </div>
      </span>
      <strong style="flex-shrink:0">${u.ecoPoints} pts</strong>
    </div>`;
        })
        .join("")
    : `<p style="font-size:0.88rem;color:var(--text-muted);margin:0">No ranked households yet.</p>`;

  lists.forEach(el => {
    el.innerHTML = html;
  });
}

function renderProfile() {
  const user = AuthService.currentUser();
  const name = document.getElementById("profile-name");
  const profileAddress = document.getElementById("profile-brgy");
  const profileAvatar = document.getElementById("profile-avatar");
  const pts = document.getElementById("profile-pts");
  const totalLogs = document.getElementById("profile-total-logs");
  const badge = document.getElementById("eco-badge-pts");
  const logs = user && normalizeRole(user.role) === "household" ? wasteLogsForUser(user) : null;
  const eco = user ? Number(user.ecoPoints) || 0 : 0;
  const logCount = logs ? logs.length : 0;

  if (profileAvatar) profileAvatar.textContent = profileAvatarEmoji(user);
  if (name) name.textContent = user ? (user.name || "User") : "User";
  if (profileAddress) profileAddress.textContent = user ? getUserBarangayLabel(user) : NO_ADDRESS_LABEL;
  // Match dashboard #screen-home stats: EcoPoints and user's log count only.
  if (pts) pts.textContent = String(eco);
  if (totalLogs) totalLogs.textContent = logs !== null ? String(logCount) : "0";
  if (badge) badge.textContent = `⭐ ${eco} pts`;
  document.querySelectorAll("#screen-home .ecopoints-value, #screen-rewards .ecopoints-value").forEach(el => {
    el.textContent = eco;
  });
}

function renderHomeGreeting() {
  const greeting = document.getElementById("home-greeting-name");
  if (!greeting) return;
  const user = AuthService.currentUser();
  const name = user ? (user.name || "User") : (AppState.currentUserName || "User");
  greeting.textContent = `Hi, ${name} 👋`;
}

function renderUserAddress() {
  const user = AuthService.currentUser();
  const homeAddress = document.getElementById("home-user-address");
  if (homeAddress) {
    homeAddress.textContent = user ? getUserBarangayLabel(user) : NO_ADDRESS_LABEL;
  }
}

function renderHomeDisposalRank() {
  const el = document.getElementById("home-disposal-rank");
  if (!el) return;
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "household") {
    el.textContent = "";
    return;
  }
  const r = computeHouseholdEcoPointsRank(user);
  if (!r || r.rank == null || Number(r.total || 0) <= 0) {
    el.textContent = "Leaderboard rank Unranked";
    return;
  }
  el.textContent = `Leaderboard rank #${r.rank} of ${r.total} · ${r.points} pts`;
}

function renderRewardsBarangay() {
  const el = document.getElementById("rewards-rank-sub");
  if (!el) return;
  const user = AuthService.currentUser();
  const pts = user && normalizeRole(user.role) === "household" ? Number(user.ecoPoints) || 0 : 0;
  const peso = Math.max(0, Math.round(pts / 10));
  const brgy = user ? getUserBarangayLabel(user) : NO_ADDRESS_LABEL;
  const r = user && normalizeRole(user.role) === "household" ? computeHouseholdEcoPointsRank(user) : null;
  const rankBit = r && r.rank != null ? `Rank #${r.rank} of ${r.total}` : "Unranked";
  el.textContent = `≈ ₱${peso} value · ${brgy} · ${rankBit} 🏆`;
}

function goToRewardsLeaderboard() {
  goTo("rewards");
  // Ensure tab switch runs after rewards screen activation/render cycle.
  window.requestAnimationFrame(() => {
    const btn = document.querySelector("#screen-rewards .log-form-tabs .log-tab:nth-child(2)");
    if (typeof window.showRewardTab === "function") window.showRewardTab("leaderboard-tab", btn || undefined);
  });
}

function setCollectorPickupTab(tab) {
  AppState.collectorPickupTab = tab === "verified" ? "verified" : "unverified";
  const sec = document.getElementById("screen-collector");
  if (sec) {
    sec.querySelectorAll(".collector-pickup-tabs .log-tab").forEach(b => {
      const t = b.dataset.collectorTab === "verified" ? "verified" : "unverified";
      b.classList.toggle("active", t === AppState.collectorPickupTab);
    });
  }
  const user = AuthService.currentUser();
  syncBottomNav(user, AppState.currentScreen);
  renderCollectorView();
}

function renderCollectorView() {
  const list = document.getElementById("pickup-list");
  const listVerified = document.getElementById("pickup-list-verified");
  const panelU = document.getElementById("collector-panel-unverified");
  const panelV = document.getElementById("collector-panel-verified");
  if (!list || !listVerified) return;

  const tab = AppState.collectorPickupTab === "verified" ? "verified" : "unverified";
  if (panelU) panelU.hidden = tab !== "unverified";
  if (panelV) panelV.hidden = tab !== "verified";

  const sec = document.getElementById("screen-collector");
  if (sec) {
    sec.querySelectorAll(".collector-pickup-tabs .log-tab").forEach(b => {
      const t = b.dataset.collectorTab === "verified" ? "verified" : "unverified";
      b.classList.toggle("active", t === tab);
    });
  }

  const year = new Date().getFullYear();
  const yearEl = document.getElementById("collector-inline-verified-year");
  if (yearEl) yearEl.textContent = String(year);

  const stats = computeCollectorDashboardStats(AppState.logs);
  const yLogs = collectorYearlyLogs(AppState.logs, year);
  const active = yLogs
    .filter(l => l.status === "Pending")
    .slice()
    .sort((a, b) => logReferenceInstant(b).getTime() - logReferenceInstant(a).getTime());
  list.innerHTML = active.length
    ? active
        .map(
          log => `
    <div class="card" style="margin-bottom:10px">
      <strong>${log.userName}</strong> • ${log.type} • ${log.weight} kg<br/>
      <small>Pending · ${logCalendarYear(log)}</small>
      ${collectorProofMarkup(log)}
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-primary" onclick="handleCollectorDecision('${log.id}',true)">Verify</button>
      </div>
    </div>
  `
        )
        .join("")
    : `<p style="font-size:0.88rem;color:var(--text-muted);margin:0">No unverified pickups for ${year}. Verified logs appear in the Verified tab.</p>`;

  const verifiedSorted = sortedVerifiedLogsYear(AppState.logs, year);
  listVerified.innerHTML = verifiedSorted.length
    ? verifiedSorted.map(l => htmlVerifiedLogCardReadOnly(l)).join("")
    : `<p style="font-size:0.88rem;color:var(--text-muted);margin:0">No verified logs for ${year} yet.</p>`;

  const statValues = document.querySelectorAll("#screen-collector .stat-value");
  if (statValues[0]) statValues[0].textContent = stats.verifiedCount;
  if (statValues[1]) statValues[1].textContent = stats.pending;
}

async function handleCollectorDecision(logId, isVerified) {
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "collector") {
    showToast("Collector login required.");
    return;
  }
  if (apiMode && getToken()) {
    try {
      await apiFetch(`/logs/${encodeURIComponent(logId)}/verify`, {
        method: "PATCH",
        body: JSON.stringify({ approve: Boolean(isVerified) })
      });
      await syncFromServer();
      showToast(
        isVerified
          ? "Verified — log is on the Verified tab."
          : "Marked as not segregated — stays on Unverified until resolved."
      );
      refreshUI();
      return;
    } catch (e) {
      showToast(e.message || "Verification failed.");
      return;
    }
  }
  const updated = VerificationService.verifyLog(
    logId,
    isVerified,
    user.id,
    user.name || user.email || ""
  );
  if (!updated) {
    showToast("Log not found.");
    return;
  }
  showToast(
    isVerified
      ? "Verified — log is on the Verified tab."
      : "Marked as not segregated — stays on Unverified until resolved."
  );
  refreshUI();
}

function adminWasteLogStatusLabel(log) {
  if (log.status === "Completed") return "Verified";
  if (log.status === "Rejected") return "Not segregated";
  return "Pending pickup";
}

function renderAdminDashboardHeader() {
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "admin") return;
  const loc = document.getElementById("admin-dashboard-location");
  if (loc) loc.textContent = getUserBarangayLabel(user);
  const line = document.getElementById("admin-dashboard-address-line");
  if (line) {
    const addr = String(user.address || "").trim();
    if (addr) {
      line.textContent = addr;
      line.hidden = false;
    } else {
      line.textContent = "";
      line.hidden = true;
    }
  }
}

function renderAdminProfileScreen() {
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "admin") return;
  const nm = document.getElementById("admin-profile-name");
  const roleLine = document.getElementById("admin-profile-role-line");
  const addrEl = document.getElementById("admin-profile-address-line");
  const br = getUserBarangayLabel(user);
  if (nm) nm.textContent = user.name || "Administrator";
  if (roleLine) roleLine.textContent = `Barangay Admin · ${br}`;
  if (addrEl) {
    const raw = String(user.address || "").trim();
    addrEl.innerHTML = `<strong>Address / barangay:</strong> ${raw || br || "—"}`;
  }
}

/** Read-only mirror of all household logs — same records collectors verify (GET /logs for admin). */
function renderAdminWasteLogs() {
  const el = document.getElementById("admin-waste-logs-list");
  if (!el) return;
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "admin") {
    el.innerHTML = "";
    return;
  }
  const logs = (AppState.logs || [])
    .slice()
    .sort((a, b) => logReferenceInstant(b).getTime() - logReferenceInstant(a).getTime());
  if (!logs.length) {
    el.innerHTML = `<p style="font-size:0.88rem;color:var(--text-muted);margin:0">No waste logs yet.</p>`;
    return;
  }
  el.innerHTML = logs
    .map(log => {
      const st = adminWasteLogStatusLabel(log);
      const verifier =
        log.status === "Completed" && log.verifiedBy ? ` · Collector ${log.verifiedBy}` : "";
      const pts = log.ecoPointsAwarded ? ` · +${log.ecoPointsAwarded} pts` : "";
      return `
    <div class="card" style="margin-bottom:8px">
      <strong>${log.userName}</strong> · ${log.type} · ${log.weight} kg<br/>
      <small>Status: <strong>${st}</strong> · ${formatDateTime(log.createdAt)}${pts}${verifier}</small>
    </div>`;
    })
    .join("");
}

function renderAdminAnalytics() {
  renderAdminDashboardHeader();
  if (apiMode && adminAnalyticsCache && adminAnalyticsCache.metrics) {
    const m = adminAnalyticsCache.metrics;
    const kpis = document.querySelectorAll("#screen-admin .kpi-card .kpi-value");
    if (kpis[0]) kpis[0].textContent = `${m.totalCollectedKg} kg`;
    if (kpis[1]) kpis[1].textContent = `${m.compliance}%`;
    if (kpis[2]) kpis[2].textContent = `${m.recyclingRate}%`;
    if (kpis[3]) kpis[3].textContent = `${m.activeUsers}`;

    const pointsVal = document.getElementById("admin-ecopoints-value");
    if (pointsVal) pointsVal.textContent = `${Number(m.ecoPointsDistributed || 0).toLocaleString()}`;
    const pointsSub = document.getElementById("admin-ecopoints-sub");
    if (pointsSub) {
      pointsSub.textContent = `EcoPoints awarded on verified pickups · ${Number(m.activeUsers || 0).toLocaleString()} active accounts (households & collectors)`;
    }

    const adminUsers = document.getElementById("admin-users");
    if (adminUsers && adminAnalyticsCache.topHouseholds) {
      adminUsers.innerHTML = adminAnalyticsCache.topHouseholds
        .map(
          u => `
      <div class="card" style="display:flex;justify-content:space-between">
        <span>
          <strong>#${u.rank ?? "—"}</strong> ${u.name || "—"}<br/>
          <small style="color:var(--text-muted)">
            ${u.email ? u.email : ""}${u.barangay ? (u.email ? " · " : "") + u.barangay : ""}
          </small>
        </span>
        <strong>${Number(u.ecoPoints ?? u.pts ?? 0)} pts</strong>
      </div>
    `
        )
        .join("");
    }

    const chart = document.getElementById("admin-chart");
    if (chart && adminAnalyticsCache.weeklyChart) {
      const data = adminAnalyticsCache.weeklyChart;
      const max = Math.max(...data.map(d => d.val), 1);
      chart.innerHTML = data
        .map(
          d => `
      <div class="chart-col">
        <div class="chart-val">${d.val}</div>
        <div class="chart-bar" style="height:${(d.val / max) * 80}px"></div>
        <div class="chart-label">${d.day}</div>
      </div>
    `
        )
        .join("");
    }
    const foot = document.getElementById("admin-chart-footnote");
    if (foot) {
      const u = AuthService.currentUser();
      foot.textContent = `${adminAnalyticsCache.weekRangeLabel || AnalyticsService.rollingWeekCaption()} · ${getUserBarangayLabel(u)}`;
    }
    return;
  }

  const metrics = AnalyticsService.metrics();
  const kpis = document.querySelectorAll("#screen-admin .kpi-card .kpi-value");
  if (kpis[0]) kpis[0].textContent = `${metrics.totalCollectedKg} kg`;
  if (kpis[1]) kpis[1].textContent = `${metrics.compliance}%`;
  if (kpis[2]) kpis[2].textContent = `${metrics.recyclingRate}%`;
  if (kpis[3]) kpis[3].textContent = `${metrics.activeUsers}`;

  const pointsValLoc = document.getElementById("admin-ecopoints-value");
  if (pointsValLoc) pointsValLoc.textContent = `${metrics.ecoPointsDistributed.toLocaleString()}`;
  const pointsSubLoc = document.getElementById("admin-ecopoints-sub");
  if (pointsSubLoc) {
    pointsSubLoc.textContent = `EcoPoints awarded on verified pickups · ${metrics.activeUsers} active accounts (households & collectors)`;
  }

  const adminUsers = document.getElementById("admin-users");
  if (adminUsers) {
    const ranked = AppState.users
      .filter(u => normalizeRole(u.role) === "household")
      .slice()
      .sort((a, b) => b.ecoPoints - a.ecoPoints)
      .slice(0, 5);
    adminUsers.innerHTML = ranked.map((u, i) => `
      <div class="card" style="display:flex;justify-content:space-between">
        <span>#${i + 1} ${u.name}</span>
        <strong>${u.ecoPoints} pts</strong>
      </div>
    `).join("");
  }

  const chart = document.getElementById("admin-chart");
  if (chart) {
    const data = AnalyticsService.weeklySeries();
    const max = Math.max(...data.map(d => d.val), 1);
    chart.innerHTML = data.map(d => `
      <div class="chart-col">
        <div class="chart-val">${d.val}</div>
        <div class="chart-bar" style="height:${(d.val / max) * 80}px"></div>
        <div class="chart-label">${d.day}</div>
      </div>
    `).join("");
  }
  const footLoc = document.getElementById("admin-chart-footnote");
  if (footLoc) {
    const u = AuthService.currentUser();
    footLoc.textContent = `${AnalyticsService.rollingWeekCaption()} · ${getUserBarangayLabel(u)}`;
  }
}

function initGuide() {
  const el = document.getElementById("guide-items");
  if (!el) return;

  const PET = [
    "Soft drink bottles (Coke, Pepsi, etc.)",
    "Bottled water containers",
    "Energy drink bottles",
    "Cooking oil bottles",
    "Food-grade transparent containers",
    "Salad dressing bottles",
    "Peanut butter jars (PET type only)",
    "Juice bottles (clear plastic type)",
    "Disposable drink cups (PET plastic cups)",
    "Food packaging trays (clear PET type)",
    "Medicine syrup bottles (PET type)",
    "Single-use plastic beverage bottles"
  ];

  const HDPE = [
    "Milk jugs and juice bottles",
    "Shampoo and conditioner bottles",
    "Dishwashing liquid containers",
    "Laundry detergent bottles",
    "Bleach containers",
    "Household cleaning product bottles",
    "Plastic buckets and pails (HDPE type)",
    "Grocery bags (HDPE plastic bags)",
    "Plastic toys (hard plastic, HDPE type)",
    "Pipe and plumbing materials (HDPE pipes)",
    "Storage containers and jerry cans",
    "Cosmetic bottles (non-aerosol HDPE type)"
  ];

  const renderSection = (title, codeLabel, codeClass, items) => `
    <div class="card bb-guide-section">
      <div class="bb-guide-title-row">
        <div class="bb-guide-title">${title}</div>
        <div class="bb-guide-code ${codeClass}">${codeLabel}</div>
      </div>
      <div class="bb-guide-grid">
        ${items
          .map(
            (t) => `
          <div class="bb-guide-chip">
            ${t}
          </div>
        `
          )
          .join("")}
      </div>
    </div>
  `;

  el.innerHTML =
    renderSection("PET (Polyethylene Terephthalate)", "Code 1 · PET", "pet", PET) +
    renderSection("HDPE (High-Density Polyethylene)", "Code 2 · HDPE", "hdpe", HDPE);
}

function initRecyclableChecker() {
  const input = document.getElementById("checker-input");
  const btn = document.getElementById("btn-check-waste");
  const out = document.getElementById("checker-result");
  if (!input || !btn || !out) return;

  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const hasAny = (text, words) => words.some((w) => text.includes(w));
  const uniq = (arr) => Array.from(new Set(arr));

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a) return b.length;
    if (!b) return a.length;
    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[m][n];
  }

  function fuzzyTokenScore(token, keyword) {
    if (!token || !keyword) return 0;
    if (token === keyword) return 6;
    if (keyword.includes(token) && token.length >= 3) return 4; // partial input: "styro" in "styrofoam"
    if (token.includes(keyword) && keyword.length >= 3) return 3; // phrase contains keyword
    if (token.length >= 4 && keyword.length >= 4 && levenshtein(token, keyword) <= 1) return 2; // basic typo tolerance
    return 0;
  }

  function phraseScore(qTokens, keywords) {
    let score = 0;
    for (const kw of keywords) {
      const kwNorm = norm(kw);
      const kwTokens = kwNorm.split(" ").filter(Boolean);
      if (kwTokens.length > 1) {
        // multi-word keyword: match across phrase
        const hit = kwTokens.every((t) => qTokens.some((qt) => fuzzyTokenScore(qt, t) > 0));
        if (hit) score += 4;
        continue;
      }
      const t = kwTokens[0];
      if (!t) continue;
      const best = Math.max(...qTokens.map((qt) => fuzzyTokenScore(qt, t)));
      score += best;
    }
    return score;
  }

  const NOT_REC = [
    { label: "Styrofoam", keys: ["styrofoam", "styro", "polystyrene", "foam"] },
    { label: "Sachet / multilayer", keys: ["sachet", "laminated", "multi layer", "multilayer", "foil pack"] },
    { label: "Tissue / napkin", keys: ["tissue", "napkin", "toilet paper"] },
    { label: "Food waste", keys: ["food waste", "leftover", "banana peel", "fruit peel"] },
    { label: "Contaminated paper cup", keys: ["paper cup", "coffee cup", "tea cup"] },
    { label: "Plastic straw / utensils", keys: ["straw", "spoon", "fork", "plastic utensil", "cutlery"] },
    { label: "Diapers / sanitary", keys: ["diaper", "sanitary", "pad"] }
  ];

  // Keyword sets include short inputs and common variants.
  const PET_KEYS = [
    "coke",
    "pepsi",
    "soda",
    "soft drink",
    "cola",
    "bottled water",
    "water",
    "water bottle",
    "energy drink",
    "gatorade",
    "sports drink",
    "cooking oil",
    "oil bottle",
    "salad dressing",
    "syrup bottle",
    "medicine syrup",
    "clear bottle",
    "transparent container",
    "pet bottle",
    "bottle",
    "drink",
    "drink cup",
    "clear tray",
    "food tray",
    "juice bottle"
  ];

  const HDPE_KEYS = [
    "shampoo",
    "conditioner",
    "dishwashing",
    "dish soap",
    "soap",
    "laundry",
    "detergent",
    "bleach",
    "gallon",
    "cleaning product",
    "milk jug",
    "jug",
    "jerry can",
    "bucket",
    "pail",
    "pipe",
    "plumbing",
    "toy",
    "grocery bag",
    "hdpe bag",
    "storage container",
    "container",
    "cosmetic bottle"
  ];

  function classify(raw) {
    const q = norm(raw);
    if (!q) return { kind: "empty" };
    if (q.length < 3) return { kind: "vague" };

    const qTokens = uniq(q.split(" ").filter(Boolean));
    const meaningful = qTokens.filter((t) => t.length >= 3);
    if (meaningful.length === 0) return { kind: "vague" };

    // Try non-recyclable first (stronger / safer).
    const notScores = NOT_REC.map((r) => ({
      label: r.label,
      score: phraseScore(meaningful, r.keys)
    })).sort((a, b) => b.score - a.score);
    if (notScores[0] && notScores[0].score >= 4) return { kind: "not", label: notScores[0].label };

    // Category scores (fuzzy / partial / light typo tolerance).
    let petScore = phraseScore(meaningful, PET_KEYS);
    let hdpeScore = phraseScore(meaningful, HDPE_KEYS);

    // Heuristic: if query mentions cleaning-related words, prefer HDPE; beverage-related, prefer PET.
    const beverageBoost = hasAny(q, ["coke", "pepsi", "cola", "soda", "juice", "water", "drink"]) ? 2 : 0;
    const cleaningBoost = hasAny(q, ["shampoo", "detergent", "bleach", "soap", "laundry", "dish"]) ? 2 : 0;
    petScore += beverageBoost;
    hdpeScore += cleaningBoost;

    if (petScore === 0 && hdpeScore === 0) return { kind: "unknown" };
    if (petScore === hdpeScore) {
      // If only "bottle" / "plastic" appears, ask for more detail.
      const generic = hasAny(q, ["plastic", "bottle", "container"]);
      if (generic && meaningful.length === 1) return { kind: "vague" };
      return { kind: "pet" };
    }
    return petScore > hdpeScore ? { kind: "pet" } : { kind: "hdpe" };
  }

  function render(raw) {
    const q = String(raw || "").trim();
    const res = classify(q);
    if (!q) {
      out.innerHTML = "";
      return;
    }

    if (res.kind === "vague") {
      out.innerHTML = `
        <div class="bb-classify">
          <div class="bb-classify-left"><strong>Try a more specific keyword.</strong> Example: "coke", "shampoo", "styro".</div>
          <div class="bb-pill not">Too vague</div>
        </div>
      `;
      return;
    }

    if (res.kind === "unknown") {
      out.innerHTML = `
        <div class="bb-classify">
          <div class="bb-classify-left"><strong>Item not recognized.</strong> Please try a more specific keyword.</div>
          <div class="bb-pill not">Unknown</div>
        </div>
      `;
      return;
    }

    if (res.kind === "not") {
      out.innerHTML = `
        <div class="bb-classify">
          <div class="bb-classify-left"><strong>${q}</strong> → Not Recyclable</div>
          <div class="bb-pill not">Not recyclable</div>
        </div>
      `;
      return;
    }

    if (res.kind === "pet") {
      out.innerHTML = `
        <div class="bb-classify">
          <div class="bb-classify-left"><strong>${q}</strong> → PET (Recyclable)</div>
          <div style="display:flex;gap:8px;align-items:center">
            <div class="bb-pill recyclable">Recyclable</div>
            <div class="bb-pill pet">PET</div>
          </div>
        </div>
      `;
      return;
    }

    out.innerHTML = `
      <div class="bb-classify">
        <div class="bb-classify-left"><strong>${q}</strong> → HDPE (Recyclable)</div>
        <div style="display:flex;gap:8px;align-items:center">
          <div class="bb-pill recyclable">Recyclable</div>
          <div class="bb-pill hdpe">HDPE</div>
        </div>
      </div>
    `;
  }

  let t = null;
  const schedule = () => {
    if (t) window.clearTimeout(t);
    t = window.setTimeout(() => render(input.value), 120);
  };

  input.addEventListener("input", schedule);
  btn.addEventListener("click", () => render(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      render(input.value);
    }
  });
}

function escapeAdminText(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Household reward picker + QR panel */
let rewardSubmissionSelection = null;
let rewardSubmissionFile = null;
let rewardPreviewObjectUrl = null;

function revokeRewardPreviewUrl() {
  if (rewardPreviewObjectUrl) {
    URL.revokeObjectURL(rewardPreviewObjectUrl);
    rewardPreviewObjectUrl = null;
  }
}

function setRewardSubmissionPanelVisible(show) {
  const panel = document.getElementById("reward-submit-panel");
  if (!panel) return;
  panel.classList.toggle("hidden", !show);
}

function resetRewardSubmissionFormOnly() {
  const fi = document.getElementById("reward-qr-photo-input");
  const prevWrap = document.getElementById("reward-photo-preview-wrap");
  const prevImg = document.getElementById("reward-photo-preview");
  const nameEl = document.getElementById("reward-photo-filename");
  const sendBtn = document.getElementById("reward-submit-send-btn");
  if (fi) fi.value = "";
  revokeRewardPreviewUrl();
  rewardSubmissionFile = null;
  if (prevWrap) prevWrap.classList.add("hidden");
  if (prevImg) prevImg.removeAttribute("src");
  if (nameEl) nameEl.textContent = "";
  if (sendBtn) sendBtn.disabled = true;
}

function showRewardSubmissionSuccess() {
  document.getElementById("reward-submit-form-block")?.classList.add("hidden");
  document.getElementById("reward-submit-success-block")?.classList.remove("hidden");
  document.getElementById("reward-submit-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function restoreRewardSubmissionFormLayout() {
  document.getElementById("reward-submit-form-block")?.classList.remove("hidden");
  document.getElementById("reward-submit-success-block")?.classList.add("hidden");
}

/** Choose a catalog reward — opens submission section beneath the grid. */
function beginRewardSubmission(reward) {
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "household") {
    showToast("Only household users can redeem rewards.");
    return;
  }
  if (!reward || !reward.id) return;
  restoreRewardSubmissionFormLayout();
  rewardSubmissionSelection = { id: reward.id, display: reward.display, cost: reward.cost };

  const summary = document.getElementById("reward-submit-selected");
  if (summary) {
    summary.textContent = `You chose: ${String(reward.display)} · ${Number(reward.cost) || 0} EcoPoints. Add your QR photo below, then tap Send.`;
  }
  resetRewardSubmissionFormOnly();

  const catalogPanel = document.getElementById("panel-catalog");
  if (catalogPanel?.classList.contains("hidden") && typeof window.showRewardTab === "function") {
    const catTab = document.querySelector("#screen-rewards .log-form-tabs .log-tab");
    window.showRewardTab("catalog", catTab || undefined);
  }
  setRewardSubmissionPanelVisible(true);
  window.requestAnimationFrame(() => {
    document.getElementById("reward-submit-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

function cancelRewardSubmission() {
  rewardSubmissionSelection = null;
  resetRewardSubmissionFormOnly();
  restoreRewardSubmissionFormLayout();
  setRewardSubmissionPanelVisible(false);
}

function rewardSubmissionDone() {
  cancelRewardSubmission();
}

let rewardRewardsFlowWiredOnce = false;
function wireRewardSubmissionFlowOnce() {
  if (rewardRewardsFlowWiredOnce) return;
  rewardRewardsFlowWiredOnce = true;

  const fi = document.getElementById("reward-qr-photo-input");
  fi?.addEventListener("change", () => {
    revokeRewardPreviewUrl();
    rewardSubmissionFile = fi.files?.[0] || null;
    const nameEl = document.getElementById("reward-photo-filename");
    const sendBtn = document.getElementById("reward-submit-send-btn");
    const prevWrap = document.getElementById("reward-photo-preview-wrap");
    const prevImg = document.getElementById("reward-photo-preview");
    if (!rewardSubmissionFile) {
      resetRewardSubmissionFormOnly();
      return;
    }
    if (nameEl) nameEl.textContent = rewardSubmissionFile.name || "Photo selected";
    if (rewardSubmissionFile.type && !/^image\//i.test(rewardSubmissionFile.type)) {
      showToast("Please choose an image file.");
      resetRewardSubmissionFormOnly();
      return;
    }
    rewardPreviewObjectUrl = URL.createObjectURL(rewardSubmissionFile);
    if (prevImg) prevImg.src = rewardPreviewObjectUrl;
    if (prevWrap) prevWrap.classList.remove("hidden");
    if (sendBtn) sendBtn.disabled = false;
  });

  document.getElementById("reward-submit-send-btn")?.addEventListener("click", async () => {
    const user = AuthService.currentUser();
    if (!user || normalizeRole(user.role) !== "household") {
      showToast("Only household users can redeem rewards.");
      return;
    }
    if (!rewardSubmissionSelection || !rewardSubmissionFile) {
      showToast("Choose a reward and a QR photo first.");
      return;
    }
    const sendBtn = document.getElementById("reward-submit-send-btn");
    if (sendBtn) sendBtn.disabled = true;
    const res = await submitRewardRedemptionWithPhoto(rewardSubmissionSelection.id, rewardSubmissionFile, {
      suppressSuccessToast: true
    });
    if (!res?.ok && sendBtn) sendBtn.disabled = false;
    if (res?.ok) showRewardSubmissionSuccess();
  });

  document.getElementById("reward-submit-cancel-btn")?.addEventListener("click", () => cancelRewardSubmission());
  document.getElementById("reward-submit-done-btn")?.addEventListener("click", () => rewardSubmissionDone());
}

async function submitRewardRedemptionWithPhoto(rewardId, file, opts = {}) {
  const suppressSuccessToast = Boolean(opts.suppressSuccessToast);
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "household") {
    showToast("Only household users can redeem rewards.");
    return { ok: false };
  }
  if (apiMode && getToken()) {
    try {
      const fd = new FormData();
      fd.append("rewardId", rewardId);
      fd.append("photo", file, file.name || "qr.jpg");
      const data = await apiFetchMultipart("/rewards/redeem", fd);
      await syncFromServer();
      if (!suppressSuccessToast) {
        showToast(`Sent · ${data.reward?.display ?? "Reward"} · ${Number(data.reward?.cost || 0)} pts deducted`);
      }
      refreshUI();
      return { ok: true, data };
    } catch (e) {
      showToast(e.message || "Could not submit redemption.");
      return { ok: false };
    }
  }
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = RewardsService.redeem(rewardId, user, reader.result);
      if (!result.ok) {
        showToast(result.message);
        resolve({ ok: false });
        return;
      }
      if (!suppressSuccessToast) showToast(`Submitted (offline demo) · ${result.reward.display}`);
      persistState();
      refreshUI();
      resolve({ ok: true });
    };
    reader.onerror = () => {
      showToast("Could not read the image.");
      resolve({ ok: false });
    };
    reader.readAsDataURL(file);
  });
}

async function renderAdminRewardQueue() {
  const wrap = document.getElementById("admin-reward-queue");
  if (!wrap) return;
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "admin") {
    wrap.innerHTML = "";
    wrap.onclick = null;
    return;
  }
  if (apiMode && getToken()) {
    try {
      const data = await apiFetch("/admin/reward-redemptions");
      const rows = data.requests || [];
      wrap.innerHTML =
        `<div class="section-title" style="margin-top:16px">🎁 Reward requests (QR photos)</div>` +
        "<p style=\"font-size:0.82rem;color:var(--text-muted);margin:0 0 12px\">Households attach a QR image; download and fulfill outside the app.</p>" +
        (rows.length
          ? rows
              .map(
                r => `
        <div class="card" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
          <div style="min-width:0">
            <strong>${escapeAdminText(r.userName || "User")}</strong>
            <small style="display:block;color:var(--text-muted)">${escapeAdminText(r.rewardDisplay || "")} · ${Number(r.cost || 0)} pts · ID ${escapeAdminText(r.id)}</small>
            <small style="display:block;color:var(--text-muted)">${escapeAdminText(formatDateTime(r.createdAt))}</small>
          </div>
          <button type="button" class="btn btn-outline" style="flex-shrink:0" data-rdm-dl="${escapeAdminText(r.id)}">⬇️ Download QR photo</button>
        </div>`
              )
              .join("")
          : `<p style="font-size:0.88rem;color:var(--text-muted);margin:0">No reward requests yet.</p>`);
      wrap.onclick = e => {
        const btn = e.target.closest("[data-rdm-dl]");
        if (!btn) return;
        void downloadAdminRewardRedemptionPhoto(btn.getAttribute("data-rdm-dl"));
      };
    } catch (_e) {
      wrap.innerHTML = `<p style="font-size:0.88rem;color:var(--text-muted)">Could not load reward requests.</p>`;
      wrap.onclick = null;
    }
    return;
  }
  const rows = AppState.rewardQrSubmissions || [];
  wrap.innerHTML =
    `<div class="section-title" style="margin-top:16px">🎁 Reward requests (QR · offline demo)</div>` +
    (rows.length
      ? rows
          .map(
            r => `
    <div class="card" style="margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
      <div style="min-width:0">
        <strong>${escapeAdminText(r.userName || "User")}</strong>
        <small style="display:block;color:var(--text-muted)">${escapeAdminText(r.rewardDisplay || "")} · ${Number(r.cost || 0)} pts</small>
        <small style="display:block;color:var(--text-muted)">${escapeAdminText(formatDateTime(r.createdAt))}</small>
      </div>
      <a class="btn btn-outline" style="flex-shrink:0;text-decoration:none" download="qr-${escapeAdminText(String(r.id).replace(/[^\w-]+/g, "_"))}.jpg" href="${String(r.qrDataUrl || "").replace(/&/g, "&amp;")}">⬇️ Download QR photo</a>
    </div>`
          )
          .join("")
      : `<p style="font-size:0.88rem;color:var(--text-muted);margin:0">No reward requests yet.</p>`);
  wrap.onclick = null;
}

async function downloadAdminRewardRedemptionPhoto(id) {
  if (!id || !getToken()) {
    showToast("Login required.");
    return;
  }
  try {
    const base = await getApiBase();
    const res = await fetch(`${base}/admin/reward-redemptions/${encodeURIComponent(id)}/photo`, {
      headers: { Authorization: `Bearer ${getToken()}` }
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      showToast(j.message || "Download failed.");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    let name = `redemption-${id}.jpg`;
    const cd = res.headers.get("Content-Disposition") || "";
    const m = /filename\*=UTF-8''([^;\n]+)|filename="([^"]+)"/i.exec(cd);
    const raw = m ? decodeURIComponent((m[1] || m[2] || "").trim()) : "";
    if (raw) name = raw;
    a.download = name.replace(/[/\\?%*:|"<>]/g, "_");
    a.click();
    URL.revokeObjectURL(url);
  } catch (_e) {
    showToast("Download failed.");
  }
}

function bindRewardCatalogPickButtons(grid, catalog) {
  if (!grid || !catalog?.length) return;
  const buttons = grid.querySelectorAll("button.bb-reward-pick");
  buttons.forEach((btn, idx) => {
    const reward = catalog[idx];
    if (!reward) return;
    btn.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      beginRewardSubmission({
        id: reward.id,
        display: String(reward.display),
        cost: Number(reward.cost) || 0
      });
    });
  });
}

function initRewards() {
  renderRewardsBarangay();
  wireRewardSubmissionFlowOnce();
  const grid = document.getElementById("rewards-grid");
  if (!grid) return;
  const paint = catalog => {
    grid.innerHTML = catalog
      .map(
        r => `
    <div class="card bb-reward-row" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <div><strong>${escapeAdminText(r.display)}</strong><br/><small>${Number(r.cost) || 0} pts</small></div>
      <button type="button" class="btn btn-primary bb-reward-pick">Redeem with QR photo</button>
    </div>
  `
      )
      .join("");
    bindRewardCatalogPickButtons(grid, catalog);
  };
  if (apiMode && getToken()) {
    apiFetch("/rewards")
      .then(res => {
        paint(
          (res.rewards || []).map(r => ({
            id: r.id,
            display: r.display,
            cost: r.cost
          }))
        );
      })
      .catch(() => paint(RewardsService.catalog()));
    return;
  }
  paint(RewardsService.catalog());
}

function initAuth() {
  const loginBtn = document.getElementById("btn-login");
  const authForm = document.getElementById("auth-form");
  const authTabs = document.querySelectorAll(".auth-tab");
  const roleCards = document.querySelectorAll(".role-card");
  const authPrimaryButton = document.getElementById("btn-login");
  const screenAuth = document.getElementById("screen-auth");
  const connCheckBtn = document.getElementById("btn-conn-check");
  const connResetBtn = document.getElementById("btn-conn-reset");
  const connStatus = document.getElementById("auth-conn-status");
  const emailInput = document.getElementById("auth-email");
  const passwordInput = document.getElementById("auth-password");
  const passwordToggleBtn = document.getElementById("auth-password-toggle");
  const phoneInput = document.getElementById("auth-phone-number");
  const addressInput = document.getElementById("auth-address");
  const genderInput = document.getElementById("auth-gender");
  const emailError = document.getElementById("auth-email-error");
  const passwordError = document.getElementById("auth-password-error");
  const phoneError = document.getElementById("auth-phone-number-error");
  const addressError = document.getElementById("auth-address-error");
  const genderError = document.getElementById("auth-gender-error");
  let authSubmitInFlight = false;

  const defaultSubmitLabel = () =>
    AppState.authMode === "register" ? "Create BinBuddy Account" : "Login to BinBuddy";

  const setAuthSubmitBusy = (busy, mode = AppState.authMode) => {
    const b = Boolean(busy);
    if (!authPrimaryButton) return;
    authPrimaryButton.disabled = b;
    authPrimaryButton.setAttribute("aria-busy", b ? "true" : "false");
    authPrimaryButton.textContent = b
      ? mode === "register"
        ? "Creating account…"
        : "Signing in…"
      : defaultSubmitLabel();
  };

  const setFieldError = (inputEl, errorEl, message) => {
    if (!inputEl || !errorEl) return;
    const text = message ? String(message).trim() : "";
    errorEl.textContent = text;
    inputEl.classList.toggle("is-invalid", Boolean(text));
  };

  const clearInlineErrors = () => {
    setFieldError(emailInput, emailError, "");
    setFieldError(passwordInput, passwordError, "");
    setFieldError(phoneInput, phoneError, "");
    setFieldError(addressInput, addressError, "");
    setFieldError(genderInput, genderError, "");
  };

  const syncPasswordAutocomplete = () => {
    if (passwordInput)
      passwordInput.setAttribute(
        "autocomplete",
        AppState.authMode === "register" ? "new-password" : "current-password"
      );
  };

  const syncAuthModeChrome = () => {
    if (screenAuth) screenAuth.classList.toggle("auth-mode-register", AppState.authMode === "register");
    syncPasswordAutocomplete();
  };

  const clearAuthFields = () => {
    if (emailInput) emailInput.value = "";
    if (passwordInput) passwordInput.value = "";
    if (phoneInput) phoneInput.value = "";
    if (addressInput) addressInput.value = "";
    if (genderInput) genderInput.value = "";
  };
  const focusAuthEmail = () => {
    if (emailInput) emailInput.focus();
  };
  window.clearAuthFields = clearAuthFields;
  window.focusAuthEmail = focusAuthEmail;
  clearAuthFields();
  clearInlineErrors();
  syncAuthModeChrome();

  const setConnStatus = (msg) => {
    if (!connStatus) return;
    connStatus.textContent = msg ? String(msg) : "";
  };

  const checkConnection = async () => {
    if (authSubmitInFlight) return;
    if (isFileProtocol()) {
      setConnStatus("Use http(s) or npm start — file:// cannot call the API.");
      showToast("Open BinBuddy over the web URL, not as a downloaded file.");
      tryShowAuthApiHint();
      return;
    }
    setConnStatus("Checking connection…");
    try {
      await getApiBase();
      let health = await apiFetch("/health", { method: "GET", timeoutMs: 12000 });
      if (health?.ok && !health?.dbConnected) {
        await sleep(900);
        health = await apiFetch("/health", { method: "GET", timeoutMs: 12000 });
      }
      apiProbesHadHealthyHit = true;
      tryShowAuthApiHint();
      const ok = Boolean(health?.dbConnected);
      setConnStatus(ok ? `Connected ✅ (DB ping ${health.dbPingMs ?? "?"}ms)` : `API ok, DB offline ❌ (${health.dbError || "unavailable"})`);
      showToast(ok ? "Connected to server + database." : "Server reachable but database is offline.");
      return;
    } catch (e) {
      const msg = e?.message || "Connection failed.";
      setConnStatus(`Offline ❌ (${msg.slice(0, 120)}${msg.length > 120 ? "…" : ""})`);
      showToast(msg);
      tryShowAuthApiHint();
    }
  };

  const resetApiLink = async () => {
    setConnStatus("Resetting API link…");
    try {
      setApiBaseOverride("");
      apiProbesHadHealthyHit = false;
      resolvedApiBase = null;
      resolvingApiBasePromise = null;
      clearToken();
      SessionManager.clear();
      apiMode = false;
      setConnStatus("API link reset. Re-checking…");
      await checkConnection();
    } catch (e) {
      setConnStatus("Could not reset API link.");
    }
  };

  connCheckBtn?.addEventListener("click", () => void checkConnection());
  connResetBtn?.addEventListener("click", () => void resetApiLink());

  emailInput?.addEventListener("input", () => setFieldError(emailInput, emailError, ""));
  passwordInput?.addEventListener("input", () => setFieldError(passwordInput, passwordError, ""));
  phoneInput?.addEventListener("input", () => setFieldError(phoneInput, phoneError, ""));
  addressInput?.addEventListener("input", () => setFieldError(addressInput, addressError, ""));
  genderInput?.addEventListener("change", () => setFieldError(genderInput, genderError, ""));

  passwordToggleBtn?.addEventListener("click", () => {
    if (!passwordInput) return;
    const reveal = passwordInput.type === "password";
    passwordInput.type = reveal ? "text" : "password";
    passwordToggleBtn.setAttribute("aria-pressed", String(reveal));
    passwordToggleBtn.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
    // Keep a single eye icon; indicate state via aria + subtle styling.
    passwordToggleBtn.textContent = "👁️";
    passwordToggleBtn.classList.toggle("is-revealed", reveal);
    passwordInput.focus();
  });

  authTabs.forEach((tab, idx) => {
    tab.addEventListener("click", () => {
      authTabs.forEach((t, i) => {
        t.classList.toggle("active", i === idx);
        t.setAttribute("aria-selected", String(i === idx));
      });
      AppState.authMode = idx === 1 ? "register" : "login";
      syncAuthModeChrome();
      clearInlineErrors();
      if (authPrimaryButton && !authSubmitInFlight) authPrimaryButton.textContent = defaultSubmitLabel();
    });
  });

  roleCards.forEach(card => {
    card.addEventListener("click", () => {
      roleCards.forEach(c => {
        c.classList.remove("selected");
        c.setAttribute("aria-pressed", "false");
      });
      card.classList.add("selected");
      card.setAttribute("aria-pressed", "true");
    });
  });

  const submitAuth = async () => {
    if (authSubmitInFlight) return;
    clearInlineErrors();
    const submitMode = AppState.authMode === "register" ? "register" : "login";
    const email = (emailInput ? emailInput.value : "").trim();
    const password = passwordInput ? passwordInput.value : "";
    const phoneNumber = (phoneInput ? phoneInput.value : "").trim();
    const address = (addressInput ? addressInput.value : "").trim();
    const gender = (genderInput ? genderInput.value : "").trim();
    if (!email || !email.includes("@")) {
      setFieldError(emailInput, emailError, "Please enter a valid email address");
      emailInput?.focus();
      return;
    }
    if (email.includes(" ")) {
      setFieldError(emailInput, emailError, "Please enter a valid email address");
      emailInput?.focus();
      return;
    }

    const loginPwErr = validateLoginPasswordPresence(password);
    if (loginPwErr && submitMode === "login") {
      setFieldError(passwordInput, passwordError, loginPwErr);
      passwordInput?.focus();
      return;
    }
    if (submitMode === "register") {
      const phoneValidationError = validateRegisterPhoneClient(phoneNumber);
      if (phoneValidationError) {
        setFieldError(phoneInput, phoneError, phoneValidationError);
        phoneInput?.focus();
        return;
      }
      const addressValidationError = validateRegisterAddressClient(address);
      if (addressValidationError) {
        setFieldError(addressInput, addressError, addressValidationError);
        addressInput?.focus();
        return;
      }
      const genderValidationError = validateRegisterGenderClient(gender);
      if (genderValidationError) {
        setFieldError(genderInput, genderError, genderValidationError);
        genderInput?.focus();
        return;
      }
      const rp = validateRegisterPasswordClient(password);
      if (rp) {
        setFieldError(passwordInput, passwordError, "Password must be at least 8 characters with letters and numbers");
        passwordInput?.focus();
        return;
      }
    }

    // Safety watchdog: never leave the button stuck forever.
    let watchdog = null;
    const armWatchdog = () => {
      if (watchdog) window.clearTimeout(watchdog);
      watchdog = window.setTimeout(() => {
        authSubmitInFlight = false;
        setAuthSubmitBusy(false, submitMode);
        showToast("Request took too long. Please try again (check connection).");
      }, 30000);
    };

    if (submitMode === "register") {
      const registrationRole = selectedRegisterRole();
      const displayName = sanitizeRegisterName(email);
      authSubmitInFlight = true;
      setAuthSubmitBusy(true, submitMode);
      armWatchdog();
      try {
        const reg = await apiFetch("/auth/register", {
          method: "POST",
          body: JSON.stringify({
            email,
            password,
            name: displayName,
            role: registrationRole,
            phoneNumber,
            address,
            gender
          })
        });
        setToken(reg.token);
        const synced = await syncFromServer();
        if (!synced) {
          if (!getToken()) {
            showToast("Account may have been created but the session is invalid. Try logging in.");
            return;
          }
          applySessionFromAuthUser(reg.user);
          showToast("Welcome! Connected — some data will refresh when the server is available.");
        } else {
          showToast(`Welcome, ${reg.user.name}`);
        }
        const regHome = getRoleHomeScreen(reg.user.role);
        finalizeAuthenticatedEntry(regHome, { replaceHistory: true });
        return;
      } catch (e) {
        console.warn("[auth] register rejected or api failed — check server logs.", e?.message || e, e?.data || "");
        const reg = AuthService.register({
          email,
          password,
          name: displayName,
          role: registrationRole,
          phoneNumber,
          address,
          gender
        });
        if (!reg.ok) {
          showToast(e.message || reg.message);
          return;
        }
        const locLogin = AuthService.login({ email, password });
        if (!locLogin.ok) {
          showToast(locLogin.message);
          return;
        }
        finalizeAuthenticatedEntry(getRoleHomeScreen(locLogin.user.role), { replaceHistory: true });
        showToast(`Welcome, ${locLogin.user.name}`);
        return;
      } finally {
        if (watchdog) window.clearTimeout(watchdog);
        authSubmitInFlight = false;
        setAuthSubmitBusy(false, submitMode);
      }
    }

    authSubmitInFlight = true;
    setAuthSubmitBusy(true, submitMode);
    armWatchdog();
    try {
      const login = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email,
          password
        })
      });
      setToken(login.token);
      const synced = await syncFromServer();
      if (!synced) {
        if (!getToken()) {
          setFieldError(passwordInput, passwordError, "Login failed. Session could not be established.");
          showToast("Login failed. Please try again.");
          return;
        }
        applySessionFromAuthUser(login.user);
        showToast("Signed in — loading full data when the connection is ready.");
      } else {
        showToast(`Welcome, ${login.user.name}`);
      }
      const targetScreen = getRoleHomeScreen(login.user.role);
      finalizeAuthenticatedEntry(targetScreen, { replaceHistory: true });
      return;
    } catch (e) {
      const loginFallback = AuthService.login({ email, password });
      if (!loginFallback.ok) {
        setFieldError(passwordInput, passwordError, "Incorrect password");
        showToast(loginFallback.message || "Login failed.");
        return;
      }
      const targetScreen = getRoleHomeScreen(loginFallback.user.role);
      finalizeAuthenticatedEntry(targetScreen, { replaceHistory: true });
      showToast(`Welcome, ${loginFallback.user.name}`);
    } finally {
      if (watchdog) window.clearTimeout(watchdog);
      authSubmitInFlight = false;
      setAuthSubmitBusy(false, submitMode);
    }
  };

  authForm?.addEventListener("submit", ev => {
    ev.preventDefault();
    void submitAuth();
  });

  if (loginBtn) {
    loginBtn.addEventListener("click", ev => {
      ev.preventDefault();
      void submitAuth();
    });
  }

  window.__binbuddyAuthInitialized = true;

}

function bindEmergencyAuthFallback() {
  if (window.__binbuddyAuthInitialized) return;
  const authForm = document.getElementById("auth-form");
  const tabs = document.querySelectorAll(".auth-tab");
  const screenAuth = document.getElementById("screen-auth");
  const submitBtn = document.getElementById("btn-login");
  const emailInput = document.getElementById("auth-email");
  const passwordInput = document.getElementById("auth-password");
  const phoneInput = document.getElementById("auth-phone-number");
  const addressInput = document.getElementById("auth-address");
  const genderInput = document.getElementById("auth-gender");
  const roleCards = document.querySelectorAll(".role-card");

  let authBusy = false;
  const labelForMode = () =>
    AppState.authMode === "register" ? "Create BinBuddy Account" : "Login to BinBuddy";
  const setBusy = busy => {
    authBusy = Boolean(busy);
    if (!submitBtn) return;
    submitBtn.disabled = authBusy;
    submitBtn.setAttribute("aria-busy", authBusy ? "true" : "false");
    submitBtn.textContent = authBusy
      ? AppState.authMode === "register"
        ? "Creating account…"
        : "Signing in…"
      : labelForMode();
  };

  const setMode = (mode) => {
    AppState.authMode = mode === "register" ? "register" : "login";
    if (screenAuth) screenAuth.classList.toggle("auth-mode-register", AppState.authMode === "register");
    if (tabs[0]) tabs[0].classList.toggle("active", AppState.authMode === "login");
    if (tabs[1]) tabs[1].classList.toggle("active", AppState.authMode === "register");
    if (submitBtn && !authBusy) submitBtn.textContent = labelForMode();
  };

  tabs[0]?.addEventListener("click", () => setMode("login"));
  tabs[1]?.addEventListener("click", () => setMode("register"));
  roleCards.forEach((card) => {
    card.addEventListener("click", () => {
      roleCards.forEach(c => c.classList.remove("selected"));
      card.classList.add("selected");
      AppState.role = normalizeRole(card.dataset.role);
    });
  });

  authForm?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (authBusy) return;
    const email = String(emailInput?.value || "").trim();
    const password = String(passwordInput?.value || "");
    const role = normalizeRole(AppState.role);
    if (!email || !password) {
      showToast("Email and password are required.");
      return;
    }
    setBusy(true);
    try {
      let resolvedRole = role;
      let welcomeMsg = "Welcome to BinBuddy.";
      if (AppState.authMode === "register") {
        const payload = {
          email,
          password,
          name: sanitizeRegisterName(email),
          role,
          phoneNumber: String(phoneInput?.value || "").trim(),
          address: String(addressInput?.value || "").trim(),
          gender: String(genderInput?.value || "").trim().toLowerCase()
        };
        const reg = await apiFetch("/auth/register", { method: "POST", body: JSON.stringify(payload) });
        setToken(reg.token);
        resolvedRole = normalizeRole(reg.user?.role || role);
        const synced = await syncFromServer();
        if (!synced) {
          if (!getToken()) {
            showToast("Account may have been created but the session is invalid. Try logging in.");
            return;
          }
          applySessionFromAuthUser(reg.user);
          welcomeMsg = "Welcome! Some data will refresh when the server is available.";
        } else {
          welcomeMsg = `Welcome, ${reg.user?.name || "BinBuddy"}.`;
        }
      } else {
        const login = await apiFetch("/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password, role })
        });
        setToken(login.token);
        resolvedRole = normalizeRole(login.user?.role || role);
        const synced = await syncFromServer();
        if (!synced) {
          if (!getToken()) {
            showToast("Login failed. Please try again.");
            return;
          }
          applySessionFromAuthUser(login.user);
          welcomeMsg = "Signed in — full data will load when the connection is ready.";
        } else {
          welcomeMsg = `Welcome, ${login.user?.name || "BinBuddy"}.`;
        }
      }
      finalizeAuthenticatedEntry(getRoleHomeScreen(AuthService.currentUser()?.role || resolvedRole), { replaceHistory: true });
      showToast(welcomeMsg);
    } catch (err) {
      showToast(err?.message || "Authentication failed.");
    } finally {
      setBusy(false);
    }
  });

  setMode("login");
}

function downloadLocalWasteLogsCsv() {
  const header = "log_code,user_id,user_name,type,weight,status,points,created_at\n";
  const lines = AppState.logs.map(l =>
    `${l.id},${l.userId},"${String(l.userName || "").replace(/"/g, '""')}",${l.type},${l.weight},${l.status},${l.ecoPointsAwarded || 0},${l.createdAt || ""}`
  );
  const blob = new Blob([header + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "binbuddy-waste-logs.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function renderAdminToolsDetail(html) {
  const el = document.getElementById("admin-tools-detail");
  if (el) el.innerHTML = html;
}

async function openAdminUsersTool() {
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "admin") {
    showToast("Admin access only.");
    return;
  }
  if (apiMode && getToken()) {
    try {
      const data = await apiFetch("/admin/users");
      AppState.users = (data.users || []).map(u => ({
        id: u.id,
        name: u.name,
        email: u.email || "",
        phoneNumber: u.phoneNumber || "",
        address: u.address || "",
        gender: u.gender || "",
        role: u.role,
        ecoPoints: Number(u.ecoPoints) || 0,
        streak: Number(u.streak) || 0,
        badge: u.badge || "",
        barangay: u.barangay || "",
        password: ""
      }));
    } catch (e) {
      showToast(e.message || "Could not load users.");
      return;
    }
  }
  const rows = AppState.users.slice().sort((a, b) => String(a.role).localeCompare(String(b.role)));
  renderAdminToolsDetail(`
    <div class="card">
      <div class="section-title">👥 Users (${rows.length})</div>
      ${rows
        .map(
          u => `
      <div class="card card-sm" style="margin-bottom:8px">
        <strong>${u.name}</strong> · ${u.id} · ${u.role}<br/>
        <small>${u.email || "—"} · ${getUserBarangayLabel(u)} · ${u.ecoPoints ?? 0} pts</small>
      </div>`
        )
        .join("")}
    </div>`);
}

async function openAdminReportTool() {
  const user = AuthService.currentUser();
  if (!user || normalizeRole(user.role) !== "admin") {
    showToast("Admin access only.");
    return;
  }
  if (apiMode && getToken()) {
    try {
      const rep = await apiFetch("/admin/report");
      const m = rep.metrics || {};
      const byStatus = rep.logsByStatus || {};
      const recent = rep.recentLogs || [];
      const summaryLine = [
        `Total waste collected: ${m.totalCollectedKg != null ? `${m.totalCollectedKg} kg` : "—"}`,
        `Segregation compliance: ${m.compliance != null ? `${m.compliance}%` : "—"}`,
        `Recycling rate: ${m.recyclingRate != null ? `${m.recyclingRate}%` : "—"}`,
        `Active users: ${m.activeUsers != null ? m.activeUsers : "—"} (households & collectors)`,
        `EcoPoints distributed: ${m.ecoPointsDistributed != null ? Number(m.ecoPointsDistributed).toLocaleString() : "—"}`
      ].join(" · ");
      const logSummary = `Logs — total: ${m.totalLogs ?? "—"} · completed: ${m.completedLogs ?? "—"} · pending: ${m.pendingLogs ?? "—"} · rejected: ${m.rejectedLogs ?? "—"}`;
      renderAdminToolsDetail(`
        <div class="card">
          <div class="section-title">📋 Full report</div>
          <p style="font-size:0.86rem;color:var(--text-muted);margin:0 0 8px;line-height:1.5">${escapeAdminText(summaryLine)}</p>
          <p style="font-size:0.86rem;color:var(--text-muted);margin:0 0 10px;line-height:1.5">${escapeAdminText(logSummary)}</p>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:10px">By status: ${Object.entries(byStatus)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ") || "—"}</div>
          <div class="section-title" style="margin-top:12px">Recent activity</div>
          ${recent
            .slice(0, 20)
            .map(r => {
              const id = r.id || r.log_id || r.logCode || "—";
              const uname = r.userName || r.householdName || "—";
              const wt = r.type || r.wasteType || "—";
              const pts = r.points != null ? r.points : r.eco_points_awarded;
              const ptsBit = pts ? ` · +${pts} pts` : "";
              return `
          <div class="card card-sm" style="margin-bottom:8px">
            <strong>${escapeAdminText(String(id))}</strong> · ${escapeAdminText(String(uname))} · ${escapeAdminText(String(wt))} · ${Number(r.weight) || 0} kg<br/>
            <small>${escapeAdminText(String(r.status || ""))}${ptsBit} · ${formatDateTime(r.createdAt)}</small>
          </div>`;
            })
            .join("")}
        </div>`);
      return;
    } catch (e) {
      showToast(e.message || "Could not load report.");
      return;
    }
  }
  const m = AnalyticsService.metrics();
  const summaryOffline = [
    `Total waste collected: ${m.totalCollectedKg} kg`,
    `Segregation compliance: ${m.compliance}%`,
    `Recycling rate: ${m.recyclingRate}%`,
    `Active users: ${m.activeUsers} (households & collectors)`,
    `EcoPoints distributed: ${m.ecoPointsDistributed.toLocaleString()}`
  ].join(" · ");
  renderAdminToolsDetail(`
    <div class="card">
      <div class="section-title">📋 Full report (local)</div>
      <p style="font-size:0.86rem;color:var(--text-muted);margin:0 0 10px;line-height:1.5">${escapeAdminText(summaryOffline)}</p>
      <p style="font-size:0.86rem;color:var(--text-muted);margin:0 0 10px;line-height:1.5">
        Logs — total: ${m.totalLogs} · completed: ${m.completedLogs} · pending: ${m.pendingLogs} · not segregated: ${m.rejectedLogs ?? 0}
      </p>
      <div class="section-title" style="margin-top:12px">All logs</div>
      ${AppState.logs
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 40)
        .map(
          l => `
      <div class="card card-sm" style="margin-bottom:8px">
        <strong>${escapeAdminText(String(l.id))}</strong> · ${escapeAdminText(String(l.userName || ""))} · ${escapeAdminText(String(l.type || ""))} · ${l.weight} kg<br/>
        <small>${escapeAdminText(String(l.status))}${l.ecoPointsAwarded ? ` · +${l.ecoPointsAwarded} pts` : ""} · ${formatDateTime(l.createdAt)}</small>
      </div>`
        )
        .join("")}
    </div>`);
}

function initAdminActions() {
  const exportBtn = document.getElementById("btn-export");
  exportBtn?.addEventListener("click", async () => {
    const user = AuthService.currentUser();
    if (!user || normalizeRole(user.role) !== "admin") {
      showToast("Admin access only.");
      return;
    }
    if (apiMode && getToken()) {
      try {
        const base = await getApiBase();
        const res = await fetch(`${base}/admin/export.csv`, {
          headers: { Authorization: `Bearer ${getToken()}` }
        });
        if (!res.ok) throw new Error("Export failed.");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "binbuddy-waste-logs.csv";
        a.click();
        URL.revokeObjectURL(url);
        showToast("CSV downloaded.");
        return;
      } catch (e) {
        showToast(e.message || "Export failed.");
        return;
      }
    }
    downloadLocalWasteLogsCsv();
    showToast("CSV downloaded.");
  });

  document.getElementById("btn-admin-users")?.addEventListener("click", () => openAdminUsersTool());

  document.getElementById("btn-admin-report")?.addEventListener("click", () => openAdminReportTool());
}

function resolveHelpTourSteps() {
  const user = AuthService.currentUser();
  const role = user ? normalizeRole(user.role) : "household";
  if (role === "collector") return HELP_TOUR_STEPS_COLLECTOR;
  if (role === "admin") return HELP_TOUR_STEPS_ADMIN;
  return HELP_TOUR_STEPS_HOUSEHOLD;
}

function renderHelpTourStep() {
  const steps = helpTourStepsActive;
  const step = steps[helpTourIndex];
  const titleEl = document.getElementById("tour-title");
  const descEl = document.getElementById("tour-desc");
  const stepEl = document.getElementById("tour-step");
  const iconEl = document.getElementById("tour-icon");
  const prevEl = document.getElementById("tour-prev");
  const nextEl = document.getElementById("tour-next");
  if (!step || !titleEl || !descEl || !stepEl || !prevEl || !nextEl) return;
  if (iconEl) iconEl.textContent = step.icon || "♻️";
  titleEl.textContent = step.title;
  descEl.textContent = step.desc;
  stepEl.textContent = `${helpTourIndex + 1} / ${steps.length}`;
  prevEl.disabled = helpTourIndex <= 0;
  const last = helpTourIndex >= steps.length - 1;
  nextEl.textContent = last ? "Done" : "Next →";
}

function openHelpTourModal() {
  if (!AuthService.currentUser()) {
    showToast("Log in to open the tutorial.");
    return;
  }
  helpTourStepsActive = resolveHelpTourSteps();
  helpTourIndex = 0;
  if (!helpTourStepsActive.length) {
    showToast("No tutorial available.");
    return;
  }
  renderHelpTourStep();
  document.getElementById("help-modal")?.classList.add("active");
}

function closeHelpTourModal() {
  closeModal("help-modal");
}

function advanceHelpTour() {
  if (helpTourIndex >= helpTourStepsActive.length - 1) {
    closeHelpTourModal();
    return;
  }
  helpTourIndex += 1;
  renderHelpTourStep();
}

function retreatHelpTour() {
  if (helpTourIndex <= 0) return;
  helpTourIndex -= 1;
  renderHelpTourStep();
}

function initHelpTour() {
  const helpBtn = document.getElementById("help-btn");
  const prev = document.getElementById("tour-prev");
  const next = document.getElementById("tour-next");
  const closeBtn = document.getElementById("tour-close");
  const overlay = document.getElementById("help-modal");

  helpBtn?.addEventListener("click", openHelpTourModal);
  prev?.addEventListener("click", retreatHelpTour);
  next?.addEventListener("click", advanceHelpTour);
  closeBtn?.addEventListener("click", closeHelpTourModal);

  overlay?.addEventListener("click", e => {
    if (e.target === overlay) closeHelpTourModal();
  });

  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("help-modal")?.classList.contains("active")) return;
    closeHelpTourModal();
  });
}

function initNavigation() {
  const burger = document.getElementById("top-nav-burger");
  const header = document.getElementById("top-nav");
  burger?.addEventListener("click", () => {
    if (!header || !burger) return;
    const open = !header.classList.contains("is-open");
    header.classList.toggle("is-open", open);
    burger.setAttribute("aria-expanded", String(open));
  });

  document.querySelectorAll(".top-nav-item").forEach(btn => {
    const navigate = () => {
      const action = btn.dataset.action;
      if (action === "logout") {
        logout();
        return;
      }
      const screen = btn.dataset.nav;
      if (screen === "collector") {
        const subt = btn.dataset.collectorTab;
        AppState.collectorPickupTab = subt === "verified" ? "verified" : "unverified";
      }
      if (screen) goTo(screen);
      header?.classList.remove("is-open");
      burger?.setAttribute("aria-expanded", "false");
    };
    btn.addEventListener("click", navigate);
    btn.addEventListener(
      "touchend",
      e => {
        e.preventDefault();
        navigate();
      },
      { passive: false }
    );
  });

  const plus = document.getElementById("qty-plus");
  const minus = document.getElementById("qty-minus");
  if (plus) plus.addEventListener("click", increaseQty);
  if (minus) minus.addEventListener("click", decreaseQty);

  document.querySelectorAll("#manual-panel .waste-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      if (chip.style.display === "none") return;
      document.querySelectorAll("#manual-panel .waste-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      AppState.logType = chip.dataset.type;
    });
  });

  const submitBtn = document.getElementById("btn-submit-log");
  if (submitBtn) {
    submitBtn.addEventListener("click", async () => {
      const user = AuthService.currentUser();
      if (!user || normalizeRole(user.role) !== "household") {
        showToast("Only household users can submit logs.");
        return;
      }
      const weight = getManualInputWeight();
      const error = WasteLogService.validate(weight, AppState.logType, user);
      if (error) {
        showToast(error);
        return;
      }
      AppState.logQty = weight;
      await submitLog();
    });
  }

  const manualDate = document.getElementById("manual-log-date");
  const modalDate = document.getElementById("modal-log-date");
  if (manualDate && !manualDate.value) manualDate.value = todayInputValue();
  if (modalDate && !modalDate.value) modalDate.value = todayInputValue();

  const manualPhoto = document.getElementById("manual-log-photo");
  const modalPhoto = document.getElementById("modal-log-photo");
  manualPhoto?.addEventListener("change", () => {
    const file = manualPhoto.files?.[0];
    updatePhotoLabel(file ? file.name : "");
  });
  modalPhoto?.addEventListener("change", () => {
    const file = modalPhoto.files?.[0];
    updatePhotoLabel(file ? file.name : "");
    if (manualPhoto && modalPhoto.files?.length) {
      manualPhoto.value = "";
    }
  });
}

function selectModalType(type, el) {
  const normalized = type === "bio" || type === "pet" || type === "PET"
    ? "bio"
    : type === "rec" || type === "hdpe" || type === "HDPE"
      ? "rec"
      : null;
  if (!normalized || !el || el.style.display === "none") {
    showToast("Please select PET or HDPE only.");
    return;
  }
  document.querySelectorAll("#log-modal .waste-chip").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  AppState.logType = normalized;
}

function refreshUI() {
  renderHomeGreeting();
  renderUserAddress();
  renderHomeDisposalRank();
  renderRewardsBarangay();
  renderProfile();
  renderCollectorProfileShell();
  updateHomeStats();
  renderRecentLogs();
  renderNotifications();
  renderCollectorView();
  renderCollectorHistoryPage();
  void hydrateCollectorLogPhotoMounts();
  renderLeaderboard();
  renderAdminAnalytics();
  renderAdminProfileScreen();
  renderAdminWasteLogs();
  void renderAdminRewardQueue();
  initRewards();
  persistState();
}

function clearRuntimeUserContext() {
  AppState.currentUserId = null;
  AppState.currentUserName = null;
  AppState.role = "household";
  AppState.currentScreen = "auth";
  AppState.logType = "bio";
  AppState.logQty = 1.0;
  AppState.collectorPickupTab = "unverified";
}

function logout(showMessage = true, requireConfirmation = false) {
  if (requireConfirmation && !window.confirm("Are you sure you want to logout?")) {
    return;
  }
  clearToken();
  apiMode = false;
  adminAnalyticsCache = null;
  SessionManager.clearAppCache();
  clearRuntimeUserContext();
  clearSession();
  clearNavStack();
  AppState.logs = [];
  AppState.notifications = [];
  loadState();
  suppressSplashTransitions = false;
  exitAuthenticatedMount();
  goToAuthScreen(false);
  if (window.clearAuthFields) window.clearAuthFields();
  if (window.focusAuthEmail) window.focusAuthEmail();
  historySyncLogin();
  if (showMessage) showToast("Logged out successfully.");
}

function goToAuthScreen(refresh = true) {
  document.querySelectorAll("#mount-login-phase .screen").forEach(el => el.classList.remove("active"));
  dashboardScreensDeactivateAll();
  const target = document.getElementById("screen-auth");
  if (target) target.classList.add("active");
  AppState.currentScreen = "auth";
  const topNav = document.getElementById("top-nav");
  if (topNav) {
    topNav.hidden = true;
    topNav.setAttribute("aria-hidden", "true");
    topNav.classList.remove("is-open");
  }
  document.querySelectorAll(".top-nav-item").forEach(btn => {
    btn.classList.remove("active");
    btn.classList.add("hidden");
  });
  if (window.clearAuthFields) window.clearAuthFields();
  if (window.focusAuthEmail) window.focusAuthEmail();
  if (refresh) refreshUI();
  resetViewportScroll(target || document.getElementById("screen-auth"));
}

document.addEventListener("DOMContentLoaded", async () => {
  const safeInit = (label, fn) => {
    try {
      fn();
    } catch (err) {
      console.error(`[init:${label}]`, err);
    }
  };

  safeInit("loadState", () => loadState());
  safeInit("loadSession", () => loadSession());
  safeInit("historyGuard", () => HistoryGuard.init());

  safeInit("runInitialUrlRouting", () => runInitialUrlRouting(false));
  /** Don't block painting on JWT sync — resolves stuck splash when API is slow or timing out (see BOOTSTRAP_SYNC_*). */
  initSplash(Boolean(AuthService.currentUser()));
  setupWasteTypeSelectors();
  initNavigation();
  safeInit("helpTour", () => initHelpTour());
  initDashboardBackButtons();
  initAuth();
  initAdminActions();
  initGuide();
  initRecyclableChecker();
  updateQtyUI();
  resetLogInputs();
  safeInit("refreshUI", () => {
    try {
      refreshUI();
    } catch (err) {
      console.error("[init:refreshUI]", err);
    }
  });

  if (getToken()) {
    void runInitialSessionHydrationFromToken().catch(err => console.error("[init:bootstrapHydration]", err));
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!getToken()) return;
    if (!AuthService.currentUser()) return;
    syncFromServer().then(ok => {
      if (ok) refreshUI();
    });
  });

  void getApiBase()
    .catch(() => {})
    .finally(() => {
      try {
        tryShowAuthApiHint();
      } catch (_e) {
        /* ignore */
      }
    });
});

window.AppState = AppState;
window.goTo = goTo;
window.navGoBack = navGoBack;
window.showToast = showToast;
window.openLogModal = openLogModal;
window.closeModal = closeModal;
window.submitLog = submitLog;
window.increaseQty = increaseQty;
window.decreaseQty = decreaseQty;
window.renderLeaderboard = renderLeaderboard;
window.goToRewardsLeaderboard = goToRewardsLeaderboard;
window.renderNotifications = renderNotifications;
window.initGuide = initGuide;
window.initRewards = initRewards;
window.handleCollectorDecision = handleCollectorDecision;
window.setCollectorPickupTab = setCollectorPickupTab;
window.beginRewardSubmission = beginRewardSubmission;
window.cancelRewardSubmission = cancelRewardSubmission;
window.selectModalType = selectModalType;
window.logout = logout;
window.cancelLogSubmission = cancelLogSubmission;
