const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const webRoot = path.join(__dirname, '..');
const JWT_SECRET = process.env.JWT_SECRET || 'binbuddy-dev-secret';
let dbConnected = false;
let lastDbError = '';
let lastDbPingMs = null;

function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        })
    ]);
}

const usersColumnInfo = {
    loaded: false,
    set: new Set()
};

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json({ limit: '2mb' }));
const staticMw = express.static(webRoot, { index: 'index.html', extensions: ['html'] });
app.use((req, res, next) => {
    const p = String(req.path || '');
    if (p === '/api' || p.startsWith('/api/')) return next();
    return staticMw(req, res, next);
});

const ALLOWED_ROLES = new Set(['household', 'collector', 'admin', 'user']);
const normalizeRole = (role) => {
    const value = String(role || '').trim().toLowerCase();
    if (!value) return 'household';
    return ALLOWED_ROLES.has(value) ? value : null;
};

/** DB ENUM is household | collector | admin */
const mapRoleToDb = (role) => {
    const r = normalizeRole(role);
    if (!r || r === 'user') return 'household';
    if (r === 'collector' || r === 'admin') return r;
    return 'household';
};

/** Frontend treats "user" as household */
const mapRoleForClient = (role) => {
    const r = String(role || '').trim().toLowerCase();
    if (r === 'user') return 'household';
    if (r === 'collector' || r === 'admin') return r;
    return 'household';
};

const transient = {
    notifications: [],
    rewards: [
        { id: 'RWD-EMONEY-50', display: '₱50 E-Money', cost: 500 },
        { id: 'RWD-EMONEY-100', display: '₱100 E-Money', cost: 1000 },
        { id: 'RWD-EMONEY-75', display: '₱75 E-Money', cost: 750 }
    ]
};

const redemptionUploadDir = path.join(__dirname, 'uploads', 'redemptions');
if (!fs.existsSync(redemptionUploadDir)) {
    fs.mkdirSync(redemptionUploadDir, { recursive: true });
}

const wasteLogsUploadDir = path.join(__dirname, 'uploads', 'waste_logs');
if (!fs.existsSync(wasteLogsUploadDir)) {
    fs.mkdirSync(wasteLogsUploadDir, { recursive: true });
}

/** Save household waste-log photo (data URL from client). Returns stored filename or null. */
function persistWasteLogPhotoDataUrl(photoDataUrl, photoFileName) {
    if (!photoDataUrl || typeof photoDataUrl !== 'string') return null;
    const match = String(photoDataUrl).match(/^data:(image\/(?:jpeg|png));base64,(.+)$/i);
    if (!match) return null;
    const mime = match[1].toLowerCase();
    const buf = Buffer.from(match[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) {
        throw new Error('Photo must be 2MB or smaller');
    }
    const ext = mime === 'image/png' ? '.png' : '.jpg';
    const safeBase =
        String(photoFileName || 'waste')
            .replace(/[^a-z0-9._-]/gi, '_')
            .slice(0, 40) || 'waste';
    const fname = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${safeBase}${ext}`;
    const full = path.join(wasteLogsUploadDir, fname);
    fs.writeFileSync(full, buf);
    return fname;
}

const redemptionUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, redemptionUploadDir),
        filename: (_req, file, cb) => {
            const ext = path.extname(String(file.originalname || '')).slice(0, 8) || '.jpg';
            cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
        }
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = /^image\//i.test(file.mimetype || '');
        cb(ok ? null : new Error('Please upload an image file (e.g. photo of QR).'), ok);
    }
});

const redemptionPhotoUploadMw = (req, res, next) => {
    redemptionUpload.single('photo')(req, res, (err) => {
        if (err) return res.status(400).json({ message: String(err.message || 'Upload failed') });
        next();
    });
};

// --- DATABASE ---
const caPath = path.join(__dirname, 'ca.pem');
const sslDisabled = String(process.env.DB_SSL_DISABLE || '').toLowerCase() === '1' || String(process.env.DB_SSL_DISABLE || '').toLowerCase() === 'true';
const caFromEnv = String(process.env.DB_CA_PEM || '').trim();
const sslOptions = sslDisabled
    ? undefined
    : caFromEnv
      ? { ca: caFromEnv, rejectUnauthorized: true }
      : fs.existsSync(caPath)
        ? { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true }
        : { rejectUnauthorized: true };

const poolConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'defaultdb',
    port: Number(process.env.DB_PORT || 17100),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 15000),
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
};
if (sslOptions !== undefined) poolConfig.ssl = sslOptions;

const pool = mysql.createPool(poolConfig);

/** Non-blocking ping so /api/health responds immediately (client probes use sub-second timeouts). */
function kickDbConnectivityProbe() {
    const pingMs = Number(process.env.DB_PING_TIMEOUT_MS || 12000);
    const t0 = Date.now();
    void withTimeout(pool.query('SELECT 1'), pingMs, 'MySQL ping')
        .then(() => {
            dbConnected = true;
            lastDbError = '';
            lastDbPingMs = Date.now() - t0;
        })
        .catch((e) => {
            dbConnected = false;
            lastDbError = e?.message || String(e);
            lastDbPingMs = null;
        });
}

app.get('/api/health', (_req, res) => {
    kickDbConnectivityProbe();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        success: true,
        ok: true,
        message: 'BinBuddy backend is running',
        dbConnected,
        ...(lastDbPingMs != null ? { dbPingMs: lastDbPingMs } : {}),
        dbError: process.env.NODE_ENV === 'production' && !dbConnected ? 'unavailable' : lastDbError || undefined,
        env: {
            hasDbHost: Boolean(process.env.DB_HOST),
            dbName: process.env.DB_NAME || 'defaultdb',
            dbPort: Number(process.env.DB_PORT || 17100),
            ssl: sslDisabled ? 'off' : fs.existsSync(caPath) ? 'ca.pem' : 'default-trust-store'
        }
    });
});

const supportsUsersColumn = (name) => usersColumnInfo.loaded && usersColumnInfo.set.has(name);

/** When column metadata is not loaded yet (or introspection failed), assume sql/aiven-reset-binbuddy.sql shape — not `password`. */
const usersIdColumn = () => {
    if (!usersColumnInfo.loaded) return 'id';
    if (supportsUsersColumn('id')) return 'id';
    if (supportsUsersColumn('user_id')) return 'user_id';
    return 'id';
};

const usersPasswordColumn = () => {
    if (!usersColumnInfo.loaded) return 'password_hash';
    if (supportsUsersColumn('password_hash')) return 'password_hash';
    if (supportsUsersColumn('password')) return 'password';
    return 'password_hash';
};

const hashPasswordValue = (value) =>
    usersPasswordColumn() === 'password_hash'
        ? crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
        : value;

function ecoPointsForLog(wasteType, weight) {
    const w = Number(weight || 0);
    const t = String(wasteType || '').toUpperCase();
    const mult = t === 'HDPE' ? 25 : 20;
    return Math.round(w * mult);
}

const buildUserSelectColumns = () => {
    const idCol = usersIdColumn();
    const cols = [`${idCol} AS id`, 'full_name', 'email', 'role', 'eco_points', 'level'];
    if (!usersColumnInfo.loaded) {
        return cols
            .concat(['streak_days', 'barangay', 'phone_number', 'mobile', 'address', 'gender'])
            .join(', ');
    }
    if (supportsUsersColumn('streak')) cols.push('streak');
    if (supportsUsersColumn('streak_days')) cols.push('streak_days');
    if (supportsUsersColumn('barangay')) cols.push('barangay');
    if (supportsUsersColumn('phone_number')) cols.push('phone_number');
    if (supportsUsersColumn('mobile')) cols.push('mobile');
    if (supportsUsersColumn('address')) cols.push('address');
    if (supportsUsersColumn('gender')) cols.push('gender');
    return cols.join(', ');
};

const readUsersColumns = async () => {
    try {
        const [rows] = await pool.query(
            `SELECT COLUMN_NAME
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
        );
        usersColumnInfo.set = new Set(rows.map((r) => String(r.COLUMN_NAME || '').toLowerCase()));
        usersColumnInfo.loaded = true;
        console.log(`ℹ️ users columns: ${Array.from(usersColumnInfo.set).join(', ')}`);
    } catch (err) {
        console.error('⚠️ Could not read users metadata:', err?.message || String(err));
        usersColumnInfo.loaded = false;
        usersColumnInfo.set = new Set();
    }
};

const barangayFromAddress = (address) => {
    const s = String(address || '').trim();
    if (!s) return '';
    const m = s.match(/(?:Brgy\.?|Barangay)\s*([^,]+)/i);
    if (m) return (m[1].trim().slice(0, 120)) || '';
    const first = s.split(',')[0].trim();
    const n = first.replace(/^(?:Brgy\.?|Barangay)\s*/i, '').trim() || first;
    return n.slice(0, 120);
};

const resolveUserBarangay = (user = {}) => {
    const addr = String(user.address || '').trim();
    if (addr) return barangayFromAddress(addr) || addr;
    return String(user.barangay || '').trim();
};

const normalizeUserRow = (user = {}) => {
    const eco = Number(user.eco_points || 0);
    const address = user.address || '';
    return {
        ...user,
        id: user.id,
        name: user.full_name || user.email,
        ecoPoints: eco,
        streak: Number(user.streak ?? user.streak_days ?? 0),
        badge: user.level || 'Eco Starter',
        barangay: resolveUserBarangay(user),
        phoneNumber: user.phone_number || user.mobile || '',
        address,
        gender: user.gender || '',
        role: mapRoleForClient(user.role)
    };
};

async function ensureWasteLogsTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS waste_logs (
            log_id VARCHAR(48) NOT NULL PRIMARY KEY,
            user_id INT UNSIGNED NOT NULL,
            user_name VARCHAR(200) DEFAULT NULL,
            waste_type VARCHAR(20) NOT NULL,
            weight DECIMAL(10, 2) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'Pending',
            eco_points_awarded INT NOT NULL DEFAULT 0,
            verified_by INT UNSIGNED DEFAULT NULL,
            notes TEXT,
            log_date DATETIME DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME DEFAULT NULL,
            KEY idx_waste_logs_user (user_id),
            KEY idx_waste_logs_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

async function ensureWasteLogsPhotoColumn() {
    try {
        const [cols] = await pool.query(`SHOW COLUMNS FROM waste_logs LIKE 'photo_filename'`);
        if (!cols.length) {
            await pool.query(
                `ALTER TABLE waste_logs ADD COLUMN photo_filename VARCHAR(255) NULL DEFAULT NULL AFTER notes`
            );
            console.log('✅ waste_logs.photo_filename column added');
        }
        const [ccols] = await pool.query(`SHOW COLUMNS FROM waste_logs LIKE 'collector_photo_filename'`);
        if (!ccols.length) {
            await pool.query(
                `ALTER TABLE waste_logs ADD COLUMN collector_photo_filename VARCHAR(255) NULL DEFAULT NULL AFTER photo_filename`
            );
            console.log('✅ waste_logs.collector_photo_filename column added');
        }
    } catch (err) {
        console.error('❌ ensureWasteLogsPhotoColumn:', err.message);
    }
}

/** Metadata for QR reward uploads; rows survive process restarts (see sql/mysql-workbench-reward-redemptions.sql). */
async function ensureRewardRedemptionsTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS reward_redemptions (
          redemption_id   VARCHAR(32) NOT NULL PRIMARY KEY,
          user_id          INT UNSIGNED NOT NULL,
          user_name       VARCHAR(200) NOT NULL,
          user_email      VARCHAR(190) NOT NULL DEFAULT '',
          reward_id       VARCHAR(64) NOT NULL,
          reward_display  VARCHAR(200) NOT NULL,
          cost_points     INT UNSIGNED NOT NULL,
          photo_filename  VARCHAR(255) NOT NULL,
          status          VARCHAR(20) NOT NULL DEFAULT 'pending',
          created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_reward_redemptions_user (user_id),
          KEY idx_reward_redemptions_created (created_at),
          KEY idx_reward_redemptions_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

function mapWasteLogRow(row) {
    const toIso = (v) => (v ? new Date(v).toISOString() : null);
    return {
        id: row.log_id,
        userId: row.user_id,
        userName: row.user_name || '',
        type: row.waste_type,
        weight: Number(row.weight),
        status: row.status,
        ecoPointsAwarded: Number(row.eco_points_awarded || 0),
        verifiedBy: row.verified_by,
        verifiedByName: row.verifier_name ? String(row.verifier_name).trim() || null : null,
        notes: row.notes || '',
        createdAt: toIso(row.created_at),
        logDate: toIso(row.log_date),
        completedAt: toIso(row.completed_at),
        hasPhoto: Boolean(row.photo_filename),
        hasCollectorPhoto: Boolean(row.collector_photo_filename)
    };
}

const collectorCollectionUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, wasteLogsUploadDir),
        filename: (_req, file, cb) => {
            const ext = path.extname(String(file.originalname || '')).toLowerCase();
            const safeExt = ext === '.png' ? '.png' : '.jpg';
            cb(null, `collector-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`);
        }
    }),
    limits: { fileSize: 4 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const ok = /^image\/(jpeg|png|webp)$/i.test(file.mimetype || '');
        cb(ok ? null : new Error('Upload a JPG or PNG photo of the collected waste.'), ok);
    }
});

const collectorCollectionUploadMw = (req, res, next) => {
    collectorCollectionUpload.single('photo')(req, res, (err) => {
        if (err) return res.status(400).json({ message: String(err.message || 'Upload failed') });
        next();
    });
};

(async () => {
    try {
        const connection = await pool.getConnection();
        dbConnected = true;
        console.log('🚀 BinBuddy connected to Aiven MySQL');
        connection.release();
        await readUsersColumns();
        await ensureWasteLogsTable();
        await ensureWasteLogsPhotoColumn();
        await ensureRewardRedemptionsTable();
        await ensureAdminAccount();
    } catch (err) {
        dbConnected = false;
        lastDbError = err?.message || String(err);
        console.error('❌ DATABASE CONNECTION:', err?.code || err?.message || String(err));
    }
})();

async function ensureAdminAccount() {
    const email = String(process.env.BINBUDDY_ADMIN_EMAIL || 'admin@email.com').trim().toLowerCase();
    const pw = String(process.env.BINBUDDY_ADMIN_PASSWORD || 'password123');
    if (!email || !pw) return;
    try {
        if (!usersColumnInfo.loaded) await readUsersColumns();
        const pwdCol = usersPasswordColumn();
        const pwdVal = hashPasswordValue(pw);
        const [[row]] = await pool.query(`SELECT ${usersIdColumn()} AS id FROM users WHERE LOWER(email)=LOWER(?) LIMIT 1`, [email]);
        if (row && row.id) return;
        await pool.query(
            `INSERT INTO users (full_name, email, ${pwdCol}, role, eco_points, level, barangay, streak_days)
             VALUES (?, ?, ?, 'admin', 0, 'Eco Starter', 'Lipa City', 0)`,
            ['Barangay Administrator', email, pwdVal]
        );
        console.log(`🛡️ Ensured admin account exists: ${email}`);
    } catch (e) {
        console.error('⚠️ Could not ensure admin account:', e?.message || String(e));
    }
}

async function resolveInsertedUserId(insertResult, cleanEmail) {
    let id = insertResult.insertId;
    if (id) return id;
    const idCol = usersIdColumn();
    const [rows] = await pool.query(`SELECT ${idCol} AS id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1`, [cleanEmail]);
    return rows[0]?.id;
}

const createToken = (user) =>
    jwt.sign(
        {
            id: user.id,
            email: user.email,
            role: mapRoleForClient(user.role)
        },
        JWT_SECRET,
        { expiresIn: '7d' }
    );

const authRequired = (req, res, next) => {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return res.status(401).json({ message: 'Missing token' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        return next();
    } catch (_err) {
        return res.status(401).json({ message: 'Invalid token' });
    }
};

async function requireDb(req, res, next) {
    const pingMs = Number(process.env.DB_PING_TIMEOUT_MS || 12000);
    try {
        await withTimeout(pool.query('SELECT 1'), pingMs, 'MySQL ping');
        dbConnected = true;
        lastDbError = '';
        return next();
    } catch (e) {
        dbConnected = false;
        lastDbError = e?.message || String(e);
        const hint =
            'Database unavailable — check server/.env (DB_HOST, DB_PORT, DB_USER, DB_PASSWORD), run sql/aiven-reset-binbuddy.sql on Aiven, and ensure this machine can reach Aiven (VPN / IP allowlist).';
        return res.status(503).json({
            message: hint,
            code: e?.code || undefined,
            detail: process.env.NODE_ENV === 'production' ? undefined : lastDbError
        });
    }
}

const requireRoles =
    (...roles) =>
        (req, res, next) => {
            const r = mapRoleForClient(req.user.role);
            if (!roles.includes(r)) return res.status(403).json({ message: 'Not allowed for this role' });
            return next();
        };

// --- ROUTES ---

app.post('/api/auth/register', requireDb, async (req, res) => {
    const { name, email, password, role, phoneNumber, address, gender } = req.body || {};
    const userRole = normalizeRole(role);
    const dbRole = mapRoleToDb(role);
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanName = String(name || '').trim() || 'New User';
    const cleanPassword = String(password || '');
    const cleanPhone = String(phoneNumber || '').trim();
    const cleanAddress = String(address || '').trim();
    const cleanGender = String(gender || '').trim().toLowerCase();

    if (!cleanEmail || !cleanPassword) {
        return res.status(400).json({ success: false, message: 'Missing email or password' });
    }
    if (!userRole) {
        return res.status(400).json({ success: false, message: 'Invalid role selected' });
    }

    try {
        if (!usersColumnInfo.loaded) await readUsersColumns();

        const insertColumns = ['full_name', 'email', usersPasswordColumn(), 'role', 'eco_points', 'level'];
        const insertValues = [cleanName, cleanEmail, hashPasswordValue(cleanPassword), dbRole, 0, 'Seedling'];
        const genderVal = cleanGender === 'male' || cleanGender === 'female' ? cleanGender : null;
        const registeredBarangay = barangayFromAddress(cleanAddress) || cleanAddress;

        if (!usersColumnInfo.loaded) {
            insertColumns.push('mobile', 'phone_number', 'address', 'gender', 'barangay', 'streak_days');
            insertValues.push(cleanPhone, cleanPhone, cleanAddress, genderVal, registeredBarangay, 0);
        } else {
            if (supportsUsersColumn('phone_number')) {
                insertColumns.push('phone_number');
                insertValues.push(cleanPhone);
            } else if (supportsUsersColumn('mobile')) {
                insertColumns.push('mobile');
                insertValues.push(cleanPhone);
            }

            if (supportsUsersColumn('address')) {
                insertColumns.push('address');
                insertValues.push(cleanAddress);
            }

            if (supportsUsersColumn('gender')) {
                insertColumns.push('gender');
                insertValues.push(genderVal);
            }

            if (supportsUsersColumn('barangay')) {
                insertColumns.push('barangay');
                insertValues.push(registeredBarangay);
            }

            if (supportsUsersColumn('streak_days')) {
                insertColumns.push('streak_days');
                insertValues.push(0);
            }
        }

        const placeholders = insertColumns.map(() => '?').join(', ');
        const query = `INSERT INTO users (${insertColumns.join(', ')}) VALUES (${placeholders})`;
        const [result] = await pool.query(query, insertValues);

        const newId = await resolveInsertedUserId(result, cleanEmail);
        const user = {
            id: newId,
            full_name: cleanName,
            email: cleanEmail,
            role: dbRole,
            eco_points: 0,
            level: 'Seedling',
            streak_days: 0,
            barangay: registeredBarangay,
            phone_number: cleanPhone,
            address: cleanAddress,
            gender: cleanGender === 'male' || cleanGender === 'female' ? cleanGender : ''
        };
        const token = createToken({ ...user, role: dbRole });

        console.log(`👤 Registered: ${cleanEmail} (${dbRole})`);
        res.status(201).json({ success: true, ok: true, role: mapRoleForClient(dbRole), user: normalizeUserRow(user), token });
    } catch (err) {
        console.error('❌ Registration:', err.code || err.message, err.sqlMessage || '');
        res.status(500).json({
            success: false,
            ok: false,
            message:
                err.code === 'ER_DUP_ENTRY'
                    ? 'Email already exists'
                    : err.code === 'ER_BAD_FIELD_ERROR'
                      ? 'Database schema mismatch — run sql/aiven-reset-binbuddy.sql on your Aiven database.'
                      : 'Database error',
            detail: process.env.NODE_ENV === 'production' ? undefined : err.message
        });
    }
});

app.post('/api/auth/login', requireDb, async (req, res) => {
    const { email, password, role } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanPassword = String(password || '');
    const selectedRole = role != null && String(role).trim() !== '' ? mapRoleToDb(role) : null;

    if (!cleanEmail || !cleanPassword) {
        return res.status(400).json({ success: false, ok: false, message: 'Missing email or password' });
    }

    try {
        if (!usersColumnInfo.loaded) await readUsersColumns();

        const baseSelect = buildUserSelectColumns();
        const pwdCol = usersPasswordColumn();
        const pwdValue = hashPasswordValue(cleanPassword);

        let rows;
        if (selectedRole) {
            [rows] = await pool.query(
                `SELECT ${baseSelect} FROM users WHERE LOWER(email) = LOWER(?) AND ${pwdCol} = ? AND role = ? LIMIT 1`,
                [cleanEmail, pwdValue, selectedRole]
            );
        } else {
            [rows] = await pool.query(
                `SELECT ${baseSelect} FROM users WHERE LOWER(email) = LOWER(?) AND ${pwdCol} = ? LIMIT 1`,
                [cleanEmail, pwdValue]
            );
        }

        if (!rows.length) {
            return res.status(401).json({ success: false, ok: false, message: 'Invalid email, password, or role' });
        }
        const normalizedUser = normalizeUserRow(rows[0]);
        if (selectedRole && String(rows[0].role).toLowerCase() !== String(selectedRole).toLowerCase()) {
            return res.status(401).json({
                success: false,
                ok: false,
                message: 'Wrong role selected — pick the role that matches this email (Household / Collector / Admin)'
            });
        }
        const token = createToken(rows[0]);
        console.log(`✅ Login: ${normalizedUser.name || normalizedUser.email}`);
        res.json({ success: true, ok: true, user: normalizedUser, token });
    } catch (err) {
        console.error('❌ Login:', err.message);
        res.status(500).json({ success: false, ok: false, message: 'Server error' });
    }
});

app.get('/api/auth/me', authRequired, requireDb, async (req, res) => {
    try {
        if (!usersColumnInfo.loaded) await readUsersColumns();
        const baseSelect = buildUserSelectColumns();
        const idCol = usersIdColumn();
        const [rows] = await pool.query(`SELECT ${baseSelect} FROM users WHERE ${idCol} = ? LIMIT 1`, [req.user.id]);
        if (!rows.length) return res.status(404).json({ message: 'User not found' });
        return res.json({ user: normalizeUserRow(rows[0]) });
    } catch (err) {
        return res.status(500).json({ message: err.message || 'Server error' });
    }
});

app.get('/api/logs', authRequired, requireDb, async (req, res) => {
    try {
        await readUsersColumns();
        const viewer = mapRoleForClient(req.user.role);
        const uid = Number(req.user.id);
        const idCol = usersIdColumn();
        const wlSelect = `
            wl.log_id, wl.user_id, wl.user_name, wl.waste_type, wl.weight, wl.status, wl.eco_points_awarded,
            wl.verified_by, wl.notes, wl.photo_filename, wl.collector_photo_filename, wl.log_date, wl.created_at, wl.completed_at,
            vu.full_name AS verifier_name
        `;
        const wlJoin = `FROM waste_logs wl LEFT JOIN users vu ON vu.${idCol} = wl.verified_by`;
        let rows;
        if (viewer === 'collector' || viewer === 'admin') {
            [rows] = await pool.query(
                `SELECT ${wlSelect} ${wlJoin} ORDER BY wl.created_at DESC LIMIT 500`
            );
        } else {
            [rows] = await pool.query(
                `SELECT ${wlSelect} ${wlJoin} WHERE wl.user_id = ? ORDER BY wl.created_at DESC LIMIT 200`,
                [uid]
            );
        }
        res.json({ logs: rows.map(mapWasteLogRow) });
    } catch (err) {
        console.error('❌ GET /logs:', err.message);
        res.status(500).json({ message: err.message || 'Server error', logs: [] });
    }
});

app.get('/api/logs/:id/collector-photo', authRequired, requireDb, async (req, res) => {
    const logId = String(req.params.id || '');
    const viewer = mapRoleForClient(req.user.role);
    const uid = Number(req.user.id);
    try {
        const [rows] = await pool.query(
            `SELECT log_id, user_id, verified_by, collector_photo_filename FROM waste_logs WHERE log_id = ? LIMIT 1`,
            [logId]
        );
        if (!rows.length || !rows[0].collector_photo_filename) {
            return res.status(404).json({ message: 'Collector photo not found' });
        }
        const row = rows[0];
        if (viewer === 'collector' || viewer === 'admin') {
            /* ok */
        } else if (viewer === 'household' && Number(row.user_id) === uid) {
            /* household may view proof for their log */
        } else {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const safeName = path.basename(String(row.collector_photo_filename));
        const filePath = path.join(wasteLogsUploadDir, safeName);
        if (!safeName || !fs.existsSync(filePath)) {
            return res.status(404).json({ message: 'Photo missing on server' });
        }
        const ext = path.extname(safeName).toLowerCase();
        const ctype = ext === '.png' ? 'image/png' : 'image/jpeg';
        res.setHeader('Content-Type', ctype);
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        console.error('❌ GET collector photo:', err.message);
        return res.status(500).json({ message: err.message || 'Server error' });
    }
});

app.get('/api/logs/:id/photo', authRequired, requireDb, async (req, res) => {
    const logId = String(req.params.id || '');
    const viewer = mapRoleForClient(req.user.role);
    const uid = Number(req.user.id);
    try {
        const [rows] = await pool.query(
            `SELECT log_id, user_id, photo_filename FROM waste_logs WHERE log_id = ? LIMIT 1`,
            [logId]
        );
        if (!rows.length || !rows[0].photo_filename) {
            return res.status(404).json({ message: 'Photo not found' });
        }
        const row = rows[0];
        if (viewer === 'collector' || viewer === 'admin') {
            /* ok */
        } else if (viewer === 'household' && Number(row.user_id) === uid) {
            /* household may view own proof */
        } else {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const safeName = path.basename(String(row.photo_filename));
        const filePath = path.join(wasteLogsUploadDir, safeName);
        if (!safeName || !fs.existsSync(filePath)) {
            return res.status(404).json({ message: 'Photo missing on server' });
        }
        const ext = path.extname(safeName).toLowerCase();
        const ctype = ext === '.png' ? 'image/png' : 'image/jpeg';
        res.setHeader('Content-Type', ctype);
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        console.error('❌ GET log photo:', err.message);
        return res.status(500).json({ message: err.message || 'Server error' });
    }
});

app.post('/api/logs', authRequired, requireDb, requireRoles('household'), async (req, res) => {
    const body = req.body || {};
    const wt = body.wasteType === 'rec' ? 'HDPE' : 'PET';
    const weight = Number(body.weight || 0);
    if (!(weight > 0)) return res.status(400).json({ message: 'Invalid weight' });

    const uid = Number(req.user.id);
    try {
        let photoFilename = null;
        try {
            photoFilename = persistWasteLogPhotoDataUrl(body.photoDataUrl, body.photoFileName);
        } catch (photoErr) {
            console.error('❌ POST /logs photo:', photoErr.message);
            return res.status(400).json({ message: photoErr.message || 'Invalid photo' });
        }
        if (!photoFilename) {
            return res.status(400).json({
                message: 'Waste log photo is required. Add a JPG or PNG image of your segregated waste.'
            });
        }

        const [urows] = await pool.query(`SELECT ${usersIdColumn()} AS id, full_name, email FROM users WHERE ${usersIdColumn()} = ?`, [
            uid
        ]);
        const urow = urows[0];
        const displayName = (urow?.full_name || urow?.email || req.user.email || '').trim() || 'User';

        const logId = `LOG${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
        let logDate = body.logDate ? new Date(body.logDate) : new Date();
        if (Number.isNaN(logDate.getTime())) logDate = new Date();

        await pool.query(
            `INSERT INTO waste_logs (log_id, user_id, user_name, waste_type, weight, status, notes, log_date, photo_filename)
             VALUES (?, ?, ?, ?, ?, 'Pending', ?, ?, ?)`,
            [
                logId,
                uid,
                displayName,
                wt,
                weight,
                String(body.notes || '').slice(0, 2000),
                logDate,
                photoFilename
            ]
        );

        const [rows] = await pool.query(`SELECT * FROM waste_logs WHERE log_id = ?`, [logId]);
        const log = mapWasteLogRow(rows[0]);
        res.status(201).json({ log });
    } catch (err) {
        console.error('❌ POST /logs:', err.message);
        res.status(500).json({ message: err.message || 'Could not save log' });
    }
});

app.post(
    '/api/logs/:id/collection-proof',
    authRequired,
    requireDb,
    requireRoles('collector'),
    collectorCollectionUploadMw,
    async (req, res) => {
        const logId = String(req.params.id || '');
        const verifierId = Number(req.user.id);
        if (!req.file || !req.file.filename) {
            return res.status(400).json({ message: 'Collection photo is required.' });
        }
        const collectorPhoto = path.basename(String(req.file.filename));

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const [found] = await conn.query(`SELECT * FROM waste_logs WHERE log_id = ? FOR UPDATE`, [logId]);
            if (!found.length) {
                await conn.rollback();
                return res.status(404).json({ message: 'Log not found' });
            }
            const logRow = found[0];
            const st = String(logRow.status || '');
            if (st === 'Completed') {
                await conn.rollback();
                return res.status(400).json({ message: 'This log is already verified.' });
            }

            const pts = ecoPointsForLog(logRow.waste_type, logRow.weight);
            const completedAt = new Date();

            await conn.query(
                `UPDATE waste_logs SET status = 'Completed', eco_points_awarded = ?, verified_by = ?, completed_at = ?, collector_photo_filename = ? WHERE log_id = ?`,
                [pts, verifierId, completedAt, collectorPhoto, logId]
            );

            if (pts > 0) {
                await conn.query(`UPDATE users SET eco_points = eco_points + ? WHERE ${usersIdColumn()} = ?`, [
                    pts,
                    logRow.user_id
                ]);
            }

            await conn.commit();
            const [updRows] = await pool.query(`SELECT * FROM waste_logs WHERE log_id = ?`, [logId]);
            return res.json({
                ok: true,
                message: 'Collection proof sent to admin. Household EcoPoints awarded.',
                log: mapWasteLogRow(updRows[0])
            });
        } catch (err) {
            await conn.rollback();
            console.error('❌ POST collection-proof:', err.message);
            return res.status(500).json({ message: err.message || 'Could not submit collection proof' });
        } finally {
            conn.release();
        }
    }
);

app.patch('/api/logs/:id/verify', authRequired, requireDb, requireRoles('collector', 'admin'), async (req, res) => {
    const logId = String(req.params.id || '');
    const approve = Boolean(req.body?.approve);
    const verifierId = Number(req.user.id);

    if (approve) {
        return res.status(400).json({
            message: 'Upload a collection photo to verify. Use Submit collection proof on the pickup card.'
        });
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [found] = await conn.query(`SELECT * FROM waste_logs WHERE log_id = ? FOR UPDATE`, [logId]);
        if (!found.length) {
            await conn.rollback();
            return res.status(404).json({ message: 'Log not found' });
        }
        const logRow = found[0];
        const pts = 0;
        const status = 'Rejected';
        const completedAt = null;

        await conn.query(
            `UPDATE waste_logs SET status = ?, eco_points_awarded = ?, verified_by = ?, completed_at = ? WHERE log_id = ?`,
            [status, pts, verifierId, completedAt, logId]
        );

        await conn.commit();
        const [updRows] = await pool.query(`SELECT * FROM waste_logs WHERE log_id = ?`, [logId]);
        return res.json({ log: mapWasteLogRow(updRows[0]) });
    } catch (err) {
        await conn.rollback();
        console.error('❌ PATCH verify:', err.message);
        return res.status(500).json({ message: err.message || 'Verify failed' });
    } finally {
        conn.release();
    }
});

app.get('/api/notifications', authRequired, (req, res) => {
    const mine = transient.notifications.filter((n) => String(n.userId) === String(req.user.id));
    res.json({ notifications: mine });
});

app.get('/api/leaderboard', authRequired, requireDb, async (_req, res) => {
    try {
        const idCol = usersIdColumn();
        const [rows] = await pool.query(
            `
            SELECT
              u.${idCol} AS id,
              u.full_name AS name,
              u.eco_points AS ecoPoints,
              COALESCE(u.barangay, '') AS barangay,
              COALESCE(u.address, '') AS address,
              COALESCE(SUM(CASE WHEN wl.status = 'Completed' THEN 1 ELSE 0 END), 0) AS completedDisposals,
              COALESCE(SUM(CASE WHEN wl.status = 'Completed' THEN wl.weight ELSE 0 END), 0) AS completedKg
            FROM users u
            LEFT JOIN waste_logs wl ON wl.user_id = u.${idCol}
            WHERE u.role = 'household'
            GROUP BY u.${idCol}, u.full_name, u.eco_points, u.barangay, u.address
            ORDER BY u.eco_points DESC
            LIMIT 50
        `
        );
        return res.json({
            leaderboard: rows.map((r) => ({
                id: r.id,
                name: r.name,
                barangay: resolveUserBarangay(r),
                address: r.address != null ? String(r.address) : '',
                ecoPoints: Number(r.ecoPoints || 0),
                completedDisposals: Number(r.completedDisposals ?? 0) || 0,
                completedKg: Number(Number(r.completedKg ?? 0).toFixed(2))
            }))
        });
    } catch (_err) {
        return res.json({ leaderboard: [] });
    }
});

app.get('/api/rewards', authRequired, (_req, res) => {
    res.json({ rewards: transient.rewards });
});

app.post(
    '/api/rewards/redeem',
    authRequired,
    requireDb,
    requireRoles('household'),
    redemptionPhotoUploadMw,
    async (req, res) => {
        const unlinkIfFile = () => {
            try {
                if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            } catch (_e) {
                /* ignore */
            }
        };
        try {
            if (!req.file) return res.status(400).json({ message: 'Photo required — take or choose a picture of your e-money QR code.' });

            const rewardId = String(req.body?.rewardId ?? req.body?.reward_id ?? '').trim();
            const reward = transient.rewards.find((r) => r.id === rewardId);
            if (!reward) {
                unlinkIfFile();
                return res.status(400).json({ message: 'Invalid reward.' });
            }

            if (!usersColumnInfo.loaded) await readUsersColumns();
            const idCol = usersIdColumn();
            const uid = req.user.id;
            const [[urow]] = await pool.query(
                `SELECT ${idCol} AS id, eco_points AS eco, full_name AS fullName, email FROM users WHERE ${idCol} = ? LIMIT 1`,
                [uid]
            );
            if (!urow) {
                unlinkIfFile();
                return res.status(404).json({ message: 'User not found.' });
            }

            const pts = Number(urow.eco || 0);
            if (pts < reward.cost) {
                unlinkIfFile();
                return res.status(400).json({ message: 'Not enough EcoPoints for this reward.' });
            }

            await pool.query(`UPDATE users SET eco_points = GREATEST(0, eco_points - ?) WHERE ${idCol} = ?`, [reward.cost, uid]);

            const redemptionId = `RDM${crypto.randomBytes(8).toString('hex')}`;
            const userName = String(urow.fullName || urow.email || req.user.email || 'User').trim();
            const userEmail = String(urow.email || '');
            try {
                await pool.query(
                    `INSERT INTO reward_redemptions (redemption_id, user_id, user_name, user_email, reward_id, reward_display, cost_points, photo_filename, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
                    [
                        redemptionId,
                        urow.id,
                        userName,
                        userEmail,
                        reward.id,
                        reward.display,
                        reward.cost,
                        req.file.filename
                    ]
                );
            } catch (insErr) {
                console.error('❌ reward_redemptions INSERT:', insErr?.message || insErr);
                unlinkIfFile();
                try {
                    await pool.query(`UPDATE users SET eco_points = eco_points + ? WHERE ${idCol} = ?`, [reward.cost, uid]);
                } catch (_re) {
                    /* best-effort rollback */
                }
                return res.status(500).json({
                    message:
                        'Could not save redemption. Run sql/mysql-workbench-reward-redemptions.sql on your database, then try again.'
                });
            }

            transient.notifications.unshift({
                userId: String(urow.id),
                text: `Reward request submitted: ${reward.display} (${reward.cost} EcoPoints). Waiting for admin review.`,
                createdAt: new Date().toISOString(),
                redemptionId
            });

            return res.json({
                ok: true,
                reward: { id: reward.id, display: reward.display, cost: reward.cost },
                redemptionId
            });
        } catch (err) {
            unlinkIfFile();
            console.error('❌ POST /rewards/redeem:', err?.message || err);
            return res.status(500).json({ message: err?.message || 'Redemption failed' });
        }
    }
);

app.get('/api/admin/reward-redemptions', authRequired, requireDb, requireRoles('admin'), async (_req, res) => {
    try {
        const [rows] = await pool.query(
            `
            SELECT
              redemption_id AS id,
              user_id AS userId,
              user_name AS userName,
              user_email AS userEmail,
              reward_id AS rewardId,
              reward_display AS rewardDisplay,
              cost_points AS cost,
              status,
              created_at AS createdAtRaw
            FROM reward_redemptions
            ORDER BY created_at DESC
            LIMIT 300
            `
        );
        const requests = rows.map((r) => ({
            id: r.id,
            userId: r.userId,
            userName: r.userName,
            userEmail: r.userEmail,
            rewardId: r.rewardId,
            rewardDisplay: r.rewardDisplay,
            cost: r.cost,
            status: String(r.status || 'pending').toLowerCase(),
            createdAt: r.createdAtRaw ? new Date(r.createdAtRaw).toISOString() : null
        }));
        res.json({ requests });
    } catch (_e) {
        res.status(500).json({ requests: [], message: 'Could not load redemptions.' });
    }
});

const QR_REJECT_REASON_MESSAGES = {
    incorrect: 'The QR code is incorrect or does not match your e-money account.',
    fake: 'The QR photo appears fake, edited, or not genuine.',
    cannot_process: 'We could not read or process your QR photo. Please submit a clearer image.',
    expired: 'The QR code is expired, incomplete, or not a valid e-money QR.',
    mismatch: 'The QR does not match the reward amount you selected.',
    other: 'Your QR submission could not be approved. Contact your barangay admin or resubmit with a valid QR.'
};

app.patch('/api/admin/reward-redemptions/:id/reject', authRequired, requireDb, requireRoles('admin'), async (req, res) => {
    try {
        const rid = String(req.params.id || '').trim();
        if (!rid) return res.status(400).json({ message: 'Redemption id required.' });

        const reasonKey = String(req.body?.reason || 'other').trim().toLowerCase();
        const reasonText = QR_REJECT_REASON_MESSAGES[reasonKey] || QR_REJECT_REASON_MESSAGES.other;

        const [[row]] = await pool.query(
            `SELECT redemption_id, user_id, user_name, reward_display, cost_points, status
             FROM reward_redemptions WHERE redemption_id = ? LIMIT 1`,
            [rid]
        );
        if (!row) return res.status(404).json({ message: 'Redemption not found.' });

        const status = String(row.status || '').toLowerCase();
        if (status === 'sent') {
            return res.status(400).json({ message: 'This reward was already sent and cannot be rejected.' });
        }

        const display = String(row.reward_display || 'your reward').trim();
        const uid = row.user_id;
        const cost = Number(row.cost_points || 0);
        const alreadyRejected = status === 'rejected';

        if (!alreadyRejected) {
            if (!usersColumnInfo.loaded) await readUsersColumns();
            const idCol = usersIdColumn();
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();
                await conn.query(`UPDATE reward_redemptions SET status = 'rejected' WHERE redemption_id = ?`, [rid]);
                if (cost > 0) {
                    await conn.query(`UPDATE users SET eco_points = eco_points + ? WHERE ${idCol} = ?`, [cost, uid]);
                }
                await conn.commit();
            } catch (txErr) {
                await conn.rollback();
                throw txErr;
            } finally {
                conn.release();
            }
        }

        const msg = `Your e-money reward request (${display}) was rejected: ${reasonText} Your EcoPoints have been refunded.`;
        const exists = transient.notifications.some(
            (n) => String(n.userId) === String(uid) && String(n.redemptionId || '') === `${rid}:reject`
        );
        if (!exists) {
            transient.notifications.unshift({
                userId: String(uid),
                text: msg,
                createdAt: new Date().toISOString(),
                redemptionId: `${rid}:reject`
            });
        }

        return res.json({
            ok: true,
            alreadyRejected,
            message: alreadyRejected
                ? 'Household was already notified of this rejection.'
                : 'QR rejected. Household notified and EcoPoints refunded.',
            request: {
                id: rid,
                userId: uid,
                userName: row.user_name,
                rewardDisplay: display,
                cost,
                status: 'rejected'
            }
        });
    } catch (err) {
        console.error('❌ PATCH reward reject:', err?.message || err);
        return res.status(500).json({ message: err?.message || 'Could not reject QR.' });
    }
});

app.patch('/api/admin/reward-redemptions/:id/sent', authRequired, requireDb, requireRoles('admin'), async (req, res) => {
    try {
        const rid = String(req.params.id || '').trim();
        if (!rid) return res.status(400).json({ message: 'Redemption id required.' });

        const [[row]] = await pool.query(
            `SELECT redemption_id, user_id, user_name, reward_display, cost_points, status
             FROM reward_redemptions WHERE redemption_id = ? LIMIT 1`,
            [rid]
        );
        if (!row) return res.status(404).json({ message: 'Redemption not found.' });

        const display = String(row.reward_display || 'your reward').trim();
        const uid = row.user_id;
        const alreadySent = String(row.status || '').toLowerCase() === 'sent';

        if (!alreadySent) {
            await pool.query(`UPDATE reward_redemptions SET status = 'sent' WHERE redemption_id = ?`, [rid]);
        }

        const msg = `Your e-money reward (${display}) has been sent by your barangay admin. Please check your e-money account.`;
        const exists = transient.notifications.some(
            (n) => String(n.userId) === String(uid) && String(n.redemptionId || '') === rid
        );
        if (!exists) {
            transient.notifications.unshift({
                userId: String(uid),
                text: msg,
                createdAt: new Date().toISOString(),
                redemptionId: rid
            });
        }

        return res.json({
            ok: true,
            alreadySent,
            request: {
                id: rid,
                userId: uid,
                userName: row.user_name,
                rewardDisplay: display,
                cost: Number(row.cost_points || 0),
                status: 'sent',
                createdAt: null
            },
            message: alreadySent ? 'Household was already notified.' : 'Household notified that their reward was sent.'
        });
    } catch (err) {
        console.error('❌ PATCH reward sent:', err?.message || err);
        return res.status(500).json({ message: err?.message || 'Could not mark reward as sent.' });
    }
});

app.get('/api/admin/reward-redemptions/:id/photo', authRequired, requireDb, requireRoles('admin'), async (req, res) => {
    try {
        const rid = String(req.params.id || '');
        const [[entry]] = await pool.query(
            `SELECT photo_filename AS filename, user_name AS userName FROM reward_redemptions WHERE redemption_id = ? LIMIT 1`,
            [rid]
        );
        if (!entry?.filename) return res.status(404).json({ message: 'Redemption not found.' });
        const fp = path.join(redemptionUploadDir, entry.filename);
        if (!fs.existsSync(fp)) return res.status(404).json({ message: 'Photo file missing.' });
        const base = `${String(entry.userName || 'user').replace(/[^\w\-]+/g, '_')}-${rid}`;
        res.download(fp, `${base}${path.extname(entry.filename) || '.jpg'}`);
    } catch (_e) {
        res.status(500).json({ message: 'Could not load file.' });
    }
});

function padDatePart(n) {
    return String(n).padStart(2, '0');
}

function dateToYMD(d) {
    return `${d.getFullYear()}-${padDatePart(d.getMonth() + 1)}-${padDatePart(d.getDate())}`;
}

function rollingWeekRangeCaption() {
    const end = new Date();
    const start = new Date(end);
    start.setDate(end.getDate() - 6);
    const fmt = (dt) =>
        dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${fmt(start)} – ${fmt(end)}`;
}

async function buildRollingWeeklyWasteChart(pool) {
    const [rows] = await pool.query(
        `SELECT DATE(completed_at) AS d, COALESCE(SUM(weight), 0) AS kg
         FROM waste_logs
         WHERE status = 'Completed' AND completed_at IS NOT NULL
           AND DATE(completed_at) >= DATE(DATE_SUB(CURDATE(), INTERVAL 6 DAY))
         GROUP BY DATE(completed_at)`
    );
    const sums = {};
    for (const r of rows || []) {
        let key;
        if (r.d instanceof Date) {
            key = dateToYMD(new Date(r.d.getTime()));
        } else {
            key = String(r.d || '').slice(0, 10);
        }
        sums[key] = Number(r.kg) || 0;
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const chart = [];
    for (let i = 6; i >= 0; i -= 1) {
        const dt = new Date(today);
        dt.setDate(today.getDate() - i);
        const key = dateToYMD(dt);
        const label = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
        chart.push({ day: label, val: Number((sums[key] || 0).toFixed(1)) });
    }
    return { weeklyChart: chart, weekRangeLabel: rollingWeekRangeCaption() };
}

app.get('/api/admin/analytics', authRequired, requireDb, requireRoles('admin'), async (_req, res) => {
    try {
        const [[{ totalKg }]] = await pool.query(
            `SELECT COALESCE(SUM(weight), 0) AS totalKg FROM waste_logs WHERE status = 'Completed'`
        );
        const [[{ activeUsers }]] = await pool.query(
            `SELECT COUNT(*) AS activeUsers FROM users WHERE LOWER(role) IN ('household','collector')`
        );
        const [[{ points }]] = await pool.query(
            `SELECT COALESCE(SUM(eco_points_awarded), 0) AS points FROM waste_logs WHERE status = 'Completed'`
        );
        const [[counts]] = await pool.query(`
            SELECT
              SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS nCompleted,
              SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS nPending,
              SUM(CASE WHEN status = 'Rejected' THEN 1 ELSE 0 END) AS nRejected,
              COALESCE(SUM(CASE WHEN status IN ('Completed','Pending','Rejected') THEN weight ELSE 0 END), 0) AS totalWeightKg,
              COALESCE(SUM(CASE WHEN status = 'Completed' THEN weight ELSE 0 END), 0) AS completedKg
            FROM waste_logs
        `);
        const decided =
            Number(counts.nCompleted || 0) + Number(counts.nPending || 0) + Number(counts.nRejected || 0);
        const compliance = decided > 0 ? Math.round((Number(counts.nCompleted || 0) / decided) * 100) : 0;
        const tw = Number(counts.totalWeightKg || 0);
        const ck = Number(counts.completedKg || 0);
        const recyclingRate = tw > 0 ? Math.round((ck / tw) * 100) : 0;

        if (!usersColumnInfo.loaded) await readUsersColumns();
        const idCol = usersIdColumn();
        const [topRows] = await pool.query(
            `SELECT ${idCol} AS id, full_name AS name, email, barangay, address, eco_points AS ecoPoints
             FROM users
             WHERE LOWER(role) IN ('household','user')
             ORDER BY eco_points DESC
             LIMIT 5`
        );
        const topHouseholds = (topRows || []).map((t, idx) => ({
            rank: idx + 1,
            id: t.id,
            name: t.name,
            email: t.email,
            barangay: resolveUserBarangay(t),
            address: t.address || '',
            ecoPoints: Number(t.ecoPoints || 0)
        }));

        const totalCollected = Number(totalKg || 0);
        const { weeklyChart, weekRangeLabel } = await buildRollingWeeklyWasteChart(pool);

        res.json({
            metrics: {
                totalCollectedKg: totalCollected.toFixed(1),
                compliance,
                recyclingRate,
                activeUsers: Number(activeUsers || 0),
                ecoPointsDistributed: Number(points || 0)
            },
            topHouseholds,
            weeklyChart,
            weekRangeLabel
        });
    } catch (_e) {
        res.json({
            metrics: { totalCollectedKg: '0', compliance: 0, recyclingRate: 0, activeUsers: 0, ecoPointsDistributed: 0 },
            topHouseholds: [],
            weeklyChart: [],
            weekRangeLabel: ''
        });
    }
});

app.get('/api/admin/users', authRequired, requireDb, requireRoles('admin'), async (_req, res) => {
    try {
        if (!usersColumnInfo.loaded) await readUsersColumns();
        const cols = buildUserSelectColumns();
        const [rows] = await pool.query(`SELECT ${cols} FROM users ORDER BY id ASC LIMIT 500`);
        res.json({ users: rows.map((r) => normalizeUserRow(r)) });
    } catch (err) {
        res.status(500).json({ users: [], message: err.message });
    }
});

app.get('/api/admin/report', authRequired, requireDb, requireRoles('admin'), async (_req, res) => {
    try {
        const [[row]] = await pool.query(`
            SELECT
              COUNT(*) AS totalLogs,
              SUM(CASE WHEN status = 'Pending' THEN 1 ELSE 0 END) AS pendingLogs,
              SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completedLogs,
              SUM(CASE WHEN status = 'Rejected' THEN 1 ELSE 0 END) AS rejectedLogs,
              COALESCE(SUM(CASE WHEN status IN ('Completed','Pending','Rejected') THEN weight ELSE 0 END), 0) AS totalWeightKg,
              COALESCE(SUM(CASE WHEN status = 'Completed' THEN weight ELSE 0 END), 0) AS completedKg
            FROM waste_logs
        `);
        const decided =
            Number(row.completedLogs || 0) + Number(row.pendingLogs || 0) + Number(row.rejectedLogs || 0);
        const compliance = decided > 0 ? Math.round((Number(row.completedLogs || 0) / decided) * 100) : 0;
        const tw = Number(row.totalWeightKg || 0);
        const ck = Number(row.completedKg || 0);
        const recyclingRate = tw > 0 ? Math.round((ck / tw) * 100) : 0;
        const [[{ points }]] = await pool.query(
            `SELECT COALESCE(SUM(eco_points_awarded), 0) AS points FROM waste_logs WHERE status = 'Completed'`
        );
        const [[{ activeUsers }]] = await pool.query(
            `SELECT COUNT(*) AS activeUsers FROM users WHERE LOWER(role) IN ('household','collector')`
        );
        const [recent] = await pool.query(`
            SELECT log_id AS id, user_name AS userName, waste_type AS type, weight, status, eco_points_awarded AS points, created_at AS createdAt
            FROM waste_logs ORDER BY created_at DESC LIMIT 20
        `);
        res.json({
            metrics: {
                totalLogs: Number(row.totalLogs || 0),
                pendingLogs: Number(row.pendingLogs || 0),
                completedLogs: Number(row.completedLogs || 0),
                rejectedLogs: Number(row.rejectedLogs || 0),
                totalCollectedKg: ck.toFixed(1),
                compliance,
                recyclingRate,
                activeUsers: Number(activeUsers || 0),
                ecoPointsDistributed: Number(points || 0)
            },
            logsByStatus: {
                Pending: Number(row.pendingLogs || 0),
                Completed: Number(row.completedLogs || 0),
                Rejected: Number(row.rejectedLogs || 0)
            },
            recentLogs: recent.map((x) => ({
                id: x.id,
                userName: x.userName,
                type: x.type,
                weight: Number(x.weight),
                status: x.status,
                points: Number(x.points || 0),
                createdAt: x.createdAt ? new Date(x.createdAt).toISOString() : null
            }))
        });
    } catch (_e) {
        res.json({ metrics: {}, logsByStatus: {}, recentLogs: [] });
    }
});

app.get('/api/admin/export.csv', authRequired, requireDb, requireRoles('admin'), async (_req, res) => {
    try {
        const [rows] = await pool.query(`
            SELECT log_id, user_id, user_name, waste_type, weight, status, eco_points_awarded, created_at FROM waste_logs ORDER BY created_at DESC
        `);
        const lines = rows.map((r) =>
            [r.log_id, r.user_id, `"${String(r.user_name || '').replace(/"/g, '""')}"`, r.waste_type, r.weight, r.status, r.eco_points_awarded, r.created_at].join(',')
        );
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="binbuddy-waste-logs.csv"');
        res.send('log_code,user_id,user_name,type,weight,status,points,created_at\n' + lines.join('\n'));
    } catch (_e) {
        res.send('log_code,user_id,user_name,type,weight,status,points,created_at\n');
    }
});

app.post('/api/admin/broadcast', authRequired, (_req, res) => res.json({ recipients: 0 }));

app.get('/', (_req, res) => {
    res.sendFile(path.join(webRoot, 'index.html'));
});

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
    kickDbConnectivityProbe();
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📡 Ready for BinBuddy operations...`);
});

// Handle server errors gracefully
server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Please kill the process or use a different port.`);
        process.exit(1);
    }
});