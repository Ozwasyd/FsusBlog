using System.Collections.Immutable;

using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>Original launch providers only; their existence does not attest startup, Track or readiness.</summary>
public sealed class AuthoringProductionRuntimeProviders
{
    internal AuthoringProductionRuntimeProviders(
        LinuxBubblewrapAuthoringWorkerRuntime? worker,
        LinuxBubblewrapAuthoringServiceRuntime? service)
    {
        Worker = worker;
        Service = service;
    }

    public IAuthoringWorkerSandboxRuntime? Worker { get; }

    public IAuthoringServiceProcessRuntime? Service { get; }
}

/// <summary>
/// Explicit host composition for development. This does not register a production
/// route, initialize state, mint consent, or manufacture lifecycle generations.
/// The original coordinator owns every receipt and Resources owns every Track call.
/// </summary>
public sealed class AuthoringExtensionProductionComposition
{
    public AuthoringExtensionProductionComposition(
        LocalAuthoringPackageRuntime packages,
        IAuthoringCapabilityGrantCatalog grants,
        IAuthoringFencedExtensionStateStore stateStore,
        IAuthoringLifecycleReceiptStore receipts,
        TimeProvider timeProvider,
        AuthoringHostPlatform platform,
        AuthoringStateScope scope,
        string purpose,
        AuthoringCoreAuthorityRegistry coreAuthorities,
        ImmutableHashSet<string> coreOrUserShortcuts,
        IAuthorSavedViewQueryValidator queryValidator,
        LinuxBubblewrapWorkerOptions? workerOptions = null,
        LinuxBubblewrapServiceOptions? serviceOptions = null,
        AuthoringExtensionApprovalAuthority? approvalAuthority = null,
        AuthoringExtensionApprovalAuthority.ApprovedClaim? approvedClaim = null)
    {
        ArgumentNullException.ThrowIfNull(packages);
        ArgumentNullException.ThrowIfNull(grants);
        ArgumentNullException.ThrowIfNull(stateStore);
        ArgumentNullException.ThrowIfNull(receipts);
        ArgumentNullException.ThrowIfNull(timeProvider);
        LinuxBubblewrapAuthoringWorkerRuntime? worker = null;
        LinuxBubblewrapAuthoringServiceRuntime? service = null;
        if (OperatingSystem.IsLinux() && platform == AuthoringHostPlatform.ServerLinux)
        {
            worker = workerOptions is null ? null : new LinuxBubblewrapAuthoringWorkerRuntime(workerOptions);
            service = serviceOptions is null ? null : new LinuxBubblewrapAuthoringServiceRuntime(serviceOptions);
        }
        Providers = new(worker, service);
        ApprovalClaim = approvedClaim;
        Approvals = approvalAuthority;
        Preflight = new(packages, grants, stateStore, receipts, timeProvider, platform, scope, purpose, Providers,
            approvalAuthority, approvedClaim);
        HostResources = new(Preflight, grants, coreAuthorities, coreOrUserShortcuts, queryValidator);
        Resources = new(HostResources);
        Coordinator = new(Resources, Preflight, stateStore, receipts, grants);
    }

    public AuthoringExtensionProductionPreflight Preflight { get; }

    public AuthoringExtensionApprovalAuthority.ApprovedClaim? ApprovalClaim { get; }

    public IAuthoringExtensionApprovalAuthority? Approvals { get; }

    public AuthoringExtensionOperationContext? OperationContext => ApprovalClaim?.OperationContext;

    public AuthoringProductionRuntimeProviders Providers { get; }

    public AuthoringExtensionHostResourceAuthority HostResources { get; }

    public AuthoringExtensionLifecycleResources Resources { get; }

    public AuthoringExtensionLifecycleCoordinator Coordinator { get; }

    /// <summary>
    /// Binds the original issuer's actual claimed state operation. Scope and actor
    /// context come exclusively from that claim; no admin-ID/user-ID mapping,
    /// approval policy or ScopeDigest encoding is introduced by this consumer.
    /// Runtime staging and common publication remain unqualified and closed.
    /// </summary>
    public static AuthoringExtensionProductionComposition ForApprovedOperation(
        LocalAuthoringPackageRuntime packages,
        IAuthoringCapabilityGrantCatalog grants,
        IAuthoringFencedExtensionStateStore stateStore,
        IAuthoringLifecycleReceiptStore receipts,
        TimeProvider timeProvider,
        AuthoringHostPlatform platform,
        IAuthoringExtensionApprovalAuthority approvals,
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim,
        string grantPurpose,
        AuthoringCoreAuthorityRegistry coreAuthorities,
        ImmutableHashSet<string> coreOrUserShortcuts,
        IAuthorSavedViewQueryValidator queryValidator,
        LinuxBubblewrapWorkerOptions? workerOptions = null,
        LinuxBubblewrapServiceOptions? serviceOptions = null)
    {
        ArgumentNullException.ThrowIfNull(claim);
        // The interface has no current-claim read port. Consume the real issuer's
        // SQL-backed ReadAsync rather than substitute caller-supplied claim facts.
        if (approvals is not AuthoringExtensionApprovalAuthority issuer)
        {
            throw new AuthoringExtensionContractException("production_approval_read_owner_missing");
        }
        return new(packages, grants, stateStore, receipts, timeProvider, platform,
            AuthoringExtensionProductionPreflight.ScopeFor(claim), grantPurpose,
            coreAuthorities, coreOrUserShortcuts, queryValidator, workerOptions, serviceOptions, issuer, claim);
    }

    /// <summary>
    /// Observes only an original native worker capability and retained descriptor.
    /// A live observation still cannot attest membership in Resources or a Running receipt.
    /// </summary>
    public static AuthoringWorkerLaunchDescriptor ObserveWorker(
        IAuthoringWorkerSandboxInstance actualOwner)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new AuthoringExtensionContractException("production_platform_unsupported");
        }
        AuthoringExtensionProductionPreflight.Require(
            AuthoringRuntimeIncarnationLease.TryObserveWorker(actualOwner, out AuthoringRuntimeIncarnationLease? lease),
            "production_native_worker_lease_missing");
        AuthoringWorkerLaunchDescriptor descriptor = lease!.GetWorkerDescriptor(actualOwner);
        AuthoringExtensionProductionPreflight.Require(lease.IsCurrentOwner(actualOwner), "production_native_worker_lease_stale");
        return descriptor;
    }

    /// <summary>Reads real service custody; health flags and scalar runtime identities cannot issue a lease.</summary>
    public static async ValueTask<AuthoringServiceLaunchDescriptor> ObserveServiceAsync(
        IAuthoringServiceProcess actualOwner,
        CancellationToken cancellationToken = default)
    {
        using var operation = AuthoringExtensionProductionPreflight.BoundOperation(cancellationToken);
        cancellationToken = operation.Token;
        if (!OperatingSystem.IsLinux())
        {
            throw new AuthoringExtensionContractException("production_platform_unsupported");
        }
        AuthoringExtensionProductionPreflight.Require(
            AuthoringRuntimeIncarnationLease.TryObserveService(actualOwner, out AuthoringRuntimeIncarnationLease? lease),
            "production_native_service_lease_missing");
        AuthoringServiceLaunchDescriptor descriptor = lease!.GetServiceDescriptor(actualOwner);
        AuthoringServiceHealthReport health = await actualOwner.GetHealthAsync(cancellationToken).ConfigureAwait(false);
        AuthoringExtensionProductionPreflight.Require(health.ProtocolHandshakeComplete
            && health.RuntimeIdentity == descriptor.RuntimeIdentity && health.ExecutableSha256 == descriptor.ExecutableSha256
            && health.TransportSchemaReference == descriptor.TransportSchemaReference && lease.IsCurrentOwner(actualOwner),
            "production_native_service_readiness_drift");
        return descriptor;
    }
}
