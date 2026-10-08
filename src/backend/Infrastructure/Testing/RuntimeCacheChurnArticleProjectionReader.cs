using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Fixtures;

namespace FsusBlog.Server.Infrastructure.Testing;

// Consume the canonical reader with the original producer invocation. This
// returns its real causal tuple/digests without relabeling edge generations as
// a common generation. It is not another projector or churn qualification API.
internal static class RuntimeCacheChurnArticleProjectionReader
{
    internal static Task<CanonicalArticleProjectionOutputAggregate> ReadAsync(
        CanonicalArticleProjectionVerifier verifier,
        IRuntimeKeyScope runtimeKeyScope,
        string runId,
        string testNamespace,
        int articleId,
        CanonicalArticlePublicationReceipt receipt,
        CanonicalArticlePublicationRequest currentInvocation,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(verifier);
        ArgumentNullException.ThrowIfNull(runtimeKeyScope);
        ArgumentNullException.ThrowIfNull(receipt);
        ArgumentNullException.ThrowIfNull(currentInvocation);
        RequireIdentity(runtimeKeyScope, runId, testNamespace, articleId, receipt.RunId, receipt.Namespace, receipt.ArticleId);
        return verifier.VerifyAsync(receipt, currentInvocation, cancellationToken);
    }

    internal static Task<CanonicalArticleProjectionOutputAggregate> ReadAsync(
        CanonicalArticleProjectionVerifier verifier,
        IRuntimeKeyScope runtimeKeyScope,
        string runId,
        string testNamespace,
        int articleId,
        CanonicalArticleLifecycleReceipt receipt,
        CanonicalArticleLifecycleFixtureBinding currentInvocation,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(verifier);
        ArgumentNullException.ThrowIfNull(runtimeKeyScope);
        ArgumentNullException.ThrowIfNull(receipt);
        ArgumentNullException.ThrowIfNull(currentInvocation);
        RequireIdentity(runtimeKeyScope, runId, testNamespace, articleId, receipt.RunId, receipt.Namespace, receipt.ArticleId);
        return verifier.VerifyAsync(receipt, currentInvocation, cancellationToken);
    }

    private static void RequireIdentity(
        IRuntimeKeyScope runtimeKeyScope, string runId, string testNamespace, int articleId,
        string receiptRunId, string receiptNamespace, int receiptArticleId)
    {
        if (string.IsNullOrWhiteSpace(runId)
            || !HttpTestSessionKeyScope.IsValidSessionId(testNamespace)
            || runtimeKeyScope.ScopeToken != testNamespace
            || articleId <= 0 || runId != receiptRunId
            || testNamespace != receiptNamespace || articleId != receiptArticleId)
        {
            throw new InvalidOperationException("cache_churn_article_producer_identity_mismatch");
        }
    }
}
