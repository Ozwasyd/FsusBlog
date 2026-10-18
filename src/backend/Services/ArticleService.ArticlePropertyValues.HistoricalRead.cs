using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services;

public partial class ArticleService
{
    /// <summary>
    /// Reads an exact historical revision/publication under the original current actor, site and
    /// article authorization. Historical evidence never supplies a current permission grant.
    /// </summary>
    public async Task<ArticlePropertyValueReadModel> ReadHistoricalPropertyValuesAsync(
        long actorAdminPrincipalId, ArticlePropertyDefinitionOwner owner, int articleId,
        long articleRevisionId, long? publicationId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArticlePropertyValuePersistence persistence = RequirePropertyPersistence();
        RequirePropertyTransactionEntry();
        var result = await ExecuteForegroundWriteAsync("article-property-values-historical-read", async gateCt =>
        {
            gateCt.ThrowIfCancellationRequested();
            return await _db.Ado.UseTranAsync(async () =>
            {
                ArticlePropertyDefinitionActor actor = await LockPropertyActorAsync(actorAdminPrincipalId,
                    owner, cancellationToken).ConfigureAwait(false);
                await LockCanvasLinkArticlesAsync(new(actorAdminPrincipalId, owner.SiteScope),
                    [articleId], cancellationToken).ConfigureAwait(false);
                await LockPropertyDefinitionsAsync(owner, cancellationToken).ConfigureAwait(false);
                ArticlePropertyValuePersistedSnapshot snapshot = await persistence.ReadHistoricalAsync(
                    owner, articleId, articleRevisionId, publicationId, cancellationToken).ConfigureAwait(false);
                IReadOnlyList<ArticlePropertyDefinition> definitions = await ReadPropertyDefinitionsAsync(
                    actor, owner, cancellationToken,
                    snapshot.Snapshot.Values.Select(static value => value.DefinitionId)).ConfigureAwait(false);
                IReadOnlyList<ArticlePropertyValueReconciliation> reconciliation = await ReconcilePropertyValuesAsync(
                    actor, owner, articleId, snapshot, definitions, cancellationToken).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
                return new ArticlePropertyValueReadModel(articleId, articleRevisionId,
                    snapshot.Snapshot.Coordinates.PropertyRevision, snapshot, definitions, reconciliation);
            }).ConfigureAwait(false);
        }, cancellationToken).ConfigureAwait(false);
        if (!result.IsSuccess)
        {
            throw result.ErrorException ?? new InvalidOperationException(result.ErrorMessage);
        }
        cancellationToken.ThrowIfCancellationRequested();
        return result.Data;
    }
}
