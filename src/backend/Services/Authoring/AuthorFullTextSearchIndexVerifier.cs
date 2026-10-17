namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Recomputes the complete bounded index from original current source batches. Publicly
/// resealed term/coordinate mutations cannot substitute for the original raw source. This
/// verifies algorithm/source parity only; canonical admission and durable storage are separate.
/// </summary>
public static class AuthorFullTextSearchIndexVerifier
{
    public static async Task VerifyAsync(
        AuthorSearchIndexReadSnapshot snapshot,
        IAuthorFullTextSearchIndexSource source,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentNullException.ThrowIfNull(source);
        if (snapshot.IndexInstanceId == Guid.Empty || snapshot.UserId <= 0 || string.IsNullOrWhiteSpace(snapshot.SiteScope)
            || snapshot.IndexGeneration <= 0 || snapshot.SourceGeneration <= 0
            || snapshot.Articles.Count > AuthorFullTextSearchIndex.MaxArticles
            || snapshot.RegistryDigest != AuthorFullTextSearchVerifier.CaptureRegistry().ContentDigest)
        {
            throw new AuthorSearchContractException("author_search_index_snapshot_invalid");
        }
        int afterArticleId = 0;
        int articleCount = 0;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AuthorSearchIndexSourcePage page = await source.ReadAsync(snapshot.UserId, snapshot.SiteScope,
                afterArticleId, AuthorFullTextSearchIndex.BatchSize, snapshot.SourceGeneration,
                cancellationToken).ConfigureAwait(false);
            if (page.SourceGeneration != snapshot.SourceGeneration || page.Articles.IsDefault
                || page.Articles.Length > AuthorFullTextSearchIndex.BatchSize
                || page.HasMore && page.Articles.IsEmpty)
            {
                throw new AuthorSearchContractException("author_search_index_verification_source_stale");
            }
            foreach (AuthorSearchIndexArticleSource article in page.Articles)
            {
                if (article.ArticleId <= afterArticleId || ++articleCount > AuthorFullTextSearchIndex.MaxArticles
                    || !snapshot.Articles.TryGetValue(article.ArticleId, out AuthorSearchIndexedArticle? indexed)
                    || indexed.ArticleId != article.ArticleId || indexed.SourceSequence != article.SourceSequence
                    || indexed.Deleted != article.Deleted || article.Fields.IsDefault
                    || indexed.Documents.IsDefault || indexed.Documents.Length != article.Fields.Length
                    || article.Fields.Length > 1_000 || article.Deleted != article.Fields.IsEmpty)
                {
                    throw new AuthorSearchContractException("author_search_index_verification_article_mismatch");
                }
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (AuthorSearchIndexFieldSource field in article.Fields)
                {
                    AuthorSearchDocument expected = AuthorFullTextSearchContract.SealDocument(field.Document with
                    {
                        Identity = field.Document.Identity with
                        {
                            IndexGeneration = snapshot.IndexGeneration
                        }
                    });
                    if (expected.Identity.ArticleId != article.ArticleId || expected.Identity.UserId != snapshot.UserId
                        || expected.Identity.SiteScope != snapshot.SiteScope || !seen.Add(expected.ContentDigest))
                    {
                        throw new AuthorSearchContractException("author_search_index_verification_scope_mismatch");
                    }
                    AuthorSearchTokenizedDocument[] matches = indexed.Documents
                        .Where(document => document.Document.ContentDigest == expected.ContentDigest).Take(2).ToArray();
                    if (matches.Length != 1)
                    {
                        throw new AuthorSearchContractException("author_search_index_verification_document_mismatch");
                    }
                    AuthorFullTextSearchVerifier.VerifyTokenDocument(matches[0], field.RawSource,
                        article.Definitions, field.ParserVersion, field.DocumentEpoch);
                }
                afterArticleId = article.ArticleId;
            }
            if (!page.HasMore)
            {
                break;
            }
        }
        if (articleCount != snapshot.Articles.Count)
        {
            throw new AuthorSearchContractException("author_search_index_verification_orphan_documents");
        }
    }
}
