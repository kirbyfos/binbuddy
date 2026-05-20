import bcrypt from "bcryptjs";
import { db } from "../db.js";
import { signToken } from "../middleware/auth.js";
import { toPublicUser, badgeFromPoints } from "./userMapper.js";
import { normalizeRoleInput, isCanonicalRole } from "./roleNormalize.js";

const AUTH_LOG = process.env.BINBUDDY_AUTH_LOG !== "false";

function authLog(event, detail) {
  if (!AUTH_LOG) return;
  try {
    console.info(`[auth] ${event}`, detail);
  } catch {
    /* ignore */
  }
}

function getUserByEmail(email) {
  /** Parameter-bound query — not string-interpolated (SQL injection safe). */
  return db.prepare("SELECT * FROM users WHERE lower(email) = lower(?)").get(email.trim());
}

function barangayFromAddress(address) {
  const s = String(address || "").trim();
  if (!s) return "";
  const m = s.match(/(?:Brgy\.?|Barangay)\s*([^,]+)/i);
  if (m) {
    const n = m[1].trim().slice(0, 120);
    return n || "";
  }
  const first = s.split(",")[0].trim();
  const n = first.replace(/^(?:Brgy\.?|Barangay)\s*/i, "").trim() || first;
  return n.slice(0, 120);
}

function nextUserCode(role) {
  const prefix = role === "collector" ? "COL" : role === "admin" ? "ADM" : "USR";
  const row = db.prepare(`SELECT user_code FROM users WHERE user_code LIKE ? ORDER BY user_code DESC LIMIT 1`).get(`${prefix}%`);
  if (!row) return `${prefix}001`;
  const n = Number.parseInt(row.user_code.slice(3), 10) || 0;
  return `${prefix}${String(n + 1).padStart(3, "0")}`;
}

export function register({ email, password, name, role: roleRaw, phoneNumber, address, gender: genderRaw }) {
  const role = normalizeRoleInput(roleRaw);
  if (!role || !isCanonicalRole(role)) {
    authLog("register_rejected", { reason: "invalid_role", roleRaw: typeof roleRaw === "string" ? roleRaw.slice(0, 32) : roleRaw });
    return { ok: false, message: "Invalid role. Use user, collector, or admin." };
  }
  if (role === "admin") {
    authLog("register_rejected", { reason: "admin_registration_disabled" });
    return { ok: false, message: "Admin accounts are managed by the system." };
  }

  const existing = getUserByEmail(email);
  if (existing) {
    authLog("register_rejected", { reason: "duplicate_email" });
    return { ok: false, message: "An account with this email already exists." };
  }
  const user_code = nextUserCode(role);
  const full_name = (name || email.split("@")[0].replace(/\./g, " ") || "User").trim();
  const password_hash = bcrypt.hashSync(password, 10);
  const level = role === "household" ? badgeFromPoints(0) : null;
  const normalizedPhone = String(phoneNumber || "").trim();
  const normalizedAddress = String(address || "").trim();
  const genderNorm = String(genderRaw || "").trim().toLowerCase();
  const gender = genderNorm === "male" || genderNorm === "female" ? genderNorm : "";
  if (!gender) {
    authLog("register_rejected", { reason: "invalid_gender" });
    return { ok: false, message: "Gender is required (Male or Female)." };
  }
  const barangay = barangayFromAddress(normalizedAddress) || normalizedAddress;

  db.prepare(
    `INSERT INTO users (user_code, full_name, email, password_hash, phone_number, address, gender, role, eco_points, streak_days, level, barangay)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`
  ).run(
    user_code,
    full_name,
    email.trim().toLowerCase(),
    password_hash,
    normalizedPhone,
    normalizedAddress,
    gender,
    role,
    level,
    barangay
  );

  const user = db.prepare("SELECT * FROM users WHERE user_code = ?").get(user_code);
  authLog("register_ok", { user_code, role });
  const token = signToken({
    sub: user.id,
    code: user.user_code,
    role: user.role,
    email: user.email
  });
  return { ok: true, token, user: toPublicUser(user) };
}

export function login({ email, password }) {
  const user = getUserByEmail(email);
  if (!user) {
    authLog("login_rejected", { reason: "unknown_email" });
    return { ok: false, message: "Account does not exist." };
  }
  if (!bcrypt.compareSync(password, user.password_hash)) {
    authLog("login_rejected", { reason: "bad_password", role: user.role });
    return { ok: false, message: "Incorrect password." };
  }
  const token = signToken({
    sub: user.id,
    code: user.user_code,
    role: user.role,
    email: user.email
  });
  authLog("login_ok", { user_code: user.user_code, role: user.role });
  return { ok: true, token, user: toPublicUser(user) };
}

export function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function guestLoginAsDemoHousehold() {
  const user = db.prepare("SELECT * FROM users WHERE user_code = ?").get("USR001");
  if (!user) return { ok: false, message: "Demo user not available." };
  const token = signToken({
    sub: user.id,
    code: user.user_code,
    role: user.role,
    email: user.email
  });
  return { ok: true, token, user: toPublicUser(user) };
}
