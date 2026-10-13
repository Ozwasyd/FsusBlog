namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>
/// Persists lifecycle facts and exact original checkpoint pointers, never operation transitions,
/// source bytes, metadata values or credentials. A historical pointer cannot establish a current tip.
/// </summary>
public sealed record ArticleVaultAgentLifecycleInventoryReceipt(
    string Schema,
    string RootManifestSha256,
    long LeaseGeneration,
    long Sequence,
    string? PreviousReceiptSha256,
    ArticleVaultAgentLifecycleReceipt Lifecycle,
    IReadOnlyList<ArticleVaultAgentOperationReference> Operations,
    string ContentSha256);

/// <summary>Seals bounded lifecycle inventory chains without promoting historical state to admission.</summary>
public static class ArticleVaultAgentLifecycleInventory
{
    public const string Schema = "fsusblog.article-vault.agent-lifecycle-inventory.v1";
    public const int MaximumOperations = 8;

    public static ArticleVaultAgentLifecycleInventoryReceipt Create(
        ArticleVaultAgentLifecycleInventoryReceipt? previous,
        string rootManifestSha256,
        long leaseGeneration,
        ArticleVaultAgentLifecycleReceipt lifecycle,
        IReadOnlyList<ArticleVaultAgentOperationReference> operations)
    {
        ArgumentNullException.ThrowIfNull(operations);
        var receipt = new ArticleVaultAgentLifecycleInventoryReceipt(Schema, rootManifestSha256, leaseGeneration,
            previous?.Sequence + 1 ?? 1, previous?.ContentSha256, lifecycle,
            operations.OrderBy(static item => item.Identity.OperationIdentity, StringComparer.Ordinal).ToArray(), string.Empty);
        receipt = receipt with
        {
            ContentSha256 = ArticleVaultAgentProtocol.Digest(receipt)
        };
        if (!VerifyAppend(previous, receipt) || ArticleVaultAgentProtocol.Encode(receipt).Length > ArticleVaultAgentProtocol.MaximumFrameBytes)
        {
            throw new InvalidDataException("agent_lifecycle_inventory_append_invalid");
        }

        return receipt;
    }

    public static ArticleVaultAgentLifecycleInventoryReceipt Decode(ReadOnlySpan<byte> bytes)
    {
        ArticleVaultAgentLifecycleInventoryReceipt receipt = ArticleVaultAgentProtocol.Decode<ArticleVaultAgentLifecycleInventoryReceipt>(bytes);
        if (!Verify(receipt))
        {
            throw new InvalidDataException("agent_lifecycle_inventory_invalid");
        }

        return receipt;
    }

    public static bool Verify(ArticleVaultAgentLifecycleInventoryReceipt? receipt)
    {
        if (receipt is null || receipt.Schema != Schema || receipt.LeaseGeneration < 1 || receipt.Sequence < 1
            || !ArticleVaultAgentProtocol.IsDigest(receipt.RootManifestSha256)
            || !ArticleVaultAgentLifecycle.Verify(receipt.Lifecycle)
            || (receipt.Sequence == 1 ? receipt.PreviousReceiptSha256 is not null
                : !ArticleVaultAgentProtocol.IsDigest(receipt.PreviousReceiptSha256))
            || receipt.Operations is null || receipt.Operations.Count > MaximumOperations
            || !receipt.Operations.All(static reference => ArticleVaultAgentOperationInventory.IsReference(reference)))
        {
            return false;
        }

        string[] identities = receipt.Operations.Select(static item => item.Identity.OperationIdentity).ToArray();
        ArticleVaultAgentBinding binding = receipt.Lifecycle.Binding;
        return identities.Distinct(StringComparer.Ordinal).Count() == identities.Length
            && identities.SequenceEqual(identities.Order(StringComparer.Ordinal), StringComparer.Ordinal)
            && receipt.Operations.All(item => item.Identity.SiteIdentity == binding.SiteIdentity
                && item.Identity.VaultIdentity == binding.VaultIdentity && item.Identity.DeviceIdentity == binding.DeviceIdentity)
            && receipt.ContentSha256 == ArticleVaultAgentProtocol.Digest(receipt with
            {
                ContentSha256 = string.Empty
            });
    }

    public static bool VerifyAppend(
        ArticleVaultAgentLifecycleInventoryReceipt? previous,
        ArticleVaultAgentLifecycleInventoryReceipt next)
    {
        if (!Verify(next) || next.Sequence != (previous?.Sequence + 1 ?? 1)
            || next.PreviousReceiptSha256 != previous?.ContentSha256)
        {
            return false;
        }

        if (previous is null)
        {
            return next.Lifecycle.RescanRequired
                && next.Lifecycle.NewState is ArticleVaultAgentLifecycleState.Stopped or ArticleVaultAgentLifecycleState.Starting;
        }

        ArticleVaultAgentBinding before = previous.Lifecycle.Binding;
        ArticleVaultAgentBinding after = next.Lifecycle.Binding;
        if (!Verify(previous) || before.SiteIdentity != after.SiteIdentity || before.VaultIdentity != after.VaultIdentity
            || before.DeviceIdentity != after.DeviceIdentity || before.RootSha256 != after.RootSha256
            || next.LeaseGeneration < previous.LeaseGeneration
            || next.Lifecycle.ObservedUnixMilliseconds < previous.Lifecycle.ObservedUnixMilliseconds)
        {
            return false;
        }

        foreach (ArticleVaultAgentOperationReference old in previous.Operations)
        {
            ArticleVaultAgentOperationReference? retained = next.Operations.SingleOrDefault(
                item => item.Identity.OperationIdentity == old.Identity.OperationIdentity);
            if (retained is null || retained.Identity != old.Identity || retained.CheckpointSequence < old.CheckpointSequence
                || retained.CheckpointSequence == old.CheckpointSequence && retained.CheckpointSha256 != old.CheckpointSha256)
            {
                return false;
            }
        }

        if (next.LeaseGeneration > previous.LeaseGeneration)
        {
            // Retain unfinished canonical pointers across runs. Restart cannot promote a persisted
            // Running state or discard obligations before real root/rescan/operation revalidation.
            return next.Lifecycle.RescanRequired && next.Lifecycle.Sequence is 1 or 2
                && next.Lifecycle.NewState is ArticleVaultAgentLifecycleState.Stopped or ArticleVaultAgentLifecycleState.Starting;
        }

        return before == after && previous.RootManifestSha256 == next.RootManifestSha256
            && (previous.Lifecycle == next.Lifecycle
            || next.Lifecycle.Sequence == previous.Lifecycle.Sequence + 1
                && next.Lifecycle.PreviousReceiptSha256 == previous.Lifecycle.ContentSha256
                && next.Lifecycle.PreviousState == previous.Lifecycle.NewState);
    }
}
