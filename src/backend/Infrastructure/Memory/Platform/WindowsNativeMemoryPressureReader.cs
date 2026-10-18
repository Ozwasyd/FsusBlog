using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

public enum WindowsPressureMetric
{
    HostPhysicalTotalBytes, HostPhysicalAvailableBytes, SystemCommitBytes, SystemCommitLimitBytes,
    SystemCommitPeakBytes, ProcessWorkingSetBytes, ProcessPrivateCommitBytes, ProcessPageFaultCount
}

public enum WindowsPressureApi
{
    GlobalMemoryStatusEx, K32GetPerformanceInfo, K32GetProcessMemoryInfo
}

public enum WindowsPressureScope
{
    HostPhysical, SystemCommit, CurrentProcess
}

public readonly record struct WindowsPressureObservation(WindowsPressureMetric Metric, WindowsPressureApi Api,
    WindowsPressureScope Scope, MemoryObservationState State, long? Value, MemoryFailure? Failure,
    int? NativeError, DateTimeOffset? SampledAt, long? Timestamp, long? TimestampFrequency)
{
    public bool IsByteValue => Metric != WindowsPressureMetric.ProcessPageFaultCount;
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

public readonly record struct WindowsPressureCapture(MemoryCapabilityMode Mode, bool Captured,
    MemoryFailure? Failure, int NativeCallAttempts, int? ProcessId, int? ReportedOsMajor,
    int? ReportedOsMinor, int? ReportedOsBuild, Architecture Architecture)
{
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

/// <summary>
/// Reads the Windows 64-bit PSAPI2 ABI into caller-owned admitted value storage.
/// Native system commit, physical availability and process private commit retain
/// different scopes; none supplies qualified job headroom or swap activity. The
/// background owner controls probe admission, metadata costs, readiness and selection.
/// This reader registers no scheduler, configuration or diagnostics authority.
/// </summary>
public static class WindowsNativeMemoryPressureReader
{
    public const int ObservationCount = 8;

    public static WindowsPressureCapture Capture(TimeProvider clock, TimeSpan maximumDuration,
        Span<WindowsPressureObservation> admittedOutput, MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        ArgumentNullException.ThrowIfNull(clock);
        if (admittedOutput.Length < ObservationCount || maximumDuration <= TimeSpan.Zero || !Enum.IsDefined(mode))
        {
            admittedOutput[..Math.Min(admittedOutput.Length, ObservationCount)].Clear();
            return new(mode, false, MemoryFailure.BoundsViolation, 0, null, null, null, null, RuntimeInformation.ProcessArchitecture);
        }
        Span<WindowsPressureObservation> output = admittedOutput[..ObservationCount];
        Initialize(output);
        if (mode == MemoryCapabilityMode.Disabled)
        {
            return new(mode, false, null, 0, null, null, null, null, RuntimeInformation.ProcessArchitecture);
        }
        if (!OperatingSystem.IsWindowsVersionAtLeast(6, 1)
            || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            SetFailure(output, 0, ObservationCount, MemoryObservationState.Unknown, MemoryFailure.UnsupportedCapability, null);
            return new(mode, false, MemoryFailure.UnsupportedCapability, 0, null, null, null, null, RuntimeInformation.ProcessArchitecture);
        }
        int attempts = 0;
        try
        {
            DateTimeOffset startedAt = clock.GetUtcNow();
            long started = clock.GetTimestamp();
            long frequency = clock.TimestampFrequency;
            if (frequency <= 0)
            {
                SetFailure(output, 0, ObservationCount, MemoryObservationState.Malformed, MemoryFailure.BoundsViolation, null);
                return new(mode, false, MemoryFailure.BoundsViolation, 0, null, null, null, null, RuntimeInformation.ProcessArchitecture);
            }
            Stamp(output, 0, 2, clock);
            ReadPhysical(output, ref attempts);
            Stamp(output, 2, 3, clock);
            ReadCommit(output, ref attempts);
            Stamp(output, 5, 3, clock);
            ReadProcess(output, ref attempts);
            long completed = clock.GetTimestamp();
            DateTimeOffset completedAt = clock.GetUtcNow();
            bool validClock;
            try
            {
                validClock = frequency == clock.TimestampFrequency && completedAt >= startedAt
                    && completedAt - startedAt <= maximumDuration && checked(completed - started) >= 0
                    && clock.GetElapsedTime(started, completed) <= maximumDuration
                    && ValidObservationWindow(output, startedAt, completedAt, started, completed, frequency);
            }
            catch (OverflowException)
            {
                validClock = false;
            }
            if (!validClock)
            {
                SetFailure(output, 0, ObservationCount, MemoryObservationState.Stale, null, null);
            }
            Version version = Environment.OSVersion.Version;
            return new(mode, true, null, attempts, Environment.ProcessId, version.Major, version.Minor, version.Build,
                RuntimeInformation.ProcessArchitecture);
        }
        catch
        {
            output.Clear();
            throw;
        }
    }

    private static void Initialize(Span<WindowsPressureObservation> output)
    {
        for (int index = 0; index < ObservationCount; index++)
        {
            WindowsPressureApi api = index < 2 ? WindowsPressureApi.GlobalMemoryStatusEx
                : index < 5 ? WindowsPressureApi.K32GetPerformanceInfo : WindowsPressureApi.K32GetProcessMemoryInfo;
            WindowsPressureScope scope = index < 2 ? WindowsPressureScope.HostPhysical
                : index < 5 ? WindowsPressureScope.SystemCommit : WindowsPressureScope.CurrentProcess;
            output[index] = new((WindowsPressureMetric)index, api, scope, MemoryObservationState.Unknown,
                null, null, null, null, null, null);
        }
    }

    private static void Stamp(Span<WindowsPressureObservation> output, int offset, int count, TimeProvider clock)
    {
        DateTimeOffset at = clock.GetUtcNow();
        long timestamp = clock.GetTimestamp();
        long frequency = clock.TimestampFrequency;
        for (int index = offset; index < offset + count; index++)
        {
            output[index] = output[index] with
            {
                SampledAt = at,
                Timestamp = timestamp,
                TimestampFrequency = frequency
            };
        }
    }

    private static void ReadPhysical(Span<WindowsPressureObservation> output, ref int attempts)
    {
        try
        {
            var native = new NativeMemoryStatus { _length = (uint)Marshal.SizeOf<NativeMemoryStatus>() };
            attempts++;
            if (!GlobalMemoryStatusEx(ref native))
            {
                NativeFailure(output, 0, 2);
                return;
            }
            if (native._length != Marshal.SizeOf<NativeMemoryStatus>() || native._availablePhysical > native._totalPhysical)
            {
                SetFailure(output, 0, 2, MemoryObservationState.Malformed, null, null);
                return;
            }
            WriteValue(output, 0, native._totalPhysical, 1);
            WriteValue(output, 1, native._availablePhysical, 1);
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException)
        {
            SetFailure(output, 0, 2, MemoryObservationState.Unknown, MemoryFailure.UnsupportedCapability, null);
        }
    }

    private static void ReadCommit(Span<WindowsPressureObservation> output, ref int attempts)
    {
        try
        {
            var native = new NativePerformanceInfo { _size = (uint)Marshal.SizeOf<NativePerformanceInfo>() };
            attempts++;
            if (!K32GetPerformanceInfo(ref native, native._size))
            {
                NativeFailure(output, 2, 3);
                return;
            }
            if (native._size != Marshal.SizeOf<NativePerformanceInfo>())
            {
                SetFailure(output, 2, 3, MemoryObservationState.Malformed, null, null);
                return;
            }
            WriteValue(output, 2, native._commitTotal, native._pageSize);
            WriteValue(output, 3, native._commitLimit, native._pageSize);
            WriteValue(output, 4, native._commitPeak, native._pageSize);
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException)
        {
            SetFailure(output, 2, 3, MemoryObservationState.Unknown, MemoryFailure.UnsupportedCapability, null);
        }
    }

    private static void ReadProcess(Span<WindowsPressureObservation> output, ref int attempts)
    {
        try
        {
            var native = new NativeProcessMemory { _size = (uint)Marshal.SizeOf<NativeProcessMemory>() };
            attempts++;
            nint borrowedProcess = GetCurrentProcess();
            attempts++;
            if (!K32GetProcessMemoryInfo(borrowedProcess, ref native, native._size))
            {
                NativeFailure(output, 5, 3);
                return;
            }
            if (native._size != Marshal.SizeOf<NativeProcessMemory>())
            {
                SetFailure(output, 5, 3, MemoryObservationState.Malformed, null, null);
                return;
            }
            // The pseudo-handle is process-owned and must not be closed by this reader.
            WriteValue(output, 5, native._workingSet, 1);
            WriteValue(output, 6, native._privateUsage, 1);
            WriteValue(output, 7, native._pageFaults, 1);
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException)
        {
            SetFailure(output, 5, 3, MemoryObservationState.Unknown, MemoryFailure.UnsupportedCapability, null);
        }
    }

    internal static (MemoryObservationState State, long? Value) ConvertNative(ulong value, ulong multiplier)
    {
        if (multiplier == 0)
        {
            return (MemoryObservationState.Malformed, null);
        }
        try
        {
            ulong bytes = checked(value * multiplier);
            return bytes > long.MaxValue ? (MemoryObservationState.Malformed, null) : (MemoryObservationState.Available, (long)bytes);
        }
        catch (OverflowException)
        {
            return (MemoryObservationState.Malformed, null);
        }
    }

    internal static bool ValidObservationWindow(ReadOnlySpan<WindowsPressureObservation> observations,
        DateTimeOffset startedAt, DateTimeOffset completedAt, long started, long completed, long frequency)
    {
        if (observations.Length != ObservationCount || frequency <= 0 || completed < started || completedAt < startedAt)
        {
            return false;
        }
        long previousTimestamp = started;
        DateTimeOffset previousUtc = startedAt;
        foreach (WindowsPressureObservation item in observations)
        {
            if (item.SampledAt is null || item.Timestamp is null || item.TimestampFrequency != frequency
                || item.Timestamp < previousTimestamp || item.Timestamp > completed
                || item.SampledAt < previousUtc || item.SampledAt > completedAt)
            {
                return false;
            }
            previousTimestamp = item.Timestamp.Value;
            previousUtc = item.SampledAt.Value;
        }
        return true;
    }

    private static void WriteValue(Span<WindowsPressureObservation> output, int index, ulong value, ulong multiplier)
    {
        var parsed = ConvertNative(value, multiplier);
        output[index] = output[index] with
        {
            State = parsed.State,
            Value = parsed.Value
        };
    }

    private static void NativeFailure(Span<WindowsPressureObservation> output, int offset, int count)
    {
        int error = Marshal.GetLastPInvokeError();
        SetFailure(output, offset, count, error == 5 ? MemoryObservationState.Denied : MemoryObservationState.Unknown,
            MemoryFailure.TierUnavailable, error);
    }

    private static void SetFailure(Span<WindowsPressureObservation> output, int offset, int count,
        MemoryObservationState state, MemoryFailure? failure, int? nativeError)
    {
        for (int index = offset; index < offset + count; index++)
        {
            output[index] = output[index] with
            {
                State = state,
                Value = null,
                Failure = failure,
                NativeError = nativeError
            };
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeMemoryStatus
    {
        internal uint _length;
        internal uint _load;
        internal ulong _totalPhysical;
        internal ulong _availablePhysical;
        internal ulong _totalPageFile;
        internal ulong _availablePageFile;
        internal ulong _totalVirtual;
        internal ulong _availableVirtual;
        internal ulong _availableExtendedVirtual;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativePerformanceInfo
    {
        internal uint _size;
        internal nuint _commitTotal;
        internal nuint _commitLimit;
        internal nuint _commitPeak;
        internal nuint _physicalTotal;
        internal nuint _physicalAvailable;
        internal nuint _systemCache;
        internal nuint _kernelTotal;
        internal nuint _kernelPaged;
        internal nuint _kernelNonpaged;
        internal nuint _pageSize;
        internal uint _handleCount;
        internal uint _processCount;
        internal uint _threadCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeProcessMemory
    {
        internal uint _size;
        internal uint _pageFaults;
        internal nuint _peakWorkingSet;
        internal nuint _workingSet;
        internal nuint _quotaPeakPaged;
        internal nuint _quotaPaged;
        internal nuint _quotaPeakNonpaged;
        internal nuint _quotaNonpaged;
        internal nuint _pagefileUsage;
        internal nuint _peakPagefileUsage;
        internal nuint _privateUsage;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref NativeMemoryStatus status);
    [DllImport("kernel32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool K32GetPerformanceInfo(ref NativePerformanceInfo information, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool K32GetProcessMemoryInfo(nint process, ref NativeProcessMemory information, uint size);
    [DllImport("kernel32.dll")]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern nint GetCurrentProcess();
}
