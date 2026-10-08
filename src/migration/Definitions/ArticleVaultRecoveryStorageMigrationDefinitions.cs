namespace FsusBlog.Migration.Definitions;

/// <summary>Defines owned private backup/journal storage; authoritative registration remains root-owned.</summary>
internal static class ArticleVaultRecoveryStorageMigrationDefinitions
{
    internal const string MigrationId = "20261008-post-article-vault-resolution-recovery-storage";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(MigrationId,
            "Retain immutable recovery associations while erasing expired encrypted payloads.",
            SchemaMigrationPhase.PostCodeFirst, Transactional: true,
            Steps:
            [new RawSqlStep("""
                CREATE TABLE article_vault_recovery_backup (
                    backup_identity varchar(128) PRIMARY KEY,
                    content_sha256 varchar(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
                    proposal_identity varchar(128) NOT NULL
                        REFERENCES article_vault_resolution_proposal(resolution_operation_identity) ON DELETE RESTRICT,
                    site_identity varchar(128) NOT NULL,
                    vault_identity varchar(128) NOT NULL,
                    device_identity varchar(128) NOT NULL,
                    delete_after_unix_ms bigint NOT NULL CHECK (delete_after_unix_ms > 0),
                    receipt_bytes bytea NOT NULL CHECK (octet_length(receipt_bytes) BETWEEN 1 AND 65536)
                );
                CREATE TABLE article_vault_recovery_backup_payload (
                    backup_identity varchar(128) PRIMARY KEY
                        REFERENCES article_vault_recovery_backup(backup_identity) ON DELETE RESTRICT,
                    ciphertext bytea CHECK (octet_length(ciphertext) BETWEEN 1 AND 16842752),
                    erased_at_unix_ms bigint,
                    CHECK ((ciphertext IS NULL) = (erased_at_unix_ms IS NOT NULL))
                );
                CREATE TABLE article_vault_recovery_journal (
                    resolution_identity varchar(128) NOT NULL
                        REFERENCES article_vault_resolution_proposal(resolution_operation_identity) ON DELETE RESTRICT,
                    sequence bigint NOT NULL CHECK (sequence BETWEEN 0 AND 9999),
                    content_sha256 varchar(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
                    association_sha256 varchar(64) NOT NULL CHECK (association_sha256 ~ '^[0-9a-f]{64}$'),
                    operation_identity varchar(64) NOT NULL,
                    operation_sequence bigint NOT NULL CHECK (operation_sequence >= 0),
                    operation_checkpoint_sha256 varchar(64) NOT NULL CHECK (operation_checkpoint_sha256 ~ '^[0-9a-f]{64}$'),
                    backup_identity varchar(128) NOT NULL
                        REFERENCES article_vault_recovery_backup(backup_identity) ON DELETE RESTRICT,
                    journal_bytes bytea NOT NULL CHECK (octet_length(journal_bytes) BETWEEN 1 AND 65536),
                    association_bytes bytea NOT NULL CHECK (octet_length(association_bytes) BETWEEN 1 AND 65536),
                    PRIMARY KEY (resolution_identity, sequence),
                    FOREIGN KEY (operation_identity, operation_sequence)
                        REFERENCES article_vault_operation_checkpoint(operation_identity, sequence)
                        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
                );
                CREATE FUNCTION reject_article_vault_recovery_metadata_mutation()
                RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    RAISE EXCEPTION 'article_vault_recovery_metadata_immutable';
                END;
                $$;
                CREATE TRIGGER article_vault_recovery_backup_immutable
                    BEFORE UPDATE OR DELETE ON article_vault_recovery_backup
                    FOR EACH ROW EXECUTE FUNCTION reject_article_vault_recovery_metadata_mutation();
                CREATE TRIGGER article_vault_recovery_backup_no_truncate
                    BEFORE TRUNCATE ON article_vault_recovery_backup
                    FOR EACH STATEMENT EXECUTE FUNCTION reject_article_vault_recovery_metadata_mutation();
                CREATE TRIGGER article_vault_recovery_journal_immutable
                    BEFORE UPDATE OR DELETE ON article_vault_recovery_journal
                    FOR EACH ROW EXECUTE FUNCTION reject_article_vault_recovery_metadata_mutation();
                CREATE TRIGGER article_vault_recovery_journal_no_truncate
                    BEFORE TRUNCATE ON article_vault_recovery_journal
                    FOR EACH STATEMENT EXECUTE FUNCTION reject_article_vault_recovery_metadata_mutation();
                CREATE FUNCTION guard_article_vault_recovery_payload_erasure()
                RETURNS trigger LANGUAGE plpgsql AS $$
                DECLARE expiry bigint;
                BEGIN
                    IF TG_OP <> 'UPDATE' THEN
                        RAISE EXCEPTION 'article_vault_recovery_payload_erasure_only';
                    END IF;
                    SELECT delete_after_unix_ms INTO expiry FROM article_vault_recovery_backup
                        WHERE backup_identity = OLD.backup_identity;
                    IF NEW.backup_identity IS DISTINCT FROM OLD.backup_identity OR OLD.ciphertext IS NULL
                        OR NEW.ciphertext IS NOT NULL OR NEW.erased_at_unix_ms IS NULL
                        OR NEW.erased_at_unix_ms < expiry
                        OR floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint < expiry THEN
                        RAISE EXCEPTION 'article_vault_recovery_payload_erasure_only';
                    END IF;
                    RETURN NEW;
                END;
                $$;
                CREATE TRIGGER article_vault_recovery_payload_guard
                    BEFORE UPDATE OR DELETE ON article_vault_recovery_backup_payload
                    FOR EACH ROW EXECUTE FUNCTION guard_article_vault_recovery_payload_erasure();
                CREATE TRIGGER article_vault_recovery_payload_no_truncate
                    BEFORE TRUNCATE ON article_vault_recovery_backup_payload
                    FOR EACH STATEMENT EXECUTE FUNCTION reject_article_vault_recovery_metadata_mutation();
                CREATE FUNCTION verify_article_vault_recovery_checkpoint_binding()
                RETURNS trigger LANGUAGE plpgsql AS $$
                DECLARE actual_digest varchar(64);
                BEGIN
                    SELECT content_sha256 INTO actual_digest FROM article_vault_operation_checkpoint
                        WHERE operation_identity = NEW.operation_identity AND sequence = NEW.operation_sequence;
                    IF actual_digest IS DISTINCT FROM NEW.operation_checkpoint_sha256 THEN
                        RAISE EXCEPTION 'article_vault_recovery_checkpoint_binding_invalid';
                    END IF;
                    RETURN NEW;
                END;
                $$;
                CREATE CONSTRAINT TRIGGER article_vault_recovery_checkpoint_binding
                    AFTER INSERT ON article_vault_recovery_journal DEFERRABLE INITIALLY DEFERRED
                    FOR EACH ROW EXECUTE FUNCTION verify_article_vault_recovery_checkpoint_binding();
                """)]);
}
