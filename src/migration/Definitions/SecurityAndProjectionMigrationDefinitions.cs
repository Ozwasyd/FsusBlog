using FsusBlog.Migration;

namespace FsusBlog.Migration.Definitions;

internal static class SecurityAndProjectionMigrationDefinitions
{
    internal static ISchemaMigrationDescriptor BuildAccountSubjectHashBackfillMigration()
        => new SchemaMigrationDescriptor(
            "20260711-post-account-subject-hash-backfill",
            "Backfill the physical account-subject projection with the canonical C# hasher and enforce its format.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: false,
            Steps:
            [
                new AccountSubjectHashBackfillStep(),
                new AssertSqlStep(
                    "Every account must have a canonical physical account-subject projection.",
                    """
                    DO $$
                    DECLARE
                        invalid_count integer;
                    BEGIN
                        SELECT COUNT(1)
                        INTO invalid_count
                        FROM sys_user
                        WHERE account_subject_hash IS NULL
                           OR btrim(account_subject_hash) = ''
                           OR account_subject_hash !~ '^[0-9a-f]{64}$';

                        IF invalid_count > 0 THEN
                            RAISE EXCEPTION 'Account subject projection backfill incomplete: invalid_count=%', invalid_count;
                        END IF;
                    END $$;
                    """),
                new RawSqlStep(
                    """
                    DO $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT 1
                            FROM pg_constraint
                            WHERE conname = 'ck_sys_user_account_subject_hash_format'
                              AND conrelid = 'sys_user'::regclass
                        ) THEN
                            ALTER TABLE sys_user
                            ADD CONSTRAINT ck_sys_user_account_subject_hash_format
                            CHECK (
                                account_subject_hash IS NULL
                                OR account_subject_hash ~ '^[0-9a-f]{64}$'
                            ) NOT VALID;
                        END IF;

                        ALTER TABLE sys_user
                        VALIDATE CONSTRAINT ck_sys_user_account_subject_hash_format;
                    END $$;
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildAdminAccountListKeysetIndexMigration()
        => new SchemaMigrationDescriptor(
            "20260629-pre-admin-account-list-keyset-indexes",
            "Add keyset and prefix-search indexes for admin anonymous account listing.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new CreateIndexStep(
                    "idx_user_admin_list_time_id",
                    "CREATE INDEX IF NOT EXISTS idx_user_admin_list_time_id ON sys_user(createtime DESC, id DESC);"),
                new CreateIndexStep(
                    "idx_user_admin_list_status_time_id",
                    "CREATE INDEX IF NOT EXISTS idx_user_admin_list_status_time_id ON sys_user(status, createtime DESC, id DESC);"),
                new CreateIndexStep(
                    "idx_user_admin_list_identity_time_id",
                    "CREATE INDEX IF NOT EXISTS idx_user_admin_list_identity_time_id ON sys_user(identity_kind, createtime DESC, id DESC);"),
                new CreateIndexStep(
                    "idx_user_public_handle_prefix",
                    "CREATE INDEX IF NOT EXISTS idx_user_public_handle_prefix ON sys_user(public_handle text_pattern_ops) WHERE public_handle IS NOT NULL;")
            ]);

    internal static ISchemaMigrationDescriptor BuildPasskeyUserHandleMigration()
        => new SchemaMigrationDescriptor(
            "20260621-pre-passkey-user-handle",
            "Add per-account stable random WebAuthn user handle storage for anonymous passkeys.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_user", "passkey_user_handle", "varchar(128) NULL")
            ]);

    internal static ISchemaMigrationDescriptor BuildPasskeyRecoveryKeyAccountIdMigration()
        => new SchemaMigrationDescriptor(
            "20260621-pre-passkey-recovery-key-account-id",
            "Rename passkey and recovery key credential ownership columns from user_id to account_id.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new DropIndexStep("idx_passkey_user_id"),
                new DropIndexStep("idx_account_recovery_key_user"),
                new DropIndexStep("idx_account_recovery_key_version"),
                new DropIndexStep("idx_account_recovery_key_active_unique"),
                new RenameColumnStep("passkey_credential", "user_id", "account_id"),
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'account_recovery_key'
                              AND column_name = 'user_id'
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'account_recovery_key'
                              AND column_name = 'account_id'
                        ) THEN
                            ALTER TABLE account_recovery_key ADD COLUMN account_id integer;
                            UPDATE account_recovery_key
                            SET account_id = user_id
                            WHERE account_id IS NULL;
                            ALTER TABLE account_recovery_key ALTER COLUMN account_id SET NOT NULL;
                        END IF;
                    END $$;
                    """),
                new CreateIndexStep(
                    "idx_passkey_account_id",
                    "CREATE INDEX IF NOT EXISTS idx_passkey_account_id ON passkey_credential(account_id);"),
                new CreateIndexStep(
                    "idx_account_recovery_key_account",
                    "CREATE INDEX IF NOT EXISTS idx_account_recovery_key_account ON account_recovery_key(account_id);"),
                new CreateIndexStep(
                    "idx_account_recovery_key_version",
                    "CREATE INDEX IF NOT EXISTS idx_account_recovery_key_version ON account_recovery_key(account_id, key_version DESC);"),
                new CreateIndexStep(
                    "idx_account_recovery_key_active_unique",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_account_recovery_key_active_unique ON account_recovery_key(account_id) WHERE used_at IS NULL AND revoked_at IS NULL;"),
                new CreateIndexStep(
                    "idx_account_recovery_key_lookup_active_unique",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_account_recovery_key_lookup_active_unique ON account_recovery_key(lookup_id_hash) WHERE lookup_id_hash IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL;")
            ]);

    internal static ISchemaMigrationDescriptor BuildPasskeyRecoveryKeyAccountIdPostCodeFirstCompatMigration()
        => new SchemaMigrationDescriptor(
            "20260615-post-passkey-recovery-key-account-id-compat",
            "Temporarily restore recovery key user_id compatibility after CodeFirst so the legacy recovery key descriptor remains idempotent.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'account_recovery_key'
                              AND column_name = 'account_id'
                        )
                        AND NOT EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'account_recovery_key'
                              AND column_name = 'user_id'
                        ) THEN
                            ALTER TABLE account_recovery_key ADD COLUMN user_id integer;
                            UPDATE account_recovery_key
                            SET user_id = account_id
                            WHERE user_id IS NULL;
                            ALTER TABLE account_recovery_key ALTER COLUMN user_id SET NOT NULL;
                        END IF;
                    END $$;
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildUserLegacyIdentityColumnsFinalizeMigration()
        => new SchemaMigrationDescriptor(
            "20260621-post-user-legacy-identity-columns-finalize",
            "Drop legacy sys_user password/role columns after anonymous account schema is authoritative.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new DropIndexStep("unique_idx_username"),
                new DropColumnStep("sys_user", "password", DestructiveMigrationProofs.For("20260621-post-user-legacy-identity-columns-finalize")),
                new DropColumnStep("sys_user", "role", DestructiveMigrationProofs.For("20260621-post-user-legacy-identity-columns-finalize")),
                new DropColumnStep("sys_user", "lastusernameupdatetime", DestructiveMigrationProofs.For("20260621-post-user-legacy-identity-columns-finalize")),
                new DropColumnStep("sys_user", "last_username_update_time", DestructiveMigrationProofs.For("20260621-post-user-legacy-identity-columns-finalize"))
            ]);

    internal static ISchemaMigrationDescriptor BuildSysUserUsernameFinalizeMigration()
        => new SchemaMigrationDescriptor(
            "20260621-post-sys-user-username-finalize",
            "Drop legacy sys_user username after CodeFirst has reconciled the anonymous account schema.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new DropColumnStep("sys_user", "username", DestructiveMigrationProofs.For("20260621-post-sys-user-username-finalize"))
            ]);

    internal static ISchemaMigrationDescriptor BuildAccountRecoveryKeyMigration()
        => new SchemaMigrationDescriptor(
            "20260616-post-account-recovery-key",
            "Create independent account recovery key storage for anonymous identity recovery.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "account_recovery_key",
                    """
                    CREATE TABLE IF NOT EXISTS account_recovery_key (
                        id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        user_id integer NOT NULL,
                        lookup_id_hash text NULL,
                        key_hash text NOT NULL,
                        key_version integer NOT NULL,
                        created_at timestamp NOT NULL DEFAULT now(),
                        used_at timestamp NULL,
                        revoked_at timestamp NULL
                    );
                    """),
                new EnsureColumnStep("account_recovery_key", "user_id", "integer NOT NULL"),
                new EnsureColumnStep("account_recovery_key", "lookup_id_hash", "text NULL"),
                new EnsureColumnStep("account_recovery_key", "key_hash", "text NOT NULL"),
                new EnsureColumnStep("account_recovery_key", "key_version", "integer NOT NULL"),
                new EnsureColumnStep("account_recovery_key", "created_at", "timestamp NOT NULL DEFAULT now()"),
                new EnsureColumnStep("account_recovery_key", "used_at", "timestamp NULL"),
                new EnsureColumnStep("account_recovery_key", "revoked_at", "timestamp NULL"),
                new CreateIndexStep(
                    "idx_account_recovery_key_user",
                    "CREATE INDEX IF NOT EXISTS idx_account_recovery_key_user ON account_recovery_key(user_id);"),
                new CreateIndexStep(
                    "idx_account_recovery_key_version",
                    "CREATE INDEX IF NOT EXISTS idx_account_recovery_key_version ON account_recovery_key(user_id, key_version DESC);"),
                new CreateIndexStep(
                    "idx_account_recovery_key_active_unique",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_account_recovery_key_active_unique ON account_recovery_key(user_id) WHERE used_at IS NULL AND revoked_at IS NULL;"),
                new CreateIndexStep(
                    "idx_account_recovery_key_lookup_active_unique",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_account_recovery_key_lookup_active_unique ON account_recovery_key(lookup_id_hash) WHERE lookup_id_hash IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL;")
            ]);

    internal static ISchemaMigrationDescriptor BuildPasskeyRecoveryKeyAccountIdFinalizerMigration()
        => new SchemaMigrationDescriptor(
            "20260621-post-passkey-recovery-key-account-id-finalize",
            "Finalize passkey and recovery key credential ownership indexes on account_id.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new DropIndexStep("idx_passkey_user_id"),
                new DropIndexStep("idx_account_recovery_key_user"),
                new DropIndexStep("idx_account_recovery_key_version"),
                new DropIndexStep("idx_account_recovery_key_active_unique"),
                new RenameColumnStep("account_recovery_key", "user_id", "account_id"),
                new CopyColumnToColumnStep("account_recovery_key", "user_id", "account_id"),
                new DropColumnStep("passkey_credential", "user_id", DestructiveMigrationProofs.For("20260621-post-passkey-recovery-key-account-id-finalize")),
                new DropColumnStep("account_recovery_key", "user_id", DestructiveMigrationProofs.For("20260621-post-passkey-recovery-key-account-id-finalize")),
                new CreateIndexStep(
                    "idx_passkey_account_id",
                    "CREATE INDEX IF NOT EXISTS idx_passkey_account_id ON passkey_credential(account_id);"),
                new CreateIndexStep(
                    "idx_account_recovery_key_account",
                    "CREATE INDEX IF NOT EXISTS idx_account_recovery_key_account ON account_recovery_key(account_id);"),
                new CreateIndexStep(
                    "idx_account_recovery_key_version",
                    "CREATE INDEX IF NOT EXISTS idx_account_recovery_key_version ON account_recovery_key(account_id, key_version DESC);"),
                new CreateIndexStep(
                    "idx_account_recovery_key_active_unique",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_account_recovery_key_active_unique ON account_recovery_key(account_id) WHERE used_at IS NULL AND revoked_at IS NULL;")
            ]);

    internal static ISchemaMigrationDescriptor BuildRecoveryPasskeyCompletionIdempotencyMigration()
        => new SchemaMigrationDescriptor(
            "20260711-post-recovery-passkey-completion-idempotency",
            "Persist recovery Passkey completion hashes for transactional and replay-safe account recovery.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("passkey_credential", "recovery_session_hash", "varchar(64) NULL"),
                new EnsureColumnStep("passkey_credential", "recovery_request_hash", "varchar(64) NULL"),
                new CreateIndexStep(
                    "ux_passkey_recovery_session_hash",
                    "CREATE UNIQUE INDEX IF NOT EXISTS ux_passkey_recovery_session_hash ON passkey_credential(recovery_session_hash) WHERE recovery_session_hash IS NOT NULL;")
            ]);

    internal static ISchemaMigrationDescriptor BuildAnonymousCredentialAccountBindingMigration()
        => new SchemaMigrationDescriptor(
            "20260621-pre-anonymous-credential-account-binding",
            "Rename anonymous credential account-bound columns away from user/ZK commitment semantics.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new DropIndexStep("idx_anonymous_credential_user"),
                new DropIndexStep("unique_idx_anonymous_credential_commitment"),
                new RenameColumnStep("anonymous_credential", "user_id", "account_id"),
                new RenameColumnStep("anonymous_credential", "commitment_hash", "account_binding_hash"),
                new BackfillSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'anonymous_credential'
                              AND column_name = 'credential_type'
                        ) THEN
                            UPDATE anonymous_credential
                            SET credential_type = 'account_bound'
                            WHERE credential_type IS NULL OR credential_type <> 'account_bound';
                        END IF;
                    END $$;
                    """),
                new CreateIndexStep(
                    "idx_anonymous_credential_account",
                    "CREATE INDEX IF NOT EXISTS idx_anonymous_credential_account ON anonymous_credential(account_id);"),
                new CreateIndexStep(
                    "unique_idx_anonymous_credential_account_binding",
                    "CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_account_binding ON anonymous_credential(account_binding_hash);")
            ]);

    internal static ISchemaMigrationDescriptor BuildAnonymousCredentialAccountBindingLegacyCompatibilityMigration()
        => new SchemaMigrationDescriptor(
            "20260615-post-anonymous-credential-account-binding-legacy-compat",
            "Temporarily expose legacy anonymous credential columns so the old governance descriptor remains idempotent on fresh databases.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("anonymous_credential", "user_id", "integer NULL"),
                new EnsureColumnStep("anonymous_credential", "commitment_hash", "varchar(128) NULL")
            ]);

    internal static ISchemaMigrationDescriptor BuildAnonymousCommentGovernanceMigration()
        => new SchemaMigrationDescriptor(
            "20260616-post-anonymous-comment-governance",
            "Create anonymous comment policy, credential, and nullifier governance tables.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "anonymous_comment_policy",
                    """
                    CREATE TABLE IF NOT EXISTS anonymous_comment_policy (
                        id integer PRIMARY KEY,
                        anonymous_comments_enabled boolean NOT NULL DEFAULT true,
                        public_comments_enabled boolean NOT NULL DEFAULT true,
                        zk_anonymous_enabled boolean NOT NULL DEFAULT false,
                        default_author_mode varchar(32) NOT NULL DEFAULT 'anonymous',
                        supported_display_languages varchar(128) NOT NULL DEFAULT 'zh-CN,en',
                        comment_max_chars integer NOT NULL DEFAULT 1000,
                        comment_max_utf8_bytes integer NOT NULL DEFAULT 4096,
                        snapshot_hash varchar(64) NOT NULL DEFAULT '',
                        updated_reason varchar(256) NULL,
                        changed_by varchar(64) NOT NULL DEFAULT 'system',
                        updated_at_utc timestamp NOT NULL DEFAULT now(),
                        updated_by_admin_id bigint NULL
                    );
                    INSERT INTO anonymous_comment_policy (
                        id,
                        anonymous_comments_enabled,
                        public_comments_enabled,
                        zk_anonymous_enabled,
                        default_author_mode,
                        supported_display_languages,
                        comment_max_chars,
                        comment_max_utf8_bytes,
                        snapshot_hash,
                        changed_by,
                        updated_at_utc
                    )
                    VALUES (1, true, true, false, 'anonymous', 'zh-CN,en', 1000, 4096, '', 'system', now())
                    ON CONFLICT (id) DO NOTHING;
                    """),
                new EnsureColumnStep("anonymous_comment_policy", "snapshot_hash", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("anonymous_comment_policy", "updated_reason", "varchar(256) NULL"),
                new EnsureColumnStep("anonymous_comment_policy", "changed_by", "varchar(64) NOT NULL DEFAULT 'system'"),
                new EnsureColumnStep("anonymous_comment_policy", "comment_max_chars", "integer NOT NULL DEFAULT 1000"),
                new EnsureColumnStep("anonymous_comment_policy", "comment_max_utf8_bytes", "integer NOT NULL DEFAULT 4096"),
                new EnsureTableStep(
                    "anonymous_credential",
                    """
                    CREATE TABLE IF NOT EXISTS anonymous_credential (
                        id bigserial PRIMARY KEY,
                        user_id integer NULL,
                        commitment_hash varchar(128) NOT NULL,
                        credential_type varchar(32) NOT NULL DEFAULT 'account_bound',
                        credential_level varchar(32) NOT NULL DEFAULT 'basic',
                        status varchar(32) NOT NULL DEFAULT 'active',
                        issued_at_utc timestamp NOT NULL DEFAULT now(),
                        revoked_at_utc timestamp NULL,
                        metadata_json text NOT NULL DEFAULT '{}'
                    );
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_user ON anonymous_credential(user_id);
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_commitment ON anonymous_credential(commitment_hash);
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_status ON anonymous_credential(status);
                    """),
                new EnsureTableStep(
                    "comment_anonymous_nullifier",
                    """
                    CREATE TABLE IF NOT EXISTS comment_anonymous_nullifier (
                        id bigserial PRIMARY KEY,
                        nullifier_hash varchar(128) NOT NULL,
                        scope varchar(128) NOT NULL,
                        use_count integer NOT NULL DEFAULT 0,
                        first_comment_id bigint NULL,
                        last_comment_id bigint NULL,
                        blocked boolean NOT NULL DEFAULT false,
                        block_reason varchar(256) NULL,
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        updated_at_utc timestamp NOT NULL DEFAULT now()
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_comment_nullifier_scope ON comment_anonymous_nullifier(nullifier_hash, scope);
                    CREATE INDEX IF NOT EXISTS idx_comment_nullifier_blocked ON comment_anonymous_nullifier(blocked);
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildAnonymousCredentialAccountBindingFinalizeMigration()
        => new SchemaMigrationDescriptor(
            "20260621-post-anonymous-credential-account-binding-finalize",
            "Drop legacy anonymous credential account binding columns and ensure account-bound indexes.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new BackfillSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'anonymous_credential'
                              AND column_name = 'credential_type'
                        ) THEN
                            UPDATE anonymous_credential
                            SET credential_type = 'account_bound'
                            WHERE credential_type IS NULL OR credential_type <> 'account_bound';
                        END IF;
                    END $$;
                    """),
                new DropIndexStep("idx_anonymous_credential_user"),
                new DropIndexStep("unique_idx_anonymous_credential_commitment"),
                new DropColumnStep("anonymous_credential", "user_id", DestructiveMigrationProofs.For("20260621-post-anonymous-credential-account-binding-finalize")),
                new DropColumnStep("anonymous_credential", "commitment_hash", DestructiveMigrationProofs.For("20260621-post-anonymous-credential-account-binding-finalize")),
                new CreateIndexStep(
                    "idx_anonymous_credential_account",
                    "CREATE INDEX IF NOT EXISTS idx_anonymous_credential_account ON anonymous_credential(account_id);"),
                new CreateIndexStep(
                    "unique_idx_anonymous_credential_account_binding",
                    "CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_account_binding ON anonymous_credential(account_binding_hash);")
            ]);

    internal static ISchemaMigrationDescriptor BuildAnonymousCredentialIssuanceAuditMigration()
        => new SchemaMigrationDescriptor(
            "20260618-post-anonymous-credential-issuance-audit",
            "Create unlinkable anonymous credential issuance audit table.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "anonymous_credential_issuance_audit",
                    """
                    CREATE TABLE IF NOT EXISTS anonymous_credential_issuance_audit (
                        id bigserial PRIMARY KEY,
                        subject_hash varchar(64) NOT NULL,
                        epoch bigint NOT NULL,
                        status varchar(32) NOT NULL DEFAULT 'issued',
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        trace_id varchar(64) NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_issuance_subject ON anonymous_credential_issuance_audit(subject_hash);
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_issuance_subject_epoch ON anonymous_credential_issuance_audit(subject_hash, epoch);
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_issuance_epoch ON anonymous_credential_issuance_audit(epoch);
                    """),
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'anonymous_credential_issuance_audit'
                        ) THEN
                            ALTER TABLE anonymous_credential_issuance_audit
                                ADD COLUMN IF NOT EXISTS subject_hash varchar(64);

                            DELETE FROM anonymous_credential_issuance_audit
                            WHERE subject_hash IS NULL OR subject_hash = '';

                            ALTER TABLE anonymous_credential_issuance_audit
                                ALTER COLUMN subject_hash SET NOT NULL;

                            DROP INDEX IF EXISTS idx_anonymous_credential_issuance_user;
                            DROP INDEX IF EXISTS unique_idx_anonymous_credential_issuance_user_epoch;

                            CREATE INDEX IF NOT EXISTS idx_anonymous_credential_issuance_subject
                                ON anonymous_credential_issuance_audit(subject_hash);
                            CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_issuance_subject_epoch
                                ON anonymous_credential_issuance_audit(subject_hash, epoch);
                        END IF;
                    END $$;
                    """),
                new DropColumnStep("anonymous_credential_issuance_audit", "request_hash", DestructiveMigrationProofs.For("20260618-post-anonymous-credential-issuance-audit")),
                new DropColumnStep("anonymous_credential_issuance_audit", "user_id", DestructiveMigrationProofs.For("20260618-post-anonymous-credential-issuance-audit"))
            ]);

    internal static ISchemaMigrationDescriptor BuildSecurityRiskEventPersistenceMigration()
        => new SchemaMigrationDescriptor(
            "20260618-post-security-risk-event-persistence",
            "Create durable RiskControl event audit table.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "security_risk_event",
                    """
                    CREATE TABLE IF NOT EXISTS security_risk_event (
                        id varchar(64) PRIMARY KEY,
                        occurred_at_utc timestamp NOT NULL,
                        source varchar(64) NOT NULL,
                        reason varchar(64) NOT NULL,
                        action varchar(96) NOT NULL,
                        score_delta integer NOT NULL,
                        total_score integer NOT NULL,
                        ttl_seconds integer NOT NULL,
                        expires_at_utc timestamp NOT NULL,
                        subject_hash varchar(64) NULL,
                        route_key varchar(160) NULL,
                        client_ip_hash varchar(64) NULL,
                        device_fp_hash varchar(64) NULL,
                        path varchar(256) NULL,
                        method varchar(16) NULL,
                        user_agent varchar(256) NULL,
                        detail varchar(256) NULL,
                        trace_id varchar(64) NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_security_risk_event_source_reason_action ON security_risk_event(source, reason, action);
                    CREATE INDEX IF NOT EXISTS idx_security_risk_event_subject ON security_risk_event(subject_hash);
                    CREATE INDEX IF NOT EXISTS idx_security_risk_event_client_ip ON security_risk_event(client_ip_hash);
                    CREATE INDEX IF NOT EXISTS idx_security_risk_event_device ON security_risk_event(device_fp_hash);
                    CREATE INDEX IF NOT EXISTS idx_security_risk_event_expires ON security_risk_event(expires_at_utc);
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildSecurityRiskPseudonymEpochMigration()
        => new SchemaMigrationDescriptor(
            "20260715-post-security-risk-pseudonym-epoch",
            "Add keyed pseudonym epochs and remove historical unkeyed risk identity rows.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep(
                    "security_risk_event",
                    "pseudonym_epoch",
                    "integer NOT NULL DEFAULT 0"),
                new RawSqlStep("""
                    UPDATE security_risk_event
                    SET path = NULL,
                        user_agent = NULL
                    WHERE path IS NOT NULL OR user_agent IS NOT NULL;

                    DELETE FROM security_risk_event
                    WHERE pseudonym_epoch <= 0;
                    """),
                new CreateIndexStep(
                    "idx_security_risk_event_epoch",
                    "CREATE INDEX IF NOT EXISTS idx_security_risk_event_epoch ON security_risk_event(pseudonym_epoch);")
            ]);

    internal static ISchemaMigrationDescriptor BuildSecurityPolicySnapshotMigration()
        => new SchemaMigrationDescriptor(
            "20260619-post-security-policy-snapshot",
            "Create versioned RiskControl security policy snapshot storage.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "security_policy_snapshot",
                    """
                    CREATE TABLE IF NOT EXISTS security_policy_snapshot (
                        id bigserial PRIMARY KEY,
                        policy_id varchar(64) NOT NULL,
                        version bigint NOT NULL,
                        mode varchar(32) NOT NULL,
                        document text NOT NULL,
                        created_by_admin_id bigint NULL,
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        activated_at_utc timestamp NULL,
                        revoked_at_utc timestamp NULL,
                        is_last_known_good boolean NOT NULL DEFAULT false,
                        rollback_of_version bigint NULL,
                        reason varchar(128) NULL
                    );
                    CREATE TABLE IF NOT EXISTS security_policy_version_counter (
                        policy_id varchar(64) PRIMARY KEY,
                        last_version bigint NOT NULL DEFAULT 0,
                        updated_at_utc timestamp NOT NULL DEFAULT now()
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_security_policy_snapshot_policy_version
                        ON security_policy_snapshot(policy_id, version);
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_security_policy_snapshot_active
                        ON security_policy_snapshot(policy_id)
                        WHERE activated_at_utc IS NOT NULL AND revoked_at_utc IS NULL;
                    CREATE INDEX IF NOT EXISTS idx_security_policy_snapshot_lkg
                        ON security_policy_snapshot(policy_id, is_last_known_good, version DESC);
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildSecurityPolicyVersionCounterMigration()
        => new SchemaMigrationDescriptor(
            "20260625-post-security-policy-version-counter",
            "Create per-policy locked version counters for security policy snapshots.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "security_policy_version_counter",
                    """
                    CREATE TABLE IF NOT EXISTS security_policy_version_counter (
                        policy_id varchar(64) PRIMARY KEY,
                        last_version bigint NOT NULL DEFAULT 0,
                        updated_at_utc timestamp NOT NULL DEFAULT now()
                    );
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildAnonymousCredentialRootMetadataMigration()
        => new SchemaMigrationDescriptor(
            "20260618-post-anonymous-credential-root-metadata",
            "Create public anonymous credential root and circuit metadata table.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "anonymous_credential_root",
                    """
                    CREATE TABLE IF NOT EXISTS anonymous_credential_root (
                        epoch bigint PRIMARY KEY,
                        root_hash varchar(128) NOT NULL,
                        revocation_root_hash varchar(128) NOT NULL DEFAULT '',
                        circuit_id varchar(96) NOT NULL,
                        circuit_numeric_id integer NOT NULL DEFAULT 0,
                        verifying_key_hash varchar(128) NOT NULL,
                        issuer_public_key_hash varchar(128) NOT NULL DEFAULT '',
                        public_input_layout_version integer NOT NULL,
                        circuit_metadata text NULL,
                        root_attestation varchar(128) NOT NULL DEFAULT '',
                        root_attestation_key_id varchar(96) NOT NULL DEFAULT '',
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        expires_at_utc timestamp NOT NULL,
                        root_grace_expires_at_utc timestamp NOT NULL,
                        status varchar(32) NOT NULL DEFAULT 'active'
                    );
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_root_status_expires ON anonymous_credential_root(status, root_grace_expires_at_utc);
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_root_circuit ON anonymous_credential_root(circuit_id);
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildAnonymousCredentialRootLifecycleMigration()
        => new SchemaMigrationDescriptor(
            "20260619-post-anonymous-credential-root-lifecycle",
            "Create anonymous credential root lifecycle epoch and revocation storage.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "anonymous_credential_epoch",
                    """
                    CREATE TABLE IF NOT EXISTS anonymous_credential_epoch (
                        epoch bigint PRIMARY KEY,
                        status varchar(32) NOT NULL DEFAULT 'draft',
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        activated_at_utc timestamp NULL,
                        expires_at_utc timestamp NOT NULL,
                        root_grace_expires_at_utc timestamp NOT NULL,
                        active_root_hash varchar(128) NULL,
                        reason varchar(128) NULL
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_epoch_epoch ON anonymous_credential_epoch(epoch);
                    """),
                new EnsureColumnStep("anonymous_credential_root", "activated_at_utc", "timestamp NULL"),
                new EnsureColumnStep("anonymous_credential_root", "issuer_public_key_hash", "varchar(128) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("anonymous_credential_root", "root_attestation", "varchar(128) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("anonymous_credential_root", "root_attestation_key_id", "varchar(96) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("anonymous_credential_root", "revoked_at_utc", "timestamp NULL"),
                new EnsureColumnStep("anonymous_credential_root", "updated_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new EnsureColumnStep("anonymous_credential_root", "revoke_reason", "varchar(128) NULL"),
                new RawSqlStep("""
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_root_hash ON anonymous_credential_root(root_hash);
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_root_single_active ON anonymous_credential_root(status) WHERE status = 'active';
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_root_status_epoch ON anonymous_credential_root(status, epoch);
                    """),
                new EnsureTableStep(
                    "anonymous_credential_revocation",
                    """
                    CREATE TABLE IF NOT EXISTS anonymous_credential_revocation (
                        id bigserial PRIMARY KEY,
                        epoch bigint NOT NULL,
                        root_hash varchar(128) NOT NULL,
                        revocation_handle_hash varchar(128) NOT NULL,
                        revocation_root_hash varchar(128) NOT NULL,
                        reason varchar(128) NULL,
                        actor_id varchar(128) NULL,
                        revoked_at_utc timestamp NOT NULL DEFAULT now()
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_revocation_epoch_handle
                        ON anonymous_credential_revocation(epoch, revocation_handle_hash);
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_revocation_epoch ON anonymous_credential_revocation(epoch);
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildSecurityChallengePersistenceMigration()
        => new SchemaMigrationDescriptor(
            "20260618-post-security-challenge-persistence",
            "Create auditable security challenge issuance and verification attempt storage.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "security_challenge",
                    """
                    CREATE TABLE IF NOT EXISTS security_challenge (
                        id bigserial PRIMARY KEY,
                        challenge_id varchar(64) NOT NULL,
                        status varchar(32) NOT NULL DEFAULT 'issued',
                        kind varchar(64) NOT NULL DEFAULT '',
                        algorithm varchar(64) NOT NULL DEFAULT '',
                        action varchar(96) NOT NULL DEFAULT '',
                        route_key varchar(256) NOT NULL DEFAULT '',
                        subject_hash varchar(64) NOT NULL DEFAULT '',
                        client_ip_hash varchar(64) NOT NULL DEFAULT '',
                        device_fp_hash varchar(64) NOT NULL DEFAULT '',
                        policy_version varchar(64) NOT NULL DEFAULT '',
                        payload_hash varchar(64) NOT NULL DEFAULT '',
                        trace_id varchar(64) NULL,
                        traceparent varchar(128) NULL,
                        issued_at_utc timestamp NOT NULL DEFAULT now(),
                        expires_at_utc timestamp NOT NULL DEFAULT now(),
                        verified_at_utc timestamp NULL,
                        revoked_at_utc timestamp NULL,
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        updated_at_utc timestamp NOT NULL DEFAULT now(),
                        CONSTRAINT chk_security_challenge_status
                            CHECK (status IN ('issued', 'verified', 'expired', 'replayed', 'failed', 'revoked'))
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_security_challenge_id ON security_challenge(challenge_id);
                    CREATE INDEX IF NOT EXISTS idx_security_challenge_status_expiry ON security_challenge(status, expires_at_utc);
                    CREATE INDEX IF NOT EXISTS idx_security_challenge_action_route ON security_challenge(action, route_key);
                    CREATE INDEX IF NOT EXISTS idx_security_challenge_subject ON security_challenge(subject_hash);
                    """),
                new EnsureColumnStep("security_challenge", "challenge_id", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "status", "varchar(32) NOT NULL DEFAULT 'issued'"),
                new EnsureColumnStep("security_challenge", "kind", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "algorithm", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "action", "varchar(96) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "route_key", "varchar(256) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "subject_hash", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "client_ip_hash", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "device_fp_hash", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "policy_version", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "payload_hash", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "trace_id", "varchar(64) NULL"),
                new EnsureColumnStep("security_challenge", "traceparent", "varchar(128) NULL"),
                new EnsureColumnStep("security_challenge", "issued_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new EnsureColumnStep("security_challenge", "expires_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new EnsureColumnStep("security_challenge", "verified_at_utc", "timestamp NULL"),
                new EnsureColumnStep("security_challenge", "revoked_at_utc", "timestamp NULL"),
                new EnsureColumnStep("security_challenge", "created_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new EnsureColumnStep("security_challenge", "updated_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new EnsureTableStep(
                    "security_challenge_attempt",
                    """
                    CREATE TABLE IF NOT EXISTS security_challenge_attempt (
                        id bigserial PRIMARY KEY,
                        attempt_id varchar(64) NOT NULL,
                        challenge_id varchar(64) NOT NULL,
                        outcome varchar(32) NOT NULL,
                        reason varchar(128) NULL,
                        payload_hash varchar(64) NULL,
                        client_ip_hash varchar(64) NULL,
                        device_fp_hash varchar(64) NULL,
                        trace_id varchar(64) NULL,
                        traceparent varchar(128) NULL,
                        attempted_at_utc timestamp NOT NULL DEFAULT now(),
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        CONSTRAINT chk_security_challenge_attempt_outcome
                            CHECK (outcome IN ('verified', 'expired', 'replayed', 'failed', 'revoked'))
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_security_challenge_attempt_id ON security_challenge_attempt(attempt_id);
                    CREATE INDEX IF NOT EXISTS idx_security_challenge_attempt_challenge ON security_challenge_attempt(challenge_id, attempted_at_utc DESC);
                    CREATE INDEX IF NOT EXISTS idx_security_challenge_attempt_outcome ON security_challenge_attempt(outcome, attempted_at_utc DESC);
                    """),
                new EnsureColumnStep("security_challenge_attempt", "attempt_id", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge_attempt", "challenge_id", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge_attempt", "outcome", "varchar(32) NOT NULL DEFAULT 'failed'"),
                new EnsureColumnStep("security_challenge_attempt", "reason", "varchar(128) NULL"),
                new EnsureColumnStep("security_challenge_attempt", "payload_hash", "varchar(64) NULL"),
                new EnsureColumnStep("security_challenge_attempt", "client_ip_hash", "varchar(64) NULL"),
                new EnsureColumnStep("security_challenge_attempt", "device_fp_hash", "varchar(64) NULL"),
                new EnsureColumnStep("security_challenge_attempt", "trace_id", "varchar(64) NULL"),
                new EnsureColumnStep("security_challenge_attempt", "traceparent", "varchar(128) NULL"),
                new EnsureColumnStep("security_challenge_attempt", "attempted_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new EnsureColumnStep("security_challenge_attempt", "created_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new CreateIndexStep(
                    "unique_idx_security_challenge_id",
                    "CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_security_challenge_id ON security_challenge(challenge_id);"),
                new CreateIndexStep(
                    "idx_security_challenge_status_expiry",
                    "CREATE INDEX IF NOT EXISTS idx_security_challenge_status_expiry ON security_challenge(status, expires_at_utc);"),
                new CreateIndexStep(
                    "idx_security_challenge_action_route",
                    "CREATE INDEX IF NOT EXISTS idx_security_challenge_action_route ON security_challenge(action, route_key);"),
                new CreateIndexStep(
                    "idx_security_challenge_subject",
                    "CREATE INDEX IF NOT EXISTS idx_security_challenge_subject ON security_challenge(subject_hash);"),
                new CreateIndexStep(
                    "unique_idx_security_challenge_attempt_id",
                    "CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_security_challenge_attempt_id ON security_challenge_attempt(attempt_id);"),
                new CreateIndexStep(
                    "idx_security_challenge_attempt_challenge",
                    "CREATE INDEX IF NOT EXISTS idx_security_challenge_attempt_challenge ON security_challenge_attempt(challenge_id, attempted_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_security_challenge_attempt_outcome",
                    "CREATE INDEX IF NOT EXISTS idx_security_challenge_attempt_outcome ON security_challenge_attempt(outcome, attempted_at_utc DESC);")
            ]);

    internal static ISchemaMigrationDescriptor BuildCommentActorMigration()
        => new SchemaMigrationDescriptor(
            "20260617-post-comment-actor-anonymous-default",
            "Allow anonymous comment actors and persist author display projections on comments.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'comment'
                              AND column_name = 'user_id'
                              AND is_nullable = 'NO'
                        ) THEN
                            ALTER TABLE comment ALTER COLUMN user_id DROP NOT NULL;
                        END IF;
                    END $$;
                    """),
                new EnsureColumnStep("comment", "author_mode", "varchar(32) NOT NULL DEFAULT 'anonymous'"),
                new EnsureColumnStep("comment", "public_handle", "varchar(64) NULL"),
                new EnsureColumnStep("comment", "anonymous_handle", "varchar(64) NULL"),
                new EnsureColumnStep("comment", "anonymous_display_name", "varchar(96) NULL"),
                new EnsureColumnStep("comment", "anonymous_display_language", "varchar(16) NULL"),
                new EnsureColumnStep("comment", "anonymous_nullifier_hash", "varchar(128) NULL"),
                new EnsureColumnStep("comment", "anonymous_scope", "varchar(128) NULL"),
                new EnsureColumnStep("comment", "moderation_subject_hash", "varchar(128) NULL"),
                new EnsureColumnStep("comment", "credential_level", "varchar(32) NULL"),
                new EnsureColumnStep("comment", "reputation_bucket", "varchar(32) NULL"),
                new EnsureColumnStep("comment", "account_age_bucket", "varchar(32) NULL"),
                new CreateIndexStep(
                    "idx_comment_author_mode",
                    "CREATE INDEX IF NOT EXISTS idx_comment_author_mode ON comment(author_mode);"),
                new CreateIndexStep(
                    "idx_comment_anonymous_scope",
                    "CREATE INDEX IF NOT EXISTS idx_comment_anonymous_scope ON comment(anonymous_scope);"),
                new CreateIndexStep(
                    "idx_comment_moderation_subject_hash",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_subject_hash ON comment(moderation_subject_hash);")
            ]);

    internal static ISchemaMigrationDescriptor BuildCommentActorPreCodeFirstMigration()
        => new SchemaMigrationDescriptor(
            "20260620-pre-comment-actor-codefirst-compat",
            "Backfill comment actor columns before CodeFirst touches legacy comment tables.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'comment'
                              AND column_name = 'user_id'
                              AND is_nullable = 'NO'
                        ) THEN
                            ALTER TABLE comment ALTER COLUMN user_id DROP NOT NULL;
                        END IF;
                    END $$;
                    """),
                new EnsureColumnStep("comment", "author_mode", "varchar(32) NOT NULL DEFAULT 'public'")
            ]);

    internal static ISchemaMigrationDescriptor BuildCommentAttributionIndexFinalizerMigration()
        => new SchemaMigrationDescriptor(
            "20260621-post-comment-attribution-index-finalize",
            "Retire generic comment user_id index and keep only explicit public attribution lookup.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new DropIndexStep("idx_comment_user_id_desc"),
                new CreateIndexStep(
                    "idx_comment_attributable_public_user_id_desc",
                    "CREATE INDEX IF NOT EXISTS idx_comment_attributable_public_user_id_desc ON comment(user_id, id DESC) WHERE author_mode = 'public' AND user_id IS NOT NULL;")
            ]);

    internal static ISchemaMigrationDescriptor BuildAuditLogMigration()
        => new SchemaMigrationDescriptor(
            "20260418-post-audit-log",
            "Create structured audit log table and indexes.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "sys_audit_log",
                    """
                    CREATE TABLE IF NOT EXISTS sys_audit_log (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        source varchar(64) NOT NULL,
                        type varchar(32) NOT NULL,
                        occurred_at_utc timestamp NOT NULL,
                        event_info text NOT NULL,
                        context_payload bytea NULL
                    );
                    """),
                new EnsureColumnStep("sys_audit_log", "context_payload", "bytea"),
                new DropColumnStep("sys_audit_log", "context_json", DestructiveMigrationProofs.For("20260418-post-audit-log")),
                new CreateIndexStep(
                    "idx_audit_occurred_at_desc",
                    "CREATE INDEX IF NOT EXISTS idx_audit_occurred_at_desc ON sys_audit_log(occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_audit_source_time",
                    "CREATE INDEX IF NOT EXISTS idx_audit_source_time ON sys_audit_log(source, occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_audit_type_time",
                    "CREATE INDEX IF NOT EXISTS idx_audit_type_time ON sys_audit_log(type, occurred_at_utc DESC);")
            ]);

    internal static ISchemaMigrationDescriptor BuildAuditLogStructuredFieldsMigration()
        => new SchemaMigrationDescriptor(
            "20260603-post-audit-structured-fields",
            "Add structured audit fields, privacy hashes, and tamper-evidence metadata.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_audit_log", "actor_type", "varchar(32) NULL"),
                new EnsureColumnStep("sys_audit_log", "actor_id", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "actor_role", "varchar(32) NULL"),
                new EnsureColumnStep("sys_audit_log", "action", "varchar(96) NOT NULL DEFAULT ''log.recorded''"),
                new EnsureColumnStep("sys_audit_log", "target_type", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "target_id", "varchar(128) NULL"),
                new EnsureColumnStep("sys_audit_log", "outcome", "varchar(32) NOT NULL DEFAULT ''unknown''"),
                new EnsureColumnStep("sys_audit_log", "severity", "varchar(32) NOT NULL DEFAULT ''info''"),
                new EnsureColumnStep("sys_audit_log", "is_high_value", "boolean NOT NULL DEFAULT false"),
                new EnsureColumnStep("sys_audit_log", "trace_id", "varchar(128) NULL"),
                new EnsureColumnStep("sys_audit_log", "request_path", "varchar(256) NULL"),
                new EnsureColumnStep("sys_audit_log", "request_method", "varchar(16) NULL"),
                new EnsureColumnStep("sys_audit_log", "ip_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "user_agent_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "session_id_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "device_fingerprint_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "reason_code", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "context_json", "text NULL"),
                new EnsureColumnStep("sys_audit_log", "chain_id", "varchar(32) NULL"),
                new EnsureColumnStep("sys_audit_log", "prev_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "record_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "record_mac", "varchar(64) NULL"),
                new CreateIndexStep(
                    "idx_audit_action_time",
                    "CREATE INDEX IF NOT EXISTS idx_audit_action_time ON sys_audit_log(action, occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_audit_actor_time",
                    "CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON sys_audit_log(actor_id, occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_audit_target_time",
                    "CREATE INDEX IF NOT EXISTS idx_audit_target_time ON sys_audit_log(target_type, target_id, occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_audit_outcome_time",
                    "CREATE INDEX IF NOT EXISTS idx_audit_outcome_time ON sys_audit_log(outcome, occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_audit_record_hash",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_record_hash ON sys_audit_log(record_hash) WHERE record_hash IS NOT NULL;")
            ]);

    internal static ISchemaMigrationDescriptor BuildAuditLogStructuredFieldsPreCodeFirstMigration()
        => new SchemaMigrationDescriptor(
            "20260603-pre-audit-structured-fields-codefirst-compat",
            "Create structured audit fields before CodeFirst sync touches non-null audit columns.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_audit_log", "actor_type", "varchar(32) NULL"),
                new EnsureColumnStep("sys_audit_log", "actor_id", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "actor_role", "varchar(32) NULL"),
                new EnsureColumnStep("sys_audit_log", "action", "varchar(96) NULL DEFAULT ''log.recorded''"),
                new EnsureColumnStep("sys_audit_log", "target_type", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "target_id", "varchar(128) NULL"),
                new EnsureColumnStep("sys_audit_log", "outcome", "varchar(32) NULL DEFAULT ''unknown''"),
                new EnsureColumnStep("sys_audit_log", "severity", "varchar(32) NULL DEFAULT ''info''"),
                new EnsureColumnStep("sys_audit_log", "is_high_value", "boolean NULL DEFAULT false"),
                new EnsureColumnStep("sys_audit_log", "trace_id", "varchar(128) NULL"),
                new EnsureColumnStep("sys_audit_log", "request_path", "varchar(256) NULL"),
                new EnsureColumnStep("sys_audit_log", "request_method", "varchar(16) NULL"),
                new EnsureColumnStep("sys_audit_log", "ip_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "user_agent_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "session_id_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "device_fingerprint_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "reason_code", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "context_json", "text NULL"),
                new EnsureColumnStep("sys_audit_log", "chain_id", "varchar(32) NULL"),
                new EnsureColumnStep("sys_audit_log", "prev_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "record_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "record_mac", "varchar(64) NULL"),
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'sys_audit_log'
                        ) THEN
                            UPDATE sys_audit_log
                            SET action = COALESCE(action, 'log.recorded'),
                                outcome = COALESCE(outcome, 'unknown'),
                                severity = COALESCE(severity, 'info'),
                                is_high_value = COALESCE(is_high_value, false);

                            ALTER TABLE sys_audit_log ALTER COLUMN action SET NOT NULL;
                            ALTER TABLE sys_audit_log ALTER COLUMN outcome SET NOT NULL;
                            ALTER TABLE sys_audit_log ALTER COLUMN severity SET NOT NULL;
                            ALTER TABLE sys_audit_log ALTER COLUMN is_high_value SET NOT NULL;
                        END IF;
                    END $$;
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildAuditLogChainTailIndexMigration()
        => new SchemaMigrationDescriptor(
            "20260629-post-audit-chain-tail-index",
            "Add chain tail index for audit tamper evidence append lookups.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new CreateIndexStep(
                    "idx_audit_chain_tail",
                    "CREATE INDEX IF NOT EXISTS idx_audit_chain_tail ON sys_audit_log(chain_id, id DESC) WHERE record_hash IS NOT NULL;")
            ]);

    internal static ISchemaMigrationDescriptor BuildFrontendRumMetricMigration()
        => new SchemaMigrationDescriptor(
            "20260603-post-frontend-rum-metric",
            "Move browser RUM telemetry out of the security audit log.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "frontend_rum_metric",
                    """
                    CREATE TABLE IF NOT EXISTS frontend_rum_metric (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        name varchar(64) NOT NULL,
                        page_type varchar(32) NOT NULL,
                        aot_source varchar(32) NOT NULL,
                        value double precision NULL,
                        metrics_json text NOT NULL DEFAULT '{}',
                        occurred_at_utc timestamp NOT NULL,
                        created_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new CreateIndexStep(
                    "idx_rum_occurred_at_desc",
                    "CREATE INDEX IF NOT EXISTS idx_rum_occurred_at_desc ON frontend_rum_metric(occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_rum_name_time",
                    "CREATE INDEX IF NOT EXISTS idx_rum_name_time ON frontend_rum_metric(name, occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_rum_page_type_time",
                    "CREATE INDEX IF NOT EXISTS idx_rum_page_type_time ON frontend_rum_metric(page_type, occurred_at_utc DESC);")
            ]);

    internal static ISchemaMigrationDescriptor BuildCoverImageMigration()
        => new SchemaMigrationDescriptor(
            "20260508-pre-cover-image",
            "Add coverimageurl to article table.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("article", "coverimageurl", "VARCHAR(512)")
            ]);

    internal static ISchemaMigrationDescriptor BuildHumanReadEventMigration()
        => new SchemaMigrationDescriptor(
            "20260513-post-human-read-events",
            "Extend visit logs into the single human-read event source and seed legacy article views.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_visit_log", "event_type", "VARCHAR(32)"),
                new EnsureColumnStep("sys_visit_log", "route_key", "VARCHAR(200) NULL"),
                new EnsureColumnStep("sys_visit_log", "article_id", "INTEGER NULL"),
                new EnsureColumnStep("sys_visit_log", "viewer_key_hash", "VARCHAR(64) NULL"),
                new EnsureColumnStep("sys_visit_log", "proof_id", "VARCHAR(64) NULL"),
                new EnsureColumnStep("sys_visit_log", "dwell_ms", "INTEGER NOT NULL DEFAULT 0"),
                new BackfillSqlStep("UPDATE sys_visit_log SET event_type = 'site_read' WHERE event_type IS NULL;"),
                new EnsureTableStep(
                    "article_view_seed",
                    """
                    CREATE TABLE IF NOT EXISTS article_view_seed (
                        article_id integer PRIMARY KEY,
                        legacy_views integer NOT NULL DEFAULT 0,
                        seeded_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO article_view_seed(article_id, legacy_views, seeded_at_utc)
                    SELECT id, COALESCE(views, 0), now() AT TIME ZONE 'utc'
                    FROM article
                    ON CONFLICT (article_id) DO NOTHING;
                    """),
                new CreateIndexStep(
                    "idx_visit_event_time",
                    "CREATE INDEX IF NOT EXISTS idx_visit_event_time ON sys_visit_log(event_type, createtime DESC);"),
                new CreateIndexStep(
                    "idx_visit_article_time",
                    "CREATE INDEX IF NOT EXISTS idx_visit_article_time ON sys_visit_log(article_id, createtime DESC);"),
                new CreateIndexStep(
                    "idx_visit_proof_id",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_visit_proof_id ON sys_visit_log(proof_id) WHERE proof_id IS NOT NULL;")
            ]);

    internal static ISchemaMigrationDescriptor BuildVisitLogStatsRollupMigration()
        => new SchemaMigrationDescriptor(
            "20260629-post-visit-log-stats-rollup",
            "Add pre-aggregated visit log rollups for admin statistics.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "daily_read_stats",
                    """
                    CREATE TABLE IF NOT EXISTS daily_read_stats (
                        stat_date date PRIMARY KEY,
                        total_reads bigint NOT NULL DEFAULT 0,
                        human_verified_reads bigint NOT NULL DEFAULT 0,
                        unique_viewer_estimate bigint NOT NULL DEFAULT 0,
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new EnsureTableStep(
                    "region_read_stats",
                    """
                    CREATE TABLE IF NOT EXISTS region_read_stats (
                        region varchar(128) PRIMARY KEY,
                        read_count bigint NOT NULL DEFAULT 0,
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new EnsureTableStep(
                    "event_type_read_stats",
                    """
                    CREATE TABLE IF NOT EXISTS event_type_read_stats (
                        event_type varchar(32) PRIMARY KEY,
                        read_count bigint NOT NULL DEFAULT 0,
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO daily_read_stats(stat_date, total_reads, human_verified_reads, unique_viewer_estimate, updated_at_utc)
                    SELECT
                        createtime::date,
                        COUNT(1)::bigint,
                        COUNT(proof_id)::bigint,
                        COUNT(DISTINCT viewer_key_hash)::bigint,
                        now() AT TIME ZONE 'utc'
                    FROM sys_visit_log
                    GROUP BY createtime::date
                    ON CONFLICT (stat_date) DO UPDATE
                    SET total_reads = EXCLUDED.total_reads,
                        human_verified_reads = EXCLUDED.human_verified_reads,
                        unique_viewer_estimate = EXCLUDED.unique_viewer_estimate,
                        updated_at_utc = EXCLUDED.updated_at_utc;
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO region_read_stats(region, read_count, updated_at_utc)
                    SELECT
                        CASE
                            WHEN region IS NULL
                                OR btrim(region) = ''
                                OR lower(btrim(region)) = 'unknown'
                                OR btrim(region) = '未知'
                            THEN '未知地区'
                            ELSE btrim(region)
                        END,
                        COUNT(1)::bigint,
                        now() AT TIME ZONE 'utc'
                    FROM sys_visit_log
                    GROUP BY 1
                    ON CONFLICT (region) DO UPDATE
                    SET read_count = EXCLUDED.read_count,
                        updated_at_utc = EXCLUDED.updated_at_utc;
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO event_type_read_stats(event_type, read_count, updated_at_utc)
                    SELECT event_type, COUNT(1)::bigint, now() AT TIME ZONE 'utc'
                    FROM sys_visit_log
                    GROUP BY event_type
                    ON CONFLICT (event_type) DO UPDATE
                    SET read_count = EXCLUDED.read_count,
                        updated_at_utc = EXCLUDED.updated_at_utc;
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildArticleViewProjectionWatermarkMigration()
        => new SchemaMigrationDescriptor(
            "20260629-post-article-view-projection-watermark",
            "Create durable article view projection repair watermark state.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "article_view_projection_watermark",
                    """
                    CREATE TABLE IF NOT EXISTS article_view_projection_watermark (
                        id varchar(96) PRIMARY KEY,
                        last_visit_log_id integer NOT NULL DEFAULT 0,
                        last_full_reconcile_utc timestamp NULL,
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO article_view_projection_watermark(
                        id,
                        last_visit_log_id,
                        last_full_reconcile_utc,
                        updated_at_utc
                    )
                    SELECT
                        'article_view_projection_watermark',
                        COALESCE(MAX(id), 0),
                        now() AT TIME ZONE 'utc',
                        now() AT TIME ZONE 'utc'
                    FROM sys_visit_log
                    ON CONFLICT (id) DO NOTHING;
                    """)
            ]);

    internal static ISchemaMigrationDescriptor BuildTaxonomyCountProjectionMigration()
        => new SchemaMigrationDescriptor(
            "20260629-post-taxonomy-count-projection",
            "Create public taxonomy count rollups for category/tag binary frames.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "category_public_article_count",
                    """
                    CREATE TABLE IF NOT EXISTS category_public_article_count (
                        category_id integer PRIMARY KEY,
                        article_count bigint NOT NULL DEFAULT 0,
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new EnsureTableStep(
                    "tag_public_article_count",
                    """
                    CREATE TABLE IF NOT EXISTS tag_public_article_count (
                        tag_id integer PRIMARY KEY,
                        article_count bigint NOT NULL DEFAULT 0,
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new EnsureTableStep(
                    "article_public_taxonomy_projection",
                    """
                    CREATE TABLE IF NOT EXISTS article_public_taxonomy_projection (
                        article_id integer PRIMARY KEY,
                        category_id integer NULL,
                        tag_ids text NOT NULL DEFAULT '',
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO article_public_taxonomy_projection(article_id, category_id, tag_ids, updated_at_utc)
                    SELECT
                        a.id,
                        a.categoryid,
                        COALESCE(string_agg(at.tagid::text, ',' ORDER BY at.tagid), ''),
                        now() AT TIME ZONE 'utc'
                    FROM article a
                    LEFT JOIN article_tag at ON at.articleid = a.id
                    WHERE a.isdeleted = false
                      AND a.status = 2
                      AND (a.published_at IS NULL OR a.published_at <= now() AT TIME ZONE 'utc')
                      AND (a.scheduled_publish_at IS NULL OR a.scheduled_publish_at <= now() AT TIME ZONE 'utc')
                    GROUP BY a.id, a.categoryid
                    ON CONFLICT (article_id) DO UPDATE
                    SET category_id = EXCLUDED.category_id,
                        tag_ids = EXCLUDED.tag_ids,
                        updated_at_utc = EXCLUDED.updated_at_utc;
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO category_public_article_count(category_id, article_count, updated_at_utc)
                    SELECT category_id, COUNT(1)::bigint, now() AT TIME ZONE 'utc'
                    FROM article_public_taxonomy_projection
                    WHERE category_id IS NOT NULL
                    GROUP BY category_id
                    ON CONFLICT (category_id) DO UPDATE
                    SET article_count = EXCLUDED.article_count,
                        updated_at_utc = EXCLUDED.updated_at_utc;
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO tag_public_article_count(tag_id, article_count, updated_at_utc)
                    SELECT tag_id::integer, COUNT(1)::bigint, now() AT TIME ZONE 'utc'
                    FROM article_public_taxonomy_projection,
                         regexp_split_to_table(tag_ids, ',') AS tag_id
                    WHERE tag_ids <> ''
                    GROUP BY tag_id
                    ON CONFLICT (tag_id) DO UPDATE
                    SET article_count = EXCLUDED.article_count,
                        updated_at_utc = EXCLUDED.updated_at_utc;
                    """)
            ]);

}
