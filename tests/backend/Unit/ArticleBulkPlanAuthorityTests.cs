using System.Collections.Immutable;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;

using FsusBlog.Server.Services.Articles.Bulk;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleBulkPlanAuthorityTests
{
    private static readonly DateTimeOffset s_now = DateTimeOffset.Parse("2026-09-04T12:00:00Z");

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(100)]
    [InlineData(10_000)]
    public async Task Create_FreezesBoundedContentAddressedPrivacySafeItems(int itemCount)
    {
        string[] ids = [.. Enumerable.Range(0, itemCount).Select(static index => $"article-{index:D5}")];
        var selection = new SelectionAuthority(ids);
        var preflight = new PreflightAuthority();
        var authority = new ArticleBulkPlanAuthority(selection, preflight, new TestTimeProvider(s_now));

        ArticleBulkPlan plan = await authority.CreateAsync(Request("category.add", ids));

        Assert.Equal(itemCount, plan.Impact.SelectedCount);
        Assert.Equal(itemCount, plan.Impact.EligibleCount);
        Assert.True(plan.ItemChunks.Length <= 40);
        Assert.All(plan.ItemChunks, static chunk => Assert.InRange(chunk.Items.Length, 1, 250));
        Assert.Equal(ids, plan.Items.Select(static item => item.ArticleId));
        Assert.Equal(1, selection.Calls);
        Assert.Equal(itemCount, preflight.Count);
        Assert.DoesNotContain("body", JsonSerializer.Serialize(plan), StringComparison.OrdinalIgnoreCase);
        authority.ValidateForExecution(plan);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task Create_SupportsEveryClosedSelectionSourceExactlyOnce(int selectionKind)
    {
        string[] ids = ["article-1", "article-2"];
        var kind = (ArticleBulkSelectionKind)selectionKind;
        var selection = new SelectionAuthority(ids);
        var authority = new ArticleBulkPlanAuthority(
            selection,
            new PreflightAuthority(),
            new TestTimeProvider(s_now));

        ArticleBulkPlan plan = await authority.CreateAsync(Request("category.add", ids, kind));

        Assert.Equal(kind, plan.Selection.Kind);
        Assert.Equal(ids, plan.Items.Select(static item => item.ArticleId));
        Assert.Equal(1, selection.Calls);
    }

    [Fact]
    public async Task Create_SeparatesPerItemBlockingFromAtomicZeroWrite()
    {
        string[] ids = ["article-1", "article-2"];
        var selection = new SelectionAuthority(ids);
        var preflight = new PreflightAuthority("article-2");
        var authority = new ArticleBulkPlanAuthority(selection, preflight, new TestTimeProvider(s_now));

        ArticleBulkPlan perItem = await authority.CreateAsync(Request("category.add", ids));
        ArticleBulkPlan atomic = await authority.CreateAsync(Request("lifecycle.archive", ids));

        Assert.True(perItem.Executable);
        ArticleBulkPlanItem blocked = Assert.Single(perItem.Items,
            static item => item.Status == ArticleBulkPlanItemStatus.Blocked);
        Assert.Equal("article-inaccessible", blocked.ReasonCode);
        Assert.Null(blocked.ExpectedRevision);
        Assert.Null(blocked.StateDigest);
        Assert.False(atomic.Executable);
        Assert.True(atomic.Impact.RequiresZeroWrite);
        Assert.Contains("article-bulk.atomic-preflight-blocked", atomic.Impact.ErrorCodes);
    }

    [Fact]
    public async Task IndependentVerifierRejectsSelectionPlanAndExpiryDrift()
    {
        string[] ids = ["article-1", "article-2"];
        var time = new TestTimeProvider(s_now);
        var selection = new SelectionAuthority(ids);
        var authority = new ArticleBulkPlanAuthority(selection, new PreflightAuthority(), time);
        ArticleBulkPlan plan = await authority.CreateAsync(Request(
            "category.add",
            ids,
            ArticleBulkSelectionKind.Query));

        selection.Ids = ["article-1", "article-3"];
        ArticleBulkContractException drift = await Assert.ThrowsAsync<ArticleBulkContractException>(
            () => authority.VerifyAsync(plan));
        Assert.Equal("article-bulk.plan-drift", drift.Code);
        int calls = selection.Calls;
        authority.ValidateForExecution(plan);
        Assert.Equal(calls, selection.Calls);

        ArticleBulkContractException tampered = Assert.Throws<ArticleBulkContractException>(() =>
            authority.ValidateForExecution(plan with
            {
                PolicyDigest = ArticleBulkDigest.Of("tampered")
            }));
        Assert.Equal("article-bulk.plan-tampered", tampered.Code);
        time.UtcNow = plan.ExpiresAtUtc;
        Assert.Equal("article-bulk.plan-expired",
            Assert.Throws<ArticleBulkContractException>(() => authority.ValidateForExecution(plan)).Code);
    }

    [Fact]
    public async Task Create_CanonicalizesParameterOrderAndVerifierRejectsChunkTamper()
    {
        string[] ids = ["article-1"];
        var authority = new ArticleBulkPlanAuthority(
            new SelectionAuthority(ids),
            new PreflightAuthority(),
            new TestTimeProvider(s_now));
        ArticleBulkPlanRequest first = Request("category.add", ids) with
        {
            OperationId = "property.set",
            Parameters = Parameters(
                ("definitionId", "definition-1"),
                ("typedValueDigest", ArticleBulkDigest.Of("value")))
        };
        ArticleBulkPlanRequest second = first with
        {
            Parameters = Parameters(
                ("typedValueDigest", ArticleBulkDigest.Of("value")),
                ("definitionId", "definition-1"))
        };

        ArticleBulkPlan firstPlan = await authority.CreateAsync(first);
        ArticleBulkPlan secondPlan = await authority.CreateAsync(second);

        Assert.Equal(firstPlan.ContentDigest, secondPlan.ContentDigest);
        ArticleBulkPlanItemChunk chunk = Assert.Single(firstPlan.ItemChunks);
        ArticleBulkPlan tampered = firstPlan with
        {
            ItemChunks = [chunk with { ContentDigest = ArticleBulkDigest.Of("tampered") }]
        };
        Assert.Equal("article-bulk.plan-tampered",
            Assert.Throws<ArticleBulkContractException>(() => authority.ValidateForExecution(tampered)).Code);
    }

    [Fact]
    public async Task ReplanRequiresNewIdentityAndNewExplicitConfirmation()
    {
        string[] ids = ["article-1"];
        var authority = new ArticleBulkPlanAuthority(
            new SelectionAuthority(ids),
            new PreflightAuthority(),
            new TestTimeProvider(s_now));
        ArticleBulkPlan original = await authority.CreateAsync(Request("category.add", ids));
        ArticleBulkPlanConfirmation originalConfirmation = authority.RecordExplicitConfirmation(
            original,
            "confirmation-original",
            s_now);

        ArticleBulkPlanRequest replanRequest = Request("category.add", ids) with
        {
            PlanIdentity = "plan-2",
            ReplanOfPlanDigest = original.ContentDigest
        };
        ArticleBulkPlan replanned = await authority.ReplanAsync(original, replanRequest);
        ArticleBulkPlanConfirmation replannedConfirmation = authority.RecordExplicitConfirmation(
            replanned,
            "confirmation-replanned",
            s_now);

        Assert.NotEqual(original.PlanIdentity, replanned.PlanIdentity);
        Assert.NotEqual(original.ContentDigest, replanned.ContentDigest);
        Assert.Equal(original.ContentDigest, replanned.ReplanOfPlanDigest);
        Assert.NotEqual(originalConfirmation.ContentDigest, replannedConfirmation.ContentDigest);
        Assert.Equal(
            "article-bulk.replan-identity-invalid",
            (await Assert.ThrowsAsync<ArticleBulkContractException>(() => authority.ReplanAsync(
                original,
                replanRequest with
                {
                    PlanIdentity = original.PlanIdentity
                }))).Code);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    public async Task Create_InaccessibleFactsDoNotChangeFrozenItemOrPlanDigests(int variant)
    {
        string[] ids = ["article-1"];
        ArticleBulkArticleObservation absent = ObservedArticle() with
        {
            Exists = false,
            SiteId = null,
            Revision = null,
            Lifecycle = null,
            Permitted = false,
            PermissionDigest = null,
            StateDigest = null,
            DependencyDigests = []
        };
        ArticleBulkArticleObservation privateFacts = ObservedArticle() with
        {
            StateDigest = ArticleBulkDigest.Of(variant % 2 == 0 ? "private-state-a" : "private-state-b")
        };
        ArticleBulkArticleObservation inaccessible = variant switch
        {
            0 or 1 => privateFacts with { Permitted = false },
            2 or 3 => privateFacts with { SiteId = "another-site" },
            4 => privateFacts with { Exists = false },
            _ => throw new ArgumentOutOfRangeException(nameof(variant))
        };
        var preflight = new ObservationPreflightAuthority(absent);
        var authority = new ArticleBulkPlanAuthority(
            new SelectionAuthority(ids), preflight, new TestTimeProvider(s_now));
        ArticleBulkPlan baseline = await authority.CreateAsync(Request("category.add", ids));
        preflight.Observation = inaccessible;
        ArticleBulkPlan actual = await authority.CreateAsync(Request("category.add", ids));

        ArticleBulkPlanItem item = Assert.Single(actual.Items);
        Assert.Equal(ArticleBulkPlanItemStatus.Blocked, item.Status);
        Assert.Equal("article-inaccessible", item.ReasonCode);
        Assert.Null(item.ExpectedRevision);
        Assert.Null(item.Lifecycle);
        Assert.Null(item.PermissionDigest);
        Assert.Null(item.StateDigest);
        Assert.Empty(item.DependencyDigests);
        Assert.False(actual.Executable);
        Assert.Equal(Assert.Single(baseline.Items).ProposedChangeDigest, item.ProposedChangeDigest);
        Assert.Equal(Assert.Single(baseline.Items).ContentDigest, item.ContentDigest);
        Assert.Equal(baseline.ContentDigest, actual.ContentDigest);
        Assert.Equal(JsonSerializer.Serialize(baseline), JsonSerializer.Serialize(actual));
        authority.ValidateIntegrity(actual);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Create_AuthorizedFactsRetainStateFreshness(bool blocked)
    {
        string[] ids = ["article-1"];
        var preflight = new ObservationPreflightAuthority(ObservedArticle() with
        {
            Applicable = !blocked,
            StateDigest = ArticleBulkDigest.Of("state-a")
        });
        var authority = new ArticleBulkPlanAuthority(
            new SelectionAuthority(ids), preflight, new TestTimeProvider(s_now));
        ArticleBulkPlan first = await authority.CreateAsync(Request("category.add", ids));
        preflight.Observation = preflight.Observation with
        {
            StateDigest = ArticleBulkDigest.Of("state-b")
        };
        ArticleBulkPlan second = await authority.CreateAsync(Request("category.add", ids));

        Assert.Equal(blocked ? ArticleBulkPlanItemStatus.Blocked : ArticleBulkPlanItemStatus.Eligible,
            Assert.Single(first.Items).Status);
        Assert.NotEqual(Assert.Single(first.Items).ProposedChangeDigest, Assert.Single(second.Items).ProposedChangeDigest);
        Assert.NotEqual(first.ContentDigest, second.ContentDigest);
        authority.ValidateIntegrity(first);
        authority.ValidateIntegrity(second);
        Assert.Equal("article-bulk.execution-article-drift",
            (await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
                authority.ValidateCurrentArticlesForExecutionAsync(first))).Code);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task Create_RejectsEligibleItemsWithoutPermissionOrStateFacts(bool missingPermission, bool missingState)
    {
        string[] ids = ["article-1"];
        var preflight = new ObservationPreflightAuthority(ObservedArticle());
        var authority = new ArticleBulkPlanAuthority(
            new SelectionAuthority(ids), preflight, new TestTimeProvider(s_now));
        ArticleBulkPlan control = await authority.CreateAsync(Request("category.add", ids));
        ArticleBulkPlanItem item = Assert.Single(control.Items);
        Assert.Equal(ArticleBulkPlanItemStatus.Eligible, item.Status);
        Assert.NotNull(item.PermissionDigest);
        Assert.NotNull(item.StateDigest);
        Assert.True(control.Executable);
        authority.ValidateIntegrity(control);
        preflight.Observation = preflight.Observation with
        {
            PermissionDigest = missingPermission ? null : item.PermissionDigest,
            StateDigest = missingState ? null : item.StateDigest
        };

        Assert.Equal("article-bulk.preflight-observation-invalid",
            (await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
                authority.CreateAsync(Request("category.add", ids)))).Code);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task IntegrityRejectsResealedEligibleItemsWithoutAuthorityFacts(bool missingPermission, bool missingState)
    {
        string[] ids = ["article-1"];
        var authority = new ArticleBulkPlanAuthority(
            new SelectionAuthority(ids), new ObservationPreflightAuthority(ObservedArticle()), new TestTimeProvider(s_now));
        ArticleBulkPlan control = await authority.CreateAsync(Request("category.add", ids));
        ArticleBulkPlanItem item = Assert.Single(control.Items);
        Assert.Equal(ArticleBulkPlanItemStatus.Eligible, item.Status);
        Assert.True(control.Executable);
        ArticleBulkPlan resealedControl = ResealSingleItemPlan(control, item);
        Assert.Equal(control.ContentDigest, resealedControl.ContentDigest);
        authority.ValidateIntegrity(resealedControl);

        ArticleBulkPlan tampered = ResealSingleItemPlan(control, item with
        {
            PermissionDigest = missingPermission ? null : item.PermissionDigest,
            StateDigest = missingState ? null : item.StateDigest
        });
        ArticleBulkPlanItem tamperedItem = Assert.Single(tampered.Items);
        Assert.Equal(ArticleBulkPlanItemStatus.Eligible, tamperedItem.Status);
        Assert.Equal(ArticleBulkDigest.Of(tamperedItem with
        {
            ContentDigest = string.Empty
        }), tamperedItem.ContentDigest);
        ArticleBulkPlanItemChunk chunk = Assert.Single(tampered.ItemChunks);
        Assert.Equal(ArticleBulkDigest.Of(chunk.Items), chunk.ContentDigest);
        Assert.NotEqual(control.ContentDigest, tampered.ContentDigest);
        Assert.Equal(control.FrozenSetDigest, tampered.FrozenSetDigest);
        Assert.Equal("article-bulk.plan-tampered",
            Assert.Throws<ArticleBulkContractException>(() => authority.ValidateIntegrity(tampered)).Code);
    }

    private static ArticleBulkArticleObservation ObservedArticle() => new(
        "article-1", true, "site-1", "revision-1", "inbox", true, true,
        ArticleBulkDigest.Of("permission"), ArticleBulkDigest.Of("state"), [ArticleBulkDigest.Of("dependency")]);

    private static ArticleBulkPlan ResealSingleItemPlan(ArticleBulkPlan plan, ArticleBulkPlanItem item)
    {
        ArticleBulkPlanItem sealedItem = item with
        {
            ContentDigest = ArticleBulkDigest.Of(item with
            {
                ContentDigest = string.Empty
            })
        };
        ImmutableArray<ArticleBulkPlanItem> items = [sealedItem];
        ArticleBulkPlanItemChunk chunk = Assert.Single(plan.ItemChunks) with
        {
            Items = items,
            ContentDigest = ArticleBulkDigest.Of(items)
        };
        ArticleBulkPlan unsigned = plan with
        {
            ItemChunks = [chunk],
            ContentDigest = string.Empty
        };
        // Reuse only the production hash to reseal the adversarial fixture, not a second plan builder.
        // The refusal oracle is the real integrity entry point, independent of a stale digest mismatch.
        MethodInfo digestPlan = typeof(ArticleBulkPlanAuthority).GetMethod("DigestPlan", BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("Production plan digest method is unavailable.");
        string digest = Assert.IsType<string>(digestPlan.Invoke(null, [unsigned]));
        return unsigned with
        {
            ContentDigest = digest
        };
    }

    private static ArticleBulkPlanRequest Request(
        string operationId,
        IReadOnlyList<string> ids,
        ArticleBulkSelectionKind kind = ArticleBulkSelectionKind.Explicit) => new(
        "plan-1",
        null,
        operationId,
        operationId == "category.add"
            ? Parameters(("categoryId", "category-1"))
            : Parameters(("reasonCode", "bulk-request")),
        new ArticleBulkSelection(
            kind,
            kind is ArticleBulkSelectionKind.Explicit or ArticleBulkSelectionKind.CurrentPage ? [.. ids] : [],
            kind is ArticleBulkSelectionKind.SavedView or ArticleBulkSelectionKind.Query ? "authority-1" : null,
            ArticleBulkDigest.Of("selection")),
        new ArticleBulkActor("user-1", "site-1", ArticleBulkDigest.Of("actor")),
        new ArticleBulkSource(new string('a', 40), ArticleBulkDigest.Of("build")),
        ArticleBulkDigest.Of("policy"),
        ArticleBulkDigest.Of("permission-policy"),
        s_now,
        s_now.AddMinutes(30));

    private static Dictionary<string, JsonElement> Parameters(params (string Name, string Value)[] pairs) =>
        pairs.ToDictionary(
            static pair => pair.Name,
            static pair => JsonSerializer.SerializeToElement(pair.Value),
            StringComparer.Ordinal);

    private sealed class SelectionAuthority(IEnumerable<string> ids) : IArticleBulkSelectionAuthority
    {
        internal IReadOnlyList<string> Ids
        {
            get;
            set;
        } = [.. ids];
        internal int Calls
        {
            get;
            private set;
        }

        public Task<ArticleBulkSelectionResolution> ResolveAsync(
            ArticleBulkSelection selection,
            ArticleBulkActor actor,
            CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(new ArticleBulkSelectionResolution(
                ArticleBulkDigest.Of("selection-authority"),
                ArticleBulkDigest.Of(Ids),
                Stream(Ids, cancellationToken)));
        }
    }

    private sealed class PreflightAuthority(string? blockedArticleId = null) : IArticleBulkPreflightAuthority
    {
        internal int Count
        {
            get;
            private set;
        }

        public async IAsyncEnumerable<ArticleBulkArticleObservation> ObserveAsync(
            IReadOnlyList<string> orderedArticleIds,
            ArticleBulkOperation operation,
            IReadOnlyDictionary<string, object> normalizedParameters,
            ArticleBulkActor actor,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            foreach (string articleId in orderedArticleIds)
            {
                Count++;
                bool blocked = articleId == blockedArticleId;
                yield return new ArticleBulkArticleObservation(
                    articleId,
                    true,
                    blocked ? "another-site" : actor.SiteId,
                    $"revision-{articleId}",
                    operation.Id == "lifecycle.archive" ? "draft" : "inbox",
                    !blocked,
                    true,
                    ArticleBulkDigest.Of($"permission-{articleId}"),
                    ArticleBulkDigest.Of($"state-{articleId}"),
                    [ArticleBulkDigest.Of($"dependency-{articleId}")]);
                cancellationToken.ThrowIfCancellationRequested();
                await Task.Yield();
            }
        }
    }

    private sealed class ObservationPreflightAuthority(ArticleBulkArticleObservation observation) : IArticleBulkPreflightAuthority
    {
        internal ArticleBulkArticleObservation Observation { get; set; } = observation;

        public async IAsyncEnumerable<ArticleBulkArticleObservation> ObserveAsync(
            IReadOnlyList<string> orderedArticleIds,
            ArticleBulkOperation operation,
            IReadOnlyDictionary<string, object> normalizedParameters,
            ArticleBulkActor actor,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            Assert.Equal(Observation.ArticleId, Assert.Single(orderedArticleIds));
            cancellationToken.ThrowIfCancellationRequested();
            yield return Observation;
            await Task.Yield();
        }
    }

    private sealed class TestTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        internal DateTimeOffset UtcNow { get; set; } = utcNow;
        public override DateTimeOffset GetUtcNow() => UtcNow;
    }

    private static async IAsyncEnumerable<string> Stream(
        IEnumerable<string> values,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        foreach (string value in values)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return value;
            await Task.Yield();
        }
    }
}
