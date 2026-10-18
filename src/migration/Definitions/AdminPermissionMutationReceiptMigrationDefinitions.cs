namespace FsusBlog.Migration.Definitions;

/// <summary>
/// Unregistered until the original source owner wires every authority writer to batch completion.
/// These triggers observe real OLD/NEW rows; neither callers nor projection refreshes mint facts.
/// </summary>
internal static class AdminPermissionMutationReceiptMigrationDefinitions
{
    internal const string MigrationId = "20261018-post-admin-permission-mutation-receipts";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Capture immutable admin authority transitions and require complete same-transaction batches.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps: [new RawSqlStep(Sql)]);

    internal const string Sql = """
        CREATE TABLE IF NOT EXISTS public.admin_permission_mutation_receipt (
            transaction_id xid8 NOT NULL,
            ordinal integer NOT NULL CHECK (ordinal > 0),
            subject_kind text NOT NULL CHECK (subject_kind IN ('principal', 'session')),
            mutation_kind text NOT NULL CHECK (mutation_kind IN ('INSERT', 'UPDATE', 'DELETE')),
            before_state jsonb NULL,
            after_state jsonb NULL,
            credential_changed boolean NOT NULL,
            PRIMARY KEY (transaction_id, ordinal),
            CHECK ((mutation_kind = 'INSERT' AND before_state IS NULL AND after_state IS NOT NULL)
                OR (mutation_kind = 'DELETE' AND before_state IS NOT NULL AND after_state IS NULL)
                OR (mutation_kind = 'UPDATE' AND before_state IS NOT NULL AND after_state IS NOT NULL))
        );
        CREATE TABLE IF NOT EXISTS public.admin_permission_mutation_receipt_batch (
            transaction_id xid8 PRIMARY KEY,
            transition_count integer NOT NULL CHECK (transition_count >= 0)
        );

        CREATE OR REPLACE FUNCTION public.admin_receipt_immutable() RETURNS trigger
        LANGUAGE plpgsql AS $body$
        BEGIN
            RAISE EXCEPTION 'admin_receipt_immutable' USING ERRCODE = '23514';
        END;
        $body$;

        CREATE OR REPLACE FUNCTION public.admin_receipt_insert_guard() RETURNS trigger
        LANGUAGE plpgsql AS $body$
        BEGIN
            IF pg_trigger_depth() <> 2 OR NEW.transaction_id <> pg_current_xact_id()
                OR NEW.ordinal <> (SELECT count(*) + 1 FROM public.admin_permission_mutation_receipt
                                    WHERE transaction_id = pg_current_xact_id()) THEN
                RAISE EXCEPTION 'admin_receipt_database_capture_required' USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $body$;

        CREATE OR REPLACE FUNCTION public.admin_receipt_seal_guard() RETURNS trigger
        LANGUAGE plpgsql AS $body$
        BEGIN
            IF NEW.transaction_id <> pg_current_xact_id()
                OR NEW.transition_count <> (SELECT count(*) FROM public.admin_permission_mutation_receipt
                                             WHERE transaction_id = pg_current_xact_id())
                OR EXISTS (SELECT 1 FROM public.admin_permission_mutation_receipt_batch
                           WHERE transaction_id = NEW.transaction_id AND transition_count <> NEW.transition_count) THEN
                RAISE EXCEPTION 'admin_receipt_partial_batch' USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $body$;

        CREATE OR REPLACE FUNCTION public.admin_receipt_require_seal() RETURNS trigger
        LANGUAGE plpgsql AS $body$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM public.admin_permission_mutation_receipt_batch
                           WHERE transaction_id = NEW.transaction_id
                           AND transition_count = (SELECT count(*) FROM public.admin_permission_mutation_receipt
                                                   WHERE transaction_id = NEW.transaction_id)) THEN
                RAISE EXCEPTION 'admin_receipt_unsealed_batch' USING ERRCODE = '23514';
            END IF;
            RETURN NULL;
        END;
        $body$;

        CREATE OR REPLACE FUNCTION public.admin_receipt_capture() RETURNS trigger
        LANGUAGE plpgsql AS $body$
        DECLARE
            before_facts jsonb;
            after_facts jsonb;
            changed_credential boolean := false;
            subject text;
        BEGIN
            IF TG_TABLE_NAME = 'admin_principal' THEN
                subject := 'principal';
                IF TG_OP <> 'INSERT' THEN
                    before_facts := jsonb_build_object('PrincipalId', OLD.id, 'Status', OLD.status,
                        'IsRoot', OLD.isroot, 'Permissions', OLD.permissions, 'ValidationVersion', OLD.validationversion);
                END IF;
                IF TG_OP <> 'DELETE' THEN
                    after_facts := jsonb_build_object('PrincipalId', NEW.id, 'Status', NEW.status,
                        'IsRoot', NEW.isroot, 'Permissions', NEW.permissions, 'ValidationVersion', NEW.validationversion);
                END IF;
            ELSE
                subject := 'session';
                IF TG_OP <> 'INSERT' THEN
                    before_facts := jsonb_build_object('PrincipalId', OLD.adminprincipalid, 'SessionId', OLD.sessionid,
                        'RevokedAtUtc', OLD.revokedatutc AT TIME ZONE 'UTC',
                        'IdleExpiresAtUtc', OLD.idleexpiresatutc AT TIME ZONE 'UTC',
                        'AbsoluteExpiresAtUtc', OLD.absoluteexpiresatutc AT TIME ZONE 'UTC',
                        'ValidationVersion', OLD.validationversion, 'StepUpVerified', OLD.stepupverified);
                END IF;
                IF TG_OP <> 'DELETE' THEN
                    after_facts := jsonb_build_object('PrincipalId', NEW.adminprincipalid, 'SessionId', NEW.sessionid,
                        'RevokedAtUtc', NEW.revokedatutc AT TIME ZONE 'UTC',
                        'IdleExpiresAtUtc', NEW.idleexpiresatutc AT TIME ZONE 'UTC',
                        'AbsoluteExpiresAtUtc', NEW.absoluteexpiresatutc AT TIME ZONE 'UTC',
                        'ValidationVersion', NEW.validationversion, 'StepUpVerified', NEW.stepupverified);
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    changed_credential := OLD.accesstokenhash IS DISTINCT FROM NEW.accesstokenhash;
                END IF;
            END IF;
            IF before_facts IS NOT DISTINCT FROM after_facts AND NOT changed_credential THEN
                RETURN NULL;
            END IF;
            IF EXISTS (SELECT 1 FROM public.admin_permission_mutation_receipt_batch
                       WHERE transaction_id = pg_current_xact_id()) THEN
                RAISE EXCEPTION 'admin_receipt_mutation_after_seal' USING ERRCODE = '23514';
            END IF;
            INSERT INTO public.admin_permission_mutation_receipt
                (transaction_id, ordinal, subject_kind, mutation_kind, before_state, after_state, credential_changed)
            SELECT pg_current_xact_id(), count(*)::integer + 1, subject, TG_OP,
                before_facts, after_facts, changed_credential
            FROM public.admin_permission_mutation_receipt WHERE transaction_id = pg_current_xact_id();
            RETURN NULL;
        END;
        $body$;

        DROP TRIGGER IF EXISTS admin_receipt_capture ON public.admin_principal;
        CREATE TRIGGER admin_receipt_capture AFTER INSERT OR UPDATE OR DELETE ON public.admin_principal
            FOR EACH ROW EXECUTE FUNCTION public.admin_receipt_capture();
        DROP TRIGGER IF EXISTS admin_receipt_capture ON public.admin_session;
        CREATE TRIGGER admin_receipt_capture AFTER INSERT OR UPDATE OR DELETE ON public.admin_session
            FOR EACH ROW EXECUTE FUNCTION public.admin_receipt_capture();

        DROP TRIGGER IF EXISTS admin_receipt_insert_guard ON public.admin_permission_mutation_receipt;
        CREATE TRIGGER admin_receipt_insert_guard BEFORE INSERT ON public.admin_permission_mutation_receipt
            FOR EACH ROW EXECUTE FUNCTION public.admin_receipt_insert_guard();
        DROP TRIGGER IF EXISTS admin_receipt_seal_guard ON public.admin_permission_mutation_receipt_batch;
        CREATE TRIGGER admin_receipt_seal_guard BEFORE INSERT ON public.admin_permission_mutation_receipt_batch
            FOR EACH ROW EXECUTE FUNCTION public.admin_receipt_seal_guard();
        DROP TRIGGER IF EXISTS admin_receipt_require_seal ON public.admin_permission_mutation_receipt;
        CREATE CONSTRAINT TRIGGER admin_receipt_require_seal AFTER INSERT ON public.admin_permission_mutation_receipt
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.admin_receipt_require_seal();

        DROP TRIGGER IF EXISTS admin_receipt_immutable ON public.admin_permission_mutation_receipt;
        CREATE TRIGGER admin_receipt_immutable BEFORE UPDATE OR DELETE ON public.admin_permission_mutation_receipt
            FOR EACH ROW EXECUTE FUNCTION public.admin_receipt_immutable();
        DROP TRIGGER IF EXISTS admin_receipt_immutable ON public.admin_permission_mutation_receipt_batch;
        CREATE TRIGGER admin_receipt_immutable BEFORE UPDATE OR DELETE ON public.admin_permission_mutation_receipt_batch
            FOR EACH ROW EXECUTE FUNCTION public.admin_receipt_immutable();
        DROP TRIGGER IF EXISTS admin_receipt_no_truncate ON public.admin_permission_mutation_receipt;
        CREATE TRIGGER admin_receipt_no_truncate BEFORE TRUNCATE ON public.admin_permission_mutation_receipt
            FOR EACH STATEMENT EXECUTE FUNCTION public.admin_receipt_immutable();
        DROP TRIGGER IF EXISTS admin_receipt_no_truncate ON public.admin_permission_mutation_receipt_batch;
        CREATE TRIGGER admin_receipt_no_truncate BEFORE TRUNCATE ON public.admin_permission_mutation_receipt_batch
            FOR EACH STATEMENT EXECUTE FUNCTION public.admin_receipt_immutable();
        DROP TRIGGER IF EXISTS admin_receipt_no_truncate ON public.admin_principal;
        CREATE TRIGGER admin_receipt_no_truncate BEFORE TRUNCATE ON public.admin_principal
            FOR EACH STATEMENT EXECUTE FUNCTION public.admin_receipt_immutable();
        DROP TRIGGER IF EXISTS admin_receipt_no_truncate ON public.admin_session;
        CREATE TRIGGER admin_receipt_no_truncate BEFORE TRUNCATE ON public.admin_session
            FOR EACH STATEMENT EXECUTE FUNCTION public.admin_receipt_immutable();

        -- Existing demo cleanup uses replica mode inside its original transaction. Capture and
        -- integrity must survive that path too; no roles, grants or session settings are changed.
        ALTER TABLE public.admin_principal ENABLE ALWAYS TRIGGER admin_receipt_capture;
        ALTER TABLE public.admin_session ENABLE ALWAYS TRIGGER admin_receipt_capture;
        ALTER TABLE public.admin_permission_mutation_receipt ENABLE ALWAYS TRIGGER admin_receipt_insert_guard;
        ALTER TABLE public.admin_permission_mutation_receipt ENABLE ALWAYS TRIGGER admin_receipt_require_seal;
        ALTER TABLE public.admin_permission_mutation_receipt ENABLE ALWAYS TRIGGER admin_receipt_immutable;
        ALTER TABLE public.admin_permission_mutation_receipt ENABLE ALWAYS TRIGGER admin_receipt_no_truncate;
        ALTER TABLE public.admin_permission_mutation_receipt_batch ENABLE ALWAYS TRIGGER admin_receipt_seal_guard;
        ALTER TABLE public.admin_permission_mutation_receipt_batch ENABLE ALWAYS TRIGGER admin_receipt_immutable;
        ALTER TABLE public.admin_permission_mutation_receipt_batch ENABLE ALWAYS TRIGGER admin_receipt_no_truncate;
        ALTER TABLE public.admin_principal ENABLE ALWAYS TRIGGER admin_receipt_no_truncate;
        ALTER TABLE public.admin_session ENABLE ALWAYS TRIGGER admin_receipt_no_truncate;
        """;
}
