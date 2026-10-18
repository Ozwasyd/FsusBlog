using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

public enum WindowsJobMemoryMetric
{
    ProcessCommitLimitBytes, JobCommitLimitBytes, PeakProcessCommitBytes, PeakJobCommitBytes,
    NotificationJobCommitBytes, NotificationJobCommitLimitBytes
}

public enum WindowsJobInformationClass
{
    ExtendedLimit = 9, LimitViolation = 13
}

public enum WindowsJobMemoryScope
{
    PerProcessLimitInImmediateJob, ImmediateJob, AnyProcessEverInImmediateJob,
    ProcessesCurrentlyInImmediateJob
}

/// <summary>
/// Raw bytes from QueryInformationJobObject(NULL). ObservedAt is the query time,
/// not the notification time. NotificationJobCommitBytes is a notification snapshot,
/// never current usage. Separate queries cannot establish a common Job identity or epoch.
/// </summary>
public readonly record struct WindowsJobMemoryObservation(WindowsJobMemoryMetric Metric,
    WindowsJobInformationClass InformationClass, WindowsJobMemoryScope Scope, MemoryObservationState State,
    long? Value, MemoryFailure? Failure, int? NativeError, uint? LimitFlags, uint? ViolationLimitFlags,
    DateTimeOffset? ObservedAt, long? Timestamp, long? TimestampFrequency)
{
    public MemoryResourceUnit Unit => MemoryResourceUnit.Bytes;
    public string Source => "QueryInformationJobObject(NULL)";
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

public readonly record struct WindowsJobMemoryCapture(MemoryCapabilityMode Mode, bool Captured,
    MemoryFailure? Failure, int NativeCallAttempts, Architecture Architecture)
{
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

/// <summary>
/// Reads only the calling process's immediate Job into caller-owned admitted storage.
/// Missing membership and Job epoch remain unknown; this reader neither establishes
/// resource identity, parent coverage, headroom, admission nor platform qualification.
/// The existing owner supplies probe admission, metadata accounting and integration.
/// </summary>
public static class WindowsCurrentJobMemoryReader
{
    public const int ObservationCount = 6;
    internal const uint ProcessMemoryFlag = 0x00000100;
    internal const uint JobMemoryFlag = 0x00000200;

    public static WindowsJobMemoryCapture Capture(TimeProvider clock, TimeSpan maximumDuration,
        Span<WindowsJobMemoryObservation> admittedOutput, MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        ArgumentNullException.ThrowIfNull(clock);
        if (admittedOutput.Length < ObservationCount || maximumDuration <= TimeSpan.Zero || !Enum.IsDefined(mode))
        {
            admittedOutput[..Math.Min(admittedOutput.Length, ObservationCount)].Clear();
            return new(mode, false, MemoryFailure.BoundsViolation, 0, RuntimeInformation.ProcessArchitecture);
        }
        Span<WindowsJobMemoryObservation> output = admittedOutput[..ObservationCount];
        Initialize(output);
        if (mode == MemoryCapabilityMode.Disabled)
        {
            return new(mode, false, null, 0, RuntimeInformation.ProcessArchitecture);
        }
        // This reader declares the audited 64-bit ABI only. Class 13 requires Windows 8.
        if (!OperatingSystem.IsWindowsVersionAtLeast(6, 2)
            || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            SetFailure(output, MemoryObservationState.Unknown, MemoryFailure.UnsupportedCapability, null);
            return new(mode, false, MemoryFailure.UnsupportedCapability, 0, RuntimeInformation.ProcessArchitecture);
        }
        int attempts = 0;
        try
        {
            DateTimeOffset startedAt = clock.GetUtcNow();
            long started = clock.GetTimestamp();
            long frequency = clock.TimestampFrequency;
            if (frequency <= 0)
            {
                SetFailure(output, MemoryObservationState.Malformed, MemoryFailure.BoundsViolation, null);
                return new(mode, false, MemoryFailure.BoundsViolation, 0, RuntimeInformation.ProcessArchitecture);
            }
            Stamp(output[..4], clock);
            ReadExtended(output[..4], ref attempts);
            Stamp(output[4..], clock);
            ReadViolation(output[4..], ref attempts);
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
                SetFailure(output, MemoryObservationState.Stale, null, null);
            }
            // Captured records attempted queries, not successful membership or qualification.
            return new(mode, true, null, attempts, RuntimeInformation.ProcessArchitecture);
        }
        catch
        {
            output.Clear();
            throw;
        }
    }

    internal static void Initialize(Span<WindowsJobMemoryObservation> output)
    {
        for (int index = 0; index < ObservationCount; index++)
        {
            WindowsJobMemoryScope scope = index switch
            {
                0 => WindowsJobMemoryScope.PerProcessLimitInImmediateJob,
                2 => WindowsJobMemoryScope.AnyProcessEverInImmediateJob,
                3 => WindowsJobMemoryScope.ProcessesCurrentlyInImmediateJob,
                _ => WindowsJobMemoryScope.ImmediateJob
            };
            output[index] = new((WindowsJobMemoryMetric)index,
                index < 4 ? WindowsJobInformationClass.ExtendedLimit : WindowsJobInformationClass.LimitViolation,
                scope, MemoryObservationState.Unknown, null, null, null, null, null, null, null, null);
        }
    }

    private static void Stamp(Span<WindowsJobMemoryObservation> output, TimeProvider clock)
    {
        DateTimeOffset at = clock.GetUtcNow();
        long timestamp = clock.GetTimestamp();
        long frequency = clock.TimestampFrequency;
        for (int index = 0; index < output.Length; index++)
        {
            output[index] = output[index] with
            {
                ObservedAt = at,
                Timestamp = timestamp,
                TimestampFrequency = frequency
            };
        }
    }

    private static void ReadExtended(Span<WindowsJobMemoryObservation> output, ref int attempts)
    {
        try
        {
            attempts++;
            bool succeeded = QueryExtended(0, WindowsJobInformationClass.ExtendedLimit,
                out NativeExtendedLimit native, checked((uint)Marshal.SizeOf<NativeExtendedLimit>()), out uint length);
            int error = succeeded ? 0 : Marshal.GetLastPInvokeError();
            MapExtended(output, native, succeeded, error, length);
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException)
        {
            SetFailure(output, MemoryObservationState.Unknown, MemoryFailure.UnsupportedCapability, null);
        }
    }

    private static void ReadViolation(Span<WindowsJobMemoryObservation> output, ref int attempts)
    {
        try
        {
            attempts++;
            bool succeeded = QueryViolation(0, WindowsJobInformationClass.LimitViolation,
                out NativeLimitViolation native, checked((uint)Marshal.SizeOf<NativeLimitViolation>()), out uint length);
            int error = succeeded ? 0 : Marshal.GetLastPInvokeError();
            MapViolation(output, native, succeeded, error, length);
        }
        catch (Exception error) when (error is DllNotFoundException or EntryPointNotFoundException)
        {
            SetFailure(output, MemoryObservationState.Unknown, MemoryFailure.UnsupportedCapability, null);
        }
    }

    internal static void MapExtended(Span<WindowsJobMemoryObservation> output, NativeExtendedLimit native,
        bool succeeded, int error, uint length)
    {
        if (!ValidQuery(output, succeeded, error, length, Marshal.SizeOf<NativeExtendedLimit>()))
        {
            return;
        }
        uint flags = native._basic._limitFlags;
        for (int index = 0; index < output.Length; index++)
        {
            output[index] = output[index] with
            {
                LimitFlags = flags
            };
        }
        WriteValue(output, 0, native._processMemoryLimit, (flags & ProcessMemoryFlag) != 0);
        WriteValue(output, 1, native._jobMemoryLimit, (flags & JobMemoryFlag) != 0);
        // The official class 9 contract tracks both peaks constantly; no validity flag
        // exists for them. PeakProcess is any process ever in the Job, not this process.
        WriteValue(output, 2, native._peakProcessMemoryUsed, true);
        WriteValue(output, 3, native._peakJobMemoryUsed, true);
    }

    internal static void MapViolation(Span<WindowsJobMemoryObservation> output, NativeLimitViolation native,
        bool succeeded, int error, uint length)
    {
        if (!ValidQuery(output, succeeded, error, length, Marshal.SizeOf<NativeLimitViolation>()))
        {
            return;
        }
        for (int index = 0; index < output.Length; index++)
        {
            output[index] = output[index] with
            {
                LimitFlags = native._limitFlags,
                ViolationLimitFlags = native._violationLimitFlags
            };
        }
        // Each field has its own flag. A notification snapshot has no exposed event time.
        WriteValue(output, 0, native._jobMemory, (native._violationLimitFlags & JobMemoryFlag) != 0);
        WriteValue(output, 1, native._jobMemoryLimit, (native._limitFlags & JobMemoryFlag) != 0);
    }

    private static bool ValidQuery(Span<WindowsJobMemoryObservation> output, bool succeeded,
        int error, uint length, int expectedLength)
    {
        if (!succeeded)
        {
            SetFailure(output, error == 5 ? MemoryObservationState.Denied : MemoryObservationState.Unknown,
                error is 50 or 87 ? MemoryFailure.UnsupportedCapability : MemoryFailure.TierUnavailable, error);
            return false;
        }
        if (length != expectedLength)
        {
            SetFailure(output, MemoryObservationState.Malformed, null, null);
            return false;
        }
        return true;
    }

    private static void WriteValue(Span<WindowsJobMemoryObservation> output, int index, ulong value, bool meaningful)
    {
        MemoryObservationState state = MemoryObservationState.Unknown;
        long? bytes = null;
        if (meaningful)
        {
            try
            {
                bytes = checked((long)value);
                state = MemoryObservationState.Available;
            }
            catch (OverflowException)
            {
                state = MemoryObservationState.Malformed;
            }
        }
        output[index] = output[index] with
        {
            State = state,
            Value = bytes,
            Failure = null,
            NativeError = null
        };
    }

    private static void SetFailure(Span<WindowsJobMemoryObservation> output, MemoryObservationState state,
        MemoryFailure? failure, int? nativeError)
    {
        for (int index = 0; index < output.Length; index++)
        {
            output[index] = output[index] with
            {
                State = state,
                Value = null,
                Failure = failure,
                NativeError = nativeError,
                LimitFlags = null,
                ViolationLimitFlags = null
            };
        }
    }

    internal static bool ValidObservationWindow(ReadOnlySpan<WindowsJobMemoryObservation> output,
        DateTimeOffset startedAt, DateTimeOffset completedAt, long started, long completed, long frequency)
    {
        if (output.Length != ObservationCount || frequency <= 0 || completed < started || completedAt < startedAt)
        {
            return false;
        }
        long previousTimestamp = started;
        DateTimeOffset previousUtc = startedAt;
        foreach (WindowsJobMemoryObservation item in output)
        {
            if (item.ObservedAt is null || item.Timestamp is null || item.TimestampFrequency != frequency
                || item.Timestamp < previousTimestamp || item.Timestamp > completed
                || item.ObservedAt < previousUtc || item.ObservedAt > completedAt)
            {
                return false;
            }
            previousTimestamp = item.Timestamp.Value;
            previousUtc = item.ObservedAt.Value;
        }
        return true;
    }

    // ABI source: microsoft/win32metadata at 6d6617a8eee57d7c4f6c55d8c23e35064ea69b9e,
    // generation/WinSDK/RecompiledIdlHeaders/{um/winnt.h,um/jobapi2.h,shared/basetsd.h}.
    // https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject
    // Every member's natural alignment is at most 8; Pack=8 preserves native offsets.
    // SIZE_T/ULONG_PTR use pointer width, DWORD is 32-bit, DWORD64/IO_COUNTERS are
    // unsigned 64-bit and LARGE_INTEGER is signed 64-bit.
    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct NativeBasicLimit
    {
        internal long _perProcessUserTimeLimit;
        internal long _perJobUserTimeLimit;
        internal uint _limitFlags;
        internal nuint _minimumWorkingSetSize;
        internal nuint _maximumWorkingSetSize;
        internal uint _activeProcessLimit;
        internal nuint _affinity;
        internal uint _priorityClass;
        internal uint _schedulingClass;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct NativeIoCounters
    {
        internal ulong _readOperationCount;
        internal ulong _writeOperationCount;
        internal ulong _otherOperationCount;
        internal ulong _readTransferCount;
        internal ulong _writeTransferCount;
        internal ulong _otherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct NativeExtendedLimit
    {
        internal NativeBasicLimit _basic;
        internal NativeIoCounters _io;
        internal nuint _processMemoryLimit;
        internal nuint _jobMemoryLimit;
        internal nuint _peakProcessMemoryUsed;
        internal nuint _peakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 8)]
    internal struct NativeLimitViolation
    {
        internal uint _limitFlags;
        internal uint _violationLimitFlags;
        internal ulong _ioReadBytes;
        internal ulong _ioReadBytesLimit;
        internal ulong _ioWriteBytes;
        internal ulong _ioWriteBytesLimit;
        internal long _perJobUserTime;
        internal long _perJobUserTimeLimit;
        internal ulong _jobMemory;
        internal ulong _jobMemoryLimit;
        internal int _rateControlTolerance;
        internal int _rateControlToleranceLimit;
    }

    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryExtended(nint job, WindowsJobInformationClass informationClass,
        out NativeExtendedLimit information, uint size, out uint returnLength);

    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", ExactSpelling = true, SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryViolation(nint job, WindowsJobInformationClass informationClass,
        out NativeLimitViolation information, uint size, out uint returnLength);
}
