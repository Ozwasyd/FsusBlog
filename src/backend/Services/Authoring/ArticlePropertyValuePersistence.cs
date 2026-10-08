using System.Data.Common;
using System.Globalization;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Shared.Contracts.ArticleProperties;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Relational participant in the sole ArticleService transaction. It never starts or commits
/// a transaction and does not grant article, definition, draft or reference authorization.
/// </summary>
public sealed partial class ArticlePropertyValuePersistence
{
    public const string WriteAuditAction = "article-property-values-write";
    public const string SnapshotAuditAction = "article-property-values-snapshot";
    private readonly ISqlSugarClient _db;
    private readonly byte[]? _tamperKey;
    private readonly TimeProvider _timeProvider;

    public ArticlePropertyValuePersistence(ISqlSugarClient db, IConfiguration configuration, TimeProvider timeProvider)
    {
        _db = db;
        _tamperKey = AuditTamperEvidence.ResolveKey(configuration);
        _timeProvider = timeProvider;
    }

    /// <summary>The canonical caller locks the article row before acquiring this complete ordered owner set.</summary>
    public async Task LockDefinitionOwnersAsync(int articleId,
        ArticlePropertyDefinitionOwner? additionalOwner = null, CancellationToken cancellationToken = default)
    {
        RequireTransaction();
        if (articleId <= 0)
        {
            throw Integrity("article_property_value_article_identity_invalid");
        }
        var owners = new List<ArticlePropertyDefinitionOwner>();
        using (DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            "SELECT owner_user_key, site_scope FROM article_property_value_head WHERE article_id = @Article LIMIT 1001;",
            new SugarParameter("@Article", articleId)).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                owners.Add(new(reader.GetInt64(0) == 0 ? null : reader.GetInt64(0), reader.GetString(1)));
            }
        }
        foreach (ArticlePropertyDefinitionOwner owner in CaptureDefinitionOwners(owners, additionalOwner))
        {
            cancellationToken.ThrowIfCancellationRequested();
            string identity = $"article-property-definition:{(owner.UserId ?? 0).ToString(CultureInfo.InvariantCulture)}:{owner.SiteScope}";
            await _db.Ado.ExecuteCommandAsync("SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 2442));",
                new SugarParameter("@Identity", identity)).ConfigureAwait(false);
        }
    }

    internal static IReadOnlyList<ArticlePropertyDefinitionOwner> CaptureDefinitionOwners(
        IEnumerable<ArticlePropertyDefinitionOwner> owners, ArticlePropertyDefinitionOwner? additionalOwner = null)
    {
        ArgumentNullException.ThrowIfNull(owners);
        ArticlePropertyDefinitionOwner[] held = owners.Take(1001).ToArray();
        if (held.Length > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
        {
            throw Integrity("article_property_value_scope_budget_exceeded");
        }
        var unique = new HashSet<ArticlePropertyDefinitionOwner>(held);
        if (additionalOwner.HasValue)
        {
            unique.Add(additionalOwner.Value);
        }
        if (unique.Count > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
        {
            throw Integrity("article_property_value_scope_budget_exceeded");
        }
        foreach (ArticlePropertyDefinitionOwner owner in unique)
        {
            ArticlePropertyDefinitionContract.ValidateOwner(owner);
        }
        return Array.AsReadOnly(unique.OrderBy(static owner => owner.UserId ?? 0)
            .ThenBy(static owner => owner.SiteScope, StringComparer.Ordinal).ToArray());
    }

    public async Task<ArticlePropertyValuePersistedSnapshot?> ReadCurrentAsync(
        ArticlePropertyDefinitionOwner owner, int articleId, long? expectedArticleRevisionId = null,
        CancellationToken cancellationToken = default)
    {
        ValidateScope(owner, articleId);
        Guid? id;
        long propertyRevision;
        using (DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT snapshot_id, property_revision FROM article_property_value_head
            WHERE owner_user_key = @Owner AND site_scope = @Site AND article_id = @Article;
            """, Scope(owner, articleId)).ConfigureAwait(false))
        {
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                return null;
            }
            id = reader.GetGuid(0);
            propertyRevision = reader.GetInt64(1);
        }
        ArticlePropertyValuePersistedSnapshot snapshot = await ReadSnapshotAsync(owner, articleId,
            id.Value, cancellationToken).ConfigureAwait(false)
            ?? throw Integrity("article_property_value_head_snapshot_missing");
        if (snapshot.Snapshot.Coordinates.PropertyRevision != propertyRevision
            || expectedArticleRevisionId.HasValue
                && snapshot.Snapshot.Coordinates.ArticleRevisionId != expectedArticleRevisionId.Value)
        {
            throw Integrity("article_property_value_current_coordinates_stale");
        }
        return snapshot;
    }

    public async Task<ArticlePropertyValueMutationReceipt?> LoadReplayAsync(
        long actorId, ArticlePropertyValueMutationCommand command, CancellationToken cancellationToken = default)
    {
        command = ArticlePropertyValueMutationContract.Capture(command);
        if (actorId <= 0)
        {
            throw Integrity("article_property_value_actor_invalid");
        }
        ArticlePropertyValueMutationReceipt? receipt = await ReadReceiptAsync(actorId, command.RequestId,
            cancellationToken).ConfigureAwait(false);
        if (receipt is null)
        {
            return null;
        }
        if (receipt.DefinitionOwnerUserId != command.DefinitionOwnerUserId || receipt.SiteScope != command.SiteScope
            || receipt.ArticleId != command.ArticleId
            || receipt.CommandDigest != ArticlePropertyValueMutationContract.ComputeCommandDigest(command))
        {
            throw new ArticlePropertyDefinitionConflictException("article_property_value_idempotency_conflict");
        }
        return receipt with
        {
            IdempotencyReplay = true
        };
    }

    public async Task<ArticlePropertyValueMutationReceipt> SaveMutationAsync(
        long actorId, ArticlePropertyValueMutationCommand command, ArticlePropertyValuePersistedSnapshot? before,
        IReadOnlyList<ArticlePropertyValueEntry> validatedValues,
        IReadOnlyDictionary<Guid, ArticlePropertyValueType> definitionTypes,
        long actualArticleRevisionId, long? actualPublicationId,
        CancellationToken cancellationToken = default)
    {
        RequireTransaction();
        command = ArticlePropertyValueMutationContract.Capture(command);
        var owner = new ArticlePropertyDefinitionOwner(command.DefinitionOwnerUserId, command.SiteScope);
        if (actorId <= 0 || actualArticleRevisionId <= 0 || actualArticleRevisionId == command.ExpectedArticleRevisionId
            || before is null && command.ExpectedPropertyRevision != 0
            || before is not null && (before.Snapshot.Coordinates.DefinitionOwnerUserId != owner.UserId
                || before.Snapshot.Coordinates.SiteScope != owner.SiteScope
                || before.Snapshot.Coordinates.ArticleId != command.ArticleId
                || before.Snapshot.Coordinates.PropertyRevision != command.ExpectedPropertyRevision
                || before.Snapshot.Coordinates.ArticleRevisionId != command.ExpectedArticleRevisionId))
        {
            throw new ArticlePropertyDefinitionConflictException("article_property_value_revision_conflict");
        }
        cancellationToken.ThrowIfCancellationRequested();
        ArticlePropertyValuePersistedSnapshot? observed = await ReadCurrentAsync(owner, command.ArticleId,
            command.ExpectedArticleRevisionId, cancellationToken).ConfigureAwait(false);
        if (observed?.SnapshotId != before?.SnapshotId
            || (observed?.Snapshot.Coordinates.PropertyRevision ?? 0) != command.ExpectedPropertyRevision)
        {
            throw new ArticlePropertyDefinitionConflictException("article_property_value_revision_conflict");
        }
        await RequireActualCoordinatesAsync(command.ArticleId, actualArticleRevisionId, actualPublicationId,
            cancellationToken, requireCurrent: true).ConfigureAwait(false);
        long propertyRevision = checked(command.ExpectedPropertyRevision + 1);
        ArticlePropertyValueSnapshot candidate = ArticlePropertyValueValidator.BindSnapshot(new(
            owner.UserId, owner.SiteScope, command.ArticleId, propertyRevision, actualArticleRevisionId,
            PublicationId: actualPublicationId), validatedValues);
        definitionTypes = candidate.Values.ToDictionary(static entry => entry.DefinitionId,
            entry => definitionTypes.TryGetValue(entry.DefinitionId, out ArticlePropertyValueType type)
                ? type : throw Integrity("article_property_value_storage_type_invalid"));
        ValidateStorageEntries(candidate.Values, definitionTypes);
        Guid factsetId = Guid.CreateVersion7();
        string factsetDigest = ComputeFactsetDigest(candidate.Values, definitionTypes);
        await InsertFactsetAsync(owner, command.ArticleId, propertyRevision, factsetId, factsetDigest,
            candidate.Values, definitionTypes, cancellationToken).ConfigureAwait(false);
        ArticlePropertyValuePersistedSnapshot after = await InsertSnapshotAsync(factsetId, factsetDigest,
            candidate, actorId, cancellationToken).ConfigureAwait(false);
        await ReplaceHeadAsync(owner, command.ArticleId, command.ExpectedPropertyRevision,
            after, cancellationToken).ConfigureAwait(false);
        DateTime occurredAt = Timestamp();
        Guid receiptId = Guid.CreateVersion7();
        var receipt = new ArticlePropertyValueMutationReceipt(receiptId, actorId, command.RequestId,
            owner.UserId, owner.SiteScope, command.ArticleId, command.ExpectedArticleRevisionId,
            command.ExpectedPropertyRevision, propertyRevision, before?.SnapshotId, after.SnapshotId,
            command.Mode, ArticlePropertyValueMutationContract.ComputeCommandDigest(command), string.Empty,
            receiptId, string.Empty, string.Empty, occurredAt);
        receipt = receipt with
        {
            ContentDigest = ArticlePropertyValueMutationContract.ComputeReceiptDigest(receipt)
        };
        AuthoringSignedAuditWriter.ChainWrite audit = await SignAsync(receipt.AuditReference,
            "article-property-value-receipt", WriteAuditAction, receipt.ContentDigest, actorId, occurredAt,
            cancellationToken).ConfigureAwait(false);
        receipt = receipt with
        {
            AuditChainId = audit.ChainId,
            AuditRecordHash = audit.RecordHash
        };
        await InsertReceiptAsync(receipt, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return receipt;
    }

    /// <summary>Ordinary article revisions share immutable facts; rollback selects exact historical facts.</summary>
    public async Task<IReadOnlyList<ArticlePropertyValuePersistedSnapshot>> CarryForwardAsync(
        int articleId, long actualArticleRevisionId, long? actualPublicationId, long actorId,
        long? restoreFromArticleRevisionId = null, ArticlePropertyDefinitionOwner? excludedOwner = null,
        CancellationToken cancellationToken = default)
    {
        RequireTransaction();
        if (actorId <= 0)
        {
            throw Integrity("article_property_value_actor_invalid");
        }
        await LockDefinitionOwnersAsync(articleId, cancellationToken: cancellationToken).ConfigureAwait(false);
        await RequireActualCoordinatesAsync(articleId, actualArticleRevisionId, actualPublicationId,
            cancellationToken, requireCurrent: true).ConfigureAwait(false);
        var owners = new List<ArticlePropertyDefinitionOwner>();
        using (DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            "SELECT owner_user_key, site_scope FROM article_property_value_head WHERE article_id = @Article ORDER BY owner_user_key, site_scope;",
            new SugarParameter("@Article", articleId)).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                owners.Add(new(reader.GetInt64(0) == 0 ? null : reader.GetInt64(0), reader.GetString(1)));
                if (owners.Count > ArticlePropertyDefinitionContract.MaxDefinitionsPerOwner)
                {
                    throw Integrity("article_property_value_scope_budget_exceeded");
                }
            }
        }
        var result = new List<ArticlePropertyValuePersistedSnapshot>(owners.Count);
        foreach (ArticlePropertyDefinitionOwner owner in owners)
        {
            if (owner == excludedOwner)
            {
                continue;
            }
            ArticlePropertyValuePersistedSnapshot current = await ReadCurrentAsync(owner, articleId,
                cancellationToken: cancellationToken).ConfigureAwait(false)
                ?? throw Integrity("article_property_value_head_snapshot_missing");
            ArticlePropertyValuePersistedSnapshot source = current;
            if (restoreFromArticleRevisionId.HasValue)
            {
                Guid? historical = null;
                using (DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
                    """
                    SELECT s.snapshot_id FROM article_property_value_snapshot s
                    JOIN article_property_value_factset f ON f.factset_id = s.factset_id
                    WHERE f.owner_user_key = @Owner AND f.site_scope = @Site AND f.article_id = @Article
                      AND s.article_revision_id = @Revision ORDER BY f.property_revision DESC LIMIT 2;
                    """, (SugarParameter[])[.. Scope(owner, articleId), new("@Revision", restoreFromArticleRevisionId.Value)]).ConfigureAwait(false))
                {
                    if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        historical = reader.GetGuid(0);
                        if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                        {
                            throw Integrity("article_property_value_rollback_snapshot_ambiguous");
                        }
                    }
                }
                if (!historical.HasValue)
                {
                    throw Integrity("article_property_value_rollback_snapshot_unavailable");
                }
                source = await ReadSnapshotAsync(owner, articleId, historical.Value, cancellationToken).ConfigureAwait(false)
                    ?? throw Integrity("article_property_value_rollback_snapshot_unavailable");
            }
            if (!restoreFromArticleRevisionId.HasValue
                && current.Snapshot.Coordinates.ArticleRevisionId == actualArticleRevisionId
                && current.Snapshot.Coordinates.PublicationId == actualPublicationId)
            {
                result.Add(current);
                continue;
            }
            ArticlePropertyValueSnapshot candidate = ArticlePropertyValueValidator.BindSnapshot(
                source.Snapshot.Coordinates with
                {
                    ArticleRevisionId = actualArticleRevisionId,
                    PropertyRevision = restoreFromArticleRevisionId.HasValue
                        ? checked(current.Snapshot.Coordinates.PropertyRevision + 1)
                        : current.Snapshot.Coordinates.PropertyRevision,
                    PublicationId = actualPublicationId,
                    DraftId = null,
                    DraftServerRevision = null
                }, source.Snapshot.Values);
            Guid factsetId = source.FactsetId;
            string digest = await ReadFactsetDigestAsync(factsetId, cancellationToken).ConfigureAwait(false);
            if (restoreFromArticleRevisionId.HasValue)
            {
                IReadOnlyDictionary<Guid, ArticlePropertyValueType> types = await ReadFactsetTypesAsync(
                    source.FactsetId, cancellationToken).ConfigureAwait(false);
                factsetId = Guid.CreateVersion7();
                await InsertFactsetAsync(owner, articleId, candidate.Coordinates.PropertyRevision, factsetId,
                    digest, candidate.Values, types, cancellationToken).ConfigureAwait(false);
            }
            ArticlePropertyValuePersistedSnapshot after = await InsertSnapshotAsync(factsetId, digest,
                candidate, actorId, cancellationToken).ConfigureAwait(false);
            // Ordinary carry retains facts; rollback creates a new monotonic property revision.
            await ReplaceHeadAsync(owner, articleId, current.Snapshot.Coordinates.PropertyRevision,
                after, cancellationToken).ConfigureAwait(false);
            result.Add(after);
        }
        return result.AsReadOnly();
    }

    private void RequireTransaction()
    {
        if (_db.Ado.Transaction is null)
        {
            throw Integrity("article_property_value_canonical_transaction_required");
        }
        if (_tamperKey is null)
        {
            throw Integrity("article_property_value_audit_key_missing");
        }
    }

    private static ArticlePropertyDefinitionIntegrityException Integrity(string code) => new(code);

    private static void ValidateScope(ArticlePropertyDefinitionOwner owner, int articleId)
    {
        ArticlePropertyDefinitionContract.ValidateOwner(owner);
        if (articleId <= 0)
        {
            throw Integrity("article_property_value_article_identity_invalid");
        }
    }

    private static SugarParameter[] Scope(ArticlePropertyDefinitionOwner owner, int articleId)
        => [new("@Owner", owner.UserId ?? 0), new("@Site", owner.SiteScope), new("@Article", articleId)];

    private DateTime Timestamp()
    {
        DateTime now = _timeProvider.GetUtcNow().UtcDateTime;
        return new DateTime(now.Ticks - now.Ticks % TimeSpan.TicksPerMicrosecond, DateTimeKind.Utc);
    }
}
