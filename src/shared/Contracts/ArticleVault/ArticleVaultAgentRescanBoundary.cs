namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Consumes canonical rescan obligations without inventing a native completion producer.</summary>
public static class ArticleVaultAgentRescanBoundary
{
    public static ArticleVaultAgentLifecycleReceipt RecordRequiredRescan(
        ArticleVaultAgentLifecycleReceipt previous,
        VaultRescanObligation obligation,
        string expectedPreviousReceiptSha256,
        long nowUnixMilliseconds)
    {
        if (!ArticleVaultAgentLifecycle.Verify(previous) || !ArticleVaultRescanTracker.Validate(obligation)
            || obligation.Binding.Scope.SiteIdentity != previous.Binding.SiteIdentity
            || obligation.Binding.Scope.VaultIdentity != previous.Binding.VaultIdentity
            || obligation.Binding.Scope.DeviceIdentity != previous.Binding.DeviceIdentity
            || obligation.Binding.Scope.AgentIdentity != previous.Binding.AgentInstanceIdentity
            || obligation.OwnerIdentity != previous.Binding.AgentInstanceIdentity
            || !obligation.BlocksSynchronization || obligation.NativeTerminalReceiptSha256 is not null)
        {
            throw new InvalidDataException("agent_rescan_obligation_binding_invalid");
        }

        ArticleVaultAgentLifecycleFact fact = previous.NewState switch
        {
            ArticleVaultAgentLifecycleState.Stopped or ArticleVaultAgentLifecycleState.Crashed => ArticleVaultAgentLifecycleFact.RequestReconnect,
            ArticleVaultAgentLifecycleState.Running => ArticleVaultAgentLifecycleFact.RequestStop,
            _ => ArticleVaultAgentLifecycleFact.ObservationDuringTransition
        };
        // Scope/root digests in structural DTOs do not prove native admission. Every branch stops
        // or retains blocked observation; neither AwaitingNativeVerification nor an inventory hash
        // is promoted to healthy/recovered, a current lease, or a completed execution receipt.
        return ArticleVaultAgentLifecycle.Reduce(previous, fact, expectedPreviousReceiptSha256,
            nowUnixMilliseconds, producerReceiptSha256: obligation.ContentSha256);
    }
}
