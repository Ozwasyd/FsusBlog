using System.Text.Json;

using Microsoft.Extensions.Caching.Distributed;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record SecurityChallengeProtocolActivationRequest(
    string OperationId,
    string RequestFingerprint,
    string TargetFingerprint,
    string ReleaseId,
    string Slot,
    long Generation);

public sealed record SecurityChallengeProtocolActivationResult(
    string SchemaVersion,
    bool Accepted,
    string Status,
    string? ErrorCode,
    string OperationId,
    string ReleaseId,
    string Slot,
    long Generation,
    string? TargetFingerprint);

public interface ISecurityChallengeProtocolActivationGuard
{
    Task<bool> IsOpenAsync(CancellationToken cancellationToken = default);
    Task<SecurityChallengeProtocolActivationResult> ActivateAsync(
        SecurityChallengeProtocolActivationRequest request,
        CancellationToken cancellationToken = default);
}

public sealed class SecurityChallengeProtocolActivationGuard(
    IDistributedCache cache,
    IReleaseIdentityProvider releaseIdentityProvider,
    IWebHostEnvironment environment,
    IConfiguration configuration,
    ISecurityChallengeKindCutoverStore cutoverStore,
    IActiveReleaseFence activeReleaseFence) : ISecurityChallengeProtocolActivationGuard
{
    public const string ResultSchemaVersion = "fsus.security-challenge-protocol-activation.v1";
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
            SecurityChallengeProtocolActivationResult? marker = JsonSerializer.Deserialize<SecurityChallengeProtocolActivationResult>(encoded);
            if (marker is not { Accepted: true, Status: "open" }
                || marker.SchemaVersion != ResultSchemaVersion
                || marker.ReleaseId != _identity.ReleaseId
                || marker.Slot != _identity.ReleaseSlot
                || marker.Generation != _generation)
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

    public async Task<SecurityChallengeProtocolActivationResult> ActivateAsync(
        SecurityChallengeProtocolActivationRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.ReleaseId != _identity.ReleaseId || request.Slot != _identity.ReleaseSlot
            || request.Generation != _generation || request.Generation <= 0)
        {
            return Rejected(request, "runtime_identity_mismatch");
        }
        SecurityChallengeKindCutoverReceipt? receipt = await cutoverStore
            .ReadReceiptAsync(request.OperationId, cancellationToken).ConfigureAwait(false);
        if (receipt is not
            {
                Accepted: true,
                Status: "applied",
                DryRun: false,
                FenceVerifiedBefore: true,
                FenceVerifiedImmediatelyBeforeMutation: true,
                FenceVerifiedAfter: true
            }
            || receipt.ReleaseId != request.ReleaseId || receipt.Slot != request.Slot
            || receipt.Generation != request.Generation
            || receipt.OperationId != request.OperationId
            || receipt.RequestFingerprint != request.RequestFingerprint
            || receipt.TargetFingerprint != request.TargetFingerprint)
        {
            return Rejected(request, "cutover_receipt_not_verified");
        }
        ActiveReleaseFenceOperationResult fence = await activeReleaseFence.VerifyAsync(
            new(request.ReleaseId, request.Slot, request.Generation, RequireActive: true),
            cancellationToken).ConfigureAwait(false);
        if (!fence.Accepted)
        {
            return Rejected(request, "active_release_fence_mismatch");
        }
        var result = new SecurityChallengeProtocolActivationResult(
            ResultSchemaVersion, true, "open", null, request.OperationId,
            request.ReleaseId, request.Slot, request.Generation, receipt.TargetFingerprint);
        await cache.SetStringAsync(Key(), JsonSerializer.Serialize(result), new DistributedCacheEntryOptions(), cancellationToken)
            .ConfigureAwait(false);
        return result;
    }

    private string Key() => $"fsus:security:challenge-protocol-activation:{_identity.ReleaseId}:{_identity.ReleaseSlot}:{_generation}";

    private static SecurityChallengeProtocolActivationResult Rejected(
        SecurityChallengeProtocolActivationRequest request,
        string errorCode) => new(ResultSchemaVersion, false, "closed", errorCode,
            request.OperationId ?? string.Empty, request.ReleaseId ?? string.Empty,
            request.Slot ?? string.Empty, request.Generation, null);
}
