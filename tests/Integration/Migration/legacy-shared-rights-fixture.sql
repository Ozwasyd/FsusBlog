-- Shared projection of the pinned v1 ArticleRightsPolicy, ArticleRightsSnapshot,
-- and ArticleResponsibilitySnapshot storage fields. IDs are set explicitly so
-- the same fixture can exercise PostgreSQL, MySQL, and SQLite.
CREATE TABLE article_rights_policy (
    id bigint PRIMARY KEY,
    article_id integer NOT NULL UNIQUE,
    enabled boolean NOT NULL,
    license_type varchar(48) NOT NULL,
    copyright_holder varchar(256),
    copyright_year integer,
    rights_statement text,
    attribution_template text,
    copy_policy varchar(48) NOT NULL,
    max_excerpt_chars integer NOT NULL,
    allow_code_copy boolean NOT NULL,
    show_public_badge boolean NOT NULL,
    proof_binding_enabled boolean NOT NULL,
    created_at timestamp NOT NULL,
    updated_at timestamp NOT NULL
);

CREATE TABLE article_rights_snapshot (
    id bigint PRIMARY KEY,
    article_id integer NOT NULL,
    article_revision_id bigint NOT NULL,
    revision_no integer NOT NULL,
    article_rights_policy_id bigint NOT NULL,
    enabled boolean NOT NULL,
    license_type varchar(48) NOT NULL,
    copyright_holder varchar(256),
    copyright_year integer,
    rights_statement text,
    attribution_template text,
    copy_policy varchar(48) NOT NULL,
    max_excerpt_chars integer NOT NULL,
    allow_code_copy boolean NOT NULL,
    show_public_badge boolean NOT NULL,
    proof_binding_enabled boolean NOT NULL,
    canonical_url varchar(512),
    policy_hash varchar(96) NOT NULL,
    content_canonical_hash varchar(96) NOT NULL,
    created_at timestamp NOT NULL,
    UNIQUE (article_id, article_revision_id)
);

CREATE TABLE article_responsibility_snapshot (
    id bigint PRIMARY KEY,
    article_id integer NOT NULL,
    article_revision_id bigint NOT NULL,
    revision_no integer NOT NULL,
    responsibility_version integer NOT NULL CHECK (responsibility_version > 0),
    previous_snapshot_id bigint,
    inherit_site_author boolean NOT NULL,
    authors_json text NOT NULL,
    reviewer_json text,
    sources_json text NOT NULL,
    update_summary varchar(512),
    update_reason varchar(512),
    effective_at timestamp,
    conclusion_impact varchar(32),
    methodology text,
    applicability text,
    limitations text,
    responsible_person_confirmed boolean NOT NULL,
    created_at timestamp NOT NULL,
    UNIQUE (article_revision_id, responsibility_version),
    FOREIGN KEY (previous_snapshot_id) REFERENCES article_responsibility_snapshot(id) ON DELETE RESTRICT
);

-- Mutable policy matches the second release, while the first keeps its older policy.
INSERT INTO article_rights_policy (
    id, article_id, enabled, license_type, copyright_holder, copyright_year,
    rights_statement, attribution_template, copy_policy, max_excerpt_chars,
    allow_code_copy, show_public_badge, proof_binding_enabled, created_at, updated_at
) VALUES (
    600, 42, true, 'CC-BY-4.0', 'Fixture Author', 2026,
    'Updated rights', '{title} {url}', 'append-attribution', 120,
    false, true, true, '2026-10-01 00:00:00', '2026-10-02 00:00:00'
);

-- Digest literals are independently calculated from pinned canonical-v1 rules,
-- the companion revision rows (category 11, tag 21), and release timestamps.
INSERT INTO article_rights_snapshot (
    id, article_id, article_revision_id, revision_no, article_rights_policy_id,
    enabled, license_type, copyright_holder, copyright_year, rights_statement,
    attribution_template, copy_policy, max_excerpt_chars, allow_code_copy,
    show_public_badge, proof_binding_enabled, canonical_url, policy_hash,
    content_canonical_hash, created_at
) VALUES
    (700, 42, 5000000001, 1, 600, true, 'all-rights-reserved', 'Fixture Author', 2026,
     'Historic rights ☃', NULL, 'append-attribution', 300, true, true, true, NULL,
     'sha256:3de5768cbecd7f5ce133aecd49b58cec405ee09fc0b903245ba4c0243b00bbff',
     'sha256:a2716e7a38b12d0dd7247bbd35cb1f4ad2a4d4c0656b2d0ecf50cef73a6d87e6',
     '2026-10-01 00:00:00'),
    (701, 42, 5000000002, 2, 600, true, 'CC-BY-4.0', 'Fixture Author', 2026,
     'Updated rights', '{title} {url}', 'append-attribution', 120, false, true, true, NULL,
     'sha256:8f3cfaee402568f52cc7125bab5b792a0b9450f615083f5fb323a275e349e91e',
     'sha256:3739bd5414081e3d0a54617159264805bb1a883363a3ba98d1e0ffd6e642801d',
     '2026-10-02 00:00:00');

INSERT INTO article_responsibility_snapshot (
    id, article_id, article_revision_id, revision_no, responsibility_version,
    previous_snapshot_id, inherit_site_author, authors_json, reviewer_json, sources_json,
    update_summary, update_reason, effective_at, conclusion_impact, methodology, applicability,
    limitations, responsible_person_confirmed, created_at
) VALUES
    (799, 42, 5000000001, 1, 1, NULL, true, '[]', NULL, '[]',
     'First revision', NULL, NULL, NULL, NULL, NULL, NULL, true, '2026-10-01 00:00:00'),
    (800, 42, 5000000002, 2, 1, 799, true, '[]', NULL, '[]',
     'Review note ☃', 'Scheduled verification', '2026-10-02 00:00:00', NULL, NULL,
     NULL, NULL, true, '2026-10-02 00:00:00'),
    (801, 42, 5000000002, 2, 2, 800, true, '[]', NULL, '[]',
     'Metadata update', NULL, NULL, NULL, NULL, NULL, NULL, true, '2026-10-03 00:00:00');
