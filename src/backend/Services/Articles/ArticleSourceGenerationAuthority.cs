using System.Data;
using System.Runtime.CompilerServices;
using System.Text.Json;

using Npgsql;

using SqlSugar;

using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Services.Articles;

/// <summary>
/// Sole producer of persistent numeric article source counters. Owners acquire the family
/// lock before article/advisory locks or mutations, enroll each inserted original outbox
/// event before commit, and retain all transaction, lifecycle and publication ownership.
/// </summary>
public static class ArticleSourceGenerationAuthority
{
    // One PostgreSQL advisory namespace for this canonical family, independent of caller.
    internal const int LockNamespace = 1179866444;
    internal const int LockKey = 1;
    private static readonly ConditionalWeakTable<NpgsqlTransaction, LockOwner> s_locks = new();

    /// <summary>Zero-write read; null means no persisted clock/schema, never a verified baseline.</summary>
    public static Task<long?> ReadGenerationAsync(
        ISqlSugarClient db, CancellationToken cancellationToken = default)
        => ArticleSourceGenerationPersistence.ReadGenerationAsync(db, cancellationToken);

    /// <summary>Zero-write read of one persisted article sequence and its current family generation.</summary>
    public static Task<ArticleSourceCursor?> ReadArticleCursorAsync(
        ISqlSugarClient db, int articleId, CancellationToken cancellationToken = default)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(articleId);
        return ArticleSourceGenerationPersistence.ReadArticleCursorAsync(db, articleId, cancellationToken);
    }

    /// <summary>
    /// Borrows an already live native ReadCommitted PostgreSQL transaction. Never begins,
    /// commits or closes it. Call at the transaction boundary before the first article lock
    /// or write, including multi-article groups. No counters are created by acquisition.
    /// </summary>
    public static async Task AcquireMutationLockAsync(
        ISqlSugarClient db, CancellationToken cancellationToken = default)
    {
        (NpgsqlConnection connection, NpgsqlTransaction transaction) = RequireTransaction(db);
        cancellationToken.ThrowIfCancellationRequested();
        await using NpgsqlCommand command = new(
            "SELECT pg_advisory_xact_lock(@Namespace, @Key);", connection, transaction);
        command.Parameters.AddWithValue("Namespace", LockNamespace);
        command.Parameters.AddWithValue("Key", LockKey);
        await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        RequireTransaction(db);
        LockOwner owner = s_locks.GetValue(transaction, _ => new LockOwner(db));
        if (!ReferenceEquals(owner.Db, db))
        {
            throw new InvalidOperationException("article_source_lock_owner_mismatch");
        }
    }

    /// <summary>
    /// Reads the actual inserted event on the same connection/transaction, validates the
    /// original envelope and immutable ownership, and atomically enrolls counters/journal.
    /// Replays return their original cursor. Exceptions require the original owner to
    /// roll back its mutation transaction; this method never publishes an uncommitted cursor.
    /// </summary>
    public static async Task<ArticleSourceCursor> RecordMutationAsync(
        ISqlSugarClient db, string eventId, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(eventId);
        (NpgsqlConnection connection, NpgsqlTransaction transaction) = RequireTransaction(db);
        cancellationToken.ThrowIfCancellationRequested();
        if (!s_locks.TryGetValue(transaction, out LockOwner? owner) || !ReferenceEquals(owner.Db, db))
        {
            throw new InvalidOperationException("article_source_mutation_lock_required");
        }
        // A savepoint rollback may have released a lock acquired after that savepoint.
        await ArticleSourceGenerationPersistence.RequireLockAsync(connection, transaction, cancellationToken)
            .ConfigureAwait(false);
        ArticleMutationOutboxEvent item = await ArticleSourceGenerationPersistence.ReadEventAsync(
            connection, transaction, eventId, cancellationToken).ConfigureAwait(false);
        ValidateEvent(item);
        string facts = JsonSerializer.Serialize(new
        {
            item.Id,
            item.EventId,
            item.AggregateType,
            item.AggregateId,
            item.SchemaVersion,
            item.EventType,
            item.ArticleRevisionId,
            item.RevisionNo,
            item.RightsSnapshotId,
            item.ResponsibilitySnapshotId,
            item.ResponsibilityVersion,
            item.ArticlePublicationId,
            item.PublicationNo,
            item.PayloadJson,
            item.CreatedAt
        });
        ArticleSourceCursor? replay = await ArticleSourceGenerationPersistence.ReadEnrollmentAsync(
            connection, transaction, item, facts, cancellationToken).ConfigureAwait(false);
        if (replay is not null)
        {
            return replay;
        }
        await ArticleSourceGenerationPersistence.RequireCoordinatesAsync(
            connection, transaction, item, cancellationToken).ConfigureAwait(false);
        RequireTransaction(db);
        return await ArticleSourceGenerationPersistence.AllocateAsync(
            connection, transaction, item, facts, cancellationToken).ConfigureAwait(false);
    }

    internal static (NpgsqlConnection Connection, NpgsqlTransaction Transaction) RequireTransaction(ISqlSugarClient db)
    {
        NpgsqlConnection connection = ArticleSourceGenerationPersistence.RequireConnection(db);
        if (connection.State != ConnectionState.Open
            || db.Ado.Transaction is not NpgsqlTransaction transaction
            || !ReferenceEquals(transaction.Connection, connection))
        {
            throw new InvalidOperationException("article_source_live_native_transaction_required");
        }
        // ReadCommitted obtains the clock state after a contending writer commits. Original
        // owners must select this isolation, or use their existing serialization/retry path.
        if (transaction.IsolationLevel != IsolationLevel.ReadCommitted)
        {
            throw new InvalidOperationException("article_source_transaction_isolation_unsupported");
        }
        return (connection, transaction);
    }

    internal static void ValidateEvent(ArticleMutationOutboxEvent item)
    {
        if (item.Id <= 0 || item.AggregateId <= 0 || !Guid.TryParseExact(item.EventId, "N", out Guid eventId)
            || eventId == Guid.Empty || item.AggregateType != "article"
            || item.SchemaVersion != ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion
            || !ArticleMutationEventTypes.All.Contains(item.EventType))
        {
            throw new InvalidOperationException("article_source_event_unsupported");
        }
        ArticleMutationOutboxEnvelope envelope = ArticleMutationOutboxEnvelopeCodec.Read(item);
        if (item.ArticleRevisionId is not > 0 || item.RevisionNo is not > 0 || item.RightsSnapshotId is <= 0
            || (item.RightsSnapshotId is null
                && (item.EventType != ArticleMutationEventTypes.Created
                    || item.ArticlePublicationId.HasValue || item.ResponsibilitySnapshotId.HasValue
                    || envelope.Scope.After?.Visibility != "draft"))
            || (item.ArticlePublicationId.HasValue != item.PublicationNo.HasValue)
            || item.ArticlePublicationId is <= 0 || item.PublicationNo is <= 0
            || (item.ResponsibilityVersion.HasValue && !item.ResponsibilitySnapshotId.HasValue)
            || item.ResponsibilitySnapshotId is <= 0 || item.ResponsibilityVersion is <= 0
            || envelope.Version.RevisionId != item.ArticleRevisionId
            || envelope.Version.RevisionNo != item.RevisionNo
            || envelope.Version.RightsSnapshotId != item.RightsSnapshotId
            || envelope.Version.PublicationId != item.ArticlePublicationId
            || envelope.Version.PublicationNo != item.PublicationNo
            || envelope.Version.ResponsibilitySnapshotId != item.ResponsibilitySnapshotId
            || envelope.Version.ResponsibilityVersion != item.ResponsibilityVersion)
        {
            throw new InvalidOperationException("article_source_event_coordinates_invalid");
        }
    }

    private sealed record LockOwner(ISqlSugarClient Db);
}
