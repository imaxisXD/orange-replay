-- Migration 0011 adds GitHub-only Better Auth, membership, and auditable project keys.
-- Existing orgs receive no members here. A known owner must be linked deliberately.
PRAGMA defer_foreign_keys = on;

CREATE TABLE users (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0, image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, role TEXT, banned INTEGER NOT NULL DEFAULT 0, ban_reason TEXT, ban_expires INTEGER);
CREATE UNIQUE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_created_at ON users(created_at);

CREATE TABLE auth_sessions (id TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL, token TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, active_org_id TEXT, impersonated_by TEXT);
CREATE UNIQUE INDEX idx_auth_sessions_token ON auth_sessions(token);
CREATE INDEX idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX idx_auth_sessions_expires_at ON auth_sessions(expires_at);

CREATE TABLE auth_accounts (id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX idx_auth_accounts_provider_account ON auth_accounts(provider_id, account_id);
CREATE INDEX idx_auth_accounts_user_id ON auth_accounts(user_id);

CREATE TABLE auth_verifications (id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX idx_auth_verifications_identifier ON auth_verifications(identifier);

CREATE TABLE auth_rate_limits (id TEXT PRIMARY KEY NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL, last_request INTEGER NOT NULL);
CREATE UNIQUE INDEX idx_auth_rate_limits_key ON auth_rate_limits(key);

ALTER TABLE orgs RENAME TO orgs_before_0011;
CREATE TABLE orgs (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL DEFAULT ('legacy-' || lower(hex(randomblob(16)))), logo TEXT, metadata TEXT, shard INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
INSERT INTO orgs (id, name, slug, logo, metadata, shard, created_at) SELECT id, name, 'legacy-' || lower(hex(randomblob(16))), NULL, NULL, shard, created_at FROM orgs_before_0011;
DROP TABLE orgs_before_0011;
CREATE UNIQUE INDEX idx_orgs_slug ON orgs(slug);

CREATE TABLE members (id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'member', created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX idx_members_org_user ON members(org_id, user_id);
CREATE INDEX idx_members_user_id ON members(user_id);
CREATE INDEX idx_members_org_id ON members(org_id);

CREATE TABLE invitations (id TEXT PRIMARY KEY NOT NULL, org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE, email TEXT NOT NULL, role TEXT, status TEXT NOT NULL DEFAULT 'pending', expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
CREATE INDEX idx_invitations_org_id ON invitations(org_id);
CREATE INDEX idx_invitations_email ON invitations(email);

ALTER TABLE keys RENAME TO keys_before_0011;
CREATE TABLE keys (key_hash TEXT PRIMARY KEY NOT NULL, id TEXT NOT NULL DEFAULT ('key_legacy_' || lower(hex(randomblob(16)))), project_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT 'Legacy key', active INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at INTEGER NOT NULL, revoked_at INTEGER, revoked_by TEXT);
INSERT INTO keys (key_hash, id, project_id, name, active, created_by, created_at, revoked_at, revoked_by) SELECT key_hash, 'key_legacy_' || substr(key_hash, 1, 40), project_id, 'Legacy key ' || substr(key_hash, 1, 8), active, NULL, created_at, CASE WHEN active = 0 THEN created_at ELSE NULL END, NULL FROM keys_before_0011;
DROP TABLE keys_before_0011;
CREATE UNIQUE INDEX idx_keys_id ON keys(id);
CREATE INDEX idx_keys_project_active ON keys(project_id, active);
CREATE INDEX idx_projects_org_id ON projects(org_id);

PRAGMA optimize;
