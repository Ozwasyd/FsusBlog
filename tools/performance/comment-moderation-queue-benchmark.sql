\set ON_ERROR_STOP on
\if :{?scale}
\else
\echo 'usage: psql -v scale=100000 -f tools/performance/comment-moderation-queue-benchmark.sql'
\quit
\endif

SET jit = off;
SET work_mem = '64MB';
SET max_parallel_workers_per_gather = 0;

CREATE UNLOGGED TABLE comment_moderation_bench (
    id bigint PRIMARY KEY,
    create_time timestamp without time zone NOT NULL,
    moderation_status integer NOT NULL,
    moderation_reason varchar(256) NULL,
    is_deleted boolean NOT NULL DEFAULT false
);
CREATE UNLOGGED TABLE comment_report_bench (
    id bigint PRIMARY KEY,
    comment_id bigint NOT NULL,
    risk_score integer NOT NULL,
    status varchar(24) NOT NULL,
    created_at_utc timestamp without time zone NOT NULL
);
CREATE UNLOGGED TABLE comment_author_appeal_bench (
    id bigint PRIMARY KEY,
    comment_id bigint NOT NULL,
    status varchar(24) NOT NULL,
    created_at_utc timestamp without time zone NOT NULL
);
CREATE UNLOGGED TABLE comment_moderation_claim_bench (
    comment_id bigint PRIMARY KEY,
    owner_admin_principal_id bigint NOT NULL,
    state varchar(16) NOT NULL,
    lease_expires_at_utc timestamp without time zone NOT NULL,
    claim_generation integer NOT NULL
);

INSERT INTO comment_moderation_bench(id, create_time, moderation_status, moderation_reason)
SELECT
    id,
    timestamp '2026-07-20 00:00:00' - (id * interval '1 second'),
    CASE WHEN id % 100 = 0 THEN 0 WHEN id % 250 = 0 THEN 3 ELSE 1 END,
    CASE WHEN id % 250 = 0 THEN 'model_policy:model_risk_borderline_review' ELSE NULL END
FROM generate_series(1, :scale) id;

INSERT INTO comment_report_bench(id, comment_id, risk_score, status, created_at_utc)
SELECT id, id * 1000, (id % 1000)::integer, 'open', timestamp '2026-07-19 00:00:00' - (id * interval '1 second')
FROM generate_series(1, GREATEST(1, :scale / 1000)) id;

INSERT INTO comment_author_appeal_bench(id, comment_id, status, created_at_utc)
SELECT id, id * 10000, 'pending', timestamp '2026-07-18 00:00:00' - (id * interval '1 second')
FROM generate_series(1, GREATEST(1, :scale / 10000)) id;

CREATE INDEX idx_comment_moderation_queue_pending_bench
    ON comment_moderation_bench(create_time, id)
    WHERE is_deleted = false
      AND (moderation_status = 0 OR moderation_reason = 'model_policy:model_risk_borderline_review');
CREATE INDEX idx_comment_report_queue_bench
    ON comment_report_bench(status, risk_score DESC, created_at_utc, id);
CREATE INDEX idx_comment_report_comment_bench ON comment_report_bench(comment_id);
CREATE INDEX idx_comment_author_appeal_pending_queue_bench
    ON comment_author_appeal_bench(status, created_at_utc, comment_id)
    WHERE status = 'pending';
CREATE INDEX idx_comment_author_appeal_comment_bench ON comment_author_appeal_bench(comment_id, created_at_utc DESC);
CREATE INDEX idx_comment_moderation_claim_lease_bench
    ON comment_moderation_claim_bench(state, lease_expires_at_utc, comment_id);
ANALYZE comment_moderation_bench;
ANALYZE comment_report_bench;
ANALYZE comment_author_appeal_bench;
ANALYZE comment_moderation_claim_bench;

CREATE VIEW moderation_queue_page_bench AS
WITH report_priority AS (
    SELECT comment_id, MAX(risk_score)::integer AS risk_score, MIN(created_at_utc) AS first_reported_at_utc
    FROM comment_report_bench WHERE status IN ('open', 'reviewing') GROUP BY comment_id
), appeal_priority AS (
    SELECT comment_id, MIN(created_at_utc) AS first_appealed_at_utc
    FROM comment_author_appeal_bench WHERE status = 'pending' GROUP BY comment_id
), appeal_queue AS (
    SELECT c.id AS comment_id, 2::integer AS appeal_priority,
           COALESCE(report.risk_score, 0)::integer AS risk_score,
           LEAST(c.create_time, COALESCE(report.first_reported_at_utc, c.create_time), appeal.first_appealed_at_utc) AS waiting_since_utc
    FROM comment_moderation_bench c
    INNER JOIN appeal_priority appeal ON appeal.comment_id = c.id
    LEFT JOIN report_priority report ON report.comment_id = c.id
    WHERE c.is_deleted = false
    ORDER BY risk_score DESC, waiting_since_utc, comment_id
    LIMIT 51
), report_queue AS (
    SELECT c.id AS comment_id, 1::integer AS appeal_priority, report.risk_score,
           LEAST(c.create_time, report.first_reported_at_utc) AS waiting_since_utc
    FROM report_priority report
    INNER JOIN comment_moderation_bench c ON c.id = report.comment_id
    LEFT JOIN appeal_priority appeal ON appeal.comment_id = c.id
    WHERE c.is_deleted = false AND appeal.comment_id IS NULL
    ORDER BY risk_score DESC, waiting_since_utc, comment_id
    LIMIT 51
), ordinary_queue AS (
    SELECT c.id AS comment_id, 0::integer AS appeal_priority, 0::integer AS risk_score,
           c.create_time AS waiting_since_utc
    FROM comment_moderation_bench c
    WHERE c.is_deleted = false
      AND (c.moderation_status = 0 OR c.moderation_reason = 'model_policy:model_risk_borderline_review')
      AND NOT EXISTS (SELECT 1 FROM report_priority report WHERE report.comment_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM appeal_priority appeal WHERE appeal.comment_id = c.id)
    ORDER BY waiting_since_utc, comment_id
    LIMIT 51
)
SELECT * FROM (
    SELECT * FROM appeal_queue
    UNION ALL SELECT * FROM report_queue
    UNION ALL SELECT * FROM ordinary_queue
) queue
ORDER BY appeal_priority DESC, risk_score DESC, waiting_since_utc, comment_id
LIMIT 51;

CREATE TEMP TABLE queue_latency(sample integer PRIMARY KEY, elapsed_ms double precision NOT NULL);
DO $benchmark$
DECLARE
    started_at timestamptz;
    sample_no integer;
BEGIN
    FOR sample_no IN 1..100 LOOP
        started_at := clock_timestamp();
        PERFORM * FROM moderation_queue_page_bench;
        INSERT INTO queue_latency VALUES (
            sample_no,
            EXTRACT(epoch FROM clock_timestamp() - started_at) * 1000.0);
    END LOOP;
END
$benchmark$;

SELECT :scale AS scale,
       ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 3) AS p50_ms,
       ROUND(percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 3) AS p95_ms,
       ROUND(percentile_cont(0.99) WITHIN GROUP (ORDER BY elapsed_ms)::numeric, 3) AS p99_ms,
       ROUND(AVG(elapsed_ms)::numeric, 3) AS average_ms
FROM queue_latency;

EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
SELECT * FROM moderation_queue_page_bench;

SELECT pg_size_pretty(pg_relation_size('idx_comment_moderation_queue_pending_bench')) AS pending_index_size,
       pg_size_pretty(pg_relation_size('idx_comment_author_appeal_pending_queue_bench')) AS appeal_index_size;

DROP VIEW moderation_queue_page_bench;
DROP TABLE comment_moderation_claim_bench;
DROP TABLE comment_author_appeal_bench;
DROP TABLE comment_report_bench;
DROP TABLE comment_moderation_bench;
