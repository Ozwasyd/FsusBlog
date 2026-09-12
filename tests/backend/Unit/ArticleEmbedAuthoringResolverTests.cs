using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

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

        ArticleEmbedAuthoringResolution resolution = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

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
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
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

        ArticleEmbedAuthoringResolution resolution = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringEmbedResult result = Assert.Single(resolution.Results);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, result.Result.Status);
        Assert.Equal(ArticleEmbedPublicationEligibility.AuthoringOnly, result.Eligibility);
        Assert.Equal(visibility, result.Result.Visibility);
        Assert.Equal(lifecycle, result.Result.Lifecycle);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Theory]
    [InlineData(ArticleEmbedLifecycleStatus.Archived, ArticleEmbedErrorCode.Archived)]
    [InlineData(ArticleEmbedLifecycleStatus.Deleted, ArticleEmbedErrorCode.Deleted)]
    [InlineData(ArticleEmbedLifecycleStatus.Unknown, ArticleEmbedErrorCode.Unpublished)]
    public void ArchivedDeletedAndUnknownLifecycleTargetsFailClosed(
        ArticleEmbedLifecycleStatus lifecycle,
        ArticleEmbedErrorCode expected)
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 9) with { Lifecycle = lifecycle });
        ArticleEmbedProviderRequest[] requests = [Request("request:one", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedAuthoringResolution resolution = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringEmbedResult result = Assert.Single(resolution.Results);
        Assert.Equal(ArticleEmbedProviderResultStatus.Failed, result.Result.Status);
        Assert.Equal(expected, result.Result.Error!.Code);
        Assert.Null(result.OpenSource);
        Assert.Equal(ArticleEmbedPublicationEligibility.AuthoringOnly, result.Eligibility);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
    }

    [Theory]
    [InlineData(ArticleEmbedPermissionStatus.Denied, ArticleEmbedErrorCode.PermissionDenied)]
    [InlineData(ArticleEmbedPermissionStatus.Unknown, ArticleEmbedErrorCode.PermissionUnknown)]
    public void PermissionDeniedOrUnknownTargetsNeverResolve(
        ArticleEmbedPermissionStatus permission,
        ArticleEmbedErrorCode expected)
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 9) with { Permission = permission });
        ArticleEmbedProviderRequest[] requests = [Request("request:one", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedAuthoringResolution resolution = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

        Assert.Equal(expected, Assert.Single(resolution.Results).Result.Error!.Code);
        Assert.Equal(permission, resolution.Results[0].Result.Permission);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
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

        ArticleEmbedAuthoringResolution resolution = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

        Assert.Equal(ArticleEmbedErrorCode.Missing, resolution.Results[0].Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.Ambiguous, resolution.Results[1].Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.HeadingMissing, resolution.Results[2].Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.BlockDuplicate, resolution.Results[3].Result.Error!.Code);
        Assert.All(resolution.Results, result => Assert.Equal(ArticleEmbedProviderResultStatus.Failed, result.Result.Status));
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
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

        ArticleEmbedAuthoringResolution resolution = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringEmbedResult result = Assert.Single(resolution.Results);
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, result.Result.Status);
        Assert.Equal(2, result.Children.Count);
        Assert.Equal(ArticleEmbedErrorCode.Cycle, result.Children[0].Error!.Code);
        ArticleEmbedResolvedNode b = result.Children[1];
        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, b.Status);
        ArticleEmbedResolvedNode backToA = Assert.Single(b.Children);
        Assert.Equal(ArticleEmbedErrorCode.Cycle, backToA.Error!.Code);
        ArticleEmbedAuthoringVerification verification = ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, resolution);
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

        ArticleEmbedAuthoringResolution resolution = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

        Assert.All(resolution.Results, result => Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, result.Result.Status));
        Assert.True(resolution.Receipt.Items[2].CacheHit);
        Assert.Equal(1, resolution.Receipt.CacheHitCount);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
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
        ArticleEmbedAuthoringResolution deep = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, depthLimited);
        Assert.Equal(ArticleEmbedErrorCode.DepthExceeded, Assert.Single(deep.Results[0].Children[0].Children).Error!.Code);
        ArticleEmbedAuthoringVerification deepVerification = ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, depthLimited, deep);
        Assert.True(deepVerification.Valid, string.Join(",", deepVerification.ReasonCodes));

        var nodeLimited = new ArticleEmbedResolutionBudgetLimits(8, 2, 1_048_576, 60_000, 128);
        ArticleEmbedAuthoringResolution nodes = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, nodeLimited);
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, nodes.Results[0].Children[0].Children[0].Error!.Code);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, nodeLimited, nodes).Valid);

        var byteLimited = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_000, 60_000, 128);
        ArticleEmbedAuthoringResolution bytes = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, byteLimited);
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, bytes.Results[0].Children[0].Error!.Code);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, byteLimited, bytes).Valid);

        var messageLimited = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_048_576, 60_000, 2);
        ArticleEmbedAuthoringResolution messages = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, messageLimited);
        Assert.Equal(ArticleEmbedErrorCode.SizeExceeded, messages.Results[0].Children[0].Children[0].Error!.Code);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, messageLimited, messages).Valid);
    }

    [Fact]
    public void ElapsedBudgetTripsWhenTheClockRunsOut()
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 4));
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        var time = new StepTimeProvider();
        var budgets = new ArticleEmbedResolutionBudgetLimits(8, 64, 1_048_576, 1, 128);

        ArticleEmbedAuthoringResolution resolution = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, budgets, time);

        Assert.Equal(ArticleEmbedErrorCode.TimeExceeded, Assert.Single(resolution.Results).Result.Error!.Code);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, budgets, resolution).Valid);
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
            Assert.Single(ArticleEmbedAuthoringResolver.Resolve(driftedSource, snapshot, s_budgets).Results).Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.StaleSource,
            Assert.Single(ArticleEmbedAuthoringResolver.Resolve(driftedEpoch, snapshot, s_budgets).Results).Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.StaleSource,
            Assert.Single(ArticleEmbedAuthoringResolver.Resolve(driftedActor, snapshot, s_budgets).Results).Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.StaleRuntime,
            Assert.Single(ArticleEmbedAuthoringResolver.Resolve(driftedRuntime, snapshot, s_budgets).Results).Result.Error!.Code);
        Assert.Equal(ArticleEmbedErrorCode.StaleSource,
            Assert.Single(ArticleEmbedAuthoringResolver.Resolve(driftedHost, snapshot, s_budgets).Results).Result.Error!.Code);
    }

    [Fact]
    public void TargetGenerationDriftAndAbortedSignalFailStale()
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 4) with { AuthorityGeneration = 9 });
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];
        ArticleEmbedAuthoringResolution stale = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);
        Assert.Equal(ArticleEmbedErrorCode.StaleTarget, Assert.Single(stale.Results).Result.Error!.Code);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, stale).Valid);

        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        ArticleEmbedProviderRequest[] aborted =
        [
            Request("request:b", ArticleA, ArticleEmbedTargetKind.Article, 0, cancellationToken: cancellation.Token)
        ];
        var clean = Snapshot(PublicFacts(ArticleA, 4));
        ArticleEmbedAuthoringResolution cancelled = ArticleEmbedAuthoringResolver.Resolve(aborted, clean, s_budgets);
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

        ArticleEmbedAuthoringResolution resolution = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

        Assert.Equal(ArticleEmbedProviderResultStatus.Resolved, resolution.Results[0].Result.Status);
        Assert.Equal(ArticleEmbedErrorCode.Missing, resolution.Results[1].Result.Error!.Code);
        Assert.Equal(1, resolution.Receipt.ResolvedCount);
        Assert.Equal(1, resolution.Receipt.FailedCount);
    }

    [Fact]
    public void UpdateAvailableComparesLatestAgainstResolvedWithoutMutatingSource()
    {
        var snapshot = Snapshot(PublicFacts(ArticleA, 4) with { LatestObservedRevision = 7 });
        ArticleEmbedProviderRequest[] requests = [Request("request:a", ArticleA, ArticleEmbedTargetKind.Article, 0)];

        ArticleEmbedAuthoringResolution resolution = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

        ArticleEmbedAuthoringEmbedResult result = Assert.Single(resolution.Results);
        Assert.True(result.UpdateAvailable);
        Assert.Equal(4, result.Result.Coordinate!.ResolvedRevision);
        Assert.True(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, resolution).Valid);
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
        ArticleEmbedAuthoringCacheKey otherActor = first with { PermissionContextDigest = DigestD };
        ArticleEmbedAuthoringCacheKey otherEpoch = first with { HostDocumentEpoch = 4 };
        ArticleEmbedAuthoringCacheKey otherLocale = first with { MaterialLocale = "en-US" };

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
            ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, null).Status);
        Assert.Equal(
            ArticleEmbedAuthoringResolutionStatus.Rejected,
            ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, new ArticleEmbedResolutionBudgetLimits(0, 1, 1, 1, 1)).Status);
        Assert.Equal(
            ArticleEmbedAuthoringResolutionStatus.Rejected,
            ArticleEmbedAuthoringResolver.Resolve(requests, snapshot with { HostSourceRevision = 99 }, s_budgets).Status);
        Assert.Equal(
            ArticleEmbedAuthoringResolutionStatus.Rejected,
            ArticleEmbedAuthoringResolver.Resolve(null, snapshot, s_budgets).Status);
        Assert.Equal(
            ArticleEmbedAuthoringResolutionStatus.Rejected,
            ArticleEmbedAuthoringResolver.Resolve(
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
        ArticleEmbedAuthoringResolution resolution = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, s_budgets);

        Assert.False(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, null).Valid);
        Assert.False(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, resolution with
        {
            Results = [resolution.Results[0] with { UpdateAvailable = true }]
        }).Valid);
        Assert.False(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, resolution with
        {
            Receipt = resolution.Receipt with { ResolvedCount = 0 }
        }).Valid);
        Assert.False(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, s_budgets, resolution with
        {
            Results = [resolution.Results[0] with
            {
                Result = resolution.Results[0].Result with { Visibility = ArticleEmbedVisibilityStatus.Private }
            }]
        }).Valid);
        Assert.False(ArticleEmbedAuthoringVerifier.Verify(
            requests,
            Snapshot(PublicFacts(ArticleA, 18)),
            s_budgets,
            resolution).Valid);
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
