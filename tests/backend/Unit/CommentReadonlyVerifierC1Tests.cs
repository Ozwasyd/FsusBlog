using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Actual gateway/seeder with read-port models; not PostgreSQL/Redis/runtime qualification.</summary>
public sealed class CommentReadonlyVerifierC1Tests
{
    private const string Secret = "comment-c1-test-secret";
    private static string Digest => $"sha256:{new string('a', 64)}";

    [Fact]
    public async Task ActualGateway_UsesIndependentReadPortsAndNoMutationPorts()
    {
        var model = new ReadModel();
        await using WebApplication app = await CreateApp(model, "Development", IPAddress.Loopback);
        using HttpResponseMessage response = await app.GetTestClient().SendAsync(Request(model.Request));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        CommentFixtureVerificationResult read = (await response.Content.ReadFromJsonAsync<CommentFixtureVerificationResult>())!;
        Assert.Equal(model.Entities.Count, read.ThreadEntities.Count);
        Assert.Equal("11", read.CacheGeneration);
        Assert.Equal(model.Request.AuthReference.Receipt.GetProperty("producerReceiptDigest").GetString(), read.AuthSourceReceiptDigest);
        Assert.Equal(2, model.CrossDomainReads);
        Assert.Equal(1, model.ThreadReads);
        Assert.Equal(1, model.ModerationReads);
        await model.AssertNoWrites();
    }

    [Theory]
    [InlineData("version")]
    [InlineData("content")]
    [InlineData("deleted")]
    [InlineData("parent")]
    [InlineData("missing")]
    [InlineData("cross-domain")]
    [InlineData("moderation")]
    public async Task ActualGateway_RejectsLiveReadDriftWithoutRepair(string kind)
    {
        var model = new ReadModel();
        await using WebApplication app = await CreateApp(model, "Development", IPAddress.Loopback);
        using HttpResponseMessage first = await app.GetTestClient().SendAsync(Request(model.Request));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        model.Drift(kind); // Mutate only the read-port model, never a fabricated response expectation.
        using HttpResponseMessage changed = await app.GetTestClient().SendAsync(Request(model.Request));
        Assert.Equal(HttpStatusCode.BadRequest, changed.StatusCode);
        string body = await changed.Content.ReadAsStringAsync();
        Assert.DoesNotContain(model.Request.Plan.RunId, body, StringComparison.Ordinal);
        Assert.DoesNotContain("threadEntities", body, StringComparison.Ordinal);
        await model.AssertNoWrites();
    }

    [Theory]
    [InlineData("run")]
    [InlineData("namespace")]
    [InlineData("session")]
    [InlineData("secret")]
    [InlineData("receipt")]
    [InlineData("canonical-body")]
    [InlineData("source")]
    [InlineData("owned-id")]
    [InlineData("roles")]
    public async Task ActualGateway_RejectsForeignOrUnsealedAuthorityBeforeReads(string kind)
    {
        var model = new ReadModel();
        CommentFixtureVerificationRequest input = model.Request;
        if (kind == "receipt")
            input = input with
            {
                AuthReference = input.AuthReference with
                {
                    Receipt = JsonSerializer.SerializeToElement(new
                    {
                        schema = "unsealed"
                    })
                }
            };
        if (kind == "canonical-body")
            input = input with
            {
                AuthReference = input.AuthReference with
                {
                    CanonicalBody = "{}"
                }
            };
        if (kind == "source")
            input = input with
            {
                PublicReference = Seal(ReceiptBody(input.Plan, "public-content", "article", "42", [], source: new string('b', 40)))
            };
        if (kind == "owned-id")
            input = input with
            {
                PublicReference = Seal(ReceiptBody(input.Plan, "public-content", "article", "999", []))
            };
        if (kind == "roles")
            input = input with
            {
                Roles = new Dictionary<string, CommentThreadFixtureObservationIdentity>()
            };
        await using WebApplication app = await CreateApp(model, "Development", IPAddress.Loopback);
        using HttpRequestMessage request = Request(input);
        string? header = kind switch
        {
            "run" => "X-Fsus-Test-Run-Id",
            "namespace" => "X-Fsus-Test-Namespace",
            "session" => HttpTestSessionKeyScope.HeaderName,
            "secret" => LocalCommentFixtureEndpoints.SecretHeaderName,
            _ => null
        };
        if (header is not null)
        {
            request.Headers.Remove(header);
            request.Headers.Add(header, "foreign");
        }
        using HttpResponseMessage response = await app.GetTestClient().SendAsync(request);
        Assert.Equal(kind == "secret" ? HttpStatusCode.Unauthorized : HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(0, model.ThreadReads);
        Assert.Equal(0, model.ModerationReads);
        Assert.Equal(0, model.CrossDomainReads);
        await model.AssertNoWrites();
    }

    [Theory]
    [InlineData("null-role")]
    [InlineData("missing-owned-comments")]
    public async Task ActualGateway_RejectsMalformedOwnershipBeforeReads(string kind)
    {
        var model = new ReadModel();
        JsonObject body = JsonSerializer.SerializeToNode(model.Request, new JsonSerializerOptions(JsonSerializerDefaults.Web))!.AsObject();
        if (kind == "null-role")
            body["roles"]!.AsObject()["approved-root"] = null;
        else
            body["cleanupReceipt"]!.AsObject().Remove("ownedComments");
        await using WebApplication app = await CreateApp(model, "Development", IPAddress.Loopback);
        using HttpRequestMessage request = Request(model.Request);
        request.Content!.Dispose();
        request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        using HttpResponseMessage response = await app.GetTestClient().SendAsync(request);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        string rejection = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain(model.Request.Plan.RunId, rejection, StringComparison.Ordinal);
        Assert.DoesNotContain("threadEntities", rejection, StringComparison.Ordinal);
        Assert.Equal(0, model.ThreadReads);
        Assert.Equal(0, model.ModerationReads);
        Assert.Equal(0, model.CrossDomainReads);
        await model.AssertNoWrites();
    }

    [Theory]
    [InlineData("Production", "127.0.0.1")]
    [InlineData("Development", "192.0.2.8")]
    public async Task ActualGateway_IsAbsentInProductionAndForNonLoopback(string environment, string remote)
    {
        var model = new ReadModel();
        await using WebApplication app = await CreateApp(model, environment, IPAddress.Parse(remote));
        using HttpResponseMessage response = await app.GetTestClient().SendAsync(Request(model.Request));
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(0, model.ThreadReads);
        await model.AssertNoWrites();
    }

    private static async Task<WebApplication> CreateApp(ReadModel model, string environment, IPAddress remote)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = environment });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["fsus:allowLocalCommentFixture"] = "true",
            ["fsus:localCommentFixtureSecret"] = Secret
        });
        builder.Services.AddSingleton<ICommentFixtureSeeder>(model.Seeder);
        WebApplication app = builder.Build();
        Assert.Equal(environment, app.Environment.EnvironmentName);
        app.Use(async (context, next) => { context.Connection.RemoteIpAddress = remote; await next(); });
        app.MapLocalCommentFixtureEndpoints();
        if (environment == "Production")
        {
            Assert.DoesNotContain(((IEndpointRouteBuilder)app).DataSources.SelectMany(item => item.Endpoints),
                endpoint => endpoint is RouteEndpoint route && route.RoutePattern.RawText == "/api/local/comment-fixture/verify");
        }
        app.MapFallback(() => Microsoft.AspNetCore.Http.Results.NotFound());
        await app.StartAsync();
        return app;
    }

    private static HttpRequestMessage Request(CommentFixtureVerificationRequest body)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/local/comment-fixture/verify") { Content = JsonContent.Create(body) };
        // Exercise routing rather than Production's unrelated localhost HostFilter rejection.
        request.Headers.Host = "fsus.blog";
        request.Headers.Add(LocalCommentFixtureEndpoints.SecretHeaderName, Secret);
        request.Headers.Add("X-Fsus-Test-Run-Id", body.Plan.RunId);
        request.Headers.Add("X-Fsus-Test-Namespace", body.Plan.Namespace);
        request.Headers.Add(HttpTestSessionKeyScope.HeaderName, body.Plan.TestSession);
        return request;
    }

    private static CommentFixtureSealedReference Seal(JsonObject unsigned)
    {
        string canonical = unsigned.ToJsonString(new JsonSerializerOptions { WriteIndented = false });
        unsigned["producerReceiptDigest"] = $"sha256:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant()}";
        return new CommentFixtureSealedReference(JsonSerializer.SerializeToElement(unsigned), canonical);
    }

    private static JsonObject ReceiptBody(CommentFixturePlan plan, string producerId, string kind, string id, string[] roles, string? source = null)
    {
        JsonArray entities = [];
        if (roles.Length == 0)
        {
            entities.Add(new JsonObject { ["kind"] = kind, ["id"] = id, ["owned"] = true });
        }
        foreach (string role in roles)
        {
            entities.Add(new JsonObject
            {
                ["kind"] = role == "admin" ? "admin" : "user",
                ["id"] = role == "admin" ? "7" : role == "primary-author" ? "11" : "12",
                ["semanticRole"] = $"consumer.comment-moderation.{role}",
                ["fixtureIdentity"] = $"fixture-{role}",
                ["owned"] = true
            });
        }
        return new JsonObject
        {
            ["schema"] = "fsusblog.fixture-producer-receipt.v1",
            ["producerId"] = producerId,
            ["strategy"] = "transaction-fixture",
            ["runId"] = plan.RunId,
            ["namespace"] = plan.Namespace,
            ["profileId"] = plan.ProfileId,
            ["source"] = new JsonObject { ["commit"] = source ?? new string('a', 40), ["worktreeFingerprint"] = Digest },
            ["fixtureCatalogDigest"] = Digest,
            ["serviceGeneration"] = Digest,
            ["expandedCapabilityDigest"] = plan.CapabilityCatalogDigest,
            ["variantPlanDigest"] = plan.VariantCatalogDigest,
            ["postconditionObservations"] = new JsonArray(new JsonObject { ["ok"] = true }),
            ["entityIdentities"] = entities.DeepClone(),
            ["observations"] = new JsonObject { ["database"] = new JsonObject { ["entities"] = entities } }
        };
    }

    private static JsonElement AuthReferences(CommentFixturePlan plan, CommentFixtureSealedReference auth)
    {
        static JsonObject WithDigest(JsonObject body)
        {
            body["digest"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(body.ToJsonString()))).ToLowerInvariant();
            return body;
        }
        JsonArray references = [];
        string[] roles = ["admin", "primary-author", "secondary-author"];
        for (int i = 0; i < roles.Length; i++)
        {
            string role = roles[i];
            references.Add(WithDigest(new JsonObject
            {
                ["schema"] = "fsusblog.fixture-identity-reference.v1",
                ["verified"] = true,
                ["ownerProducerId"] = "auth-session",
                ["consumerProducerId"] = "comment-moderation",
                ["runId"] = plan.RunId,
                ["namespace"] = plan.Namespace,
                ["profileId"] = plan.ProfileId,
                ["role"] = role,
                ["semanticRole"] = $"consumer.comment-moderation.{role}",
                ["capabilityId"] = i == 0 ? "auth.admin.full-permission" : "auth.user.active",
                ["publicId"] = i == 0 ? "7" : i == 1 ? "11" : "12",
                ["fixtureIdentity"] = $"fixture-{role}",
                ["producerResultDigest"] = plan.IdentityReferences.AuthProducerResultDigest[7..],
                ["sourceReceiptDigest"] = auth.Receipt.GetProperty("producerReceiptDigest").GetString(),
                ["prepareReferenceDigest"] = plan.IdentityReferences.AuthPrepareReferenceDigests[i][7..],
                ["planDigests"] = new JsonObject()
            }));
        }
        return JsonSerializer.SerializeToElement(WithDigest(new JsonObject
        {
            ["schema"] = "fsusblog.fixture-identity-references.v1",
            ["verified"] = true,
            ["ownerProducerId"] = "auth-session",
            ["consumerProducerId"] = "comment-moderation",
            ["runId"] = plan.RunId,
            ["namespace"] = plan.Namespace,
            ["profileId"] = plan.ProfileId,
            ["sourceReceiptDigest"] = auth.Receipt.GetProperty("producerReceiptDigest").GetString(),
            ["references"] = references
        }));
    }

    private sealed class ReadModel
    {
        public ICommentThreadFixturePort Threads { get; } = Substitute.For<ICommentThreadFixturePort>();
        public ICommentModerationFixturePort Moderation { get; } = Substitute.For<ICommentModerationFixturePort>();
        public CommentFixtureSeeder Seeder
        {
            get;
        }
        public CommentFixtureVerificationRequest Request
        {
            get;
        }
        public List<CommentThreadFixtureEntity> Entities { get; } = [];
        public int ThreadReads
        {
            get; private set;
        }
        public int ModerationReads
        {
            get; private set;
        }
        public int CrossDomainReads
        {
            get; private set;
        }
        private bool _crossDomainDrift;
        private bool _moderationDrift;

        public ReadModel()
        {
            IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["CommentThreads:MaxDepth"] = "2" }).Build();
            Seeder = new CommentFixtureSeeder(Threads, Moderation, configuration, TimeProvider.System);
            var plan = new CommentFixturePlan("fsusblog.comment-fixture-plan.v1", "comment-moderation", "transaction-fixture",
                "c1-test-run", "c1-test-ns", "c1-test-session", "comments-moderation",
                ["comment.moderation-matrix", "comment.threaded", "moderation.policy-matrix"],
                new CommentFixtureIdentityReferences(11, 12, 7, Digest, [Digest, $"sha256:{new string('b', 64)}", $"sha256:{new string('c', 64)}"]) { AdminActorReferenceDigest = Digest },
                new CommentFixtureArticleReference(42, Digest, Digest), Digest, Digest, Digest, Digest, Digest, Digest);
            var binding = new CommentFixturePortBinding(plan.RunId, plan.Namespace, plan.TestSession, $"comment-fixture:{plan.Namespace}:{plan.RunId}",
                plan.ProfileId, plan.Capabilities, 42, Digest, plan.IdentityReferences.AuthPrepareReferenceDigests, Digest, Digest, Digest, Digest, Digest, Digest, Digest, Digest);
            string[] names = ["approved-root", "approved-reply", "approved-nested", "pending", "rejected", "spam", "edited", "deleted-root",
                "deleted-root-child", "deleted-reply-parent", "deleted-reply", "region-global", "region-manual-review", "depth-root", "depth-1", "depth-2"];
            var ids = names.Select((name, index) => (name, id: 1000L + index)).ToDictionary(item => item.name, item => item.id);
            foreach (string name in names)
            {
                string? parent = name switch
                {
                    "approved-reply" => "approved-root",
                    "approved-nested" => "approved-reply",
                    "deleted-root-child" => "deleted-root",
                    "deleted-reply" => "deleted-reply-parent",
                    "depth-1" => "depth-root",
                    "depth-2" => "depth-1",
                    _ => null
                };
                string root = name is "approved-reply" or "approved-nested" ? "approved-root" : name == "deleted-root-child" ? "deleted-root"
                    : name == "deleted-reply" ? "deleted-reply-parent" : name.StartsWith("depth-", StringComparison.Ordinal) ? "depth-root" : name;
                string capability = name switch
                {
                    "edited" => "comment.version.edited",
                    "deleted-root" => "comment.delete.root",
                    "pending" => "comment.moderation.pending",
                    "region-manual-review" => "moderation.region-policy",
                    "approved-nested" => "comment.thread.nested",
                    "approved-reply" or "deleted-root-child" or "deleted-reply" => "comment.thread.reply",
                    _ => name.StartsWith("depth-", StringComparison.Ordinal) ? "comment.thread.depth-boundary" : "comment.thread.root"
                };
                bool anonymous = name is "pending" or "region-manual-review";
                int? account = anonymous ? null : name is "approved-root" or "rejected" or "edited" or "deleted-reply-parent" or "approved-nested" or "deleted-root-child" or "depth-2" ? 11 : 12;
                Entities.Add(new CommentThreadFixtureEntity(name, ids[name], 42, anonymous ? "zk_anonymous" : "public", account, ids[root], parent is null ? null : ids[parent], parent is null ? null : ids[parent],
                    name is "approved-nested" or "depth-2" ? 2 : parent is null ? 0 : 1, 1, false, "approved", Digest, [], true, [], Digest, capability, [], "article:42", "11"));
            }
            var roles = Entities.ToDictionary(item => item.SemanticRole, item => new CommentThreadFixtureObservationIdentity(item.CommentId, item.AccountId, item.ActorMode, item.OperationPlanDigest, item.CapabilityId));
            var owned = Entities.ToDictionary(item => item.CommentId, item => new CommentThreadFixtureOwnedIdentity(item.CommentId, 42, item.SemanticRole, item.ActorMode, item.AccountId,
                item.ContentDigest, item.CurrentVersion, item.IsDeleted, item.OperationPlanDigest));
            var sentinel = new CommentFixtureCrossDomainSentinel("fsusblog.comment-fixture-cross-domain-sentinel.v1", 42, [11, 12], 7, Digest, Digest, Digest, Digest);
            CommentFixtureSealedReference auth = Seal(ReceiptBody(plan, "auth-session", "user", "11", ["admin", "primary-author", "secondary-author"]));
            Request = new CommentFixtureVerificationRequest("fsusblog.comment-fixture-verification-request.v1", plan,
                new CommentThreadFixtureCleanupReceipt("fsusblog.comment-thread-fixture-cleanup.v1", binding, owned, sentinel), roles,
                auth, Seal(ReceiptBody(plan, "public-content", "article", "42", [])), AuthReferences(plan, auth));
            Threads.ObserveCurrentAsync(Arg.Any<CommentThreadFixtureObservationPlan>(), Arg.Any<CancellationToken>()).Returns(_ => { ThreadReads++; return Entities.ToArray(); });
            Threads.ObserveCrossDomainAsync(42, Arg.Any<IReadOnlyList<int>>(), 7, Arg.Any<CancellationToken>()).Returns(_ => { CrossDomainReads++; return _crossDomainDrift ? sentinel with { AuthDigest = $"sha256:{new string('b', 64)}" } : sentinel; });
            Moderation.ObserveCurrentAsync(Arg.Any<CommentModerationFixturePlan>(), Arg.Any<CancellationToken>()).Returns(call =>
            {
                ModerationReads++;
                if (_moderationDrift)
                {
                    throw new InvalidOperationException("live moderation model drift");
                }
                CommentModerationFixturePlan readPlan = call.Arg<CommentModerationFixturePlan>();
                return new CommentModerationFixtureResult("fsusblog.comment-moderation-fixture-result.v1", readPlan.Binding,
                    new CommentFixtureRuntimeSemantics("fsusblog.comment-fixture-runtime-semantics.v1",
                        new Dictionary<string, string>(), new Dictionary<string, string>(), "rejected", "evidence", "read-port-model"), []);
            });
            Moderation.ReadCommentCacheGenerationAsync(42, Arg.Any<CancellationToken>()).Returns("11");
        }

        public void Drift(string kind)
        {
            if (kind == "cross-domain")
            {
                _crossDomainDrift = true;
                return;
            }
            if (kind == "moderation")
            {
                _moderationDrift = true;
                return;
            }
            if (kind == "missing")
            {
                Entities.RemoveAt(0);
                return;
            }
            Entities[0] = kind switch
            {
                "version" => Entities[0] with { CurrentVersion = 2 },
                "content" => Entities[0] with { ContentDigest = "changed" },
                "deleted" => Entities[0] with { IsDeleted = true },
                "parent" => Entities[0] with { ParentId = 999 },
                _ => throw new ArgumentException(kind)
            };
        }

        public async Task AssertNoWrites()
        {
            await Threads.DidNotReceiveWithAnyArgs().ExecuteAsync(default!, default);
            await Threads.DidNotReceiveWithAnyArgs().CleanupAsync(default!, default);
            await Moderation.DidNotReceiveWithAnyArgs().ExecuteAsync(default!, default);
            await Moderation.DidNotReceiveWithAnyArgs().TransitionAsync(default!, default, default!, default);
            Moderation.DidNotReceiveWithAnyArgs().AcquireRuntimeState(default!, default!);
            Moderation.DidNotReceiveWithAnyArgs().RestoreRuntimeState(default!);
        }
    }
}
