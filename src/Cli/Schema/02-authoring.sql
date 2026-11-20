-- FsusBlog V2 Authoring Schema: workspace, recovery, properties, search index, canvas, media, and exports.

CREATE TABLE public.authoring_recovery_site (
    singleton boolean PRIMARY KEY CHECK (singleton),
    site_id uuid NOT NULL
);
INSERT INTO public.authoring_recovery_site (singleton, site_id)
VALUES (true, pg_catalog.gen_random_uuid());

CREATE TABLE public.article_body_insertion (
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    source_revision bigint NOT NULL,
    offset_utf16 integer CHECK (offset_utf16 >= 0),
    length_utf16 integer CHECK (length_utf16 > 0),
    source_digest bytea NOT NULL CHECK (octet_length(source_digest) = 32),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
    operations integer[],
    edit_texts text[],
    PRIMARY KEY (article_id, revision),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision),
    FOREIGN KEY (article_id, source_revision) REFERENCES public.article_revision (article_id, revision),
    CHECK (revision = source_revision + 1),
    CHECK (cardinality(operations) BETWEEN 2 AND 16),
    CHECK (array_ndims(operations) = 1),
    CHECK (array_lower(operations, 1) = 1),
    CHECK (array_position(operations, NULL::integer) IS NULL),
    CHECK (cardinality(edit_texts) BETWEEN 1 AND 8),
    CHECK (array_ndims(edit_texts) = 1),
    CHECK (array_lower(edit_texts, 1) = 1),
    CHECK (array_position(edit_texts, NULL::text) IS NULL)
);

CREATE TABLE public.authoring_workspace (
    user_id uuid PRIMARY KEY REFERENCES public.admin_principal (id),
    schema_version integer NOT NULL CHECK (schema_version = 1),
    revision bigint NOT NULL CHECK (revision > 0),
    updated_at timestamptz NOT NULL,
    active_article_id integer NOT NULL CHECK (active_article_id >= 0),
    tabs integer[] NOT NULL CHECK (cardinality(tabs) <= 100),
    inspector_open boolean NOT NULL DEFAULT false,
    secondary_active_article_id integer NOT NULL DEFAULT 0 CHECK (secondary_active_article_id >= 0),
    secondary_tabs integer[] NOT NULL DEFAULT '{}'::integer[],
    focused_group integer NOT NULL DEFAULT 0 CHECK (focused_group >= 0 AND focused_group <= 1),
    CHECK (cardinality(tabs) + cardinality(secondary_tabs) <= 100),
    CHECK (focused_group = 0 OR secondary_active_article_id > 0)
);

CREATE TABLE public.author_recent_open_collection (
    site_id uuid NOT NULL,
    owner_id uuid NOT NULL REFERENCES public.admin_principal (id),
    revision bigint NOT NULL CHECK (revision > 0),
    PRIMARY KEY (site_id, owner_id)
);

CREATE TABLE public.author_recent_open (
    site_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    article_id integer NOT NULL REFERENCES public.article (id),
    article_revision bigint NOT NULL CHECK (article_revision > 0),
    sequence bigint NOT NULL CHECK (sequence > 0),
    opened_at timestamptz NOT NULL,
    PRIMARY KEY (site_id, owner_id, article_id),
    UNIQUE (site_id, owner_id, sequence),
    FOREIGN KEY (site_id, owner_id) REFERENCES public.author_recent_open_collection (site_id, owner_id)
);

CREATE TABLE public.author_recent_open_receipt (
    site_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    request_id uuid NOT NULL,
    article_id integer NOT NULL,
    article_revision bigint NOT NULL CHECK (article_revision > 0),
    sequence bigint NOT NULL CHECK (sequence > 0),
    opened_at timestamptz NOT NULL,
    PRIMARY KEY (site_id, owner_id, request_id),
    UNIQUE (site_id, owner_id, sequence),
    FOREIGN KEY (site_id, owner_id) REFERENCES public.author_recent_open_collection (site_id, owner_id)
);

CREATE TABLE public.author_saved_view_collection (
    site_id uuid NOT NULL,
    owner_id uuid NOT NULL REFERENCES public.admin_principal (id),
    revision bigint NOT NULL CHECK (revision > 0),
    PRIMARY KEY (site_id, owner_id)
);

CREATE TABLE public.author_saved_view (
    site_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    name text NOT NULL CHECK (octet_length(name) <= 512),
    name_key bytea NOT NULL,
    definition bytea NOT NULL CHECK (octet_length(definition) <= 262288),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    retired boolean NOT NULL,
    PRIMARY KEY (site_id, owner_id, id),
    FOREIGN KEY (site_id, owner_id) REFERENCES public.author_saved_view_collection (site_id, owner_id)
);
CREATE UNIQUE INDEX author_saved_view_live_name ON public.author_saved_view (site_id, owner_id, name_key) WHERE NOT retired;

CREATE TABLE public.author_saved_view_command (
    site_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    request_id uuid NOT NULL,
    view_id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    collection_revision bigint NOT NULL CHECK (collection_revision >= revision),
    action integer NOT NULL CHECK (action >= 1 AND action <= 3),
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    happened_at timestamptz NOT NULL,
    PRIMARY KEY (site_id, owner_id, request_id),
    FOREIGN KEY (site_id, owner_id, view_id) REFERENCES public.author_saved_view (site_id, owner_id, id)
);

CREATE TABLE public.author_saved_view_default (
    site_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    view_id uuid NOT NULL,
    PRIMARY KEY (site_id, owner_id),
    FOREIGN KEY (site_id, owner_id, view_id) REFERENCES public.author_saved_view (site_id, owner_id, id)
);

CREATE TABLE public.author_saved_view_pin (
    site_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    view_id uuid NOT NULL,
    pin_order integer NOT NULL CHECK (pin_order > 0),
    PRIMARY KEY (site_id, owner_id, view_id),
    FOREIGN KEY (site_id, owner_id, view_id) REFERENCES public.author_saved_view (site_id, owner_id, id),
    UNIQUE (site_id, owner_id, pin_order) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE public.author_saved_view_placement_command (
    site_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    request_id uuid NOT NULL,
    view_id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    collection_revision bigint NOT NULL CHECK (collection_revision >= revision),
    action integer NOT NULL CHECK (action >= 4 AND action <= 8),
    before_id uuid,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    happened_at timestamptz NOT NULL,
    PRIMARY KEY (site_id, owner_id, request_id),
    FOREIGN KEY (site_id, owner_id, view_id) REFERENCES public.author_saved_view (site_id, owner_id, id),
    FOREIGN KEY (site_id, owner_id, before_id) REFERENCES public.author_saved_view (site_id, owner_id, id)
);

CREATE TABLE public.property_schema (
    owner_id uuid PRIMARY KEY REFERENCES public.admin_principal (id),
    revision bigint NOT NULL CHECK (revision >= 0)
);

CREATE TABLE public.property_definition (
    owner_id uuid NOT NULL REFERENCES public.property_schema (owner_id),
    id uuid NOT NULL,
    machine_key text NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    digest text NOT NULL CHECK (char_length(digest) = 64),
    shape jsonb NOT NULL,
    PRIMARY KEY (owner_id, id),
    UNIQUE (owner_id, machine_key)
);

CREATE TABLE public.property_schema_command (
    owner_id uuid NOT NULL REFERENCES public.property_schema (owner_id),
    request_id uuid NOT NULL,
    receipt jsonb NOT NULL,
    PRIMARY KEY (owner_id, request_id)
);

CREATE TABLE public.property_article (
    article_id integer PRIMARY KEY REFERENCES public.article (id),
    owner_id uuid NOT NULL REFERENCES public.property_schema (owner_id),
    revision bigint NOT NULL CHECK (revision > 0),
    UNIQUE (article_id, owner_id)
);

CREATE TABLE public.property_value (
    article_id integer NOT NULL,
    owner_id uuid NOT NULL,
    definition_id uuid NOT NULL,
    data jsonb NOT NULL,
    references_ids integer[] NOT NULL CHECK (cardinality(references_ids) <= 32),
    PRIMARY KEY (article_id, definition_id),
    FOREIGN KEY (article_id, owner_id) REFERENCES public.property_article (article_id, owner_id),
    FOREIGN KEY (owner_id, definition_id) REFERENCES public.property_definition (owner_id, id)
);
CREATE INDEX property_value_by_definition ON public.property_value (owner_id, definition_id, article_id);
CREATE INDEX property_value_references ON public.property_value USING gin (references_ids);

CREATE TABLE public.property_value_command (
    article_id integer NOT NULL REFERENCES public.property_article (article_id),
    request_id uuid NOT NULL,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    definition_id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    PRIMARY KEY (article_id, request_id)
);

CREATE TABLE public.article_property_snapshot (
    article_id integer NOT NULL REFERENCES public.article (id),
    schema_revision bigint NOT NULL CHECK (schema_revision >= 0),
    value_revision bigint NOT NULL CHECK (value_revision >= 0),
    digest text NOT NULL CHECK (char_length(digest) = 64),
    field_digests text[] NOT NULL CHECK (cardinality(field_digests) <= 1000),
    PRIMARY KEY (article_id, schema_revision, value_revision)
);

CREATE TABLE public.article_property_snapshot_field (
    article_id integer NOT NULL,
    schema_revision bigint NOT NULL,
    value_revision bigint NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal > 0),
    definition_id uuid NOT NULL,
    machine_key text NOT NULL,
    definition_revision bigint NOT NULL CHECK (definition_revision > 0),
    definition_digest text NOT NULL CHECK (char_length(definition_digest) = 64),
    shape jsonb NOT NULL,
    data jsonb NOT NULL,
    references_ids integer[] NOT NULL CHECK (cardinality(references_ids) <= 32),
    PRIMARY KEY (article_id, schema_revision, value_revision, ordinal),
    UNIQUE (article_id, schema_revision, value_revision, machine_key),
    FOREIGN KEY (article_id, schema_revision, value_revision)
        REFERENCES public.article_property_snapshot (article_id, schema_revision, value_revision)
);

CREATE TABLE public.article_revision_property_snapshot (
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    schema_revision bigint NOT NULL,
    value_revision bigint NOT NULL,
    PRIMARY KEY (article_id, revision),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision),
    FOREIGN KEY (article_id, schema_revision, value_revision)
        REFERENCES public.article_property_snapshot (article_id, schema_revision, value_revision)
);

CREATE TABLE public.author_text_document (
    owner_id uuid NOT NULL REFERENCES public.admin_principal (id),
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    profile integer NOT NULL CONSTRAINT author_text_document_profile_check CHECK (profile BETWEEN 1 AND 3),
    title_digest bytea NOT NULL CHECK (octet_length(title_digest) = 32),
    body_digest bytea NOT NULL CHECK (octet_length(body_digest) = 32),
    summary_digest bytea NOT NULL CONSTRAINT author_text_document_summary_digest_check CHECK (octet_length(summary_digest) = 32),
    PRIMARY KEY (owner_id, article_id),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision)
);

CREATE TABLE public.author_text_posting (
    owner_id uuid NOT NULL,
    article_id integer NOT NULL,
    field integer NOT NULL CONSTRAINT author_text_posting_field_check CHECK (field BETWEEN 1 AND 4),
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 199999),
    term bytea NOT NULL CHECK (octet_length(term) BETWEEN 1 AND 512),
    start_u16 integer NOT NULL CHECK (start_u16 >= 0),
    end_u16 integer NOT NULL,
    start_u8 integer NOT NULL CHECK (start_u8 >= 0),
    end_u8 integer NOT NULL,
    segment integer NOT NULL DEFAULT 0,
    CHECK (start_u16 < end_u16),
    CHECK (start_u8 < end_u8),
    CONSTRAINT author_text_posting_segment_check
        CHECK (field = 4 AND segment BETWEEN 1 AND 200000 OR field <> 4 AND segment = 0),
    PRIMARY KEY (owner_id, term, article_id, field, ordinal),
    CONSTRAINT author_text_posting_owner_article UNIQUE (owner_id, article_id, field, ordinal),
    FOREIGN KEY (owner_id, article_id) REFERENCES public.author_text_document (owner_id, article_id)
);
CREATE INDEX author_text_article_owner ON public.article (owner_id, id);

CREATE TABLE public.author_text_property_document (
    owner_id uuid NOT NULL,
    definition_id uuid NOT NULL,
    article_id integer NOT NULL,
    definition_revision bigint NOT NULL CHECK (definition_revision > 0),
    value_revision bigint NOT NULL CHECK (value_revision > 0),
    source_digest bytea NOT NULL CHECK (octet_length(source_digest) = 32),
    PRIMARY KEY (owner_id, definition_id, article_id),
    FOREIGN KEY (owner_id, definition_id) REFERENCES public.property_definition (owner_id, id),
    FOREIGN KEY (article_id, owner_id) REFERENCES public.property_article (article_id, owner_id)
);

CREATE TABLE public.author_text_property_posting (
    owner_id uuid NOT NULL,
    definition_id uuid NOT NULL,
    article_id integer NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal BETWEEN 0 AND 16383),
    term bytea NOT NULL CHECK (octet_length(term) BETWEEN 1 AND 512),
    start_u16 integer NOT NULL CHECK (start_u16 >= 0),
    end_u16 integer NOT NULL CHECK (end_u16 <= 16384),
    start_u8 integer NOT NULL CHECK (start_u8 >= 0),
    end_u8 integer NOT NULL CHECK (end_u8 <= 65536),
    CHECK (start_u16 < end_u16),
    CHECK (start_u8 < end_u8),
    PRIMARY KEY (owner_id, definition_id, term, article_id, ordinal),
    UNIQUE (owner_id, definition_id, article_id, ordinal),
    FOREIGN KEY (owner_id, definition_id, article_id)
        REFERENCES public.author_text_property_document (owner_id, definition_id, article_id)
);

CREATE TABLE public.author_text_rebuild_job (
    owner_id uuid NOT NULL REFERENCES public.admin_principal (id),
    profile integer NOT NULL CHECK (profile BETWEEN 1 AND 4),
    definition_id uuid NOT NULL,
    owner_generation bigint NOT NULL CHECK (owner_generation > 0),
    schema_revision bigint NOT NULL,
    definition_revision bigint NOT NULL CHECK (definition_revision >= 0),
    available_at timestamptz NOT NULL CHECK (isfinite(available_at)),
    CHECK (schema_revision >= definition_revision),
    PRIMARY KEY (owner_id, profile, definition_id),
    UNIQUE (available_at, owner_id, profile, definition_id)
);

CREATE TABLE public.authoring_canvas (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.admin_principal (id),
    revision bigint NOT NULL CHECK (revision > 0),
    title text NOT NULL,
    viewport_x integer NOT NULL,
    viewport_y integer NOT NULL,
    viewport_zoom integer NOT NULL CHECK (viewport_zoom >= 100 AND viewport_zoom <= 4000),
    deleted boolean NOT NULL,
    touched_at timestamptz NOT NULL
);
CREATE INDEX canvas_owner ON public.authoring_canvas (owner_id);

CREATE TABLE public.canvas_node (
    canvas_id uuid NOT NULL REFERENCES public.authoring_canvas (id),
    id uuid NOT NULL,
    kind integer NOT NULL CHECK (kind >= 0 AND kind <= 4),
    x integer NOT NULL,
    y integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    article_id integer REFERENCES public.article (id),
    anchor text,
    pinned_revision bigint,
    note text,
    member_ids uuid[] NOT NULL,
    PRIMARY KEY (canvas_id, id),
    FOREIGN KEY (article_id, pinned_revision) REFERENCES public.article_revision (article_id, revision)
);

CREATE TABLE public.canvas_edge (
    canvas_id uuid NOT NULL REFERENCES public.authoring_canvas (id),
    id uuid NOT NULL,
    source_node_id uuid NOT NULL,
    target_node_id uuid NOT NULL,
    explicit_reference boolean NOT NULL,
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    label text,
    PRIMARY KEY (canvas_id, id),
    FOREIGN KEY (canvas_id, source_node_id) REFERENCES public.canvas_node (canvas_id, id),
    FOREIGN KEY (canvas_id, target_node_id) REFERENCES public.canvas_node (canvas_id, id)
);
CREATE INDEX canvas_edge_document_order ON public.canvas_edge (canvas_id, sort_order, id);

CREATE TABLE public.canvas_document_event (
    canvas_id uuid NOT NULL REFERENCES public.authoring_canvas (id),
    revision bigint NOT NULL CHECK (revision > 0),
    actor_id uuid NOT NULL REFERENCES public.admin_principal (id),
    command_id uuid NOT NULL,
    command_kind integer NOT NULL,
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    title text NOT NULL,
    viewport_x integer NOT NULL,
    viewport_y integer NOT NULL,
    viewport_zoom integer NOT NULL,
    deleted boolean NOT NULL,
    node_count integer NOT NULL CHECK (node_count >= 0 AND node_count <= 10000),
    edge_count integer NOT NULL CHECK (edge_count >= 0 AND edge_count <= 10000),
    touched_at timestamptz NOT NULL,
    PRIMARY KEY (canvas_id, revision),
    UNIQUE (canvas_id, command_id)
);

CREATE TABLE public.canvas_link_plan (
    id uuid PRIMARY KEY,
    canvas_id uuid NOT NULL REFERENCES public.authoring_canvas (id),
    edge_id uuid NOT NULL,
    canvas_revision bigint NOT NULL CHECK (canvas_revision > 0),
    host_revision bigint NOT NULL CHECK (host_revision > 0),
    target_revision bigint NOT NULL CHECK (target_revision > 0),
    source_offset integer NOT NULL CHECK (source_offset >= 0),
    insert_digest bytea NOT NULL CHECK (octet_length(insert_digest) = 32),
    session_digest bytea NOT NULL CHECK (octet_length(session_digest) = 32),
    session_generation bigint NOT NULL CHECK (session_generation > 0),
    expires_at timestamptz NOT NULL,
    applied_article_id integer,
    applied_revision bigint,
    applied_canvas_revision bigint,
    FOREIGN KEY (applied_article_id, applied_revision) REFERENCES public.article_revision (article_id, revision)
);
CREATE INDEX canvas_links_owner ON public.canvas_link_plan (canvas_id, edge_id, expires_at);

CREATE TABLE public.canvas_history_patch (
    canvas_id uuid NOT NULL,
    edit_revision bigint NOT NULL,
    undone boolean NOT NULL,
    moved_at_revision bigint NOT NULL,
    payload bytea NOT NULL CHECK (octet_length(payload) >= 1 AND octet_length(payload) <= 33554432),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    PRIMARY KEY (canvas_id, edit_revision),
    FOREIGN KEY (canvas_id, edit_revision) REFERENCES public.canvas_document_event (canvas_id, revision),
    FOREIGN KEY (canvas_id, moved_at_revision) REFERENCES public.canvas_document_event (canvas_id, revision)
);
CREATE INDEX canvas_history_undo ON public.canvas_history_patch (canvas_id, undone, edit_revision DESC);
CREATE INDEX canvas_history_redo ON public.canvas_history_patch (canvas_id, undone, moved_at_revision DESC);

CREATE TABLE public.canvas_history_transition (
    canvas_id uuid NOT NULL,
    revision bigint NOT NULL,
    target_revision bigint,
    discarded_redo bigint[] NOT NULL,
    PRIMARY KEY (canvas_id, revision),
    FOREIGN KEY (canvas_id, revision) REFERENCES public.canvas_document_event (canvas_id, revision),
    FOREIGN KEY (canvas_id, target_revision) REFERENCES public.canvas_document_event (canvas_id, revision)
);

CREATE TABLE public.private_media (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.admin_principal (id),
    command_id uuid NOT NULL,
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
    name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
    format smallint NOT NULL CHECK (format >= 1 AND format <= 2),
    length integer NOT NULL CHECK (length BETWEEN 1 AND 20971520),
    width integer NOT NULL CHECK (width BETWEEN 1 AND 8192),
    height integer NOT NULL CHECK (height BETWEEN 1 AND 8192),
    phase smallint NOT NULL CHECK (phase >= 0 AND phase <= 3),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, command_id)
);
CREATE INDEX private_media_owner_listing ON public.private_media (owner_id, created_at DESC, id DESC) WHERE phase = 1;

CREATE TABLE public.article_revision_media (
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    asset_id uuid NOT NULL REFERENCES public.private_media (id),
    PRIMARY KEY (article_id, revision, asset_id),
    FOREIGN KEY (article_id, revision) REFERENCES public.article_revision (article_id, revision)
);
CREATE INDEX article_revision_media_asset ON public.article_revision_media (asset_id);

CREATE TABLE public.article_revision_cover (
    article_id integer NOT NULL,
    revision bigint NOT NULL,
    asset_id uuid NOT NULL,
    PRIMARY KEY (article_id, revision),
    FOREIGN KEY (article_id, revision, asset_id) REFERENCES public.article_revision_media (article_id, revision, asset_id)
);

CREATE TABLE public.private_media_upload (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.admin_principal (id),
    command_id uuid NOT NULL,
    name text NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
    format smallint NOT NULL CHECK (format BETWEEN 1 AND 2),
    length integer NOT NULL CHECK (length BETWEEN 1 AND 20971520),
    part_size integer NOT NULL CHECK (part_size BETWEEN 65536 AND 2097152),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    expires_at timestamptz NOT NULL,
    asset_id uuid REFERENCES public.private_media (id),
    complete boolean NOT NULL DEFAULT false CHECK (NOT complete OR asset_id IS NOT NULL),
    UNIQUE (owner_id, command_id)
);
CREATE INDEX private_media_upload_expiry ON public.private_media_upload (expires_at, id);
CREATE INDEX private_media_upload_asset ON public.private_media_upload (asset_id) WHERE asset_id IS NOT NULL;

CREATE TABLE public.private_media_upload_part (
    upload_id uuid NOT NULL REFERENCES public.private_media_upload (id),
    part integer NOT NULL CHECK (part BETWEEN 0 AND 319),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    bytes bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 1 AND 2097152),
    PRIMARY KEY (upload_id, part)
);

CREATE TABLE public.article_publication_media (
    article_id integer NOT NULL,
    publication_id bigint NOT NULL,
    revision bigint NOT NULL,
    ordinal integer NOT NULL CHECK (ordinal >= 1 AND ordinal <= 32),
    asset_id uuid NOT NULL,
    content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
    format smallint NOT NULL CHECK (format >= 1 AND format <= 2),
    length integer NOT NULL CHECK (length >= 1 AND length <= 20971520),
    width integer NOT NULL CHECK (width >= 1 AND width <= 8192),
    height integer NOT NULL CHECK (height >= 1 AND height <= 8192),
    PRIMARY KEY (article_id, publication_id, ordinal),
    UNIQUE (article_id, publication_id, asset_id),
    UNIQUE (article_id, publication_id, content_hash),
    FOREIGN KEY (article_id, publication_id, revision)
        REFERENCES public.article_publication_history (article_id, publication_id, revision),
    FOREIGN KEY (article_id, revision, asset_id)
        REFERENCES public.article_revision_media (article_id, revision, asset_id)
);

CREATE TABLE public.article_publication_cover (
    article_id integer NOT NULL,
    publication_id bigint NOT NULL,
    asset_id uuid NOT NULL,
    PRIMARY KEY (article_id, publication_id),
    FOREIGN KEY (article_id, publication_id, asset_id)
        REFERENCES public.article_publication_media (article_id, publication_id, asset_id)
);

CREATE TABLE public.author_document_export (
    owner_id uuid NOT NULL REFERENCES public.admin_principal (id) ON DELETE CASCADE,
    id uuid NOT NULL,
    article_id integer NOT NULL,
    expected_revision bigint NOT NULL,
    source_revision bigint NOT NULL,
    author_generation bigint NOT NULL CHECK (author_generation > 0),
    format smallint NOT NULL CHECK (format BETWEEN 1 AND 4),
    state smallint NOT NULL CHECK (state BETWEEN 1 AND 7),
    failure smallint NOT NULL DEFAULT 0 CHECK (failure BETWEEN 0 AND 4),
    provider smallint NOT NULL DEFAULT 1 CHECK (provider BETWEEN 1 AND 4),
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    expires_at timestamptz NOT NULL,
    source_digest bytea NOT NULL CHECK (octet_length(source_digest) = 32),
    output_digest bytea CHECK (octet_length(output_digest) = 32),
    output bytea CHECK (octet_length(output) BETWEEN 1 AND 4194304),
    attachment_id uuid,
    attachment_ids uuid[],
    CHECK ((provider = 3) = (attachment_id IS NOT NULL)),
    CHECK ((provider = 4) = (attachment_ids IS NOT NULL)),
    CHECK (attachment_ids IS NULL OR (format BETWEEN 1 AND 4 AND cardinality(attachment_ids) BETWEEN 2 AND 4
        AND array_ndims(attachment_ids) = 1 AND array_position(attachment_ids, NULL) IS NULL)),
    PRIMARY KEY (owner_id, id),
    FOREIGN KEY (article_id, source_revision)
        REFERENCES public.article_revision (article_id, revision) ON DELETE CASCADE,
    CHECK (source_revision >= 1 AND source_revision <= expected_revision),
    CHECK (expires_at > created_at),
    CHECK (started_at >= created_at),
    CHECK (finished_at >= coalesce(started_at, created_at)),
    CHECK ((state BETWEEN 3 AND 6) = (finished_at IS NOT NULL)),
    CHECK ((state NOT IN (2, 3, 7)) OR started_at IS NOT NULL),
    CHECK ((state IN (4, 6)) = (failure <> 0)),
    CHECK ((state = 3) = (output IS NOT NULL)),
    CHECK ((state = 3) = (output_digest IS NOT NULL))
);
CREATE INDEX author_document_export_pending ON public.author_document_export (state, created_at, owner_id, id);
CREATE INDEX author_document_export_expiry ON public.author_document_export (expires_at);
CREATE INDEX author_document_export_article ON public.author_document_export (owner_id, article_id, created_at, id);
