using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Control;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public enum PublicHotReadOwnershipReleaseDisposition
{
    FinalSharedHold
}

public enum PublicHotReadOwnershipReloadDisposition
{
    DrainBeforeApply
}

/// <summary>Bound by the existing PublicHotRead configuration section; no numerical defaults.</summary>
public sealed class PublicHotReadSnapshotOwnershipOptions
{
    public ulong? Revision
    {
        get; set;
    }
    public ulong? AccountingRevision
    {
        get; set;
    }
    public int? MaximumHolds
    {
        get; set;
    }
    public int? MaximumRepresentations
    {
        get; set;
    }
    public int? MaximumLeases
    {
        get; set;
    }
    public int? MaximumSnapshots
    {
        get; set;
    }
    public int? MaximumConsumers
    {
        get; set;
    }
    public long? MetadataUpperBoundBytes
    {
        get; set;
    }
    public long? MetadataCapacityBytes
    {
        get; set;
    }
    public long? MetadataHeadroomBytes
    {
        get; set;
    }
    public PublicHotReadOwnershipReleaseDisposition? ReleaseDisposition
    {
        get; set;
    }
    public PublicHotReadOwnershipReloadDisposition? ReloadDisposition
    {
        get; set;
    }
}

/// <summary>Immutable values supplied by the existing frozen baseline/policy owner, not configuration defaults.</summary>
public sealed record PublicHotReadSnapshotOwnershipLimits(ulong Revision, ulong AccountingRevision, int MaximumHolds,
    int MaximumRepresentations, int MaximumLeases, int MaximumSnapshots, int MaximumConsumers,
    long MetadataUpperBoundBytes, long MetadataCapacityBytes, long MetadataHeadroomBytes,
    PublicHotReadOwnershipReleaseDisposition ReleaseDisposition, PublicHotReadOwnershipReloadDisposition ReloadDisposition);

/// <summary>
/// Copies explicit frozen numerical inputs and real ledger domains. The supplied baseline
/// verifier owns qualification; this contract neither measures CLR sizes nor verifies receipts.
/// </summary>
public sealed class PublicHotReadSnapshotOwnershipPolicy
{
    private readonly MemoryReservationCoordinator _ledger;
    private readonly ResourceDomainId _metadataDomain;
    private readonly ResourceDomainId _operationDomain;

    private PublicHotReadSnapshotOwnershipPolicy(PublicHotReadSnapshotOwnershipLimits limits,
        MemoryReservationCoordinator ledger, ResourceDomainId metadataDomain, ResourceDomainId operationDomain,
        MemoryGovernorBaselineBinding baseline)
    {
        _ledger = ledger;
        _metadataDomain = metadataDomain;
        _operationDomain = operationDomain;
        Revision = limits.Revision;
        AccountingRevision = limits.AccountingRevision;
        MaximumHolds = limits.MaximumHolds;
        MaximumRepresentations = limits.MaximumRepresentations;
        MaximumLeases = limits.MaximumLeases;
        MaximumSnapshots = limits.MaximumSnapshots;
        MaximumConsumers = limits.MaximumConsumers;
        MetadataUpperBoundBytes = limits.MetadataUpperBoundBytes;
        MetadataCapacityBytes = limits.MetadataCapacityBytes;
        MetadataHeadroomBytes = limits.MetadataHeadroomBytes;
        Baseline = baseline;
    }

    public ulong Revision
    {
        get;
    }
    public ulong AccountingRevision
    {
        get;
    }
    public int MaximumHolds
    {
        get;
    }
    public int MaximumRepresentations
    {
        get;
    }
    public int MaximumLeases
    {
        get;
    }
    public int MaximumSnapshots
    {
        get;
    }
    public int MaximumConsumers
    {
        get;
    }
    public long MetadataUpperBoundBytes
    {
        get;
    }
    public long MetadataCapacityBytes
    {
        get;
    }
    public long MetadataHeadroomBytes
    {
        get;
    }
    public MemoryGovernorBaselineBinding Baseline
    {
        get;
    }

    public static MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicy> TryCreate(
        PublicHotReadOptions options, MemoryReservationCoordinator ledger,
        ResourceDomainId metadataDomain, ResourceDomainId operationDomain,
        MemoryGovernorBaselineBinding? baseline, PublicHotReadSnapshotOwnershipLimits? frozenLimits,
        string candidateCommit, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(ledger);
        if (options.SnapshotOwnership is not
            {
                Revision: { } revision, AccountingRevision: { } accountingRevision,
                MaximumHolds: { } maximumHolds, MaximumRepresentations: { } maximumRepresentations,
                MaximumLeases: { } maximumLeases, MaximumSnapshots: { } maximumSnapshots,
                MaximumConsumers: { } maximumConsumers, MetadataUpperBoundBytes: { } metadataUpperBoundBytes,
                MetadataCapacityBytes: { } metadataCapacityBytes, MetadataHeadroomBytes: { } metadataHeadroomBytes,
                ReleaseDisposition: { } releaseDisposition, ReloadDisposition: { } reloadDisposition
            }
            || frozenLimits is null || baseline is null || baseline.Qualification != MemoryQualification.Qualified
            || baseline.FrozenAt == default || baseline.FrozenAt > now
            || !MemoryGovernorPolicy.ValidDigest(candidateCommit, 40) || baseline.CandidateCommit != candidateCommit
            || !MemoryGovernorPolicy.ValidDigest(baseline.EvidenceDigest, 64)
            || string.IsNullOrWhiteSpace(baseline.EvidenceIdentity) || baseline.EvidenceIdentity.Length > 128)
        {
            return MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicy>.Reject(MemoryFailure.TierUnavailable);
        }
        if (revision == 0 || accountingRevision == 0 || maximumHolds <= 0
            || maximumRepresentations <= 0 || maximumLeases <= 0 || maximumSnapshots <= 0 || maximumConsumers <= 0
            || maximumLeases > maximumRepresentations || (long)maximumSnapshots + maximumConsumers > maximumHolds
            || metadataUpperBoundBytes <= 0 || metadataCapacityBytes <= 0 || metadataHeadroomBytes < 0
            || metadataUpperBoundBytes > metadataCapacityBytes - metadataHeadroomBytes
            || releaseDisposition != PublicHotReadOwnershipReleaseDisposition.FinalSharedHold
            || reloadDisposition != PublicHotReadOwnershipReloadDisposition.DrainBeforeApply)
        {
            return MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicy>.Reject(MemoryFailure.BoundsViolation);
        }
        var captured = new PublicHotReadSnapshotOwnershipLimits(revision, accountingRevision, maximumHolds,
            maximumRepresentations, maximumLeases, maximumSnapshots, maximumConsumers, metadataUpperBoundBytes,
            metadataCapacityBytes, metadataHeadroomBytes, releaseDisposition, reloadDisposition);
        if (captured != frozenLimits)
        {
            return MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicy>.Reject(MemoryFailure.TierUnavailable);
        }
        try
        {
            if (ledger.Topology.Unit(metadataDomain) != MemoryResourceUnit.Bytes
                || ledger.Topology.Unit(operationDomain) != MemoryResourceUnit.OperationSlots)
            {
                return MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicy>.Reject(MemoryFailure.BoundsViolation);
            }
        }
        catch (KeyNotFoundException)
        {
            return MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicy>.Reject(MemoryFailure.TierUnavailable);
        }
        if (ledger.Snapshot().PolicyRevision != accountingRevision)
        {
            return MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicy>.Reject(MemoryFailure.StaleLocation);
        }
        return MemoryOperationResult<PublicHotReadSnapshotOwnershipPolicy>.Success(
            new(captured, ledger, metadataDomain, operationDomain, baseline));
    }

    internal MemoryOperationResult<PublicHotReadSnapshotOwnershipAdmission> TryReserve(
        PublicHotReadSnapshot snapshot, int leases, DateTimeOffset now, Action released)
    {
        if (Baseline.FrozenAt > now)
        {
            return MemoryOperationResult<PublicHotReadSnapshotOwnershipAdmission>.Reject(MemoryFailure.TierUnavailable);
        }
        if (leases <= 0 || leases > MaximumLeases || RepresentationCount(snapshot) > MaximumRepresentations)
        {
            return MemoryOperationResult<PublicHotReadSnapshotOwnershipAdmission>.Reject(MemoryFailure.BudgetRejected);
        }
        MemoryAccountingSnapshot accounting = _ledger.Snapshot();
        if (accounting.PolicyRevision != AccountingRevision)
        {
            return MemoryOperationResult<PublicHotReadSnapshotOwnershipAdmission>.Reject(MemoryFailure.StaleLocation);
        }
        MemoryOperationResult<MemoryReservation> reservation = _ledger.TryReserveUnderBounds([
            new(_metadataDomain, MemoryResourceUnit.Bytes, MetadataUpperBoundBytes + MetadataHeadroomBytes),
            new(_operationDomain, MemoryResourceUnit.OperationSlots, MaximumHolds)
        ], accounting.EnforcedHardCaps, AccountingRevision);
        if (!reservation.Succeeded)
        {
            return MemoryOperationResult<PublicHotReadSnapshotOwnershipAdmission>.Reject(reservation.Failure!.Value);
        }
        try
        {
            return MemoryOperationResult<PublicHotReadSnapshotOwnershipAdmission>.Success(
                new(this, reservation.Value!, released));
        }
        catch
        {
            reservation.Value!.Dispose();
            throw;
        }
    }

    internal static long RepresentationCount(PublicHotReadSnapshot snapshot)
        => (long)snapshot.ArticleFrameCount + snapshot.ListFrameCount + snapshot.HtmlFrameCount
            + (snapshot.CategoryFrameReady ? 1 : 0) + (snapshot.TagFrameReady ? 1 : 0);
}

internal sealed class PublicHotReadSnapshotOwnershipAdmission(
    PublicHotReadSnapshotOwnershipPolicy policy, MemoryReservation reservation, Action released) : IDisposable
{
    private MemoryReservation? _reservation = reservation;
    private bool _transferred;
    internal PublicHotReadSnapshotOwnershipPolicy Policy => policy;

    internal void TransferToGroup() => _transferred = true;
    internal void DisposeUntransferred()
    {
        if (!_transferred)
        {
            Dispose();
        }
    }

    public void Dispose()
    {
        MemoryReservation? held = Interlocked.Exchange(ref _reservation, null);
        if (held is not null)
        {
            held.Dispose();
            released();
        }
    }
}

public sealed record PublicHotReadSnapshotOwnershipPolicyUpdate(ulong Revision, bool Draining);
