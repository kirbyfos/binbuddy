-- =============================================================================
-- BinBuddy — Persist reward redemption QR uploads (run in MySQL Workbench /
-- Aiven Query, against the SAME database as `users` and `waste_logs`).
--
-- Matches: sql/aiven-reset-binbuddy.sql (users.id INT UNSIGNED).
-- Photos stay on disk (server/uploads/redemptions/); this table stores metadata
-- so requests survive API restarts.
-- =============================================================================

CREATE TABLE IF NOT EXISTS reward_redemptions (
  redemption_id   VARCHAR(32) NOT NULL PRIMARY KEY COMMENT 'Client/server id e.g. RDM...',
  user_id          INT UNSIGNED NOT NULL,
  user_name        VARCHAR(200) NOT NULL,
  user_email       VARCHAR(190) NOT NULL DEFAULT '',
  reward_id        VARCHAR(64) NOT NULL,
  reward_display   VARCHAR(200) NOT NULL,
  cost_points       INT UNSIGNED NOT NULL,
  photo_filename    VARCHAR(255) NOT NULL COMMENT 'Filename inside uploads/redemptions/',
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_reward_redemptions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  KEY idx_reward_redemptions_user (user_id),
  KEY idx_reward_redemptions_created (created_at),
  KEY idx_reward_redemptions_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Verify:
-- SHOW CREATE TABLE reward_redemptions;
-- SELECT * FROM reward_redemptions ORDER BY created_at DESC LIMIT 10;
