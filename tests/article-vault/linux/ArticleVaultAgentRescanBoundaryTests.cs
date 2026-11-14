using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "ArticleVaultAgentLifecycle")]
public sealed class ArticleVaultAgentRescanBoundaryTests
{
    [Fact]
    public void CanonicalObligation_StartsReconnectButNeverClearsNativeRecoveryGate()
    {
        ArticleVaultAgentLifecycleReceipt previous = Initial();
        VaultRescanObligation required = Required();
        VaultRescanObligation running = ArticleVaultRescanTracker.Begin(required, required.OwnerIdentity);
        VaultRescanObligation failed = ArticleVaultRescanTracker.Fail(running, running.OwnerIdentity, "native_reader_unavailable");
        foreach (VaultRescanObligation obligation in new[] { required, running, failed })
        {
            ArticleVaultAgentLifecycleReceipt blocked = ArticleVaultAgentRescanBoundary.RecordRequiredRescan(
                previous, obligation, previous.ContentSha256, 1);
            Assert.Equal(ArticleVaultAgentLifecycleState.Reconnecting, blocked.NewState);
            Assert.True(blocked.RescanRequired);
            Assert.Null(blocked.Recovery);
            Assert.Null(blocked.LeaseGeneration);
            Assert.Equal(obligation.ContentSha256, blocked.ProducerReceiptSha256);
            Assert.Throws<InvalidDataException>(() => ArticleVaultAgentLifecycle.Reduce(blocked,
                ArticleVaultAgentLifecycleFact.RecoveryCompleted, blocked.ContentSha256, 2));
        }
    }

    [Fact]
    public void ResealedForeignOwnerAndTamperedObligation_AreRejected()
    {
        ArticleVaultAgentLifecycleReceipt previous = Initial();
        VaultRescanObligation required = Required();
        VaultRescanObligation foreign = required with
        {
            OwnerIdentity = "agent-other"
        };
        foreign = foreign with
        {
            ContentSha256 = ArticleVaultRescanTracker.ComputeContentSha256(foreign)
        };
        Assert.True(ArticleVaultRescanTracker.Validate(foreign));
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentRescanBoundary.RecordRequiredRescan(
            previous, foreign, previous.ContentSha256, 1));
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentRescanBoundary.RecordRequiredRescan(
            previous, required with
            {
                Attempt = 1
            }, previous.ContentSha256, 1));
    }

    private static ArticleVaultAgentLifecycleReceipt Initial()
        => ArticleVaultAgentLifecycle.Initial(ArticleVaultLeaseProtocolTests.Binding, ArticleVaultAgentPlatform.Linux, 0);

    private static VaultRescanObligation Required()
    {
        ArticleVaultAgentBinding binding = ArticleVaultLeaseProtocolTests.Binding;
        var scope = new VaultPathStructuralScope(binding.SiteIdentity, binding.VaultIdentity, binding.DeviceIdentity,
            binding.AgentInstanceIdentity, binding.RootSha256, new string('c', 64), VaultPathComparisonPolicy.Ordinal);
        var observation = new VaultObservationBinding(scope, "watch-test");
        var watermark = new VaultObservationWatermark("watch-test", 0, new string('d', 64), null);
        return ArticleVaultRescanTracker.Require(observation, binding.AgentInstanceIdentity, watermark, ["watcher_restart"]);
    }
}
