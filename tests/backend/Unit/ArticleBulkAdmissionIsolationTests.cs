using System.Collections.Immutable;
using System.Text.Json;

using FsusBlog.Server.Services.Articles.Bulk;

namespace FsusBlog.Server.Tests.Unit;

// Authority observations and command responses are protocol inputs, not DB qualification.
public sealed class ArticleBulkAdmissionIsolationTests
{
    [Theory]
    [InlineData("revision", "revision-conflict")]
    [InlineData("permission", "article-inaccessible")]
    [InlineData("site", "article-inaccessible")]
    [InlineData("absence", "article-inaccessible")]
    [InlineData("permission-digest", "permission-conflict")]
    [InlineData("state", "article-state-blocked")]
    [InlineData("applicability", "operation-not-applicable")]
    [InlineData("dependency", "precondition-conflict")]
    public async Task SingleItemDriftIsSealedAsAnIsolatedRefusalAndOtherExactItemsExecute(
        string change, string expectedReason)
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.add");
        string frozenDigest = fixture.Plan.ContentDigest;
        string affected = fixture.Plan.Items.ElementAt(1).ArticleId;
        fixture.Preflight.Transform = observation => observation.ArticleId == affected ? Change(observation, change) : observation;
        var commands = new ItemOwner(fixture.Plan);
        ArticleBulkExecutionResult result = await new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, commands)
            .ExecuteAsync(fixture.Plan, fixture.Input);

        Assert.Equal(ArticleBulkExecutionState.Partial, result.Head.State);
        Assert.Equal(2, result.Receipt!.SucceededCount);
        Assert.Equal(1, result.Receipt.FailedCount);
        Assert.Equal(fixture.Plan.Items.Where(item => item.ArticleId != affected).Select(static item => item.ArticleId), commands.Calls);
        ArticleBulkItemReceipt refused = Assert.Single(fixture.Journal.Receipts, receipt => receipt.ArticleId == affected);
        Assert.Equal(ArticleBulkItemStatus.Failed, refused.ExecutionStatus);
        Assert.Equal(expectedReason, refused.ReasonCode);
        Assert.Null(refused.NewRevision);
        Assert.Null(refused.ObservedRevision);
        Assert.Empty(refused.SideEffects);
        Assert.Null(result.Receipt.ZeroWriteProofDigest);
        Assert.Equal(frozenDigest, fixture.Plan.ContentDigest);
        Assert.Equal(1, fixture.Selection.Calls);
        Assert.Equal(2, fixture.Preflight.Calls);
        await fixture.Framework.VerifyExecutionAsync(result.Request, fixture.Plan, result.Head);
    }

    [Fact]
    public async Task AllItemsDeniedProduceExactFailuresAndNeverInvokeACanonicalCommand()
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.add");
        fixture.Preflight.Transform = observation => observation with { Permitted = false };
        var commands = new ItemOwner(fixture.Plan);
        ArticleBulkExecutionResult result = await new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, commands)
            .ExecuteAsync(fixture.Plan, fixture.Input);
        Assert.Equal(ArticleBulkExecutionState.Failed, result.Head.State);
        Assert.Equal(3, result.Receipt!.FailedCount);
        Assert.Empty(commands.Calls);
        Assert.All(fixture.Journal.Receipts, static receipt => Assert.Equal("article-inaccessible", receipt.ReasonCode));
        Assert.Equal(3, fixture.Plan.Impact.EligibleCount);
    }

    [Theory]
    [InlineData("revision")]
    [InlineData("permission")]
    public async Task AtomicAdmissionKeepsTheWholeSetDriftBarrierAndWritesNoJournal(string change)
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
        string affected = fixture.Plan.Items.ElementAt(1).ArticleId;
        fixture.Preflight.Transform = observation => observation.ArticleId == affected ? Change(observation, change) : observation;
        Assert.Equal("article-bulk.execution-article-drift", (await Assert.ThrowsAsync<ArticleBulkContractException>(() =>
            ArticleBulkExecutorProtocol.AdmitAsync(fixture.Framework, fixture.Plan, fixture.Input, default))).Code);
        Assert.Empty(fixture.Journal.Events);
        Assert.Empty(fixture.Journal.Receipts);
        Assert.Null(fixture.Journal.Request);
    }

    [Theory]
    [InlineData("order")]
    [InlineData("shape")]
    [InlineData("incomplete")]
    public async Task BrokenObservationAuthorityStillRejectsGlobalAdmissionBeforeAnyCommandOrJournal(string failure)
    {
        ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.add");
        fixture.Preflight.Transform = observation => failure switch
        {
            "order" => observation with { ArticleId = "different-identity" },
            "shape" => observation with { PermissionDigest = "invalid-digest" },
            _ => throw new IOException("authority stream interrupted")
        };
        var commands = new ItemOwner(fixture.Plan);
        await Assert.ThrowsAnyAsync<Exception>(() => new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, commands)
            .ExecuteAsync(fixture.Plan, fixture.Input));
        Assert.Empty(commands.Calls);
        Assert.Empty(fixture.Journal.Events);
        Assert.Null(fixture.Journal.Request);
    }

    [Fact]
    public async Task DeniedAbsentAndForeignSiteObservationsShareTheSamePrivateRefusalReceipt()
    {
        var digests = new List<string>();
        foreach (string change in new[] { "permission", "absence", "site" })
        {
            ArticleBulkExecutorTestFixture fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.add", 1);
            fixture.Preflight.Transform = observation => Change(observation, change) with
            {
                Revision = "private-current-revision",
                Lifecycle = "private-current-state",
                StateDigest = ArticleBulkDigest.Of("private-current-state")
            };
            var commands = new ItemOwner(fixture.Plan);
            await new ArticleBulkPerItemExecutor(fixture.Framework, fixture.Journal, commands)
                .ExecuteAsync(fixture.Plan, fixture.Input);
            ArticleBulkItemReceipt receipt = Assert.Single(fixture.Journal.Receipts);
            string serialized = JsonSerializer.Serialize(receipt);
            Assert.DoesNotContain("private-current", serialized, StringComparison.Ordinal);
            Assert.Empty(commands.Calls);
            digests.Add(receipt.ContentDigest);
        }
        Assert.Single(digests.Distinct(StringComparer.Ordinal));
    }

    private static ArticleBulkArticleObservation Change(ArticleBulkArticleObservation observation, string change)
        => change switch
        {
            "revision" => observation with { Revision = "changed-revision" },
            "permission" => observation with { Permitted = false },
            "site" => observation with { SiteId = "foreign-site" },
            "absence" => observation with { Exists = false },
            "permission-digest" => observation with { PermissionDigest = ArticleBulkDigest.Of("new-permission") },
            "state" => observation with { Lifecycle = "deleted" },
            "applicability" => observation with { Applicable = false },
            "dependency" => observation with { DependencyDigests = [ArticleBulkDigest.Of("new-dependency")] },
            _ => throw new InvalidOperationException(change)
        };

    private sealed class ItemOwner(ArticleBulkPlan plan) : IArticleBulkPerItemCommandAuthority
    {
        internal List<string> Calls { get; } = [];
        public string CommandOwner => ArticleBulkOperationRegistry.Get(plan.OperationId).CommandOwner;
        public ImmutableArray<string> OperationIds => [plan.OperationId];
        public string RegistryDigest => plan.RegistryDigest;
        public Task<ArticleBulkItemReceipt> ExecuteAsync(ArticleBulkItemCommand command, CancellationToken cancellationToken)
        {
            Calls.Add(command.Item.ArticleId);
            return Task.FromResult(ArticleBulkExecutorTestFixture.ItemReceipt(command.Request, command.Plan, command.Item));
        }
    }
}
