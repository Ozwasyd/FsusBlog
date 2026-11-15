-- Fixed v1 PostgreSQL DDL from 20260629-post-taxonomy-count-projection.
CREATE TABLE category_public_article_count (
    category_id integer PRIMARY KEY,
    article_count bigint NOT NULL DEFAULT 0,
    updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE TABLE tag_public_article_count (
    tag_id integer PRIMARY KEY,
    article_count bigint NOT NULL DEFAULT 0,
    updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);
CREATE TABLE article_public_taxonomy_projection (
    article_id integer PRIMARY KEY,
    category_id integer NULL,
    tag_ids text NOT NULL DEFAULT '',
    updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
);

-- V1 reconciles the visible article's current taxonomy and leaves zero rows after decrements.
INSERT INTO category_public_article_count VALUES
    (11,0,'2026-10-03 00:00:00.000001'), (12,1,'2026-10-03 00:00:00.000002');
INSERT INTO tag_public_article_count VALUES
    (21,0,'2026-10-03 00:00:00.000003'), (22,1,'2026-10-03 00:00:00.000004'), (23,1,'2026-10-03 00:00:00.000005');
INSERT INTO article_public_taxonomy_projection VALUES (42,12,'22,23','2026-10-03 00:00:00.000006');
