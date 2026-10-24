using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringNativeAedsEndpointTests
{
    [Fact]
    public async Task PreviewEndpoint_EncodesStructuredFrame94WithoutHtml()
    {
        const string SourceIdentity =
            "preview:sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        var preview = new ArticlePreviewResponse(
            "Normalized title",
            "Normalized summary",
            "/uploads/cover.webp",
            "# Markdown\n\n| key | value |\n| --- | --- |\n| safe | yes |",
            "Markdown key value safe yes",
            SourceIdentity,
            [new PrepublishIssue("warning", "summary_short", "Summary is short")]);
        IAuthoringDraftLifecycle lifecycle = Substitute.For<IAuthoringDraftLifecycle>();
        lifecycle.PreviewAsync(Arg.Any<ServerDraftSaveRequest>())
            .Returns(preview);
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create(
            new EndpointSecurityTestServerOptions
            {
                MapAuthoringEndpoints = true,
                ConfigureServices = services =>
                {
                    services.RemoveAll<IAuthoringDraftLifecycle>();
                    services.AddSingleton(lifecycle);
                }
            });
        using HttpClient client = server.CreateClient();
        var requestBody = new ServerDraftSaveRequest(
            "preview-endpoint-contract",
            null,
            "Title",
            "# Markdown",
            "Summary",
            "/uploads/cover.webp",
            1,
            [],
            "client-revision",
            0,
            null);
        byte[] requestPayload = JsonSerializer.SerializeToUtf8Bytes(
            requestBody,
            new JsonSerializerOptions(JsonSerializerDefaults.Web));
        byte[] requestFrame = new AedsEncoder().Encode(
            AedsFrameType.ArticlePreviewRequest,
            requestPayload);
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/binary/author/preview")
        {
            Content = new ByteArrayContent(requestFrame)
        };
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        EndpointSecurityTestServer.AddAdminPrincipal(request, AdminPermissions.ArticleWrite);

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("application/octet-stream", response.Content.Headers.ContentType?.MediaType);
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(
            await response.Content.ReadAsByteArrayAsync());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(AedsFrameType.ArticlePreviewResponse, decoded.Value.FrameType);
        Assert.Equal(94, (ushort)decoded.Value.FrameType);

        using JsonDocument payload = JsonDocument.Parse(decoded.Value.Payload);
        JsonElement root = payload.RootElement;
        Assert.Equal(
            [
                "issues",
                "normalizedCoverImageUrl",
                "normalizedMarkdownSource",
                "normalizedSummary",
                "normalizedTitle",
                "plainText",
                "sourceIdentity"
            ],
            root.EnumerateObject()
                .Select(static property => property.Name)
                .Order(StringComparer.Ordinal));
        Assert.Equal(preview.NormalizedTitle, root.GetProperty("normalizedTitle").GetString());
        Assert.Equal(preview.NormalizedSummary, root.GetProperty("normalizedSummary").GetString());
        Assert.Equal(preview.NormalizedCoverImageUrl, root.GetProperty("normalizedCoverImageUrl").GetString());
        Assert.Equal(preview.NormalizedMarkdownSource, root.GetProperty("normalizedMarkdownSource").GetString());
        Assert.Equal(preview.PlainText, root.GetProperty("plainText").GetString());
        Assert.Equal(SourceIdentity, root.GetProperty("sourceIdentity").GetString());
        JsonElement issue = Assert.Single(root.GetProperty("issues").EnumerateArray());
        Assert.Equal("warning", issue.GetProperty("severity").GetString());
        Assert.Equal("summary_short", issue.GetProperty("code").GetString());
        Assert.Equal("Summary is short", issue.GetProperty("message").GetString());
        Assert.DoesNotContain(
            root.EnumerateObject(),
            static property => string.Equals(property.Name, "html", StringComparison.OrdinalIgnoreCase));
    }

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

        Assert.True(AuthoringEndpoints.TryResolveRoute(
            HttpMethods.Post,
            new PathString("/comments/88001/moderation/claim"),
            out var claimRoute));
        Assert.Equal(AedsFrameType.CommentModerationClaimRequest, claimRoute.RequestFrame);
        Assert.Equal(AedsFrameType.CommentModerationClaimResponse, claimRoute.ResponseFrame);

        Assert.True(AuthoringEndpoints.TryResolveRoute(
            HttpMethods.Post,
            new PathString("/comments/88001/moderation/claim/renew"),
            out var renewRoute));
        Assert.Equal(AedsFrameType.CommentModerationClaimMutationRequest, renewRoute.RequestFrame);
        Assert.Equal(AedsFrameType.CommentModerationClaimResponse, renewRoute.ResponseFrame);
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
            HttpMethods.Get,
            new PathString("/plugins"),
            out var pluginListRoute));
        Assert.Null(pluginListRoute.RequestFrame);
        Assert.Equal(AedsFrameType.PluginAdminSnapshot, pluginListRoute.ResponseFrame);

        Assert.True(AuthoringEndpoints.TryResolveRoute(
            HttpMethods.Post,
            new PathString("/plugins/install"),
            out var pluginInstallRoute));
        Assert.Equal(AedsFrameType.PluginPackageInstallRequest, pluginInstallRoute.RequestFrame);
        Assert.Equal(AedsFrameType.PluginAdminSnapshot, pluginInstallRoute.ResponseFrame);

        Assert.True(AuthoringEndpoints.TryResolveRoute(
            HttpMethods.Post,
            new PathString("/plugins/fsusblog.plugin.example/actions"),
            out var pluginActionRoute));
        Assert.Equal(AedsFrameType.PluginAdminMutationRequest, pluginActionRoute.RequestFrame);
        Assert.Equal(AedsFrameType.PluginAdminSnapshot, pluginActionRoute.ResponseFrame);

        Assert.True(AuthoringEndpoints.TryResolveRoute(
            HttpMethods.Put,
            new PathString("/articles/42/revisions/9001/responsibility"),
            out var responsibilityRoute));
        Assert.Equal(AedsFrameType.ArticleResponsibilityRequest, responsibilityRoute.RequestFrame);
        Assert.Equal(AedsFrameType.ArticleResponsibilityResponse, responsibilityRoute.ResponseFrame);
    }
}
