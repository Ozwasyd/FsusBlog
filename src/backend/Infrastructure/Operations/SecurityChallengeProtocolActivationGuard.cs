using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Caching.Distributed;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record PerceptionCharacterV3ActivationMarker(
    string SchemaVersion,
    bool Accepted,
    string Status,
    string OperationId,
    string ReceiptFingerprint,
    string ReleaseId,
    string Slot,
    long Generation,
    string ContractDigest,
    string PoolGeneration,
    string PoolManifestDigest,
    string BackendAedsSchemaFingerprint,
    string SharedAedsSchemaFingerprint,
    string FrontendAedsSchemaFingerprint,
    string PolicySnapshotVersion,
    string TargetFingerprint);

public interface ISecurityChallengeProtocolActivationGuard : IPerceptionCharacterV3ActivationGate
{
}

public sealed class SecurityChallengeProtocolActivationGuard(
    IDistributedCache cache,
    IReleaseIdentityProvider releaseIdentityProvider,
    IWebHostEnvironment environment,
    IConfiguration configuration,
    IPerceptionCharacterV3CutoverStore cutoverStore,
    IPerceptionCharacterV3ArtifactPool artifactPool,
    ISecurityRiskPolicyProvider policyProvider,
    IActiveReleaseFence activeReleaseFence) : ISecurityChallengeProtocolActivationGuard
{
    public const string MarkerSchemaVersion = "fsus.security.perception-character-v3-activation.v1";
    private readonly ReleaseIdentitySnapshot _identity = releaseIdentityProvider.Current;
    private readonly long _generation = configuration.GetValue<long?>("FSUSBLOG_DEPLOYMENT_GENERATION")
        ?? configuration.GetValue<long?>("Deployment:Generation")
        ?? 0;

    public async Task<bool> IsOpenAsync(CancellationToken cancellationToken = default)
    {
        if (_identity.ReleaseSlot is not ("blue" or "green"))
        {
            return environment.IsDevelopment() || environment.IsEnvironment("Testing");
        }
        if (_generation <= 0)
        {
            return false;
        }
        try
        {
            string? encoded = await cache.GetStringAsync(Key(), cancellationToken).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(encoded))
            {
                return false;
            }
            PerceptionCharacterV3ActivationMarker? marker =
                JsonSerializer.Deserialize<PerceptionCharacterV3ActivationMarker>(encoded);
            if (marker is not { Accepted: true, Status: "open" }
                || marker.SchemaVersion != MarkerSchemaVersion
                || marker.ReleaseId != _identity.ReleaseId
                || marker.Slot != _identity.ReleaseSlot
                || marker.Generation != _generation
                || !FixedEquals(marker.ContractDigest, PerceptionCharacterV3ReleaseTarget.ContractDigest)
                || !FixedEquals(marker.BackendAedsSchemaFingerprint, PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint)
                || !FixedEquals(marker.SharedAedsSchemaFingerprint, PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint)
                || !FixedEquals(marker.FrontendAedsSchemaFingerprint, PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint))
            {
                return false;
            }

            PerceptionCharacterV3CutoverReceipt? receipt = await cutoverStore
                .ReadReceiptAsync(marker.OperationId, cancellationToken)
                .ConfigureAwait(false);
            if (receipt is not { Accepted: true, Status: "activated", DryRun: false }
                || !FixedEquals(receipt.ReceiptFingerprint, marker.ReceiptFingerprint)
                || !FixedEquals(receipt.TargetFingerprint, marker.TargetFingerprint))
            {
                return false;
            }
            PerceptionCharacterV3PoolIdentity pool = await artifactPool
                .GetIdentityAsync(cancellationToken)
                .ConfigureAwait(false);
            if (!FixedEquals(pool.GenerationId, marker.PoolGeneration)
                || !FixedEquals(pool.ManifestDigest, marker.PoolManifestDigest)
                || !FixedEquals(pool.ContractDigest, marker.ContractDigest)
                || !FixedEquals(policyProvider.CurrentRiskPolicy.PolicyVersion, marker.PolicySnapshotVersion))
            {
                return false;
            }
            ActiveReleaseFenceOperationResult fence = await activeReleaseFence.VerifyAsync(
                new(marker.ReleaseId, marker.Slot, marker.Generation, RequireActive: true),
                cancellationToken).ConfigureAwait(false);
            return fence.Accepted;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception)
        {
            return false;
        }
    }

    public Task CloseAsync(CancellationToken cancellationToken = default)
        => cache.RemoveAsync(Key(), cancellationToken);

    public async Task OpenAsync(
        PerceptionCharacterV3CutoverReceipt receipt,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        if (receipt is not { Accepted: true, Status: "activated", DryRun: false }
            || receipt.ReleaseId != _identity.ReleaseId
            || receipt.Slot != _identity.ReleaseSlot
            || receipt.Generation != _generation
            || receipt.Generation <= 0
            || !FixedEquals(receipt.ContractDigest, PerceptionCharacterV3ReleaseTarget.ContractDigest)
            || !FixedEquals(receipt.BackendAedsSchemaFingerprint, PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint)
            || !FixedEquals(receipt.SharedAedsSchemaFingerprint, PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint)
            || !FixedEquals(receipt.FrontendAedsSchemaFingerprint, PerceptionCharacterV3ReleaseTarget.AedsSchemaFingerprint))
        {
            throw new InvalidOperationException("The V3 cutover receipt does not match the current runtime.");
        }
        PerceptionCharacterV3CutoverReceipt? stored = await cutoverStore
            .ReadReceiptAsync(receipt.OperationId, cancellationToken)
            .ConfigureAwait(false);
        if (stored is null
            || !FixedEquals(stored.ReceiptFingerprint, receipt.ReceiptFingerprint)
            || !FixedEquals(stored.RequestFingerprint, receipt.RequestFingerprint))
        {
            throw new InvalidOperationException("The V3 cutover receipt is not durably verified.");
        }
        ActiveReleaseFenceOperationResult fence = await activeReleaseFence.VerifyAsync(
            new(receipt.ReleaseId, receipt.Slot, receipt.Generation, RequireActive: true),
            cancellationToken).ConfigureAwait(false);
        if (!fence.Accepted)
        {
            throw new InvalidOperationException("The active release fence changed before V3 activation.");
        }
        var marker = new PerceptionCharacterV3ActivationMarker(
            MarkerSchemaVersion,
            true,
            "open",
            receipt.OperationId,
            receipt.ReceiptFingerprint,
            receipt.ReleaseId,
            receipt.Slot,
            receipt.Generation,
            receipt.ContractDigest,
            receipt.PoolGeneration,
            receipt.PoolManifestDigest,
            receipt.BackendAedsSchemaFingerprint,
            receipt.SharedAedsSchemaFingerprint,
            receipt.FrontendAedsSchemaFingerprint,
            receipt.PolicySnapshotVersion,
            receipt.TargetFingerprint);
        await cache.SetStringAsync(
            Key(),
            JsonSerializer.Serialize(marker),
            new DistributedCacheEntryOptions(),
            cancellationToken).ConfigureAwait(false);
    }

    private string Key()
        => $"fsus:security:perception-character-v3-activation:{_identity.ReleaseId}:{_identity.ReleaseSlot}:{_generation}";

    private static bool FixedEquals(string left, string right)
    {
        byte[] a = Encoding.UTF8.GetBytes(left ?? string.Empty);
        byte[] b = Encoding.UTF8.GetBytes(right ?? string.Empty);
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }
}
