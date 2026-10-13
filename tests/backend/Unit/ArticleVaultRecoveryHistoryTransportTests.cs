using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Real route/framing with explicit substitute ports; not native, cookie/session or product qualification.</summary>
public sealed class ArticleVaultRecoveryHistoryTransportTests
{
    private const string Digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    [Fact]
    public async Task ExactHistoricalRead_UsesCurrentPermissionAndOriginalReadersWithoutGrantsOrWrites()
    {
        Fixture fixture = new();
        using EndpointSecurityTestServer server = fixture.Server();
        using HttpClient client = server.CreateClient();
        using HttpResponseMessage response = await client.SendAsync(fixture.Message());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        byte[] bytes = await response.Content.ReadAsByteArrayAsync();
        var decoded = new AedsEncoder().TryDecode(bytes);
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ArticleVaultRecoveryHistoryResponse, decoded.Value.FrameType);
        using JsonDocument document = JsonDocument.Parse(decoded.Value.Payload.ToArray());
        Assert.True(document.RootElement.GetProperty("isHistorical").GetBoolean());
        Assert.False(document.RootElement.GetProperty("canExecute").GetBoolean());
        Assert.False(document.RootElement.GetProperty("canCommitBase").GetBoolean());
        Assert.Equal(fixture.Proposal.ContentSha256, document.RootElement.GetProperty("proposal").GetProperty("contentSha256").GetString());
        Assert.Equal(JsonValueKind.Null, document.RootElement.GetProperty("snapshot").GetProperty("materializationPreflight").ValueKind);
        Assert.Equal(2, fixture.PermissionReads);
        await fixture.Stored.CheckpointStore.Received(1).ReadThroughAsync(fixture.Stored.Operation, fixture.Stored.Bundle.Plan,
            0, fixture.Stored.Checkpoint.ContentSha256, Arg.Any<CancellationToken>());
        fixture.NoWrites();
    }

    [Theory]
    [InlineData("anonymous")]
    [InlineData("missing-permission")]
    public async Task EndpointAuthorization_RejectsBeforePrivateReads(string kind)
    {
        Fixture fixture = new();
        using EndpointSecurityTestServer server = fixture.Server();
        using HttpClient client = server.CreateClient();
        using HttpRequestMessage message = fixture.Message(authenticate: kind != "anonymous", permission: false);
        using HttpResponseMessage response = await client.SendAsync(message);
        Assert.True(response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden);
        Assert.Empty(fixture.Proposals.ReceivedCalls());
        Assert.Equal(0, fixture.PermissionReads);
    }

    [Theory]
    [InlineData("doc")]
    [InlineData("site")]
    [InlineData("device")]
    [InlineData("principal")]
    [InlineData("permission-before")]
    [InlineData("permission-after")]
    public async Task CrossScopeOrPermissionDrift_FailsClosedWithoutWriting(string mutation)
    {
        Fixture fixture = new();
        if (mutation == "doc")
            fixture.Request = fixture.Request with
            {
                ArticleId = 102
            };
        if (mutation == "site")
            fixture.TrustedSite = "other-site";
        if (mutation == "device")
            fixture.Request = fixture.Request with
            {
                Operation = fixture.Request.Operation with
                {
                    DeviceIdentity = "other-device"
                }
            };
        if (mutation == "principal")
            fixture.SetBundle(19);
        if (mutation.StartsWith("permission-", StringComparison.Ordinal))
            fixture.DenyRead = mutation == "permission-before" ? 1 : 2;
        using EndpointSecurityTestServer server = fixture.Server();
        using HttpClient client = server.CreateClient();
        using HttpResponseMessage response = await client.SendAsync(fixture.Message());
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("article_vault_recovery_history_not_authorized", (await EndpointSecurityTestServer.ReadErrorAsync(response)).Message);
        fixture.NoWrites();
    }

    [Theory]
    [InlineData("unknown")]
    [InlineData("duplicate")]
    [InlineData("nested-unknown")]
    [InlineData("wrong-frame")]
    [InlineData("plain-json")]
    public async Task ClosedPayloadAndFrame_RejectUnknownAmbiguousOrFallbackRequests(string mutation)
    {
        Fixture fixture = new();
        string json = Encoding.UTF8.GetString(ArticleVaultOperationCodec.Serialize(fixture.Request));
        if (mutation == "unknown")
            json = json[..^1] + ",\"permission\":true}";
        if (mutation == "duplicate")
            json = json[..^1] + ",\"articleId\":101}";
        if (mutation == "nested-unknown")
            json = json.Replace("\"operation\":{", "\"operation\":{\"path\":\"/tmp/forbidden\",", StringComparison.Ordinal);
        using EndpointSecurityTestServer server = fixture.Server();
        using HttpClient client = server.CreateClient();
        using HttpRequestMessage message = fixture.Message(Encoding.UTF8.GetBytes(json),
            mutation == "wrong-frame" ? AedsFrameType.AuthorDraftSaveRequest : AedsFrameType.ArticleVaultRecoveryHistoryRequest,
            plain: mutation == "plain-json");
        using HttpResponseMessage response = await client.SendAsync(message);
        Assert.NotEqual(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty(fixture.Proposals.ReceivedCalls());
        Assert.Equal(0, fixture.PermissionReads);
    }

    [Fact]
    public async Task MissingTrustedComposition_ReturnsRealUnavailableWithoutBreakingOtherAuthoring()
    {
        Fixture fixture = new();
        using EndpointSecurityTestServer server = fixture.Server(register: false);
        using HttpClient client = server.CreateClient();
        using HttpResponseMessage response = await client.SendAsync(fixture.Message());
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal("article_vault_trusted_site_composition_unavailable", (await EndpointSecurityTestServer.ReadErrorAsync(response)).Message);
    }

    private sealed class Fixture
    {
        internal ArticleVaultRecoveryCheckpointReaderTests.Fixture Stored { get; } = ArticleVaultRecoveryCheckpointReaderTests.Create();
        internal IArticleVaultResolutionProposalStore Proposals { get; } = Substitute.For<IArticleVaultResolutionProposalStore>();
        internal IAuthorRecentArticleHistoryPermissionProjectionProvider Permissions { get; } = Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>();
        internal ArticleVaultResolutionPlan Proposal
        {
            get;
        }
        internal ArticleVaultRecoveryHistoryRequest Request
        {
            get; set;
        }
        internal string TrustedSite { get; set; } = "site-one";
        internal int PermissionReads
        {
            get; private set;
        }
        internal int DenyRead
        {
            get; set;
        }

        internal Fixture()
        {
            Proposal = Stored.Resolution with
            {
                ResolutionOperationIdentity = "resolution-" + new string('a', 64)
            };
            Proposal = Proposal with
            {
                ContentSha256 = ArticleVaultResolutionPlanner.ComputeContentSha256(Proposal)
            };
            Request = new(ArticleVaultRecoveryHistoryRequestCodec.Schema, 101, Proposal.ResolutionOperationIdentity,
                Proposal.ContentSha256, Stored.Operation, 0, Stored.Checkpoint.ContentSha256);
            SetBundle(17);
            Proposals.ReadExactAsync(Proposal.ResolutionOperationIdentity, Proposal.ContentSha256, Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<ArticleVaultResolutionPlan?>(Proposal));
            Permissions.ResolveAsync(Arg.Any<AuthorRecentArticleHistoryPermissionRequest>(), Arg.Any<CancellationToken>()).Returns(call =>
            {
                PermissionReads++;
                var request = call.Arg<AuthorRecentArticleHistoryPermissionRequest>();
                AuthorRecentArticleHistoryPermissionSnapshot snapshot = new(AuthorRecentArticleHistoryPermissionSnapshotStatus.Current,
                    request.Owner, Digest, Digest,
                    Digest,
                    [new(request.ArticleIds.Single(), PermissionReads != DenyRead, PermissionReads != DenyRead,
                        Digest)], string.Empty);
                snapshot = snapshot with
                {
                    ContentDigest = AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot)
                };
                return Task.FromResult(snapshot);
            });
        }

        internal void SetBundle(long principal)
        {
            var bundle = Stored.Bundle with
            {
                AdminPrincipalId = principal
            };
            bundle = bundle with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealBundle(bundle)
            };
            Stored.ExecutionStore.LoadSealedAsync(bundle.PlanReference, bundle.PlanSha256, Arg.Any<CancellationToken>())
                .Returns(Task.FromResult<ArticleVaultSealedExecutionBundle?>(bundle));
        }

        internal EndpointSecurityTestServer Server(bool register = true)
            => EndpointSecurityTestServer.Create(new()
            {
                MapAuthoringEndpoints = true,
                ConfigureServices = services =>
                {
                    if (!register)
                        return;
                    IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(
                        new Dictionary<string, string?> { ["SITE_BASEURL"] = "https://site.example/" }).Build();
                    services.AddSingleton(new ArticleVaultRecoveryHistoryReader(Proposals, Stored.ExecutionStore,
                        new ArticleVaultRecoveryStoredProposalReader(Proposals, Stored.Reader), Permissions, configuration, TrustedSite));
                }
            });

        internal HttpRequestMessage Message(byte[]? body = null,
            AedsFrameType frame = AedsFrameType.ArticleVaultRecoveryHistoryRequest, bool plain = false,
            bool authenticate = true, bool permission = true)
        {
            body ??= ArticleVaultOperationCodec.Serialize(Request);
            var message = new HttpRequestMessage(HttpMethod.Post, "/api/binary/author/vault/recovery/history")
            {
                Content = new ByteArrayContent(plain ? body : new AedsEncoder().Encode(frame, body))
            };
            message.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));
            message.Content.Headers.ContentType = new MediaTypeHeaderValue(plain ? "application/json" : "application/octet-stream");
            if (authenticate)
                EndpointSecurityTestServer.AddAdminPrincipal(message, permission ? [AdminPermissions.ArticleWrite] : []);
            return message;
        }

        internal void NoWrites()
        {
            Assert.DoesNotContain(Proposals.ReceivedCalls(), call => call.GetMethodInfo().Name != "ReadExactAsync");
            Assert.DoesNotContain(Stored.ExecutionStore.ReceivedCalls(), call => call.GetMethodInfo().Name != "LoadSealedAsync");
            Assert.DoesNotContain(Stored.CheckpointStore.ReceivedCalls(), call => call.GetMethodInfo().Name != "ReadThroughAsync");
        }
    }
}
