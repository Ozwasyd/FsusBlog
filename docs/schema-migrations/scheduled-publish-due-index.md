# Scheduled publish due index

Issue #1223 adds a PostgreSQL partial index for the worker path that promotes
scheduled articles. The worker now builds both its candidate query and its
locking claim query from the same two due branches:

- `status = Scheduled`, ordered by `(scheduled_publish_at, id)`;
- `status = Published` with a pending revision, ordered by
  `(pending_publication_at, id)`.

The second branch already has `idx_article_pending_publication_due`. The new
`idx_article_scheduled_publish_due_v2` covers the first branch and excludes
deleted or non-scheduled rows:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_article_scheduled_publish_due_v2
ON article(scheduled_publish_at, id)
WHERE isdeleted = false
  AND status = 1
  AND scheduled_publish_at IS NOT NULL;
```

## Local evidence

`ScheduledPublishWorkerTests` creates a fixed PostgreSQL distribution with
50,000 ordinary published rows, 20,000 future scheduled rows, 1,000 deleted due
rows, and 105 live due rows. It captures `EXPLAIN (ANALYZE, BUFFERS, FORMAT
JSON)` before and after the index is installed and requires all of the
following:

- the baseline does not use the dedicated due index (it may use a broader
  status/time index depending on the PostgreSQL version and cost model);
- the indexed plan names `idx_article_scheduled_publish_due_v2`;
- the five-run warmed median execution time is lower than the baseline under
  the default planner with JIT disabled for measurement stability;
- the partial index is smaller than the `article` heap;
- 105 due rows are published once across concurrent workers and a drain pass;
- an empty follow-up pass produces no duplicate Outbox event.

The fixture is deterministic evidence for plan shape and relative local cost;
it is not a production latency claim.

## Write and operations trade-offs

The index adds one entry only while an article is non-deleted and scheduled.
Ordinary drafts, published rows, archived rows, deleted rows, and pending
published revisions do not add entries to this index. Scheduling, rescheduling,
publishing, and deleting an eligible article therefore add, move, or remove one
small B-tree entry. PostgreSQL vacuum reclaims obsolete entries normally; index
size and dead tuples should be inspected during routine database maintenance.

The older `idx_article_scheduled_publish(status, scheduled_publish_at)` remains
for N-1 compatibility and rollback safety, so an eligible scheduled row
temporarily maintains both entries. Removing the older index is separate
Contract work after the new plan has accumulated release evidence; this Expand
migration does not hide that write cost behind an immediate destructive drop.

The migration is non-transactional because PostgreSQL forbids `CONCURRENTLY`
inside a transaction. `CREATE INDEX CONCURRENTLY` avoids blocking normal table
writes, while the migration runner and checksum history still fail closed if
the command does not complete.

## Rollback

The old query remains correct without the index, so rollback is online and does
not require an application restart:

```sql
DROP INDEX CONCURRENTLY IF EXISTS idx_article_scheduled_publish_due_v2;
```

Dropping the index only returns the due scan to its previous plan; it does not
change article state, scheduling semantics, Outbox delivery, or public
artifacts.
