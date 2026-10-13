using System.Text.Json;

using FsusBlog.Shared.Contracts.AuthoringCanvas;
using FsusBlog.Server.Services.Authoring;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringCanvasReferenceResolverTests
{
    private const string CanvasDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string AuthorityDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private static readonly AuthoringCanvasOwner s_owner = new(41, "primary-site");
    private static readonly AuthoringCanvasGeometry s_geometry = new(10, 20, 240, 120);

    [Fact]
    public async Task ResolveAsync_ProjectsCurrentAndPinnedReferencesInOneBoundedBatch()
    {
        AuthoringCanvasNode[] nodes =
        [
            Reference(101),
            Reference(102, AuthoringCanvasNodeType.HeadingReference, headingIdentity: "heading-a", pinned: 7),
            Reference(103, AuthoringCanvasNodeType.BlockReference, blockIdentity: "block-a", pinned: 6)
        ];
        var source = new DeterministicFactSource(target => target.NodeType switch
        {
            AuthoringCanvasNodeType.ArticleReference => Fact(target, currentRevision: 7, resolvedRevision: 7),
            AuthoringCanvasNodeType.HeadingReference => Fact(target, currentRevision: 7, resolvedRevision: 7),
            AuthoringCanvasNodeType.BlockReference => Fact(target, currentRevision: 7, resolvedRevision: 6),
            _ => throw new InvalidOperationException()
        });
        AuthoringCanvasReferenceResolver resolver = CreateResolver(nodes, source);
        AuthoringCanvasReferenceResolutionRequest request = Request(nodes) with
        {
            TargetWorkspaceGroupId = "research-group-b"
        };

        AuthoringCanvasReferenceResolutionBatch first = await resolver.ResolveAsync(request);
        AuthoringCanvasReferenceResolutionBatch cached = await resolver.ResolveAsync(request);

        Assert.Equal(
            [
                AuthoringCanvasReferenceProjectionStatus.Current,
                AuthoringCanvasReferenceProjectionStatus.PinnedCurrent,
                AuthoringCanvasReferenceProjectionStatus.PinnedStale
            ],
            first.Projections.Select(static projection => projection.Status));
        Assert.All(first.Projections, projection =>
        {
            Assert.Equal($"Article {projection.TargetArticleId}", projection.Title);
            Assert.NotNull(projection.ContextSnippet);
            Assert.NotNull(projection.OpenIntent);
            Assert.Equal(new string('e', 64), projection.DisplayProjectionReference);
            Assert.Equal(64, projection.ContentDigest.Length);
        });
        Assert.False(first.Projections[0].UpdateAvailable);
        Assert.True(first.Projections[2].UpdateAvailable);
        Assert.Equal(6, first.Projections[2].OpenIntent!.Revision);
        Assert.Equal(AuthoringCanvasOpenIntentMode.OpenOrActivate, first.Projections[2].OpenIntent!.Mode);
        Assert.All(first.Projections, static projection =>
            Assert.Equal("research-group-b", projection.OpenIntent!.TargetGroupId));
        Assert.Equal(1, source.BatchReadCount);
        Assert.Equal(3, cached.Receipt.CacheHitCount);
        Assert.Equal(first.ContentDigest, cached.ContentDigest);
        Assert.Equal(3, first.Receipt.Items.Count);
        Assert.All(first.Receipt.Items, static item => Assert.Equal(64, item.ContentDigest.Length));
        Assert.Equal(first.Projections[1].TargetHeadingIdentity, first.Receipt.Items[1].TargetHeadingIdentity);
        Assert.Equal(first.Projections[2].TargetBlockIdentity, first.Receipt.Items[2].TargetBlockIdentity);
        Assert.Equal(first.Projections[1].Title, first.Receipt.Items[1].Title);
        Assert.Equal(first.Projections[1].ContextSnippet, first.Receipt.Items[1].ContextSnippet);
        Assert.Equal(first.Projections[1].OpenIntent, first.Receipt.Items[1].OpenIntent);
        Assert.Equal(
            [
                "NodeId", "TargetArticleId", "TargetHeadingIdentity", "TargetBlockIdentity",
                "TargetRevision", "Status", "Title", "ContextSnippet", "OpenIntent", "ContentDigest"
            ],
            PropertyNames(JsonSerializer.Serialize(first.Receipt.Items[1])));
    }

    [Fact]
    public async Task ResolveAsync_MapsTargetUpdatedAndEmptyBatchesWithoutMutationOrNPlusOne()
    {
        AuthoringCanvasNode node = Reference(150);
        var source = new DeterministicFactSource(target => Fact(target) with
        {
            TargetChangedSinceProjection = true
        });
        AuthoringCanvasReferenceResolutionBatch updated = await CreateResolver([node], source)
            .ResolveAsync(Request([node]));

        Assert.Equal(AuthoringCanvasReferenceProjectionStatus.TargetUpdated, updated.Projections[0].Status);
        Assert.True(updated.Projections[0].UpdateAvailable);

        var emptySource = new DeterministicFactSource(target => Fact(target));
        AuthoringCanvasReferenceResolutionBatch empty = await CreateResolver([], emptySource)
            .ResolveAsync(Request([]));
        Assert.Empty(empty.Projections);
        Assert.Equal(0, emptySource.BatchReadCount);
        Assert.Equal(0, empty.Receipt.TargetCount);
    }

    [Fact]
    public async Task ResolveAsync_MapsLifecycleCoordinateAndPrivacyStatesWithoutContentLeaks()
    {
        const string SecretCanary = "SECRET-CANARY-ARTICLE-204";
        AuthoringCanvasNode[] nodes =
        [
            Reference(201),
            Reference(202),
            Reference(203),
            Reference(204),
            Reference(205, AuthoringCanvasNodeType.HeadingReference, headingIdentity: "heading-missing"),
            Reference(206, AuthoringCanvasNodeType.HeadingReference, headingIdentity: "heading-duplicate"),
            Reference(207, AuthoringCanvasNodeType.HeadingReference, headingIdentity: "heading-invalid"),
            Reference(208, AuthoringCanvasNodeType.BlockReference, blockIdentity: "block-missing"),
            Reference(209, AuthoringCanvasNodeType.BlockReference, blockIdentity: "block-duplicate"),
            Reference(210, AuthoringCanvasNodeType.BlockReference, blockIdentity: "block-invalid"),
            Reference(211)
        ];
        var facts = new Dictionary<int, AuthoringCanvasReferenceFact>
        {
            [201] = Fact(nodes[0], AuthoringCanvasArticleState.Missing),
            [202] = Fact(nodes[1], AuthoringCanvasArticleState.Deleted),
            [203] = Fact(nodes[2], AuthoringCanvasArticleState.Archived),
            [204] = Fact(nodes[3]) with { Title = SecretCanary },
            [205] = Fact(nodes[4], coordinate: AuthoringCanvasReferenceCoordinateState.Missing),
            [206] = Fact(nodes[5], coordinate: AuthoringCanvasReferenceCoordinateState.Duplicate),
            [207] = Fact(nodes[6], coordinate: AuthoringCanvasReferenceCoordinateState.Invalid),
            [208] = Fact(nodes[7], coordinate: AuthoringCanvasReferenceCoordinateState.Missing),
            [209] = Fact(nodes[8], coordinate: AuthoringCanvasReferenceCoordinateState.Duplicate),
            [210] = Fact(nodes[9], coordinate: AuthoringCanvasReferenceCoordinateState.Invalid),
            [211] = Fact(nodes[10], coordinate: AuthoringCanvasReferenceCoordinateState.SourceStale)
        };
        var source = new DeterministicFactSource(target => facts[target.TargetArticleId]);
        source.DeniedArticleIds.Add(204);
        AuthoringCanvasReferenceResolutionBatch result = await CreateResolver(nodes, source)
            .ResolveAsync(Request(nodes));

        Assert.Equal(
            [
                AuthoringCanvasReferenceProjectionStatus.Missing,
                AuthoringCanvasReferenceProjectionStatus.Deleted,
                AuthoringCanvasReferenceProjectionStatus.Archived,
                AuthoringCanvasReferenceProjectionStatus.PermissionDeniedOrUnknown,
                AuthoringCanvasReferenceProjectionStatus.HeadingMissing,
                AuthoringCanvasReferenceProjectionStatus.HeadingDuplicate,
                AuthoringCanvasReferenceProjectionStatus.HeadingInvalid,
                AuthoringCanvasReferenceProjectionStatus.BlockMissing,
                AuthoringCanvasReferenceProjectionStatus.BlockDuplicate,
                AuthoringCanvasReferenceProjectionStatus.BlockInvalid,
                AuthoringCanvasReferenceProjectionStatus.SourceStale
            ],
            result.Projections.Select(static projection => projection.Status));
        Assert.All(result.Projections.Take(10), static projection =>
        {
            Assert.Null(projection.Title);
            Assert.Null(projection.ContextSnippet);
            Assert.Null(projection.OpenIntent);
        });
        AuthoringCanvasReferenceProjection denied = result.Projections[3];
        Assert.Null(denied.TargetRevision);
        Assert.Null(denied.CurrentTargetRevision);
        AuthoringCanvasReferenceResolutionReceiptItem deniedReceipt = result.Receipt.Items[3];
        Assert.Null(deniedReceipt.Title);
        Assert.Null(deniedReceipt.ContextSnippet);
        Assert.Null(deniedReceipt.OpenIntent);

        string projectionJson = JsonSerializer.Serialize(denied);
        string receiptJson = JsonSerializer.Serialize(result.Receipt);
        Assert.DoesNotContain(SecretCanary, projectionJson, StringComparison.Ordinal);
        Assert.DoesNotContain(SecretCanary, receiptJson, StringComparison.Ordinal);
        Assert.Equal(
            [
                "NodeId", "NodeType", "TargetArticleId", "TargetHeadingIdentity", "TargetBlockIdentity",
                "Status", "Title", "ContextSnippet", "TargetRevision", "CurrentTargetRevision", "OpenIntent",
                "UpdateAvailable", "ContentDigest", "DisplayProjectionReference"
            ],
            PropertyNames(projectionJson));
        Assert.Equal(
            [
                "RequestId", "CanvasId", "CanvasRevision", "CanvasContentDigest", "Permission",
                "PermissionFingerprint", "AuthorityGeneration", "AuthorityContentDigest", "TargetCount",
                "CacheHitCount", "ElapsedMilliseconds", "Items", "ContentDigest"
            ],
            PropertyNames(receiptJson));
    }

    [Fact]
    public async Task OperationValidator_BindsReferenceStateAndCanonicalDisplayProjection()
    {
        AuthoringCanvasNode unresolved = Reference(901);
        var source = new DeterministicFactSource(target => Fact(target));
        var validator = new AuthoringCanvasOperationReferenceValidator(CreateResolver([unresolved], source));
        AuthoringCanvasNode current = unresolved with
        {
            DisplayProjectionReference = new string('e', 64),
            ReferenceState = AuthoringCanvasReferenceState.Current
        };
        var request = new AuthoringCanvasOperationReferenceValidationRequest(
            Guid.CreateVersion7(),
            Request([unresolved]).CanvasId,
            17,
            CanvasDigest,
            s_owner,
            [current]);

        string digest = await validator.ValidateAsync(request);

        Assert.Equal(64, digest.Length);
        AuthoringCanvasValidationException wrongState = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => validator.ValidateAsync(request with
            {
                References = [current with { ReferenceState = AuthoringCanvasReferenceState.Unresolved }]
            }));
        Assert.Equal("canvas_operation_reference_validation_mismatch", wrongState.Code);
        AuthoringCanvasValidationException wrongProjection = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => validator.ValidateAsync(request with
            {
                References = [current with { DisplayProjectionReference = new string('f', 64) }]
            }));
        Assert.Equal("canvas_operation_reference_validation_mismatch", wrongProjection.Code);
    }

    [Fact]
    public async Task ResolveAsync_FailsClosedForLeakingOrUnexpectedFactRows()
    {
        AuthoringCanvasNode node = Reference(301);
        var leakingSource = new DeterministicFactSource(target => DeniedFact(target) with
        {
            Title = "secret",
            CurrentRevision = 7,
            ResolvedRevision = 7
        });
        AuthoringCanvasReferenceResolver leakingResolver = CreateResolver([node], leakingSource);
        AuthoringCanvasValidationException leak = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => leakingResolver.ResolveAsync(Request([node])));
        Assert.Equal("canvas_reference_permission_fact_leak", leak.Code);

        var unexpectedSource = new DeterministicFactSource(
            target => Fact(target),
            appendUnexpected: true);
        AuthoringCanvasValidationException unexpected = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => CreateResolver([node], unexpectedSource).ResolveAsync(Request([node])));
        Assert.Equal("canvas_reference_fact_set_invalid", unexpected.Code);

        const string UnavailableCanary = "SECRET-CANVAS-TITLE";
        IAuthoringCanvasDocumentStore unavailable = Substitute.For<IAuthoringCanvasDocumentStore>();
        unavailable.GetAsync(s_owner, Arg.Any<Guid>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<AuthoringCanvasDocumentHeader?>(null));
        var unavailableResolver = new AuthoringCanvasReferenceResolver(
            unavailable,
            new DeterministicFactSource(target => Fact(target)),
            new AuthoringCanvasReferenceProjectionCache(),
            TimeProvider.System);
        AuthoringCanvasAccessDeniedException accessDenied = await Assert.ThrowsAsync<AuthoringCanvasAccessDeniedException>(
            () => unavailableResolver.ResolveAsync(Request([node])));
        Assert.Equal("authoring_canvas_unavailable", accessDenied.Message);
        Assert.DoesNotContain(UnavailableCanary, accessDenied.ToString(), StringComparison.Ordinal);
        Assert.DoesNotContain(node.TargetArticleId!.Value.ToString(), accessDenied.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ResolveAsync_BindsCacheToPermissionCanvasAndAuthorityCoordinates()
    {
        AuthoringCanvasNode node = Reference(401);
        var source = new DeterministicFactSource(target => Fact(target));
        var cache = new AuthoringCanvasReferenceProjectionCache(2);
        AuthoringCanvasReferenceResolver resolver = CreateResolver([node], source, cache);
        AuthoringCanvasReferenceResolutionRequest firstRequest = Request([node]);

        await resolver.ResolveAsync(firstRequest);
        await resolver.ResolveAsync(firstRequest);
        Assert.Equal(1, source.BatchReadCount);

        source.TitlePrefix = "Permission B";
        source.PermissionFingerprint = "permission-b";
        AuthoringCanvasReferenceResolutionRequest permissionB = firstRequest with
        {
            RequestId = Guid.CreateVersion7()
        };
        AuthoringCanvasReferenceResolutionBatch permissionResult = await resolver.ResolveAsync(permissionB);
        Assert.Equal("Permission B 401", permissionResult.Projections[0].Title);
        Assert.Equal(2, source.BatchReadCount);

        source.Generation = 2;
        source.TitlePrefix = "Generation 2";
        AuthoringCanvasReferenceResolutionBatch generationResult = await resolver.ResolveAsync(
            permissionB with
            {
                RequestId = Guid.CreateVersion7()
            });
        Assert.Equal("Generation 2 401", generationResult.Projections[0].Title);
        Assert.Equal(3, source.BatchReadCount);
        Assert.InRange(cache.EntryCount, 1, 2);
    }

    [Fact]
    public async Task ResolveAsync_RejectsStaleOutOfOrderAndCancelledWorkBeforeCaching()
    {
        AuthoringCanvasNode node = Reference(501);
        var source = new DeterministicFactSource(target => Fact(target));
        AuthoringCanvasReferenceResolutionRequest request = Request([node]);
        IAuthoringCanvasDocumentStore store = CanvasStore([node], revision: request.CanvasRevision + 1);
        var resolver = new AuthoringCanvasReferenceResolver(
            store,
            source,
            new AuthoringCanvasReferenceProjectionCache(),
            TimeProvider.System);

        await Assert.ThrowsAsync<AuthoringCanvasRevisionConflictException>(() => resolver.ResolveAsync(request));

        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            CreateResolver([node], source).ResolveAsync(request, cancelled.Token));
        Assert.Equal(0, source.BatchReadCount);

        var racingSource = new DeterministicFactSource(target => Fact(target));
        var racingCache = new AuthoringCanvasReferenceProjectionCache();
        IAuthoringCanvasDocumentStore racingStore = Substitute.For<IAuthoringCanvasDocumentStore>();
        racingStore.GetAsync(s_owner, request.CanvasId, Arg.Any<CancellationToken>()).Returns(
            Task.FromResult<AuthoringCanvasDocumentHeader?>(Header(
                request.CanvasId,
                [node],
                request.CanvasRevision,
                request.CanvasContentDigest)),
            Task.FromResult<AuthoringCanvasDocumentHeader?>(Header(
                request.CanvasId,
                [node],
                request.CanvasRevision + 1,
                new string('f', 64))));
        var racingResolver = new AuthoringCanvasReferenceResolver(
            racingStore,
            racingSource,
            racingCache,
            TimeProvider.System);

        await Assert.ThrowsAsync<AuthoringCanvasRevisionConflictException>(() =>
            racingResolver.ResolveAsync(request));
        Assert.Equal(1, racingSource.BatchReadCount);
        Assert.Equal(0, racingCache.EntryCount);

        using var cancelledAfterFacts = new CancellationTokenSource();
        var cancelledSource = new DeterministicFactSource(target => Fact(target))
        {
            AfterBatchRead = cancelledAfterFacts.Cancel
        };
        var cancelledCache = new AuthoringCanvasReferenceProjectionCache();
        var cancelledResolver = new AuthoringCanvasReferenceResolver(
            CanvasStore([node]),
            cancelledSource,
            cancelledCache,
            TimeProvider.System);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            cancelledResolver.ResolveAsync(request, cancelledAfterFacts.Token));
        Assert.Equal(1, cancelledSource.BatchReadCount);
        Assert.Equal(0, cancelledCache.EntryCount);
    }

    [Theory]
    [InlineData(false, "permission")]
    [InlineData(true, "permission")]
    [InlineData(false, "generation")]
    [InlineData(true, "generation")]
    [InlineData(false, "digest")]
    [InlineData(true, "digest")]
    public async Task ResolveAsync_RejectsAuthorityRaceBeforeReturningOrCaching(
        bool warmCache,
        string changedComponent)
    {
        AuthoringCanvasNode node = Reference(502);
        var source = new DeterministicFactSource(target => Fact(target));
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolutionRequest request = Request([node]);
        int canvasReads = 0;
        IAuthoringCanvasDocumentStore store = Substitute.For<IAuthoringCanvasDocumentStore>();
        store.GetAsync(s_owner, request.CanvasId, Arg.Any<CancellationToken>()).Returns(_ =>
        {
            canvasReads++;
            if (canvasReads == (warmCache ? 5 : 2))
            {
                switch (changedComponent)
                {
                    case "permission":
                        source.PermissionFingerprint = "permission-revoked";
                        break;
                    case "generation":
                        source.Generation++;
                        break;
                    case "digest":
                        source.ContentDigest = new string('f', 64);
                        break;
                    default:
                        throw new InvalidOperationException();
                }
            }
            return Task.FromResult<AuthoringCanvasDocumentHeader?>(Header(
                request.CanvasId,
                [node],
                request.CanvasRevision,
                request.CanvasContentDigest));
        });
        var resolver = new AuthoringCanvasReferenceResolver(store, source, cache, TimeProvider.System);
        if (warmCache)
        {
            AuthoringCanvasReferenceResolutionBatch first = await resolver.ResolveAsync(request);
            Assert.Equal(0, first.Receipt.CacheHitCount);
            Assert.Equal(1, cache.EntryCount);
        }

        AuthoringCanvasValidationException exception = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
            () => resolver.ResolveAsync(request));

        Assert.Equal("canvas_reference_authority_changed", exception.Code);
        Assert.Equal(warmCache ? 5 : 2, canvasReads);
        Assert.Equal(warmCache ? 4 : 2, source.AuthorityReadCount);
        Assert.Equal(1, source.BatchReadCount);
        Assert.Equal(warmCache ? 1 : 0, cache.EntryCount);
    }

    [Theory]
    [InlineData(false, "revision")]
    [InlineData(true, "revision")]
    [InlineData(false, "digest")]
    [InlineData(true, "digest")]
    public async Task ResolveAsync_RejectsDocumentRaceDuringFinalAuthorityReadBeforeReturningOrCaching(
        bool warmCache,
        string changedComponent)
    {
        AuthoringCanvasNode node = Reference(503);
        var cache = new AuthoringCanvasReferenceProjectionCache();
        AuthoringCanvasReferenceResolutionRequest request = Request([node]);
        long canvasRevision = request.CanvasRevision;
        string canvasDigest = request.CanvasContentDigest;
        var source = new DeterministicFactSource(target => Fact(target))
        {
            AfterAuthorityRead = readCount =>
            {
                if (readCount == (warmCache ? 4 : 2))
                {
                    switch (changedComponent)
                    {
                        case "revision":
                            canvasRevision++;
                            break;
                        case "digest":
                            canvasDigest = new string('f', 64);
                            break;
                        default:
                            throw new InvalidOperationException();
                    }
                }
            }
        };
        int canvasReads = 0;
        IAuthoringCanvasDocumentStore store = Substitute.For<IAuthoringCanvasDocumentStore>();
        store.GetAsync(s_owner, request.CanvasId, Arg.Any<CancellationToken>()).Returns(_ =>
        {
            canvasReads++;
            return Task.FromResult<AuthoringCanvasDocumentHeader?>(Header(
                request.CanvasId,
                [node],
                canvasRevision,
                canvasDigest));
        });
        var resolver = new AuthoringCanvasReferenceResolver(store, source, cache, TimeProvider.System);
        if (warmCache)
        {
            AuthoringCanvasReferenceResolutionBatch first = await resolver.ResolveAsync(request);
            Assert.Equal(0, first.Receipt.CacheHitCount);
            Assert.Equal(1, cache.EntryCount);
        }

        if (changedComponent == "revision")
        {
            await Assert.ThrowsAsync<AuthoringCanvasRevisionConflictException>(() => resolver.ResolveAsync(request));
        }
        else
        {
            AuthoringCanvasValidationException exception = await Assert.ThrowsAsync<AuthoringCanvasValidationException>(
                () => resolver.ResolveAsync(request));
            Assert.Equal("canvas_reference_content_digest_stale", exception.Code);
        }

        Assert.Equal(warmCache ? 6 : 3, canvasReads);
        Assert.Equal(warmCache ? 4 : 2, source.AuthorityReadCount);
        Assert.Equal(1, source.BatchReadCount);
        Assert.Equal(warmCache ? 1 : 0, cache.EntryCount);
    }

    [Fact]
    public async Task ResolveAsync_UsesStableIdsWhenTitlesMatchAndNeverFirstMatches()
    {
        AuthoringCanvasNode[] nodes = [Reference(601), Reference(602)];
        var source = new DeterministicFactSource(target => Fact(target) with
        {
            Title = "Same title",
            StableRoute = $"/author/articles/{target.TargetArticleId}"
        });
        AuthoringCanvasReferenceResolutionBatch result = await CreateResolver(nodes, source)
            .ResolveAsync(Request(nodes));

        Assert.Equal([601, 602], result.Projections.Select(static projection => projection.TargetArticleId));
        Assert.Equal(
            ["/author/articles/601", "/author/articles/602"],
            result.Projections.Select(static projection => projection.OpenIntent!.StableRoute));
    }

    [Fact]
    public async Task ResolveAsync_HandlesTenThousandReferencesWithOneSourceBatch()
    {
        AuthoringCanvasNode[] nodes = Enumerable.Range(1, AuthoringCanvasReferenceContract.MaxBatchSize)
            .Select(static articleId => Reference(articleId))
            .ToArray();
        var source = new DeterministicFactSource(target => Fact(target));
        var cache = new AuthoringCanvasReferenceProjectionCache(AuthoringCanvasReferenceContract.MaxBatchSize);

        AuthoringCanvasReferenceResolutionBatch result = await CreateResolver(nodes, source, cache)
            .ResolveAsync(Request(nodes));

        Assert.Equal(AuthoringCanvasReferenceContract.MaxBatchSize, result.Projections.Count);
        Assert.Equal(1, source.BatchReadCount);
        Assert.Equal(AuthoringCanvasReferenceContract.MaxBatchSize, source.LargestBatchSize);
        Assert.Equal(AuthoringCanvasReferenceContract.MaxBatchSize, cache.EntryCount);
    }

    [Fact]
    public async Task IndependentVerifier_BypassesCacheAndAcceptsLifecyclePinnedAndPermissionFacts()
    {
        AuthoringCanvasNode[] nodes =
        [
            Reference(701),
            Reference(702, pinned: 6),
            Reference(703)
        ];
        var source = new DeterministicFactSource(target => target.TargetArticleId switch
        {
            701 => Fact(target) with { TargetChangedSinceProjection = true },
            702 => Fact(target, currentRevision: 7, resolvedRevision: 6),
            703 => DeniedFact(target),
            _ => throw new InvalidOperationException()
        });
        AuthoringCanvasReferenceResolutionRequest request = Request(nodes);
        AuthoringCanvasReferenceResolutionBatch candidate = await CreateResolver(nodes, source)
            .ResolveAsync(request);
        var verifier = new AuthoringCanvasReferenceVerifier(CanvasStore(nodes), source);

        AuthoringCanvasReferenceVerificationResult result = await verifier.VerifyAsync(request, candidate);

        Assert.True(result.Valid);
        Assert.Empty(result.Reasons);
        Assert.Equal(candidate.ContentDigest, result.ContentDigest);
        Assert.Equal(3, result.VerifiedProjectionCount);
        Assert.Equal(
            [
                AuthoringCanvasReferenceProjectionStatus.TargetUpdated,
                AuthoringCanvasReferenceProjectionStatus.PinnedStale,
                AuthoringCanvasReferenceProjectionStatus.PermissionDeniedOrUnknown
            ],
            candidate.Projections.Select(static projection => projection.Status));
        Assert.Equal(3, source.AuthorityReadCount);
        Assert.Equal(2, source.BatchReadCount);
    }

    [Fact]
    public async Task IndependentVerifier_DetectsProjectionAuthorityAndEveryReceiptTamper()
    {
        AuthoringCanvasNode node = Reference(711);
        var source = new DeterministicFactSource(target => Fact(target));
        AuthoringCanvasReferenceResolver resolver = CreateResolver([node], source);
        AuthoringCanvasReferenceResolutionRequest request = Request([node]);
        AuthoringCanvasReferenceResolutionBatch original = await resolver.ResolveAsync(request);
        var verifier = new AuthoringCanvasReferenceVerifier(CanvasStore([node]), source);
        AuthoringCanvasReferenceProjection targetTamper = original.Projections[0] with
        {
            TargetArticleId = 999
        };
        AuthoringCanvasReferenceResolutionReceiptItem itemTamper = original.Receipt.Items[0] with
        {
            TargetArticleId = 999
        };
        AuthoringCanvasReferenceResolutionBatch[] tamperedCandidates =
        [
            original with
            {
                AuthorityCoordinate = original.AuthorityCoordinate with { Generation = 99 }
            },
            original with { Projections = [targetTamper] },
            original with { Receipt = original.Receipt with { TargetCount = 9 } },
            original with { Receipt = original.Receipt with { CacheHitCount = 1 } },
            original with { Receipt = original.Receipt with { ElapsedMilliseconds = 999 } },
            original with { Receipt = original.Receipt with { Items = [itemTamper] } }
        ];

        AuthoringCanvasReferenceVerificationResult authority = await verifier.VerifyAsync(
            request,
            tamperedCandidates[0]);
        AuthoringCanvasReferenceVerificationResult projection = await verifier.VerifyAsync(
            request,
            tamperedCandidates[1]);
        AuthoringCanvasReferenceVerificationResult[] receipts = [];
        foreach (AuthoringCanvasReferenceResolutionBatch candidate in tamperedCandidates.Skip(2))
        {
            receipts = [.. receipts, await verifier.VerifyAsync(request, candidate)];
        }

        Assert.False(authority.Valid);
        Assert.Contains("authority_coordinate_mismatch", authority.Reasons);
        Assert.False(projection.Valid);
        Assert.Contains($"projection_digest_mismatch:{node.Id:D}", projection.Reasons);
        Assert.Contains($"projection_fact_mismatch:{node.Id:D}", projection.Reasons);
        Assert.All(receipts, static result =>
        {
            Assert.False(result.Valid);
            Assert.Contains("receipt_invalid", result.Reasons);
        });
        Assert.Equal(1 + tamperedCandidates.Length, source.BatchReadCount);
    }

    [Fact]
    public void RequestAndFactContracts_RejectBodyHtmlNonReferenceAndDuplicateShapes()
    {
        AuthoringCanvasNode reference = Reference(801);
        Assert.Throws<AuthoringCanvasValidationException>(() =>
            AuthoringCanvasReferenceContract.ValidateRequest(Request([reference, reference])));
        Assert.Throws<AuthoringCanvasValidationException>(() =>
            AuthoringCanvasReferenceContract.ValidateRequest(Request(
                [new AuthoringCanvasNode(Guid.CreateVersion7(), AuthoringCanvasNodeType.PlainTextNote, 0, s_geometry,
                    NoteSource: "note")])));
        Assert.Throws<AuthoringCanvasValidationException>(() =>
            AuthoringCanvasReferenceContract.ValidateRequest(Request([reference]) with
            {
                TargetWorkspaceGroupId = " "
            }));

        var target = new AuthoringCanvasReferenceTarget(
            reference.Id,
            reference.Type,
            reference.TargetArticleId!.Value,
            null,
            null,
            null,
            null);
        Assert.Throws<AuthoringCanvasValidationException>(() =>
            AuthoringCanvasReferenceContract.ValidateFact(target, Fact(target) with
            {
                ContextSnippet = "<article>copied body</article>"
            }));
    }

    private static AuthoringCanvasReferenceResolver CreateResolver(
        IReadOnlyList<AuthoringCanvasNode> nodes,
        DeterministicFactSource source,
        AuthoringCanvasReferenceProjectionCache? cache = null)
        => new(
            CanvasStore(nodes),
            source,
            cache ?? new AuthoringCanvasReferenceProjectionCache(),
            TimeProvider.System);

    private static IAuthoringCanvasDocumentStore CanvasStore(
        IReadOnlyList<AuthoringCanvasNode> nodes,
        long revision = 17)
    {
        IAuthoringCanvasDocumentStore store = Substitute.For<IAuthoringCanvasDocumentStore>();
        store.GetAsync(s_owner, Arg.Any<Guid>(), Arg.Any<CancellationToken>())
            .Returns(call => Task.FromResult<AuthoringCanvasDocumentHeader?>(Header(
                call.ArgAt<Guid>(1),
                nodes,
                revision,
                CanvasDigest)));
        return store;
    }

    private static AuthoringCanvasDocumentHeader Header(
        Guid canvasId,
        IReadOnlyList<AuthoringCanvasNode> nodes,
        long revision,
        string contentDigest)
        => new(
            canvasId,
            s_owner,
            AuthoringCanvasContract.SchemaVersion,
            revision,
            "Research",
            new AuthoringCanvasViewport(0, 0, 1),
            nodes.Count,
            0,
            DateTime.UnixEpoch,
            DateTime.UnixEpoch,
            contentDigest);

    private static AuthoringCanvasReferenceResolutionRequest Request(IReadOnlyList<AuthoringCanvasNode> nodes)
        => new(
            Guid.CreateVersion7(),
            Guid.Parse("018f5f93-2997-7c8a-9a47-0242ac120001"),
            17,
            CanvasDigest,
            s_owner,
            AuthoringCanvasReferencePermission.ArticleRead,
            nodes);

    private static AuthoringCanvasNode Reference(
        int articleId,
        AuthoringCanvasNodeType type = AuthoringCanvasNodeType.ArticleReference,
        string? headingIdentity = null,
        string? blockIdentity = null,
        long? pinned = null)
        => new(
            Guid.CreateVersion7(),
            type,
            articleId,
            s_geometry,
            TargetArticleId: articleId,
            TargetHeadingIdentity: headingIdentity,
            TargetBlockIdentity: blockIdentity,
            PinnedTargetRevision: pinned,
            DisplayProjectionReference: $"projection-{articleId}",
            ReferenceState: AuthoringCanvasReferenceState.Unresolved);

    private static AuthoringCanvasReferenceFact Fact(
        AuthoringCanvasNode node,
        AuthoringCanvasArticleState state = AuthoringCanvasArticleState.Current,
        AuthoringCanvasReferenceCoordinateState coordinate = AuthoringCanvasReferenceCoordinateState.Current,
        long currentRevision = 7,
        long resolvedRevision = 7)
        => Fact(
            new AuthoringCanvasReferenceTarget(
                node.Id,
                node.Type,
                node.TargetArticleId!.Value,
                node.TargetHeadingIdentity,
                node.TargetBlockIdentity,
                node.PinnedTargetRevision,
                node.DisplayProjectionReference),
            state,
            coordinate,
            currentRevision,
            resolvedRevision);

    private static AuthoringCanvasReferenceFact Fact(
        AuthoringCanvasReferenceTarget target,
        AuthoringCanvasArticleState state = AuthoringCanvasArticleState.Current,
        AuthoringCanvasReferenceCoordinateState coordinate = AuthoringCanvasReferenceCoordinateState.Current,
        long currentRevision = 7,
        long resolvedRevision = 7)
        => new(
            target.NodeId,
            target.TargetArticleId,
            state,
            coordinate,
            currentRevision,
            resolvedRevision,
            false,
            $"Article {target.TargetArticleId}",
            $"Context for article {target.TargetArticleId}",
            $"/author/articles/{target.TargetArticleId}")
        {
            DisplayProjectionReference = new string('e', 64)
        };

    private static AuthoringCanvasReferenceFact DeniedFact(AuthoringCanvasNode node)
        => DeniedFact(new AuthoringCanvasReferenceTarget(
            node.Id,
            node.Type,
            node.TargetArticleId!.Value,
            node.TargetHeadingIdentity,
            node.TargetBlockIdentity,
            node.PinnedTargetRevision,
            node.DisplayProjectionReference));

    private static AuthoringCanvasReferenceFact DeniedFact(AuthoringCanvasReferenceTarget target)
        => new(
            target.NodeId,
            target.TargetArticleId,
            AuthoringCanvasArticleState.PermissionDeniedOrUnknown,
            AuthoringCanvasReferenceCoordinateState.Current,
            0,
            0,
            false,
            null,
            null,
            null);

    private static string[] PropertyNames(string json)
    {
        using JsonDocument document = JsonDocument.Parse(json);
        return document.RootElement.EnumerateObject().Select(static property => property.Name).ToArray();
    }

    private sealed class DeterministicFactSource(
        Func<AuthoringCanvasReferenceTarget, AuthoringCanvasReferenceFact> project,
        bool appendUnexpected = false) : IAuthoringCanvasReferenceFactSource
    {
        public int Generation { get; set; } = 1;

        public string TitlePrefix { get; set; } = "Article";

        public string PermissionFingerprint { get; set; } = "permission-a";

        public string ContentDigest { get; set; } = AuthorityDigest;

        public int AuthorityReadCount
        {
            get; private set;
        }

        public HashSet<int> DeniedArticleIds { get; } = [];

        public int BatchReadCount
        {
            get; private set;
        }

        public int LargestBatchSize
        {
            get; private set;
        }

        public Action? AfterBatchRead
        {
            get; init;
        }

        public Action<int>? AfterAuthorityRead
        {
            get; init;
        }

        public Task<AuthoringCanvasReferenceAuthorityCoordinate> ReadAuthorityCoordinateAsync(
            AuthoringCanvasOwner owner,
            AuthoringCanvasReferencePermission permission,
            CancellationToken cancellationToken = default)
        {
            AuthorityReadCount++;
            var coordinate = new AuthoringCanvasReferenceAuthorityCoordinate(
                Generation,
                ContentDigest,
                PermissionFingerprint);
            AfterAuthorityRead?.Invoke(AuthorityReadCount);
            return Task.FromResult(coordinate);
        }

        public Task<IReadOnlyList<AuthoringCanvasReferenceFact>> ReadBatchAsync(
            AuthoringCanvasReferenceFactQuery query,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            BatchReadCount++;
            LargestBatchSize = Math.Max(LargestBatchSize, query.Targets.Count);
            var result = query.Targets.Select(target =>
            {
                if (DeniedArticleIds.Contains(target.TargetArticleId))
                {
                    return DeniedFact(target);
                }
                AuthoringCanvasReferenceFact fact = project(target);
                return fact.Title is null
                    ? fact
                    : fact with
                    {
                        Title = $"{TitlePrefix} {target.TargetArticleId}"
                    };
            }).ToList();
            if (appendUnexpected)
            {
                result.Add(new AuthoringCanvasReferenceFact(
                    Guid.CreateVersion7(),
                    int.MaxValue,
                    AuthoringCanvasArticleState.Current,
                    AuthoringCanvasReferenceCoordinateState.Current,
                    1,
                    1,
                    false,
                    "unexpected",
                    "unexpected",
                    "/unexpected"));
            }
            AfterBatchRead?.Invoke();
            return Task.FromResult<IReadOnlyList<AuthoringCanvasReferenceFact>>(result);
        }
    }
}
