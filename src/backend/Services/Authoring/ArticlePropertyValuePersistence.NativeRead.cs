using FsusBlog.Shared.Contracts.ArticleProperties;

using Npgsql;

namespace FsusBlog.Server.Services.Authoring;

public sealed partial class ArticlePropertyValuePersistence
{
    internal void RequireOriginalNativeSnapshot(NpgsqlTransaction transaction)
        => ArticlePropertyNativeSnapshotRead.Require(_db, transaction);

    internal async Task<ArticlePropertyValuePersistedSnapshot?> ReadCurrentInNativeSnapshotAsync(
        NpgsqlTransaction transaction, ArticlePropertyDefinitionOwner owner, int articleId,
        long expectedArticleRevisionId, CancellationToken cancellationToken)
    {
        RequireOriginalNativeSnapshot(transaction);
        ArticlePropertyValuePersistedSnapshot? value = await ReadCurrentAsync(owner, articleId,
            expectedArticleRevisionId, cancellationToken).ConfigureAwait(false);
        RequireOriginalNativeSnapshot(transaction);
        cancellationToken.ThrowIfCancellationRequested();
        return value;
    }
}
