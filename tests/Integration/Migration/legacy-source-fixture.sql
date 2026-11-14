-- Relevant physical columns from v1 Article.cs and the published coordinate/content block definitions.
-- Make current revision differ from both older publications.
CREATE TABLE article (
    id integer PRIMARY KEY, title varchar(256) NOT NULL, summary varchar(512),
    coverimageurl varchar(512), categoryid integer NOT NULL, createtime timestamp NOT NULL,
    metadata_updated_at timestamp NOT NULL, isdeleted boolean NOT NULL, status integer NOT NULL,
    current_revision_id bigint, current_publication_id bigint, scheduled_publish_at timestamp,
    pending_publication_at timestamp, published_at timestamp, last_published_at timestamp,
    public_updated_at timestamp, archived_at timestamp, deleted_at timestamp
);
CREATE TABLE article_body (article_id integer PRIMARY KEY, markdown_content text NOT NULL, updated_at timestamp NOT NULL);
CREATE TABLE article_revision (
    id bigint PRIMARY KEY, article_id integer NOT NULL, revision_no integer NOT NULL,
    title varchar(256) NOT NULL, summary varchar(512), cover_image_url varchar(512),
    categoryid integer NOT NULL, tag_ids text NOT NULL, content_block_id bigint NOT NULL,
    markdown_content text NOT NULL, diff_summary varchar(512), created_by_admin_principal_id bigint NOT NULL,
    rollback_source_revision_id bigint, rollback_reason varchar(500), created_at timestamp NOT NULL
);
CREATE TABLE article_revision_content_block (
    id bigint PRIMARY KEY, content_hash varchar(64) NOT NULL, markdown_content text NOT NULL,
    byte_length integer NOT NULL, created_at timestamp NOT NULL
);
CREATE TABLE article_publication (
    id bigint PRIMARY KEY, article_id integer NOT NULL, publication_no integer NOT NULL,
    article_revision_id bigint NOT NULL, revision_no integer NOT NULL, rights_snapshot_id bigint NOT NULL,
    responsibility_snapshot_id bigint, transition_kind varchar(32) NOT NULL,
    published_at timestamp NOT NULL, created_at timestamp NOT NULL
);
-- Category and Tag are lowercased physically by the v1 PostgreSQL schema initializer.
CREATE TABLE category (
    id integer PRIMARY KEY, name varchar(128) NOT NULL UNIQUE, description varchar(500)
);
CREATE TABLE tag (
    id integer PRIMARY KEY, name varchar(128) NOT NULL UNIQUE, description varchar(500)
);
CREATE TABLE article_tag (
    articleid integer NOT NULL, tagid integer NOT NULL, PRIMARY KEY (articleid, tagid)
);
CREATE TABLE tag_url_alias (
    normalized_name varchar(256) PRIMARY KEY, tag_id integer NOT NULL,
    original_name varchar(128) NOT NULL, created_at_utc timestamp NOT NULL
);
CREATE TABLE admin_principal (
    id bigint PRIMARY KEY, handle varchar(64) NOT NULL UNIQUE,
    status varchar(32) NOT NULL, validationversion bigint NOT NULL,
    isroot boolean NOT NULL, permissions text NOT NULL, totpenabled boolean NOT NULL,
    totpsecretencrypted text
);
INSERT INTO admin_principal VALUES (7, 'fixture-editor', 'active', 1, false, '[]', false, NULL);
INSERT INTO category VALUES
    (11, 'Published category', 'Visible in the published revision'),
    (12, 'Current category', NULL);
INSERT INTO tag VALUES
    (21, 'News', 'Published tag'),
    (22, 'Work in progress', NULL),
    (23, 'Café', 'Unicode display name');
INSERT INTO tag_url_alias VALUES
    ('BLOG NEWS', 21, 'Blog News', '2026-09-05 00:00:00'),
    ('CAFÉ ARCHIVE', 23, 'Café Archive', '2026-09-06 00:00:00');

INSERT INTO article (id, title, categoryid, createtime, metadata_updated_at, isdeleted, status,
                     current_revision_id, current_publication_id, published_at)
VALUES (42, 'Private edit', 12, '2026-10-01 00:00:00', '2026-10-03 00:00:00', false, 2,
        5000000003, 900000002, '2026-10-01 00:00:00');
INSERT INTO article_tag VALUES (42, 22), (42, 23);
INSERT INTO article_body VALUES (42, 'Private edit ☃', '2026-10-03 00:00:00');
INSERT INTO article_revision_content_block VALUES
    (100, 'a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e', 'first', 5, '2026-10-01 00:00:00'),
    (200, 'C3623599529FF7370FD758C3F75335170075F76BB4DEF28A89131708C8E9D750', 'published ☃', 13, '2026-10-02 00:00:00'),
    (300, 'e3af05ce10bf286004cf42455c18e45ce7b14f2b7594e89d0f157e6b74cfb1b2', 'Private edit ☃', 16, '2026-10-03 00:00:00');
INSERT INTO article_revision (id, article_id, revision_no, title, categoryid, tag_ids, content_block_id,
                              markdown_content, created_by_admin_principal_id, created_at)
VALUES (5000000001, 42, 1, 'First', 11, '21', 100, '', 7, '2026-10-01 00:00:00'),
       (5000000002, 42, 2, 'Public', 11, '21', 200, '', 7, '2026-10-02 00:00:00'),
       (5000000003, 42, 3, 'Private edit', 12, '22,23', 300, '', 7, '2026-10-03 00:00:00');
INSERT INTO article_publication VALUES
    (900000001, 42, 1, 5000000001, 1, 700, NULL, 'publish', '2026-10-01 00:00:00', '2026-10-01 00:00:00'),
    (900000002, 42, 2, 5000000002, 2, 701, 800, 'republish', '2026-10-02 00:00:00', '2026-10-02 00:00:00');
