-- ============================================
-- BinBuddy - Database Schema & Queries
-- Smart Waste Tracking & Rewards Platform
-- Powerpuff w/ Mojo Jojo - Technopreneurship
-- MySQL / MariaDB Compatible
-- ============================================

-- Create and use the database
CREATE DATABASE IF NOT EXISTS binbuddy_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE binbuddy_db;

-- ============================================
-- TABLE: users
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    user_id        VARCHAR(10)  PRIMARY KEY,
    full_name      VARCHAR(100) NOT NULL,
    email          VARCHAR(100) UNIQUE NOT NULL,
    mobile         VARCHAR(15),
    password_hash  VARCHAR(255) NOT NULL,
    role           ENUM('household', 'collector', 'admin') NOT NULL DEFAULT 'household',
    barangay       VARCHAR(100),
    city           VARCHAR(100) DEFAULT 'Quezon City',
    eco_points     INT          NOT NULL DEFAULT 0,
    streak_days    INT          NOT NULL DEFAULT 0,
    level          VARCHAR(50)  DEFAULT 'Eco Starter',
    is_verified    BOOLEAN      DEFAULT FALSE,
    is_active      BOOLEAN      DEFAULT TRUE,
    created_at     DATETIME     DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_role     (role),
    INDEX idx_barangay (barangay),
    INDEX idx_points   (eco_points DESC)
);

-- ============================================
-- TABLE: waste_logs
-- ============================================
CREATE TABLE IF NOT EXISTS waste_logs (
    log_id           VARCHAR(10)  PRIMARY KEY,
    user_id          VARCHAR(10)  NOT NULL,
    waste_type       ENUM('biodegradable', 'recyclable', 'residual', 'special') NOT NULL,
    category         VARCHAR(100),
    quantity         DECIMAL(6,2) NOT NULL,
    quantity_unit    ENUM('kg', 'pcs', 'liters') DEFAULT 'kg',
    log_date         DATE         NOT NULL,
    log_time         TIME,
    log_method       ENUM('manual', 'qr_scan') DEFAULT 'manual',
    photo_url        VARCHAR(255),
    is_verified      BOOLEAN      DEFAULT FALSE,
    verified_by      VARCHAR(10),
    eco_points_earned INT         DEFAULT 0,
    notes            TEXT,
    created_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)      REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (verified_by)  REFERENCES users(user_id) ON DELETE SET NULL,
    INDEX idx_user_id   (user_id),
    INDEX idx_log_date  (log_date),
    INDEX idx_waste_type(waste_type)
);

-- ============================================
-- TABLE: rewards_catalog
-- ============================================
CREATE TABLE IF NOT EXISTS rewards_catalog (
    reward_id      VARCHAR(10)  PRIMARY KEY,
    reward_name    VARCHAR(100) NOT NULL,
    icon           VARCHAR(10),
    points_cost    INT          NOT NULL,
    category       VARCHAR(50),
    sponsor        VARCHAR(100),
    description    TEXT,
    is_available   BOOLEAN      DEFAULT TRUE,
    stock_count    INT          DEFAULT 100,
    expiry_days    INT          DEFAULT 30,
    created_at     DATETIME     DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_points_cost (points_cost),
    INDEX idx_available   (is_available)
);

-- ============================================
-- TABLE: transactions (reward claims)
-- ============================================
CREATE TABLE IF NOT EXISTS transactions (
    txn_id         VARCHAR(15)  PRIMARY KEY,
    user_id        VARCHAR(10)  NOT NULL,
    reward_id      VARCHAR(10),
    txn_type       ENUM('earn', 'redeem', 'bonus', 'penalty') NOT NULL,
    points_change  INT          NOT NULL,  -- positive = earn, negative = redeem
    balance_after  INT          NOT NULL,
    description    VARCHAR(255),
    ref_log_id     VARCHAR(10),            -- reference waste log if applicable
    created_at     DATETIME     DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)   REFERENCES users(user_id)           ON DELETE CASCADE,
    FOREIGN KEY (reward_id) REFERENCES rewards_catalog(reward_id) ON DELETE SET NULL,
    FOREIGN KEY (ref_log_id) REFERENCES waste_logs(log_id)      ON DELETE SET NULL,
    INDEX idx_user_id   (user_id),
    INDEX idx_txn_type  (txn_type),
    INDEX idx_created_at(created_at)
);

-- ============================================
-- TABLE: barangays
-- ============================================
CREATE TABLE IF NOT EXISTS barangays (
    brgy_id              VARCHAR(10) PRIMARY KEY,
    brgy_name            VARCHAR(100) NOT NULL,
    city                 VARCHAR(100) DEFAULT 'Quezon City',
    total_households     INT          DEFAULT 0,
    active_users         INT          DEFAULT 0,
    subscription_plan    ENUM('free', 'basic', 'premium') DEFAULT 'basic',
    subscription_start   DATE,
    subscription_end     DATE,
    is_active            BOOLEAN      DEFAULT TRUE,
    created_at           DATETIME     DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- TABLE: challenges
-- ============================================
CREATE TABLE IF NOT EXISTS challenges (
    challenge_id   VARCHAR(10)  PRIMARY KEY,
    title          VARCHAR(150) NOT NULL,
    description    TEXT,
    challenge_type ENUM('daily', 'weekly', 'monthly', 'special') DEFAULT 'daily',
    points_reward  INT          NOT NULL DEFAULT 50,
    target_value   DECIMAL(8,2),
    target_unit    VARCHAR(20),
    start_date     DATE,
    end_date       DATE,
    is_active      BOOLEAN      DEFAULT TRUE,
    created_at     DATETIME     DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- TABLE: user_challenges
-- ============================================
CREATE TABLE IF NOT EXISTS user_challenges (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    user_id        VARCHAR(10)  NOT NULL,
    challenge_id   VARCHAR(10)  NOT NULL,
    progress       DECIMAL(8,2) DEFAULT 0,
    is_completed   BOOLEAN      DEFAULT FALSE,
    completed_at   DATETIME,
    created_at     DATETIME     DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)     REFERENCES users(user_id)      ON DELETE CASCADE,
    FOREIGN KEY (challenge_id) REFERENCES challenges(challenge_id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_challenge (user_id, challenge_id)
);

-- ============================================
-- TABLE: announcements
-- ============================================
CREATE TABLE IF NOT EXISTS announcements (
    ann_id         VARCHAR(10)  PRIMARY KEY,
    barangay_id    VARCHAR(10),
    title          VARCHAR(150) NOT NULL,
    message        TEXT         NOT NULL,
    priority       ENUM('low', 'normal', 'high', 'urgent') DEFAULT 'normal',
    published_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
    expires_at     DATETIME,
    created_by     VARCHAR(10),
    FOREIGN KEY (barangay_id) REFERENCES barangays(brgy_id) ON DELETE SET NULL,
    FOREIGN KEY (created_by)  REFERENCES users(user_id)     ON DELETE SET NULL
);

-- ============================================
-- INSERT: Seed Data - Users
-- ============================================
INSERT INTO users (user_id, full_name, email, mobile, password_hash, role, barangay, city, eco_points, streak_days, level, is_verified) VALUES
('USR001', 'Maria Santos',        'maria@email.com',          '09171234567', SHA2('password123', 256), 'household', 'Holy Spirit',  'Quezon City', 1245, 7, 'BinBuddy',  TRUE),
('USR002', 'Juan dela Cruz',      'juan@email.com',           '09181234567', SHA2('password123', 256), 'household', 'Holy Spirit',  'Quezon City', 1180, 5, 'Green Warrior', TRUE),
('USR003', 'Ana Reyes',           'ana@email.com',            '09191234567', SHA2('password123', 256), 'household', 'Batasan Hills','Quezon City', 1050, 4, 'Green Warrior', TRUE),
('USR004', 'Pedro Lim',           'pedro@email.com',          '09201234567', SHA2('password123', 256), 'household', 'Payatas',      'Quezon City',  980, 3, 'Eco Starter',   FALSE),
('USR005', 'Rosa Fernandez',      'rosa@email.com',           '09211234567', SHA2('password123', 256), 'household', 'Holy Spirit',  'Quezon City',  870, 6, 'BinBuddy',  TRUE),
('COL001', 'Roberto Cruz',        'roberto@qcgov.ph',         '09221234567', SHA2('password123', 256), 'collector', 'Holy Spirit',  'Quezon City',    0, 0, NULL,            TRUE),
('ADM001', 'HS Barangay Admin',   'admin@holyspirit.qc.gov.ph','09231234567',SHA2('admin2026',   256), 'admin',     'Holy Spirit',  'Quezon City',    0, 0, NULL,            TRUE);

-- ============================================
-- INSERT: Seed Data - Barangays
-- ============================================
INSERT INTO barangays (brgy_id, brgy_name, city, total_households, active_users, subscription_plan, subscription_start, subscription_end) VALUES
('BRG001', 'Holy Spirit',   'Quezon City', 4250, 312, 'premium', '2026-01-01', '2026-12-31'),
('BRG002', 'Batasan Hills', 'Quezon City', 6800, 498, 'basic',   '2026-01-01', '2026-12-31'),
('BRG003', 'Commonwealth',  'Quezon City', 5100, 287, 'basic',   '2026-02-01', '2026-12-31'),
('BRG004', 'Payatas',       'Quezon City', 7200, 401, 'free',    '2026-03-01', '2026-06-30');

-- ============================================
-- INSERT: Seed Data - Rewards Catalog
-- ============================================
INSERT INTO rewards_catalog (reward_id, reward_name, icon, points_cost, category, sponsor, description, is_available, stock_count, expiry_days) VALUES
('RWD001', '₱50 Mobile Load',    '📱', 500,  'telecommunications', 'Globe Telecom',         '₱50 prepaid mobile load for any network',       TRUE, 200, 30),
('RWD002', 'SM Voucher ₱100',    '🛒', 1000, 'voucher',            'SM Supermalls',          '₱100 SM shopping voucher',                      TRUE,  50, 60),
('RWD003', 'Starbucks Discount', '☕',  800,  'food_beverage',      'Starbucks Philippines',  '20% off any Starbucks beverage',                TRUE,  80, 14),
('RWD004', 'Beep Card Reload',   '🚌',  600,  'transportation',     'AF Payments Inc.',       '₱50 Beep card reload for MRT/LRT/buses',        TRUE, 150, 90),
('RWD005', 'Puregold Discount',  '🛍️',  400,  'grocery',            'Puregold Price Club',    '15% off grocery purchase',                      TRUE, 300, 30),
('RWD006', 'Mystery Eco Box',    '🎁',  300,  'surprise',           'BinBuddy Partners',      'Surprise eco-friendly product box',             TRUE,  40, 30);

-- ============================================
-- INSERT: Seed Data - Waste Logs
-- ============================================
INSERT INTO waste_logs (log_id, user_id, waste_type, category, quantity, quantity_unit, log_date, log_time, log_method, is_verified, verified_by, eco_points_earned, notes) VALUES
('LOG001', 'USR001', 'biodegradable', 'Food Scraps',     1.2, 'kg', '2026-04-14', '08:30:00', 'manual',  TRUE,  'COL001', 25, 'Leftover food and vegetable peels'),
('LOG002', 'USR001', 'recyclable',    'Plastic Bottles', 0.8, 'kg', '2026-04-13', '09:00:00', 'qr_scan', TRUE,  'COL001', 40, 'PET bottles, rinsed and clean'),
('LOG003', 'USR001', 'residual',      'Mixed Trash',     0.5, 'kg', '2026-04-12', '07:45:00', 'manual',  FALSE, NULL,     10, 'Non-recyclable household waste'),
('LOG004', 'USR002', 'recyclable',    'Cardboard',       2.5, 'kg', '2026-04-14', '10:15:00', 'qr_scan', TRUE,  'COL001', 40, 'Old boxes and cardboard packaging'),
('LOG005', 'USR001', 'special',       'E-Waste',         3.0, 'pcs','2026-04-11', '11:00:00', 'manual',  TRUE,  'COL001', 15, 'Old batteries and a broken phone'),
('LOG006', 'USR003', 'biodegradable', 'Garden Waste',    3.0, 'kg', '2026-04-14', '07:00:00', 'manual',  TRUE,  'COL001', 25, 'Leaves and grass clippings'),
('LOG007', 'USR004', 'recyclable',    'Tin Cans',        1.0, 'kg', '2026-04-13', '16:00:00', 'qr_scan', FALSE, NULL,     40, 'Empty food cans'),
('LOG008', 'USR005', 'biodegradable', 'Food Scraps',     1.8, 'kg', '2026-04-14', '09:30:00', 'manual',  TRUE,  'COL001', 25, 'Kitchen compost');

-- ============================================
-- INSERT: Seed Data - Transactions
-- ============================================
INSERT INTO transactions (txn_id, user_id, reward_id, txn_type, points_change, balance_after, description, ref_log_id) VALUES
('TXN001', 'USR001', NULL,     'earn',   25,   25,   'Earned for biodegradable log',      'LOG001'),
('TXN002', 'USR001', NULL,     'earn',   40,   65,   'Earned for recyclable log',         'LOG002'),
('TXN003', 'USR001', NULL,     'earn',   10,   75,   'Earned for residual log',           'LOG003'),
('TXN004', 'USR001', 'RWD005', 'redeem', -400, 1245, 'Redeemed: Puregold Discount',       NULL),
('TXN005', 'USR001', NULL,     'bonus',  100,  1345, 'Weekly challenge bonus',            NULL),
('TXN006', 'USR002', NULL,     'earn',   40,   40,   'Earned for cardboard recyclables',  'LOG004');

-- ============================================
-- INSERT: Seed Data - Challenges
-- ============================================
INSERT INTO challenges (challenge_id, title, description, challenge_type, points_reward, target_value, target_unit, start_date, end_date, is_active) VALUES
('CHL001', 'Segregate 5 Days Straight',   'Log waste daily for 5 consecutive days',           'weekly',  100, 5,   'days',   '2026-04-14', '2026-04-20', TRUE),
('CHL002', 'Recycle 3kg This Week',        'Contribute 3kg of recyclables this week',          'weekly',   75, 3,   'kg',     '2026-04-14', '2026-04-20', TRUE),
('CHL003', 'Top Barangay Contributor',     'Earn the most points in Brgy. Holy Spirit',        'weekly',  200, 1,   'rank',   '2026-04-14', '2026-04-20', TRUE),
('CHL004', 'Invite a Neighbor',            'Share BinBuddy with 1 friend and they register',   'special',  50, 1,   'invite', '2026-04-01', '2026-04-30', TRUE),
('CHL005', 'Zero Residual Day',            'Log zero residual waste in a single day',           'daily',    30, 0,   'kg_residual','2026-04-14','2026-04-14',TRUE);

-- ============================================
-- SELECT: Useful Queries
-- ============================================

-- 1. Get all household users with their EcoPoints, ranked
SELECT 
    user_id,
    full_name,
    barangay,
    eco_points,
    streak_days,
    level
FROM users
WHERE role = 'household' AND is_active = TRUE
ORDER BY eco_points DESC;

-- 2. Get total waste per type for a specific user
SELECT 
    waste_type,
    COUNT(*) AS log_count,
    SUM(quantity) AS total_qty,
    SUM(eco_points_earned) AS total_points
FROM waste_logs
WHERE user_id = 'USR001'
GROUP BY waste_type
ORDER BY total_qty DESC;

-- 3. Get barangay-level segregation compliance
SELECT 
    u.barangay,
    COUNT(DISTINCT u.user_id) AS active_users,
    COUNT(wl.log_id) AS total_logs,
    SUM(CASE WHEN wl.is_verified = TRUE THEN 1 ELSE 0 END) AS verified_logs,
    ROUND(SUM(CASE WHEN wl.is_verified = TRUE THEN 1 ELSE 0 END) / COUNT(wl.log_id) * 100, 1) AS compliance_pct,
    SUM(wl.eco_points_earned) AS total_points_distributed
FROM users u
JOIN waste_logs wl ON u.user_id = wl.user_id
WHERE u.role = 'household'
GROUP BY u.barangay
ORDER BY compliance_pct DESC;

-- 4. Get daily waste summary for the past 7 days
SELECT 
    log_date,
    COUNT(*) AS total_logs,
    SUM(quantity) AS total_kg,
    SUM(eco_points_earned) AS points_earned,
    SUM(CASE WHEN waste_type='recyclable' THEN quantity ELSE 0 END) AS recyclable_kg,
    SUM(CASE WHEN waste_type='biodegradable' THEN quantity ELSE 0 END) AS biodegradable_kg
FROM waste_logs
WHERE log_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
GROUP BY log_date
ORDER BY log_date DESC;

-- 5. Leaderboard query - top users by EcoPoints
SELECT 
    ROW_NUMBER() OVER (ORDER BY eco_points DESC) AS rank_num,
    full_name,
    barangay,
    eco_points,
    streak_days,
    level
FROM users
WHERE role = 'household' AND is_active = TRUE
ORDER BY eco_points DESC
LIMIT 10;

-- 6. Get rewards redeemed by a user (transaction history)
SELECT 
    t.txn_id,
    t.txn_type,
    t.points_change,
    t.balance_after,
    t.description,
    t.created_at,
    rc.reward_name,
    rc.icon
FROM transactions t
LEFT JOIN rewards_catalog rc ON t.reward_id = rc.reward_id
WHERE t.user_id = 'USR001'
ORDER BY t.created_at DESC;

-- 7. Recycling rate per barangay
SELECT 
    u.barangay,
    SUM(wl.quantity) AS total_waste_kg,
    SUM(CASE WHEN wl.waste_type='recyclable' THEN wl.quantity ELSE 0 END) AS recyclable_kg,
    ROUND(SUM(CASE WHEN wl.waste_type='recyclable' THEN wl.quantity ELSE 0 END) / SUM(wl.quantity) * 100, 1) AS recycling_rate_pct
FROM users u
JOIN waste_logs wl ON u.user_id = wl.user_id
GROUP BY u.barangay
ORDER BY recycling_rate_pct DESC;

-- 8. Collector verification performance
SELECT 
    u.full_name AS collector_name,
    COUNT(wl.log_id) AS verifications_done,
    SUM(CASE WHEN wl.is_verified=TRUE THEN 1 ELSE 0 END) AS verified_ok,
    ROUND(AVG(wl.eco_points_earned), 1) AS avg_pts_per_log
FROM users u
JOIN waste_logs wl ON u.user_id = wl.verified_by
WHERE u.role = 'collector'
GROUP BY u.user_id, u.full_name;

-- ============================================
-- UPDATE: Sample Update Queries
-- ============================================

-- Update EcoPoints when new log is verified
UPDATE users
SET eco_points = eco_points + 40,
    streak_days = streak_days + 1,
    updated_at = CURRENT_TIMESTAMP
WHERE user_id = 'USR001';

-- Mark a waste log as verified by collector
UPDATE waste_logs
SET is_verified = TRUE,
    verified_by = 'COL001'
WHERE log_id = 'LOG003';

-- Update user level based on EcoPoints
UPDATE users
SET level = CASE
    WHEN eco_points >= 2000 THEN 'Eco Legend'
    WHEN eco_points >= 1000 THEN 'BinBuddy'
    WHEN eco_points >= 500  THEN 'Green Warrior'
    WHEN eco_points >= 100  THEN 'Eco Starter'
    ELSE 'Newcomer'
END
WHERE role = 'household';

-- Deduct points on reward redemption
UPDATE users
SET eco_points = eco_points - 500
WHERE user_id = 'USR001' AND eco_points >= 500;

-- ============================================
-- DELETE: Sample Delete Queries
-- ============================================

-- Soft delete (deactivate) a user
UPDATE users
SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP
WHERE user_id = 'USR004';

-- Delete a waste log (hard delete)
DELETE FROM waste_logs
WHERE log_id = 'LOG007' AND is_verified = FALSE;

-- Delete expired reward from catalog
DELETE FROM rewards_catalog
WHERE reward_id = 'RWD006' AND is_available = FALSE;

-- Archive/delete old transactions older than 1 year
DELETE FROM transactions
WHERE created_at < DATE_SUB(NOW(), INTERVAL 1 YEAR);

-- ============================================
-- VIEWS: Useful Database Views
-- ============================================

-- View: User EcoPoints summary
CREATE OR REPLACE VIEW v_user_ecopoints AS
SELECT 
    u.user_id,
    u.full_name,
    u.barangay,
    u.eco_points,
    u.streak_days,
    u.level,
    COUNT(wl.log_id) AS total_logs,
    SUM(wl.quantity) AS total_waste_kg
FROM users u
LEFT JOIN waste_logs wl ON u.user_id = wl.user_id
WHERE u.role = 'household'
GROUP BY u.user_id;

-- View: Barangay dashboard summary
CREATE OR REPLACE VIEW v_barangay_summary AS
SELECT
    u.barangay,
    COUNT(DISTINCT u.user_id) AS active_users,
    SUM(wl.quantity) AS total_waste_kg,
    SUM(wl.eco_points_earned) AS total_points,
    ROUND(SUM(CASE WHEN wl.waste_type='recyclable' THEN wl.quantity ELSE 0 END)/SUM(wl.quantity)*100,1) AS recycling_rate
FROM users u
JOIN waste_logs wl ON u.user_id = wl.user_id
GROUP BY u.barangay;

-- ============================================
-- END OF SCHEMA
-- BinBuddy DB v1.0 | April 2026
-- ============================================
