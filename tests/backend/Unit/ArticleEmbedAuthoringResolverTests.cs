using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleEmbedAuthoringResolverTests
{
    private const string Host = "article:01991e72-9a2c-7b60-8f47-b339f58e4a11";
    private const string ArticleA = "article:01991e72-a611-7d16-9fd4-38f7d2e65498";
    private const string ArticleB = "article:01991e72-b871-7a86-bc95-5518cf8bd7dc";
    private const string ArticleC = "article:01991e72-c397-75a2-b61a-da6d7dbd8092";
    private const string HeadingA = "heading:01991e72-d093-78ad-b06d-8f7664902992";
    private const string DigestA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string DigestB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string DigestC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string DigestD = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    private static readonly ArticleEmbedActorContext s_actor =
        new("actor:01991e72-dbed-74bd-a467-027699b78ad8", "site:primary", DigestA);

    private static readonly ArticleEmbedRuntimeContext s_runtime =
        new("article-embed", 1, ArticleEmbedSchemas.ProviderRuntime, DigestB);

    private static readonly ArticleEmbedDocumentIdentity s_document = new("document:host-1", 3);

    private static readonly ArticleEmbedResolutionBudgetLimits s_budgets = new(8, 64, 1_048_576, 60_000, 128);

    private static readonly CancellationToken s_signal = new CancellationTokenSource().Token;

    [Fact]
    public void ResolvesArticleHeadingAndBlockCurrentTargets()
    {
        var snapshot = Snapshot(
            PublicFacts(ArticleA, 17,
                headings: [new ArticleEmbedHeadingFact(HeadingA, Projection("projection:heading"))],
                blocks: [new ArticleEmbedBlockFact("release-notes-2026", Projection("projection:block"))]));
        ArticleEmbedProviderRequest[] requests =
        [
            Request("request:article", ArticleA, ArticleEmbedTargetKind.Article, 0),
            Request("request:heading", $"{ArticleA}#{HeadingA}", ArticleEmbedTargetKind.Heading, 40),
            Request("request:block", $"{ArticleA}#release-notes-2026", ArticleEmbedTargetKind.Block, 80)
        ];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        Assert.Equal(ArticleEmbedAuthoringResolutionStatus.Completed, resolution.Status);
        Assert.Equal(3, resolution.Results.Count);
        Assert.All(resolution.Results, result =>
        {
            Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, result.Result.Status);
            Assert.Equal(ArticleEmbedPublicationEligibility.PublicationEligible, result.Eligibility);
            Assert.NotNull(result.OpenSource);
            Assert.Equal(ArticleEmbedAuthoringSchemas.OpenSourceIntentKind, result.OpenSource.IntentKind);
        });
        Assert.Equal("projection:article-body", resolution.Results[0].Result.Projection!.ProjectionIdentity);
        Assert.Equal("projection:heading", resolution.Results[1].Result.Projection!.ProjectionIdentity);
        Assert.Equal("projection:block", resolution.Results[2].Result.Projection!.ProjectionIdentity);
        Assert.Equal(17, resolution.Results[0].Result.Coordinate!.ResolvedRevision);
        Assert.Equal(17, resolution.Results[0].OpenSource!.ResolvedRevision);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Theory]
    [InlineData(ArticleEmbedVisibilityStatus.Private, ArticleEmbedLifecycleStatus.Draft)]
    [InlineData(ArticleEmbedVisibilityStatus.Private, ArticleEmbedLifecycleStatus.Published)]
    [InlineData(ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Draft)]
    [InlineData(ArticleEmbedVisibilityStatus.Public, ArticleEmbedLifecycleStatus.Scheduled)]
    public void PrivateDraftAndScheduledTargetsResolveAsAuthoringOnly(
        ArticleEmbedVisibilityStatus visibility,
        ArticleEmbedLifecycleStatus lifecycle)
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 9) with
        {
            Visibility = visibility,
            Lifecycle = lifecycle
        });
        ArticleEmbedProviderRequest[] requests = [Request("request:one", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringEmbedResult result = Assert.Single(resolution.Results);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, result.Result.Status);
        Assert.Equal(ArticleEmbedPublicationEligibility.AuthoringOnly, result.Eligibility);
        Assert.Equal(visibility, result.Result.Visibility);
        Assert.Equal(lifecycle, result.Result.Lifecycle);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Theory]
    [InlineData(ArticleEmbedLifecycleStatus.Archived, ArticleEmbedErrorCode.Archived)]
    [InlineData(ArticleEmbedLifecycleStatus.Deleted, ArticleEmbedErrorCode.Deleted)]
    [InlineData(ArticleEmbedLifecycleStatus.Unknown, ArticleEmbedErrorCode.Unpublished)]
    public void ArchivedDeletedAndUnknownLifecycleTargetsFailClosed(
        ArticleEmbedLifecycleStatus lifecycle,
        ArticleEmbedErrorCode expected)
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 9) with
        {
            Lifecycle = lifecycle
        });
        ArticleEmbedProviderRequest[] requests = [Request("request:one", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringEmbedResult result = Assert.Single(resolution.Results);
        Assert.Equal(ArticleEmbedProviderResultStatus.Failed, result.Result.Status);
        Assert.Equal(expected, result.Result.Error!.Code);
        Assert.Null(result.OpenSource);
        Assert.Equal(ArticleEmbedPublicationEligibility.AuthoringOnly, result.Eligibility);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Theory]
    [InlineData(ArticleEmbedPermissionStatus.Denied, ArticleEmbedErrorCode.PermissionDenied)]
    [InlineData(ArticleEmbedPermissionStatus.Unknown, ArticleEmbedErrorCode.PermissionUnknown)]
    public void PermissionDeniedOrUnknownTargetsNeverResolve(
        ArticleEmbedPermissionStatus permission,
        ArticleEmbedErrorCode expected)
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 9) with
        {
            Permission = permission
        });
        ArticleEmbedProviderRequest[] requests = [Request("request:one", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        Assert.Equal(expected, Assert.Single(resolution.Results).Result.Error!.Code);
        Assert.Equal(permission, resolution.Results[0].Result.Permission);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Theory]
    [InlineData(ArticleEmbedPermissionStatus.Denied, false)]
    [InlineData(ArticleEmbedPermissionStatus.Denied, true)]
    [InlineData(ArticleEmbedPermissionStatus.Unknown, false)]
    [InlineData(ArticleEmbedPermissionStatus.Unknown, true)]
    public void UnauthorizedTargetFactsDoNotExposeLifecycleOrRevisionDrift(
        ArticleEmbedPermissionStatus permission,
        bool drifted)
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 9, nested: [Nested(ArticleB, ArticleEmbedTargetKind.Article, 10)]) with
        {
            Permission = permission,
            Visibility = ArticleEmbedVisibilityStatus.Private,
            Lifecycle = ArticleEmbedLifecycleStatus.Archived,
            AuthorityGeneration = drifted ? 99 : 1,
            SourceRevision = drifted ? 12 : 9,
            LatestObservedRevision = 12,
            AttributionDisplayText = "Unauthorized title"
        });
        ArticleEmbedProviderRequest[] requests = [Request("request:hidden", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringEmbedResult result = Assert.Single(resolution.Results);
        Assert.Equal(permission == ArticleEmbedPermissionStatus.Denied
            ? ArticleEmbedErrorCode.PermissionDenied : ArticleEmbedErrorCode.PermissionUnknown, result.Result.Error!.Code);
        Assert.Equal(ArticleEmbedVisibilityStatus.Unknown, result.Result.Visibility);
        Assert.Equal(ArticleEmbedLifecycleStatus.Unknown, result.Result.Lifecycle);
        Assert.Equal(permission, result.Result.Permission);
        Assert.Null(result.Result.Coordinate);
        Assert.Null(result.Result.Projection);
        Assert.Null(result.Result.Attribution);
        Assert.Null(result.OpenSource);
        Assert.False(result.UpdateAvailable);
        Assert.Empty(result.Children);
        Assert.Equal(0, resolution.Receipt.Observed.Bytes);
        ArticleEmbedAuthoringReceiptItem item = Assert.Single(resolution.Receipt.Items);
        Assert.Equal(ArticleEmbedVisibilityStatus.Unknown, item.Visibility);
        Assert.Equal(ArticleEmbedLifecycleStatus.Unknown, item.Lifecycle);
        Assert.Null(item.ResolvedRevision);
        Assert.Equal(0, item.ChildCount);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Fact]
    public void CrossSiteTargetRejectsBeforeGenerationOrPermissionFacts()
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 9) with
        {
            SiteIdentity = "site:foreign",
            AuthorityGeneration = 99,
            SourceRevision = 12,
            Visibility = ArticleEmbedVisibilityStatus.Private,
            Lifecycle = ArticleEmbedLifecycleStatus.Deleted,
            Permission = ArticleEmbedPermissionStatus.Denied
        });
        ArticleEmbedProviderRequest[] requests = [Request("request:site", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        ArticleEmbedProviderResult result = Assert.Single(resolution.Results).Result;
        Assert.Equal(ArticleEmbedErrorCode.PermissionUnknown, result.Error!.Code);
        Assert.Equal("site_mismatch", result.Error.SafeReasonCode);
        Assert.Equal(ArticleEmbedVisibilityStatus.Unknown, result.Visibility);
        Assert.Equal(ArticleEmbedLifecycleStatus.Unknown, result.Lifecycle);
        Assert.Equal(ArticleEmbedPermissionStatus.Unknown, result.Permission);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Theory]
    [InlineData(ArticleEmbedTargetKind.Article, 8)]
    [InlineData(ArticleEmbedTargetKind.Article, 10)]
    [InlineData(ArticleEmbedTargetKind.Heading, 8)]
    [InlineData(ArticleEmbedTargetKind.Heading, 10)]
    [InlineData(ArticleEmbedTargetKind.Block, 8)]
    [InlineData(ArticleEmbedTargetKind.Block, 10)]
    public void ProjectionRevisionMustMatchCurrentAuthorizedSource(
        ArticleEmbedTargetKind mode,
        long sourceRevision)
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 9,
            headings: [new ArticleEmbedHeadingFact(HeadingA, Projection("projection:heading"))],
            blocks: [new ArticleEmbedBlockFact("exact-anchor", Projection("projection:block"))]) with
        {
            SourceRevision = sourceRevision,
            LatestObservedRevision = 10
        }, PublicFacts(ArticleB, 5));
        string token = mode switch
        {
            ArticleEmbedTargetKind.Heading => $"{ArticleA}#{HeadingA}",
            ArticleEmbedTargetKind.Block => $"{ArticleA}#exact-anchor",
            _ => ArticleA
        };
        ArticleEmbedProviderRequest[] requests =
        [
            Request("request:stale", token, mode, 0),
            Request("request:valid", ArticleB, ArticleEmbedTargetKind.Article, 40)
        ];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringEmbedResult result = resolution.Results[0];
        Assert.Equal(ArticleEmbedProviderResultStatus.Failed, result.Result.Status);
        Assert.Equal(ArticleEmbedErrorCode.StaleTarget, result.Result.Error!.Code);
        Assert.Equal("target_source_revision_drift", result.Result.Error.SafeReasonCode);
        Assert.Null(result.Result.Coordinate);
        Assert.Null(result.Result.Projection);
        Assert.Null(result.OpenSource);
        Assert.False(result.UpdateAvailable);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, resolution.Results[1].Result.Status);
        Assert.Equal(5, resolution.Results[1].Result.Coordinate!.ResolvedRevision);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Theory]
    [InlineData("visibility")]
    [InlineData("lifecycle")]
    [InlineData("permission")]
    public void IndependentVerifierRejectsResealedUnauthorizedMetadata(string field)
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 9) with
        {
            Permission = ArticleEmbedPermissionStatus.Denied
        });
        ArticleEmbedProviderRequest[] requests = [Request("request:sealed", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);
        ArticleEmbedProviderResult result = resolution.Results[0].Result;
        ArticleEmbedProviderResult altered = field switch
        {
            "visibility" => result with { Visibility = ArticleEmbedVisibilityStatus.Private },
            "lifecycle" => result with { Lifecycle = ArticleEmbedLifecycleStatus.Published },
            _ => result with { Permission = ArticleEmbedPermissionStatus.Allowed }
        };
        altered = ArticleEmbedContractValidator.Seal(altered);
        var receipt = resolution.Receipt with
        {
            Items = [resolution.Receipt.Items[0] with
            {
                Visibility = altered.Visibility,
                Lifecycle = altered.Lifecycle,
                Permission = altered.Permission,
                ResultDigest = altered.ResultDigest
            }]
        };
        receipt = receipt with
        {
            ReceiptDigest = ArticleEmbedAuthoringDigest.ComputeReceipt(receipt)
        };
        var candidate = resolution with
        {
            Results = [resolution.Results[0] with { Result = altered }],
            Receipt = receipt
        };
        candidate = candidate with
        {
            ResolutionDigest = ArticleEmbedAuthoringDigest.ComputeResolution(candidate)
        };
        Assert.True(ArticleEmbedAuthoringContractValidator.Validate(candidate).IsValid);
        ArticleEmbedValidationResult providerCheck = ArticleEmbedContractValidator.Validate(altered, requests[0]);
        Assert.Equal(field != "permission", providerCheck.IsValid);

        ArticleEmbedAuthoringVerification verification = ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, candidate);

        Assert.False(verification.Valid);
        Assert.Contains("failure_metadata_mismatch:request:sealed", verification.ReasonCodes);
    }

    [Fact]
    public void NestedTargetRevisionDriftFailsLocallyWithoutProjectionFallback()
    {
        var snapshot = Snapshot(
            PublicFacts(ArticleA, 9, nested: [Nested(ArticleB, ArticleEmbedTargetKind.Article, 10)]),
            PublicFacts(ArticleB, 5) with
            {
                SourceRevision = 6
            });
        ArticleEmbedProviderRequest[] requests = [Request("request:nested", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringEmbedResult result = Assert.Single(resolution.Results);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, result.Result.Status);
        ArticleEmbedResolvedNode child = Assert.Single(result.Children);
        Assert.Equal(ArticleEmbedErrorCode.StaleTarget, child.Error!.Code);
        Assert.Null(child.Coordinate);
        Assert.Empty(child.Children);
        ArticleEmbedAuthoringVerification verification = ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution);
        Assert.True(verification.Valid, string.Join(",", verification.ReasonCodes));
    }

    [Theory]
    [InlineData(ArticleEmbedPermissionStatus.Denied)]
    [InlineData(ArticleEmbedPermissionStatus.Unknown)]
    public void NestedPermissionFailureRetainsOnlyTheSuppliedTargetIdentity(ArticleEmbedPermissionStatus permission)
    {
        var snapshot = Snapshot(
            PublicFacts(ArticleA, 9, nested: [Nested(ArticleB, ArticleEmbedTargetKind.Article, 10)]),
            PublicFacts(ArticleB, 5) with
            {
                Permission = permission,
                Lifecycle = ArticleEmbedLifecycleStatus.Deleted
            });
        ArticleEmbedProviderRequest[] requests = [Request("request:nested-permission", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        ArticleEmbedResolvedNode child = Assert.Single(Assert.Single(resolution.Results).Children);
        Assert.Equal(ArticleB, child.Target!.PortableArticleIdentity);
        Assert.Equal(permission == ArticleEmbedPermissionStatus.Denied
            ? ArticleEmbedErrorCode.PermissionDenied : ArticleEmbedErrorCode.PermissionUnknown, child.Error!.Code);
        Assert.Null(child.Coordinate);
        Assert.Empty(child.Children);
        Assert.Equal(128, resolution.Receipt.Observed.Bytes);
        ArticleEmbedAuthoringVerification verification = ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution);
        Assert.True(verification.Valid, string.Join(",", verification.ReasonCodes));
    }

    [Fact]
    public void TenThousandSuppliedAuthorityFactsDoNotExpandUnrequestedTargetsOrReceiptCounts()
    {
        ArticleEmbedTargetFacts[] facts = Enumerable.Range(0, 9999)
            .Select(index => PublicFacts($"article:01991e72-a611-7d16-9fd4-{index:x12}", 9))
            .Prepend(PublicFacts(ArticleA, 9) with
            {
                Permission = ArticleEmbedPermissionStatus.Denied,
                Visibility = ArticleEmbedVisibilityStatus.Private
            }).ToArray();
        var snapshot = Snapshot(facts);
        ArticleEmbedProviderRequest[] requests = [Request("request:bounded", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        Assert.Equal(10000, snapshot.Targets.Count);
        Assert.Single(resolution.Results);
        Assert.Single(resolution.Receipt.Items);
        Assert.Equal(1, resolution.Receipt.RequestCount);
        Assert.Equal(1, resolution.Receipt.FailedCount);
        Assert.Equal(1, resolution.Receipt.Observed.Nodes);
        Assert.Equal(0, resolution.Receipt.Observed.Bytes);
        Assert.Equal(ArticleEmbedVisibilityStatus.Unknown, resolution.Results[0].Result.Visibility);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Fact]
    public void MissingAmbiguousMissingDuplicateCoordinatesFailWithoutFirstMatch()
    {
        var snapshot = Snapshot(
            PublicFacts(ArticleA, 3,
                blocks: [new ArticleEmbedBlockFact("dup-anchor", Projection("projection:one")), new ArticleEmbedBlockFact("dup-anchor", Projection("projection:two"))]),
            PublicFacts(ArticleB, 5),
            PublicFacts(ArticleB, 5));
        ArticleEmbedProviderRequest[] requests =
        [
            Request("request:missing", ArticleC, ArticleEmbedTargetKind.Article, 0),
            Request("request:ambiguous", ArticleB, ArticleEmbedTargetKind.Article, 40),
            Request("request:heading-missing", $"{ArticleA}#{HeadingA}", ArticleEmbedTargetKind.Heading, 80),
            Request("request:block-duplicate", $"{ArticleA}#dup-anchor", ArticleEmbedTargetKind.Block, 120)
        ];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        Assert.Equal(ArticleEmbedErrorCode.Missing, resolution.Results[0].Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.Ambiguous, resolution.Results[1].Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.HeadingMissing, resolution.Results[2].Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.BlockDuplicate, resolution.Results[3].Result.Error!.Code);
        Assert.All(resolution.Results, result => Assert.Equal(ArticleEmbedProviderResultStatus.Failed, result.Result.Status));
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Fact]
    public void SelfCycleAndMultiHopCycleFailLocallyWithoutStackOverflow()
    {
        ArticleEmbedDirectiveProjection selfNested = Nested(ArticleA, ArticleEmbedTargetKind.Article, 10);
        ArticleEmbedDirectiveProjection toB = Nested(ArticleB, ArticleEmbedTargetKind.Article, 50);
        ArticleEmbedDirectiveProjection toA = Nested(ArticleA, ArticleEmbedTargetKind.Article, 10);
        var snapshot = Snapshot(
            PublicFacts(ArticleA, 4, nested: [selfNested, toB]),
            PublicFacts(ArticleB, 6, nested: [toA]));
        ArticleEmbedProviderRequest[] requests =
        [
            Request("request:cycles", ArticleA, ArticleEmbedTargetKind.Article, 0)
        ];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringEmbedResult result = Assert.Single(resolution.Results);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, result.Result.Status);
        Assert.Equal(2, result.Children.Count);
        Assert.Equal(ArticleEmbedErrorCode.Cycle, result.Children[0].Error!.Code);
        ArticleEmbedResolvedNode b = result.Children[1];
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, b.Status);
        ArticleEmbedResolvedNode backToA = Assert.Single(b.Children);
        Assert.Equal(ArticleEmbedErrorCode.Cycle, backToA.Error!.Code);
        ArticleEmbedAuthoringVerification verification = ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution);
        Assert.True(verification.Valid, string.Join(",", verification.ReasonCodes));
    }

    [Fact]
    public void SharedSubtreeResolvesOnceAndSecondReferenceIsACacheHit()
    {
        ArticleEmbedDirectiveProjection toShared = Nested(ArticleC, ArticleEmbedTargetKind.Article, 10);
        var snapshot = Snapshot(
            PublicFacts(ArticleA, 4, nested: [toShared]),
            PublicFacts(ArticleB, 6, nested: [toShared]),
            PublicFacts(ArticleC, 8));
        ArticleEmbedProviderRequest[] requests =
        [
            Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0),
            Request("request:b", ArticleB, ArticleEmbedTargetKind.Article, 40),
            Request("request:again", ArticleC, ArticleEmbedTargetKind.Article, 80)
        ];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        Assert.All(resolution.Results, result => Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, result.Result.Status));
        Assert.True(resolution.Receipt.Items[2].CacheHit);
        Assert.Equal(1, resolution.Receipt.CacheHitCount);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Fact]
    public void DepthNodeByteAndMessageBudgetsFailLocally()
    {
        ArticleEmbedDirectiveProjection toB = Nested(ArticleB, ArticleEmbedTargetKind.Article, 10);
        ArticleEmbedDirectiveProjection toC = Nested(ArticleC, ArticleEmbedTargetKind.Article, 10);
        var snapshot = Snapshot(
            PublicFacts(ArticleA, 4, nested: [toB], bytes: 700),
            PublicFacts(ArticleB, 6, nested: [toC], bytes: 700),
            PublicFacts(ArticleC, 8, bytes: 700));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        var depthLimited = new ArticleEmbedResolutionBudgetLimits(2, 64, 1_048_576, 60_000, 128);
        ArticleEmbedAuthoringResolution deep = ResolveGraph(requests, snapshot, depthLimited);
        Assert.Equal(ArticleEmbedErrorCode.DepthExceeded, Assert.Single(deep.Results[0].Children[0].Children).Error!.Code);
        ArticleEmbedAuthoringVerification deepVerification = ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, depthLimited, deep);
        Assert.True(deepVerification.Valid, string.Join(",", deepVerification.ReasonCodes));

        var nodeLimited = new ArticleEmbedResolutionBudgetLimits(8, 2, 1_048_576, 60_000, 128);
        ArticleEmbedAuthoringResolution nodes = ResolveGraph(requests, snapshot, nodeLimited);
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, nodes.Results[0].Children[0].Children[0].Error!.Code);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, nodeLimited, nodes).Valid);

        var byteLimited = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_000, 60_000, 128);
        ArticleEmbedAuthoringResolution bytes = ResolveGraph(requests, snapshot, byteLimited);
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, bytes.Results[0].Children[0].Error!.Code);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, byteLimited, bytes).Valid);

        var messageLimited = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_048_576, 60_000, 2);
        ArticleEmbedAuthoringResolution messages = ResolveGraph(requests, snapshot, messageLimited);
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, messages.Results[0].Children[0].Children[0].Error!.Code);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, messageLimited, messages).Valid);
    }

    [Fact]
    public void ElapsedBudgetTripsWhenTheClockRunsOut()
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        var time = new StepTimeProvider();
        var budgets = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_048_576, 1, 128);

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, budgets, time);

        Assert.Equal(ArticleEmbedErrorCode.TimeExceeded, Assert.Single(resolution.Results).Result.Error!.Code);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, resolution).Valid);
    }

    [Fact]
    public void HostSourceEpochActorAndRuntimeDriftMakeResultsStale()
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] driftedSource =
        [
            Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0, sourceRevision: 99)
        ];
        ArticleEmbedProviderRequest[] driftedEpoch =
        [
            Request("request:b", ArticleA, ArticleEmbedTargetKind.Article, 0, document: s_document with { Epoch = 9 })
        ];
        ArticleEmbedProviderRequest[] driftedActor =
        [
            Request("request:c", ArticleA, ArticleEmbedTargetKind.Article, 0, actor: s_actor with { PermissionContextDigest = DigestD })
        ];
        ArticleEmbedProviderRequest[] driftedRuntime =
        [
            Request("request:d", ArticleA, ArticleEmbedTargetKind.Article, 0, runtime: s_runtime with { RuntimeDigest = DigestD })
        ];
        ArticleEmbedProviderRequest[] driftedHost =
        [
            Request("request:e", ArticleA, ArticleEmbedTargetKind.Article, 0, host: ArticleC)
        ];

        Assert.Equal(ArticleEmbedErrorCode.StaleSource,
            Assert.Single(ResolveGraph(driftedSource, snapshot, s_budgets).Results).Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.StaleSource,
            Assert.Single(ResolveGraph(driftedEpoch, snapshot, s_budgets).Results).Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.StaleSource,
            Assert.Single(ResolveGraph(driftedActor, snapshot, s_budgets).Results).Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.StaleRuntime,
            Assert.Single(ResolveGraph(driftedRuntime, snapshot, s_budgets).Results).Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.StaleSource,
            Assert.Single(ResolveGraph(driftedHost, snapshot, s_budgets).Results).Result.Error!.Code);
    }

    [Fact]
    public void TargetGenerationDriftAndAbortedSignalFailStale()
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 4) with
        {
            AuthorityGeneration = 9
        });
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedAuthoringResolution stale = ResolveGraph(requests, snapshot, s_budgets);
        Assert.Equal(ArticleEmbedErrorCode.StaleTarget, Assert.Single(stale.Results).Result.Error!.Code);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, stale).Valid);

        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        ArticleEmbedProviderRequest[] aborted =
        [
            Request("request:b", ArticleA, ArticleEmbedTargetKind.Article, 0, cancellationToken: cancellation.Token)
        ];
        var clean = Snapshot(PublicFacts(ArticleA, 4));
        ArticleEmbedAuthoringResolution cancelled = ResolveGraph(aborted, clean, s_budgets);
        Assert.Equal(ArticleEmbedErrorCode.StaleSource, Assert.Single(cancelled.Results).Result.Error!.Code);
    }

    [Fact]
    public void LocalFailureDoesNotReplaceTheWholeDocument()
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests =
        [
            Request("request:ok", ArticleA, ArticleEmbedTargetKind.Article, 0),
            Request("request:bad", ArticleB, ArticleEmbedTargetKind.Article, 40)
        ];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, resolution.Results[0].Result.Status);
        Assert.Equal(ArticleEmbedErrorCode.Missing, resolution.Results[1].Result.Error!.Code);
        Assert.Equal(1, resolution.Receipt.ResolvedCount);
        Assert.Equal(1, resolution.Receipt.FailedCount);
    }

    [Fact]
    public void UpdateAvailableComparesLatestAgainstResolvedWithoutMutatingSource()
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 4) with
        {
            LatestObservedRevision = 7
        });
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringEmbedResult result = Assert.Single(resolution.Results);
        Assert.True(result.UpdateAvailable);
        Assert.Equal(4, result.Result.Coordinate!.ResolvedRevision);
        Assert.True(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Fact]
    public void CacheKeyBindsHostTargetRuntimePermissionSiteAndMaterial()
    {
        var first = new ArticleEmbedAuthoringCacheKey(
            s_document.Id,
            s_document.Epoch,
            8,
            ArticleA,
            4,
            ArticleEmbedTargetKind.Article,
            null,
            null,
            s_runtime.ProviderId,
            s_runtime.ProviderVersion,
            s_runtime.RuntimeDigest,
            s_actor.PermissionContextDigest,
            s_actor.SiteIdentity,
            "zh-CN",
            "light");
        ArticleEmbedAuthoringCacheKey otherActor = first with
        {
            PermissionContextDigest = DigestD
        };
        ArticleEmbedAuthoringCacheKey otherEpoch = first with
        {
            HostDocumentEpoch = 4
        };
        ArticleEmbedAuthoringCacheKey otherLocale = first with
        {
            MaterialLocale = "en-US"
        };

        Assert.NotEqual(
            ArticleEmbedAuthoringDigest.ComputeCacheKey(first),
            ArticleEmbedAuthoringDigest.ComputeCacheKey(otherActor));
        Assert.NotEqual(
            ArticleEmbedAuthoringDigest.ComputeCacheKey(first),
            ArticleEmbedAuthoringDigest.ComputeCacheKey(otherEpoch));
        Assert.NotEqual(
            ArticleEmbedAuthoringDigest.ComputeCacheKey(first),
            ArticleEmbedAuthoringDigest.ComputeCacheKey(otherLocale));
    }

    [Fact]
    public void RejectsInvalidBudgetsTamperedSnapshotAndOversizedRequestSet()
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        Assert.Equal(
            ArticleEmbedAuthoringResolutionStatus.Rejected,
            ResolveGraph(requests, snapshot, null).Status);
        Assert.Equal(
            ArticleEmbedAuthoringResolutionStatus.Rejected,
            ResolveGraph(requests, snapshot, new ArticleEmbedResolutionBudgetLimits(0, 1, 1, 1, 1)).Status);
        Assert.Equal(
            ArticleEmbedAuthoringResolutionStatus.Rejected,
            ResolveGraph(requests, snapshot with
            {
                HostSourceRevision = 99
            }, s_budgets).Status);
        Assert.Equal(
            ArticleEmbedAuthoringResolutionStatus.Rejected,
            ResolveGraph(null, snapshot, s_budgets).Status);
        Assert.Equal(
            ArticleEmbedAuthoringResolutionStatus.Rejected,
            ResolveGraph(
                Enumerable.Range(0, 3)
                    .Select(index => Request($"request:{index}", ArticleA, ArticleEmbedTargetKind.Article, index * 40))
                    .ToArray(),
                snapshot,
                new ArticleEmbedResolutionBudgetLimits(8, 2, 1_048_576, 60_000, 128)).Status);
    }

    [Fact]
    public void VerifierRejectsResultReceiptAndTreeTamper()
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 17));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedAuthoringResolution resolution = ResolveGraph(requests, snapshot, s_budgets);

        Assert.False(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, null).Valid);
        Assert.False(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution with
        {
            Results = [resolution.Results[0] with { UpdateAvailable = true }]
        }).Valid);
        Assert.False(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution with
        {
            Receipt = resolution.Receipt with
            {
                ResolvedCount = 0
            }
        }).Valid);
        Assert.False(ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, s_budgets, resolution with
        {
            Results = [resolution.Results[0] with
            {
                Result = resolution.Results[0].Result with { Visibility = ArticleEmbedVisibilityStatus.Private }
            }]
        }).Valid);
        Assert.False(ArticleEmbedDependencyGraphVerifier.Verify(
            requests,
            Snapshot(PublicFacts(ArticleA, 18)),
            s_budgets,
            resolution).Valid);
    }

    [Theory]
    [InlineData(ArticleEmbedTargetKind.Article)]
    [InlineData(ArticleEmbedTargetKind.Heading)]
    [InlineData(ArticleEmbedTargetKind.Block)]
    public void RefreshComparisonUsesExactCurrentCoordinateWithoutChangingSource(ArticleEmbedTargetKind mode)
    {
        var previous = RefreshInput(mode, 9);
        var current = RefreshInput(mode, 10);
        ArticleEmbedDependencyCoordinate recorded = previous.Resolution.Results[0].Result.Coordinate!;
        ArticleEmbedProviderRequest originalRequest = current.Requests[0];
        string originalResolutionDigest = current.Resolution.ResolutionDigest;

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            current.Requests, current.Snapshot, s_budgets, current.Resolution, originalRequest.RequestId,
            recorded, out bool changed);

        Assert.True(comparison.IsValid, comparison.ReasonCode);
        Assert.True(changed);
        Assert.Same(originalRequest, current.Requests[0]);
        Assert.Equal(previous.Requests[0].Directive, originalRequest.Directive);
        Assert.Equal(previous.Requests[0].ContentDigest, originalRequest.ContentDigest);
        Assert.Equal(9, recorded.ResolvedRevision);
        Assert.Equal(originalResolutionDigest, current.Resolution.ResolutionDigest);
        Assert.Equal(10, current.Resolution.Results[0].Result.Coordinate!.ResolvedRevision);
    }

    [Fact]
    public void RefreshComparisonDoesNotUseLatestObservedHintAsANewCoordinate()
    {
        var input = RefreshInput(ArticleEmbedTargetKind.Article, 9);
        var snapshot = Snapshot(PublicFacts(ArticleA, 9) with
        {
            LatestObservedRevision = 10
        });
        ArticleEmbedAuthoringResolution current = ResolveGraph(input.Requests, snapshot, s_budgets);
        Assert.True(current.Results[0].UpdateAvailable);

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            input.Requests, snapshot, s_budgets, current, input.Requests[0].RequestId,
            input.Resolution.Results[0].Result.Coordinate, out bool changed);

        Assert.True(comparison.IsValid);
        Assert.False(changed);
        Assert.Equal(9, current.Results[0].Result.Coordinate!.ResolvedRevision);
    }

    [Fact]
    public void RefreshComparisonAllowsAuthorizedPrivateDraftWithoutPublicationAdmission()
    {
        var previous = RefreshInput(ArticleEmbedTargetKind.Article, 9);
        var snapshot = Snapshot(PublicFacts(ArticleA, 10) with
        {
            Visibility = ArticleEmbedVisibilityStatus.Private,
            Lifecycle = ArticleEmbedLifecycleStatus.Draft
        });
        ArticleEmbedAuthoringResolution current = ResolveGraph(previous.Requests, snapshot, s_budgets);

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            previous.Requests, snapshot, s_budgets, current, previous.Requests[0].RequestId,
            previous.Resolution.Results[0].Result.Coordinate, out bool changed);

        Assert.True(comparison.IsValid);
        Assert.True(changed);
        Assert.Equal(ArticleEmbedPublicationEligibility.AuthoringOnly, current.Results[0].Eligibility);
        Assert.Equal(ArticleEmbedVisibilityStatus.Private, current.Results[0].Result.Visibility);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("permission")]
    [InlineData("revision")]
    [InlineData("heading")]
    [InlineData("block")]
    public void RefreshComparisonBlocksUnavailableCurrentProjection(string failure)
    {
        ArticleEmbedTargetKind mode = failure switch
        {
            "heading" => ArticleEmbedTargetKind.Heading,
            "block" => ArticleEmbedTargetKind.Block,
            _ => ArticleEmbedTargetKind.Article
        };
        var previous = RefreshInput(mode, 9);
        ArticleEmbedTargetFacts facts = PublicFacts(ArticleA, 10);
        facts = failure switch
        {
            "permission" => facts with { Permission = ArticleEmbedPermissionStatus.Denied },
            "revision" => facts with { SourceRevision = 11 },
            _ => facts
        };
        var snapshot = failure == "missing" ? Snapshot() : Snapshot(facts);
        ArticleEmbedAuthoringResolution current = ResolveGraph(previous.Requests, snapshot, s_budgets);

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            previous.Requests, snapshot, s_budgets, current, previous.Requests[0].RequestId,
            previous.Resolution.Results[0].Result.Coordinate, out bool changed);

        Assert.False(comparison.IsValid);
        Assert.False(changed);
        Assert.Null(current.Results[0].Result.Coordinate);
    }

    [Theory]
    [InlineData("host")]
    [InlineData("range")]
    [InlineData("permission")]
    public void RefreshComparisonRequiresRevalidationAfterBindingDrift(string drift)
    {
        var input = RefreshInput(ArticleEmbedTargetKind.Article, 9);
        ArticleEmbedProviderRequest[] requests = input.Requests;
        ArticleEmbedAuthoritySnapshot snapshot = input.Snapshot;
        if (drift == "range")
        {
            requests = [ArticleEmbedContractValidator.Seal(requests[0] with
            {
                Directive = requests[0].Directive with { RawRange = new ArticleEmbedSourceRange(40, 72) }
            })];
        }
        else
        {
            snapshot = ArticleEmbedAuthoringContractValidator.Seal(snapshot with
            {
                HostDocument = drift == "host" ? s_document with
                {
                    Epoch = 99
                } : snapshot.HostDocument,
                Actor = drift == "permission" ? s_actor with
                {
                    PermissionContextDigest = DigestD
                } : snapshot.Actor
            });
        }

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            requests, snapshot, s_budgets, input.Resolution, requests[0].RequestId,
            input.Resolution.Results[0].Result.Coordinate, out bool changed);

        Assert.False(comparison.IsValid);
        Assert.False(changed);
    }

    [Fact]
    public void RefreshComparisonRejectsCancelledCurrentRequest()
    {
        using var cancellation = new CancellationTokenSource();
        var snapshot = Snapshot(PublicFacts(ArticleA, 9));
        ArticleEmbedProviderRequest[] requests =
            [Request("request:cancel-refresh", ArticleA, ArticleEmbedTargetKind.Article, 0, cancellationToken: cancellation.Token)];
        ArticleEmbedAuthoringResolution current = ResolveGraph(requests, snapshot, s_budgets);
        cancellation.Cancel();

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            requests, snapshot, s_budgets, current, requests[0].RequestId,
            current.Results[0].Result.Coordinate, out bool changed);

        Assert.False(comparison.IsValid);
        Assert.False(changed);
    }

    [Fact]
    public void RefreshComparisonDoesNotAcceptAnUnrelatedRecordedTarget()
    {
        var input = RefreshInput(ArticleEmbedTargetKind.Article, 9);
        var snapshot = Snapshot(PublicFacts(ArticleB, 9));
        ArticleEmbedProviderRequest[] otherRequests = [Request("request:other", ArticleB, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedAuthoringResolution other = ResolveGraph(otherRequests, snapshot, s_budgets);

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            input.Requests, input.Snapshot, s_budgets, input.Resolution, input.Requests[0].RequestId,
            other.Results[0].Result.Coordinate, out bool changed);

        Assert.False(comparison.IsValid);
        Assert.Equal("article_embed_refresh_recorded_coordinate_mismatch", comparison.ReasonCode);
        Assert.False(changed);
    }

    [Theory]
    [InlineData(ArticleEmbedTargetKind.Article, ArticleEmbedTargetKind.Heading)]
    [InlineData(ArticleEmbedTargetKind.Heading, ArticleEmbedTargetKind.Block)]
    [InlineData(ArticleEmbedTargetKind.Block, ArticleEmbedTargetKind.Article)]
    public void RefreshComparisonDoesNotGuessBetweenModes(ArticleEmbedTargetKind previousMode, ArticleEmbedTargetKind currentMode)
    {
        var previous = RefreshInput(previousMode, 9);
        var current = RefreshInput(currentMode, 10);

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            current.Requests, current.Snapshot, s_budgets, current.Resolution, current.Requests[0].RequestId,
            previous.Resolution.Results[0].Result.Coordinate, out bool changed);

        Assert.False(comparison.IsValid);
        Assert.Equal("article_embed_refresh_recorded_coordinate_mismatch", comparison.ReasonCode);
        Assert.False(changed);
    }

    [Fact]
    public void RefreshComparisonRejectsTamperedRecordedDigest()
    {
        var input = RefreshInput(ArticleEmbedTargetKind.Article, 9);
        var tampered = input.Resolution.Results[0].Result.Coordinate! with
        {
            DependencyDigest = DigestA
        };

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            input.Requests, input.Snapshot, s_budgets, input.Resolution, input.Requests[0].RequestId, tampered,
            out bool changed);

        Assert.False(comparison.IsValid);
        Assert.False(changed);
    }

    [Fact]
    public void RefreshComparisonSelectsOnlyOneExplicitRequestDespiteAnUnrelatedFailure()
    {
        var previous = RefreshInput(ArticleEmbedTargetKind.Article, 9);
        ArticleEmbedProviderRequest[] requests =
        [
            previous.Requests[0],
            Request("request:unavailable", ArticleC, ArticleEmbedTargetKind.Article, 40)
        ];
        var snapshot = Snapshot(PublicFacts(ArticleA, 10, nested: [Nested(ArticleB, ArticleEmbedTargetKind.Article, 10)]),
            PublicFacts(ArticleB, 7));
        ArticleEmbedAuthoringResolution current = ResolveGraph(requests, snapshot, s_budgets);
        string unchangedDigest = current.ResolutionDigest;

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            requests, snapshot, s_budgets, current, requests[0].RequestId,
            previous.Resolution.Results[0].Result.Coordinate, out bool changed);

        Assert.True(comparison.IsValid, comparison.ReasonCode);
        Assert.True(changed);
        Assert.Equal(ArticleEmbedErrorCode.Missing, current.Results[1].Result.Error!.Code);
        Assert.Equal(unchangedDigest, current.ResolutionDigest);
        Assert.Equal(7, Assert.Single(current.Results[0].Children).Coordinate!.ResolvedRevision);
    }

    [Fact]
    public void RefreshComparisonRejectsAbsentCandidateWithoutAnUpdateHint()
    {
        var input = RefreshInput(ArticleEmbedTargetKind.Article, 9);

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            input.Requests, input.Snapshot, s_budgets, null, input.Requests[0].RequestId,
            input.Resolution.Results[0].Result.Coordinate, out bool changed);

        Assert.False(comparison.IsValid);
        Assert.False(changed);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RefreshComparisonBlocksFailedNestedDependencies(bool budgetFailure)
    {
        var previous = RefreshInput(ArticleEmbedTargetKind.Article, 9);
        var snapshot = Snapshot(PublicFacts(ArticleA, 10, nested: [Nested(ArticleA, ArticleEmbedTargetKind.Article, 10)]));
        var budgets = budgetFailure ? s_budgets with
        {
            MaxExpandedNodes = 1
        } : s_budgets;
        ArticleEmbedAuthoringResolution current = ResolveGraph(previous.Requests, snapshot, budgets);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, current.Results[0].Result.Status);
        Assert.Equal(ArticleEmbedProviderResultStatus.Failed, current.Results[0].Children[0].Status);

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            previous.Requests, snapshot, budgets, current, previous.Requests[0].RequestId,
            previous.Resolution.Results[0].Result.Coordinate, out bool changed);

        Assert.False(comparison.IsValid);
        Assert.False(changed);
    }

    [Theory]
    [InlineData("unknown")]
    [InlineData("duplicate")]
    public void RefreshComparisonRequiresOneExactRequestSelection(string selection)
    {
        var previous = RefreshInput(ArticleEmbedTargetKind.Article, 9);
        ArticleEmbedProviderRequest[] requests =
        [
            previous.Requests[0],
            Request(selection == "duplicate" ? previous.Requests[0].RequestId : "request:b", ArticleB, ArticleEmbedTargetKind.Article, 40)
        ];
        var snapshot = Snapshot(PublicFacts(ArticleA, 10), PublicFacts(ArticleB, 7));
        ArticleEmbedAuthoringResolution current = ResolveGraph(requests, snapshot, s_budgets);

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            requests, snapshot, s_budgets, current, selection == "unknown" ? "request:absent" : requests[0].RequestId,
            previous.Resolution.Results[0].Result.Coordinate, out bool changed);

        Assert.False(comparison.IsValid);
        Assert.Equal(selection == "unknown" ? "article_embed_refresh_request_missing"
            : "article_embed_refresh_request_ambiguous", comparison.ReasonCode);
        Assert.False(changed);
    }

    [Fact]
    public void RefreshComparisonRejectsCyclicCandidateCollectionsBeforeDigestWork()
    {
        var input = RefreshInput(ArticleEmbedTargetKind.Article, 9);
        var children = new List<ArticleEmbedResolvedNode>();
        var node = new ArticleEmbedResolvedNode(
            Nested(ArticleA, ArticleEmbedTargetKind.Article, 10), input.Requests[0].Target,
            ArticleEmbedProviderResultStatus.Resolved, input.Resolution.Results[0].Result.Coordinate, null, children);
        children.Add(node);
        var malformed = input.Resolution with
        {
            Results = [input.Resolution.Results[0] with { Children = children }]
        };

        ArticleEmbedValidationResult comparison = ArticleEmbedAuthoringRefreshPolicy.TryCompare(
            input.Requests, input.Snapshot, s_budgets, malformed, input.Requests[0].RequestId,
            input.Resolution.Results[0].Result.Coordinate, out bool changed);

        Assert.False(comparison.IsValid);
        Assert.Equal("article_embed_refresh_candidate_unbounded_or_missing", comparison.ReasonCode);
        Assert.False(changed);
    }

    private static (ArticleEmbedProviderRequest[] Requests, ArticleEmbedAuthoritySnapshot Snapshot,
        ArticleEmbedAuthoringResolution Resolution) RefreshInput(ArticleEmbedTargetKind mode, long revision)
    {
        string token = mode switch
        {
            ArticleEmbedTargetKind.Heading => $"{ArticleA}#{HeadingA}",
            ArticleEmbedTargetKind.Block => $"{ArticleA}#exact-anchor",
            _ => ArticleA
        };
        ArticleEmbedProviderRequest[] requests = [Request("request:refresh", token, mode, 0)];
        var snapshot = Snapshot(PublicFacts(ArticleA, revision,
            headings: [new ArticleEmbedHeadingFact(HeadingA, Projection("projection:heading"))],
            blocks: [new ArticleEmbedBlockFact("exact-anchor", Projection("projection:block"))]));
        return (requests, snapshot, ResolveGraph(requests, snapshot, s_budgets));
    }

    private static ArticleEmbedAuthoringResolution ResolveGraph(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests, ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedResolutionBudgetLimits? budgets, TimeProvider? time = null)
    {
        ArticleEmbedAuthoringResolution projection = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, budgets, time);
        return ArticleEmbedDependencyGraphPlanner.Expand(requests, snapshot, budgets, projection, time);
    }

    private static ArticleEmbedProviderRequest Request(
        string requestId,
        string token,
        ArticleEmbedTargetKind mode,
        int start,
        long sourceRevision = 8,
        ArticleEmbedDocumentIdentity? document = null,
        ArticleEmbedActorContext? actor = null,
        ArticleEmbedRuntimeContext? runtime = null,
        string? host = null,
        CancellationToken cancellationToken = default)
    {
        CancellationToken signal = cancellationToken.CanBeCanceled
            ? cancellationToken
            : s_signal;
        ArticleEmbedTargetCodec.TryDecode(token, mode, out ArticleEmbedTargetIdentity? target);
        return ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderRequest(
            ArticleEmbedSchemas.ProviderRequest,
            ArticleEmbedSchemas.Version,
            requestId,
            host ?? Host,
            document ?? s_document,
            sourceRevision,
            new ArticleEmbedDirectiveProjection(
                ArticleEmbedSchemas.ParserContract,
                token,
                mode,
                new ArticleEmbedSourceRange(start, start + 32)),
            target!,
            ArticleEmbedRequestedScope.Authoring,
            actor ?? s_actor,
            runtime ?? s_runtime,
            DigestC,
            string.Empty,
            signal));
    }

    private static ArticleEmbedDirectiveProjection Nested(string token, ArticleEmbedTargetKind mode, int start)
        => new(ArticleEmbedSchemas.ParserContract, token, mode, new ArticleEmbedSourceRange(start, start + 32));

    private static ArticleEmbedSafeProjectionReference Projection(string identity)
        => new(ArticleEmbedProjectionKind.SafeProjection, identity, DigestD);

    private static ArticleEmbedTargetFacts PublicFacts(
        string portableIdentity,
        long resolvedRevision,
        ArticleEmbedHeadingFact[]? headings = null,
        ArticleEmbedBlockFact[]? blocks = null,
        ArticleEmbedDirectiveProjection[]? nested = null,
        long bytes = 128)
        => new(
            portableIdentity,
            s_actor.SiteIdentity,
            1,
            resolvedRevision,
            resolvedRevision,
            resolvedRevision,
            ArticleEmbedVisibilityStatus.Public,
            ArticleEmbedLifecycleStatus.Published,
            ArticleEmbedPermissionStatus.Allowed,
            DigestB,
            $"revision:{resolvedRevision}",
            bytes,
            "Target display",
            Projection("projection:article-body"),
            headings ?? [],
            blocks ?? [],
            nested ?? []);

    private static ArticleEmbedAuthoritySnapshot Snapshot(params ArticleEmbedTargetFacts[] targets)
        => ArticleEmbedAuthoringContractValidator.Seal(new ArticleEmbedAuthoritySnapshot(
            ArticleEmbedAuthoringSchemas.AuthoritySnapshot,
            ArticleEmbedAuthoringSchemas.Version,
            Host,
            s_document,
            8,
            DigestC,
            1,
            s_actor,
            s_runtime,
            "zh-CN",
            "light",
            targets,
            string.Empty));

    private sealed class StepTimeProvider : TimeProvider
    {
        private long _now = 1_000_000;

        public override long GetTimestamp() => _now += TimestampFrequency * 60;
    }
}
