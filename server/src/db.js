import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
const dbPath = path.join(dataDir, "binbuddy.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schemaPath = path.join(__dirname, "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");
db.exec(schema);

function ensureUserColumns() {
  const cols = db.prepare("PRAGMA table_info(users)").all();
  const colNames = new Set(cols.map(c => c.name));

  if (!colNames.has("phone_number")) {
    db.exec("ALTER TABLE users ADD COLUMN phone_number TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.has("address")) {
    db.exec("ALTER TABLE users ADD COLUMN address TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.has("gender")) {
    db.exec("ALTER TABLE users ADD COLUMN gender TEXT NOT NULL DEFAULT ''");
    try {
      db.prepare("UPDATE users SET gender = 'female' WHERE user_code = 'USR001'").run();
      db.prepare("UPDATE users SET gender = 'male' WHERE user_code IN ('COL001','ADM001')").run();
    } catch {
      /* ignore if seed users differ */
    }
  }
}

ensureUserColumns();

function ensureWasteLogColumns() {
  const cols = db.prepare("PRAGMA table_info(waste_logs)").all();
  const colNames = new Set(cols.map(c => c.name));
  if (!colNames.has("log_date")) {
    db.exec("ALTER TABLE waste_logs ADD COLUMN log_date TEXT");
  }
  if (!colNames.has("photo_path")) {
    db.exec("ALTER TABLE waste_logs ADD COLUMN photo_path TEXT");
  }
}

ensureWasteLogColumns();

/** SQLite cannot ALTER CHECK; rebuild table once to allow `rejected` status. */
function migrateWasteLogsAllowRejected() {
  const tbl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='waste_logs'").get();
  if (!tbl || !tbl.sql || /'rejected'/i.test(tbl.sql)) return;
  db.exec("PRAGMA foreign_keys=OFF;");
  db.exec("BEGIN IMMEDIATE;");
  db.exec(`
    CREATE TABLE waste_logs__bb_migrate (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_code TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      waste_type TEXT NOT NULL CHECK (waste_type IN ('PET', 'HDPE')),
      weight REAL NOT NULL,
      log_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'rejected')),
      notes TEXT,
      photo_path TEXT,
      verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      eco_points_awarded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    INSERT INTO waste_logs__bb_migrate (
      id, log_code, user_id, waste_type, weight, log_date, status, notes, photo_path, verified_by, eco_points_awarded, created_at, completed_at
    )
    SELECT id, log_code, user_id, waste_type, weight, log_date, status, notes, photo_path, verified_by, eco_points_awarded, created_at, completed_at
    FROM waste_logs;
    DROP TABLE waste_logs;
    ALTER TABLE waste_logs__bb_migrate RENAME TO waste_logs;
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_waste_logs_user ON waste_logs(user_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_waste_logs_status ON waste_logs(status);");
  db.exec("COMMIT;");
  db.exec("PRAGMA foreign_keys=ON;");
}

migrateWasteLogsAllowRejected();

function seedIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (count > 0) return;

  const hash = (p) => bcrypt.hashSync(p, 10);

  const insertUser = db.prepare(`
    INSERT INTO users (user_code, full_name, email, password_hash, phone_number, address, gender, role, eco_points, streak_days, level, barangay)
    VALUES (@user_code, @full_name, @email, @password_hash, @phone_number, @address, @gender, @role, @eco_points, @streak_days, @level, @barangay)
  `);

  insertUser.run({
    user_code: "USR001",
    full_name: "Maria Santos",
    email: "maria@email.com",
    password_hash: hash("password123"),
    phone_number: "09171234567",
    address: "Lipa City, Philippines",
    gender: "female",
    role: "household",
    eco_points: 1245,
    streak_days: 7,
    level: "Eco Hero",
    barangay: "Lipa City"
  });
  insertUser.run({
    user_code: "COL001",
    full_name: "Roberto Cruz",
    email: "collector@email.com",
    password_hash: hash("password123"),
    phone_number: "09171230000",
    address: "Lipa City, Philippines",
    gender: "male",
    role: "collector",
    eco_points: 0,
    streak_days: 0,
    level: null,
    barangay: "Lipa City"
  });
  insertUser.run({
    user_code: "ADM001",
    full_name: "Barangay Administrator",
    email: "admin@email.com",
    password_hash: hash("password123"),
    phone_number: "09179990000",
    address: "Lipa City, Philippines",
    gender: "male",
    role: "admin",
    eco_points: 0,
    streak_days: 0,
    level: null,
    barangay: "Lipa City"
  });

  const u1 = db.prepare("SELECT id FROM users WHERE user_code = ?").get("USR001");
  const col = db.prepare("SELECT id FROM users WHERE user_code = ?").get("COL001");

  db.prepare(`
    INSERT INTO waste_logs (log_code, user_id, waste_type, weight, status, verified_by, eco_points_awarded, completed_at)
    VALUES ('LOG001', ?, 'PET', 1.2, 'completed', ?, 24, datetime('now'))
  `).run(u1.id, col.id);

  db.prepare(`
    INSERT INTO waste_logs (log_code, user_id, waste_type, weight, status, eco_points_awarded)
    VALUES ('LOG002', ?, 'HDPE', 0.8, 'pending', 0)
  `).run(u1.id);

  db.prepare(`
    INSERT INTO waste_logs (log_code, user_id, waste_type, weight, status, verified_by, eco_points_awarded)
    VALUES ('LOG003', ?, 'PET', 0.5, 'rejected', ?, 0)
  `).run(u1.id, col.id);

  db.prepare(`
    INSERT INTO rewards (reward_code, name, display_label, points_required, category) VALUES
    ('RWD-LOAD-50', 'Mobile Load', '₱50 Load', 500, 'load'),
    ('RWD-VOUCH-100', 'Voucher', '₱100 Voucher', 1000, 'voucher'),
    ('RWD-GCASH-75', 'GCash', '₱75 GCash', 750, 'gcash')
  `).run();
}

seedIfEmpty();
