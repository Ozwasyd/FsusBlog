using System.Collections.Immutable;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

using Npgsql;

using NpgsqlTypes;

namespace FsusBlog.Server.Services;

/// <summary>Original read models and persisted MVCC/actor/article facts only; no Query generation or live session grant.</summary>
internal sealed record ArticlePropertyValueNativeBatch(
    ArticlePropertyDefinitionOwner Owner, ArticlePropertyDefinitionActor Actor,
    ArticlePropertyNativeSnapshotObservation NativeSnapshot,
    ImmutableArray<ArticlePropertyValueNativeArticle> ArticleFacts,
    ImmutableArray<ArticlePropertyValueReadModel> Articles);

internal sealed record ArticlePropertyValueNativeArticle(int ArticleId, long ArticleRevisionId, ArticleStatus Status, bool IsDeleted);

public partial class ArticleService
{
    internal const int PropertyNativeBatchArticleLimit = 64;
    private const int PropertyNativeBatchEntryLimit = 4096;

    /// <summary>
    /// Reads the whole held article set through the original value/definition owners in one
    /// caller-owned native snapshot. Never calls standalone ReadAsync or starts/commits a transaction.
    /// Existing original permissions and reconciliation are preserved; the caller independently owns
    /// live session admission and any Query generation/document/parser/range binding.
    /// </summary>
    internal async Task<ArticlePropertyValueNativeBatch> ReadPropertyValuesInNativeSnapshotAsync(
        NpgsqlTransaction originalTransaction, long actorAdminPrincipalId, ArticlePropertyDefinitionOwner owner,
        IReadOnlyList<int> articleIds, CancellationToken cancellationToken)
    {
        ImmutableArray<int> ids = CapturePropertyNativeBatchIds(articleIds);
        ArticlePropertyValuePersistence values = RequirePropertyPersistence();
        if (_articlePropertyDefinitions is not ArticlePropertyDefinitionStore definitions)
            throw new ArticlePropertyDefinitionIntegrityException("article_property_definition_native_snapshot_unavailable");
        void RequireParticipants()
        {
            ArticlePropertyNativeSnapshotRead.Require(_db, originalTransaction);
            values.RequireOriginalNativeSnapshot(originalTransaction);
            definitions.RequireOriginalNativeSnapshot(originalTransaction);
        }
        RequireParticipants();
        ArticlePropertyNativeSnapshotObservation snapshot = await ArticlePropertyNativeSnapshotRead.ObserveAsync(
            _db, originalTransaction, cancellationToken).ConfigureAwait(false);
        RequireParticipants();
        if (snapshot.ReadOnly)
            throw new ArticlePropertyDefinitionIntegrityException("article_property_native_read_locks_require_readwrite_snapshot");
        // Reuse original live-context and persisted actor/definition-owner checks, not another authority.
        ArticlePropertyDefinitionActor actor = await LockPropertyActorAsync(actorAdminPrincipalId, owner, cancellationToken)
            .ConfigureAwait(false);
        RequireParticipants();
        await LockCanvasLinkArticlesAsync(new(actorAdminPrincipalId, owner.SiteScope), ids.ToArray(), cancellationToken)
            .ConfigureAwait(false);
        RequireParticipants();
        await LockPropertyDefinitionsAsync(owner, cancellationToken).ConfigureAwait(false);
        RequireParticipants();
        await AdmitPropertyNativeBatchAsync(originalTransaction, owner, ids, cancellationToken).ConfigureAwait(false);
        RequireParticipants();
        Dictionary<int, ArticlePropertyValueNativeArticle> articleFacts = await ReadPropertyNativeArticleFactsAsync(
            originalTransaction, ids, cancellationToken).ConfigureAwait(false);
        RequireParticipants();
        if (articleFacts.Count != ids.Length)
            throw new ArticlePropertyDefinitionAccessDeniedException();
        var persisted = new Dictionary<int, ArticlePropertyValuePersistedSnapshot?>();
        foreach (int id in ids)
        {
            persisted.Add(id, await values.ReadCurrentInNativeSnapshotAsync(originalTransaction, owner, id,
                articleFacts[id].ArticleRevisionId, cancellationToken).ConfigureAwait(false));
            RequireParticipants();
        }
        IReadOnlyList<ArticlePropertyDefinition> currentDefinitions = await ReadPropertyDefinitionsAsync(actor, owner,
            cancellationToken, persisted.Values.Where(static value => value is not null)
                .SelectMany(static value => value!.Snapshot.Values.Select(static field => field.DefinitionId)))
            .ConfigureAwait(false);
        RequireParticipants();
        var rows = ImmutableArray.CreateBuilder<ArticlePropertyValueReadModel>(ids.Length);
        foreach (int id in ids)
        {
            ArticlePropertyValuePersistedSnapshot? current = persisted[id];
            IReadOnlyList<ArticlePropertyValueReconciliation> reconciliation = await ReconcilePropertyValuesAsync(actor,
                owner, id, current, currentDefinitions, cancellationToken).ConfigureAwait(false);
            RequireParticipants();
            rows.Add(new(id, articleFacts[id].ArticleRevisionId, current?.Snapshot.Coordinates.PropertyRevision ?? 0,
                current, currentDefinitions, reconciliation));
        }
        ArticlePropertyNativeSnapshotObservation after = await ArticlePropertyNativeSnapshotRead.ObserveAsync(
            _db, originalTransaction, cancellationToken).ConfigureAwait(false);
        RequireParticipants();
        cancellationToken.ThrowIfCancellationRequested();
        if (after != snapshot)
            throw new ArticlePropertyDefinitionIntegrityException("article_property_native_snapshot_changed");
        // No source generation is manufactured from this MVCC string or these value/definition digests.
        return new(owner, new(actor.AdminPrincipalId, Array.AsReadOnly(actor.Permissions.ToArray())), snapshot,
            [.. ids.Select(id => articleFacts[id])], rows.MoveToImmutable());
    }

    internal static ImmutableArray<int> CapturePropertyNativeBatchIds(IReadOnlyList<int> articleIds)
    {
        ArgumentNullException.ThrowIfNull(articleIds);
        if (articleIds.Count > PropertyNativeBatchArticleLimit)
            throw new ArticlePropertyDefinitionBudgetExceededException("article_property_native_batch_article_budget");
        ImmutableArray<int> held = [.. articleIds];
        if (held.Length > PropertyNativeBatchArticleLimit || held.Any(static id => id <= 0)
            || held.Distinct().Count() != held.Length)
            throw new ArticlePropertyDefinitionValidationException("article_property_native_batch_article_identity_invalid");
        return held;
    }

    private async Task<Dictionary<int, ArticlePropertyValueNativeArticle>> ReadPropertyNativeArticleFactsAsync(
        NpgsqlTransaction transaction, ImmutableArray<int> ids, CancellationToken cancellationToken)
    {
        var result = new Dictionary<int, ArticlePropertyValueNativeArticle>();
        using var command = new NpgsqlCommand("""
            SELECT id,current_revision_id,status,isdeleted FROM article WHERE id=ANY(@Ids) ORDER BY id;
            """, ArticlePropertyNativeSnapshotRead.Require(_db, transaction), transaction);
        command.Parameters.AddWithValue("Ids", NpgsqlDbType.Array | NpgsqlDbType.Integer, ids.ToArray());
        using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            ArticlePropertyNativeSnapshotRead.Require(_db, transaction);
            if (reader.IsDBNull(1) || reader.GetInt64(1) <= 0)
                throw new ArticlePropertyDefinitionIntegrityException("article_property_native_batch_revision_missing");
            int id = reader.GetInt32(0);
            result.Add(id, new(id, reader.GetInt64(1), (ArticleStatus)reader.GetInt32(2), reader.GetBoolean(3)));
        }
        ArticlePropertyNativeSnapshotRead.Require(_db, transaction);
        return result;
    }

    private async Task AdmitPropertyNativeBatchAsync(NpgsqlTransaction transaction, ArticlePropertyDefinitionOwner owner,
        ImmutableArray<int> ids, CancellationToken cancellationToken)
    {
        using var command = new NpgsqlCommand("""
            WITH facts AS (
                SELECT f.* FROM article_property_value_head h
                JOIN article_property_value_snapshot s ON s.snapshot_id=h.snapshot_id
                JOIN article_property_value_factset f ON f.factset_id=s.factset_id
                WHERE h.owner_user_key=@Owner AND h.site_scope=@Site AND h.article_id=ANY(@Ids)),
            costs AS (
                SELECT 2048::bigint AS bytes FROM facts
                UNION ALL SELECT 256::bigint+4::bigint*coalesce(octet_length(e.text_value),0)
                    FROM article_property_value_entry e JOIN facts f ON f.factset_id=e.factset_id
                UNION ALL SELECT 64::bigint FROM article_property_value_option o JOIN facts f ON f.factset_id=o.factset_id
                UNION ALL SELECT 64::bigint FROM article_property_value_reference r JOIN facts f ON f.factset_id=r.factset_id),
            definitions AS (SELECT * FROM article_property_definition WHERE owner_user_id=@Owner AND site_scope=@Site),
            definition_costs AS (
                SELECT 2048::bigint+4::bigint*octet_length(row_to_json(d)::text) AS bytes FROM definitions d
                UNION ALL SELECT 256::bigint+4::bigint*octet_length(row_to_json(n)::text)
                    FROM article_property_definition_display_name n JOIN definitions d ON d.definition_id=n.definition_id
                UNION ALL SELECT 256::bigint+4::bigint*octet_length(row_to_json(o)::text)
                    FROM article_property_definition_option o JOIN definitions d ON d.definition_id=o.definition_id
                UNION ALL SELECT 256::bigint+4::bigint*octet_length(row_to_json(l)::text)
                    FROM article_property_definition_option_label l JOIN definitions d ON d.definition_id=l.definition_id)
            SELECT (SELECT count(*) FROM facts),(SELECT coalesce(sum(value_count),0) FROM facts),
                   (SELECT count(*) FROM definitions),
                   (SELECT coalesce(sum(bytes),0) FROM costs)+(SELECT coalesce(sum(bytes),0) FROM definition_costs);
            """, ArticlePropertyNativeSnapshotRead.Require(_db, transaction), transaction);
        command.Parameters.AddWithValue("Owner", owner.UserId ?? 0);
        command.Parameters.AddWithValue("Site", owner.SiteScope);
        command.Parameters.AddWithValue("Ids", NpgsqlDbType.Array | NpgsqlDbType.Integer, ids.ToArray());
        using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            || reader.GetInt64(0) > ids.Length || reader.GetInt64(1) > PropertyNativeBatchEntryLimit
            || reader.GetInt64(2) > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner
            || reader.GetDecimal(3) > ArticlePropertyDefinitionContract.MaxVerificationResourceBytes)
            throw new ArticlePropertyDefinitionBudgetExceededException("article_property_native_batch_source_budget");
        ArticlePropertyNativeSnapshotRead.Require(_db, transaction);
    }
}
