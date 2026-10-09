using System.IO.Compression;
using System.Security.Claims;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Controlled typed-reader observations prove inactive consumer behavior, not canonical DB authority.</summary>
[Trait("Category", "Unit")]
public sealed class ArticlePackageCandidateReviewReadServiceTests
{
    private const string Scope = "https://controlled.example";
    private static readonly DateTime s_created = new(2026, 10, 9, 1, 2, 3, DateTimeKind.Utc);

    [Fact]
    public async Task CurrentExactScope_UsesOriginalProducerAndPreservesObservedCoordinates()
    {
        var reader = new Reader(_ => Current());
        ArticlePackageCandidateReviewReadOutcome result = await Service(reader).ReadAsync(Request());
        Assert.True(result.Result.IsValid, result.Result.ReasonCode);
        ArticlePackageCandidateReviewReadResponse response = Assert.IsType<ArticlePackageCandidateReviewReadResponse>(result.Response);
        Assert.Equal("controlled-read", response.RequestId);
        Assert.Equal(new ArticlePackageCandidateReviewContextExpectation("fsus-site:" + new string('a', 64), 1, 2, 7, 3), response.Context);
        Assert.Equal(2, reader.Calls);
        Assert.True(response.Review.ExecuteDisabled);
        Assert.Equal("article_package_import_authority_unavailable", response.Review.ExecutionReasonCode);
        Assert.Contains("current_actor_site_target_permissions", response.Review.RequiredAuthorities);
        string json = JsonSerializer.Serialize(response);
        Assert.DoesNotContain(Scope, json, StringComparison.Ordinal);
        Assert.DoesNotContain("controlled-session", json, StringComparison.Ordinal);
        Assert.DoesNotContain("admin_principal", json, StringComparison.Ordinal);
        Assert.DoesNotContain("ArchiveBytes", json, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(SystemSiteIdentityState.Absent)]
    [InlineData(SystemSiteIdentityState.MigrationRequired)]
    [InlineData(SystemSiteIdentityState.Ambiguous)]
    [InlineData(SystemSiteIdentityState.Malformed)]
    [InlineData(SystemSiteIdentityState.UnsupportedVersion)]
    [InlineData(SystemSiteIdentityState.InitializationRequired)]
    public async Task NonCurrentState_NeverUsesAnIdentityEvenIfFieldsArePresent(SystemSiteIdentityState state)
    {
        var reader = new Reader(_ => Current() with { State = state });
        Refused(await Service(reader).ReadAsync(Request()), "article_package_candidate_review_site_unavailable");
        Assert.Equal(1, reader.Calls);
    }

    [Theory]
    [InlineData("missing-identity")]
    [InlineData("missing-generation")]
    [InlineData("unsupported-lifecycle")]
    [InlineData("missing-mapping")]
    [InlineData("wrong-scope")]
    [InlineData("duplicate-scope")]
    [InlineData("future-scope-revision")]
    public async Task IncompleteOrAmbiguousCurrentBinding_IsRefused(string change)
    {
        SystemSiteIdentityReadModel value = change switch
        {
            "missing-identity" => Current() with { Identity = null },
            "missing-generation" => Current() with { Generation = null },
            "unsupported-lifecycle" => Current() with { LifecycleVersion = 2 },
            "missing-mapping" => Current() with { MappingRevision = null },
            "wrong-scope" => Current() with { Scopes = new[] { new SystemSiteIdentityScope(Scope + "/", 3) } },
            "duplicate-scope" => Current() with { Scopes = new[] { new SystemSiteIdentityScope(Scope, 3), new SystemSiteIdentityScope(Scope, 4) } },
            _ => Current() with { Scopes = new[] { new SystemSiteIdentityScope(Scope, 8) } }
        };
        Refused(await Service(new Reader(_ => value)).ReadAsync(Request()), "article_package_candidate_review_site_unavailable");
    }

    [Theory]
    [InlineData("generation")]
    [InlineData("mapping")]
    [InlineData("scope-revision")]
    public async Task FinalRevisionDrift_IsRefusedEvenWhenIdentityIsUnchanged(string change)
    {
        var reader = new Reader(call => call == 1 ? Current() : change switch
        {
            "generation" => Current() with { Generation = 3 },
            "mapping" => Current() with { MappingRevision = 8 },
            _ => Current() with { Scopes = new[] { new SystemSiteIdentityScope(Scope, 4) } }
        });
        Refused(await Service(reader).ReadAsync(Request()), "article_package_candidate_review_context_drift");
        Assert.Equal(2, reader.Calls);
    }

    [Fact]
    public async Task StatelessReplay_RequiresSamePlanAndContextRatherThanRefreshingThem()
    {
        var reader = new Reader(_ => Current());
        ArticlePackageCandidateReviewReadService service = Service(reader);
        ArticlePackageCandidateReviewReadRequest request = Request();
        ArticlePackageCandidateReviewReadResponse seed = (await service.ReadAsync(request)).Response!;
        ArticlePackageCandidateReviewReadRequest replay = request with
        {
            RequestId = "controlled-next-read",
            ExpectedPlanDigest = seed.Review.PlanDigest,
            ExpectedContext = seed.Context
        };
        ArticlePackageCandidateReviewReadOutcome same = await service.ReadAsync(replay);
        Assert.True(same.Result.IsValid);
        Assert.Equal(seed.Review.PlanDigest, same.Response!.Review.PlanDigest);
        Refused(await service.ReadAsync(replay with
        {
            ExpectedPlanDigest = new string('b', 64)
        }),
            "article_package_candidate_review_plan_stale");
        Refused(await service.ReadAsync(replay with
        {
            ExpectedContext = seed.Context with
            {
                MappingRevision = 6
            }
        }),
            "article_package_candidate_review_plan_stale");
    }

    [Fact]
    public async Task PermissionDenialAndOversizeEnvelope_DoNotCallReader()
    {
        var reader = new Reader(_ => Current());
        HttpContextAccessor accessor = Accessor();
        accessor.HttpContext!.User = new ClaimsPrincipal();
        Refused(await Service(reader, accessor).ReadAsync(Request()), "article_package_candidate_review_access_denied");
        ArticlePackageCandidateReviewReadRequest request = Request() with
        {
            ArchiveBytes = new byte[ArticlePackageCandidateReviewReadLimits.MaxArchiveBytes + 1]
        };
        Refused(await Service(reader).ReadAsync(request), "article_package_candidate_review_read_invalid");
        Assert.Equal(0, reader.Calls);
    }

    [Fact]
    public async Task ScopeChangeAfterProjection_IsRefusedWithoutUrlNormalization()
    {
        IConfigurationRoot config = Configuration();
        var clock = new Clock(() => config["SITE_BASEURL"] = Scope + "/");
        Refused(await Service(new Reader(_ => Current()), configuration: config, clock: clock).ReadAsync(Request()),
            "article_package_candidate_review_context_drift");
    }

    [Fact]
    public async Task UpdateHint_Int64StaysExactAndExecutionStillHasNoAuthority()
    {
        ArticlePackageCandidateReviewReadRequest request = Request();
        Assert.True(ArticlePackageImportZipCandidateReader.TryReadCandidate(request.ArchiveBytes, out var candidate).IsValid);
        request = request with
        {
            RequestedMode = "UpdateRequested",
            RequestedTargets = new[]
            {
                new ArticlePackageCandidateReviewRequestedTarget(candidate!.Candidate.Manifest.Articles[0].PortableArticle.Value!,
                    41, "9223372036854775807")
            }
        };
        ArticlePackageCandidateReviewReadOutcome result = await Service(new Reader(_ => Current())).ReadAsync(request);
        Assert.True(result.Result.IsValid, result.Result.ReasonCode);
        Assert.Equal("9223372036854775807", Assert.Single(result.Response!.Review.Targets).ExpectedTargetRevision);
        Assert.True(result.Response.Review.ExecuteDisabled);
        Assert.Contains("\"ExpectedTargetRevision\":\"9223372036854775807\"", JsonSerializer.Serialize(request));
    }

    [Fact]
    public async Task CancelAndOwnerFailure_NeverFabricateBindingOrDefaultIdentity()
    {
        using var cancellation = new CancellationTokenSource();
        var reader = new Reader(_ =>
        {
            cancellation.Cancel();
            throw new OperationCanceledException(cancellation.Token);
        });
        Refused(await Service(reader).ReadAsync(Request(), cancellation.Token), "article_package_import_cancelled");
        await Assert.ThrowsAsync<InvalidOperationException>(() => Service(new Reader(_ =>
            throw new InvalidOperationException("controlled-owner-failure"))).ReadAsync(Request()));
        ArticlePackageCandidateReviewReadOutcome recovered = await Service(new Reader(_ => Current())).ReadAsync(Request());
        Assert.True(recovered.Result.IsValid);
        Assert.True(recovered.Response!.Review.ExecuteDisabled);
    }

    private static ArticlePackageCandidateReviewReadService Service(Reader reader,
        HttpContextAccessor? accessor = null, IConfiguration? configuration = null, TimeProvider? clock = null)
        => new(reader, accessor ?? Accessor(), configuration ?? Configuration(), clock ?? new Clock());

    private static SystemSiteIdentityReadModel Current()
        => new(SystemSiteIdentityState.Current, "fsus-site:" + new string('a', 64), 1, 2, 7,
            Array.AsReadOnly(new[] { new SystemSiteIdentityScope(Scope, 3) }));

    private static IConfigurationRoot Configuration()
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["SITE_BASEURL"] = Scope }).Build();

    private static HttpContextAccessor Accessor()
    {
        var identity = new ClaimsIdentity(new[]
        {
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", "73"),
            new Claim("admin_sid", "controlled-session"),
            new Claim(AdminPermissions.PermissionClaimType, AdminPermissions.ArticleWrite)
        }, "controlled-unit");
        return new()
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(identity)
            }
        };
    }

    private static ArticlePackageCandidateReviewReadRequest Request()
    {
        ArticlePackageImportCandidateByteTests.PackageCase package = ArticlePackageImportCandidateByteTests.CreatePackage();
        using var memory = new MemoryStream();
        using (var zip = new ZipArchive(memory, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (ArticlePackageFileBytes file in package.Files)
            {
                ZipArchiveEntry entry = zip.CreateEntry(file.Path, CompressionLevel.NoCompression);
                entry.LastWriteTime = new(2026, 10, 9, 0, 0, 0, TimeSpan.Zero);
                using Stream output = entry.Open();
                output.Write(file.Bytes.Span);
            }
        }
        return new("controlled-read", memory.ToArray(), "CreateNew", new string('b', 64), new string('c', 64),
            s_created, s_created.AddMinutes(30), null, 0, 1, null, null);
    }

    private static void Refused(ArticlePackageCandidateReviewReadOutcome result, string reason)
    {
        Assert.False(result.Result.IsValid);
        Assert.Equal(reason, result.Result.ReasonCode);
        Assert.Null(result.Response);
    }

    private sealed class Reader(Func<int, SystemSiteIdentityReadModel> read) : ISystemSiteIdentityReader
    {
        public int Calls
        {
            get; private set;
        }
        public Task<SystemSiteIdentityReadModel> ReadCurrentSiteIdentityAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(read(++Calls));
    }

    private sealed class Clock(Action? whenRead = null) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow()
        {
            whenRead?.Invoke();
            return new(s_created.AddMinutes(1));
        }
    }
}
