using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Original-project controls; controlled Current observations do not qualify canonical storage or registration.</summary>
[Trait("Category", "Unit")]
public sealed class ArticlePackageCandidateReviewWireValidationTests
{
    private const string RequestJson = """
        {"requestId":"wire-read","archiveBytes":"AQ==","requestedMode":"CreateNew","callerPolicyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","callerPermissionContextDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","createdAtUtc":"2026-10-09T01:02:03Z","expiresAtUtc":"2026-10-10T01:02:03Z","requestedTargets":null,"pageIndex":0,"pageSize":50,"expectedPlanDigest":null,"expectedContext":null}
        """;
    private const string ResponseJson = """
        {"requestId":"wire-read","review":{"candidateStatus":"finite_bytes_validated","summary":{"articleCount":1,"fileCount":3,"schemaVersion":1,"canonicalHashVersion":1,"propertySchemaVersion":1,"packageBytesDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","manifestSemanticDigest":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","checksumComponentDigest":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"requestedMode":"CreateNew","policyDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","createdAtUtc":"2026-10-09T01:02:03.0000000Z","expiresAtUtc":"2026-10-10T01:02:03.0000000Z","intervalStatus":"caller_interval_current","planDigest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","pageIndex":0,"pageSize":50,"totalTargets":1,"targets":[{"portableArticle":"article:11111111-1111-1111-1111-111111111111","requiresNewIdentity":true,"requestedTargetArticleId":null,"expectedTargetRevision":null}],"requiredAuthorities":["archive_intake","complete_package_schema","canonical_source_and_property_provenance","fsusui_syntax_dependencies","persisted_relation_and_embed_plan","frozen_public_projection_retention","asset_and_dependency_resolution","rights_responsibility_taxonomy_privacy","current_actor_site_target_permissions","current_target_revision_and_identity","execution_qualification"],"executeDisabled":true,"executionReasonCode":"article_package_import_authority_unavailable"},"context":{"identity":"fsus-site:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","lifecycleVersion":1,"generation":2,"mappingRevision":7,"scopeRevision":3}}
        """;

    [Fact]
    public void LiteralSeedAndReadonlyProjection_PreserveCorrelationWithoutAuthority()
    {
        Assert.True(ReadRequest(RequestJson, out var request));
        Assert.True(ReadResponse(ResponseJson, out var response));
        Assert.True(ArticlePackageCandidateReviewWireValidation.IsCorrelated(request!, response!));
        Assert.True(response!.Review.ExecuteDisabled);
        Assert.Equal("article_package_import_authority_unavailable", response.Review.ExecutionReasonCode);
        Assert.Equal(288, ArticlePackageCandidateReviewWireValidation.ReservedRequestFrame);
        Assert.Equal(289, ArticlePackageCandidateReviewWireValidation.ReservedResponseFrame);
    }

    [Theory]
    [InlineData("requestId", "null")]
    [InlineData("pageSize", "0")]
    [InlineData("pageSize", "51")]
    [InlineData("pageSize", "\"50\"")]
    [InlineData("pageSize", "1.0")]
    [InlineData("pageIndex", "9007199254740992")]
    [InlineData("requestedMode", "\"Execute\"")]
    [InlineData("archiveBytes", "\"AR==\"")]
    [InlineData("archiveBytes", "\"AQ== \"")]
    [InlineData("callerPolicyDigest", "\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"")]
    [InlineData("createdAtUtc", "\"2026-02-30T01:02:03Z\"")]
    [InlineData("createdAtUtc", "\"2026-10-09T01:02:03+00:00\"")]
    [InlineData("createdAtUtc", "\"2026-10-09T01:02:03Z\\n\"")]
    [InlineData("callerPolicyDigest", "\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n\"")]
    [InlineData("expiresAtUtc", "\"2026-10-09T01:02:03Z\"")]
    [InlineData("expectedPlanDigest", "\"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\"")]
    public void RequestWrongPrimitiveBudgetAndIntent_AreRefused(string property, string raw)
    {
        JsonNode root = JsonNode.Parse(RequestJson)!;
        root[property] = JsonNode.Parse(raw);
        Assert.False(ReadRequest(root.ToJsonString(), out var request));
        Assert.Null(request);
    }

    [Fact]
    public void RequestAndEveryNestedResponse_RejectUnknownDuplicateAndMissingProperties()
    {
        JsonNode request = JsonNode.Parse(RequestJson)!;
        request["adminSession"] = "private-canary";
        Assert.False(ReadRequest(request.ToJsonString(), out _));
        Assert.False(ReadRequest(RequestJson.Replace("\"pageSize\":50", "\"pageSize\":50,\"pageSize\":50", StringComparison.Ordinal), out _));
        Assert.False(ReadRequest(RequestJson.Replace("\"pageSize\":50,", "", StringComparison.Ordinal), out _));
        foreach (string path in new[] { "root", "review", "summary", "target", "context" })
        {
            JsonNode root = JsonNode.Parse(ResponseJson)!;
            JsonObject selected = (path switch
            {
                "root" => root,
                "review" => root["review"],
                "summary" => root["review"]!["summary"],
                "target" => root["review"]!["targets"]![0],
                _ => root["context"]
            })!.AsObject();
            selected["privateSource"] = "private-canary";
            Assert.False(ReadResponse(root.ToJsonString(), out _));
            selected.Remove("privateSource");
            string key = selected.First().Key;
            string serialized = root.ToJsonString();
            string member = JsonSerializer.Serialize(key) + ":" + selected[key]!.ToJsonString();
            Assert.False(ReadResponse(serialized.Replace(member, member + "," + member, StringComparison.Ordinal), out _));
            selected.Remove(key);
            Assert.False(ReadResponse(root.ToJsonString(), out _));
            selected[key] = null;
            Assert.False(ReadResponse(root.ToJsonString(), out _));
        }
    }

    [Theory]
    [InlineData("0")]
    [InlineData("01")]
    [InlineData("+1")]
    [InlineData("-1")]
    [InlineData("1.0")]
    [InlineData("9223372036854775808")]
    [InlineData("1\n")]
    public void NestedTargetRevision_RefusesNoncanonicalInt64Strings(string revision)
    {
        JsonNode request = UpdateRequest(revision);
        Assert.False(ReadRequest(request.ToJsonString(), out _));
        JsonNode response = UpdateResponse(revision);
        Assert.False(ReadResponse(response.ToJsonString(), out _));
    }

    [Fact]
    public void ExactInt64AndReplayContext_RemainStringsAndRejectDrift()
    {
        Assert.True(ReadRequest(UpdateRequest("9223372036854775807").ToJsonString(), out var request));
        Assert.True(ReadResponse(UpdateResponse("9223372036854775807").ToJsonString(), out var response));
        Assert.Equal("9223372036854775807", response!.Review.Targets[0].ExpectedTargetRevision);
        Assert.True(ArticlePackageCandidateReviewWireValidation.IsCorrelated(request!, response));
        Assert.False(ArticlePackageCandidateReviewWireValidation.IsCorrelated(request!, response with { RequestId = "late-read" }));
        Assert.False(ArticlePackageCandidateReviewWireValidation.IsCorrelated(request!, response with { Context = response.Context with { Generation = 3 } }));
        Assert.False(ArticlePackageCandidateReviewWireValidation.IsCorrelated(request!, response with { Review = response.Review with { PlanDigest = new string('a', 64) } }));
        JsonNode nested = UpdateRequest("1");
        nested["requestedTargets"]![0]!["privateScope"] = "private-canary";
        Assert.False(ReadRequest(nested.ToJsonString(), out _));
        nested = UpdateRequest("1");
        nested["expectedContext"]!["scopeRevision"] = 8;
        Assert.False(ReadRequest(nested.ToJsonString(), out _));
        nested = UpdateRequest("1");
        nested["expectedContext"]!["scope"] = "private-canary";
        Assert.False(ReadRequest(nested.ToJsonString(), out _));
        string closedRequest = UpdateRequest("1").ToJsonString();
        Assert.False(ReadRequest(closedRequest.Replace("\"generation\":2", "\"generation\":2,\"generation\":2", StringComparison.Ordinal), out _));
        Assert.False(ReadRequest(closedRequest.Replace("\"expectedTargetRevision\":\"1\"", "\"expectedTargetRevision\":1", StringComparison.Ordinal), out _));
    }

    [Fact]
    public void RequestedTargetCountAndBijection_UseOriginalThousandTargetLimit()
    {
        JsonNode root = UpdateRequest("1");
        var targets = new JsonArray();
        for (int index = 1; index <= 1000; index++)
        {
            targets.Add(new JsonObject
            {
                ["portableArticle"] = $"article:{index:x8}-1111-1111-1111-111111111111",
                ["requestedTargetArticleId"] = index,
                ["expectedTargetRevision"] = "1"
            });
        }
        root["requestedTargets"] = targets;
        Assert.True(ReadRequest(root.ToJsonString(), out _));
        targets.Add(targets[0]!.DeepClone());
        Assert.False(ReadRequest(root.ToJsonString(), out _));
        targets.RemoveAt(1000);
        targets[1]!["requestedTargetArticleId"] = 1;
        Assert.False(ReadRequest(root.ToJsonString(), out _));
        JsonNode portable = UpdateRequest("1");
        portable["requestedTargets"]![0]!["portableArticle"] = "article:11111111-1111-1111-1111-111111111111\n";
        Assert.False(ReadRequest(portable.ToJsonString(), out _));
    }

    [Fact]
    public void Utf16ArchiveAndCompleteFrameBudgets_AreExact()
    {
        JsonNode request = JsonNode.Parse(RequestJson)!;
        request["requestId"] = string.Concat(Enumerable.Repeat("😀", 64));
        request["archiveBytes"] = Convert.ToBase64String(new byte[524288]);
        Assert.True(ReadRequest(request.ToJsonString(), out _));
        request["requestId"] = string.Concat(Enumerable.Repeat("😀", 65));
        Assert.False(ReadRequest(request.ToJsonString(), out _));
        request["requestId"] = "wire-read";
        request["archiveBytes"] = Convert.ToBase64String(new byte[524289]);
        Assert.False(ReadRequest(request.ToJsonString(), out _));
        byte[] original = Encoding.UTF8.GetBytes(RequestJson);
        byte[] boundary = Enumerable.Repeat((byte)' ', 1048576 - 16).ToArray();
        original.CopyTo(boundary, 0);
        Assert.True(ArticlePackageCandidateReviewWireValidation.TryReadRequest(boundary, out _));
        Assert.False(ArticlePackageCandidateReviewWireValidation.TryReadRequest([.. boundary, (byte)' '], out _));
        Assert.False(ReadRequest(RequestJson.Replace("wire-read", "\\ud800", StringComparison.Ordinal), out _));
        Assert.False(ArticlePackageCandidateReviewWireValidation.TryReadRequest([0xff], out _));
    }

    [Fact]
    public void ResponseExecuteGrantPrivateScopeAndUnknownAuthority_AreRefused()
    {
        foreach (string field in new[] { "archiveBytes", "title", "source", "scopes", "credential", "receipt" })
        {
            JsonNode root = JsonNode.Parse(ResponseJson)!;
            root[field] = "private-canary";
            Assert.False(ReadResponse(root.ToJsonString(), out _));
        }
        Assert.False(ReadResponse(ResponseJson.Replace("\"executeDisabled\":true", "\"executeDisabled\":false", StringComparison.Ordinal), out _));
        Assert.False(ReadResponse(ResponseJson.Replace("execution_qualification", "execution_granted", StringComparison.Ordinal), out _));
        Assert.False(ReadResponse(ResponseJson.Replace("\"totalTargets\":1", "\"totalTargets\":2", StringComparison.Ordinal), out _));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task EndpointOriginalFrameHelper_RefusesCompleteOversizeKnownAndUnknownBodies(bool contentLength)
    {
        byte[] payload = Enumerable.Repeat((byte)' ', 1048576 - 15).ToArray();
        await using EndpointCase owned = Endpoint(new AedsEncoder().Encode((AedsFrameType)288, payload), contentLength);
        await owned.Execute();
        Assert.Equal(400, owned.Context.Response.StatusCode);
        Assert.Equal(0, owned.Reader.Calls);
    }

    [Fact]
    public async Task UnknownLengthTrailingBodyAndOpenShape_RefuseBeforeReader()
    {
        byte[] frame = new AedsEncoder().Encode((AedsFrameType)288, Encoding.UTF8.GetBytes(RequestJson));
        await using (EndpointCase owned = Endpoint([.. frame, (byte)' '], false))
        {
            await owned.Execute();
            Assert.Equal(400, owned.Context.Response.StatusCode);
            Assert.Equal(0, owned.Reader.Calls);
        }
        await using (EndpointCase owned = Endpoint(new AedsEncoder().Encode((AedsFrameType)288,
            Encoding.UTF8.GetBytes(RequestJson.Replace("\"pageSize\":50", "\"pageSize\":50,\"pageSize\":50", StringComparison.Ordinal))), false))
        {
            await owned.Execute();
            Assert.Equal(400, owned.Context.Response.StatusCode);
            Assert.Equal(0, owned.Reader.Calls);
        }
    }

    [Fact]
    public async Task EndpointOriginalProducer_PreservesAuthContextCorrelationAndRefusal()
    {
        JsonNode request = JsonNode.Parse(RequestJson)!;
        request["archiveBytes"] = Convert.ToBase64String(Archive());
        await using EndpointCase owned = Endpoint(new AedsEncoder().Encode((AedsFrameType)288, Encoding.UTF8.GetBytes(request.ToJsonString())), false);
        await owned.Execute();
        byte[] frame = ((MemoryStream)owned.Context.Response.Body).ToArray();
        Assert.Equal(200, owned.Context.Response.StatusCode);
        Assert.Equal(289, BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(8)));
        Assert.True(ReadRequest(request.ToJsonString(), out var input));
        Assert.True(ArticlePackageCandidateReviewWireValidation.TryReadResponse(frame.AsMemory(16), out var response));
        Assert.True(ArticlePackageCandidateReviewWireValidation.IsCorrelated(input!, response!));
        Assert.Equal(2, owned.Reader.Calls);
        Assert.DoesNotContain("controlled-session", Encoding.UTF8.GetString(frame), StringComparison.Ordinal);
        Assert.DoesNotContain("controlled.example", Encoding.UTF8.GetString(frame), StringComparison.Ordinal);
    }

    [Fact]
    public async Task EndpointInitializationRequiredAndStorageFailure_RemainPrivateRefusals()
    {
        byte[] frame = new AedsEncoder().Encode((AedsFrameType)288, Encoding.UTF8.GetBytes(RequestJson));
        await using (EndpointCase owned = Endpoint(frame, false))
        {
            owned.Reader.State = SystemSiteIdentityState.InitializationRequired;
            await owned.Execute();
            Assert.Equal(400, owned.Context.Response.StatusCode);
            Assert.Contains("article_package_candidate_review_site_unavailable", Encoding.UTF8.GetString(((MemoryStream)owned.Context.Response.Body).ToArray()));
        }
        await using (EndpointCase owned = Endpoint(frame, false))
        {
            owned.Reader.Fail = true;
            await owned.Execute();
            Assert.Equal(500, owned.Context.Response.StatusCode);
            Assert.DoesNotContain("private-canary", Encoding.UTF8.GetString(((MemoryStream)owned.Context.Response.Body).ToArray()));
        }
    }

    [Theory]
    [InlineData("anonymous", 401)]
    [InlineData("non-admin", 403)]
    [InlineData("invalid-id", 403)]
    [InlineData("missing-session", 403)]
    [InlineData("missing-permission", 403)]
    public async Task EndpointIdentityDenial_UsesOriginalStatusBeforeBodyOrReader(string input, int status)
    {
        await using EndpointCase owned = Endpoint([], false);
        await owned.Context.Request.Body.DisposeAsync();
        var unread = new UnreadBody();
        owned.Context.Request.Body = unread;
        var claims = new List<Claim>
        {
            new("identity_kind", input == "non-admin" ? "user" : AnonymousIdentityRuntime.AdminPrincipalKind),
            new("admin_id", input == "invalid-id" ? "0" : "73")
        };
        if (input != "missing-session")
        {
            claims.Add(new("admin_sid", "controlled-session"));
        }
        if (input != "missing-permission")
        {
            claims.Add(new(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite));
        }
        owned.Context.User = input == "anonymous" ? new() : new(new ClaimsIdentity(claims, "controlled-unit"));
        await owned.Execute();
        Assert.Equal(status, owned.Context.Response.StatusCode);
        Assert.Equal(0, unread.Reads);
        Assert.Equal(0, owned.Reader.Calls);
        var decoded = new AedsEncoder().TryDecode(((MemoryStream)owned.Context.Response.Body).ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var error));
        Assert.Equal(input == "anonymous" ? "UNAUTHORIZED" : "article_package_candidate_review_access_denied",
            PodBinaryCodec.ToErrorDetail(error).Message);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EndpointCallerOrRequestAbort_ProducesNoResponseBodyOrIdentityRead(bool requestAborted)
    {
        await using EndpointCase owned = Endpoint([], false);
        await owned.Context.Request.Body.DisposeAsync();
        var unread = new UnreadBody();
        owned.Context.Request.Body = unread;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        if (requestAborted)
        {
            owned.Context.RequestAborted = cancellation.Token;
        }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            owned.Execute(requestAborted ? CancellationToken.None : cancellation.Token));
        Assert.Equal(0, unread.Reads);
        Assert.Equal(0, owned.Reader.Calls);
        Assert.Equal(0, owned.Context.Response.Body.Length);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task EndpointAbortDuringOriginalIdentityRead_ProducesNoResponse(int cancelledRead)
    {
        JsonNode request = JsonNode.Parse(RequestJson)!;
        request["archiveBytes"] = Convert.ToBase64String(Archive());
        await using EndpointCase owned = Endpoint(new AedsEncoder().Encode((AedsFrameType)288,
            Encoding.UTF8.GetBytes(request.ToJsonString())), false);
        using var cancellation = new CancellationTokenSource();
        owned.Context.RequestAborted = cancellation.Token;
        owned.Reader.OnRead = count =>
        {
            if (count == cancelledRead)
            {
                cancellation.Cancel();
            }
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => owned.Execute());
        Assert.Equal(cancelledRead, owned.Reader.Calls);
        Assert.Equal(0, owned.Context.Response.Body.Length);
    }

    [Fact]
    public async Task EndpointUnsignalledCancellation_PropagatesWithoutPublicResponse()
    {
        await using EndpointCase owned = Endpoint(new AedsEncoder().Encode((AedsFrameType)288,
            Encoding.UTF8.GetBytes(RequestJson)), false);
        owned.Reader.OnRead = _ => throw new OperationCanceledException("private-canary");
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => owned.Execute());
        Assert.Equal(1, owned.Reader.Calls);
        Assert.Equal(0, owned.Context.Response.Body.Length);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EndpointStalePlanOrOwnerDrift_UsesOriginalConflict(bool ownerDrift)
    {
        JsonNode request = JsonNode.Parse(RequestJson)!;
        request["archiveBytes"] = Convert.ToBase64String(Archive());
        if (!ownerDrift)
        {
            request["expectedPlanDigest"] = new string('f', 64);
            request["expectedContext"] = JsonNode.Parse(ResponseJson)!["context"]!.DeepClone();
        }
        await using EndpointCase owned = Endpoint(new AedsEncoder().Encode((AedsFrameType)288,
            Encoding.UTF8.GetBytes(request.ToJsonString())), false);
        if (ownerDrift)
        {
            owned.Reader.OnRead = _ => owned.Context.User = new ClaimsPrincipal();
        }
        await owned.Execute();
        Assert.Equal(409, owned.Context.Response.StatusCode);
        string response = Encoding.UTF8.GetString(((MemoryStream)owned.Context.Response.Body).ToArray());
        Assert.Contains(ownerDrift ? "article_package_candidate_review_context_drift" : "article_package_candidate_review_plan_stale", response);
        Assert.DoesNotContain("controlled-session", response, StringComparison.Ordinal);
        Assert.DoesNotContain("controlled.example", response, StringComparison.Ordinal);
    }

    private static bool ReadRequest(string json, out ArticlePackageCandidateReviewReadRequest? request)
        => ArticlePackageCandidateReviewWireValidation.TryReadRequest(Encoding.UTF8.GetBytes(json), out request);
    private static bool ReadResponse(string json, out ArticlePackageCandidateReviewReadResponse? response)
        => ArticlePackageCandidateReviewWireValidation.TryReadResponse(Encoding.UTF8.GetBytes(json), out response);

    private static JsonNode UpdateRequest(string revision)
    {
        JsonNode root = JsonNode.Parse(RequestJson)!;
        root["requestedMode"] = "UpdateRequested";
        root["requestedTargets"] = JsonNode.Parse("""
            [{"portableArticle":"article:11111111-1111-1111-1111-111111111111","requestedTargetArticleId":73,"expectedTargetRevision":"1"}]
            """);
        root["requestedTargets"]![0]!["expectedTargetRevision"] = revision;
        root["expectedPlanDigest"] = new string('f', 64);
        root["expectedContext"] = JsonNode.Parse(ResponseJson)!["context"]!.DeepClone();
        return root;
    }

    private static JsonNode UpdateResponse(string revision)
    {
        JsonNode root = JsonNode.Parse(ResponseJson)!;
        root["review"]!["requestedMode"] = "UpdateRequested";
        JsonNode target = root["review"]!["targets"]![0]!;
        target["requiresNewIdentity"] = false;
        target["requestedTargetArticleId"] = 73;
        target["expectedTargetRevision"] = revision;
        return root;
    }

    private static byte[] Archive()
    {
        var package = ArticlePackageImportCandidateByteTests.CreatePackage();
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (ArticlePackageFileBytes file in package.Files)
            {
                using Stream output = zip.CreateEntry(file.Path, CompressionLevel.NoCompression).Open();
                output.Write(file.Bytes.Span);
            }
        }
        return memory.ToArray();
    }

    private static EndpointCase Endpoint(byte[] frame, bool contentLength)
    {
        var reader = new Reader();
        var context = new DefaultHttpContext();
        context.Request.Body = new MemoryStream(frame, writable: false);
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = contentLength ? frame.Length : null;
        context.Response.Body = new MemoryStream();
        context.User = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind), new Claim("admin_id", "73"),
            new Claim("admin_sid", "controlled-session"), new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
        }, "controlled-unit"));
        ServiceProvider services = new ServiceCollection().AddSingleton<IBinaryEndpointRequestContext>(
            new BinaryEndpointRequestContext(new BinaryRequestBinder(), Substitute.For<IHotArticlesCacheVersionProvider>())).BuildServiceProvider();
        context.RequestServices = services;
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SITE_BASEURL"] = "https://controlled.example"
        }).Build();
        var service = new ArticlePackageCandidateReviewReadService(reader, new HttpContextAccessor { HttpContext = context }, configuration, new Clock());
        return new(context, reader, service, services);
    }

    private sealed class Reader : ISystemSiteIdentityReader
    {
        public int Calls { get; private set; }
        public SystemSiteIdentityState State { get; set; } = SystemSiteIdentityState.Current;
        public bool Fail { get; set; }
        public Action<int>? OnRead { get; set; }
        public Task<SystemSiteIdentityReadModel> ReadCurrentSiteIdentityAsync(CancellationToken cancellationToken = default)
        {
            Calls++;
            cancellationToken.ThrowIfCancellationRequested();
            OnRead?.Invoke(Calls);
            if (Fail)
            {
                throw new IOException("private-canary");
            }
            return Task.FromResult(new SystemSiteIdentityReadModel(State, "fsus-site:" + new string('a', 64), 1, 2, 7,
                new[] { new SystemSiteIdentityScope("https://controlled.example", 3) }));
        }
    }

    private sealed class UnreadBody : MemoryStream
    {
        public int Reads { get; private set; }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            Reads++;
            throw new InvalidOperationException("Identity refusal must not read source bytes.");
        }
    }

    private sealed class Clock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => new(2026, 10, 9, 12, 0, 0, TimeSpan.Zero);
    }

    private sealed record EndpointCase(HttpContext Context, Reader Reader, ArticlePackageCandidateReviewReadService Service, ServiceProvider Services) : IAsyncDisposable
    {
        public async Task Execute(CancellationToken cancellationToken = default)
        {
            IResult result = await AuthoringEndpoints.ReadArticlePackageCandidateReviewAsync(Context, new AedsEncoder(), Service, cancellationToken);
            await result.ExecuteAsync(Context);
        }
        public async ValueTask DisposeAsync()
        {
            await Context.Request.BodyReader.CompleteAsync();
            await Context.Request.Body.DisposeAsync();
            await Context.Response.Body.DisposeAsync();
            await Services.DisposeAsync();
        }
    }
}
