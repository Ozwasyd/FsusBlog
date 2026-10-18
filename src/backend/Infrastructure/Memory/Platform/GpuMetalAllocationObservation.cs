using FsusBlog.Server.Infrastructure.Memory.Devices;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

/// <summary>Reports Metal's actual resource allocation size without granting or changing a common reservation.</summary>
public interface IGpuMetalAllocationObservation
{
    /// <summary>Queries an owned private resource's allocatedSize; null means no usable positive native signal.</summary>
    ulong? ObservedDeviceCapacity(GpuDeviceAddress address);

    /// <summary>Queries an owned shared resource's allocatedSize; null means no usable positive native signal.</summary>
    ulong? ObservedHostCapacity(GpuHostAddress address);
}
