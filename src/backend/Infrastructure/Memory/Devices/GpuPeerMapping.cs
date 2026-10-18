using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Devices;

/// <summary>Opaque driver mapping identity. It has no CPU pointer conversion.</summary>
public readonly record struct GpuDriverMapping(ulong Token);

public enum GpuMappedAccess
{
    ReadOnly
}

public sealed record GpuMappingSynchronization(
    string DriverApi,
    int ApiVersion,
    MemoryLocationToken Location,
    ulong Sequence,
    bool Completed);

/// <summary>A version-bound supported driver API; reads must obey its mapped access/coherency rules.</summary>
public interface IGpuMappedDriverApi
{
    IGpuDriverSession Session
    {
        get;
    }
    string DriverApi
    {
        get;
    }
    int ApiVersion
    {
        get;
    }
    GpuMappingCoherency Coherency
    {
        get;
    }
    GpuDriverMapping Map(IGpuPeerAllocationHold allocation, long offset, long length);
    GpuMappingSynchronization SynchronizeForRead(GpuDriverMapping mapping, MemoryLocationToken location);
    void Read(GpuDriverMapping mapping, long relativeOffset, Span<byte> destination);
    void Unmap(GpuDriverMapping mapping);
}

/// <summary>Explicit mapped-device reads retain the allocation/epoch until the final consumer drains.</summary>
public sealed class GpuMappedReadLease : IDisposable
{
    private readonly object _gate = new();
    private readonly IGpuMappedDriverApi _driver;
    private readonly IGpuPeerAllocationHold _allocation;
    private GpuDriverMapping _mapping;
    private int _consumers;
    private bool _draining;
    private bool _released;
    private bool _quarantined;
    private ulong _lastSynchronization;

    private GpuMappedReadLease(IGpuMappedDriverApi driver, IGpuPeerAllocationHold allocation, long offset, long length,
        int maximumConsumers)
    {
        _driver = driver;
        _allocation = allocation;
        Offset = offset;
        Length = length;
        MaximumConsumers = maximumConsumers;
        Location = allocation.Location;
        DriverApi = driver.DriverApi;
        ApiVersion = driver.ApiVersion;
        Coherency = driver.Coherency;
        DeviceIdentity = allocation.Session.Identity;
    }

    public MemoryLocationToken Location
    {
        get;
    }
    public long Offset
    {
        get;
    }
    public long Length
    {
        get;
    }
    public int MaximumConsumers
    {
        get;
    }
    public GpuMappedAccess Access => GpuMappedAccess.ReadOnly;
    public string DriverApi
    {
        get;
    }
    public int ApiVersion
    {
        get;
    }
    public GpuMappingCoherency Coherency
    {
        get;
    }
    public GpuDeviceIdentity DeviceIdentity
    {
        get;
    }
    public bool IsQuarantined
    {
        get
        {
            lock (_gate)
            {
                return _quarantined;
            }
        }
    }
    public Exception? DriverFailure
    {
        get; private set;
    }
    public GpuMappingSynchronization? Synchronization
    {
        get; private set;
    }

    /// <summary>Transfers the allocation hold. A possibly submitted failed map retains it in quarantine.</summary>
    public static GpuMappedReadLease Map(IGpuMappedDriverApi driver, IGpuPeerAllocationHold allocation,
        long offset, long length, int maximumConsumers)
    {
        ArgumentNullException.ThrowIfNull(driver);
        ArgumentNullException.ThrowIfNull(allocation);
        try
        {
            allocation.Location.Validate();
            allocation.Content.Validate();
            if (allocation.Access != GpuPeerAllocationAccess.Read)
            {
                throw new InvalidOperationException("Mapped reads require a readable allocation hold.");
            }
            if (!allocation.IsCurrent)
            {
                throw new InvalidOperationException("Mapping allocation epoch/location is stale.");
            }
            if (!allocation.CanSubmit)
            {
                throw new InvalidOperationException("Mapping allocation owner has stopped new submissions.");
            }
            if (!ReferenceEquals(driver.Session, allocation.Session)
                || driver.ApiVersion <= 0 || driver.ApiVersion != allocation.Session.Identity.ApiVersion
                || string.IsNullOrWhiteSpace(driver.DriverApi))
            {
                throw new InvalidOperationException("Mapping API version does not match the allocation session.");
            }
            if (driver.Coherency is not (GpuMappingCoherency.DriverSynchronized or GpuMappingCoherency.Coherent))
            {
                throw new InvalidOperationException("Mapping coherency is not known.");
            }
            if (offset < 0 || length <= 0 || offset > allocation.Length || length > allocation.Length - offset)
            {
                throw new ArgumentOutOfRangeException(nameof(length));
            }
            if (maximumConsumers <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(maximumConsumers));
            }
        }
        catch
        {
            allocation.Dispose();
            throw;
        }
        var lease = new GpuMappedReadLease(driver, allocation, offset, length, maximumConsumers);
        try
        {
            lease._mapping = driver.Map(allocation, offset, length);
            if (lease._mapping.Token == 0)
            {
                throw new InvalidOperationException("Driver mapping identity is invalid.");
            }
        }
        catch (Exception exception)
        {
            lease._quarantined = true;
            lease.DriverFailure = exception;
        }
        return lease;
    }

    public MemoryOperationResult<GpuMappedReadConsumer> TryAcquireConsumer()
    {
        lock (_gate)
        {
            if (_quarantined)
            {
                return MemoryOperationResult<GpuMappedReadConsumer>.Reject(MemoryFailure.DeviceLost);
            }
            if (!IsCurrent())
            {
                return MemoryOperationResult<GpuMappedReadConsumer>.Reject(MemoryFailure.StaleLocation);
            }
            if (_draining || _released || !_allocation.CanSubmit)
            {
                return MemoryOperationResult<GpuMappedReadConsumer>.Reject(MemoryFailure.TierUnavailable);
            }
            if (_consumers >= MaximumConsumers)
            {
                return MemoryOperationResult<GpuMappedReadConsumer>.Reject(MemoryFailure.BudgetRejected);
            }
            checked
            {
                _consumers++;
            }
            return MemoryOperationResult<GpuMappedReadConsumer>.Success(new(this));
        }
    }

    internal MemoryFailure? Read(GpuMappedReadConsumer consumer, long relativeOffset, Span<byte> destination)
    {
        lock (_gate)
        {
            if (consumer.IsDisposed || _released)
            {
                return MemoryFailure.OwnershipViolation;
            }
            if (_quarantined)
            {
                return MemoryFailure.DeviceLost;
            }
            if (!IsCurrent())
            {
                return MemoryFailure.StaleLocation;
            }
            if (relativeOffset < 0 || relativeOffset > Length || destination.Length > Length - relativeOffset)
            {
                return MemoryFailure.BoundsViolation;
            }
            try
            {
                GpuMappingSynchronization synchronization = _driver.SynchronizeForRead(_mapping, Location);
                if (synchronization.Location != Location || synchronization.DriverApi != DriverApi
                    || synchronization.ApiVersion != ApiVersion || !synchronization.Completed
                    || synchronization.Sequence == 0 || synchronization.Sequence < _lastSynchronization)
                {
                    _quarantined = true;
                    return MemoryFailure.OwnershipViolation;
                }
                Synchronization = synchronization;
                _lastSynchronization = synchronization.Sequence;
                if (!IsCurrent())
                {
                    return MemoryFailure.StaleLocation;
                }
                _driver.Read(_mapping, relativeOffset, destination);
                return IsCurrent() ? null : MemoryFailure.StaleLocation;
            }
            catch (Exception exception)
            {
                _quarantined = true;
                DriverFailure = exception;
                return MemoryFailure.DeviceLost;
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _draining = true;
            TryUnmap();
        }
    }

    internal void ReleaseConsumer(GpuMappedReadConsumer consumer)
    {
        lock (_gate)
        {
            if (!consumer.MarkDisposed())
            {
                return;
            }
            _consumers--;
            TryUnmap();
        }
    }

    private void TryUnmap()
    {
        if (!_draining || _consumers != 0 || _released || _quarantined)
        {
            return;
        }
        try
        {
            _driver.Unmap(_mapping);
        }
        catch (Exception exception)
        {
            _quarantined = true;
            DriverFailure = exception;
            return;
        }
        _released = true;
        _allocation.Dispose();
    }

    private bool IsCurrent()
        => _allocation.IsCurrent && ReferenceEquals(_driver.Session, _allocation.Session)
            && _allocation.Session.Identity == DeviceIdentity && _driver.DriverApi == DriverApi
            && _driver.ApiVersion == ApiVersion && _driver.Coherency == Coherency;
}

/// <summary>Mapped access remains explicit and exposes neither Memory nor a CPU-dereferenceable address.</summary>
public sealed class GpuMappedReadConsumer : IDisposable
{
    private readonly GpuMappedReadLease _owner;
    internal bool IsDisposed
    {
        get; private set;
    }

    internal GpuMappedReadConsumer(GpuMappedReadLease owner) => _owner = owner;
    public MemoryFailure? Read(long relativeOffset, Span<byte> destination) => _owner.Read(this, relativeOffset, destination);
    public void Dispose() => _owner.ReleaseConsumer(this);
    internal bool MarkDisposed()
    {
        if (IsDisposed)
        {
            return false;
        }
        IsDisposed = true;
        return true;
    }
}
