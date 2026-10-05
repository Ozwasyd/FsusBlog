using System.Buffers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests;

public sealed class PublicContentFixtureSeederTests
{
    [Fact]
    public void BuildPaginationProjection_UsesProductionCodecWithOneGenerationAndPageSize()
    {
        DateTime createdAtUtc = new(2026, 9, 14, 8, 0, 0, DateTimeKind.Utc);
        var codec = new ArticleListCursorCodec(
            new EphemeralDataProtectionProvider(),
            TimeProvider.System);
        var rows = new[]
        {
            new PublicContentPaginationBoundaryRow(10, 9010, createdAtUtc, 0, 90),
            new PublicContentPaginationBoundaryRow(100, 9910, createdAtUtc.AddSeconds(-1), 0, 990),
            new PublicContentPaginationBoundaryRow(1000, 99910, createdAtUtc.AddSeconds(-2), 0, 9990)
        };

        PublicContentPaginationProjection projection = PublicContentFixtureSeeder.BuildPaginationProjection(
            generation: 47,
            articleCount: 10_023,
            ownedArticleCount: 10_023,
            rows,
            codec);

        Assert.Equal(10, projection.PageSize);
        Assert.Equal(47, projection.Generation);
        Assert.Equal([10, 100, 1000], projection.Cursors.Select(static item => item.LogicalPage));
        for (int index = 0; index < rows.Length; index++)
        {
            Assert.True(codec.TryDecode(
                projection.Cursors[index].Cursor,
                categoryId: null,
                tagId: null,
                normalizedKeyword: string.Empty,
                pageSize: 10,
                queryVersion: 47,
                sort: ArticleListSortMode.Latest,
                out ArticleListCursorPosition decoded));
            Assert.Equal(rows[index].ArticleId, decoded.Id);
            Assert.Equal(rows[index].CreateTimeUtc, decoded.CreateTimeUtc);
            Assert.False(codec.TryDecode(
                projection.Cursors[index].Cursor,
                categoryId: null,
                tagId: null,
                normalizedKeyword: string.Empty,
                pageSize: 20,
                queryVersion: 47,
                sort: ArticleListSortMode.Latest,
                out _));
        }
    }

    [Fact]
    public void BuildPaginationProjection_RejectsMissingDeepBoundary()
    {
        var codec = Substitute.For<IArticleListCursorCodec>();
        var rows = new[]
        {
            new PublicContentPaginationBoundaryRow(10, 9010, DateTime.UtcNow, 0, 90),
            new PublicContentPaginationBoundaryRow(100, 9910, DateTime.UtcNow, 0, 990)
        };

        Assert.Throws<InvalidOperationException>(() => PublicContentFixtureSeeder.BuildPaginationProjection(
            generation: 1,
            articleCount: 10_020,
            ownedArticleCount: 10_020,
            rows,
            codec));
        codec.DidNotReceiveWithAnyArgs().Encode(default, default, default, default, default, default, default);
    }

    [Fact]
    public void AddPaginationBoundaryEvidence_PreservesExistingIdentityAndAddsScopedObservation()
    {
        var identities = new List<PublicContentEntityIdentity>
        {
            new("article", "9010", "domain-created", "article-published")
        };
        var observations = new List<PublicContentObservedEntity>
        {
            new()
            {
                Kind = "article",
                Id = "9010",
                CapabilityHint = "article-published",
                Fields = new Dictionary<string, object?> { ["status"] = "published" }
            }
        };
        var cursor = new PublicContentPaginationCursor(
            10,
            "production-opaque-cursor",
            new PublicContentPaginationBoundaryIdentity(
                "9010",
                new DateTime(2026, 9, 14, 8, 0, 0, DateTimeKind.Utc),
                0,
                90));

        PublicContentFixtureSeeder.AddPaginationBoundaryEvidence(
            identities,
            observations,
            "fxpc:pagination:run",
            cursor);

        Assert.Single(identities);
        Assert.Contains(observations, item => item.Kind == "article"
            && item.Id == "9010"
            && item.CapabilityHint == "article-pagination-deep");
    }

    [Fact]
    public void SecurityMatrixOutboxOwnership_RequiresExplicitFixtureOwnershipAndDisabledDispatcher()
    {
        static IConfiguration Configuration(params (string Key, string Value)[] values)
            => new ConfigurationBuilder()
                .AddInMemoryCollection(values.ToDictionary(
                    static item => item.Key,
                    static item => (string?)item.Value))
                .Build();

        Assert.True(PublicContentFixtureSeeder.OwnsSecurityMatrixOutbox(Configuration(
            ("PublicContentFixture:SecurityMatrixOwnsOutbox", "true"),
            ("ArticleMutationOutbox:Enabled", "false"))));
        Assert.False(PublicContentFixtureSeeder.OwnsSecurityMatrixOutbox(Configuration(
            ("PublicContentFixture:SecurityMatrixOwnsOutbox", "true"),
            ("ArticleMutationOutbox:Enabled", "true"))));
        Assert.False(PublicContentFixtureSeeder.OwnsSecurityMatrixOutbox(Configuration(
            ("ArticleMutationOutbox:Enabled", "false"))));
    }

    [Fact]
    public void SecurityMatrixOwnedOutboxHandoff_RequiresPublishedObligationAndNoTombstones()
    {
        PublicHotArtifactObligation published = Obligation(PublicHotArtifactObligationState.Published);

        Assert.True(PublicContentFixtureSeeder.IsSecurityMatrixOwnedOutboxHandoffReady([], [], null));
        Assert.True(PublicContentFixtureSeeder.IsSecurityMatrixOwnedOutboxHandoffReady([], [], published));
        Assert.False(PublicContentFixtureSeeder.IsSecurityMatrixOwnedOutboxHandoffReady(
            [],
            [],
            Obligation(PublicHotArtifactObligationState.Processing)));
        Assert.False(PublicContentFixtureSeeder.IsSecurityMatrixOwnedOutboxHandoffReady(
            [
                new PublicArtifactTombstone(
                    ArticleId: 23,
                    Generation: 5,
                    RevokedAtUnixMilliseconds: 1,
                    PurgeConfirmed: true,
                    TransitionPending: false)
            ],
            [],
            published));
        Assert.False(PublicContentFixtureSeeder.IsSecurityMatrixOwnedOutboxHandoffReady(
            [],
            [
                new PublicArtifactTombstone(
                    ArticleId: 23,
                    Generation: 5,
                    RevokedAtUnixMilliseconds: 1,
                    PurgeConfirmed: true,
                    TransitionPending: false)
            ],
            published));
    }

    [Fact]
    public void SecurityMatrixPublicationConvergence_RequiresProcessedEventPerArticleAndNoTombstones()
    {
        int[] articleIds = [17, 23];
        var processed = new[]
        {
            new ArticleMutationOutboxEvent { AggregateId = 17, Status = "processed" },
            new ArticleMutationOutboxEvent { AggregateId = 23, Status = "processed" }
        };

        Assert.True(PublicContentFixtureSeeder.IsSecurityMatrixPublicationConverged(
            articleIds,
            processed,
            []));
        Assert.False(PublicContentFixtureSeeder.IsSecurityMatrixPublicationConverged(
            articleIds,
            processed[..1],
            []));
        Assert.False(PublicContentFixtureSeeder.IsSecurityMatrixPublicationConverged(
            articleIds,
            [
                processed[0],
                new ArticleMutationOutboxEvent { AggregateId = 23, Status = "processing" }
            ],
            []));
        Assert.False(PublicContentFixtureSeeder.IsSecurityMatrixPublicationConverged(
            articleIds,
            processed,
            [
                new PublicArtifactTombstone(
                    ArticleId: 23,
                    Generation: 5,
                    RevokedAtUnixMilliseconds: 1,
                    PurgeConfirmed: true,
                    TransitionPending: false)
            ]));
    }

    [Fact]
    public async Task EnsureTaxonomyAsync_InvalidatesAfterBothOwnedRowsExist()
    {
        var sequence = new List<string>();
        var dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        using var cancellation = new CancellationTokenSource();
        dispatcher
            .InvalidateCategoryTagAsync(cancellation.Token)
            .Returns(_ =>
            {
                sequence.Add("invalidate");
                return Task.CompletedTask;
            });

        (Category category, Tag tag) = await PublicContentFixtureSeeder.EnsureTaxonomyAsync(
            (name, token) =>
            {
                Assert.Equal(cancellation.Token, token);
                sequence.Add("category");
                return Task.FromResult(new Category { Id = 17, Name = name });
            },
            (name, token) =>
            {
                Assert.Equal(cancellation.Token, token);
                sequence.Add("tag");
                return Task.FromResult(new Tag { Id = 23, Name = name });
            },
            dispatcher,
            "fxpc:acceptance:run",
            cancellation.Token);

        Assert.Equal(["category", "tag", "invalidate"], sequence);
        Assert.Equal("fxpc:acceptance:run:category", category.Name);
        Assert.Equal("fxpc:acceptance:run:tag", tag.Name);
        await dispatcher.Received(1).InvalidateCategoryTagAsync(cancellation.Token);
    }

    [Fact]
    public void PublishedArtifactOwner_RequiresTheAdmittedDedicatedRuntimeTuple()
    {
        PublicContentPublishedArtifactRequest request = PublishedArtifactRequest();
        PublicContentFixtureSeeder.RequirePublishedArtifactOwner(request, PublishedArtifactConfiguration(request));
    }

    [Theory]
    [InlineData("expectedSeo")]
    [InlineData("checked")]
    [InlineData("qualification")]
    public void PublishedArtifactRequest_RejectsCallerExpectationOrQualificationFields(string field)
    {
        string json = "{\"" + field + "\":true}";
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<PublicContentPublishedArtifactRequest>(
            json,
            LocalPublicContentFixtureEndpoints.s_requestJsonOptions));
    }

    [Theory]
    [InlineData("FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME")]
    [InlineData("FSUSBLOG_TEST_NAMESPACE")]
    [InlineData("FSUSBLOG_TEST_RUN_ID")]
    [InlineData("FSUSBLOG_TEST_SOURCE_COMMIT")]
    [InlineData("FSUSBLOG_TEST_SOURCE_FINGERPRINT")]
    [InlineData("FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST")]
    public void PublishedArtifactOwner_RejectsMissingOrForeignRuntimeCoordinates(string coordinate)
    {
        PublicContentPublishedArtifactRequest request = PublishedArtifactRequest();
        IConfiguration configuration = PublishedArtifactConfiguration(request);
        configuration[coordinate] = null;
        Assert.Throws<InvalidOperationException>(() =>
            PublicContentFixtureSeeder.RequirePublishedArtifactOwner(request, configuration));
        configuration[coordinate] = "foreign-runtime";
        Assert.Throws<InvalidOperationException>(() =>
            PublicContentFixtureSeeder.RequirePublishedArtifactOwner(request, configuration));
    }

    [Theory]
    [InlineData("//foreign.example/")]
    [InlineData("/?locale=en-US")]
    [InlineData("/#fragment")]
    [InlineData("/\\foreign")]
    [InlineData("")]
    public void PublishedArtifactOwner_RejectsNonCanonicalSelectionPaths(string path)
    {
        PublicContentPublishedArtifactRequest request = PublishedArtifactRequest() with
        {
            Path = path
        };
        Assert.Throws<InvalidOperationException>(() => PublicContentFixtureSeeder.RequirePublishedArtifactOwner(
            request,
            PublishedArtifactConfiguration(request)));
    }

    [Theory]
    [InlineData("fixture-scope")]
    [InlineData("")]
    public void PublishedArtifactProjection_RetainsOpaquePublishedBytesWithoutInventingTypedExpectations(string scope)
    {
        PublicContentPublishedArtifactRequest request = PublishedArtifactRequest();
        var (match, lookup, entry, assets) = PublishedArtifactInputs();
        byte[] original = entry.Document!.Value.Utf8Bytes.ToArray();
        JsonElement result = PublicContentFixtureSeeder.ProjectPublishedArtifact(
            request, match, lookup, entry, assets, scope, 7, 7);
        JsonElement observation = result.GetProperty("observation");
        JsonElement retained = observation.GetProperty("originals")[0];

        Assert.Equal(original, Convert.FromBase64String(retained.GetProperty("content").GetString()!));
        Assert.Equal(original.Length, retained.GetProperty("bytes").GetInt32());
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(original)), retained.GetProperty("sha256").GetString());
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(observation.GetRawText()))),
            result.GetProperty("contentDigest").GetString());
        Assert.Equal(request.RuntimeRunId, observation.GetProperty("owner").GetProperty("runtimeRunId").GetString());
        Assert.Equal(scope, observation.GetProperty("owner").GetProperty("runtimeScope").GetString());
        Assert.Equal(7, observation.GetProperty("publication").GetProperty("generation").GetInt64());
        Assert.Equal(entry.GeneratedAtUtc, observation.GetProperty("publication").GetProperty("generatedAtUtc").GetDateTimeOffset());
        Assert.Equal("server-ssr", observation.GetProperty("publication").GetProperty("source").GetString());
        Assert.Equal("no-cache", observation.GetProperty("publication").GetProperty("artifactCacheControl").GetString());
        Assert.Equal(assets.FrontendBuildIdentity, observation.GetProperty("runtimeAssets").GetProperty("frontendBuildIdentity").GetString());
        Assert.False(observation.TryGetProperty("seo", out _));
        Assert.False(observation.TryGetProperty("payload", out _));
        Assert.False(observation.GetProperty("publication").TryGetProperty("renderTimestampUtc", out _));
        Assert.False(observation.GetProperty("publication").TryGetProperty("frontendRelease", out _));
        Assert.False(observation.TryGetProperty("qualification", out _));
    }

    [Theory]
    [InlineData(-1, -1)]
    [InlineData(7, 8)]
    [InlineData(8, 7)]
    [InlineData(6, 6)]
    public void PublishedArtifactProjection_RejectsChangingOrForeignGeneration(long before, long after)
    {
        var (match, lookup, entry, assets) = PublishedArtifactInputs();
        Assert.Throws<InvalidOperationException>(() => PublicContentFixtureSeeder.ProjectPublishedArtifact(
            PublishedArtifactRequest(), match, lookup, entry, assets, "fixture-scope", before, after));
    }

    [Theory]
    [InlineData("cache-key")]
    [InlineData("route")]
    [InlineData("locale")]
    [InlineData("page")]
    [InlineData("renderer")]
    [InlineData("frontend")]
    [InlineData("document")]
    [InlineData("source")]
    [InlineData("source-assets")]
    [InlineData("manifest")]
    [InlineData("lookup-locale")]
    [InlineData("request-path")]
    [InlineData("oversized-artifact")]
    public void PublishedArtifactProjection_RejectsUnboundOrUnavailablePublication(string fault)
    {
        PublicContentPublishedArtifactRequest request = PublishedArtifactRequest();
        var (match, lookup, entry, assets) = PublishedArtifactInputs();
        switch (fault)
        {
            case "cache-key":
                entry = entry with
                {
                    CacheKey = "foreign:iv:7"
                };
                break;
            case "route":
                entry = entry with
                {
                    RouteKey = "foreign"
                };
                break;
            case "locale":
                entry = entry with
                {
                    Locale = "foreign"
                };
                break;
            case "page":
                entry = entry with
                {
                    PageId = PublicPageId.About
                };
                break;
            case "renderer":
                entry = entry with
                {
                    RendererVersion = "old-renderer"
                };
                break;
            case "frontend":
                entry = entry with
                {
                    FrontendAssetVersion = "old-assets"
                };
                break;
            case "document":
                entry = entry with
                {
                    Document = null
                };
                break;
            case "source":
                entry = entry with
                {
                    Source = default
                };
                break;
            case "source-assets":
                assets = assets with
                {
                    UsesSourceAssets = true
                };
                break;
            case "manifest":
                assets = assets with
                {
                    FrontendBuildIdentity = "missing-manifest"
                };
                break;
            case "lookup-locale":
                lookup = lookup with
                {
                    ExpectedLocale = "foreign"
                };
                break;
            case "request-path":
                request = request with
                {
                    Path = "/about"
                };
                break;
            case "oversized-artifact":
                entry = entry with
                {
                    Document = entry.Document!.Value with
                    {
                        Utf8Bytes = new UnreadableOversizedArtifactMemory().Original
                    }
                };
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(fault));
        }
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => PublicContentFixtureSeeder.ProjectPublishedArtifact(
            request, match, lookup, entry, assets, "fixture-scope", 7, 7));
        if (fault == "oversized-artifact")
        {
            Assert.Equal("published artifact observation exceeds the private byte bound", error.Message);
        }
    }

    [Theory]
    [InlineData(false, "no-cache", "no-cache")]
    [InlineData(false, "public,max-age=60", "public,max-age=60")]
    [InlineData(true, "no-cache", "private,no-store")]
    [InlineData(true, "public,max-age=60", "private,no-store")]
    public void PublishedArtifactProjection_ExposesTheServingOwnersEffectiveCacheControl(
        bool requiresNonce,
        string artifactCacheControl,
        string expected)
    {
        var (match, lookup, entry, assets) = PublishedArtifactInputs();
        string html = requiresNonce
            ? "<html><head></head><body><script>publication()</script></body></html>"
            : "<main>static publication</main>";
        PublicAotHtmlArtifact document = PublicAotHtmlArtifactFactory.FromHtml(
            html, entry.RendererVersion, entry.FrontendAssetVersion, artifactCacheControl);
        entry = entry with
        {
            Document = document
        };
        JsonElement result = PublicContentFixtureSeeder.ProjectPublishedArtifact(
            PublishedArtifactRequest(), match, lookup, entry, assets, string.Empty, 7, 7);
        JsonElement publication = result.GetProperty("observation").GetProperty("publication");

        Assert.Equal(requiresNonce, document.RequiresCspNonceMutation);
        Assert.Equal(artifactCacheControl, publication.GetProperty("artifactCacheControl").GetString());
        Assert.Equal(requiresNonce, publication.GetProperty("requiresCspNonceMutation").GetBoolean());
        Assert.Equal(expected, publication.GetProperty("effectiveCacheControl").GetString());
    }

    [Fact]
    public void PublishedArtifactProjection_DiscardsTemporaryNonceWithoutChangingOriginalBytesOrDigest()
    {
        var (match, lookup, entry, assets) = PublishedArtifactInputs();
        PublicAotHtmlArtifact document = PublicAotHtmlArtifactFactory.FromHtml(
            "<html><head></head><body><script>publication()</script></body></html>",
            entry.RendererVersion, entry.FrontendAssetVersion, "public,max-age=60");
        entry = entry with
        {
            Document = document
        };
        byte[] original = document.Utf8Bytes.ToArray();
        CspNonceUtf8Template? template = document.CspNonceTemplate;

        JsonElement first = PublicContentFixtureSeeder.ProjectPublishedArtifact(
            PublishedArtifactRequest(), match, lookup, entry, assets, string.Empty, 7, 7);
        JsonElement second = PublicContentFixtureSeeder.ProjectPublishedArtifact(
            PublishedArtifactRequest(), match, lookup, entry, assets, string.Empty, 7, 7);

        Assert.NotNull(template);
        Assert.Same(template, document.CspNonceTemplate);
        Assert.Equal(original, document.Utf8Bytes.ToArray());
        Assert.Equal(first.GetRawText(), second.GetRawText());
        JsonElement observation = first.GetProperty("observation");
        Assert.Equal("private,no-store", observation.GetProperty("publication").GetProperty("effectiveCacheControl").GetString());
        Assert.Equal(original, Convert.FromBase64String(observation.GetProperty("originals")[0].GetProperty("content").GetString()!));
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(observation.GetRawText()))),
            first.GetProperty("contentDigest").GetString());
    }

    [Fact]
    public void PublishedArtifactCommit_RequiresTheCurrentReceiptForExactOriginalBytes()
    {
        var (_, lookup, entry, _) = PublishedArtifactInputs();
        string originalDigest = Convert.ToHexStringLower(SHA256.HashData(entry.Document!.Value.Utf8Bytes.Span));
        PublicAotBackfillCommitReceipt receipt = PublishedArtifactCommit(lookup, entry, originalDigest);

        PublicContentFixtureSeeder.RequirePublishedArtifactCommit(
            lookup, entry, receipt, receipt, originalDigest, 7, 7);
    }

    [Theory]
    [InlineData("missing-before")]
    [InlineData("missing-after")]
    [InlineData("cache-key")]
    [InlineData("entry-cache-key")]
    [InlineData("page-prefix")]
    [InlineData("scheduled-generation")]
    [InlineData("current-generation")]
    [InlineData("published-generation")]
    [InlineData("renderer")]
    [InlineData("lookup-frontend")]
    [InlineData("entry-frontend")]
    [InlineData("payload-digest")]
    [InlineData("artifact-digest")]
    [InlineData("original-bytes")]
    [InlineData("invalid-digest")]
    [InlineData("source")]
    [InlineData("receipt-replaced")]
    [InlineData("equal-receipt-replaced")]
    [InlineData("generation-changed")]
    public void PublishedArtifactCommit_RejectsMissingForeignOrRacingPublication(string fault)
    {
        var (_, lookup, entry, _) = PublishedArtifactInputs();
        string originalDigest = Convert.ToHexStringLower(SHA256.HashData(entry.Document!.Value.Utf8Bytes.Span));
        PublicAotBackfillCommitReceipt receipt = PublishedArtifactCommit(lookup, entry, originalDigest);
        switch (fault)
        {
            case "cache-key":
                receipt = receipt with
                {
                    CacheKey = "foreign:iv:7"
                };
                break;
            case "entry-cache-key":
                entry = entry with
                {
                    CacheKey = "foreign:iv:7"
                };
                break;
            case "page-prefix":
                receipt = receipt with
                {
                    PagePrefixKey = "foreign-prefix"
                };
                break;
            case "scheduled-generation":
                receipt = receipt with
                {
                    ScheduledInvalidationVersion = 6
                };
                break;
            case "current-generation":
                receipt = receipt with
                {
                    CurrentInvalidationVersion = 8
                };
                break;
            case "published-generation":
                receipt = receipt with
                {
                    PublishedInvalidationVersion = 6
                };
                break;
            case "renderer":
                receipt = receipt with
                {
                    RendererVersion = "foreign-renderer"
                };
                break;
            case "lookup-frontend":
                lookup = lookup with
                {
                    FrontendAssetVersion = "foreign-assets"
                };
                break;
            case "entry-frontend":
                entry = entry with
                {
                    FrontendAssetVersion = "foreign-assets"
                };
                break;
            case "payload-digest":
                receipt = receipt with
                {
                    PayloadDigest = new string('0', 64)
                };
                break;
            case "artifact-digest":
                receipt = receipt with
                {
                    ArtifactDigest = new string('0', 64)
                };
                break;
            case "original-bytes":
                entry = entry with
                {
                    Document = entry.Document!.Value with
                    {
                        Utf8Bytes = Encoding.UTF8.GetBytes("different-published-original")
                    }
                };
                originalDigest = Convert.ToHexStringLower(SHA256.HashData(entry.Document!.Value.Utf8Bytes.Span));
                break;
            case "invalid-digest":
                originalDigest = "not-a-byte-digest";
                break;
            case "source":
                entry = entry with
                {
                    Source = default
                };
                break;
            case "missing-before":
            case "missing-after":
            case "receipt-replaced":
            case "equal-receipt-replaced":
            case "generation-changed":
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(fault));
        }

        PublicAotBackfillCommitReceipt? before = fault == "missing-before" ? null : receipt;
        PublicAotBackfillCommitReceipt? after = fault == "missing-after" ? null : receipt;
        if (fault == "receipt-replaced")
        {
            after = receipt with
            {
                HotReadDigest = new string('0', 64)
            };
        }
        else if (fault == "equal-receipt-replaced")
        {
            after = receipt with
            {
            };
        }
        long generationAfter = fault == "generation-changed" ? 8 : 7;

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            PublicContentFixtureSeeder.RequirePublishedArtifactCommit(
                lookup, entry, before, after, originalDigest, 7, generationAfter));
        Assert.Equal("published artifact observation commit binding is invalid", error.Message);
    }

    private static PublicAotBackfillCommitReceipt PublishedArtifactCommit(
        PublicAotArtifactLookup lookup,
        PublicAotCacheEntry entry,
        string originalDigest)
        => new(
            lookup.DocumentCacheKey,
            lookup.PagePrefixKey,
            7,
            7,
            7,
            entry.FrontendAssetVersion,
            entry.RendererVersion,
            originalDigest,
            originalDigest,
            originalDigest);

    private sealed class UnreadableOversizedArtifactMemory : MemoryManager<byte>
    {
        public ReadOnlyMemory<byte> Original => CreateMemory(8 * 1024 * 1024 + 1);

        public override Span<byte> GetSpan()
            => throw new InvalidOperationException("oversized artifact bytes must not be read or copied");

        public override MemoryHandle Pin(int elementIndex = 0)
            => throw new InvalidOperationException("oversized artifact bytes must not be pinned");

        public override void Unpin()
        {
        }

        protected override void Dispose(bool disposing)
        {
        }
    }

    private static PublicContentPublishedArtifactRequest PublishedArtifactRequest()
        => new("first-response", "owned-runtime-1", new string('a', 40), new string('b', 64), new string('c', 64), "/", "zh-CN");

    private static IConfiguration PublishedArtifactConfiguration(PublicContentPublishedArtifactRequest request)
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["FSUSBLOG_BROWSER_CONTRACT_DEDICATED_RUNTIME"] = "1",
            ["FSUSBLOG_TEST_NAMESPACE"] = request.Namespace,
            ["FSUSBLOG_TEST_RUN_ID"] = request.RuntimeRunId,
            ["FSUSBLOG_TEST_SOURCE_COMMIT"] = request.SourceCommit,
            ["FSUSBLOG_TEST_SOURCE_FINGERPRINT"] = request.WorktreeFingerprint,
            ["FSUSBLOG_CI_PRODUCTION_RECEIPT_DIGEST"] = request.BuildDigest
        }).Build();

    private static (PublicAotRouteMatch Match, PublicAotArtifactLookup Lookup, PublicAotCacheEntry Entry, SpaAssetSet Assets)
        PublishedArtifactInputs()
    {
        var match = new PublicAotRouteMatch(PublicPageKind.Home, PublicPageId.Home, string.Empty, "/", "/", string.Empty);
        var lookup = new PublicAotArtifactLookup("owned-home:iv:7", "owned-home", "current-assets", "published", "zh-CN");
        var document = PublicAotHtmlArtifactFactory.FromHtml(
            "<opaque-publication-not-an-expectation-parser>", PublicAotConstants.RendererVersion, "current-assets");
        var entry = new PublicAotCacheEntry
        {
            CacheKey = lookup.DocumentCacheKey,
            RouteKey = match.RouteKey,
            PageId = match.PageId,
            Source = PublicAotWriteSource.ServerSsrBackfill,
            GeneratedAtUtc = new DateTimeOffset(2026, 10, 5, 0, 0, 0, TimeSpan.Zero),
            ExpiresAtUtc = new DateTimeOffset(2026, 10, 5, 1, 0, 0, TimeSpan.Zero),
            RendererVersion = PublicAotConstants.RendererVersion,
            FrontendAssetVersion = lookup.FrontendAssetVersion,
            Locale = "zh-CN",
            Document = document
        };
        var assets = new SpaAssetSet("/assets/entry.js", [], [], "current-assets", false)
        {
            FrontendBuildIdentity = "current-runtime-manifest-not-published-boot-config",
            AssetSetDigest = new string('d', 64)
        };
        return (match, lookup, entry, assets);
    }

    private static PublicHotArtifactObligation Obligation(PublicHotArtifactObligationState state)
        => new(
            ObligationId: "obligation",
            TargetGeneration: 5,
            DirtyReasons: PublicHotArtifactDirtyReason.Content,
            ArticleIds: [23],
            RequiresFullRebuild: false,
            ExpectedReleaseIds: new Dictionary<int, long>(),
            AttemptNumber: 1,
            State: state,
            LastFailureKind: PublicHotArtifactFailureKind.None,
            NextEligibleAt: DateTimeOffset.MinValue,
            Attempts: []);
}
