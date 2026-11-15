-- Raw PostgreSQL DDL from frozen FsusBlog 2605b438eed8f16d12ddddf033d08a6fa18fcd12
-- src/migration/Definitions/AuthorSavedViewMigrationDefinitions.cs. Only the C# raw-string indentation is removed.

CREATE TABLE IF NOT EXISTS author_saved_view_collection (
    owner_admin_principal_id bigint NOT NULL,
    site_scope varchar(128) NOT NULL,
    revision bigint NOT NULL,
    default_view_id uuid NULL,
    active_view_count integer NOT NULL,
    last_command_digest varchar(64) NOT NULL,
    content_digest varchar(64) NOT NULL,
    PRIMARY KEY (owner_admin_principal_id, site_scope),
    CONSTRAINT fk_author_saved_view_collection_owner
        FOREIGN KEY (owner_admin_principal_id) REFERENCES admin_principal(id) ON DELETE CASCADE,
    CONSTRAINT ck_author_saved_view_collection_revision CHECK (revision >= 0),
    CONSTRAINT ck_author_saved_view_collection_count CHECK (active_view_count BETWEEN 0 AND 1000),
    CONSTRAINT ck_author_saved_view_collection_digests CHECK (
        last_command_digest ~ '^[0-9a-f]{64}$'
        AND content_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS author_saved_view (
    id uuid PRIMARY KEY,
    owner_admin_principal_id bigint NOT NULL,
    site_scope varchar(128) NOT NULL,
    schema_version integer NOT NULL,
    revision bigint NOT NULL,
    name varchar(128) NOT NULL,
    name_key varchar(256) NOT NULL,
    query_digest varchar(64) NOT NULL,
    dependency_digest varchar(64) NOT NULL,
    sort_field_kind smallint NOT NULL,
    sort_field_identity varchar(128) NOT NULL,
    sort_direction smallint NOT NULL,
    sort_null_placement smallint NOT NULL,
    sort_collation varchar(32) NOT NULL,
    sort_timezone_id varchar(64) NULL,
    stable_tie_breaker varchar(128) NOT NULL,
    page_size integer NOT NULL,
    pinned boolean NOT NULL,
    order_key bigint NOT NULL,
    lifecycle_state smallint NOT NULL,
    created_at_utc timestamp without time zone NOT NULL,
    updated_at_utc timestamp without time zone NOT NULL,
    content_digest varchar(64) NOT NULL,
    CONSTRAINT fk_author_saved_view_collection
        FOREIGN KEY (owner_admin_principal_id, site_scope)
        REFERENCES author_saved_view_collection(owner_admin_principal_id, site_scope)
        ON DELETE CASCADE,
    CONSTRAINT ck_author_saved_view_schema CHECK (schema_version = 1),
    CONSTRAINT ck_author_saved_view_revision CHECK (revision >= 1),
    CONSTRAINT ck_author_saved_view_name CHECK (char_length(name) BETWEEN 1 AND 128),
    CONSTRAINT ck_author_saved_view_sort_kind CHECK (sort_field_kind BETWEEN 0 AND 7),
    CONSTRAINT ck_author_saved_view_sort_direction CHECK (sort_direction IN (0, 1)),
    CONSTRAINT ck_author_saved_view_sort_null CHECK (sort_null_placement IN (0, 1)),
    CONSTRAINT ck_author_saved_view_page_size CHECK (page_size BETWEEN 1 AND 100),
    CONSTRAINT ck_author_saved_view_order CHECK (
        (pinned AND lifecycle_state = 0 AND order_key > 0)
        OR (NOT pinned AND order_key = 0)),
    CONSTRAINT ck_author_saved_view_lifecycle CHECK (lifecycle_state IN (0, 1)),
    CONSTRAINT ck_author_saved_view_digests CHECK (
        query_digest ~ '^[0-9a-f]{64}$'
        AND dependency_digest ~ '^[0-9a-f]{64}$'
        AND content_digest ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_author_saved_view_active_name
    ON author_saved_view(owner_admin_principal_id, site_scope, name_key)
    WHERE lifecycle_state = 0;
CREATE INDEX IF NOT EXISTS ix_author_saved_view_page
    ON author_saved_view(
        owner_admin_principal_id, site_scope, lifecycle_state, pinned DESC, order_key, id);

CREATE TABLE IF NOT EXISTS author_saved_view_condition (
    view_id uuid NOT NULL,
    condition_index smallint NOT NULL,
    field_kind smallint NOT NULL,
    field_identity varchar(128) NOT NULL,
    operator_id varchar(128) NOT NULL,
    timezone_id varchar(64) NULL,
    PRIMARY KEY (view_id, condition_index),
    CONSTRAINT fk_author_saved_view_condition
        FOREIGN KEY (view_id) REFERENCES author_saved_view(id) ON DELETE CASCADE,
    CONSTRAINT ck_author_saved_view_condition_index CHECK (condition_index BETWEEN 0 AND 63),
    CONSTRAINT ck_author_saved_view_condition_kind CHECK (field_kind BETWEEN 0 AND 7)
);

CREATE TABLE IF NOT EXISTS author_saved_view_condition_value (
    view_id uuid NOT NULL,
    condition_index smallint NOT NULL,
    value_index smallint NOT NULL,
    value varchar(512) NOT NULL,
    PRIMARY KEY (view_id, condition_index, value_index),
    CONSTRAINT fk_author_saved_view_condition_value
        FOREIGN KEY (view_id, condition_index)
        REFERENCES author_saved_view_condition(view_id, condition_index) ON DELETE CASCADE,
    CONSTRAINT ck_author_saved_view_condition_value_index CHECK (value_index BETWEEN 0 AND 63),
    CONSTRAINT ck_author_saved_view_condition_value CHECK (char_length(value) BETWEEN 1 AND 512)
);

CREATE TABLE IF NOT EXISTS author_saved_view_projection (
    view_id uuid NOT NULL,
    projection_index smallint NOT NULL,
    field_kind smallint NOT NULL,
    field_identity varchar(128) NOT NULL,
    PRIMARY KEY (view_id, projection_index),
    CONSTRAINT fk_author_saved_view_projection
        FOREIGN KEY (view_id) REFERENCES author_saved_view(id) ON DELETE CASCADE,
    CONSTRAINT ck_author_saved_view_projection_index CHECK (projection_index BETWEEN 0 AND 31),
    CONSTRAINT ck_author_saved_view_projection_kind CHECK (field_kind BETWEEN 0 AND 7)
);

CREATE TABLE IF NOT EXISTS author_saved_view_receipt (
    receipt_id uuid PRIMARY KEY,
    request_id uuid NOT NULL,
    owner_admin_principal_id bigint NOT NULL,
    site_scope varchar(128) NOT NULL,
    view_id uuid NOT NULL,
    command_kind varchar(32) NOT NULL,
    command_digest varchar(64) NOT NULL,
    view_revision bigint NOT NULL,
    previous_collection_revision bigint NOT NULL,
    collection_revision bigint NOT NULL,
    query_digest varchar(64) NOT NULL,
    dependency_digest varchar(64) NOT NULL,
    pinned boolean NOT NULL,
    previous_default_view_id uuid NULL,
    default_view_id uuid NULL,
    previous_active_view_count integer NOT NULL,
    active_view_count integer NOT NULL,
    order_key bigint NOT NULL,
    lifecycle_state smallint NOT NULL,
    default_transition smallint NOT NULL,
    change_count integer NOT NULL,
    changes_digest varchar(64) NOT NULL,
    reason_code varchar(64) NOT NULL,
    content_digest varchar(64) NOT NULL,
    occurred_at_utc timestamp without time zone NOT NULL,
    CONSTRAINT ck_author_saved_view_receipt_revisions CHECK (
        view_revision >= 0
        AND previous_collection_revision >= 0
        AND collection_revision = previous_collection_revision + 1),
    CONSTRAINT ck_author_saved_view_receipt_counts CHECK (
        previous_active_view_count BETWEEN 0 AND 1000
        AND active_view_count BETWEEN 0 AND 1000
        AND change_count BETWEEN 0 AND 1000),
    CONSTRAINT ck_author_saved_view_receipt_lifecycle CHECK (lifecycle_state IN (0, 1)),
    CONSTRAINT ck_author_saved_view_receipt_default_transition CHECK (
        default_transition BETWEEN 0 AND 3),
    CONSTRAINT ck_author_saved_view_receipt_digests CHECK (
        command_digest ~ '^[0-9a-f]{64}$'
        AND (query_digest = '' OR query_digest ~ '^[0-9a-f]{64}$')
        AND (dependency_digest = '' OR dependency_digest ~ '^[0-9a-f]{64}$')
        AND changes_digest ~ '^[0-9a-f]{64}$'
        AND content_digest ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_author_saved_view_receipt_revision
    ON author_saved_view_receipt(
        owner_admin_principal_id, site_scope, collection_revision);
CREATE INDEX IF NOT EXISTS ix_author_saved_view_receipt_owner
    ON author_saved_view_receipt(
        owner_admin_principal_id, site_scope, collection_revision DESC, occurred_at_utc DESC);

CREATE TABLE IF NOT EXISTS author_saved_view_receipt_change (
    receipt_id uuid NOT NULL,
    change_index integer NOT NULL,
    view_id uuid NOT NULL,
    change_kind smallint NOT NULL,
    before_revision bigint NULL,
    before_name varchar(128) NULL,
    before_query_digest varchar(64) NULL,
    before_dependency_digest varchar(64) NULL,
    before_pinned boolean NULL,
    before_order_key bigint NULL,
    before_lifecycle_state smallint NULL,
    before_content_digest varchar(64) NULL,
    after_revision bigint NOT NULL,
    after_name varchar(128) NOT NULL,
    after_query_digest varchar(64) NOT NULL,
    after_dependency_digest varchar(64) NOT NULL,
    after_pinned boolean NOT NULL,
    after_order_key bigint NOT NULL,
    after_lifecycle_state smallint NOT NULL,
    after_content_digest varchar(64) NOT NULL,
    content_digest varchar(64) NOT NULL,
    PRIMARY KEY (receipt_id, change_index),
    CONSTRAINT ux_author_saved_view_receipt_change_view UNIQUE (receipt_id, view_id),
    CONSTRAINT fk_author_saved_view_receipt_change_receipt
        FOREIGN KEY (receipt_id) REFERENCES author_saved_view_receipt(receipt_id)
        ON DELETE RESTRICT,
    CONSTRAINT ck_author_saved_view_receipt_change_index CHECK (
        change_index BETWEEN 0 AND 999),
    CONSTRAINT ck_author_saved_view_receipt_change_kind CHECK (change_kind BETWEEN 0 AND 2),
    CONSTRAINT ck_author_saved_view_receipt_change_before CHECK (
        (change_kind = 0
            AND before_revision IS NULL
            AND before_name IS NULL
            AND before_query_digest IS NULL
            AND before_dependency_digest IS NULL
            AND before_pinned IS NULL
            AND before_order_key IS NULL
            AND before_lifecycle_state IS NULL
            AND before_content_digest IS NULL
            AND after_revision = 1)
        OR (change_kind IN (1, 2)
            AND before_revision >= 1
            AND before_name IS NOT NULL
            AND before_query_digest IS NOT NULL
            AND before_dependency_digest IS NOT NULL
            AND before_pinned IS NOT NULL
            AND before_order_key IS NOT NULL
            AND before_lifecycle_state IS NOT NULL
            AND before_content_digest IS NOT NULL
            AND after_revision = before_revision + 1)),
    CONSTRAINT ck_author_saved_view_receipt_change_before_order CHECK (
        before_revision IS NULL
        OR (before_pinned AND before_lifecycle_state = 0 AND before_order_key > 0)
        OR (NOT before_pinned AND before_order_key = 0)),
    CONSTRAINT ck_author_saved_view_receipt_change_after_order CHECK (
        (after_pinned AND after_lifecycle_state = 0 AND after_order_key > 0)
        OR (NOT after_pinned AND after_order_key = 0)),
    CONSTRAINT ck_author_saved_view_receipt_change_lifecycle CHECK (
        (before_lifecycle_state IS NULL OR before_lifecycle_state IN (0, 1))
        AND after_lifecycle_state IN (0, 1)),
    CONSTRAINT ck_author_saved_view_receipt_change_digests CHECK (
        (before_query_digest IS NULL OR before_query_digest ~ '^[0-9a-f]{64}$')
        AND (before_dependency_digest IS NULL OR before_dependency_digest ~ '^[0-9a-f]{64}$')
        AND (before_content_digest IS NULL OR before_content_digest ~ '^[0-9a-f]{64}$')
        AND after_query_digest ~ '^[0-9a-f]{64}$'
        AND after_dependency_digest ~ '^[0-9a-f]{64}$'
        AND after_content_digest ~ '^[0-9a-f]{64}$'
        AND content_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS author_saved_view_idempotency (
    owner_admin_principal_id bigint NOT NULL,
    site_scope varchar(128) NOT NULL,
    request_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    command_digest varchar(64) NOT NULL,
    created_at_utc timestamp without time zone NOT NULL,
    PRIMARY KEY (owner_admin_principal_id, site_scope, request_id),
    CONSTRAINT fk_author_saved_view_idempotency_receipt
        FOREIGN KEY (receipt_id) REFERENCES author_saved_view_receipt(receipt_id) ON DELETE RESTRICT,
    CONSTRAINT ck_author_saved_view_idempotency_digest CHECK (
        command_digest ~ '^[0-9a-f]{64}$')
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_author_saved_view_collection_default') THEN
        ALTER TABLE author_saved_view_collection
            ADD CONSTRAINT fk_author_saved_view_collection_default
            FOREIGN KEY (default_view_id) REFERENCES author_saved_view(id)
            ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

-- Replay the committed rows from the frozen store's create, set-pinned and set-default commands.
-- The pinned dependency provider resolves category:11 from the companion legacy-source-fixture.sql.
-- SHA-256 literals use the frozen UTF-8 length-prefixed canonical query, dependency and ledger payloads.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM category WHERE id=11)
       OR NOT EXISTS (SELECT FROM article_revision WHERE article_id=42 AND created_by_admin_principal_id=7) THEN
        RAISE EXCEPTION 'Saved-view fixture requires the companion category and article author';
    END IF;
END $$;

BEGIN;

INSERT INTO author_saved_view_collection (
    owner_admin_principal_id, site_scope, revision, default_view_id, active_view_count, last_command_digest,
    content_digest
) VALUES (
    7, 'primary', 1, NULL, 1, '08095ee5a03f96c6f54e331e10857feacce9a7fa02276252d68b64cadfb42a79',
    '7e71f6c9f61de81ecca7e32d1ddbf30ef63798426666dca5717d6107d74f544f'
);

INSERT INTO author_saved_view (
    id, owner_admin_principal_id, site_scope, schema_version, revision, name, name_key, query_digest,
    dependency_digest, sort_field_kind, sort_field_identity, sort_direction, sort_null_placement, sort_collation,
    sort_timezone_id, stable_tie_breaker, page_size, pinned, order_key, lifecycle_state, created_at_utc,
    updated_at_utc, content_digest
) VALUES (
    '6f94f86a-c4de-48bb-bde6-d15893701a42', 7, 'primary', 1, 1, 'Reviewed category', 'REVIEWED CATEGORY',
    'e123af6f257e7edc5bd8c8a3d73fcd9620b195d869667e6cc168c6f06bdbc7ae',
    '9435dc3f58b9b1d66e75ca057a12e996089b6619cb7669ecf8ec78ad6c09cc6b', 0, 'article.lifecycle.status', 0, 1,
    'ordinal', NULL, 'article.id', 25, false, 0, 0, TIMESTAMP '2026-10-04 00:00:00',
    TIMESTAMP '2026-10-04 00:00:00', 'ca518fa39200deabcafcd9b22c595c67ff0b7a30060b1cc579739f5084b8f6b4'
);

INSERT INTO author_saved_view_condition (
    view_id, condition_index, field_kind, field_identity, operator_id, timezone_id
) VALUES (
    '6f94f86a-c4de-48bb-bde6-d15893701a42', 0, 1, 'category:11', 'identity.equals', NULL
);

INSERT INTO author_saved_view_condition_value (
    view_id, condition_index, value_index, value
) VALUES (
    '6f94f86a-c4de-48bb-bde6-d15893701a42', 0, 0, 'category:11'
);

INSERT INTO author_saved_view_projection (
    view_id, projection_index, field_kind, field_identity
) VALUES (
    '6f94f86a-c4de-48bb-bde6-d15893701a42', 0, 1, 'category:11'
);

INSERT INTO author_saved_view_receipt (
    receipt_id, request_id, owner_admin_principal_id, site_scope, view_id, command_kind, command_digest,
    view_revision, previous_collection_revision, collection_revision, query_digest, dependency_digest, pinned,
    previous_default_view_id, default_view_id, previous_active_view_count, active_view_count, order_key,
    lifecycle_state, default_transition, change_count, changes_digest, reason_code, content_digest,
    occurred_at_utc
) VALUES (
    '01a10435-d800-7000-8000-000000000001', '6f94f86a-c4de-48bb-bde6-d15893701b01', 7, 'primary',
    '6f94f86a-c4de-48bb-bde6-d15893701a42', 'create',
    '08095ee5a03f96c6f54e331e10857feacce9a7fa02276252d68b64cadfb42a79', 1, 0, 1,
    'e123af6f257e7edc5bd8c8a3d73fcd9620b195d869667e6cc168c6f06bdbc7ae',
    '9435dc3f58b9b1d66e75ca057a12e996089b6619cb7669ecf8ec78ad6c09cc6b', false, NULL, NULL, 0, 1, 0, 0, 0, 1,
    '75fe7d04d5887f475e5c4476d19d48e689fc09099f71211d158894751b052aaf', 'none',
    '63beac556219da2b898617ccaa0aea6f2ae70d6c97843e323129a94e5fa3a89f', TIMESTAMP '2026-10-04 00:00:00'
);

INSERT INTO author_saved_view_receipt_change (
    receipt_id, change_index, view_id, change_kind, before_revision, before_name, before_query_digest,
    before_dependency_digest, before_pinned, before_order_key, before_lifecycle_state, before_content_digest,
    after_revision, after_name, after_query_digest, after_dependency_digest, after_pinned, after_order_key,
    after_lifecycle_state, after_content_digest, content_digest
) VALUES (
    '01a10435-d800-7000-8000-000000000001', 0, '6f94f86a-c4de-48bb-bde6-d15893701a42', 0, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, 1, 'Reviewed category',
    'e123af6f257e7edc5bd8c8a3d73fcd9620b195d869667e6cc168c6f06bdbc7ae',
    '9435dc3f58b9b1d66e75ca057a12e996089b6619cb7669ecf8ec78ad6c09cc6b', false, 0, 0,
    'ca518fa39200deabcafcd9b22c595c67ff0b7a30060b1cc579739f5084b8f6b4',
    '574472c1396d0c179fb0ebaa0bb7b3a8104f7948750b61ef122f5642be67bc53'
);

INSERT INTO author_saved_view_idempotency (
    owner_admin_principal_id, site_scope, request_id, receipt_id, command_digest, created_at_utc
) VALUES (
    7, 'primary', '6f94f86a-c4de-48bb-bde6-d15893701b01', '01a10435-d800-7000-8000-000000000001',
    '08095ee5a03f96c6f54e331e10857feacce9a7fa02276252d68b64cadfb42a79', TIMESTAMP '2026-10-04 00:00:00'
);

COMMIT;

BEGIN;

UPDATE author_saved_view_collection SET revision=2, last_command_digest='0b22d5e6e05436973a65a6fedc43676105824a50e5daa84d439c795bab758ac9',
    content_digest='71d4b26bd7c5a762228a90b0d013150d039e4e924ee83871cf9c17be63ddf531'
WHERE owner_admin_principal_id=7 AND site_scope='primary' AND revision=1;
UPDATE author_saved_view SET revision=2, pinned=true, order_key=1, updated_at_utc=TIMESTAMP '2026-10-04 00:01:00',
    content_digest='a98d078fc0cfd135936e0105472dbce2c2cc97714d69b23e53572de28fb4946a'
WHERE id='6f94f86a-c4de-48bb-bde6-d15893701a42' AND revision=1;

INSERT INTO author_saved_view_receipt (
    receipt_id, request_id, owner_admin_principal_id, site_scope, view_id, command_kind, command_digest,
    view_revision, previous_collection_revision, collection_revision, query_digest, dependency_digest, pinned,
    previous_default_view_id, default_view_id, previous_active_view_count, active_view_count, order_key,
    lifecycle_state, default_transition, change_count, changes_digest, reason_code, content_digest,
    occurred_at_utc
) VALUES (
    '01a10436-c260-7000-8000-000000000002', '6f94f86a-c4de-48bb-bde6-d15893701b02', 7, 'primary',
    '6f94f86a-c4de-48bb-bde6-d15893701a42', 'set-pinned',
    '0b22d5e6e05436973a65a6fedc43676105824a50e5daa84d439c795bab758ac9', 2, 1, 2,
    'e123af6f257e7edc5bd8c8a3d73fcd9620b195d869667e6cc168c6f06bdbc7ae',
    '9435dc3f58b9b1d66e75ca057a12e996089b6619cb7669ecf8ec78ad6c09cc6b', true, NULL, NULL, 1, 1, 1, 0, 0, 1,
    '24ddeae6625ae2c5695dec19188e7a06cbbee14d7f1eb4b678f32f08527f402d', 'none',
    '2405b15af648a7297b0b29c18fbcd4ab1e5f900d7dcc296c42997b9eb9a3bedc', TIMESTAMP '2026-10-04 00:01:00'
);

INSERT INTO author_saved_view_receipt_change (
    receipt_id, change_index, view_id, change_kind, before_revision, before_name, before_query_digest,
    before_dependency_digest, before_pinned, before_order_key, before_lifecycle_state, before_content_digest,
    after_revision, after_name, after_query_digest, after_dependency_digest, after_pinned, after_order_key,
    after_lifecycle_state, after_content_digest, content_digest
) VALUES (
    '01a10436-c260-7000-8000-000000000002', 0, '6f94f86a-c4de-48bb-bde6-d15893701a42', 1, 1, 'Reviewed category',
    'e123af6f257e7edc5bd8c8a3d73fcd9620b195d869667e6cc168c6f06bdbc7ae',
    '9435dc3f58b9b1d66e75ca057a12e996089b6619cb7669ecf8ec78ad6c09cc6b', false, 0, 0,
    'ca518fa39200deabcafcd9b22c595c67ff0b7a30060b1cc579739f5084b8f6b4', 2, 'Reviewed category',
    'e123af6f257e7edc5bd8c8a3d73fcd9620b195d869667e6cc168c6f06bdbc7ae',
    '9435dc3f58b9b1d66e75ca057a12e996089b6619cb7669ecf8ec78ad6c09cc6b', true, 1, 0,
    'a98d078fc0cfd135936e0105472dbce2c2cc97714d69b23e53572de28fb4946a',
    '4c2f7787a3272dc960a0892d47a78a4b10bc71a76b2e5c8fe7949ec1909a25dd'
);

INSERT INTO author_saved_view_idempotency (
    owner_admin_principal_id, site_scope, request_id, receipt_id, command_digest, created_at_utc
) VALUES (
    7, 'primary', '6f94f86a-c4de-48bb-bde6-d15893701b02', '01a10436-c260-7000-8000-000000000002',
    '0b22d5e6e05436973a65a6fedc43676105824a50e5daa84d439c795bab758ac9', TIMESTAMP '2026-10-04 00:01:00'
);

COMMIT;

BEGIN;

UPDATE author_saved_view_collection SET revision=3, default_view_id='6f94f86a-c4de-48bb-bde6-d15893701a42',
    last_command_digest='49587f423abcc8355bc272e15a3b57292066f532e3cc4a7bd3adcf43046b6d14',
    content_digest='9d924c2b41f72e0de340ec804db801ce76d201264244f6c0a8dfb2c60e62e651'
WHERE owner_admin_principal_id=7 AND site_scope='primary' AND revision=2;

INSERT INTO author_saved_view_receipt (
    receipt_id, request_id, owner_admin_principal_id, site_scope, view_id, command_kind, command_digest,
    view_revision, previous_collection_revision, collection_revision, query_digest, dependency_digest, pinned,
    previous_default_view_id, default_view_id, previous_active_view_count, active_view_count, order_key,
    lifecycle_state, default_transition, change_count, changes_digest, reason_code, content_digest,
    occurred_at_utc
) VALUES (
    '01a10437-acc0-7000-8000-000000000003', '6f94f86a-c4de-48bb-bde6-d15893701b03', 7, 'primary',
    '6f94f86a-c4de-48bb-bde6-d15893701a42', 'set-default',
    '49587f423abcc8355bc272e15a3b57292066f532e3cc4a7bd3adcf43046b6d14', 2, 2, 3,
    'e123af6f257e7edc5bd8c8a3d73fcd9620b195d869667e6cc168c6f06bdbc7ae',
    '9435dc3f58b9b1d66e75ca057a12e996089b6619cb7669ecf8ec78ad6c09cc6b', true, NULL,
    '6f94f86a-c4de-48bb-bde6-d15893701a42', 1, 1, 1, 0, 1, 0,
    '1b26cca0fce89aa39da5a00b4e891c984091ff32b6ccd3011f7039b35bdf9f4b', 'none',
    '1b7332467cfd8103cdf58798a559da54eb5bf58b90fb8c1aa6c50a5a4d084dae', TIMESTAMP '2026-10-04 00:02:00'
);

INSERT INTO author_saved_view_idempotency (
    owner_admin_principal_id, site_scope, request_id, receipt_id, command_digest, created_at_utc
) VALUES (
    7, 'primary', '6f94f86a-c4de-48bb-bde6-d15893701b03', '01a10437-acc0-7000-8000-000000000003',
    '49587f423abcc8355bc272e15a3b57292066f532e3cc4a7bd3adcf43046b6d14', TIMESTAMP '2026-10-04 00:02:00'
);

COMMIT;
