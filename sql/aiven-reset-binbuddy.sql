-- =============================================================================
-- BinBuddy — full reset for Aiven MySQL (run in Aiven console → Query / SQL)
-- WARNING: drops all BinBuddy tables in the current database (e.g. defaultdb).
-- =============================================================================

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS waste_logs;
DROP TABLE IF EXISTS users;

SET FOREIGN_KEY_CHECKS = 1;

-- -----------------------------------------------------------------------------
-- users — matches Node server (password_hash = SHA-256 hex of plain password)
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  full_name       VARCHAR(100) NOT NULL,
  email           VARCHAR(190) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  role            ENUM('household', 'collector', 'admin') NOT NULL DEFAULT 'household',
  mobile          VARCHAR(20) DEFAULT NULL,
  phone_number    VARCHAR(20) DEFAULT NULL,
  address         VARCHAR(500) DEFAULT NULL,
  gender          ENUM('male', 'female') DEFAULT NULL,
  barangay        VARCHAR(100) DEFAULT 'Holy Spirit',
  eco_points      INT NOT NULL DEFAULT 0,
  streak_days     INT NOT NULL DEFAULT 0,
  level           VARCHAR(50) DEFAULT 'Eco Starter',
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_role (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- waste_logs — persisted pickup logs (household submits, collector verifies)
-- -----------------------------------------------------------------------------
CREATE TABLE waste_logs (
  log_id              VARCHAR(48) NOT NULL PRIMARY KEY,
  user_id             INT UNSIGNED NOT NULL,
  user_name           VARCHAR(200) DEFAULT NULL,
  waste_type          VARCHAR(20) NOT NULL,
  weight              DECIMAL(10, 2) NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'Pending',
  eco_points_awarded  INT NOT NULL DEFAULT 0,
  verified_by         INT UNSIGNED DEFAULT NULL,
  notes               TEXT,
  log_date            DATETIME DEFAULT NULL,
  created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at        DATETIME DEFAULT NULL,
  CONSTRAINT fk_waste_logs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_waste_logs_verifier FOREIGN KEY (verified_by) REFERENCES users (id) ON DELETE SET NULL,
  KEY idx_waste_logs_user (user_id),
  KEY idx_waste_logs_status (status),
  KEY idx_waste_logs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Optional demo accounts (password for all: password123)
-- -----------------------------------------------------------------------------
INSERT INTO users (full_name, email, password_hash, role, mobile, address, gender, barangay, eco_points, streak_days, level) VALUES
('Maria Santos', 'maria@email.com', SHA2('password123', 256), 'household', '09171234567', 'Brgy. Holy Spirit, Quezon City', 'female', 'Holy Spirit', 1245, 7, 'Eco Champion'),
('Roberto Cruz', 'roberto@email.com', SHA2('password123', 256), 'collector', '09181234567', 'Brgy. Holy Spirit, Quezon City', 'male', 'Holy Spirit', 0, 0, 'Eco Starter'),
('Brgy Admin', 'admin@email.com', SHA2('password123', 256), 'admin', '09191234567', 'Brgy. Holy Spirit, Quezon City', 'male', 'Holy Spirit', 0, 0, 'Eco Starter');
