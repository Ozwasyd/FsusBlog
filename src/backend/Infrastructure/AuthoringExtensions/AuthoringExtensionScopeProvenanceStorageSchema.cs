namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>
/// Unregistered leaf proposal. The migration and original state owners must review the insertion
/// witness trigger before installation. No store executes DDL and no production DI is supplied.
/// The trigger records an actual original INSERT, never an ON CONFLICT no-op. Its update of the
/// Pending row occurs inside the original initializer transaction and survives a host crash.
/// </summary>
public static class AuthoringExtensionScopeProvenanceStorageSchema
{
    public const string CreateTablesSql = """
        CREATE TABLE authoring_extension_scope_provenance (
            registration_id varchar(64) COLLATE "C" PRIMARY KEY CHECK (registration_id ~ '^[0-9a-f]{64}$'),
            scope_id varchar(64) COLLATE "C" UNIQUE NOT NULL CHECK (scope_id ~ '^[0-9a-f]{64}$'),
            owner_admin_principal_id bigint NOT NULL CHECK (owner_admin_principal_id > 0),
            policy_version varchar(128) COLLATE "C" NOT NULL,
            status smallint NOT NULL CHECK (status BETWEEN 0 AND 2),
            revision bigint NOT NULL CHECK (revision >= 0),
            scope_payload bytea NOT NULL CHECK (octet_length(scope_payload) <= 8192),
            package_identity varchar(64) COLLATE "C" NOT NULL CHECK (package_identity ~ '^[0-9a-f]{64}$'),
            initial_payload bytea NOT NULL CHECK (octet_length(initial_payload) <= 8192),
            creation_seen boolean NOT NULL DEFAULT false
        );
        CREATE FUNCTION authoring_extension_scope_creation_witness() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'TRUNCATE' THEN
                UPDATE authoring_extension_scope_provenance SET status = 2, revision = revision + 1
                WHERE status <> 2;
                RETURN NULL;
            END IF;
            IF TG_OP = 'INSERT' THEN
                UPDATE authoring_extension_scope_provenance
                SET creation_seen = true
                WHERE registration_id = current_setting('fsus.authoring_scope_registration', true)
                    AND scope_id = NEW.scope_id AND status = 0 AND revision = 0
                    AND NOT creation_seen AND NEW.revision = 0 AND NEW.fence IS NULL
                    AND initial_payload = NEW.payload;
                RETURN NEW;
            END IF;
            IF TG_OP = 'DELETE' OR OLD.scope_id IS DISTINCT FROM NEW.scope_id THEN
                UPDATE authoring_extension_scope_provenance SET status = 2, revision = revision + 1
                WHERE scope_id = OLD.scope_id AND status <> 2;
            END IF;
            RETURN NULL;
        END $$;
        CREATE TRIGGER authoring_extension_scope_creation_witness
            AFTER INSERT OR DELETE OR UPDATE OF scope_id ON authoring_extension_state_scope
            FOR EACH ROW EXECUTE FUNCTION authoring_extension_scope_creation_witness();
        CREATE TRIGGER authoring_extension_scope_truncate_witness
            BEFORE TRUNCATE ON authoring_extension_state_scope
            FOR EACH STATEMENT EXECUTE FUNCTION authoring_extension_scope_creation_witness();
        """;
}
