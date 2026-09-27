-- Login rate limiting.
--
-- Keyed on (email, ip) rather than either alone: per-email-only would let one
-- attacker distributed across IPs keep hammering a single account, and
-- per-IP-only would let one attacker rotate the email to dodge the limit.
-- Requiring both to match narrows a lockout to the actual attack pattern.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS login_attempts (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email      VARCHAR(255)    NOT NULL,
  ip         VARCHAR(45)     NOT NULL,  -- fits IPv6
  attempted_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_login_attempts_lookup (email, ip, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
