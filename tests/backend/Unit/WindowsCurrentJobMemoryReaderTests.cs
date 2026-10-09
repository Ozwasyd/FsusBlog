using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Tests.Unit;

public sealed class WindowsCurrentJobMemoryReaderTests
{
    [Fact]
    public void Managed64BitLayoutMatchesPinnedDeclarationsWithoutNativeQualification()
    {
        Assert.Equal(8, IntPtr.Size);
        Assert.Equal(9, (int)WindowsJobInformationClass.ExtendedLimit);
        Assert.Equal(13, (int)WindowsJobInformationClass.LimitViolation);
        Assert.Equal(0x100U, WindowsCurrentJobMemoryReader.ProcessMemoryFlag);
        Assert.Equal(0x200U, WindowsCurrentJobMemoryReader.JobMemoryFlag);
        Assert.Equal(64, Marshal.SizeOf<WindowsCurrentJobMemoryReader.NativeBasicLimit>());
        Assert.Equal(48, Marshal.SizeOf<WindowsCurrentJobMemoryReader.NativeIoCounters>());
        Assert.Equal(144, Marshal.SizeOf<WindowsCurrentJobMemoryReader.NativeExtendedLimit>());
        Assert.Equal(80, Marshal.SizeOf<WindowsCurrentJobMemoryReader.NativeLimitViolation>());
        Assert.Equal(16, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeBasicLimit>("_limitFlags").ToInt32());
        Assert.Equal(24, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeBasicLimit>("_minimumWorkingSetSize").ToInt32());
        Assert.Equal(48, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeBasicLimit>("_affinity").ToInt32());
        Assert.Equal(64, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeExtendedLimit>("_io").ToInt32());
        Assert.Equal(112, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeExtendedLimit>("_processMemoryLimit").ToInt32());
        Assert.Equal(120, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeExtendedLimit>("_jobMemoryLimit").ToInt32());
        Assert.Equal(128, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeExtendedLimit>("_peakProcessMemoryUsed").ToInt32());
        Assert.Equal(136, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeExtendedLimit>("_peakJobMemoryUsed").ToInt32());
        Assert.Equal(4, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeLimitViolation>("_violationLimitFlags").ToInt32());
        Assert.Equal(40, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeLimitViolation>("_perJobUserTime").ToInt32());
        Assert.Equal(56, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeLimitViolation>("_jobMemory").ToInt32());
        Assert.Equal(64, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeLimitViolation>("_jobMemoryLimit").ToInt32());
        Assert.Equal(72, Marshal.OffsetOf<WindowsCurrentJobMemoryReader.NativeLimitViolation>("_rateControlTolerance").ToInt32());
        Assert.Equal(typeof(nuint), typeof(WindowsCurrentJobMemoryReader.NativeExtendedLimit)
            .GetField("_jobMemoryLimit", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.FieldType);
        Assert.Equal(typeof(ulong), typeof(WindowsCurrentJobMemoryReader.NativeLimitViolation)
            .GetField("_jobMemory", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.FieldType);
        Assert.Equal(typeof(uint), typeof(WindowsCurrentJobMemoryReader.NativeLimitViolation)
            .GetField("_limitFlags", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.FieldType);
        Assert.Equal(typeof(long), typeof(WindowsCurrentJobMemoryReader.NativeLimitViolation)
            .GetField("_perJobUserTime", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.FieldType);
    }

    [Fact]
    public void ExtendedLimitsUseIndependentFlagsAndPeaksRetainTheirDocumentedScopes()
    {
        var rows = Rows();
        var native = Extended(123, 456, 789, 1011);
        foreach (uint flags in new uint[] { 0, 0x100, 0x200, 0x300, 0x8000 })
        {
            native._basic._limitFlags = flags;
            WindowsCurrentJobMemoryReader.MapExtended(rows.AsSpan(0, 4), native, true, 0, 144);
            Assert.Equal((flags & 0x100) != 0 ? 123L : (long?)null, rows[0].Value);
            Assert.Equal((flags & 0x200) != 0 ? 456L : (long?)null, rows[1].Value);
            Assert.Equal((flags & 0x100) != 0 ? MemoryObservationState.Available : MemoryObservationState.Unknown, rows[0].State);
            Assert.Equal((flags & 0x200) != 0 ? MemoryObservationState.Available : MemoryObservationState.Unknown, rows[1].State);
            Assert.Equal(789, rows[2].Value);
            Assert.Equal(1011, rows[3].Value);
            Assert.All(rows[..4], row => Assert.Equal(flags, row.LimitFlags));
        }
        Assert.Equal(WindowsJobMemoryScope.PerProcessLimitInImmediateJob, rows[0].Scope);
        Assert.Equal(WindowsJobMemoryScope.ImmediateJob, rows[1].Scope);
        Assert.Equal(WindowsJobMemoryScope.AnyProcessEverInImmediateJob, rows[2].Scope);
        Assert.Equal(WindowsJobMemoryScope.ProcessesCurrentlyInImmediateJob, rows[3].Scope);
        Assert.All(rows, row =>
        {
            Assert.Equal(MemoryResourceUnit.Bytes, row.Unit);
            Assert.Equal("QueryInformationJobObject(NULL)", row.Source);
            Assert.Equal(MemoryQualification.NotVerified, row.Qualification);
        });
    }

    [Fact]
    public void NotificationUsageRequiresViolationFlagAndLimitRequiresItsOwnFlag()
    {
        var rows = Rows();
        foreach (uint limit in new uint[] { 0, 0x200, 0x100 })
        {
            foreach (uint violation in new uint[] { 0, 0x200, 0x100 })
            {
                var native = new WindowsCurrentJobMemoryReader.NativeLimitViolation
                {
                    _limitFlags = limit,
                    _violationLimitFlags = violation,
                    _jobMemory = 654,
                    _jobMemoryLimit = 321
                };
                WindowsCurrentJobMemoryReader.MapViolation(rows.AsSpan(4), native, true, 0, 80);
                Assert.Equal((violation & 0x200) != 0 ? 654L : (long?)null, rows[4].Value);
                Assert.Equal((limit & 0x200) != 0 ? 321L : (long?)null, rows[5].Value);
                Assert.Equal((violation & 0x200) != 0 ? MemoryObservationState.Available : MemoryObservationState.Unknown, rows[4].State);
                Assert.Equal((limit & 0x200) != 0 ? MemoryObservationState.Available : MemoryObservationState.Unknown, rows[5].State);
                Assert.Equal(limit, rows[4].LimitFlags);
                Assert.Equal(violation, rows[4].ViolationLimitFlags);
            }
        }
        Assert.Equal(WindowsJobMemoryMetric.NotificationJobCommitBytes, rows[4].Metric);
        Assert.Equal(WindowsJobInformationClass.LimitViolation, rows[4].InformationClass);
        Assert.Equal(WindowsJobMemoryScope.ImmediateJob, rows[4].Scope);
    }

    [Fact]
    public void FlagQualifiedZeroDiffersFromMissingAndIgnoredGarbageCannotOverflow()
    {
        var rows = Rows();
        var native = Extended(0, 0, 0, 0);
        native._basic._limitFlags = 0x300;
        WindowsCurrentJobMemoryReader.MapExtended(rows.AsSpan(0, 4), native, true, 0, 144);
        var violation = new WindowsCurrentJobMemoryReader.NativeLimitViolation { _limitFlags = 0x200, _violationLimitFlags = 0x200 };
        WindowsCurrentJobMemoryReader.MapViolation(rows.AsSpan(4), violation, true, 0, 80);
        Assert.All(rows, row =>
        {
            Assert.Equal(MemoryObservationState.Available, row.State);
            Assert.Equal(0, row.Value);
        });
        native._basic._limitFlags = 0;
        native._processMemoryLimit = nuint.MaxValue;
        native._jobMemoryLimit = nuint.MaxValue;
        WindowsCurrentJobMemoryReader.MapExtended(rows.AsSpan(0, 4), native, true, 0, 144);
        violation._limitFlags = 0;
        violation._violationLimitFlags = 0;
        violation._jobMemory = ulong.MaxValue;
        violation._jobMemoryLimit = ulong.MaxValue;
        WindowsCurrentJobMemoryReader.MapViolation(rows.AsSpan(4), violation, true, 0, 80);
        foreach (int index in new[] { 0, 1, 4, 5 })
        {
            Assert.Equal(MemoryObservationState.Unknown, rows[index].State);
            Assert.Null(rows[index].Value);
        }
    }

    [Fact]
    public void CheckedNativeConversionsKeepLongBoundaryAndRejectOverflowPerField()
    {
        var rows = Rows();
        ulong boundary = (ulong)long.MaxValue;
        var native = Extended(checked((nuint)boundary), nuint.MaxValue, nuint.MaxValue, 42);
        native._basic._limitFlags = 0x300;
        WindowsCurrentJobMemoryReader.MapExtended(rows.AsSpan(0, 4), native, true, 0, 144);
        WindowsCurrentJobMemoryReader.MapViolation(rows.AsSpan(4), new()
        {
            _limitFlags = 0x200,
            _violationLimitFlags = 0x200,
            _jobMemory = ulong.MaxValue,
            _jobMemoryLimit = (ulong)long.MaxValue
        }, true, 0, 80);
        Assert.Equal(long.MaxValue, rows[0].Value);
        Assert.Equal(long.MaxValue, rows[5].Value);
        Assert.Equal(42, rows[3].Value);
        foreach (int index in new[] { 1, 2, 4 })
        {
            Assert.Equal(MemoryObservationState.Malformed, rows[index].State);
            Assert.Null(rows[index].Value);
        }
    }

    [Fact]
    public void QueryFailuresRetainErrorsAndNeverConvertFailedNativeBuffers()
    {
        var rows = Rows();
        foreach (int error in new[] { 5, 6, 50, 87, 1 })
        {
            WindowsCurrentJobMemoryReader.MapExtended(rows.AsSpan(0, 4), Extended(1, 2, 3, 4), false, error, 144);
            WindowsCurrentJobMemoryReader.MapViolation(rows.AsSpan(4), new()
            {
                _jobMemory = 5
            }, false, error, 80);
            Assert.All(rows, row =>
            {
                Assert.Equal(error == 5 ? MemoryObservationState.Denied : MemoryObservationState.Unknown, row.State);
                Assert.Equal(error is 50 or 87 ? MemoryFailure.UnsupportedCapability : MemoryFailure.TierUnavailable, row.Failure);
                Assert.Equal(error, row.NativeError);
                Assert.Null(row.Value);
                Assert.Null(row.LimitFlags);
                Assert.Null(row.ViolationLimitFlags);
            });
        }
    }

    [Fact]
    public void PartialOrOversizedNativeResultsAreMalformedAndIndependentQueriesStayIndependent()
    {
        var rows = Rows();
        foreach (uint length in new uint[] { 0, 143, 145 })
        {
            WindowsCurrentJobMemoryReader.MapExtended(rows.AsSpan(0, 4), Extended(1, 2, 3, 4), true, 0, length);
            Assert.All(rows[..4], row =>
            {
                Assert.Equal(MemoryObservationState.Malformed, row.State);
                Assert.Null(row.Value);
                Assert.Null(row.NativeError);
            });
        }
        WindowsCurrentJobMemoryReader.MapExtended(rows.AsSpan(0, 4), Extended(1, 2, 3, 4), true, 0, 144);
        foreach (uint length in new uint[] { 0, 79, 81 })
        {
            WindowsCurrentJobMemoryReader.MapViolation(rows.AsSpan(4), new()
            {
                _jobMemory = 5
            }, true, 0, length);
            Assert.All(rows[4..], row => Assert.Equal(MemoryObservationState.Malformed, row.State));
        }
        WindowsCurrentJobMemoryReader.MapViolation(rows.AsSpan(4), default, false, 87, 0);
        Assert.Equal(3, rows[2].Value);
        Assert.Equal(4, rows[3].Value);
        Assert.Null(rows[4].Value);
        Assert.Equal(MemoryFailure.UnsupportedCapability, rows[4].Failure);
    }

    [Fact]
    public void DisabledAndInvalidArgumentsClearOldValuesBeforeClockOrNativeCalls()
    {
        var clock = new ThrowingClock();
        var rows = Rows();
        Array.Fill(rows, rows[0] with
        {
            State = MemoryObservationState.Available,
            Value = 99
        });
        var disabled = WindowsCurrentJobMemoryReader.Capture(clock, TimeSpan.FromSeconds(1), rows, MemoryCapabilityMode.Disabled);
        Assert.False(disabled.Captured);
        Assert.Null(disabled.Failure);
        Assert.Equal(0, disabled.NativeCallAttempts);
        Assert.Equal(MemoryQualification.NotVerified, disabled.Qualification);
        Assert.Equal(6, rows.Select(row => row.Metric).Distinct().Count());
        Assert.All(rows, row =>
        {
            Assert.Equal(MemoryObservationState.Unknown, row.State);
            Assert.Null(row.Value);
            Assert.Null(row.ObservedAt);
            Assert.Null(row.Timestamp);
        });
        var shortRows = rows[..5];
        var invalid = WindowsCurrentJobMemoryReader.Capture(clock, TimeSpan.FromSeconds(1), shortRows);
        Assert.Equal(MemoryFailure.BoundsViolation, invalid.Failure);
        Assert.Equal(0, invalid.NativeCallAttempts);
        Assert.False(invalid.Captured);
        foreach (var arguments in new[] { (TimeSpan.Zero, MemoryCapabilityMode.Auto), (TimeSpan.FromSeconds(1), (MemoryCapabilityMode)99) })
        {
            invalid = WindowsCurrentJobMemoryReader.Capture(clock, arguments.Item1, rows, arguments.Item2);
            Assert.Equal(MemoryFailure.BoundsViolation, invalid.Failure);
            Assert.Equal(0, invalid.NativeCallAttempts);
        }
        Assert.All(rows, row => Assert.Null(row.Value));
    }

    [Fact]
    [Trait("Platform", "Unix")]
    public void UnsupportedHostRefusesAutoAndRequiredBeforeClockOrNativeCalls()
    {
        Assert.False(OperatingSystem.IsWindows());
        var rows = Rows();
        foreach (var mode in new[] { MemoryCapabilityMode.Auto, MemoryCapabilityMode.Required })
        {
            var result = WindowsCurrentJobMemoryReader.Capture(new ThrowingClock(), TimeSpan.FromSeconds(1), rows, mode);
            Assert.Equal(mode, result.Mode);
            Assert.False(result.Captured);
            Assert.Equal(0, result.NativeCallAttempts);
            Assert.Equal(MemoryFailure.UnsupportedCapability, result.Failure);
            Assert.Equal(MemoryQualification.NotVerified, result.Qualification);
            Assert.All(rows, row =>
            {
                Assert.Equal(MemoryObservationState.Unknown, row.State);
                Assert.Null(row.Value);
                Assert.Null(row.ObservedAt);
                Assert.Null(row.Timestamp);
                Assert.Equal(MemoryFailure.UnsupportedCapability, row.Failure);
            });
        }
    }

    [Fact]
    public void ObservationWindowRetainsQueryTimeAndRejectsDiscontinuity()
    {
        var rows = Rows();
        var at = DateTimeOffset.UnixEpoch;
        for (int index = 0; index < rows.Length; index++)
        {
            rows[index] = rows[index] with
            {
                ObservedAt = at.AddMilliseconds(index),
                Timestamp = index,
                TimestampFrequency = 1000
            };
        }
        bool Valid() => WindowsCurrentJobMemoryReader.ValidObservationWindow(rows, at, at.AddSeconds(1), 0, 1000, 1000);
        Assert.True(Valid());
        WindowsCurrentJobMemoryReader.MapViolation(rows.AsSpan(4), new()
        {
            _violationLimitFlags = 0x200,
            _jobMemory = 7
        }, true, 0, 80);
        Assert.Equal(at.AddMilliseconds(4), rows[4].ObservedAt);
        Assert.Equal(4, rows[4].Timestamp);
        rows[4] = rows[4] with
        {
            TimestampFrequency = 2000
        };
        Assert.False(Valid());
        rows[4] = rows[4] with
        {
            TimestampFrequency = 1000,
            Timestamp = 1
        };
        Assert.False(Valid());
        rows[4] = rows[4] with
        {
            Timestamp = 4,
            ObservedAt = at.AddMilliseconds(1)
        };
        Assert.False(Valid());
        rows[4] = rows[4] with
        {
            ObservedAt = at.AddSeconds(2)
        };
        Assert.False(Valid());
        rows[4] = rows[4] with
        {
            ObservedAt = null
        };
        Assert.False(Valid());
    }

    private static WindowsJobMemoryObservation[] Rows()
    {
        var rows = new WindowsJobMemoryObservation[WindowsCurrentJobMemoryReader.ObservationCount];
        WindowsCurrentJobMemoryReader.Initialize(rows);
        return rows;
    }

    private static WindowsCurrentJobMemoryReader.NativeExtendedLimit Extended(nuint processLimit, nuint jobLimit,
        nuint processPeak, nuint jobPeak) => new()
        {
            _processMemoryLimit = processLimit,
            _jobMemoryLimit = jobLimit,
            _peakProcessMemoryUsed = processPeak,
            _peakJobMemoryUsed = jobPeak
        };

    private sealed class ThrowingClock : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => throw new InvalidOperationException("Clock capture is not permitted.");
        public override long GetTimestamp() => throw new InvalidOperationException("Clock capture is not permitted.");
    }
}
