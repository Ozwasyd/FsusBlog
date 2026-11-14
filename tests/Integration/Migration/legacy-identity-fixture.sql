-- Post-cutover v1 identity fields from the pinned SqlSugar entities.
-- Ordinary account 7 and administrator 7 are independent source principals.
CREATE TABLE sys_user (
    id integer PRIMARY KEY, public_handle varchar(64), identity_kind varchar(32) NOT NULL,
    account_subject_hash varchar(64), registration_state varchar(24) NOT NULL,
    passkey_enabled boolean NOT NULL, passkey_user_handle varchar(128), passkey_signal_version bigint NOT NULL,
    recovery_enabled boolean NOT NULL, status integer NOT NULL, ban_state_generation bigint NOT NULL,
    mfaenabled boolean NOT NULL, passwordhash varchar(256)
);
INSERT INTO sys_user VALUES
    (7, 'fixture-public-handle', 'anonymous_account',
     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'active',
     true, 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 4, true, 0, 1, true, NULL),
    (8, NULL, 'anonymous_account',
     'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'suspended',
     false, NULL, 0, false, 1, 2, false, 'fixture-residual-password-hash');

CREATE TABLE admin_principal (
    id bigint PRIMARY KEY, handle varchar(64) NOT NULL UNIQUE, status varchar(32) NOT NULL,
    validationversion bigint NOT NULL, isroot boolean NOT NULL, permissions text NOT NULL,
    totpenabled boolean NOT NULL, totpsecretencrypted text
);
INSERT INTO admin_principal VALUES
    (7, 'fixture-admin-handle', 'active', 5, true, 'article.write
article.publish', true, 'fixture-admin-totp-ciphertext'),
    (5000000007, 'fixture-disabled-admin', 'disabled', 2, false, '', false, NULL);

CREATE TABLE passkey_credential (
    id integer PRIMARY KEY, account_id integer NOT NULL, credentialid varchar(512) NOT NULL,
    publickey text NOT NULL, signcount bigint NOT NULL, backupeligible boolean NOT NULL, backupstate boolean NOT NULL
);
INSERT INTO passkey_credential VALUES
    (1, 7, 'AAECAwQFBgcICQoLDA0ODw',
     'pQECAyYgASFYIGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWIlggT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU', 8, true, true);

CREATE TABLE admin_passkey_credential (
    id bigint PRIMARY KEY, adminprincipalid bigint NOT NULL, credentialid varchar(512) NOT NULL,
    userhandle varchar(128) NOT NULL, publickey text NOT NULL, signcount bigint NOT NULL,
    backupeligible boolean NOT NULL, backupstate boolean NOT NULL
);
INSERT INTO admin_passkey_credential VALUES
    (1, 7, 'AQIDBAUGBwgJCgsMDQ4PEA', 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
     'pQECAyYgASFYIGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWIlggT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU', 11, true, false),
    (2, 7, 'AgMEBQYHCAkKCwwNDg8QEQ', 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
     'pQECAyYgASFYIGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWIlggT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU', 13, false, false);

CREATE TABLE user_mfa_profile (
    id bigint PRIMARY KEY, user_id integer NOT NULL, hash_version smallint NOT NULL,
    mfa_secret_encrypted text, mfa_pending_secret_encrypted text, mfa_recovery_codes_hash text
);
INSERT INTO user_mfa_profile VALUES
    (1, 7, 1, 'fixture-user-totp-ciphertext', NULL, 'fixture-user-mfa-recovery-hash');

CREATE TABLE account_recovery_key (
    id integer PRIMARY KEY, account_id integer NOT NULL, key_version integer NOT NULL,
    key_hash text NOT NULL, lookup_id_hash text, created_at timestamp NOT NULL, used_at timestamp, revoked_at timestamp
);
INSERT INTO account_recovery_key VALUES
    (1, 7, 1, 'fixture-legacy-recovery-hash-1', 'fixture-legacy-recovery-lookup-1', '2026-10-01 00:00:00',
     '2026-10-02 00:00:00', NULL),
    (2, 7, 2, 'fixture-legacy-recovery-hash-2', 'fixture-legacy-recovery-lookup-2', '2026-10-02 00:00:00',
     NULL, '2026-10-03 00:00:00'),
    (3, 7, 3, 'fixture-legacy-recovery-hash-3', 'fixture-legacy-recovery-lookup-3', '2026-10-03 00:00:00', NULL, NULL);

CREATE TABLE sys_user_session (
    sessionid varchar(64) PRIMARY KEY, userid integer NOT NULL, refreshtokenhash varchar(128) NOT NULL,
    refresh_family_id varchar(64) NOT NULL, refresh_generation bigint NOT NULL, rememberme boolean NOT NULL,
    duration_policy varchar(24) NOT NULL, session_mode integer NOT NULL, refresh_compromised_at_utc timestamp,
    revokedat timestamp, idleexpiresat timestamp NOT NULL, absoluteexpiresat timestamp NOT NULL
);
INSERT INTO sys_user_session VALUES
    ('fixture-user-persistent-session', 7, 'fixture-refresh-token-hash-1', 'fixture-refresh-family-1', 2, true,
     'persistent_30d', 0, NULL, NULL, '2037-10-01 00:00:00', '2037-10-02 00:00:00'),
    ('fixture-user-revoked-session', 7, 'fixture-refresh-token-hash-2', 'fixture-refresh-family-2', 1, true,
     'persistent_30d', 2, '2026-10-02 00:00:00', '2026-10-02 00:00:00', '2037-10-01 00:00:00', '2037-10-02 00:00:00'),
    ('fixture-user-browser-session', 8, 'fixture-refresh-token-hash-3', 'fixture-refresh-family-3', 0, false,
     'browser_session', 1, NULL, NULL, '2037-10-01 00:00:00', '2037-10-02 00:00:00');

CREATE TABLE admin_session (
    sessionid varchar(64) PRIMARY KEY, adminprincipalid bigint NOT NULL, accesstokenhash varchar(128) NOT NULL,
    validationversion bigint NOT NULL, revokedatutc timestamp, idleexpiresatutc timestamp NOT NULL,
    absoluteexpiresatutc timestamp NOT NULL
);
INSERT INTO admin_session VALUES
    ('fixture-admin-session', 7, 'fixture-admin-session-hash', 5, NULL, '2037-10-01 00:00:00', '2037-10-02 00:00:00');

CREATE TABLE user_refresh_token_tombstone (
    id bigint PRIMARY KEY, token_hash varchar(64) NOT NULL, refresh_family_id varchar(64) NOT NULL,
    session_id varchar(64) NOT NULL, generation bigint NOT NULL, used_at_utc timestamp NOT NULL,
    expires_at_utc timestamp NOT NULL
);
INSERT INTO user_refresh_token_tombstone VALUES
    (1, 'fixture-tombstone-token-hash', 'fixture-refresh-family-1', 'fixture-user-persistent-session', 1,
     '2026-10-01 00:00:00', '2037-10-02 00:00:00');

CREATE TABLE account_enrollment_session (
    token_hash varchar(64) PRIMARY KEY, account_id integer NOT NULL, state varchar(24) NOT NULL,
    passkey_user_handle varchar(128) NOT NULL, protected_refresh_token text,
    created_at timestamp NOT NULL, expires_at timestamp NOT NULL
);
INSERT INTO account_enrollment_session VALUES
    ('fixture-enrollment-token-hash', 7, 'completed', 'fixture-enrollment-user-handle',
     'fixture-enrollment-protected-refresh-token', '2026-10-01 00:00:00', '2026-10-02 00:00:00');

CREATE TABLE admin_audit_log (
    id bigint PRIMARY KEY, adminprincipalid bigint, action varchar(96) NOT NULL, outcome varchar(32) NOT NULL,
    metadatajson text NOT NULL, occurredatutc timestamp NOT NULL
);
INSERT INTO admin_audit_log VALUES
    (1, 7, 'fixture-admin-audit-action', 'success', '{"detail":"fixture-admin-audit-payload"}', '2026-10-01 00:00:00');
