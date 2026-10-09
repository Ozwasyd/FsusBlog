using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>Ordinary projection controls using the original finite bytes, identity codecs and immutable planner.</summary>
[Trait("Category", "Unit")]
public sealed class ArticlePackageImportCandidateReviewProjectionTests
{
    private static readonly DateTime s_created = new(2026, 10, 8, 1, 2, 3, DateTimeKind.Utc);

    [Fact]
    public void Create_ProjectsOriginalSummaryDigestsAndIdentityRequirementsWithoutAuthority()
    {
        ArticlePackageImportCandidatePlan plan = Plan(1);
        ArticlePackageCandidateReview review = Project(plan);

        Assert.Equal("finite_bytes_validated", review.CandidateStatus);
        Assert.Equal("CreateNew", review.RequestedMode);
        Assert.Equal(plan.PlanDigest, review.PlanDigest);
        Assert.Equal(plan.PolicyDigest, review.PolicyDigest);
        Assert.Equal(plan.Candidate.PackageBytesDigest, review.Summary.PackageBytesDigest);
        Assert.Equal(plan.Candidate.Manifest.SemanticDigest, review.Summary.ManifestSemanticDigest);
        Assert.Equal(plan.Candidate.ChecksumComponentDigest, review.Summary.ChecksumComponentDigest);
        Assert.Equal(plan.Candidate.Manifest.SchemaVersion, review.Summary.SchemaVersion);
        Assert.Equal(plan.Candidate.Manifest.CanonicalHashVersion, review.Summary.CanonicalHashVersion);
        Assert.Equal(plan.Candidate.Manifest.PropertySchemaVersion, review.Summary.PropertySchemaVersion);
        Assert.Equal(1, review.Summary.ArticleCount);
        Assert.Equal(3, review.Summary.FileCount);
        ArticlePackageCandidateReviewTarget target = Assert.Single(review.Targets);
        Assert.Equal(plan.Targets[0].PortableArticle.Value, target.PortableArticle);
        Assert.True(target.RequiresNewIdentity);
        Assert.Null(target.RequestedTargetArticleId);
        Assert.Null(target.ExpectedTargetRevision);
        Assert.Equal(plan.RequiredAuthorities, review.RequiredAuthorities);
        Assert.True(review.ExecuteDisabled);
        Assert.Equal(plan.RequireExecutionAuthority().ReasonCode, review.ExecutionReasonCode);
    }

    [Fact]
    public void Update_CompleteHintsRemainUnresolvedAndExactInt64SurvivesJson()
    {
        ArticlePackageImportCandidatePlan plan = Plan(1, true);
        ArticlePackageCandidateReview review = Project(plan);
        ArticlePackageCandidateReviewTarget target = Assert.Single(review.Targets);
        Assert.False(target.RequiresNewIdentity);
        Assert.Equal(101, target.RequestedTargetArticleId);
        Assert.Equal(long.MaxValue.ToString(CultureInfo.InvariantCulture), target.ExpectedTargetRevision);
        Assert.True(review.ExecuteDisabled);
        Assert.Equal("article_package_import_authority_unavailable", review.ExecutionReasonCode);

        string json = JsonSerializer.Serialize(review, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement serialized = document.RootElement.GetProperty("targets")[0].GetProperty("expectedTargetRevision");
        Assert.Equal(JsonValueKind.String, serialized.ValueKind);
        Assert.Equal("9223372036854775807", serialized.GetString());
        Assert.DoesNotContain("actor:explicit-importer", json);
        Assert.DoesNotContain("site:primary", json);
        Assert.DoesNotContain("Caller supplied title", json);
        Assert.DoesNotContain("PRIVATE source", json);
        Assert.DoesNotContain("permissionContextDigest", json);
        Assert.DoesNotContain("articleRevisionId", json);
        Assert.DoesNotContain("filePaths", json);
        Assert.DoesNotContain("resolvedTarget", json);
    }

    [Fact]
    public void Projection_PreservesUtcTicksInStringsWithoutClientNumericCoordinates()
    {
        ArticlePackageImportCandidatePlan plan = Plan(1);
        ArticlePackageCandidateReview review = Project(plan);
        Assert.Equal(plan.CreatedAtUtc, DateTime.Parse(review.CreatedAtUtc, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind));
        Assert.Equal(plan.ExpiresAtUtc, DateTime.Parse(review.ExpiresAtUtc, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind));
        Assert.EndsWith(".1234567Z", review.CreatedAtUtc);
    }

    [Fact]
    public void ThousandTargets_ArePagedInOriginalOrderWithNoFullTargetPayload()
    {
        ArticlePackageImportCandidatePlan plan = Plan(1000, true);
        var portable = new List<string>();
        for (int page = 0; page < 20; page++)
        {
            ArticlePackageCandidateReview review = Project(plan, page, 50);
            Assert.Equal(1000, review.TotalTargets);
            Assert.Equal(page, review.PageIndex);
            Assert.Equal(50, review.PageSize);
            Assert.Equal(50, review.Targets.Count);
            Assert.True(review.ExecuteDisabled);
            portable.AddRange(review.Targets.Select(row => row.PortableArticle));
        }
        Assert.Equal(plan.Targets.Select(row => row.PortableArticle.Value), portable);
        Assert.Equal(1000, portable.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void FinalPage_IsBoundedAndOriginalPlanRemainsImmutable()
    {
        ArticlePackageImportCandidatePlan plan = Plan(51);
        ArticlePackageCandidateReview first = Project(plan, 0, 50);
        ArticlePackageCandidateReview last = Project(plan, 1, 50);
        Assert.Equal(50, first.Targets.Count);
        Assert.Single(last.Targets);
        Assert.Equal(plan.Targets[^1].PortableArticle.Value, last.Targets[0].PortableArticle);
        Assert.Equal(first.PlanDigest, last.PlanDigest);
        Assert.Equal(51, plan.Targets.Count);
        Assert.Throws<NotSupportedException>(() => ((IList<ArticlePackageCandidateReviewTarget>)first.Targets).Clear());
        Assert.Throws<NotSupportedException>(() => ((IList<string>)first.RequiredAuthorities).Clear());
    }

    [Theory]
    [InlineData(-1, 25)]
    [InlineData(0, 0)]
    [InlineData(0, -1)]
    [InlineData(0, 51)]
    [InlineData(0, int.MaxValue)]
    [InlineData(int.MaxValue, 1)]
    [InlineData(1, 25)]
    public void InvalidPages_RefuseWithoutPartialProjectionOrOverflow(int pageIndex, int pageSize)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidateReviewProjection.TryProject(
            Plan(1), pageIndex, pageSize, s_created.AddMinutes(1), out var review);
        Assert.False(result.IsValid);
        Assert.Equal("article_package_candidate_review_invalid", result.ReasonCode);
        Assert.Null(review);
    }

    [Theory]
    [InlineData(-1, "caller_interval_not_started")]
    [InlineData(0, "caller_interval_current")]
    [InlineData(1, "caller_interval_expired")]
    public void CallerInterval_UsesExactBoundariesAndNeverChangesAuthority(int boundary, string expected)
    {
        ArticlePackageImportCandidatePlan plan = Plan(1);
        DateTime now = boundary switch
        {
            -1 => plan.CreatedAtUtc.AddTicks(-1),
            0 => plan.CreatedAtUtc,
            _ => plan.ExpiresAtUtc
        };
        Assert.True(ArticlePackageImportCandidateReviewProjection.TryProject(plan, 0, 25, now, out var review).IsValid);
        Assert.Equal(expected, review!.IntervalStatus);
        Assert.True(review.ExecuteDisabled);
        Assert.Equal("article_package_import_authority_unavailable", review.ExecutionReasonCode);
    }

    [Fact]
    public void MissingPlanAndNonUtcClock_RefuseWithoutReview()
    {
        Assert.False(ArticlePackageImportCandidateReviewProjection.TryProject(null, 0, 25, s_created, out var missing).IsValid);
        Assert.Null(missing);
        Assert.False(ArticlePackageImportCandidateReviewProjection.TryProject(Plan(1), 0, 25,
            DateTime.SpecifyKind(s_created, DateTimeKind.Unspecified), out var badClock).IsValid);
        Assert.Null(badClock);
    }

    [Fact]
    public void EmptyAndOverbudgetCandidates_StayOriginalCodecRefusals()
    {
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateCandidate([], out var empty).IsValid);
        Assert.Null(empty);
        ArticlePackageManifestArticle article = Candidate().Manifest.Articles[0];
        Assert.False(ArticlePackageManifestCandidateCodec.TryCreateCandidate(
            Enumerable.Repeat(article, ArticlePackageImportCandidatePlanner.MaxArticles + 1).ToArray(), out var oversized).IsValid);
        Assert.Null(oversized);
    }

    [Fact]
    public void MalformedAndOverbudgetRequests_CannotAcquireAReviewOrExecutionAuthority()
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate();
        ArticlePackageImportCandidateRequest valid = Request();
        ArticlePackageImportRequestedTarget hint = new(Identity(1), 101, long.MaxValue);
        ArticlePackageImportCandidateRequest[] invalid =
        [
            valid with { PolicyDigest = "PRIVATE malformed policy" },
            valid with { Mode = (ArticlePackageImportCandidateMode)255 },
            valid with { ExpiresAtUtc = valid.CreatedAtUtc },
            valid with { Mode = ArticlePackageImportCandidateMode.UpdateRequested, RequestedTargets = [] },
            valid with { Mode = ArticlePackageImportCandidateMode.UpdateRequested, RequestedTargets = [hint with { ExpectedTargetRevision = 0 }] },
            valid with { RequestedTargets = Enumerable.Repeat(hint, 1001).ToArray() }
        ];
        foreach (ArticlePackageImportCandidateRequest request in invalid)
        {
            Assert.False(ArticlePackageImportCandidatePlanner.TryCreatePlan(candidate, request, out var plan).IsValid);
            Assert.Null(plan);
            Assert.False(ArticlePackageImportCandidateReviewProjection.TryProject(plan, 0, 25, s_created, out var review).IsValid);
            Assert.Null(review);
        }
    }

    private static ArticlePackageImportCandidatePlan Plan(int count, bool update = false)
    {
        ArticlePackageValidatedImportCandidate candidate = Candidate(count, "PRIVATE source\r\n");
        ArticlePackageImportCandidateRequest request = Request() with
        {
            Mode = update ? ArticlePackageImportCandidateMode.UpdateRequested : ArticlePackageImportCandidateMode.CreateNew,
            RequestedTargets = update ? Enumerable.Range(1, count).Select(index =>
                new ArticlePackageImportRequestedTarget(Identity(index), 100 + index, long.MaxValue)).ToArray() : null
        };
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidatePlanner.TryCreatePlan(candidate, request, out var plan);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackageImportCandidatePlan>(plan);
    }

    private static ArticlePackageCandidateReview Project(ArticlePackageImportCandidatePlan plan, int page = 0, int size = 25)
    {
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidateReviewProjection.TryProject(
            plan, page, size, s_created.AddMinutes(1), out var review);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackageCandidateReview>(review);
    }

    private static ArticlePackageImportCandidateRequest Request() => new(
        new ArticleRelationActorContext("actor:explicit-importer", "site:primary", new string('a', 64)),
        ArticlePackageImportCandidateMode.CreateNew, new string('b', 64),
        s_created.AddTicks(1234567), s_created.AddMinutes(30).AddTicks(7654321), null);

    private static ArticlePackageIdentity Identity(int index)
    {
        Assert.True(ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article,
            $"article:00000000-0000-0000-0000-{index:x12}", out var identity).IsValid);
        return identity;
    }

    private static ArticlePackageValidatedImportCandidate Candidate(int count = 1, string markdown = "exact source\r\n")
    {
        byte[] raw = System.Text.Encoding.UTF8.GetBytes(markdown);
        Assert.True(ArticlePackageSourceBytes.Inspect(raw, out var metadata).IsValid);
        ArticlePackageManifestArticle[] articles = Enumerable.Range(1, count).Select(index =>
            new ArticlePackageManifestArticle(Identity(index),
                new(index, 1000 + index, 3, new string('c', 64), "site:primary", 1, null, null, null),
                "Caller supplied title", null, new string('d', 64), new string('e', 64), new string('f', 64),
                metadata!, new(0, null, null))).ToArray();
        Assert.True(ArticlePackageManifestCandidateCodec.TryCreateCandidate(articles, out var manifest).IsValid);
        var files = new List<ArticlePackageFileBytes>
        {
            new(ArticlePackageInventory.ManifestPath, ArticlePackageManifestCandidateCodec.WriteCandidate(manifest!))
        };
        files.AddRange(articles.Select(article => new ArticlePackageFileBytes($"articles/{article.PortableArticle.FileNameToken}.md", raw)));
        ArticlePackageInventoryEntry[] inventory = [.. files.Select(file => Entry(file.Path, file.Bytes.Length)),
            Entry(ArticlePackageInventory.ChecksumsPath, 0)];
        ArticlePackageChecksumEntry[] rows = files.Select(file => new ArticlePackageChecksumEntry(file.Path,
            file.Bytes.Length, Convert.ToHexStringLower(SHA256.HashData(file.Bytes.Span)))).ToArray();
        ArticlePackageChecksumValidationResult checksum = ArticlePackageChecksums.ComputeComponentDigest(inventory, rows);
        Assert.True(checksum.IsValid, checksum.ReasonCode);
        byte[] document = JsonSerializer.SerializeToUtf8Bytes(new
        {
            schema = ArticlePackageChecksums.Schema,
            version = ArticlePackageChecksums.Version,
            algorithm = ArticlePackageChecksums.Algorithm,
            componentDigest = checksum.ComponentDigest,
            files = rows.Select(row => new
            {
                path = row.Path,
                byteLength = row.ByteLength,
                sha256 = row.Sha256
            })
        });
        inventory[^1] = Entry(ArticlePackageInventory.ChecksumsPath, document.Length);
        files.Add(new(ArticlePackageInventory.ChecksumsPath, document));
        Assert.True(ArticlePackageChecksums.Verify(inventory, files).IsValid);
        ArticlePackageManifestCandidateResult result = ArticlePackageImportCandidateBytes.Validate(inventory, files, out var candidate);
        Assert.True(result.IsValid, result.ReasonCode);
        return Assert.IsType<ArticlePackageValidatedImportCandidate>(candidate);
    }

    private static ArticlePackageInventoryEntry Entry(string path, int length)
        => new(path, ArticlePackageEntryKind.RegularFile, length, length);

}
