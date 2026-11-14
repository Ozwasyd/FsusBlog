using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "ArticleVaultAgentLifecycle")]
public sealed class ArticleVaultAgentLifecycleTests
{
    private static readonly ArticleVaultAgentRecoveryReferences s_recovery = new(
        new string('c', 64), new string('d', 64), new string('e', 64), new string('f', 64), new string('a', 64));

    [Fact]
    public void StartAndReconnect_RequireEveryDurableRecoveryInput()
    {
        ArticleVaultAgentLifecycleReceipt starting = Apply(Initial(), ArticleVaultAgentLifecycleFact.RequestStart);
        Assert.True(starting.RescanRequired);
        Assert.Throws<InvalidDataException>(() => Apply(starting, ArticleVaultAgentLifecycleFact.HealthyStart));
        ArticleVaultAgentLifecycleReceipt running = Healthy(starting, ArticleVaultAgentLifecycleFact.HealthyStart);
        Assert.Equal(ArticleVaultAgentLifecycleState.Running, running.NewState);
        Assert.False(running.RescanRequired);
        ArticleVaultAgentLifecycleReceipt crash = Apply(running, ArticleVaultAgentLifecycleFact.Crash);
        Assert.True(crash.RescanRequired);
        Assert.Null(crash.Recovery);
        ArticleVaultAgentLifecycleReceipt reconnect = Apply(crash, ArticleVaultAgentLifecycleFact.RequestReconnect);
        Assert.Throws<InvalidDataException>(() => Apply(reconnect, ArticleVaultAgentLifecycleFact.RecoveryCompleted));
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentLifecycle.Reduce(
            reconnect, ArticleVaultAgentLifecycleFact.RecoveryCompleted, reconnect.ContentSha256, 10,
            producerReceiptSha256: new string('d', 64), recovery: s_recovery with
            {
                SourceTreeSha256 = string.Empty
            },
            lease: ArticleVaultLeaseProtocolTests.Acquire(), ipcReceiptSha256: new string('e', 64)));
        Assert.Equal(ArticleVaultAgentLifecycleState.Running, Healthy(reconnect, ArticleVaultAgentLifecycleFact.RecoveryCompleted).NewState);
    }

    [Fact]
    public void FailedUpdate_RetainsOldBinaryAndRequiresExplicitRollback()
    {
        ArticleVaultAgentLifecycleReceipt updating = ArticleVaultAgentLifecycle.Reduce(
            Initial(), ArticleVaultAgentLifecycleFact.RequestUpdate, Initial().ContentSha256, 1,
            candidateBinarySha256: new string('c', 64));
        Assert.Equal(ArticleVaultLeaseProtocolTests.Binding.BinarySha256, updating.RetainedBinarySha256);
        ArticleVaultAgentLifecycleReceipt failed = Apply(updating, ArticleVaultAgentLifecycleFact.FailedUpdate);
        Assert.Equal(ArticleVaultAgentLifecycleState.RollbackRequired, failed.NewState);
        Assert.True(failed.RescanRequired);
        Assert.Throws<InvalidDataException>(() => Apply(failed, ArticleVaultAgentLifecycleFact.RequestStart));
        Assert.Throws<InvalidDataException>(() => Apply(failed, ArticleVaultAgentLifecycleFact.RollbackCompleted));
        ArticleVaultAgentLifecycleReceipt rollback = Apply(failed, ArticleVaultAgentLifecycleFact.RollbackCompleted, new string('d', 64));
        Assert.Equal(ArticleVaultAgentLifecycleState.Stopped, rollback.NewState);
        Assert.Equal(ArticleVaultLeaseProtocolTests.Binding.BinarySha256, rollback.Binding.BinarySha256);
        Assert.Null(rollback.CandidateBinarySha256);
    }

    [Fact]
    public void UpdateHealthFact_DoesNotInventNewBinaryRuntimeBinding()
    {
        ArticleVaultAgentLifecycleReceipt updating = ArticleVaultAgentLifecycle.Reduce(
            Initial(), ArticleVaultAgentLifecycleFact.RequestUpdate, Initial().ContentSha256, 1,
            candidateBinarySha256: new string('c', 64));
        ArticleVaultAgentLifecycleReceipt probed = Healthy(updating, ArticleVaultAgentLifecycleFact.HealthyUpdate);
        Assert.Equal(ArticleVaultAgentLifecycleState.Reconnecting, probed.NewState);
        Assert.True(probed.RescanRequired);
        Assert.Equal("new_binary_runtime_binding_required", probed.ReasonCode);
        Assert.Equal(updating.Binding, probed.Binding);
        Assert.Throws<InvalidDataException>(() => Healthy(probed, ArticleVaultAgentLifecycleFact.RecoveryCompleted));
    }

    [Theory]
    [InlineData(ArticleVaultAgentLifecycleFact.ControlStateRetained, ArticleVaultAgentLifecycleState.RetainedControlState)]
    [InlineData(ArticleVaultAgentLifecycleFact.ControlStateRemoved, ArticleVaultAgentLifecycleState.Removed)]
    public void Unlink_RequiresCleanupReceiptAndCannotRestartTerminalState(
        ArticleVaultAgentLifecycleFact terminalFact,
        ArticleVaultAgentLifecycleState terminalState)
    {
        ArticleVaultAgentLifecycleReceipt unlink = Apply(Initial(), ArticleVaultAgentLifecycleFact.RequestUnlink);
        Assert.Throws<InvalidDataException>(() => Apply(unlink, terminalFact));
        ArticleVaultAgentLifecycleReceipt terminal = Apply(unlink, terminalFact, new string('e', 64));
        Assert.Equal(terminalState, terminal.NewState);
        Assert.Null(terminal.LeaseGeneration);
        Assert.Null(terminal.IpcReceiptSha256);
        Assert.Throws<InvalidDataException>(() => Apply(terminal, ArticleVaultAgentLifecycleFact.RequestStart));
    }

    [Fact]
    public void EventsDuringUpdate_AreBlockedAndRequireRescan()
    {
        ArticleVaultAgentLifecycleReceipt updating = ArticleVaultAgentLifecycle.Reduce(
            Initial(), ArticleVaultAgentLifecycleFact.RequestUpdate, Initial().ContentSha256, 1,
            candidateBinarySha256: new string('c', 64));
        ArticleVaultAgentLifecycleReceipt observation = Apply(updating, ArticleVaultAgentLifecycleFact.ObservationDuringTransition);
        Assert.Equal(updating.NewState, observation.NewState);
        Assert.True(observation.RescanRequired);
        Assert.Equal("events_blocked_rescan_required", observation.ReasonCode);
        Assert.Equal(updating.CandidateBinarySha256, observation.CandidateBinarySha256);
    }

    [Fact]
    public void Mismatch_StopsAuthorityAndNeverFallsBackToOldProtocol()
    {
        ArticleVaultAgentLifecycleReceipt running = Healthy(Apply(Initial(), ArticleVaultAgentLifecycleFact.RequestStart),
            ArticleVaultAgentLifecycleFact.HealthyStart);
        ArticleVaultAgentLifecycleReceipt blocked = Apply(running, ArticleVaultAgentLifecycleFact.ProtocolMismatch);
        Assert.Equal(ArticleVaultAgentLifecycleState.Stopping, blocked.NewState);
        Assert.Equal("protocol_mismatch_blocked", blocked.ReasonCode);
        Assert.Null(blocked.LeaseGeneration);
        Assert.Null(blocked.IpcReceiptSha256);
        Assert.True(blocked.RescanRequired);
        Assert.Throws<InvalidDataException>(() => Apply(blocked, ArticleVaultAgentLifecycleFact.HealthyStart));
    }

    [Fact]
    public void TamperedGenerationReceiptOrClock_IsRejected()
    {
        ArticleVaultAgentLifecycleReceipt initial = Initial();
        Assert.False(ArticleVaultAgentLifecycle.Verify(initial with
        {
            RescanRequired = false
        }));
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentLifecycle.Reduce(
            initial, ArticleVaultAgentLifecycleFact.RequestStart, new string('e', 64), 1));
        ArticleVaultAgentLifecycleReceipt starting = Apply(initial, ArticleVaultAgentLifecycleFact.RequestStart);
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentLifecycle.Reduce(
            starting, ArticleVaultAgentLifecycleFact.HealthyStart, starting.ContentSha256, 10,
            producerReceiptSha256: new string('d', 64), recovery: s_recovery,
            lease: ArticleVaultLeaseProtocolTests.Acquire() with
            {
                Generation = 99
            }, ipcReceiptSha256: new string('e', 64)));
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentLifecycle.Reduce(
            starting, ArticleVaultAgentLifecycleFact.Crash, starting.ContentSha256, 0));
    }

    private static ArticleVaultAgentLifecycleReceipt Initial()
        => ArticleVaultAgentLifecycle.Initial(ArticleVaultLeaseProtocolTests.Binding, ArticleVaultAgentPlatform.Linux, 0);

    private static ArticleVaultAgentLifecycleReceipt Apply(
        ArticleVaultAgentLifecycleReceipt previous,
        ArticleVaultAgentLifecycleFact fact,
        string? producer = null)
        => ArticleVaultAgentLifecycle.Reduce(previous, fact, previous.ContentSha256,
            previous.ObservedUnixMilliseconds + 1, producerReceiptSha256: producer);

    private static ArticleVaultAgentLifecycleReceipt Healthy(
        ArticleVaultAgentLifecycleReceipt previous,
        ArticleVaultAgentLifecycleFact fact)
        => ArticleVaultAgentLifecycle.Reduce(previous, fact, previous.ContentSha256,
            previous.ObservedUnixMilliseconds + 1, producerReceiptSha256: new string('d', 64),
            recovery: s_recovery, lease: ArticleVaultLeaseProtocolTests.Acquire(), ipcReceiptSha256: new string('e', 64));
}
