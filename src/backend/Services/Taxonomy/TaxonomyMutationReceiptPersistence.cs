using System.Buffers.Binary;
using System.Collections.Immutable;
using System.Text.Json;

using Npgsql;

using SqlSugar;

using ArticleSourceGenerationAuthority = FsusBlog.Server.Services.Articles.ArticleSourceGenerationAuthority;
using ArticleSourceGenerationPersistence = FsusBlog.Server.Services.Articles.ArticleSourceGenerationPersistence;

namespace FsusBlog.Server.Services.Taxonomy;

/// <summary>
/// Captures original taxonomy facts before DML and persists immutable receipts before the
/// original owner commits. Borrows its native transaction; never allocates source counters.
/// The original DML owner declares the operation and supplies its native result; this is not
/// a SQL-statement auditor. The owner rolls back a failed mutation scope, including receipts,
/// to its savepoint or original transaction boundary. Live same-transaction savepoints are supported.
/// </summary>
public static class TaxonomyMutationReceiptPersistence
{
    public enum TargetKind
    {
        Category,
        Tag
    }

    public enum MutationOperation
    {
        Create,
        Update,
        Delete
    }

    /// <summary>The actual persisted identity, including the description before physical deletion.</summary>
    public sealed record Identity(int Id, string Name, string? Description);

    /// <summary>Transaction-local until commit; affected IDs come from original article/link rows.</summary>
    public sealed record Receipt(Guid ReceiptId, TargetKind Kind, MutationOperation Operation,
        int TargetId, Identity? Before, Identity? After, ImmutableArray<int> AffectedArticleIds);

    /// <summary>Opaque capture bound to one exact client and native transaction.</summary>
    public sealed class Capture
    {
        internal Capture(ISqlSugarClient db, NpgsqlTransaction transaction, TargetKind kind,
            MutationOperation operation, Identity? before, string? createName, ImmutableArray<int> articleIds)
        {
            Db = db;
            Transaction = transaction;
            Kind = kind;
            Operation = operation;
            Before = before;
            CreateName = createName;
            ArticleIds = articleIds;
        }

        internal Guid ReceiptId { get; } = Guid.NewGuid();
        internal long LockKey => BinaryPrimitives.ReadInt64BigEndian(ReceiptId.ToByteArray());
        internal ISqlSugarClient Db
        {
            get;
        }
        internal NpgsqlTransaction Transaction
        {
            get;
        }
        internal TargetKind Kind
        {
            get;
        }
        internal MutationOperation Operation
        {
            get;
        }
        internal Identity? Before
        {
            get;
        }
        internal string? CreateName
        {
            get;
        }
        internal ImmutableArray<int> ArticleIds
        {
            get;
        }
    }

    /// <summary>
    /// Supply the identity and affected-row count returned by the exact original DML paired
    /// with this capture. The trusted owner must match its actual INSERT/UPDATE/DELETE kind;
    /// native writer ownership and before/after facts cannot authenticate the SQL statement kind.
    /// </summary>
    public sealed record Completion(Capture Capture, int TargetId, int AffectedRows);

    /// <summary>
    /// Call before the original insert. The intended unique name must be absent. The returned
    /// ID is supplied only after the insert; no identity or deleted-row tombstone is invented.
    /// Acquires the existing family lock before any taxonomy row locks.
    /// The trusted original owner must pair this capture only with its actual INSERT into the
    /// declared table, use that INSERT's native returned ID and affected-row count, and persist
    /// before ending its mutation scope. Pairing an UPDATE of an existing row with this capture
    /// violates the caller contract even if it writes the intended name in the same transaction:
    /// the producer verifies native writer ownership, not INSERT provenance. No claim about an
    /// untrusted caller's statement kind follows from a create receipt's null Before value.
    /// </summary>
    public static async Task<Capture> CaptureCreateAsync(ISqlSugarClient db, TargetKind kind,
        string name, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        string table = Table(kind);
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db, cancellationToken).ConfigureAwait(false);
        (NpgsqlConnection connection, NpgsqlTransaction transaction) = ArticleSourceGenerationAuthority.RequireTransaction(db);
        await using NpgsqlCommand command = new($"SELECT EXISTS (SELECT 1 FROM {table} WHERE name = @Name);",
            connection, transaction);
        command.Parameters.AddWithValue("Name", name);
        if ((bool)(await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false))!)
        {
            throw new InvalidOperationException("taxonomy_receipt_create_identity_exists");
        }
        return await ProtectCaptureAsync(new Capture(db, transaction, kind, MutationOperation.Create, null, name, []),
            connection, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Call before update/delete. Locks and captures the real target and all linked article IDs
    /// on the original native transaction. Missing targets cannot produce deletion receipts.
    /// The trusted owner must execute the declared operation on this exact captured target;
    /// recreating or substituting it is outside this contract.
    /// </summary>
    public static async Task<Capture> CaptureExistingAsync(ISqlSugarClient db, TargetKind kind,
        MutationOperation operation, int targetId, CancellationToken cancellationToken = default)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(targetId);
        _ = Table(kind);
        if (operation is not (MutationOperation.Update or MutationOperation.Delete))
        {
            throw new ArgumentOutOfRangeException(nameof(operation));
        }
        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(db, cancellationToken).ConfigureAwait(false);
        (NpgsqlConnection connection, NpgsqlTransaction transaction) = ArticleSourceGenerationAuthority.RequireTransaction(db);
        Identity before = await ReadIdentityAsync(connection, transaction, kind, targetId, cancellationToken)
            .ConfigureAwait(false) ?? throw new InvalidOperationException("taxonomy_receipt_target_missing");
        ImmutableArray<int> articleIds = await ReadArticleIdsAsync(connection, transaction, kind, targetId, cancellationToken)
            .ConfigureAwait(false);
        return await ProtectCaptureAsync(new Capture(db, transaction, kind, operation, before, null, articleIds),
            connection, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Persist the trusted owner's paired original DML result before enrollment and commit.
    /// DML and receipts may use active or released savepoints of the same native transaction.
    /// </summary>
    public static async Task<Receipt> PersistAsync(ISqlSugarClient db, Capture capture,
        int targetId, int affectedRows, CancellationToken cancellationToken = default)
        => (await PersistBatchAsync(db, [new Completion(capture, targetId, affectedRows)], cancellationToken)
            .ConfigureAwait(false))[0];

    /// <summary>
    /// Validates the complete batch before one atomic INSERT. Repeating an unchanged capture
    /// returns the same receipt; changed facts or duplicate captures fail closed. Rollback also
    /// rolls back receipts; a retried transaction must take fresh captures.
    /// A capture retained before a savepoint may be reused after rolling back that savepoint's
    /// DML and receipts; rolling back past capture acquisition invalidates the capture itself.
    /// </summary>
    public static async Task<ImmutableArray<Receipt>> PersistBatchAsync(ISqlSugarClient db,
        IReadOnlyList<Completion> completions, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(completions);
        cancellationToken.ThrowIfCancellationRequested();
        (NpgsqlConnection connection, NpgsqlTransaction transaction) = ArticleSourceGenerationAuthority.RequireTransaction(db);
        if (completions.Count == 0)
        {
            throw new InvalidOperationException("taxonomy_receipt_empty_batch");
        }
        var seen = new HashSet<Guid>();
        var targets = new HashSet<(TargetKind, int)>();
        var receipts = ImmutableArray.CreateBuilder<Receipt>(completions.Count);
        foreach (Completion completion in completions)
        {
            ArgumentNullException.ThrowIfNull(completion);
            Capture capture = completion.Capture ?? throw new ArgumentException("A capture is required.", nameof(completions));
            if (!ReferenceEquals(capture.Db, db) || !ReferenceEquals(capture.Transaction, transaction))
            {
                throw new InvalidOperationException("taxonomy_receipt_transaction_owner_mismatch");
            }
            if (completion.AffectedRows != 1 || completion.TargetId <= 0
                || !seen.Add(capture.ReceiptId) || !targets.Add((capture.Kind, completion.TargetId))
                || (capture.Before is not null && capture.Before.Id != completion.TargetId))
            {
                throw new InvalidOperationException("taxonomy_receipt_dml_result_invalid");
            }
            await ArticleSourceGenerationPersistence.RequireLockAsync(connection, transaction, cancellationToken)
                .ConfigureAwait(false);
            await using (NpgsqlCommand captureLock = new("""
                SELECT EXISTS (SELECT 1 FROM pg_locks
                    WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted
                        AND mode = 'ExclusiveLock' AND objsubid = 1
                        AND classid = ((@Key::bigint >> 32) & 4294967295)::oid
                        AND objid = (@Key::bigint & 4294967295)::oid);
                """, connection, transaction))
            {
                captureLock.Parameters.AddWithValue("Key", capture.LockKey);
                if (await captureLock.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) is not true)
                {
                    throw new InvalidOperationException("taxonomy_receipt_capture_rolled_back");
                }
            }
            Identity? after = await ReadIdentityAsync(connection, transaction, capture.Kind, completion.TargetId, cancellationToken)
                .ConfigureAwait(false);
            if ((capture.Operation == MutationOperation.Delete && after is not null)
                || (capture.Operation != MutationOperation.Delete && after is null)
                || (capture.Operation == MutationOperation.Create && after!.Name != capture.CreateName)
                || capture.Before == after)
            {
                throw new InvalidOperationException("taxonomy_receipt_no_actual_mutation");
            }
            if (after is not null)
            {
                // A visible row with an in-progress writer belongs to this native transaction
                // or its live/subcommitted children; another transaction's pending row is invisible.
                // Reconstruct the writer's full XID near the root XID across 32-bit wraparound.
                // This authenticates writer ownership, never INSERT kind, a cursor or a counter.
                await using NpgsqlCommand ownership = new($"""
                    WITH root AS (SELECT pg_current_xact_id()::text::numeric AS xid),
                    writer AS (
                        SELECT root.xid + mod(taxonomy.xmin::text::numeric - mod(root.xid, 4294967296)
                            + 6442450944, 4294967296) - 2147483648 AS xid
                        FROM {Table(capture.Kind)} taxonomy CROSS JOIN root WHERE taxonomy.id = @Id
                    )
                    SELECT pg_xact_status(writer.xid::text::xid8) = 'in progress' FROM writer;
                    """, connection, transaction);
                ownership.Parameters.AddWithValue("Id", completion.TargetId);
                if (await ownership.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) is not true)
                {
                    throw new InvalidOperationException("taxonomy_receipt_original_dml_required");
                }
            }
            ImmutableArray<int> afterIds = await ReadArticleIdsAsync(connection, transaction, capture.Kind,
                completion.TargetId, cancellationToken).ConfigureAwait(false);
            receipts.Add(new Receipt(capture.ReceiptId, capture.Kind, capture.Operation, completion.TargetId,
                capture.Before, after, capture.ArticleIds.Concat(afterIds).Distinct().Order().ToImmutableArray()));
        }
        string[] facts = receipts.Select(static receipt => JsonSerializer.Serialize(new
        {
            receipt.ReceiptId,
            Kind = receipt.Kind == TargetKind.Category ? "category" : "tag",
            Operation = receipt.Operation.ToString().ToLowerInvariant(),
            receipt.TargetId,
            receipt.Before,
            receipt.After,
            receipt.AffectedArticleIds
        })).ToArray();
        // One statement makes a late conflict roll back every insert in this batch.
        // Exact replays are filtered; different facts with the same key fail uniqueness.
        await using NpgsqlCommand insert = new("""
            INSERT INTO taxonomy_mutation_receipt
                (receipt_id, target_kind, operation, target_id, before_identity, after_identity,
                 affected_article_ids, receipt_facts)
            SELECT (fact->>'ReceiptId')::uuid, lower(fact->>'Kind'), lower(fact->>'Operation'),
                (fact->>'TargetId')::integer, NULLIF(fact->'Before', 'null'::jsonb),
                NULLIF(fact->'After', 'null'::jsonb),
                ARRAY(SELECT jsonb_array_elements_text(fact->'AffectedArticleIds')::integer), fact::text
            FROM (SELECT raw::jsonb AS fact FROM unnest(@Facts::text[]) raw) incoming
            WHERE NOT EXISTS (SELECT 1 FROM taxonomy_mutation_receipt existing
                WHERE existing.receipt_id = (fact->>'ReceiptId')::uuid AND existing.receipt_facts::jsonb = fact);
            """, connection, transaction);
        insert.Parameters.AddWithValue("Facts", facts);
        await insert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        return receipts.MoveToImmutable();
    }

    private static string Table(TargetKind kind) => kind switch
    {
        TargetKind.Category => "category",
        TargetKind.Tag => "tag",
        _ => throw new ArgumentOutOfRangeException(nameof(kind))
    };

    private static async Task<Capture> ProtectCaptureAsync(Capture capture, NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        // A private transaction lock makes a capture unusable after rolling back past its
        // row locks, even if the original family lock is subsequently acquired again.
        await using NpgsqlCommand command = new("SELECT pg_advisory_xact_lock(@Key::bigint);", connection, capture.Transaction);
        command.Parameters.AddWithValue("Key", capture.LockKey);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        return capture;
    }

    private static async Task<Identity?> ReadIdentityAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        TargetKind kind, int targetId, CancellationToken cancellationToken)
    {
        await using NpgsqlCommand command = new(
            $"SELECT id, name, description FROM {Table(kind)} WHERE id = @Id FOR UPDATE;", connection, transaction);
        command.Parameters.AddWithValue("Id", targetId);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? new Identity(reader.GetInt32(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2))
            : null;
    }

    private static async Task<ImmutableArray<int>> ReadArticleIdsAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        TargetKind kind, int targetId, CancellationToken cancellationToken)
    {
        string sql = kind == TargetKind.Category
            ? "SELECT id FROM article WHERE categoryid = @Id ORDER BY id;"
            : "SELECT DISTINCT articleid FROM article_tag WHERE tagid = @Id ORDER BY articleid;";
        await using NpgsqlCommand command = new(sql, connection, transaction);
        command.Parameters.AddWithValue("Id", targetId);
        var ids = ImmutableArray.CreateBuilder<int>();
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            int id = reader.GetInt32(0);
            ArgumentOutOfRangeException.ThrowIfNegativeOrZero(id);
            ids.Add(id);
        }
        return ids.ToImmutable();
    }
}
