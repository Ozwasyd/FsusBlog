using FsusBlog.Shared.Contracts.ArticleVault;

using Xunit;

namespace FsusBlog.ArticleVault.Linux.Tests;

[Trait("Category", "ArticleVaultAgentDispatch")]
public sealed class ArticleVaultAgentLifecycleInventoryTests
{
    [Fact]
    public void Inventory_RoundTripsExactCanonicalPointersAndRetainsThemAcrossRestart()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        ArticleVaultAgentLifecycleReceipt stopped = ArticleVaultAgentLifecycle.Initial(fixture.Binding, ArticleVaultAgentPlatform.Linux, 0);
        ArticleVaultAgentLifecycleInventoryReceipt first = ArticleVaultAgentLifecycleInventory.Create(null,
            fixture.Plan.RootManifestSha256, 1, stopped, [fixture.Reference]);
        ArticleVaultAgentLifecycleInventoryReceipt decoded = ArticleVaultAgentLifecycleInventory.Decode(ArticleVaultAgentProtocol.Encode(first));
        Assert.Equal(first.ContentSha256, decoded.ContentSha256);
        Assert.Equal(fixture.Reference, Assert.Single(decoded.Operations));
        ArticleVaultAgentLifecycleReceipt restarted = ArticleVaultAgentLifecycle.Initial(fixture.Binding with
        {
            UserSessionIdentity = "next-session"
        }, ArticleVaultAgentPlatform.Linux, 5);
        ArticleVaultAgentLifecycleInventoryReceipt next = ArticleVaultAgentLifecycleInventory.Create(first,
            fixture.Plan.RootManifestSha256, 2, restarted, first.Operations);
        Assert.True(next.Lifecycle.RescanRequired);
        Assert.Equal(ArticleVaultAgentLifecycleState.Stopped, next.Lifecycle.NewState);
        Assert.Equal(first.ContentSha256, next.PreviousReceiptSha256);
        Assert.Equal(first.Operations, next.Operations);
    }

    [Fact]
    public void Inventory_RejectsDiscardedPointersAndAResumedRunningStateAtRestart()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        ArticleVaultAgentLifecycleReceipt stopped = ArticleVaultAgentLifecycle.Initial(fixture.Binding, ArticleVaultAgentPlatform.Linux, 0);
        ArticleVaultAgentLifecycleInventoryReceipt first = ArticleVaultAgentLifecycleInventory.Create(null,
            fixture.Plan.RootManifestSha256, 1, stopped, [fixture.Reference]);
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentLifecycleInventory.Create(first,
            fixture.Plan.RootManifestSha256, 2, stopped, []));
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentLifecycleInventory.Create(first,
            fixture.Plan.RootManifestSha256, 2, fixture.Running, first.Operations));
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentLifecycleInventory.Create(first,
            new string('f', 64), 1, stopped, first.Operations));
    }

    [Fact]
    public async Task DurableCancellationPointer_RoundTripsWithoutAuthorizingRunningOrRollback()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        ArticleVaultAgentLifecycleReceipt stopped = ArticleVaultAgentLifecycle.Initial(fixture.Binding, ArticleVaultAgentPlatform.Linux, 0);
        ArticleVaultAgentLifecycleInventoryReceipt first = ArticleVaultAgentLifecycleInventory.Create(null,
            fixture.Plan.RootManifestSha256, 1, stopped, [fixture.Reference]);
        ArticleVaultAgentOperationSnapshot cancelled = await fixture.CancelAsync(fixture.Reference, default);
        ArticleVaultOperationCheckpoint tip = cancelled.History[^1];
        ArticleVaultAgentOperationReference durable = new(fixture.Identity, tip.Sequence, tip.ContentSha256);
        ArticleVaultAgentOperationInventory.RequireCurrentBinding(fixture.Binding, fixture.Plan.RootManifestSha256, durable, cancelled);
        ArticleVaultAgentLifecycleInventoryReceipt next = ArticleVaultAgentLifecycleInventory.Create(first,
            fixture.Plan.RootManifestSha256, 1, stopped, [durable]);
        ArticleVaultAgentLifecycleInventoryReceipt decoded = ArticleVaultAgentLifecycleInventory.Decode(ArticleVaultAgentProtocol.Encode(next));
        Assert.Equal(durable, Assert.Single(decoded.Operations));
        Assert.True(decoded.Lifecycle.RescanRequired);
        Assert.Equal(ArticleVaultAgentLifecycleState.Stopped, decoded.Lifecycle.NewState);
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentLifecycleInventory.Create(next,
            fixture.Plan.RootManifestSha256, 1, stopped, [fixture.Reference]));
    }

    [Fact]
    public void Inventory_RejectsUnknownFieldsAndContentDrift()
    {
        using var fixture = new ArticleVaultAgentDispatchFixture();
        ArticleVaultAgentLifecycleReceipt stopped = ArticleVaultAgentLifecycle.Initial(fixture.Binding, ArticleVaultAgentPlatform.Linux, 0);
        ArticleVaultAgentLifecycleInventoryReceipt receipt = ArticleVaultAgentLifecycleInventory.Create(null,
            fixture.Plan.RootManifestSha256, 1, stopped, [fixture.Reference]);
        Assert.False(ArticleVaultAgentLifecycleInventory.Verify(receipt with
        {
            LeaseGeneration = 2
        }));
        byte[] bytes = ArticleVaultAgentProtocol.Encode(receipt);
        string unknown = System.Text.Encoding.UTF8.GetString(bytes)[..^1] + ",\"latest\":true}";
        Assert.Throws<InvalidDataException>(() => ArticleVaultAgentLifecycleInventory.Decode(System.Text.Encoding.UTF8.GetBytes(unknown)));
    }
}
