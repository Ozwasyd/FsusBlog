using System.Collections.Immutable;
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

    private static ArticleBulkPlanRequest Request(
        string operationId,
        IReadOnlyList<string> ids,
        ArticleBulkSelectionKind kind = ArticleBulkSelectionKind.Explicit) => new(
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
