namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Names one exact canonical checkpoint; this pointer is not a new operation store.</summary>
public sealed record ArticleVaultAgentOperationReference(
    ArticleVaultOperationIdentity Identity,
    long CheckpointSequence,
    string CheckpointSha256);

/// <summary>Contains the original plan and a history read through the existing checkpoint owner.</summary>
public sealed record ArticleVaultAgentOperationSnapshot(
    ArticleVaultSyncPlan Plan,
    IReadOnlyList<ArticleVaultOperationCheckpoint> History);

/// <summary>Preserves canonical server outcomes separately from local synchronization progress.</summary>
public enum ArticleVaultAgentCanonicalOutcome
{
    Completed,
    NoOp,
    Failed,
    Cancelled
}

/// <summary>Reports a verified canonical server result, never local materialization or Synced.</summary>
public sealed record ArticleVaultAgentCanonicalResult(
    string OperationIdentity,
    string IdentitySha256,
    string PlanSha256,
    string ResultReference,
    string ResultSha256,
    ArticleVaultAgentCanonicalOutcome Outcome);

/// <summary>
/// The server adapter uses the existing sealed bundle, checkpoint reader and executor. Implementing
/// this port does not authorize a local agent to hold service credentials or bypass its native gate.
/// </summary>
public interface IArticleVaultAgentCanonicalOperations
{
    Task<ArticleVaultAgentOperationSnapshot> ReadAsync(
        ArticleVaultAgentOperationReference reference,
        CancellationToken cancellationToken);

    Task<ArticleVaultAgentCanonicalResult> ExecuteAsync(
        ArticleVaultAgentOperationReference reference,
        CancellationToken cancellationToken);

    /// <summary>Requests a durable canonical cancellation and returns its exact verified history.</summary>
    Task<ArticleVaultAgentOperationSnapshot> CancelAsync(
        ArticleVaultAgentOperationReference reference,
        CancellationToken cancellationToken);
}

/// <summary>Checks canonical operation histories against the exact active control scope.</summary>
public static class ArticleVaultAgentOperationInventory
{
    public static void RequireCurrentBinding(
        ArticleVaultAgentBinding binding,
        string rootManifestSha256,
        ArticleVaultAgentOperationReference reference,
        ArticleVaultAgentOperationSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(snapshot);
        ArticleVaultOperationIdentity identity = reference.Identity;
        if (!ArticleVaultAgentProtocol.IsBinding(binding)
            || !ArticleVaultAgentProtocol.IsDigest(rootManifestSha256)
            || identity is null || snapshot.Plan is null
            || identity.SiteIdentity != binding.SiteIdentity || identity.VaultIdentity != binding.VaultIdentity
            || identity.DeviceIdentity != binding.DeviceIdentity || identity.AgentIdentity != binding.AgentInstanceIdentity
            || snapshot.Plan.RootManifestSha256 != rootManifestSha256)
        {
            throw new InvalidDataException("agent_operation_scope_mismatch");
        }

        ArticleVaultOperationVerifier.Require(ArticleVaultOperationVerifier.VerifyHistory(identity,
            snapshot.Plan, snapshot.History, reference.CheckpointSequence, reference.CheckpointSha256));
    }

    public static bool IsReference(ArticleVaultAgentOperationReference? reference)
        => reference?.Identity is { } identity && reference.CheckpointSequence >= 0
            && identity.Schema == ArticleVaultOperationSchemas.Identity && identity.SchemaVersion == ArticleVaultOperationSchemas.Version
            && ArticleVaultAgentProtocol.IsIdentity(identity.SiteIdentity) && ArticleVaultAgentProtocol.IsIdentity(identity.VaultIdentity)
            && ArticleVaultAgentProtocol.IsIdentity(identity.DeviceIdentity) && ArticleVaultAgentProtocol.IsIdentity(identity.AgentIdentity)
            && ArticleVaultAgentProtocol.IsIdentity(identity.PlanReference) && identity.DeadlineUnixMs > 0
            && ArticleVaultAgentProtocol.IsDigest(identity.PlanSha256) && ArticleVaultAgentProtocol.IsDigest(identity.RequestSha256)
            && ArticleVaultAgentProtocol.IsDigest(identity.IdempotencySha256)
            && ArticleVaultAgentProtocol.IsDigest(reference.CheckpointSha256)
            && ArticleVaultAgentProtocol.IsDigest(identity.ContentSha256)
            && identity.ContentSha256 == ArticleVaultOperationCodec.ComputeContentSha256(identity)
            && identity.OperationIdentity == ArticleVaultOperationCodec.ComputeOperationIdentity(identity);
}
