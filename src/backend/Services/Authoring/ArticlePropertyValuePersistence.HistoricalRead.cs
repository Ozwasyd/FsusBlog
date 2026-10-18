using System.Data.Common;

using FsusBlog.Shared.Contracts.ArticleProperties;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class ArticlePropertyValuePersistence
{
    /// <summary>
    /// Resolves exactly one persisted coordinate in the canonical caller's authorized transaction.
    /// A null publication selects only an unpublished coordinate; absence never creates empty facts.
    /// </summary>
    public async Task<ArticlePropertyValuePersistedSnapshot> ReadHistoricalAsync(
        ArticlePropertyDefinitionOwner owner, int articleId, long articleRevisionId, long? publicationId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequireTransaction();
        ValidateScope(owner, articleId);
        if (articleRevisionId <= 0 || publicationId is <= 0)
        {
            throw Integrity("article_property_value_historical_coordinates_invalid");
        }
        Guid snapshotId;
        using (DbDataReader reader = (DbDataReader)await _db.Ado.GetDataReaderAsync(
            """
            SELECT s.snapshot_id FROM article_property_value_snapshot s
            JOIN article_property_value_factset f ON f.factset_id = s.factset_id
            WHERE f.owner_user_key = @Owner AND f.site_scope = @Site AND f.article_id = @Article
                AND s.article_revision_id = @Revision
                AND s.publication_id IS NOT DISTINCT FROM CAST(@Publication AS bigint)
            LIMIT 2;
            """, (SugarParameter[])[.. Scope(owner, articleId), new("@Revision", articleRevisionId),
                new("@Publication", (object?)publicationId ?? DBNull.Value)]).ConfigureAwait(false))
        {
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw Integrity("article_property_value_historical_snapshot_unavailable");
            }
            snapshotId = reader.GetGuid(0);
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw Integrity("article_property_value_historical_snapshot_ambiguous");
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        ArticlePropertyValuePersistedSnapshot snapshot = await ReadSnapshotAsync(owner, articleId,
            snapshotId, cancellationToken).ConfigureAwait(false)
            ?? throw Integrity("article_property_value_historical_snapshot_unavailable");
        ArticlePropertySnapshotCoordinates coordinates = snapshot.Snapshot.Coordinates;
        if (coordinates.DefinitionOwnerUserId != owner.UserId || coordinates.SiteScope != owner.SiteScope
            || coordinates.ArticleId != articleId || coordinates.ArticleRevisionId != articleRevisionId
            || coordinates.PublicationId != publicationId || coordinates.DraftId.HasValue
            || coordinates.DraftServerRevision.HasValue)
        {
            throw Integrity("article_property_value_historical_coordinates_invalid");
        }
        cancellationToken.ThrowIfCancellationRequested();
        return snapshot;
    }
}
