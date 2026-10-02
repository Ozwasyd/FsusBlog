using System.Collections.Immutable;
using System.Security.Cryptography;

using FsusBlog.Contracts.Articles;
using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class ArticlePreservationProjectionTests
{
    private static readonly Uri s_base = new("https://fixture.example/articles/1");
    private static readonly ArticlePreservationLimits s_limits = new(10, 20, 1_000_000);
    private static readonly ArticleMediaLimits s_mediaLimits = new(10, 100, 100, 1_000_000, 2048, 1_000_000, 1_000_000, 10_000_000);

    [Fact]
    public void PureProjection_PreservesTheRepresentativeSourceAndUsesCurrentCanonicalRules()
    {
        var fixture = Fixture();
        ArticlePreservationWritePlan plan = Project(fixture);

        ArticlePreservationArticleWritePlan article = Assert.Single(plan.Articles);
        Assert.Equal(1, article.Current.Article.ArticleId);
        Assert.Equal(fixture.Source.Data.Articles[0], article.Source);
        Assert.Equal(37, article.Source.Views);
        Assert.Equal(fixture.Source.Data.Articles[0].CreateTime, article.Source.CreateTime);
        Assert.Equal("# Legacy body from 20260517", article.Current.Article.MarkdownContent);
        Assert.Equal(ArticlePreservationSemanticReceipt.HashMarkdown(article.Source.Markdown!), article.RawMarkdownSha256);
        Assert.Equal(ArticleRightsCanonicalBinding.Build(article.Current.Article, article.Current.Rights), article.Canonical);
        Assert.Equal(ArticlePreservationSemanticReceipt.ComputePlanDigest(plan), plan.ContentDigest);
        Assert.Equal(Project(fixture).ContentDigest, plan.ContentDigest);
    }

    [Fact]
    public void PureProjection_FinalNewlineChangesRawAndCanonicalDigestsRatherThanBeingTrimmed()
    {
        var original = Fixture();
        var changed = ChangeMarkdown(original, original.Source.Data.Articles[0].Markdown + "\n", rebuildMedia: true);
        ArticlePreservationWritePlan first = Project(original);
        ArticlePreservationWritePlan second = Project(changed);

        Assert.NotEqual(first.Articles[0].RawMarkdownSha256, second.Articles[0].RawMarkdownSha256);
        Assert.NotEqual(first.Articles[0].Canonical.ContentCanonicalHash, second.Articles[0].Canonical.ContentCanonicalHash);
        Assert.NotEqual(first.ContentDigest, second.ContentDigest);
        Assert.EndsWith("\n", second.Articles[0].Current.Article.MarkdownContent);
    }

    [Fact]
    public void PureProjection_RejectsResealedBodyChangesAgainstTheExistingMediaReadset()
    {
        var fixture = Fixture();
        var changed = ChangeMarkdown(fixture, fixture.Source.Data.Articles[0].Markdown + "\n", rebuildMedia: false);

        Assert.Equal(fixture.Media.SourceDocumentsDigest, changed.Media.SourceDocumentsDigest);
        Assert.Throws<InvalidOperationException>(() => Project(changed));
    }

    [Theory]
    [InlineData("content-block")]
    [InlineData("rights-policy")]
    [InlineData("rights-snapshot")]
    [InlineData("responsibility-snapshot")]
    [InlineData("responsibility-version")]
    [InlineData("publication")]
    [InlineData("publication-number")]
    [InlineData("actor")]
    public void PureProjection_RejectsEveryMissingRequiredCurrentCoordinate(string missing)
    {
        var fixture = Fixture();
        ArticlePreservationCurrentData data = fixture.Current.Articles[0].Data;
        ArticlePreservationGraphCoordinates coordinates = missing switch
        {
            "content-block" => data.Coordinates with { ContentBlockId = 0 },
            "rights-policy" => data.Coordinates with { RightsPolicyId = 0 },
            "rights-snapshot" => data.Coordinates with { RightsSnapshotId = 0 },
            "responsibility-snapshot" => data.Coordinates with { ResponsibilitySnapshotId = 0 },
            "responsibility-version" => data.Coordinates with { ResponsibilityVersion = 0 },
            "publication" => data.Coordinates with { PublicationId = 0 },
            "publication-number" => data.Coordinates with { PublicationNo = 0 },
            "actor" => data.Coordinates with { CreatedByAdminPrincipalId = 0 },
            _ => throw new ArgumentOutOfRangeException(nameof(missing))
        };
        var changed = ReplaceCurrent(fixture, data with { Coordinates = coordinates });
        long selectedCoordinate = missing switch
        {
            "content-block" => coordinates.ContentBlockId,
            "rights-policy" => coordinates.RightsPolicyId,
            "rights-snapshot" => coordinates.RightsSnapshotId,
            "responsibility-snapshot" => coordinates.ResponsibilitySnapshotId,
            "responsibility-version" => coordinates.ResponsibilityVersion,
            "publication" => coordinates.PublicationId,
            "publication-number" => coordinates.PublicationNo,
            "actor" => coordinates.CreatedByAdminPrincipalId,
            _ => throw new ArgumentOutOfRangeException(nameof(missing))
        };
        Assert.Equal(0L, selectedCoordinate);
        Assert.Throws<InvalidOperationException>(() => Project(changed));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void PureProjection_UsesTheRealCurrentResponsibilityPredicate(bool missingAuthors)
    {
        var fixture = Fixture();
        ArticlePreservationCurrentData data = fixture.Current.Articles[0].Data;
        ArticleResponsibilityDraft draft = missingAuthors
            ? data.Responsibility with { Authors = [] }
            : data.Responsibility with { ResponsiblePersonConfirmed = false };
        Assert.Contains(ArticleResponsibilityGovernance.Evaluate(draft), static issue => issue.Severity == "error");
        Assert.Throws<InvalidOperationException>(() => Project(ReplaceCurrent(fixture, data with { Responsibility = draft })));
    }

    [Fact]
    public void PureProjection_RejectsAResealedPartialSourceCollection()
    {
        var fixture = Fixture();
        ArticlePreservationSourceData data = fixture.Source.Data with { ExpectedArticleCount = 2 };
        var changed = fixture with { Source = Source(data) };

        Assert.Single(changed.Source.Data.Articles);
        Assert.Equal(2, changed.Source.Data.ExpectedArticleCount);
        Assert.Throws<InvalidOperationException>(() => Project(changed));
    }

    [Fact]
    public void PureProjection_DuplicateCategoryNamesRequireExplicitDistinctIdMappings()
    {
        var fixture = Fixture();
        ArticlePreservationSourceData source = fixture.Source.Data with
        {
            ExpectedCategoryCount = 2,
            Categories = [new(1, "same"), new(2, "same")],
            Articles = [fixture.Source.Data.Articles[0] with { CategoryId = 2 }]
        };
        ArticlePreservationCurrentData data = fixture.Current.Articles[0].Data with
        {
            Article = fixture.Current.Articles[0].Data.Article with { CategoryId = 20 }
        };
        var changed = ReplaceCurrent(fixture with { Source = Source(source) }, data);
        changed = changed with { Current = Current([new(1, "same", 10, "explicit A"), new(2, "same", 20, "explicit B")],
            changed.Current.Tags, changed.Current.Articles) };

        ArticlePreservationWritePlan plan = Project(changed);
        Assert.Equal(20, plan.Articles[0].Current.Article.CategoryId);
        Assert.Equal(new[] { 1, 2 }, plan.Categories.Select(static map => map.SourceId).ToArray());
        var collapsed = changed with { Current = Current(
            [new(1, "same", 10, "same"), new(2, "same", 10, "same")], changed.Current.Tags, changed.Current.Articles) };
        Assert.Throws<InvalidOperationException>(() => Project(collapsed));
    }

    [Fact]
    public void PureProjection_RejectsMissingCurrentPackagesAndCancelledAttemptsWithoutPartialPlan()
    {
        var fixture = Fixture();
        var missing = fixture with { Current = Current(fixture.Current.Categories, fixture.Current.Tags, []) };
        Assert.Throws<InvalidOperationException>(() => Project(missing));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.Throws<OperationCanceledException>(() => ArticlePreservationProjection.Project(
            fixture.Source, fixture.Current, fixture.Media, s_limits, s_mediaLimits, cancellation.Token));
    }

    [Fact]
    public void PureProjection_ByteSealsDoNotAcceptTamperedArtifacts()
    {
        var fixture = Fixture();
        var changed = fixture with { Source = fixture.Source with { Bytes = [1, 2, 3] } };
        Assert.NotEqual(changed.Source.Artifact.Sha256, ArticlePreservationSemanticReceipt.HashBytes(changed.Source.Bytes.AsSpan()));
        Assert.Throws<InvalidOperationException>(() => Project(changed));
    }

    [Fact]
    public void PureProjection_PreservesTheProductionSharedContentBlockIdentity()
    {
        var fixture = Fixture();
        var shared = WithSecondArticle(fixture, fixture.Source.Data.Articles[0].Markdown!,
            fixture.Current.Articles[0].Data.Coordinates.ContentBlockId);

        ArticlePreservationWritePlan plan = Project(shared);
        Assert.Equal(2, plan.Articles.Length);
        Assert.Equal(plan.Articles[0].RawMarkdownSha256, plan.Articles[1].RawMarkdownSha256);
        Assert.Equal(plan.Articles[0].Current.Coordinates.ContentBlockId, plan.Articles[1].Current.Coordinates.ContentBlockId);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void PureProjection_RejectsConflictingContentBlockAllocations(bool differentBodiesShareId)
    {
        var fixture = Fixture();
        string firstBody = fixture.Source.Data.Articles[0].Markdown!;
        long firstBlockId = fixture.Current.Articles[0].Data.Coordinates.ContentBlockId;
        var conflicting = WithSecondArticle(fixture,
            differentBodiesShareId ? firstBody + "\n" : firstBody,
            differentBodiesShareId ? firstBlockId : firstBlockId + 1);

        Assert.Equal(differentBodiesShareId,
            conflicting.Current.Articles[0].Data.Coordinates.ContentBlockId == conflicting.Current.Articles[1].Data.Coordinates.ContentBlockId);
        Assert.Equal(!differentBodiesShareId,
            conflicting.Source.Data.Articles[0].Markdown == conflicting.Source.Data.Articles[1].Markdown);
        Assert.Throws<InvalidOperationException>(() => Project(conflicting));
    }

    [Theory]
    [InlineData(ArticleStatusValues.Scheduled, false)]
    [InlineData(ArticleStatusValues.Scheduled, true)]
    [InlineData(ArticleStatusValues.Draft, true)]
    public void PureProjection_RejectsTheActualCurrentTargetStatusPredicate(int status, bool includePastSchedule)
    {
        var fixture = Fixture();
        ArticlePreservationCurrentData data = fixture.Current.Articles[0].Data;
        DateTime? schedule = includePastSchedule ? data.Coordinates.PublicationTime.AddMinutes(-1) : null;
        var target = data with { Article = data.Article with { Status = status, ScheduledPublishAt = schedule } };

        Assert.NotNull(ArticleStatusTransitionPolicy.ValidateTarget(status, schedule, target.Coordinates.PublicationTime));
        Assert.Throws<InvalidOperationException>(() => Project(ReplaceCurrent(fixture, target)));
    }

    [Fact]
    public void PureProjection_UnknownSourceProfileCannotBorrowTheKnownRowsOrDefaultPolicy()
    {
        var fixture = Fixture();
        var unknown = fixture with { Source = Source(fixture.Source.Data with { FingerprintId = "unknown-profile" }) };
        Assert.NotEqual(OfflineMigrationSourceFingerprints.LegacyId, unknown.Source.Data.FingerprintId);
        Assert.Equal(fixture.Source.Data.Articles, unknown.Source.Data.Articles);
        Assert.Throws<InvalidOperationException>(() => Project(unknown));
    }

    [Fact]
    public void PureProjection_AbsentCurrentRightsCannotBeReplacedWithAuthoringDefaults()
    {
        var fixture = Fixture();
        var missing = ReplaceCurrent(fixture, fixture.Current.Articles[0].Data with { Rights = null! });
        Assert.Null(missing.Current.Articles[0].Data.Rights);
        Assert.Throws<InvalidOperationException>(() => Project(missing));
    }

    // Synthetic input fixtures exercise pure computation only. They are not source/current
    // exporters, backup evidence, filesystem observations, or permission to register a native step.
    private sealed record InputFixture(ArticlePreservationSourceExport Source, ArticlePreservationCurrentExport Current, ArticleMediaInventory Media);
    private static InputFixture Fixture()
    {
        DateTime created = new(2026, 5, 17, 10, 0, 0, DateTimeKind.Unspecified);
        var row = new LegacyArticlePreservationRow(1, "Legacy 20260517 article", "# Legacy body from 20260517",
            "Legacy summary", 1, [1], 37, created, false);
        var source = new ArticlePreservationSourceData(OfflineMigrationSourceFingerprints.LegacyId, new string('a', 64),
            new("fixture://origin", new string('b', 64)), s_base, 1, 1, 1, [row], [new(1, "技术随笔")], [new(1, "migration")]);
        var responsibility = new ArticleResponsibilityDraft(false, [new("Fixture author", null)], null, [],
            "Initial import", "offline preservation", created, "none", null, null, null, true, false, false, false, 1);
        var article = new ArticleCanonicalInput(1, 101, 1, "article:1", row.Title, row.Summary, null, 1, [1],
            ArticleStatusValues.Published, created, null, row.Markdown!);
        var target = new ArticlePreservationCurrentData(1, article, ArticleProductionNormalizers.NormalizeArticleRights(null),
            responsibility, null, new(201, 301, 401, 501, 1, 601, 1, 701, "Initial import", "article-created", created));
        var current = Current([new(1, "技术随笔", 1, "技术随笔")], [new(1, "migration", 1, "migration")], [Package(target)]);
        return new(Source(source), current, Media(source));
    }
    private static ArticlePreservationWritePlan Project(InputFixture input)
        => ArticlePreservationProjection.Project(input.Source, input.Current, input.Media, s_limits, s_mediaLimits, default);
    private static ArticlePreservationSourceExport Source(ArticlePreservationSourceData data)
    {
        byte[] bytes = ArticlePreservationSemanticReceipt.Serialize(data);
        return new(new("fixture://source", ArticlePreservationSemanticReceipt.HashBytes(bytes)), bytes.ToImmutableArray(), data);
    }
    private static ArticlePreservationCurrentPackage Package(ArticlePreservationCurrentData data)
    {
        byte[] bytes = ArticlePreservationSemanticReceipt.Serialize(data);
        return new(new($"fixture://current/{data.SourceArticleId}", ArticlePreservationSemanticReceipt.HashBytes(bytes)), bytes.ToImmutableArray(), data);
    }
    private static ArticlePreservationCurrentExport Current(ImmutableArray<ArticlePreservationTaxonomyMap> categories,
        ImmutableArray<ArticlePreservationTaxonomyMap> tags, ImmutableArray<ArticlePreservationCurrentPackage> articles)
    {
        byte[] bytes = ArticlePreservationSemanticReceipt.Serialize(new { Categories = categories, Tags = tags, Articles = articles });
        return new(new("fixture://current", ArticlePreservationSemanticReceipt.HashBytes(bytes)), bytes.ToImmutableArray(), categories, tags, articles);
    }
    private static ArticleMediaInventory Media(ArticlePreservationSourceData source)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var row in source.Articles.OrderBy(static row => row.Id))
            ArticleMediaPreservation.AppendSourceDocument(hash, new(row.Id, null, row.Markdown!, source.DocumentBase));
        var media = new ArticleMediaInventory("fixture-root-identity",
            Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant(), [], 0, "");
        return media with { ManifestDigest = ArticleMediaPreservation.ComputeManifestDigest(media) };
    }
    private static InputFixture ReplaceCurrent(InputFixture fixture, ArticlePreservationCurrentData data)
        => fixture with { Current = Current(fixture.Current.Categories, fixture.Current.Tags, [Package(data)]) };
    private static InputFixture ChangeMarkdown(InputFixture fixture, string markdown, bool rebuildMedia)
    {
        ArticlePreservationSourceData source = fixture.Source.Data with { Articles = [fixture.Source.Data.Articles[0] with { Markdown = markdown }] };
        ArticlePreservationCurrentData data = fixture.Current.Articles[0].Data with
        {
            Article = fixture.Current.Articles[0].Data.Article with { MarkdownContent = markdown }
        };
        var changed = ReplaceCurrent(fixture with { Source = Source(source) }, data);
        return rebuildMedia ? changed with { Media = Media(source) } : changed;
    }

    private static InputFixture WithSecondArticle(InputFixture fixture, string markdown, long blockId)
    {
        LegacyArticlePreservationRow row = fixture.Source.Data.Articles[0] with { Id = 2, Markdown = markdown };
        ArticlePreservationSourceData source = fixture.Source.Data with
        {
            ExpectedArticleCount = 2,
            Articles = [fixture.Source.Data.Articles[0], row]
        };
        ArticlePreservationCurrentData first = fixture.Current.Articles[0].Data;
        ArticlePreservationCurrentData second = first with
        {
            SourceArticleId = 2,
            Article = first.Article with { ArticleId = 2, ArticleRevisionId = 102, PublicRouteKey = "article:2", MarkdownContent = markdown },
            Coordinates = first.Coordinates with
            {
                ContentBlockId = blockId, RightsPolicyId = 302, RightsSnapshotId = 402,
                ResponsibilitySnapshotId = 502, PublicationId = 602
            }
        };
        return fixture with
        {
            Source = Source(source),
            Current = Current(fixture.Current.Categories, fixture.Current.Tags, [fixture.Current.Articles[0], Package(second)]),
            Media = Media(source)
        };
    }
}
