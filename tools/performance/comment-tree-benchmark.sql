\set ON_ERROR_STOP on
SET jit = off;
SET work_mem = '64MB';

CREATE UNLOGGED TABLE comment_tree_bench (
    id bigint PRIMARY KEY,
    article_id integer NOT NULL,
    parent_id bigint NULL,
    root_id bigint NULL,
    depth integer NOT NULL,
    moderation_status integer NOT NULL DEFAULT 1,
    is_deleted boolean NOT NULL DEFAULT false
);

INSERT INTO comment_tree_bench (id, article_id, parent_id, root_id, depth)
SELECT root_id, 1, NULL, NULL, 0
FROM generate_series(1, 5000) AS root_id;

INSERT INTO comment_tree_bench (id, article_id, parent_id, root_id, depth)
SELECT 10000 + ((root_id - 1) * 199) + child_no, 1, root_id, root_id, 1
FROM generate_series(1, 5000) AS root_id
CROSS JOIN generate_series(1, 199) AS child_no;

INSERT INTO comment_tree_bench (id, article_id, parent_id, root_id, depth)
SELECT
    2000000 + depth,
    2,
    CASE WHEN depth = 0 THEN NULL ELSE 2000000 + depth - 1 END,
    CASE WHEN depth = 0 THEN NULL ELSE 2000000 END,
    depth
FROM generate_series(0, 1000) AS depth;

CREATE INDEX idx_comment_tree_article_parent_id
    ON comment_tree_bench (article_id, parent_id, id);
CREATE INDEX idx_comment_tree_article_root_id
    ON comment_tree_bench (article_id, root_id, id);
ANALYZE comment_tree_bench;

SELECT 'roots_cursor';
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
SELECT id
FROM comment_tree_bench
WHERE article_id = 1
  AND parent_id IS NULL
  AND moderation_status = 1
  AND is_deleted = false
  AND id < 5001
ORDER BY id DESC
LIMIT 51;

SELECT 'direct_children_cursor';
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
WITH page AS MATERIALIZED (
    SELECT id, parent_id, root_id, depth
    FROM comment_tree_bench
    WHERE article_id = 1
      AND parent_id = 2500
      AND moderation_status = 1
      AND is_deleted = false
      AND id > 0
    ORDER BY id
    LIMIT 101
), child_counts AS (
    SELECT child.parent_id, COUNT(*) AS child_count
    FROM comment_tree_bench child
    WHERE child.article_id = 1
      AND child.parent_id IN (SELECT id FROM page)
    GROUP BY child.parent_id
)
SELECT page.*, COALESCE(child_counts.child_count, 0)
FROM page
LEFT JOIN child_counts ON child_counts.parent_id = page.id
ORDER BY page.id;

SELECT 'ancestor_path_depth_1000';
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
WITH RECURSIVE ancestor_path AS (
    SELECT id, parent_id, root_id, depth
    FROM comment_tree_bench
    WHERE article_id = 2 AND id = 2001000
    UNION ALL
    SELECT parent.id, parent.parent_id, parent.root_id, parent.depth
    FROM comment_tree_bench parent
    INNER JOIN ancestor_path child ON child.parent_id = parent.id
    WHERE parent.article_id = 2
)
SELECT * FROM ancestor_path ORDER BY depth;

SELECT 'permalink_sibling_window';
EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
(
    SELECT id, parent_id, root_id, depth
    FROM comment_tree_bench
    WHERE article_id = 1 AND parent_id = 2500 AND id < 507400
    ORDER BY id DESC
    LIMIT 5
)
UNION ALL
(
    SELECT id, parent_id, root_id, depth
    FROM comment_tree_bench
    WHERE article_id = 1 AND parent_id = 2500 AND id >= 507400
    ORDER BY id
    LIMIT 6
)
ORDER BY id;

DROP TABLE comment_tree_bench;
