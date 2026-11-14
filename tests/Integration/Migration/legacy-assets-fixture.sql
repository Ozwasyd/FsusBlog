-- Canonical v1 PostgreSQL content-asset cutover relations and their source IDs.
CREATE TABLE content_asset (
    id uuid PRIMARY KEY, storage_class varchar(16) NOT NULL, storage_key varchar(512) NOT NULL UNIQUE,
    media_type varchar(127) NOT NULL, extension varchar(16) NOT NULL, byte_length bigint NOT NULL,
    sha256 varchar(64), width integer, height integer, owner_admin_principal_id bigint, state varchar(16) NOT NULL,
    created_at_utc timestamp NOT NULL, updated_at_utc timestamp NOT NULL,
    CHECK (storage_class IN ('public', 'private')), CHECK (state IN ('active', 'pending_delete')), CHECK (byte_length >= 0)
);
CREATE TABLE content_asset_reference (
    asset_id uuid NOT NULL REFERENCES content_asset(id), source_kind varchar(16) NOT NULL,
    source_key varchar(160) NOT NULL, article_id integer, reference_count integer NOT NULL,
    alt_text varchar(256), updated_at_utc timestamp NOT NULL,
    PRIMARY KEY (asset_id, source_kind, source_key),
    CHECK (source_kind IN ('article', 'draft', 'revision')), CHECK (reference_count > 0)
);
CREATE TABLE content_asset_cleanup_queue (
    asset_id uuid PRIMARY KEY REFERENCES content_asset(id), not_before_utc timestamp NOT NULL,
    attempt_count integer NOT NULL DEFAULT 0, last_error varchar(512), updated_at_utc timestamp NOT NULL
);
INSERT INTO content_asset VALUES
    ('1a550000-0000-4000-8000-000000000001', 'public', 'illustration/ExactName.txt', 'text/plain', '.txt', 3,
     'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', NULL, NULL, NULL, 'active',
     '2026-10-01 00:00:00', '2026-10-01 00:00:00'),
    ('2b550000-0000-4000-8000-000000000002', 'private', '2b/2b550000000040008000000000000002.txt', 'text/plain', 'TXT', 3,
     'cb8379ac2098aa165029e3938a51da0bcecfc008fd6795f401178647f96c5b34', NULL, NULL, 7, 'active',
     '2026-10-01 00:00:00', '2026-10-01 00:00:00');
INSERT INTO content_asset_reference VALUES
    ('1a550000-0000-4000-8000-000000000001', 'article', '42', 42, 1, 'Fixture private alt text', '2026-10-01 00:00:00'),
    ('2b550000-0000-4000-8000-000000000002', 'revision', '5000000002', 42, 1, NULL, '2026-10-01 00:00:00');
