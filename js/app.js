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

function normalizeApiBase(raw) {
  const s = String(raw || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  return s.endsWith("/api") ? s : `${s}/api`;
}

function candidateApiBases() {
  const list = [];
  try {
    const w = typeof window !== "undefined" ? window : null;
    if (!w) return ["/api"];
    const explicit = normalizeApiBase(w.BINBUDDY_API_BASE);
    if (explicit) list.push(explicit);
    const stored = normalizeApiBase(w.localStorage?.getItem(API_BASE_STORAGE_KEY));
    if (stored) list.push(stored);
    const meta = w.document?.querySelector?.('meta[name="binbuddy-api-base"]')?.getAttribute?.("content");
    const metaNorm = normalizeApiBase(meta);
    if (metaNorm) list.push(metaNorm);

    // same-origin
    const origin = String(w.location?.origin || "").trim();
    if (origin) list.push(`${origin}/api`);

    // api. subdomain
    const host = String(w.location?.hostname || "").trim();
    const proto = String(w.location?.protocol || "https:").trim();
    if (host && !host.startsWith("api.")) {
      list.push(`${proto}//api.${host}/api`);
    }
  } catch (_e) {
    // ignore
  }
  list.push("/api");

  // de-dupe while preserving order
  const seen = new Set();
  return list.filter(x => (x && !seen.has(x) ? (seen.add(x), true) : false));
}

async function probeApiBase(base) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6500);
  try {
    const res = await fetch(`${base}/health`, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) return false;
    const ct = String(res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) return false;
    const data = await res.json().catch(() => ({}));
    return Boolean(data && (data.ok === true || data.success === true));
  } catch (_e) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function getApiBase() {
  if (resolvedApiBase) return resolvedApiBase;
  if (resolvingApiBasePromise) return resolvingApiBasePromise;
  resolvingApiBasePromise = (async () => {
    const candidates = candidateApiBases();
    for (const c of candidates) {
      if (await probeApiBase(c)) {
        resolvedApiBase = c;
        return resolvedApiBase;
      }
    }
    // If none respond, fall back to the first candidate (most likely correct) and surface a useful error later.
    resolvedApiBase = candidates[0] || "/api";
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
      return true;
    }
    localStorage.setItem(API_BASE_STORAGE_KEY, b);
    resolvedApiBase = b;
    resolvingApiBasePromise = null;
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
  notifications: []
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

function isLogSameLocalCalendarDay(log, refDate = new Date()) {
  const d = logReferenceInstant(log);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getFullYear() === refDate.getFullYear() &&
    d.getMonth() === refDate.getMonth() &&
    d.getDate() === refDate.getDate()
  );
}

function collectorYearlyLogs(logs, year = new Date().getFullYear()) {
  return logs.filter(l => isLogInCalendarYear(l, year));
}

function computeCollectorDashboardStats(logs) {
  const year = new Date().getFullYear();
  const y = collectorYearlyLogs(logs, year);
  const today = new Date();
  const pickupsToday = y.filter(l => isLogSameLocalCalendarDay(l, today)).length;
  const verifiedOk = y.filter(l => l.status === "Completed").length;
  const notSegregated = y.filter(l => l.status === "Rejected").length;
  const pending = y.filter(l => l.status === "Pending").length;
  return { year, pickupsToday, verifiedOk, notSegregated, pending };
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

function htmlVerifiedLogCardReadOnly(log, opts = {}) {
  const showVerifier = opts.showVerifier !== false;
  const verifier = showVerifier && log.verifiedBy ? ` · Verified by ${log.verifiedBy}` : "";
  return `
      <div class="card" style="margin-bottom:8px">
        <strong>${log.userName}</strong> • ${log.type} • ${log.weight} kg<br/>
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
    ? mine.map(l => htmlVerifiedLogCardReadOnly(l, { showVerifier: false })).join("")
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
    const isJson = contentType.includes("application/json");
    const data = isJson ? await res.json().catch(() => ({})) : {};
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

async function syncFromServer() {
  const token = getToken();
  if (!token) {
    apiMode = false;
    return false;
  }
  try {
    const me = await apiFetch("/auth/me");
    const user = me.user;
    AppState.currentUserId = user.id;
    AppState.currentUserName = user.name;
    AppState.role = normalizeRole(user.role);

    const logsData = await apiFetch("/logs");
    AppState.logs = logsData.logs || [];

    const notifData = await apiFetch("/notifications");
    AppState.notifications = (notifData.notifications || []).map(n => ({
      text: n.text,
      createdAt: n.createdAt || n.created_at,
      userId: user.id
    }));

    if (normalizeRole(user.role) === "household") {
      const lb = await apiFetch("/leaderboard");
      const rows = lb.leaderboard || [];
      const myIdStr = String(user.id);
      const myLb = rows.find(r => String(r.id) === myIdStr);

      /** Disposal totals for me when API omits top-50 snapshot (fallback: my `/logs`). */
      const myLogsFiltered = AppState.logs.filter(
        l => String(l.userId) === myIdStr && isLogStatusCompleted(l.status)
      );

      /** Single source of truth for EcoPoints/streak/contact; disposal stats prefer leaderboard row or local logs. */
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
        barangay: user.barangay || "Holy Spirit",
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
    } else {
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
          barangay: user.barangay || "Holy Spirit",
          password: ""
        }
      ];
    }

    if (normalizeRole(user.role) === "admin") {
      adminAnalyticsCache = await apiFetch("/admin/analytics");
      try {
        const usersData = await apiFetch("/admin/users");
        const mappedAdminUsers = (usersData.users || []).map(u => ({
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
      } catch (_e) {
        /* keep fallback single-user row */
      }
    } else {
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
    barangay: user.barangay || "Holy Spirit",
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
        barangay: "Holy Spirit",
        phoneNumber: "09171234567",
        address: "Brgy. Holy Spirit, Lipa City",
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
        barangay: "Holy Spirit",
        phoneNumber: "09171230000",
        address: "Brgy. Holy Spirit, Lipa City",
        gender: "male"
      },
      {
        id: "ADM001",
        name: "Brgy. Holy Spirit Admin",
        email: "admin@email.com",
        password: "password123",
        role: "admin",
        ecoPoints: 0,
        streak: 0,
        badge: "Admin",
        barangay: "Holy Spirit",
        phoneNumber: "09179990000",
        address: "Brgy. Holy Spirit, Lipa City",
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
  verifyLog(logId, isVerified, collectorId) {
    const log = AppState.logs.find(l => l.id === logId);
    if (!log) return null;
    if (!isVerified) {
      if (log.status === "Completed") return log;
      log.status = "Rejected";
      log.verifiedBy = collectorId;
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
    const totalCollectedKg = AppState.logs
      .filter(l => l.status === "Completed")
      .reduce((sum, l) => sum + l.weight, 0);
    const decided = completed + pending + rejected;
    const compliance = decided > 0 ? Math.round((completed / decided) * 100) : 0;
    const ecoPointsDistributed = AppState.logs.reduce((sum, l) => sum + (l.ecoPointsAwarded || 0), 0);
    return {
      totalLogs: total,
      completedLogs: completed,
      pendingLogs: pending,
      rejectedLogs: rejected,
      totalCollectedKg: Number(totalCollectedKg.toFixed(1)),
      compliance,
      ecoPointsDistributed
    };
  },
  weeklySeries() {
    const byDay = {};
    AppState.logs.forEach(log => {
      if (log.status !== "Completed") return;
      const day = new Date(log.createdAt).toLocaleDateString(undefined, { weekday: "short" });
      byDay[day] = (byDay[day] || 0) + log.weight;
    });
    const sequence = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    return sequence.map(day => ({ day, val: Number((byDay[day] || 0).toFixed(1)) }));
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

function initSplash(_restoredSession) {
  const splashScreen = document.getElementById("screen-splash");
  if (!splashScreen && !AuthService.currentUser()) {
    showLoginFormOnly();
    return;
  }
  if (!splashScreen) return;

  if (suppressSplashTransitions || AuthService.currentUser()) {
    return;
  }

  showSplashOnly();
  if (pathRoutingEnabled()) {
    historySplashOnLoginRoute();
  }

  setTimeout(() => {
    if (AuthService.currentUser()) return;

    showLoginFormOnly();
    if (pathRoutingEnabled()) {
      window.history.replaceState({ screen: "auth", authenticated: false }, "", ROUTES.LOGIN);
    }
    const ae = document.getElementById("screen-auth");
    if (ae) resetViewportScroll(ae);
  }, 1800);
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
      section.id === "screen-collector-history"
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
      section.id === "screen-collector-history"
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
    const isActive = isRoleMatch && !action && targetScreen === screen;
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

function renderCollectorView() {
  const list = document.getElementById("pickup-list");
  if (!list) return;
  const year = new Date().getFullYear();
  const stats = computeCollectorDashboardStats(AppState.logs);
  const yLogs = collectorYearlyLogs(AppState.logs, year);
  const active = yLogs
    .filter(l => l.status === "Pending" || l.status === "Rejected")
    .slice()
    .sort((a, b) => {
      if (a.status === "Pending" && b.status !== "Pending") return -1;
      if (b.status === "Pending" && a.status !== "Pending") return 1;
      return logReferenceInstant(b).getTime() - logReferenceInstant(a).getTime();
    });
  const statusLabel = log =>
    log.status === "Rejected" ? "Not segregated" : log.status === "Pending" ? "Pending" : log.status;
  list.innerHTML = active.length
    ? active
        .map(
          log => `
    <div class="card" style="margin-bottom:10px">
      <strong>${log.userName}</strong> • ${log.type} • ${log.weight} kg<br/>
      <small>Status: <strong>${statusLabel(log)}</strong> · ${logCalendarYear(log)}</small>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-outline" onclick="handleCollectorDecision('${log.id}',false)">Not Verified</button>
        <button class="btn btn-primary" onclick="handleCollectorDecision('${log.id}',true)">Verify</button>
      </div>
    </div>
  `
        )
        .join("")
    : `<p style="font-size:0.88rem;color:var(--text-muted);margin:0">No active pickups for ${year}. Open History for verified logs.</p>`;

  const statValues = document.querySelectorAll("#screen-collector .stat-value");
  if (statValues[0]) statValues[0].textContent = stats.pickupsToday;
  if (statValues[1]) statValues[1].textContent = stats.verifiedOk;
  if (statValues[2]) statValues[2].textContent = stats.notSegregated;
  if (statValues[3]) statValues[3].textContent = stats.pending;
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
        isVerified ? "Verified — log moved to history." : "Marked as not segregated — stays on active dashboard."
      );
      refreshUI();
      return;
    } catch (e) {
      showToast(e.message || "Verification failed.");
      return;
    }
  }
  const updated = VerificationService.verifyLog(logId, isVerified, user.id);
  if (!updated) {
    showToast("Log not found.");
    return;
  }
  showToast(
    isVerified ? "Verified — log moved to history." : "Marked as not segregated — stays on active dashboard."
  );
  refreshUI();
}

function adminWasteLogStatusLabel(log) {
  if (log.status === "Completed") return "Verified";
  if (log.status === "Rejected") return "Not segregated";
  return "Pending pickup";
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
  if (apiMode && adminAnalyticsCache && adminAnalyticsCache.metrics) {
    const m = adminAnalyticsCache.metrics;
    const kpis = document.querySelectorAll("#screen-admin .kpi-card .kpi-value");
    if (kpis[0]) kpis[0].textContent = `${m.totalCollectedKg}kg`;
    if (kpis[1]) kpis[1].textContent = `${m.compliance}%`;
    if (kpis[2]) kpis[2].textContent = `${m.recyclingRate}%`;
    if (kpis[3]) kpis[3].textContent = `${m.activeHouseholds}`;

    const pointsNode = document.querySelector("#screen-admin .card.mb-12 .section-title + div");
    if (pointsNode) pointsNode.textContent = `${m.ecoPointsDistributed}`;

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
    return;
  }

  const metrics = AnalyticsService.metrics();
  const kpis = document.querySelectorAll("#screen-admin .kpi-card .kpi-value");
  if (kpis[0]) kpis[0].textContent = `${metrics.totalCollectedKg}kg`;
  if (kpis[1]) kpis[1].textContent = `${metrics.compliance}%`;
  if (kpis[2]) kpis[2].textContent = `${metrics.completedLogs}`;
  if (kpis[3]) kpis[3].textContent = `${AppState.users.filter(u => normalizeRole(u.role) === "household").length}`;

  const pointsNodeLocal =
    document.querySelector("#screen-admin .card.mb-12 .section-title + div") ||
    document.querySelector("#screen-admin .card .section-title + div");
  if (pointsNodeLocal) pointsNodeLocal.textContent = `${metrics.ecoPointsDistributed}`;

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
            <small>Tap chips above to log PET/HDPE</small>
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
    setConnStatus("Checking connection…");
    try {
      const base = await getApiBase();
      const health = await apiFetch("/health", { method: "GET", timeoutMs: 12000 });
      const ok = Boolean(health?.dbConnected);
      setConnStatus(ok ? `Connected ✅ (DB ping ${health.dbPingMs ?? "?"}ms)` : `API ok, DB offline ❌ (${health.dbError || "unavailable"})`);
      showToast(ok ? "Connected to server + database." : "Server reachable but database is offline.");
      return;
    } catch (e) {
      const msg = e?.message || "Connection failed.";
      setConnStatus(`Offline ❌ (${msg})`);
      showToast(msg);
    }
  };

  const resetApiLink = async () => {
    setConnStatus("Resetting API link…");
    try {
      setApiBaseOverride("");
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

function adminBroadcastLocal(message) {
  const households = AppState.users.filter(u => normalizeRole(u.role) === "household");
  const text = `[Barangay broadcast] ${message}`;
  households.forEach(h => {
    AppState.notifications.unshift({
      text,
      createdAt: nowIso(),
      userId: h.id
    });
  });
  persistState();
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
      renderAdminToolsDetail(`
        <div class="card">
          <div class="section-title">📋 Full report</div>
          <p style="font-size:0.86rem;color:var(--text-muted);margin:0 0 10px">
            Total logs: ${m.totalLogs ?? "—"} · Completed: ${m.completedLogs ?? "—"} · Pending: ${m.pendingLogs ?? "—"} · Rejected: ${m.rejectedLogs ?? "—"} · Compliance: ${m.compliance ?? "—"}%
          </p>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:10px">By status: ${Object.entries(byStatus)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ") || "—"}</div>
          <div class="section-title" style="margin-top:12px">Recent activity</div>
          ${recent
            .slice(0, 20)
            .map(
              r => `
          <div class="card card-sm" style="margin-bottom:8px">
            <strong>${r.logCode}</strong> · ${r.householdName} · ${r.wasteType} · ${r.weight} kg<br/>
            <small>${r.status}${r.verifierCode ? ` · Verifier ${r.verifierCode}` : ""} · ${formatDateTime(r.createdAt)}</small>
          </div>`
            )
            .join("")}
        </div>`);
      return;
    } catch (e) {
      showToast(e.message || "Could not load report.");
      return;
    }
  }
  const m = AnalyticsService.metrics();
  renderAdminToolsDetail(`
    <div class="card">
      <div class="section-title">📋 Full report (local)</div>
      <p style="font-size:0.86rem;color:var(--text-muted);margin:0 0 10px">
        Total logs: ${m.totalLogs} · Completed: ${m.completedLogs} · Pending: ${m.pendingLogs} · Not segregated: ${m.rejectedLogs ?? 0} · Compliance: ${m.compliance}%
      </p>
      <div class="section-title" style="margin-top:12px">All logs</div>
      ${AppState.logs
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 40)
        .map(
          l => `
      <div class="card card-sm" style="margin-bottom:8px">
        <strong>${l.id}</strong> · ${l.userName} · ${l.type} · ${l.weight} kg<br/>
        <small>${l.status}${l.verifiedBy ? ` · ${l.verifiedBy}` : ""} · ${formatDateTime(l.createdAt)}</small>
      </div>`
        )
        .join("")}
    </div>`);
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

function adminBroadcastLocal(message) {
  const households = AppState.users.filter(u => normalizeRole(u.role) === "household");
  const text = `[Barangay broadcast] ${message}`;
  households.forEach(h => {
    AppState.notifications.unshift({
      text,
      createdAt: nowIso(),
      userId: h.id
    });
  });
  persistState();
}

function renderAdminToolsDetail(html) {
  const el = document.getElementById("admin-tools-detail");
  if (el) el.innerHTML = html;
}

async function openAdminUsersTool() {
  const user = AuthService.currentUser();
  if (!user || user.role !== "admin") {
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
  if (!user || user.role !== "admin") {
    showToast("Admin access only.");
    return;
  }
  if (apiMode && getToken()) {
    try {
      const rep = await apiFetch("/admin/report");
      const m = rep.metrics || {};
      const byStatus = rep.logsByStatus || {};
      const recent = rep.recentLogs || [];
      renderAdminToolsDetail(`
        <div class="card">
          <div class="section-title">📋 Full report</div>
          <p style="font-size:0.86rem;color:var(--text-muted);margin:0 0 10px">
            Total logs: ${m.totalLogs ?? "—"} · Completed: ${m.completedLogs ?? "—"} · Pending: ${m.pendingLogs ?? "—"} · Rejected: ${m.rejectedLogs ?? "—"} · Compliance: ${m.compliance ?? "—"}%
          </p>
          <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:10px">By status: ${Object.entries(byStatus)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ") || "—"}</div>
          <div class="section-title" style="margin-top:12px">Recent activity</div>
          ${recent
            .slice(0, 20)
            .map(
              r => `
          <div class="card card-sm" style="margin-bottom:8px">
            <strong>${r.logCode}</strong> · ${r.householdName} · ${r.wasteType} · ${r.weight} kg<br/>
            <small>${r.status}${r.verifierCode ? ` · Verifier ${r.verifierCode}` : ""} · ${formatDateTime(r.createdAt)}</small>
          </div>`
            )
            .join("")}
        </div>`);
      return;
    } catch (e) {
      showToast(e.message || "Could not load report.");
      return;
    }
  }
  const m = AnalyticsService.metrics();
  renderAdminToolsDetail(`
    <div class="card">
      <div class="section-title">📋 Full report (local)</div>
      <p style="font-size:0.86rem;color:var(--text-muted);margin:0 0 10px">
        Total logs: ${m.totalLogs} · Completed: ${m.completedLogs} · Pending: ${m.pendingLogs} · Not segregated: ${m.rejectedLogs ?? 0} · Compliance: ${m.compliance}%
      </p>
      <div class="section-title" style="margin-top:12px">All logs</div>
      ${AppState.logs
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 40)
        .map(
          l => `
      <div class="card card-sm" style="margin-bottom:8px">
        <strong>${l.id}</strong> · ${l.userName} · ${l.type} · ${l.weight} kg<br/>
        <small>${l.status}${l.verifiedBy ? ` · ${l.verifiedBy}` : ""} · ${formatDateTime(l.createdAt)}</small>
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

  document.getElementById("btn-admin-broadcast")?.addEventListener("click", async () => {
    const user = AuthService.currentUser();
    if (!user || user.role !== "admin") {
      showToast("Admin access only.");
      return;
    }
    const msg = window.prompt("Broadcast message to all households:");
    if (msg == null) return;
    const trimmed = String(msg).trim();
    if (!trimmed) {
      showToast("Message required.");
      return;
    }
    if (apiMode && getToken()) {
      try {
        const res = await apiFetch("/admin/broadcast", {
          method: "POST",
          body: JSON.stringify({ message: trimmed })
        });
        showToast(`Broadcast sent to ${res.recipients ?? 0} households.`);
        await syncFromServer();
        refreshUI();
        return;
      } catch (e) {
        showToast(e.message || "Broadcast failed.");
        return;
      }
    }
    adminBroadcastLocal(trimmed);
    showToast(`Broadcast sent to ${AppState.users.filter(u => normalizeRole(u.role) === "household").length} households.`);
    refreshUI();
  });

  document.getElementById("btn-admin-report")?.addEventListener("click", () => openAdminReportTool());

  // Excel-friendly XML + XSL export (admin only).
  const exportXmlBtn = document.getElementById("btn-admin-export-xml");
  exportXmlBtn?.addEventListener("click", async () => {
    const user = AuthService.currentUser();
    if (!user || user.role !== "admin") {
      showToast("Admin access only.");
      return;
    }
    if (apiMode && getToken()) {
      try {
        const res = await fetch(`${API_BASE}/export/logs.xml`, {
          headers: { Authorization: `Bearer ${getToken()}` }
        });
        if (!res.ok) throw new Error("Export failed.");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "binbuddy-waste-logs.xml";
        a.click();
        URL.revokeObjectURL(url);
        showToast("XML downloaded.");
        return;
      } catch (e) {
        showToast(e.message || "Export failed.");
        return;
      }
    }
    showToast("XML export requires server mode.");
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
  renderLeaderboard();
  renderAdminAnalytics();
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

  let restored = false;
  if (getToken()) {
    try {
      restored = await syncFromServer();
    } catch (err) {
      console.error("[init:syncFromServer]", err);
      restored = false;
    }
  }

  safeInit("runInitialUrlRouting", () => runInitialUrlRouting(restored));

  initSplash(restored);
  setupWasteTypeSelectors();
  initNavigation();
  initDashboardBackButtons();
  initAuth();
  initAdminActions();
  initGuide();
  initRecyclableChecker();
  updateQtyUI();
  resetLogInputs();
  refreshUI();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (!getToken()) return;
    if (!AuthService.currentUser()) return;
    syncFromServer().then(ok => {
      if (ok) refreshUI();
    });
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
window.beginRewardSubmission = beginRewardSubmission;
window.cancelRewardSubmission = cancelRewardSubmission;
window.selectModalType = selectModalType;
window.logout = logout;
window.cancelLogSubmission = cancelLogSubmission;
