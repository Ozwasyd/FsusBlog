using System.Data;

using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticlePropertyNativeBatchReadTests
{
    [Theory]
    [InlineData(IsolationLevel.ReadCommitted)]
    [InlineData(IsolationLevel.ReadUncommitted)]
    [InlineData(IsolationLevel.Unspecified)]
    [InlineData(IsolationLevel.Snapshot)]
    [InlineData(IsolationLevel.Chaos)]
    public void StatementOrSyntheticIsolationCannotAdmitConsistentNativeSnapshot(IsolationLevel isolation)
        => Assert.False(ArticlePropertyNativeSnapshotRead.SupportsConsistentSnapshot(isolation));

    [Theory]
    [InlineData(IsolationLevel.RepeatableRead)]
    [InlineData(IsolationLevel.Serializable)]
    public void ActualTransactionSnapshotIsolationIsSupported(IsolationLevel isolation)
        => Assert.True(ArticlePropertyNativeSnapshotRead.SupportsConsistentSnapshot(isolation));

    [Fact]
    public void HeldBatchPreservesOrderAndCannotFollowCallerListMutation()
    {
        var supplied = new List<int> { 3, 1, 2 };
        var captured = ArticleService.CapturePropertyNativeBatchIds(supplied);
        supplied[0] = 99;
        supplied.Clear();
        Assert.Equal(new[] { 3, 1, 2 }, captured);
        Assert.Empty(ArticleService.CapturePropertyNativeBatchIds(Array.Empty<int>()));
    }

    [Fact]
    public void DuplicateNonpositiveAndOverBudgetArticlesRejectInsteadOfTruncating()
    {
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticleService.CapturePropertyNativeBatchIds([1, 1]));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticleService.CapturePropertyNativeBatchIds([0]));
        Assert.Throws<ArticlePropertyDefinitionValidationException>(() => ArticleService.CapturePropertyNativeBatchIds([-1]));
        Assert.Throws<ArticlePropertyDefinitionBudgetExceededException>(() => ArticleService.CapturePropertyNativeBatchIds(
            Enumerable.Range(1, ArticleService.PropertyNativeBatchArticleLimit + 1).ToArray()));
        Assert.Equal(ArticleService.PropertyNativeBatchArticleLimit, ArticleService.CapturePropertyNativeBatchIds(
            Enumerable.Range(1, ArticleService.PropertyNativeBatchArticleLimit).ToArray()).Length);
    }
}
