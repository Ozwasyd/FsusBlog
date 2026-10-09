using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

public enum MacOsMemoryMetric
{
    HostPhysicalTotalBytes, HostSwapTotalBytes, HostSwapAvailableBytes, HostSwapUsedBytes
}

public enum MacOsMemoryScope
{
    HostPhysical, HostSwap
}

/// <summary>One raw host observation; swap occupancy is not process usage or qualified headroom.</summary>
public readonly record struct MacOsSysctlMemoryObservation(MacOsMemoryMetric Metric, MacOsMemoryScope Scope,
    string Source, MemoryObservationState State, long? Value, MemoryFailure? Failure,
    int? NativeError, DateTimeOffset? SampledAt)
{
    public MemoryResourceUnit Unit => MemoryResourceUnit.Bytes;
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

/// <summary>Capture metadata does not establish successful values or target platform qualification.</summary>
public readonly record struct MacOsSysctlMemoryCapture(MemoryCapabilityMode Mode, bool Captured,
    MemoryFailure? Failure, int NativeCallAttempts, Architecture Architecture)
{
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

/// <summary>
/// Reads only hw.memsize and vm.swapusage into caller-owned admitted storage.
/// The existing background owner retains resource admission, clock selection,
/// scheduling, resource identity and qualification. No capacity policy is inferred.
/// </summary>
public static class MacOsSysctlMemoryReader
{
    public const int ObservationCount = 4;
    private const string PhysicalKey = "hw.memsize";
    private const string SwapKey = "vm.swapusage";
    private const nuint PhysicalSize = 8;
    private const nuint SwapSize = 32;

    /// <summary>Disabled and unsupported targets refuse capture before clock or native calls.</summary>
    public static MacOsSysctlMemoryCapture Capture(TimeProvider clock,
        Span<MacOsSysctlMemoryObservation> admittedOutput, MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        ArgumentNullException.ThrowIfNull(clock);
        Architecture architecture = RuntimeInformation.ProcessArchitecture;
        if (admittedOutput.Length < ObservationCount || !Enum.IsDefined(mode))
        {
            admittedOutput[..Math.Min(admittedOutput.Length, ObservationCount)].Clear();
            return new(mode, false, MemoryFailure.BoundsViolation, 0, architecture);
        }
        Span<MacOsSysctlMemoryObservation> output = admittedOutput[..ObservationCount];
        for (int index = 0; index < ObservationCount; index++)
        {
            output[index] = new((MacOsMemoryMetric)index,
                index == 0 ? MacOsMemoryScope.HostPhysical : MacOsMemoryScope.HostSwap,
                index == 0 ? PhysicalKey : SwapKey, MemoryObservationState.Unknown, null, null, null, null);
        }
        if (mode == MemoryCapabilityMode.Disabled)
        {
            return new(mode, false, null, 0, architecture);
        }
        if (!OperatingSystem.IsMacOS() || architecture is not (Architecture.X64 or Architecture.Arm64))
        {
            SetFailure(output, MemoryObservationState.Unknown, MemoryFailure.UnsupportedCapability, null);
            return new(mode, false, MemoryFailure.UnsupportedCapability, 0, architecture);
        }
        int attempts = 0;
        try
        {
            output[0] = output[0] with
            {
                SampledAt = clock.GetUtcNow()
            };
            ReadPhysical(output, ref attempts);
            DateTimeOffset swapAt = clock.GetUtcNow();
            for (int index = 1; index < ObservationCount; index++)
            {
                output[index] = output[index] with
                {
                    SampledAt = swapAt
                };
            }
            ReadSwap(output[1..], ref attempts);
            return new(mode, true, null, attempts, architecture);
        }
        catch
        {
            output.Clear();
            throw;
        }
    }

    private static void ReadPhysical(Span<MacOsSysctlMemoryObservation> output, ref int attempts)
    {
        try
        {
            ulong native = 0;
            nuint length = PhysicalSize;
            attempts++;
            int status = ReadPhysicalByName(PhysicalKey, ref native, ref length, 0, 0);
            int error = status == 0 ? 0 : Marshal.GetLastPInvokeError();
            MapPhysical(output, status, error, length, native);
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException)
        {
            SetFailure(output[..1], MemoryObservationState.Unknown, MemoryFailure.UnsupportedCapability, null);
        }
    }

    private static void ReadSwap(Span<MacOsSysctlMemoryObservation> output, ref int attempts)
    {
        try
        {
            NativeSwapUsage native = default;
            nuint length = SwapSize;
            attempts++;
            int status = ReadSwapByName(SwapKey, ref native, ref length, 0, 0);
            int error = status == 0 ? 0 : Marshal.GetLastPInvokeError();
            MapSwap(output, status, error, length, native);
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException)
        {
            SetFailure(output, MemoryObservationState.Unknown, MemoryFailure.UnsupportedCapability, null);
        }
    }

    internal static void MapPhysical(Span<MacOsSysctlMemoryObservation> output,
        int status, int error, nuint returnedLength, ulong native)
    {
        if (NativeFailure(output[..1], status, error))
        {
            return;
        }
        if (returnedLength != PhysicalSize)
        {
            SetFailure(output[..1], MemoryObservationState.Malformed, null, null);
            return;
        }
        WriteValue(output, 0, native);
    }

    internal static void MapSwap(Span<MacOsSysctlMemoryObservation> output,
        int status, int error, nuint returnedLength, NativeSwapUsage native)
    {
        if (NativeFailure(output, status, error))
        {
            return;
        }
        // Apple returns byte counts, not pages. A zero page size is valid only
        // for the no-swap result in bsd/vm/dp_backing_file.c, not a missing key.
        if (returnedLength != SwapSize || native._available > native._total
            || native._used != native._total - native._available || native._encrypted > 1
            || (native._pageSize == 0 && (native._total != 0 || native._encrypted != 0)))
        {
            SetFailure(output, MemoryObservationState.Malformed, null, null);
            return;
        }
        WriteValue(output, 0, native._total);
        WriteValue(output, 1, native._available);
        WriteValue(output, 2, native._used);
    }

    private static void WriteValue(Span<MacOsSysctlMemoryObservation> output, int index, ulong native)
    {
        try
        {
            output[index] = output[index] with
            {
                State = MemoryObservationState.Available,
                Value = checked((long)native),
                Failure = null,
                NativeError = null
            };
        }
        catch (OverflowException)
        {
            SetFailure(output.Slice(index, 1), MemoryObservationState.Malformed, null, null);
        }
    }

    private static bool NativeFailure(Span<MacOsSysctlMemoryObservation> output, int status, int error)
    {
        if (status == 0)
        {
            return false;
        }
        // Darwin errno.h at the pinned XNU revision: EPERM/EACCES, EOVERFLOW,
        // ENOENT/ENOTSUP/ENOSYS. ENOMEM can also mean a failed kernel buffer wire;
        // errno alone cannot prove a malformed ABI or a zero observation.
        MemoryObservationState state = error is 1 or 13 ? MemoryObservationState.Denied
            : error == 84 ? MemoryObservationState.Malformed : MemoryObservationState.Unknown;
        MemoryFailure failure = error is 2 or 45 or 78
            ? MemoryFailure.UnsupportedCapability : MemoryFailure.TierUnavailable;
        SetFailure(output, state, failure, error);
        return true;
    }

    private static void SetFailure(Span<MacOsSysctlMemoryObservation> output,
        MemoryObservationState state, MemoryFailure? failure, int? error)
    {
        for (int index = 0; index < output.Length; index++)
        {
            output[index] = output[index] with
            {
                State = state,
                Value = null,
                Failure = failure,
                NativeError = error
            };
        }
    }

    // ABI pinned to Apple XNU 1031c584a5e37aff177559b9f69dbd3c8c3fd30a:
    // bsd/sys/sysctl.h, bsd/kern/kern_mib.c, bsd/kern/kern_sysctl.c and
    // bsd/vm/dp_backing_file.c. xsw_usage has 3 uint64, uint32 and boolean_t.
    // boolean_t is 32-bit (signed on arm64; unsigned in x64 userspace);
    // its 0/1 bit representation is identical. No managed bool marshalling.
    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeSwapUsage
    {
        internal ulong _total;
        internal ulong _available;
        internal ulong _used;
        internal uint _pageSize;
        internal uint _encrypted;
    }

    // newp/newlen are always null/zero. size_t and size_t* use native unsigned width.
    [DllImport("/usr/lib/libSystem.B.dylib", EntryPoint = "sysctlbyname", ExactSpelling = true,
        CallingConvention = CallingConvention.Cdecl, SetLastError = true)]
    private static extern int ReadPhysicalByName([MarshalAs(UnmanagedType.LPUTF8Str)] string name,
        ref ulong oldValue, ref nuint oldLength, nint newValue, nuint newLength);

    [DllImport("/usr/lib/libSystem.B.dylib", EntryPoint = "sysctlbyname", ExactSpelling = true,
        CallingConvention = CallingConvention.Cdecl, SetLastError = true)]
    private static extern int ReadSwapByName([MarshalAs(UnmanagedType.LPUTF8Str)] string name,
        ref NativeSwapUsage oldValue, ref nuint oldLength, nint newValue, nuint newLength);
}
