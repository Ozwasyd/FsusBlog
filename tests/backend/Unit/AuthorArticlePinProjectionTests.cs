using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthorArticlePinProjectionTests
{
    private static readonly AuthorArticlePinOwner s_owner = new(41, "primary-site");

    [Fact]
    public async Task Projection_FiltersBeforeArticleReadAndReconcilesLifecycleWithoutExistenceLeaks()
    {
        AuthorArticlePinCollectionSnapshot collection = Collection(s_owner, [1, 2, 3, 4, 5, 6]);
        string deletedTitle = "secret deleted title";
        var articles = new RecordingArticleSource(articleId => articleId switch
        {
            1 => Fact(1, "duplicate title", ArticleStatus.Published, revisionId: 101, revisionNo: 1),
            3 => Fact(3, "duplicate title", ArticleStatus.Archived, revisionId: 103, revisionNo: 2),
            4 => Fact(4, deletedTitle, ArticleStatus.Deleted, revisionId: 104, revisionNo: 3, deleted: true),
            5 => Fact(5, "replacement title", ArticleStatus.Draft, revisionId: 205, revisionNo: 7),
            6 => MissingFact(6),
            _ => throw new InvalidOperationException("Denied article metadata was queried.")
        });
        var reconciliation = new RecordingReconciliationSink();
        RecordingPermissionProvider permissions = PermissionProvider(denied: [2]);
        var request = new AuthorArticlePinProjectionRequest(
            s_owner,
            Guid.Parse("01991f50-8850-7f63-82ab-000000000001"));
        AuthorArticlePinProjectionService service = Service(
            collection,
            permissions,
            articles,
            new DirectAuthorArticlePinProjectionCache(),
            reconciliation);

        AuthorArticlePinProjectionPage page = await service.ReadAsync(request);

        Assert.Equal(AuthorArticlePinProjectionStatus.Current, page.Status);
        Assert.Equal(3, page.FilteredCount);
        Assert.Equal(new[] { 1, 3, 5 }, page.Items.Select(static item => item.ArticleId));
        Assert.Equal(ArticleStatus.Archived, page.Items[1].Status);
        Assert.Equal(205, page.Items[2].CurrentRevisionId);
        Assert.DoesNotContain(page.Items, static item => item.ArticleId is 2 or 4 or 6);
        Assert.Equal(new[] { 1, 3, 4, 5, 6 }, Assert.Single(articles.Requests));
        Assert.Equal(new[] { 4, 6 }, reconciliation.Obligations.Select(static obligation => obligation.ArticleId));
        Assert.Equal(new[] { "article-deleted", "article-missing" }, reconciliation.Obligations.Select(static obligation => obligation.ReasonCode));
        Assert.Equal(new[] { 1, 3, 5 }, page.Receipt!.ResultArticleIds);
        Assert.Equal(3, page.Receipt.ResultCount);
        Assert.DoesNotContain("secret", string.Join('|', page.Items.Select(static item => item.Title)), StringComparison.Ordinal);
        Assert.Null(typeof(AuthorArticlePinProjectionItem).GetProperty("OrderKey"));
        Assert.Null(typeof(AuthorArticlePinProjectionItem).GetProperty("Slug"));
        Assert.Null(typeof(AuthorArticlePinProjectionItem).GetProperty("SourceHash"));
        Assert.Null(typeof(AuthorArticlePinProjectionItem).GetProperty("PublicRank"));

        AuthorArticlePinProjectionVerificationResult verified = AuthorArticlePinProjectionVerifier.Verify(
            new AuthorArticlePinProjectionVerificationInput(
                collection,
                permissions.LastSnapshot!,
                articles.LastFacts,
                request,
                page,
                ClosedRemovals: reconciliation.Obligations));
        Assert.True(verified.Valid, string.Join(',', verified.Reasons));
        AuthorArticlePinProjectionVerificationResult missingReconciliation = AuthorArticlePinProjectionVerifier.Verify(
            new AuthorArticlePinProjectionVerificationInput(
                collection,
                permissions.LastSnapshot!,
                articles.LastFacts,
                request,
                page,
                ClosedRemovals: []));
        Assert.Contains("projection_reconciliation_mismatch", missingReconciliation.Reasons);

        deletedTitle = "different hidden deleted title";
        AuthorArticlePinProjectionPage hiddenMetadataChanged = await service.ReadAsync(request with
        {
            RequestId = Guid.CreateVersion7()
        });
        Assert.Equal(page.ContentDigest, hiddenMetadataChanged.ContentDigest);
        Assert.Equal(page.CacheReference, hiddenMetadataChanged.CacheReference);
        Assert.Equal(page.Items, hiddenMetadataChanged.Items);
    }

    [Fact]
    public async Task Projection_PaginatesOneThousandPinsWithOneBatchPerPageAndNoLocalReorder()
    {
        int[] articleIds = Enumerable.Range(1, AuthorArticlePinContract.MaxPinsPerOwner).ToArray();
        AuthorArticlePinCollectionSnapshot collection = Collection(s_owner, articleIds);
        var articles = new RecordingArticleSource(articleId => Fact(
            articleId,
            articleId % 2 == 0 ? "same title" : $"title-{articleId}",
            ArticleStatus.Published,
            10_000 + articleId,
            articleId));
        RecordingPermissionProvider permissions = PermissionProvider();
        AuthorArticlePinProjectionService service = Service(
            collection,
            permissions,
            articles,
            new DirectAuthorArticlePinProjectionCache(),
            new RecordingReconciliationSink());

        var projected = new List<int>();
        string? cursor = null;
        do
        {
            AuthorArticlePinProjectionPage page = await service.ReadAsync(new AuthorArticlePinProjectionRequest(
                s_owner,
                Guid.CreateVersion7(),
                Limit: AuthorArticlePinProjectionContract.MaxPageSize,
                Cursor: cursor));
            Assert.Equal(AuthorArticlePinProjectionStatus.Current, page.Status);
            Assert.InRange(page.Items.Count, 1, AuthorArticlePinProjectionContract.MaxPageSize);
            Assert.Equal(1_000, page.FilteredCount);
            projected.AddRange(page.Items.Select(static item => item.ArticleId));
            cursor = page.NextCursor;
        }
        while (cursor is not null);

        Assert.Equal(articleIds, projected);
        Assert.Equal(4, articles.Requests.Count);
        Assert.All(articles.Requests, request => Assert.Equal(1_000, request.Length));
    }

    [Fact]
    public async Task Projection_ReturnsAClosedCurrentReceiptForZeroPins()
    {
        AuthorArticlePinCollectionSnapshot collection = Collection(s_owner, []);
        var articles = new RecordingArticleSource(_ => throw new InvalidOperationException("No article should resolve."));
        AuthorArticlePinProjectionService service = Service(
            collection,
            PermissionProvider(),
            articles,
            new DirectAuthorArticlePinProjectionCache(),
            new RecordingReconciliationSink());
        AuthorArticlePinProjectionRequest request = new(s_owner, Guid.CreateVersion7());
        AuthorArticlePinProjectionPage page = await service.ReadAsync(request);

        Assert.Equal(AuthorArticlePinProjectionStatus.Current, page.Status);
        Assert.Equal(0, page.FilteredCount);
        Assert.Empty(page.Items);
        Assert.Empty(Assert.Single(articles.Requests));
        Assert.NotNull(page.Receipt);
        Assert.Equal(0, page.Receipt.ResultCount);
        Assert.Equal(0, page.Receipt.PageCount);
        Assert.Equal(DateTimeKind.Utc, page.Receipt.CreatedAtUtc.Kind);

        AuthorArticlePinProjectionPage replay = await service.ReadAsync(request);
        Assert.Equal(page.Receipt.ReceiptId, replay.Receipt!.ReceiptId);
        Assert.Equal(page.Receipt.ContentDigest, replay.Receipt.ContentDigest);
    }

    [Fact]
    public async Task Projection_ReportsArticlePermissionSiteSessionAndCursorStalenessAndRevalidatesOpen()
    {
        AuthorArticlePinCollectionSnapshot collection = Collection(s_owner, [1, 2]);
        int revisionNo = 1;
        string permissionRevision = "permission:1";
        string siteRevision = "site:1";
        string sessionRevision = "session:1";
        bool denied = false;
        var articles = new RecordingArticleSource(articleId => Fact(
            articleId,
            $"title-{articleId}",
            ArticleStatus.Published,
            100 + revisionNo,
            revisionNo));
        var permissions = new RecordingPermissionProvider(request => Permission(
            request.Owner,
            request.ArticleIds,
            denied ? request.ArticleIds : [],
            permissionRevision,
            siteRevision,
            sessionRevision));
        AuthorArticlePinProjectionService service = Service(
            collection,
            permissions,
            articles,
            new DirectAuthorArticlePinProjectionCache(),
            new RecordingReconciliationSink());
        var initialRequest = new AuthorArticlePinProjectionRequest(s_owner, Guid.CreateVersion7(), Limit: 1);
        AuthorArticlePinProjectionPage initial = await service.ReadAsync(initialRequest);
        Assert.NotNull(initial.NextCursor);

        AuthorArticlePinCollectionSnapshot advancedCollection = AtRevision(collection, 2);
        AuthorArticlePinProjectionPage collectionStale = await Service(
            advancedCollection,
            PermissionProvider(),
            articles,
            new DirectAuthorArticlePinProjectionCache(),
            new RecordingReconciliationSink()).ReadAsync(initialRequest with
            {
                RequestId = Guid.CreateVersion7(),
                Cursor = initial.NextCursor
            });
        Assert.Equal(AuthorArticlePinProjectionStatus.Stale, collectionStale.Status);
        Assert.Contains("cursor_collection_revision_stale", collectionStale.StaleReasons);
        Assert.Empty(collectionStale.Items);

        AuthorArticlePinProjectionPage collectionExpectedStale = await Service(
            advancedCollection,
            PermissionProvider(),
            articles,
            new DirectAuthorArticlePinProjectionCache(),
            new RecordingReconciliationSink()).ReadAsync(initialRequest with
            {
                RequestId = Guid.CreateVersion7(),
                Cursor = null,
                ExpectedCollectionRevision = initial.CollectionRevision
            });
        Assert.Equal(AuthorArticlePinProjectionStatus.Stale, collectionExpectedStale.Status);
        Assert.Contains("collection_revision_stale", collectionExpectedStale.StaleReasons);
        Assert.NotEqual(initial.CacheReference, collectionExpectedStale.CacheReference);

        AuthorArticlePinProjectionItem projected = Assert.Single(initial.Items);
        AuthorArticlePinOpenValidationResult currentOpen = await service.RevalidateOpenAsync(OpenRequest(
            projected,
            initial));
        Assert.Equal(AuthorArticlePinOpenValidationStatus.Current, currentOpen.Status);

        revisionNo = 2;
        AuthorArticlePinProjectionPage staleCursor = await service.ReadAsync(initialRequest with
        {
            RequestId = Guid.CreateVersion7(),
            Cursor = initial.NextCursor
        });
        Assert.Equal(AuthorArticlePinProjectionStatus.Stale, staleCursor.Status);
        Assert.Empty(staleCursor.Items);
        Assert.Contains("cursor_article_projection_stale", staleCursor.StaleReasons);

        AuthorArticlePinProjectionPage invalidCursor = await service.ReadAsync(initialRequest with
        {
            RequestId = Guid.CreateVersion7(),
            Cursor = $"!{initial.NextCursor[1..]}"
        });
        Assert.Equal(AuthorArticlePinProjectionStatus.InvalidCursor, invalidCursor.Status);
        Assert.Empty(invalidCursor.Items);

        AuthorArticlePinProjectionPage staleExpected = await service.ReadAsync(initialRequest with
        {
            RequestId = Guid.CreateVersion7(),
            Cursor = null,
            ExpectedCollectionRevision = initial.CollectionRevision,
            ExpectedArticleProjectionDigest = initial.ArticleProjectionDigest,
            ExpectedPermissionRevision = initial.PermissionRevision,
            ExpectedSiteRevision = initial.SiteRevision,
            ExpectedSessionRevision = initial.SessionRevision
        });
        Assert.Equal(AuthorArticlePinProjectionStatus.Stale, staleExpected.Status);
        Assert.Contains("article_projection_stale", staleExpected.StaleReasons);
        Assert.NotEmpty(staleExpected.Items);

        AuthorArticlePinOpenValidationResult staleOpen = await service.RevalidateOpenAsync(OpenRequest(
            projected,
            initial));
        Assert.Equal(AuthorArticlePinOpenValidationStatus.Stale, staleOpen.Status);

        sessionRevision = "session:logout";
        permissionRevision = "permission:2";
        siteRevision = "site:2";
        AuthorArticlePinProjectionPage switched = await service.ReadAsync(initialRequest with
        {
            RequestId = Guid.CreateVersion7(),
            Cursor = null,
            ExpectedPermissionRevision = initial.PermissionRevision,
            ExpectedSiteRevision = initial.SiteRevision,
            ExpectedSessionRevision = initial.SessionRevision
        });
        Assert.Contains("permission_revision_stale", switched.StaleReasons);
        Assert.Contains("site_revision_stale", switched.StaleReasons);
        Assert.Contains("session_revision_stale", switched.StaleReasons);
        Assert.NotEqual(initial.CacheReference, switched.CacheReference);

        int articleReadsBeforeDeny = articles.Requests.Count;
        denied = true;
        AuthorArticlePinOpenValidationResult deniedOpen = await service.RevalidateOpenAsync(OpenRequest(
            projected,
            initial));
        Assert.Equal(AuthorArticlePinOpenValidationStatus.Denied, deniedOpen.Status);
        Assert.Equal(articleReadsBeforeDeny, articles.Requests.Count);

        AuthorArticlePinProjectionPage revoked = await service.ReadAsync(initialRequest with
        {
            RequestId = Guid.CreateVersion7(),
            Cursor = null
        });
        Assert.Equal(AuthorArticlePinProjectionStatus.Current, revoked.Status);
        Assert.Empty(revoked.Items);
        Assert.Equal(0, revoked.FilteredCount);
        Assert.Empty(Assert.Single(articles.Requests.Skip(articleReadsBeforeDeny)));
        Assert.Empty(revoked.Receipt!.ResultArticleIds);
        Assert.NotEqual(initial.CacheReference, revoked.CacheReference);
    }

    [Fact]
    public async Task Projection_FailsClosedAcrossOwnerSitePermissionAndPartialReadBoundaries()
    {
        AuthorArticlePinCollectionSnapshot collection = Collection(s_owner, [1]);
        var articles = new RecordingArticleSource(articleId => Fact(
            articleId,
            "private title",
            ArticleStatus.Draft,
            10,
            1));
        AuthorArticlePinProjectionService unavailable = Service(
            collection,
            new UnavailableAuthorArticlePinPermissionProjectionProvider(),
            articles,
            new DirectAuthorArticlePinProjectionCache(),
            new RecordingReconciliationSink());
        AuthorArticlePinProjectionPage denied = await unavailable.ReadAsync(new(
            s_owner,
            Guid.CreateVersion7()));
        Assert.Equal(AuthorArticlePinProjectionStatus.Unavailable, denied.Status);
        Assert.Empty(denied.Items);
        Assert.Equal(0, denied.FilteredCount);
        Assert.Empty(articles.Requests);

        var wrongOwnerProvider = new RecordingPermissionProvider(request => Permission(
            new AuthorArticlePinOwner(999, request.Owner.SiteScope),
            request.ArticleIds));
        AuthorArticlePinProjectionPage wrongOwner = await Service(
            collection,
            wrongOwnerProvider,
            articles,
            new DirectAuthorArticlePinProjectionCache(),
            new RecordingReconciliationSink()).ReadAsync(new(s_owner, Guid.CreateVersion7()));
        Assert.Equal(AuthorArticlePinProjectionStatus.Unavailable, wrongOwner.Status);
        Assert.Empty(articles.Requests);

        AuthorArticlePinProjectionPage wrongSite = await Service(
            collection,
            PermissionProvider(),
            articles,
            new DirectAuthorArticlePinProjectionCache(),
            new RecordingReconciliationSink()).ReadAsync(new(
                new AuthorArticlePinOwner(s_owner.AdminPrincipalId, "other-site"),
                Guid.CreateVersion7()));
        Assert.Equal(AuthorArticlePinProjectionStatus.Unavailable, wrongSite.Status);
        Assert.Empty(wrongSite.Items);

        articles.ThrowOnRead = true;
        AuthorArticlePinProjectionPage partialRead = await Service(
            collection,
            PermissionProvider(),
            articles,
            new DirectAuthorArticlePinProjectionCache(),
            new RecordingReconciliationSink()).ReadAsync(new(s_owner, Guid.CreateVersion7()));
        Assert.Equal(AuthorArticlePinProjectionStatus.Unavailable, partialRead.Status);
        Assert.Empty(partialRead.Items);
    }

    [Fact]
    public async Task Projection_DoesNotClaimCurrentWhenCacheOrReconciliationFailsOrCacheIsTampered()
    {
        AuthorArticlePinCollectionSnapshot collection = Collection(s_owner, [1]);
        var articles = new RecordingArticleSource(articleId => Fact(
            articleId,
            "title",
            ArticleStatus.Published,
            11,
            1));
        var unavailableCache = new MemoryProjectionCache { ReadStatus = AuthorArticlePinProjectionCacheReadStatus.Unavailable };
        AuthorArticlePinProjectionPage cacheFailure = await Service(
            collection,
            PermissionProvider(),
            articles,
            unavailableCache,
            new RecordingReconciliationSink()).ReadAsync(new(s_owner, Guid.CreateVersion7()));
        Assert.Equal(AuthorArticlePinProjectionStatus.Unavailable, cacheFailure.Status);

        AuthorArticlePinProjectionPage cacheWriteFailure = await Service(
            collection,
            PermissionProvider(),
            articles,
            new MemoryProjectionCache { WriteSucceeds = false },
            new RecordingReconciliationSink()).ReadAsync(new(s_owner, Guid.CreateVersion7()));
        Assert.Equal(AuthorArticlePinProjectionStatus.Unavailable, cacheWriteFailure.Status);

        AuthorArticlePinCollectionSnapshot deletedCollection = Collection(s_owner, [2]);
        var deletedArticles = new RecordingArticleSource(articleId => Fact(
            articleId,
            "deleted",
            ArticleStatus.Deleted,
            12,
            1,
            deleted: true));
        AuthorArticlePinProjectionPage reconciliationFailure = await Service(
            deletedCollection,
            PermissionProvider(),
            deletedArticles,
            new DirectAuthorArticlePinProjectionCache(),
            new RecordingReconciliationSink { Succeeds = false }).ReadAsync(new(s_owner, Guid.CreateVersion7()));
        Assert.Equal(AuthorArticlePinProjectionStatus.Unavailable, reconciliationFailure.Status);

        var cache = new MemoryProjectionCache();
        AuthorArticlePinProjectionService cachedService = Service(
            collection,
            PermissionProvider(),
            articles,
            cache,
            new RecordingReconciliationSink());
        _ = await cachedService.ReadAsync(new(s_owner, Guid.CreateVersion7()));
        cache.Tamper(static page => page with
        {
            Items = [page.Items[0] with { Title = "tampered title" }]
        });
        AuthorArticlePinProjectionPage tampered = await cachedService.ReadAsync(new(s_owner, Guid.CreateVersion7()));
        Assert.Equal(AuthorArticlePinProjectionStatus.Unavailable, tampered.Status);
        Assert.Empty(tampered.Items);
    }

    [Fact]
    public async Task IndependentVerifierRejectsRecomputedSemanticItemAndReceiptTamper()
    {
        AuthorArticlePinCollectionSnapshot collection = Collection(s_owner, [1, 2]);
        var articles = new RecordingArticleSource(articleId => Fact(
            articleId,
            $"title-{articleId}",
            ArticleStatus.Published,
            100 + articleId,
            articleId));
        RecordingPermissionProvider permissions = PermissionProvider();
        AuthorArticlePinProjectionService service = Service(
            collection,
            permissions,
            articles,
            new DirectAuthorArticlePinProjectionCache(),
            new RecordingReconciliationSink());
        AuthorArticlePinProjectionRequest request = new(s_owner, Guid.CreateVersion7());
        AuthorArticlePinProjectionPage page = await service.ReadAsync(request);
        AuthorArticlePinProjectionVerificationInput evidence = new(
            collection,
            permissions.LastSnapshot!,
            articles.LastFacts,
            request,
            page);
        Assert.True(AuthorArticlePinProjectionVerifier.Verify(evidence).Valid);

        AuthorArticlePinProjectionItem altered = page.Items[0] with
        {
            OrderReference = AuthorArticlePinProjectionContract.HashText("attacker-order"),
            ContentDigest = string.Empty
        };
        altered = altered with
        {
            ContentDigest = AuthorArticlePinProjectionContract.ComputeItemDigest(altered)
        };
        AuthorArticlePinProjectionPage alteredPage = page with
        {
            Items = [altered, page.Items[1]],
            ContentDigest = string.Empty
        };
        alteredPage = alteredPage with
        {
            ContentDigest = AuthorArticlePinProjectionContract.ComputePageDigest(alteredPage)
        };
        AuthorArticlePinProjectionReceipt alteredReceipt = alteredPage.Receipt! with
        {
            ResultOrderReferences = [altered.OrderReference, page.Items[1].OrderReference],
            ResultItemDigests = [altered.ContentDigest, page.Items[1].ContentDigest],
            ResultContentDigest = alteredPage.ContentDigest,
            ContentDigest = string.Empty
        };
        alteredReceipt = alteredReceipt with
        {
            ReceiptId = AuthorArticlePinProjectionContract.CreateReceiptId(request.RequestId, alteredPage.ContentDigest),
            ContentDigest = AuthorArticlePinProjectionContract.ComputeReceiptDigest(alteredReceipt)
        };
        alteredPage = alteredPage with
        {
            Receipt = alteredReceipt
        };

        AuthorArticlePinProjectionVerificationResult tampered = AuthorArticlePinProjectionVerifier.Verify(
            evidence with
            {
                Page = alteredPage
            });
        Assert.False(tampered.Valid);
        Assert.Contains(tampered.Reasons, reason => reason.StartsWith("projection_item_mismatch:", StringComparison.Ordinal));

        AuthorArticlePinArticleFact invalidFact = articles.LastFacts[0] with
        {
            CurrentRevisionId = 0,
            RevisionNo = 0,
            ArticleVersionReference = string.Empty,
            RevisionVersionReference = string.Empty,
            ContentDigest = string.Empty
        };
        invalidFact = invalidFact with
        {
            ContentDigest = AuthorArticlePinProjectionContract.ComputeArticleFactDigest(invalidFact)
        };
        AuthorArticlePinProjectionVerificationResult invalidSource = AuthorArticlePinProjectionVerifier.Verify(
            evidence with
            {
                ArticleFacts = [invalidFact, articles.LastFacts[1]]
            });
        Assert.False(invalidSource.Valid);
        Assert.Contains($"projection_article_shape_invalid:{invalidFact.ArticleId}", invalidSource.Reasons);
    }

    [Theory]
    [InlineData("invalid-principal")]
    [InlineData("empty-site")]
    [InlineData("padded-site")]
    [InlineData("control-site")]
    [InlineData("oversized-site")]
    [InlineData("empty-request-id")]
    [InlineData("zero-limit")]
    [InlineData("negative-revision")]
    public async Task IndependentVerifierRejectsClosedRequestValidationFailures(string refusal)
    {
        AuthorArticlePinCollectionSnapshot collection = Collection(s_owner, [1]);
        var articles = new RecordingArticleSource(articleId => Fact(
            articleId,
            "title",
            ArticleStatus.Published,
            101,
            1));
        RecordingPermissionProvider permissions = PermissionProvider();
        AuthorArticlePinProjectionService service = Service(
            collection,
            permissions,
            articles,
            new DirectAuthorArticlePinProjectionCache(),
            new RecordingReconciliationSink());
        AuthorArticlePinProjectionRequest request = new(s_owner, Guid.CreateVersion7());
        AuthorArticlePinProjectionPage page = await service.ReadAsync(request);
        AuthorArticlePinProjectionVerificationInput evidence = new(
            collection,
            permissions.LastSnapshot!,
            articles.LastFacts,
            request,
            page);
        Assert.Equal(AuthorArticlePinProjectionStatus.Current, page.Status);
        Assert.True(AuthorArticlePinProjectionVerifier.Verify(evidence).Valid);

        AuthorArticlePinProjectionRequest invalidRequest = refusal switch
        {
            "invalid-principal" => request with { Owner = new(0, s_owner.SiteScope) },
            "empty-site" => request with { Owner = new(s_owner.AdminPrincipalId, string.Empty) },
            "padded-site" => request with { Owner = new(s_owner.AdminPrincipalId, $"{s_owner.SiteScope} ") },
            "control-site" => request with { Owner = new(s_owner.AdminPrincipalId, $"site{(char)10}name") },
            "oversized-site" => request with { Owner = new(s_owner.AdminPrincipalId, new string('s', AuthorArticlePinContract.MaxSiteScopeLength + 1)) },
            "empty-request-id" => request with { RequestId = Guid.Empty },
            "zero-limit" => request with { Limit = 0 },
            "negative-revision" => request with { ExpectedCollectionRevision = -1 },
            _ => throw new ArgumentOutOfRangeException(nameof(refusal))
        };
        AuthorArticlePinProjectionVerificationResult refused = AuthorArticlePinProjectionVerifier.Verify(
            evidence with
            {
                Request = invalidRequest
            });

        Assert.False(refused.Valid);
        Assert.Equal("projection_request_invalid", Assert.Single(refused.Reasons));
        Assert.True(AuthorArticlePinProjectionVerifier.Verify(evidence).Valid);
    }

    private static AuthorArticlePinProjectionService Service(
        AuthorArticlePinCollectionSnapshot collection,
        IAuthorArticlePinPermissionProjectionProvider permissionProvider,
        RecordingArticleSource articleSource,
        IAuthorArticlePinProjectionCache cache,
        IAuthorArticlePinReconciliationSink reconciliation)
        => new(
            new SnapshotPinStore(collection),
            permissionProvider,
            articleSource,
            cache,
            reconciliation,
            TimeProvider.System);

    private static RecordingPermissionProvider PermissionProvider(params int[] denied)
        => new(request => Permission(request.Owner, request.ArticleIds, denied));

    private static AuthorArticlePinPermissionSnapshot Permission(
        AuthorArticlePinOwner owner,
        IReadOnlyList<int> articleIds,
        IReadOnlyCollection<int>? denied = null,
        string permissionRevision = "permission:1",
        string siteRevision = "site:1",
        string sessionRevision = "session:1")
    {
        denied ??= [];
        var snapshot = new AuthorArticlePinPermissionSnapshot(
            AuthorArticlePinPermissionSnapshotStatus.Current,
            owner,
            permissionRevision,
            siteRevision,
            sessionRevision,
            [.. articleIds.Select(articleId => new AuthorArticlePinPermissionDecision(
                articleId,
                !denied.Contains(articleId),
                !denied.Contains(articleId),
                denied.Contains(articleId) ? string.Empty : $"permission:{articleId}:{permissionRevision}"))],
            string.Empty);
        return snapshot with
        {
            ContentDigest = AuthorArticlePinProjectionContract.ComputePermissionDigest(snapshot)
        };
    }

    private static AuthorArticlePinArticleFact Fact(
        int articleId,
        string title,
        ArticleStatus status,
        long revisionId,
        int revisionNo,
        bool deleted = false)
    {
        var fact = new AuthorArticlePinArticleFact(
            articleId,
            title,
            status,
            revisionId,
            revisionNo,
            $"article:{articleId}:version:{revisionNo}",
            $"article:{articleId}:revision:{revisionId}:{revisionNo}",
            Exists: true,
            deleted,
            string.Empty);
        return fact with
        {
            ContentDigest = AuthorArticlePinProjectionContract.ComputeArticleFactDigest(fact)
        };
    }

    private static AuthorArticlePinArticleFact MissingFact(int articleId)
    {
        var fact = new AuthorArticlePinArticleFact(
            articleId,
            string.Empty,
            ArticleStatus.Deleted,
            0,
            0,
            string.Empty,
            string.Empty,
            Exists: false,
            IsDeleted: true,
            string.Empty);
        return fact with
        {
            ContentDigest = AuthorArticlePinProjectionContract.ComputeArticleFactDigest(fact)
        };
    }

    private static AuthorArticlePinCollectionSnapshot Collection(
        AuthorArticlePinOwner owner,
        IReadOnlyList<int> articleIds)
    {
        AuthorArticlePin[] pins = [.. articleIds.Select((articleId, index) =>
        {
            Guid pinId = Guid.Parse($"00000000-0000-0000-0000-{articleId:000000000000}");
            long orderKey = checked((index + 1L) * AuthorArticlePinContract.OrderKeyGap);
            return new AuthorArticlePin(
                pinId,
                articleId,
                orderKey,
                1,
                1,
                AuthorArticlePinContract.ComputePinDigest(owner, pinId, articleId, orderKey, 1, 1));
        })];
        long revision = pins.Length == 0 ? 0 : 1;
        return new AuthorArticlePinCollectionSnapshot(
            owner,
            AuthorArticlePinContract.SchemaVersion,
            revision,
            pins.Length,
            pins,
            DateTime.UnixEpoch,
            AuthorArticlePinContract.ComputeCollectionDigest(owner, revision, pins));
    }

    private static AuthorArticlePinCollectionSnapshot AtRevision(
        AuthorArticlePinCollectionSnapshot collection,
        long revision)
        => collection with
        {
            Revision = revision,
            ContentDigest = AuthorArticlePinContract.ComputeCollectionDigest(
                collection.Owner,
                revision,
                collection.Pins)
        };

    private static AuthorArticlePinOpenValidationRequest OpenRequest(
        AuthorArticlePinProjectionItem item,
        AuthorArticlePinProjectionPage page)
        => new(
            s_owner,
            Guid.CreateVersion7(),
            item.ArticleId,
            page.CollectionRevision,
            item.ArticleVersionReference,
            item.RevisionVersionReference,
            page.PermissionRevision,
            item.PermissionReference,
            page.SiteRevision,
            page.SessionRevision);

    private sealed class SnapshotPinStore(AuthorArticlePinCollectionSnapshot snapshot) : IAuthorArticlePinStore
    {
        public Task<AuthorArticlePinCollectionSnapshot> GetAuthoritySnapshotAsync(
            AuthorArticlePinOwner owner,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(snapshot);
        }

        public Task<AuthorArticlePinWriteReceipt> AddAsync(AddAuthorArticlePinCommand command, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthorArticlePinWriteReceipt> RemoveAsync(RemoveAuthorArticlePinCommand command, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthorArticlePinWriteReceipt> ReorderAsync(ReorderAuthorArticlePinsCommand command, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<AuthorArticlePinVerificationResult> VerifyAsync(AuthorArticlePinOwner owner, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }

    private sealed class RecordingPermissionProvider(
        Func<AuthorArticlePinPermissionBatchRequest, Task<AuthorArticlePinPermissionSnapshot>> resolve)
        : IAuthorArticlePinPermissionProjectionProvider
    {
        public RecordingPermissionProvider(Func<AuthorArticlePinPermissionBatchRequest, AuthorArticlePinPermissionSnapshot> resolve)
            : this(request => Task.FromResult(resolve(request)))
        {
        }

        public AuthorArticlePinPermissionBatchRequest? LastRequest
        {
            get; private set;
        }
        public AuthorArticlePinPermissionSnapshot? LastSnapshot
        {
            get; private set;
        }

        public async Task<AuthorArticlePinPermissionSnapshot> ResolveAsync(
            AuthorArticlePinPermissionBatchRequest request,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            LastRequest = request;
            LastSnapshot = await resolve(request).ConfigureAwait(false);
            return LastSnapshot;
        }
    }

    private sealed class RecordingArticleSource(Func<int, AuthorArticlePinArticleFact> resolve)
        : IAuthorArticlePinArticleProjectionSource
    {
        public List<int[]> Requests { get; } = [];
        public IReadOnlyList<AuthorArticlePinArticleFact> LastFacts { get; private set; } = [];
        public bool ThrowOnRead
        {
            get; set;
        }

        public Task<IReadOnlyList<AuthorArticlePinArticleFact>> ReadCurrentBatchAsync(
            IReadOnlyList<int> articleIds,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (ThrowOnRead)
            {
                throw new InvalidOperationException("article source unavailable");
            }
            Requests.Add([.. articleIds]);
            LastFacts = [.. articleIds.Select(resolve)];
            return Task.FromResult(LastFacts);
        }
    }

    private sealed class RecordingReconciliationSink : IAuthorArticlePinReconciliationSink
    {
        public bool Succeeds { get; set; } = true;
        public List<AuthorArticlePinClosedRemovalObligation> Obligations { get; } = [];

        public Task<bool> RecordClosedRemovalsAsync(
            IReadOnlyList<AuthorArticlePinClosedRemovalObligation> obligations,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Obligations.AddRange(obligations);
            return Task.FromResult(Succeeds);
        }
    }

    private sealed class MemoryProjectionCache : IAuthorArticlePinProjectionCache
    {
        private readonly Dictionary<string, AuthorArticlePinProjectionPage> _pages = [];

        public AuthorArticlePinProjectionCacheReadStatus ReadStatus { get; set; } = AuthorArticlePinProjectionCacheReadStatus.Miss;
        public bool WriteSucceeds { get; set; } = true;

        public string GetReference(string identity) => $"memory:{identity}";

        public Task<AuthorArticlePinProjectionCacheReadResult> TryReadAsync(
            string identity,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (ReadStatus == AuthorArticlePinProjectionCacheReadStatus.Unavailable)
            {
                return Task.FromResult(new AuthorArticlePinProjectionCacheReadResult(
                    AuthorArticlePinProjectionCacheReadStatus.Unavailable,
                    null,
                    string.Empty));
            }
            if (_pages.TryGetValue(identity, out AuthorArticlePinProjectionPage? page))
            {
                return Task.FromResult(new AuthorArticlePinProjectionCacheReadResult(
                    AuthorArticlePinProjectionCacheReadStatus.Hit,
                    page,
                    GetReference(identity)));
            }
            return Task.FromResult(new AuthorArticlePinProjectionCacheReadResult(
                AuthorArticlePinProjectionCacheReadStatus.Miss,
                null,
                GetReference(identity)));
        }

        public Task<bool> WriteAsync(
            string identity,
            AuthorArticlePinProjectionPage page,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!WriteSucceeds)
            {
                return Task.FromResult(false);
            }
            _pages[identity] = page;
            return Task.FromResult(true);
        }

        public void Tamper(Func<AuthorArticlePinProjectionPage, AuthorArticlePinProjectionPage> mutate)
        {
            string key = Assert.Single(_pages.Keys);
            _pages[key] = mutate(_pages[key]);
        }
    }
}
