using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Devices;

/// <summary>One device allocation owner; no direct CPU view is exposed.</summary>
public sealed class GpuAllocation : IDisposable
{
    private readonly GpuMemoryDevice _owner;

    internal GpuAllocation(GpuMemoryDevice owner, MemoryContentIdentity content, MemoryLocationToken location,
        GpuDeviceAddress address, long length, IMemoryAllocationCharge? charge, IMemoryReservation? unconverted)
    {
        _owner = owner;
        Content = content;
        Location = location;
        Address = address;
        Length = length;
        Charge = charge;
        Unconverted = unconverted;
    }

    public MemoryContentIdentity Content
    {
        get;
    }
    public MemoryLocationToken Location
    {
        get;
    }
    public long Length
    {
        get;
    }
    public bool IsCurrent => _owner.IsCurrent(this);
    internal GpuDeviceAddress Address
    {
        get;
    }
    internal IGpuDriverSession Driver => _owner.Driver;
    internal Accounting.MemoryReservationCoordinator Ledger => _owner.Ledger;
    internal ResourceDomainId TransferDomain => _owner.TransferDomain;
    internal void InvalidateOwner() => _owner.InvalidateEpoch();
    internal IMemoryAllocationCharge? Charge
    {
        get;
    }
    internal IMemoryReservation? Unconverted
    {
        get;
    }
    internal int Holds
    {
        get; set;
    }
    internal bool Retiring
    {
        get; set;
    }
    internal bool UploadSubmitted
    {
        get; set;
    }
    internal bool Initialized
    {
        get; set;
    }

    public MemoryOperationResult<IGpuPeerAllocationHold> TryAcquirePeerHold(MemoryLocationToken expected)
        => _owner.TryRetain(this, expected);

    public void Dispose() => _owner.Retire(this);
}

internal sealed class GpuAllocationHold(GpuMemoryDevice owner, GpuAllocation allocation, GpuPeerAllocationAccess access) : IGpuPeerAllocationHold
{
    private GpuMemoryDevice? _owner = owner;
    public MemoryLocationToken Location => allocation.Location;
    public MemoryContentIdentity Content => allocation.Content;
    public GpuPeerAllocationAccess Access => access;
    public GpuDeviceAddress Address => allocation.Address;
    public IGpuDriverSession Session => allocation.Driver;
    public long Length => allocation.Length;
    public bool IsCurrent => _owner is not null && allocation.IsCurrent;
    public bool CanSubmit => _owner is not null && _owner.CanSubmit(allocation);

    public void Dispose() => Interlocked.Exchange(ref _owner, null)?.ReleaseHold(allocation, access == GpuPeerAllocationAccess.Read);
}
