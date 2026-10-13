using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Infrastructure.Memory.Disk;

/// <summary>
/// Boundary for a dedicated root selected and provisioned by the existing storage owner.
/// Disabled does not open, create, enumerate, or probe a root. Native qualification remains
/// the capability owner's responsibility; opening this boundary does not qualify a backend.
/// </summary>
public sealed class OwnedSpillRoot : IDisposable
{
    private readonly LinuxOwnedSpillDirectory _directory;
    private readonly Guid _owner;

    public OwnedSpillRoot(string ownerSelectedRoot, Guid owner, MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        MemoryCapabilityPolicy.Validate(mode);
        if (mode == MemoryCapabilityMode.Disabled)
        {
            throw new InvalidOperationException("Disk capability is Disabled.");
        }
        if (owner == Guid.Empty)
        {
            throw new ArgumentException("Storage owner identity is required.", nameof(owner));
        }
        _owner = owner;
        _directory = new(ownerSelectedRoot);
    }

    public void Validate() => _directory.Validate();

    public string NewName(string extension)
    {
        if (extension is not ("stage" or "segment"))
        {
            throw new ArgumentException("Only private segment namespaces are accepted.", nameof(extension));
        }
        return $"mem-{_owner:N}-{Guid.NewGuid():N}.{extension}";
    }

    public FileStream CreateFile(string ownerGeneratedName)
    {
        ValidateName(ownerGeneratedName);
        return _directory.Create(ownerGeneratedName);
    }

    internal FileStream CreateFile(string ownerGeneratedName, Action onCreated)
    {
        ArgumentNullException.ThrowIfNull(onCreated);
        ValidateName(ownerGeneratedName);
        return _directory.Create(ownerGeneratedName, onCreated);
    }

    public FileStream OpenRead(string name)
    {
        ValidateName(name);
        return _directory.Read(name);
    }

    public IEnumerable<string> EnumerateNames(int maximumExaminedEntries)
        => _directory.EnumerateNames(maximumExaminedEntries).Where(IsOwnerName);

    public void Rename(string source, string destination)
    {
        ValidateName(source);
        ValidateName(destination);
        _directory.Rename(source, destination);
    }

    internal void Rename(string source, string destination, DiskFileFootprint expected)
    {
        ArgumentNullException.ThrowIfNull(expected);
        ValidateName(source);
        ValidateName(destination);
        _directory.Rename(source, destination, expected);
    }

    public void Delete(string name)
    {
        ValidateName(name);
        _directory.Delete(name);
    }

    internal void Delete(string name, DiskFileFootprint expected)
    {
        ArgumentNullException.ThrowIfNull(expected);
        ValidateName(name);
        _directory.Delete(name, expected);
    }

    public DiskFileFootprint ObserveRootFootprint(TimeProvider? timeProvider = null)
        => _directory.ObserveRootFootprint(timeProvider ?? TimeProvider.System);

    public DiskFileFootprint ObserveFileFootprint(string name, TimeProvider? timeProvider = null)
    {
        ValidateName(name);
        return _directory.ObserveFileFootprint(name, timeProvider ?? TimeProvider.System);
    }

    internal DiskFileFootprint ObserveFileFootprint(FileStream file)
        => _directory.ObserveFileFootprint(file, TimeProvider.System);

    /// <summary>Samples the descriptor's actual device. Quota scope is supplied by its owner.</summary>
    public DiskCapacityObservation Observe(ResourceDomainId capacityDomain, ResourceDomainId inodeDomain,
        MemoryResourceObservation quotaBytes, TimeSpan validity, ulong policyRevision, TimeProvider? timeProvider = null)
    {
        if (validity <= TimeSpan.Zero || policyRevision == 0 || quotaBytes.Domain != capacityDomain
            || quotaBytes.Unit != MemoryResourceUnit.Bytes)
        {
            throw new ArgumentException("Observation requires finite validity and matching owner quota scope.");
        }
        LinuxDiskSample sample = _directory.Sample();
        DateTimeOffset sampledAt = (timeProvider ?? TimeProvider.System).GetUtcNow();
        MemoryObservationState state = sample.ReadOnly ? MemoryObservationState.Denied : MemoryObservationState.Available;
        var bytes = new MemoryResourceObservation(capacityDomain, MemoryResourceUnit.Bytes, state,
            sample.ReadOnly ? null : sample.AvailableBytes, "linux:fstatvfs:descriptor", sampledAt);
        MemoryObservationState inodeState = sample.ReadOnly ? MemoryObservationState.Denied
            : sample.AvailableInodes is null ? MemoryObservationState.Unknown : MemoryObservationState.Available;
        var inodes = new MemoryResourceObservation(inodeDomain, MemoryResourceUnit.OperationSlots, inodeState,
            sample.ReadOnly ? null : sample.AvailableInodes, "linux:fstatvfs:descriptor:inodes", sampledAt);
        return new(sample.CapacityIdentity, bytes, quotaBytes, inodes, sample.Backing,
            (quotaBytes.SampledAt < sampledAt ? quotaBytes.SampledAt : sampledAt) + validity, policyRevision);
    }

    public void Dispose() => _directory.Dispose();

    private bool IsOwnerName(string name)
    {
        string prefix = $"mem-{_owner:N}-";
        if (!name.StartsWith(prefix, StringComparison.Ordinal))
        {
            return false;
        }
        ReadOnlySpan<char> remainder = name.AsSpan(prefix.Length);
        int dot = remainder.IndexOf('.');
        return dot == 32 && Guid.TryParseExact(remainder[..dot], "N", out _)
            && (remainder[(dot + 1)..].SequenceEqual("stage") || remainder[(dot + 1)..].SequenceEqual("segment"));
    }

    private void ValidateName(string name)
    {
        if (name is null || !IsOwnerName(name))
        {
            throw new ArgumentException("Spill names are opaque owner IDs, never user paths.", nameof(name));
        }
    }
}
