namespace FsusBlog.Migration.Definitions;

internal static class AuthoringCanvasOperationJournalMigrationDefinitions
{
    internal const string MigrationId = "20260906-post-authoring-canvas-operation-journal";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the append-only authoring canvas operation journal, sealed fact rows, and recovery receipts.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS authoring_canvas_operation_journal (
                        journal_id uuid PRIMARY KEY,
                        canvas_id uuid NOT NULL,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        revision bigint NOT NULL,
                        mode smallint NOT NULL,
                        request_id uuid NOT NULL,
                        actor_user_id bigint NOT NULL,
                        parent_journal_id uuid NULL,
                        target_journal_id uuid NULL,
                        previous_content_digest varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        transaction_digest varchar(64) NOT NULL,
                        reference_validation_digest varchar(64) NOT NULL,
                        command_kinds smallint[] NOT NULL,
                        affected_node_ids uuid[] NOT NULL,
                        affected_edge_ids uuid[] NOT NULL,
                        truncated_redo_journal_ids uuid[] NOT NULL,
                        result_node_count integer NOT NULL,
                        result_edge_count integer NOT NULL,
                        journal_digest varchar(64) NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        CONSTRAINT uq_authoring_canvas_operation_journal_revision UNIQUE (
                            canvas_id, owner_admin_principal_id, site_scope, revision),
                        CONSTRAINT uq_authoring_canvas_operation_journal_request UNIQUE (
                            canvas_id, owner_admin_principal_id, site_scope, request_id),
                        CONSTRAINT fk_authoring_canvas_operation_journal_document
                            FOREIGN KEY (canvas_id)
                            REFERENCES authoring_canvas_document(id) ON DELETE CASCADE,
                        CONSTRAINT fk_authoring_canvas_operation_journal_parent
                            FOREIGN KEY (parent_journal_id)
                            REFERENCES authoring_canvas_operation_journal(journal_id) ON DELETE CASCADE,
                        CONSTRAINT fk_authoring_canvas_operation_journal_target
                            FOREIGN KEY (target_journal_id)
                            REFERENCES authoring_canvas_operation_journal(journal_id) ON DELETE CASCADE,
                        CONSTRAINT ck_authoring_canvas_operation_journal_revision CHECK (revision >= 2),
                        CONSTRAINT ck_authoring_canvas_operation_journal_mode CHECK (mode BETWEEN 0 AND 2),
                        CONSTRAINT ck_authoring_canvas_operation_journal_actor CHECK (actor_user_id > 0),
                        CONSTRAINT ck_authoring_canvas_operation_journal_counts CHECK (
                            result_node_count BETWEEN 0 AND 10000
                            AND result_edge_count BETWEEN 0 AND 10000),
                        CONSTRAINT ck_authoring_canvas_operation_journal_arrays CHECK (
                            cardinality(command_kinds) BETWEEN 1 AND 10000
                            AND cardinality(affected_node_ids) <= 10000
                            AND cardinality(affected_edge_ids) <= 10000
                            AND cardinality(truncated_redo_journal_ids) <= 100),
                        CONSTRAINT ck_authoring_canvas_operation_journal_digests CHECK (
                            previous_content_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$'
                            AND transaction_digest ~ '^[0-9a-f]{64}$'
                            AND reference_validation_digest ~ '^[0-9a-f]{64}$'
                            AND journal_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_authoring_canvas_operation_journal_history
                        ON authoring_canvas_operation_journal(
                            canvas_id, owner_admin_principal_id, site_scope, revision, journal_id);

                    CREATE TABLE IF NOT EXISTS authoring_canvas_operation_command (
                        journal_id uuid NOT NULL,
                        command_ordinal integer NOT NULL,
                        command_id uuid NOT NULL,
                        command_kind smallint NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        PRIMARY KEY (journal_id, command_ordinal),
                        CONSTRAINT uq_authoring_canvas_operation_command_id UNIQUE (
                            journal_id, command_id),
                        CONSTRAINT fk_authoring_canvas_operation_command_journal
                            FOREIGN KEY (journal_id)
                            REFERENCES authoring_canvas_operation_journal(journal_id) ON DELETE CASCADE,
                        CONSTRAINT ck_authoring_canvas_operation_command_ordinal CHECK (
                            command_ordinal BETWEEN 0 AND 9999),
                        CONSTRAINT ck_authoring_canvas_operation_command_kind CHECK (
                            command_kind BETWEEN 0 AND 14),
                        CONSTRAINT ck_authoring_canvas_operation_command_digest CHECK (
                            command_digest ~ '^[0-9a-f]{64}$')
                    );

                    CREATE TABLE IF NOT EXISTS authoring_canvas_operation_command_fact (
                        journal_id uuid NOT NULL,
                        command_ordinal integer NOT NULL,
                        direction smallint NOT NULL,
                        fact_order integer NOT NULL,
                        fact_payload jsonb NOT NULL,
                        fact_digest varchar(64) NOT NULL,
                        PRIMARY KEY (journal_id, command_ordinal, direction, fact_order),
                        CONSTRAINT fk_authoring_canvas_operation_command_fact_command
                            FOREIGN KEY (journal_id, command_ordinal)
                            REFERENCES authoring_canvas_operation_command(journal_id, command_ordinal)
                            ON DELETE CASCADE,
                        CONSTRAINT ck_authoring_canvas_operation_command_fact_direction CHECK (
                            direction BETWEEN 0 AND 1),
                        CONSTRAINT ck_authoring_canvas_operation_command_fact_order CHECK (
                            fact_order BETWEEN 0 AND 20000),
                        CONSTRAINT ck_authoring_canvas_operation_command_fact_payload CHECK (
                            jsonb_typeof(fact_payload) = 'object'),
                        CONSTRAINT ck_authoring_canvas_operation_command_fact_digest CHECK (
                            fact_digest ~ '^[0-9a-f]{64}$')
                    );

                    CREATE TABLE IF NOT EXISTS authoring_canvas_operation_history_state (
                        canvas_id uuid PRIMARY KEY,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        revision bigint NOT NULL,
                        canvas_content_digest varchar(64) NOT NULL,
                        history_digest varchar(64) NOT NULL,
                        undo_journal_ids uuid[] NOT NULL,
                        redo_journal_ids uuid[] NOT NULL,
                        last_journal_id uuid NULL,
                        updated_at_utc timestamp without time zone NOT NULL,
                        CONSTRAINT fk_authoring_canvas_operation_history_document
                            FOREIGN KEY (canvas_id)
                            REFERENCES authoring_canvas_document(id) ON DELETE CASCADE,
                        CONSTRAINT fk_authoring_canvas_operation_history_last_journal
                            FOREIGN KEY (last_journal_id)
                            REFERENCES authoring_canvas_operation_journal(journal_id) ON DELETE CASCADE,
                        CONSTRAINT ck_authoring_canvas_operation_history_revision CHECK (revision >= 1),
                        CONSTRAINT ck_authoring_canvas_operation_history_depth CHECK (
                            cardinality(undo_journal_ids) <= 100
                            AND cardinality(redo_journal_ids) <= 100),
                        CONSTRAINT ck_authoring_canvas_operation_history_digests CHECK (
                            canvas_content_digest ~ '^[0-9a-f]{64}$'
                            AND history_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_authoring_canvas_operation_history_owner
                        ON authoring_canvas_operation_history_state(
                            canvas_id, owner_admin_principal_id, site_scope);

                    CREATE TABLE IF NOT EXISTS authoring_canvas_operation_fact (
                        journal_id uuid NOT NULL,
                        direction smallint NOT NULL,
                        fact_order integer NOT NULL,
                        fact_kind smallint NOT NULL,
                        fact_id uuid NOT NULL,
                        exists boolean NOT NULL,
                        node_type smallint NULL,
                        node_order integer NULL,
                        position_x double precision NULL,
                        position_y double precision NULL,
                        width double precision NULL,
                        height double precision NULL,
                        target_article_id integer NULL,
                        target_heading_identity varchar(128) NULL,
                        target_block_identity varchar(128) NULL,
                        pinned_target_revision bigint NULL,
                        display_projection_ref varchar(128) NULL,
                        reference_state smallint NULL,
                        note_source varchar(8192) NULL,
                        frame_label varchar(128) NULL,
                        frame_member_ids uuid[] NULL,
                        edge_type smallint NULL,
                        edge_order integer NULL,
                        source_node_id uuid NULL,
                        target_node_id uuid NULL,
                        edge_label varchar(128) NULL,
                        viewport_x double precision NULL,
                        viewport_y double precision NULL,
                        viewport_zoom double precision NULL,
                        fact_digest varchar(64) NOT NULL,
                        PRIMARY KEY (journal_id, direction, fact_order),
                        CONSTRAINT uq_authoring_canvas_operation_fact_identity UNIQUE (
                            journal_id, direction, fact_kind, fact_id),
                        CONSTRAINT fk_authoring_canvas_operation_fact_journal
                            FOREIGN KEY (journal_id)
                            REFERENCES authoring_canvas_operation_journal(journal_id) ON DELETE CASCADE,
                        CONSTRAINT ck_authoring_canvas_operation_fact_direction CHECK (direction BETWEEN 0 AND 1),
                        CONSTRAINT ck_authoring_canvas_operation_fact_order CHECK (fact_order >= 0),
                        CONSTRAINT ck_authoring_canvas_operation_fact_kind CHECK (fact_kind BETWEEN 0 AND 2),
                        CONSTRAINT ck_authoring_canvas_operation_fact_digest CHECK (
                            fact_digest ~ '^[0-9a-f]{64}$'),
                        CONSTRAINT ck_authoring_canvas_operation_fact_payload CHECK (
                            (exists = false
                                AND node_type IS NULL AND node_order IS NULL
                                AND position_x IS NULL AND position_y IS NULL
                                AND width IS NULL AND height IS NULL
                                AND target_article_id IS NULL
                                AND target_heading_identity IS NULL
                                AND target_block_identity IS NULL
                                AND pinned_target_revision IS NULL
                                AND display_projection_ref IS NULL
                                AND reference_state IS NULL AND note_source IS NULL
                                AND frame_label IS NULL AND frame_member_ids IS NULL
                                AND edge_type IS NULL AND edge_order IS NULL
                                AND source_node_id IS NULL AND target_node_id IS NULL
                                AND edge_label IS NULL
                                AND viewport_x IS NULL AND viewport_y IS NULL
                                AND viewport_zoom IS NULL)
                            OR (exists = true AND fact_kind = 0
                                AND node_type BETWEEN 0 AND 4 AND node_order >= 0
                                AND position_x IS NOT NULL AND position_y IS NOT NULL
                                AND width IS NOT NULL AND height IS NOT NULL
                                AND edge_type IS NULL AND edge_order IS NULL
                                AND source_node_id IS NULL AND target_node_id IS NULL
                                AND edge_label IS NULL
                                AND viewport_x IS NULL AND viewport_y IS NULL
                                AND viewport_zoom IS NULL)
                            OR (exists = true AND fact_kind = 1
                                AND node_type IS NULL AND node_order IS NULL
                                AND position_x IS NULL AND position_y IS NULL
                                AND width IS NULL AND height IS NULL
                                AND target_article_id IS NULL
                                AND target_heading_identity IS NULL
                                AND target_block_identity IS NULL
                                AND pinned_target_revision IS NULL
                                AND display_projection_ref IS NULL
                                AND reference_state IS NULL AND note_source IS NULL
                                AND frame_label IS NULL AND frame_member_ids IS NULL
                                AND edge_type BETWEEN 0 AND 1 AND edge_order >= 0
                                AND source_node_id IS NOT NULL AND target_node_id IS NOT NULL
                                AND viewport_x IS NULL AND viewport_y IS NULL
                                AND viewport_zoom IS NULL)
                            OR (exists = true AND fact_kind = 2
                                AND node_type IS NULL AND node_order IS NULL
                                AND position_x IS NULL AND position_y IS NULL
                                AND width IS NULL AND height IS NULL
                                AND target_article_id IS NULL
                                AND target_heading_identity IS NULL
                                AND target_block_identity IS NULL
                                AND pinned_target_revision IS NULL
                                AND display_projection_ref IS NULL
                                AND reference_state IS NULL AND note_source IS NULL
                                AND frame_label IS NULL AND frame_member_ids IS NULL
                                AND edge_type IS NULL AND edge_order IS NULL
                                AND source_node_id IS NULL AND target_node_id IS NULL
                                AND edge_label IS NULL
                                AND viewport_x IS NOT NULL AND viewport_y IS NOT NULL
                                AND viewport_zoom IS NOT NULL))
                    );

                    CREATE TABLE IF NOT EXISTS authoring_canvas_operation_receipt (
                        receipt_id uuid PRIMARY KEY,
                        journal_id uuid NOT NULL,
                        canvas_id uuid NOT NULL,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        request_id uuid NOT NULL,
                        revision bigint NOT NULL,
                        mode smallint NOT NULL,
                        target_journal_id uuid NULL,
                        command_count integer NOT NULL,
                        command_kinds smallint[] NOT NULL,
                        affected_node_ids uuid[] NOT NULL,
                        affected_edge_ids uuid[] NOT NULL,
                        undo_depth integer NOT NULL,
                        redo_depth integer NOT NULL,
                        status smallint NOT NULL,
                        reasons text[] NOT NULL,
                        transaction_digest varchar(64) NOT NULL,
                        reference_validation_digest varchar(64) NOT NULL,
                        journal_digest varchar(64) NOT NULL,
                        canvas_content_digest varchar(64) NOT NULL,
                        receipt_digest varchar(64) NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        CONSTRAINT uq_authoring_canvas_operation_receipt_request UNIQUE (
                            canvas_id, owner_admin_principal_id, site_scope, request_id),
                        CONSTRAINT fk_authoring_canvas_operation_receipt_journal
                            FOREIGN KEY (journal_id)
                            REFERENCES authoring_canvas_operation_journal(journal_id) ON DELETE CASCADE,
                        CONSTRAINT ck_authoring_canvas_operation_receipt_revision CHECK (revision >= 2),
                        CONSTRAINT ck_authoring_canvas_operation_receipt_mode CHECK (mode BETWEEN 0 AND 2),
                        CONSTRAINT ck_authoring_canvas_operation_receipt_count CHECK (
                            command_count BETWEEN 1 AND 10000
                            AND command_count = cardinality(command_kinds)),
                        CONSTRAINT ck_authoring_canvas_operation_receipt_depth CHECK (
                            undo_depth BETWEEN 0 AND 100 AND redo_depth BETWEEN 0 AND 100),
                        CONSTRAINT ck_authoring_canvas_operation_receipt_status CHECK (status = 0),
                        CONSTRAINT ck_authoring_canvas_operation_receipt_digests CHECK (
                            transaction_digest ~ '^[0-9a-f]{64}$'
                            AND reference_validation_digest ~ '^[0-9a-f]{64}$'
                            AND journal_digest ~ '^[0-9a-f]{64}$'
                            AND canvas_content_digest ~ '^[0-9a-f]{64}$'
                            AND receipt_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_authoring_canvas_operation_receipt_history
                        ON authoring_canvas_operation_receipt(
                            canvas_id, owner_admin_principal_id, site_scope, revision DESC);
                    """)
            ]);
}
