using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Modules.Endpoints;
using Microsoft.AspNetCore.Http;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringNativeAedsEndpointTests
{
    [Fact]
    public void TryResolveRoute_KnowsModerationAndAuditAuthoringRoutes()
    {
        Assert.True(AuthoringEndpoints.TryResolveRoute(
            HttpMethods.Post,
            new PathString("/moderation/effective-policy/preview"),
            out var moderationRoute));
        Assert.Equal(AedsFrameType.ModerationEffectivePolicyPreviewRequest, moderationRoute.RequestFrame);
        Assert.Equal(AedsFrameType.ModerationEffectivePolicy, moderationRoute.ResponseFrame);

        Assert.True(AuthoringEndpoints.TryResolveRoute(
            HttpMethods.Get,
            new PathString("/audit/42/verify"),
            out var auditRoute));
        Assert.Null(auditRoute.RequestFrame);
        Assert.Equal(AedsFrameType.AuditTamperVerifyResponse, auditRoute.ResponseFrame);

        Assert.True(AuthoringEndpoints.TryResolveRoute(
            HttpMethods.Post,
            new PathString("/comments/moderation/nullifiers/block"),
            out var nullifierRoute));
        Assert.Equal(AedsFrameType.AnonymousGovernanceActionRequest, nullifierRoute.RequestFrame);
        Assert.Equal(AedsFrameType.AnonymousGovernanceActionResponse, nullifierRoute.ResponseFrame);

        Assert.True(AuthoringEndpoints.TryResolveRoute(
            HttpMethods.Post,
            new PathString("/comments/moderation/anonymous-credentials/88001/revoke"),
            out var credentialRoute));
        Assert.Equal(AedsFrameType.AnonymousGovernanceActionRequest, credentialRoute.RequestFrame);
        Assert.Equal(AedsFrameType.AnonymousGovernanceActionResponse, credentialRoute.ResponseFrame);

        Assert.True(AuthoringEndpoints.TryResolveRoute(
            HttpMethods.Get,
            new PathString("/moderation/anonymous-comment-policy"),
            out var commentPolicyRoute));
        Assert.Null(commentPolicyRoute.RequestFrame);
        Assert.Equal(AedsFrameType.CommentPolicySnapshot, commentPolicyRoute.ResponseFrame);

        Assert.True(AuthoringEndpoints.TryResolveRoute(
            HttpMethods.Put,
            new PathString("/moderation/anonymous-comment-policy"),
            out var commentPolicyUpdateRoute));
        Assert.Equal(AedsFrameType.CommentPolicyUpdateRequest, commentPolicyUpdateRoute.RequestFrame);
        Assert.Equal(AedsFrameType.CommentPolicySnapshot, commentPolicyUpdateRoute.ResponseFrame);
    }

    [Fact]
    public void TryResolveRoute_KnowsAuthoringOperationsRoutes()
    {
        Assert.True(AuthoringEndpoints.TryResolveRoute(HttpMethods.Post, new PathString("/drafts"), out var draftRoute));
        Assert.Equal(AedsFrameType.AuthorDraftSaveRequest, draftRoute.RequestFrame);
        Assert.Equal(AedsFrameType.AuthorDraftResponse, draftRoute.ResponseFrame);

        Assert.True(AuthoringEndpoints.TryResolveRoute(HttpMethods.Get, new PathString("/cache/diagnostics"), out var cacheRoute));
        Assert.Null(cacheRoute.RequestFrame);
        Assert.Equal(AedsFrameType.CacheDiagnostics, cacheRoute.ResponseFrame);

        Assert.True(AuthoringEndpoints.TryResolveRoute(HttpMethods.Post, new PathString("/integrity/fix"), out var integrityRoute));
        Assert.Equal(AedsFrameType.IntegrityFixRequest, integrityRoute.RequestFrame);
        Assert.Equal(AedsFrameType.IntegrityFixResponse, integrityRoute.ResponseFrame);

        Assert.True(AuthoringEndpoints.TryResolveRoute(
            HttpMethods.Put,
            new PathString("/articles/42/revisions/9001/responsibility"),
            out var responsibilityRoute));
        Assert.Equal(AedsFrameType.ArticleResponsibilityRequest, responsibilityRoute.RequestFrame);
        Assert.Equal(AedsFrameType.ArticleResponsibilityResponse, responsibilityRoute.ResponseFrame);
    }
}
