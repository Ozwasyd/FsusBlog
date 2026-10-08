using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Devices;

public enum GpuCompletion
{
    Pending,
    Complete,
    Uncertain
}

public sealed record GpuDeviceIdentity(string Backend, string NativeIdentity, string Name,
    int ApiVersion, bool SharesHostCapacity);

// INTEROP: A device address is opaque and never convertible to a CPU view.
public readonly record struct GpuDeviceAddress(ulong Value);
public readonly record struct GpuHostAddress(nint Value);
public readonly record struct GpuSubmission(nint Stream, nint Event);

/// <summary>Driver seam; implementations must not free uncertain submitted resources.</summary>
public interface IGpuDriverSession : IDisposable
{
    GpuDeviceIdentity Identity
    {
        get;
    }
    GpuDeviceAddress AllocateDevice(long bytes);
    void FreeDevice(GpuDeviceAddress address);
    GpuHostAddress AllocateHost(long bytes, bool cpuReadback);
    void FreeHost(GpuHostAddress address);
    void WriteHost(GpuHostAddress address, ReadOnlySpan<byte> source);
    void ReadHost(GpuHostAddress address, Span<byte> destination);
    // A throw may follow submission. The owner therefore quarantines all holds on a throw.
    GpuSubmission SubmitUpload(GpuHostAddress source, GpuDeviceAddress destination, long bytes);
    GpuSubmission SubmitReadback(GpuDeviceAddress source, GpuHostAddress destination, long bytes);
    GpuCompletion Query(GpuSubmission submission);
    void ReleaseSubmission(GpuSubmission submission);
}

/// <summary>Submission and release failures retain charges instead of guessing DMA stopped.</summary>
public sealed class GpuDriverException : Exception
{
    public GpuDriverException(string operation, int nativeCode)
        : base($"GPU operation {operation} failed with native status {nativeCode}.")
    {
        Operation = operation;
        NativeCode = nativeCode;
    }

    public string Operation
    {
        get;
    }
    public int NativeCode
    {
        get;
    }
}

/// <summary>A driver-confirmed allocation rejection that created no native resource.</summary>
public sealed class GpuAllocationRejectedException : Exception
{
    public GpuAllocationRejectedException() : base("The driver rejected allocation without creating a resource.")
    {
    }
}
