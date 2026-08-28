namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class AuthoringCanvasDocumentMigrationDefinitions
{
    internal const string MigrationId = "20260828-post-authoring-canvas-document";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add the private closed authoring canvas document authority and bounded record ledgers.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS authoring_canvas_document (
                        id uuid PRIMARY KEY,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        schema_version integer NOT NULL,
                        revision bigint NOT NULL,
                        title varchar(128) NOT NULL,
                        viewport_x double precision NOT NULL,
                        viewport_y double precision NOT NULL,
                        viewport_zoom double precision NOT NULL,
                        node_count integer NOT NULL,
                        edge_count integer NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        updated_at_utc timestamp without time zone NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        CONSTRAINT fk_authoring_canvas_document_owner
                            FOREIGN KEY (owner_admin_principal_id) REFERENCES admin_principal(id) ON DELETE CASCADE,
                        CONSTRAINT ck_authoring_canvas_document_schema CHECK (schema_version = 1),
                        CONSTRAINT ck_authoring_canvas_document_revision CHECK (revision >= 1),
                        CONSTRAINT ck_authoring_canvas_document_title CHECK (char_length(title) BETWEEN 1 AND 128),
                        CONSTRAINT ck_authoring_canvas_document_viewport CHECK (
                            viewport_x BETWEEN -10000000 AND 10000000
                            AND viewport_y BETWEEN -10000000 AND 10000000
                            AND viewport_zoom BETWEEN 0.1 AND 4),
                        CONSTRAINT ck_authoring_canvas_document_counts CHECK (
                            node_count BETWEEN 0 AND 10000
                            AND edge_count BETWEEN 0 AND 10000),
                        CONSTRAINT ck_authoring_canvas_document_digest CHECK (
                            content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_authoring_canvas_document_owner
                        ON authoring_canvas_document(owner_admin_principal_id, site_scope, updated_at_utc DESC, id);

                    CREATE TABLE IF NOT EXISTS authoring_canvas_node (
                        canvas_id uuid NOT NULL,
                        node_id uuid NOT NULL,
                        node_type varchar(32) NOT NULL,
                        node_order integer NOT NULL,
                        position_x double precision NOT NULL,
                        position_y double precision NOT NULL,
                        width double precision NOT NULL,
                        height double precision NOT NULL,
                        target_article_id integer NULL,
                        target_heading_identity varchar(128) NULL,
                        target_block_identity varchar(128) NULL,
                        pinned_target_revision bigint NULL,
                        display_projection_ref varchar(128) NULL,
                        reference_state varchar(32) NULL,
                        note_source varchar(8192) NULL,
                        frame_label varchar(128) NULL,
                        content_digest varchar(64) NOT NULL,
                        PRIMARY KEY (canvas_id, node_id),
                        CONSTRAINT fk_authoring_canvas_node_document
                            FOREIGN KEY (canvas_id) REFERENCES authoring_canvas_document(id) ON DELETE CASCADE,
                        CONSTRAINT ck_authoring_canvas_node_type CHECK (
                            node_type IN (
                                'article-reference',
                                'heading-reference',
                                'block-reference',
                                'plain-text-note',
                                'group-frame')),
                        CONSTRAINT ck_authoring_canvas_node_order CHECK (node_order >= 0),
                        CONSTRAINT ck_authoring_canvas_node_geometry CHECK (
                            position_x BETWEEN -10000000 AND 10000000
                            AND position_y BETWEEN -10000000 AND 10000000
                            AND width BETWEEN 24 AND 4096
                            AND height BETWEEN 24 AND 4096),
                        CONSTRAINT ck_authoring_canvas_node_reference_shape CHECK (
                            (node_type = 'article-reference'
                                AND target_article_id > 0
                                AND target_heading_identity IS NULL
                                AND target_block_identity IS NULL
                                AND reference_state IS NOT NULL
                                AND note_source IS NULL
                                AND frame_label IS NULL)
                            OR (node_type = 'heading-reference'
                                AND target_article_id > 0
                                AND target_heading_identity IS NOT NULL
                                AND target_block_identity IS NULL
                                AND reference_state IS NOT NULL
                                AND note_source IS NULL
                                AND frame_label IS NULL)
                            OR (node_type = 'block-reference'
                                AND target_article_id > 0
                                AND target_heading_identity IS NULL
                                AND target_block_identity IS NOT NULL
                                AND reference_state IS NOT NULL
                                AND note_source IS NULL
                                AND frame_label IS NULL)
                            OR (node_type = 'plain-text-note'
                                AND target_article_id IS NULL
                                AND target_heading_identity IS NULL
                                AND target_block_identity IS NULL
                                AND pinned_target_revision IS NULL
                                AND display_projection_ref IS NULL
                                AND reference_state IS NULL
                                AND note_source IS NOT NULL
                                AND frame_label IS NULL)
                            OR (node_type = 'group-frame'
                                AND target_article_id IS NULL
                                AND target_heading_identity IS NULL
                                AND target_block_identity IS NULL
                                AND pinned_target_revision IS NULL
                                AND display_projection_ref IS NULL
                                AND reference_state IS NULL
                                AND note_source IS NULL
                                AND frame_label IS NOT NULL)),
                        CONSTRAINT ck_authoring_canvas_node_reference_state CHECK (
                            reference_state IS NULL OR reference_state IN (
                                'unresolved', 'current', 'pinned', 'stale', 'missing', 'permission-denied')),
                        CONSTRAINT ck_authoring_canvas_node_digest CHECK (
                            content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_authoring_canvas_node_page
                        ON authoring_canvas_node(canvas_id, node_order, node_id);

                    CREATE TABLE IF NOT EXISTS authoring_canvas_frame_member (
                        canvas_id uuid NOT NULL,
                        frame_node_id uuid NOT NULL,
                        member_node_id uuid NOT NULL,
                        member_order integer NOT NULL,
                        PRIMARY KEY (canvas_id, frame_node_id, member_node_id),
                        CONSTRAINT fk_authoring_canvas_frame_member_frame
                            FOREIGN KEY (canvas_id, frame_node_id)
                            REFERENCES authoring_canvas_node(canvas_id, node_id) ON DELETE CASCADE,
                        CONSTRAINT fk_authoring_canvas_frame_member_node
                            FOREIGN KEY (canvas_id, member_node_id)
                            REFERENCES authoring_canvas_node(canvas_id, node_id) ON DELETE CASCADE,
                        CONSTRAINT ck_authoring_canvas_frame_member_order CHECK (member_order >= 0),
                        CONSTRAINT ck_authoring_canvas_frame_member_self CHECK (frame_node_id <> member_node_id)
                    );
                    CREATE INDEX IF NOT EXISTS ix_authoring_canvas_frame_member_order
                        ON authoring_canvas_frame_member(canvas_id, frame_node_id, member_order, member_node_id);

                    CREATE TABLE IF NOT EXISTS authoring_canvas_edge (
                        canvas_id uuid NOT NULL,
                        edge_id uuid NOT NULL,
                        edge_type varchar(32) NOT NULL,
                        edge_order integer NOT NULL,
                        source_node_id uuid NOT NULL,
                        target_node_id uuid NOT NULL,
                        label varchar(128) NULL,
                        content_digest varchar(64) NOT NULL,
                        PRIMARY KEY (canvas_id, edge_id),
                        CONSTRAINT fk_authoring_canvas_edge_document
                            FOREIGN KEY (canvas_id) REFERENCES authoring_canvas_document(id) ON DELETE CASCADE,
                        CONSTRAINT fk_authoring_canvas_edge_source
                            FOREIGN KEY (canvas_id, source_node_id)
                            REFERENCES authoring_canvas_node(canvas_id, node_id) ON DELETE CASCADE,
                        CONSTRAINT fk_authoring_canvas_edge_target
                            FOREIGN KEY (canvas_id, target_node_id)
                            REFERENCES authoring_canvas_node(canvas_id, node_id) ON DELETE CASCADE,
                        CONSTRAINT ck_authoring_canvas_edge_type CHECK (
                            edge_type IN ('visual-only', 'explicit-reference-note')),
                        CONSTRAINT ck_authoring_canvas_edge_order CHECK (edge_order >= 0),
                        CONSTRAINT ck_authoring_canvas_edge_digest CHECK (
                            content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_authoring_canvas_edge_page
                        ON authoring_canvas_edge(canvas_id, edge_order, edge_id);
                    CREATE INDEX IF NOT EXISTS ix_authoring_canvas_edge_source
                        ON authoring_canvas_edge(canvas_id, source_node_id);
                    CREATE INDEX IF NOT EXISTS ix_authoring_canvas_edge_target
                        ON authoring_canvas_edge(canvas_id, target_node_id);

                    CREATE TABLE IF NOT EXISTS authoring_canvas_receipt (
                        receipt_id uuid PRIMARY KEY,
                        canvas_id uuid NOT NULL,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        revision bigint NOT NULL,
                        command_kind varchar(32) NOT NULL,
                        node_count integer NOT NULL,
                        edge_count integer NOT NULL,
                        status varchar(16) NOT NULL,
                        reason_code varchar(64) NULL,
                        command_digest varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        CONSTRAINT ck_authoring_canvas_receipt_revision CHECK (revision >= 1),
                        CONSTRAINT ck_authoring_canvas_receipt_counts CHECK (
                            node_count BETWEEN 0 AND 10000
                            AND edge_count BETWEEN 0 AND 10000),
                        CONSTRAINT ck_authoring_canvas_receipt_status CHECK (
                            status IN ('applied', 'rejected')),
                        CONSTRAINT ck_authoring_canvas_receipt_digests CHECK (
                            command_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_authoring_canvas_receipt_document
                        ON authoring_canvas_receipt(
                            canvas_id, owner_admin_principal_id, site_scope, revision DESC, created_at_utc DESC);

                    CREATE TABLE IF NOT EXISTS authoring_canvas_idempotency (
                        canvas_id uuid NOT NULL,
                        owner_admin_principal_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        request_id uuid NOT NULL,
                        receipt_id uuid NOT NULL,
                        revision bigint NOT NULL,
                        command_kind varchar(32) NOT NULL,
                        node_count integer NOT NULL,
                        edge_count integer NOT NULL,
                        command_digest varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        created_at_utc timestamp without time zone NOT NULL,
                        PRIMARY KEY (canvas_id, owner_admin_principal_id, site_scope, request_id),
                        CONSTRAINT fk_authoring_canvas_idempotency_receipt
                            FOREIGN KEY (receipt_id) REFERENCES authoring_canvas_receipt(receipt_id) ON DELETE RESTRICT,
                        CONSTRAINT ck_authoring_canvas_idempotency_revision CHECK (revision >= 1),
                        CONSTRAINT ck_authoring_canvas_idempotency_counts CHECK (
                            node_count BETWEEN 0 AND 10000
                            AND edge_count BETWEEN 0 AND 10000),
                        CONSTRAINT ck_authoring_canvas_idempotency_digests CHECK (
                            command_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE INDEX IF NOT EXISTS ix_authoring_canvas_idempotency_created
                        ON authoring_canvas_idempotency(created_at_utc, canvas_id);
                    """)
            ]);
}
