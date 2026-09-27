-- Revocable refresh tokens.
--
-- Refresh tokens were stateless: signed, valid for thirty days, and impossible
-- to withdraw. Logging out threw the token away on the device but the token
-- itself stayed valid, so a copy taken beforehand kept working for a month.
--
-- Each issued refresh token now has a row here, and refreshing *rotates*: the
-- old row is marked used and a new one takes its place. That turns a stolen
-- token into a detectable event rather than a silent one — see the `family`
-- column below.
--
-- Access tokens are deliberately left stateless. They live fifteen minutes, and
-- checking a database row on every single request to shorten that window to
-- nothing is a poor trade on shared hosting.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  -- The JWT's own jti claim. Unique, so one token maps to exactly one row.
  jti        CHAR(16)        NOT NULL,
  -- One login, followed through every rotation. Rotation keeps the family and
  -- changes the jti, so "log out this session" means revoking a family, and
  -- reuse of an already-rotated token can burn every descendant of it at once.
  family     CHAR(32)        NOT NULL,
  issued_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME        NOT NULL,
  -- Set when the token is exchanged. A second exchange of the same token is
  -- the signature of a stolen copy: the legitimate client already moved on.
  used_at    DATETIME        DEFAULT NULL,
  revoked_at DATETIME        DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_refresh_jti (jti),
  KEY idx_refresh_user (user_id),
  KEY idx_refresh_family (family),
  KEY idx_refresh_expiry (expires_at),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
