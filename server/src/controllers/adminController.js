import { body, validationResult } from "express-validator";
import { adminMetrics, weeklySeries } from "../services/analyticsService.js";
import { db } from "../db.js";

export function listAdminUsers(req, res) {
  const rows = db
    .prepare(
      `SELECT user_code, full_name, email, phone_number, address, gender, role, eco_points, streak_days, level, barangay
       FROM users ORDER BY role, full_name`
    )
    .all();
  return res.json({
    ok: true,
    users: rows.map((u) => ({
      id: u.user_code,
      name: u.full_name,
      email: u.email,
      phoneNumber: u.phone_number || "",
      address: u.address || "",
      role: u.role,
      ecoPoints: u.eco_points,
      streak: u.streak_days,
      badge: u.level || "",
      barangay: u.barangay || "",
      gender: u.gender || ""
    }))
  });
}

export function getAdminReport(req, res) {
  const metrics = adminMetrics();
  const logsByStatus = db
    .prepare(`SELECT status, COUNT(*) AS c FROM waste_logs GROUP BY status`)
    .all()
    .reduce((acc, row) => {
      acc[row.status] = row.c;
      return acc;
    }, {});
  const recentLogs = db
    .prepare(
      `
      SELECT wl.log_code, u.user_code AS household_code, u.full_name AS household_name, wl.waste_type, wl.weight, wl.status,
             wl.eco_points_awarded, wl.created_at, wl.completed_at, vu.user_code AS verifier_code
      FROM waste_logs wl
      JOIN users u ON u.id = wl.user_id
      LEFT JOIN users vu ON vu.id = wl.verified_by
      ORDER BY wl.created_at DESC LIMIT 50
    `
    )
    .all();
  return res.json({
    ok: true,
    metrics,
    logsByStatus,
    recentLogs: recentLogs.map((r) => ({
      logCode: r.log_code,
      householdCode: r.household_code,
      householdName: r.household_name,
      wasteType: r.waste_type,
      weight: r.weight,
      status: r.status,
      ecoPointsAwarded: r.eco_points_awarded,
      createdAt: r.created_at,
      completedAt: r.completed_at,
      verifierCode: r.verifier_code || null
    }))
  });
}

export const broadcastValidators = [
  body("message").trim().isLength({ min: 1, max: 2000 }).withMessage("Message is required (max 2000 characters).")
];

export function postAdminBroadcast(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ ok: false, message: "Invalid input.", errors: errors.array() });
  }
  const message = String(req.body.message || "").trim();
  const households = db.prepare(`SELECT id FROM users WHERE role = 'household'`).all();
  const insert = db.prepare(`INSERT INTO notifications (user_id, message) VALUES (?, ?)`);
  const run = db.transaction(() => {
    const prefix = "[Barangay broadcast]";
    for (const h of households) {
      insert.run(h.id, `${prefix} ${message}`);
    }
  });
  run();
  return res.json({ ok: true, recipients: households.length });
}

export function getAnalytics(req, res) {
  const metrics = adminMetrics();
  const weekly = weeklySeries();
  const topUsers = db
    .prepare(
      `SELECT user_code, full_name, email, barangay, address, eco_points FROM users WHERE role = 'household' ORDER BY eco_points DESC LIMIT 5`
    )
    .all()
    .map((u, i) => {
      const addr = u.address || "";
      const barangay = addr
        ? (String(addr).match(/(?:Brgy\.?|Barangay)\s*([^,]+)/i)?.[1]?.trim().slice(0, 120) ||
            String(addr).split(",")[0].trim().replace(/^(?:Brgy\.?|Barangay)\s*/i, "").trim() ||
            addr)
        : u.barangay || "";
      return {
        rank: i + 1,
        id: u.user_code,
        name: u.full_name,
        email: u.email || "",
        barangay,
        address: addr,
        ecoPoints: u.eco_points
      };
    });

  return res.json({
    ok: true,
    metrics,
    weeklyChart: weekly.map(({ day, val }) => ({ day, val })),
    topHouseholds: topUsers
  });
}

export function exportCsv(req, res) {
  const logs = db
    .prepare(
      `
    SELECT wl.log_code, u.user_code, u.full_name, wl.waste_type, wl.weight, wl.status, wl.eco_points_awarded, wl.created_at
    FROM waste_logs wl
    JOIN users u ON u.id = wl.user_id
    ORDER BY wl.created_at DESC
  `
    )
    .all();

  const header = "log_code,user_id,user_name,type_kg,weight,status,points,created_at\n";
  const lines = logs
    .map(
      (r) =>
        `${r.log_code},${r.user_code},"${String(r.full_name).replace(/"/g, '""')}",${r.waste_type},${r.weight},${r.status},${r.eco_points_awarded},${r.created_at}`
    )
    .join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=binbuddy-waste-logs.csv");
  return res.send(header + lines);
}
