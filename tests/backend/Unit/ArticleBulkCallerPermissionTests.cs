using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

// Ordinary source controls only. No native/auth/runtime execution or qualification is claimed.
public sealed class ArticleBulkCallerPermissionTests
{
    [Theory]
    [InlineData("lifecycle.archive")]
    [InlineData("lifecycle.restore")]
    [InlineData("lifecycle.inbox-to-draft")]
    [InlineData("lifecycle.draft-to-inbox")]
    public void OriginalWriteAloneDoesNotSupplyExplicitOperationPermission(string operation)
    {
        Assert.Equal(ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.ExplicitOperationPermissionAbsent,
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(false, "article.write", operation));
    }

    [Fact]
    public void ExplicitOperationPermissionAloneDoesNotReplaceOriginalWriterPermission()
    {
        Assert.Equal(ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.OriginalArticleWriteAbsent,
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(false, "article.lifecycle.write", "lifecycle.restore"));
    }

    [Fact]
    public void OriginalRootRuleDoesNotInventBulkOperationRootBypass()
    {
        Assert.Equal(ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.ExplicitOperationPermissionAbsent,
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(true, "", "lifecycle.archive"));
    }

    [Fact]
    public void ExactPersistedPermissionsAreDistinctFactsOnly()
    {
        Assert.Equal(ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.OriginalWriteAndExplicitOperationPresent,
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(false,
                "article.write; article.lifecycle.write\r\narticle.read", "lifecycle.restore"));
    }

    [Fact]
    public void RootStillRequiresTheExplicitPersistedOperationPermission()
    {
        Assert.Equal(ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.OriginalWriteAndExplicitOperationPresent,
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(true, "article.lifecycle.write", "lifecycle.restore"));
    }

    [Theory]
    [InlineData("article.write,ARTICLE.LIFECYCLE.WRITE")]
    [InlineData("article.write,article.lifecycle.write.extra")]
    [InlineData("article.write,*")]
    public void CasePrefixAndWildcardDoNotSupplyOperationPermission(string permissions)
    {
        Assert.Equal(ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.ExplicitOperationPermissionAbsent,
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(false, permissions, "lifecycle.archive"));
    }

    [Theory]
    [InlineData("schedule.change")]
    [InlineData("category.add")]
    [InlineData("lifecycle.archive.extra")]
    public void OtherOperationOwnersAreNotReinterpreted(string operation)
    {
        Assert.Throws<ArticleWriteValidationException>(() =>
            ArticleLifecycleTransitionWriter.DecideBulkCallerPermission(true, "article.lifecycle.write", operation));
    }

    [Fact]
    public async Task FabricatedPermissionObjectHasNoOriginalCustody()
    {
        var fabricated = new ArticleLifecycleTransitionWriter.BulkCallerPermissionObservation(1, "https://site.invalid",
            "lifecycle.restore", "article.lifecycle.write",
            ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.OriginalWriteAndExplicitOperationPresent);
        await Assert.ThrowsAsync<ArticleWriteValidationException>(() =>
            ArticleLifecycleTransitionWriter.RevalidateBulkCallerPermissionAfterLockAsync(
                null!, null!, null!, null!, fabricated, CancellationToken.None));
    }
}
