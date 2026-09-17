using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCommentScopePolicyTests
{
    [Fact]
    public void TopLevelScope_IsArticleBoundVersionedAndSingleUse()
    {
        string scope = AnonymousCommentScopePolicy.CreateTopLevelScope(42);

        Assert.Equal("comment:v1:article:42:top", scope);
        Assert.True(AnonymousCommentScopePolicy.TryParse(scope, out AnonymousCommentScopeDescriptor descriptor));
        Assert.Equal(AnonymousCommentScopeKind.TopLevel, descriptor.Kind);
        Assert.Equal(42, descriptor.ArticleId);
        Assert.Null(descriptor.RootId);
        Assert.Equal(1, descriptor.MaxUsesPerCredential);
    }

    [Fact]
    public void ThreadScope_IsArticleAndRootBoundWithThreeReplyUses()
    {
        string scope = AnonymousCommentScopePolicy.CreateThreadScope(42, 9001);

        Assert.Equal("comment:v1:article:42:thread:9001", scope);
        Assert.True(AnonymousCommentScopePolicy.TryParse(scope, out AnonymousCommentScopeDescriptor descriptor));
        Assert.Equal(AnonymousCommentScopeKind.ThreadReply, descriptor.Kind);
        Assert.Equal(42, descriptor.ArticleId);
        Assert.Equal(9001, descriptor.RootId);
        Assert.Equal(3, descriptor.MaxUsesPerCredential);
    }

    [Theory]
    [InlineData("article:42")]
    [InlineData("comment:v0:article:42:top")]
    [InlineData("comment:v1:article:0:top")]
    [InlineData("comment:v1:article:42:thread:0")]
    [InlineData("comment:v1:article:42:thread:9001:extra")]
    public void LegacyOrMalformedScope_IsRejected(string scope)
        => Assert.False(AnonymousCommentScopePolicy.TryParse(scope, out _));

    [Fact]
    public void SameThreadAcrossArticles_DoesNotShareScope()
        => Assert.NotEqual(
            AnonymousCommentScopePolicy.CreateThreadScope(42, 9001),
            AnonymousCommentScopePolicy.CreateThreadScope(43, 9001));
}
