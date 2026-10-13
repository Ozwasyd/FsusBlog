using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleVaultRecoveryStoredProposalReaderTests
{
    [Fact]
    public async Task ExactPersistedProposal_ComposesOriginalHistoryWithoutGrantingExecution()
    {
        ArticleVaultRecoveryCheckpointReaderTests.Fixture fixture = ArticleVaultRecoveryCheckpointReaderTests.Create();
        IArticleVaultResolutionProposalStore store = CreateStore(fixture.Resolution);
        var reader = new ArticleVaultRecoveryStoredProposalReader(store, fixture.Reader);

        ArticleVaultRecoveryCheckpointSnapshot snapshot = await reader.ReadAsync(
            fixture.Resolution.ResolutionOperationIdentity, fixture.Resolution.ContentSha256,
            fixture.Operation, 0, fixture.Checkpoint.ContentSha256);

        Assert.Equal(fixture.Resolution.ContentSha256, snapshot.ResolutionPlanSha256);
        Assert.Equal(fixture.Checkpoint, Assert.Single(snapshot.Checkpoints));
        Assert.Contains("canonical_conflict_resolution_execution_admission", snapshot.MissingCapabilities);
        Assert.Contains("encrypted_recovery_backup_and_journal_persistence", snapshot.MissingCapabilities);
        await store.Received(1).ReadExactAsync(fixture.Resolution.ResolutionOperationIdentity,
            fixture.Resolution.ContentSha256, Arg.Any<CancellationToken>());
        Assert.DoesNotContain(store.ReceivedCalls(), static call => call.GetMethodInfo().Name == "SealAsync");
    }

    [Fact]
    public async Task MissingPersistedProposal_RefusesBeforeOriginalHistoryOrAcceptedSourceRead()
    {
        ArticleVaultRecoveryCheckpointReaderTests.Fixture fixture = ArticleVaultRecoveryCheckpointReaderTests.Create();
        IArticleVaultResolutionProposalStore store = CreateStore(null);
        var reader = new ArticleVaultRecoveryStoredProposalReader(store, fixture.Reader);

        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
            () => reader.ReadAcceptedSourceAsync(fixture.Resolution.ResolutionOperationIdentity,
                fixture.Resolution.ContentSha256, fixture.Operation, 0, fixture.Checkpoint.ContentSha256, null!));

        Assert.Equal("article_vault_recovery_stored_proposal_missing", error.Message);
        Assert.Empty(fixture.ExecutionStore.ReceivedCalls());
        Assert.Empty(fixture.CheckpointStore.ReceivedCalls());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ChangedExactReference_RefusesAValidProposalReturnedUnderAnotherKey(bool changeIdentity)
    {
        ArticleVaultRecoveryCheckpointReaderTests.Fixture fixture = ArticleVaultRecoveryCheckpointReaderTests.Create();
        IArticleVaultResolutionProposalStore store = CreateStore(fixture.Resolution);
        var reader = new ArticleVaultRecoveryStoredProposalReader(store, fixture.Reader);
        string changedDigest = new('b', 64);

        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
            () => reader.ReadAsync(changeIdentity ? "resolution-" + changedDigest : fixture.Resolution.ResolutionOperationIdentity,
                changeIdentity ? fixture.Resolution.ContentSha256 : changedDigest,
                fixture.Operation, 0, fixture.Checkpoint.ContentSha256));

        Assert.Equal("article_vault_recovery_stored_proposal_binding_drift", error.Message);
        Assert.Empty(fixture.ExecutionStore.ReceivedCalls());
        Assert.Empty(fixture.CheckpointStore.ReceivedCalls());
    }

    [Fact]
    public async Task CancellationDuringProposalRead_ReturnsNoPartialHistory()
    {
        ArticleVaultRecoveryCheckpointReaderTests.Fixture fixture = ArticleVaultRecoveryCheckpointReaderTests.Create();
        using var cancellation = new CancellationTokenSource();
        IArticleVaultResolutionProposalStore store = Substitute.For<IArticleVaultResolutionProposalStore>();
        store.ReadExactAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(_ =>
        {
            cancellation.Cancel();
            return Task.FromResult<ArticleVaultResolutionPlan?>(fixture.Resolution);
        });
        var reader = new ArticleVaultRecoveryStoredProposalReader(store, fixture.Reader);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.ReadAsync(
            fixture.Resolution.ResolutionOperationIdentity, fixture.Resolution.ContentSha256,
            fixture.Operation, 0, fixture.Checkpoint.ContentSha256, cancellation.Token));

        Assert.Empty(fixture.ExecutionStore.ReceivedCalls());
        Assert.Empty(fixture.CheckpointStore.ReceivedCalls());
    }

    private static IArticleVaultResolutionProposalStore CreateStore(ArticleVaultResolutionPlan? proposal)
    {
        IArticleVaultResolutionProposalStore store = Substitute.For<IArticleVaultResolutionProposalStore>();
        store.ReadExactAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(proposal));
        return store;
    }
}
