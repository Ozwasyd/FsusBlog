using System.Text.Json;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class LinuxCgroupContextReaderTests
{
    private readonly ITestOutputHelper _output;

    public LinuxCgroupContextReaderTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    public void LiveCaptureRetainsActualNamespaceAndClockIdentityAndClearsBothBuffers()
    {
        Assert.True(OperatingSystem.IsLinux());
        byte[] membership = new byte[65537];
        byte[] mounts = new byte[65537];
        Array.Fill(membership, (byte)0xcc);
        Array.Fill(mounts, (byte)0xcc);
        var result = LinuxCgroupContextReader.TryCapture(TimeProvider.System, 65536, 2048, 256,
            TimeSpan.FromSeconds(30), membership, mounts);
        Assert.True(result.Succeeded);
        LinuxCgroupContextCapture capture = result.Value!;
        _output.WriteLine(JsonSerializer.Serialize(capture));
        Assert.Equal(MemoryQualification.NotVerified, capture.Qualification);
        Assert.Equal(NamespaceInode("cgroup"), capture.CgroupNamespaceBefore);
        Assert.Equal(capture.CgroupNamespaceBefore, capture.CgroupNamespaceAfter);
        Assert.Equal(NamespaceInode("mnt"), capture.MountNamespaceBefore);
        Assert.Equal(capture.MountNamespaceBefore, capture.MountNamespaceAfter);
        Assert.Contains($"pid={Environment.ProcessId}", capture.Source);
        Assert.True(capture.TimestampFrequency > 0);
        Assert.True(capture.CompletedTimestamp >= capture.Timestamp);
        Assert.All(membership, item => Assert.Equal((byte)0, item));
        Assert.All(mounts, item => Assert.Equal((byte)0, item));
        if (capture.State == MemoryObservationState.Available)
        {
            Assert.NotNull(capture.Scope);
            Assert.Equal(MemoryQualification.NotVerified, capture.Scope.Qualification);
        }
        else
        {
            Assert.Null(capture.Scope);
            Assert.NotEqual(LinuxCgroupScopeReason.Ready, capture.Reason);
        }
    }

    [Fact]
    public void OverlappingOrInsufficientBuffersRejectBeforeClockCaptureOrProcReads()
    {
        byte[] scratch = new byte[129];
        Array.Fill(scratch, (byte)0xcc);
        var clock = new ThrowingClock();
        Assert.Equal(MemoryFailure.BoundsViolation,
            LinuxCgroupContextReader.TryCapture(clock, 64, 16, 8, TimeSpan.FromSeconds(1),
                scratch.AsSpan(0, 65), scratch.AsSpan(64, 65)).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation,
            LinuxCgroupContextReader.TryCapture(clock, 64, 16, 8, TimeSpan.FromSeconds(1),
                scratch.AsSpan(0, 64), scratch.AsSpan(64, 65)).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation,
            LinuxCgroupContextReader.TryCapture(clock, 64, 0, 8, TimeSpan.FromSeconds(1),
                new byte[65], new byte[65]).Failure);
        Assert.Equal(0, clock.Captures);
        Assert.All(scratch, item => Assert.Equal((byte)0xcc, item));
    }

    [Fact]
    public void OversizedRealMetadataNeverTruncatesIntoAnAvailableScope()
    {
        byte[] membership = new byte[9];
        byte[] mounts = new byte[9];
        var capture = LinuxCgroupContextReader.TryCapture(TimeProvider.System, 8, 16, 8,
            TimeSpan.FromSeconds(30), membership, mounts).Value!;
        Assert.Equal(MemoryObservationState.Malformed, capture.State);
        Assert.Null(capture.Scope);
        Assert.All(membership, item => Assert.Equal((byte)0, item));
        Assert.All(mounts, item => Assert.Equal((byte)0, item));
    }

    [Fact]
    public void CaptureTimeBoundAndClockDiscontinuityInvalidateActualReads()
    {
        foreach (TimeProvider clock in new TimeProvider[] { new AdvancingClock(), new ReversingClock(), new FrequencyClock() })
        {
            var capture = LinuxCgroupContextReader.TryCapture(clock, 65536, 2048, 256,
                TimeSpan.FromMilliseconds(1), new byte[65537], new byte[65537]).Value!;
            Assert.Equal(MemoryObservationState.Stale, capture.State);
            Assert.Null(capture.Scope);
        }
    }

    [Fact]
    public void ClockFaultClearsCallerScratchWithoutRetainingAnyCapturedData()
    {
        byte[] membership = new byte[65];
        byte[] mounts = new byte[65];
        Array.Fill(membership, (byte)0xcc);
        Array.Fill(mounts, (byte)0xcc);
        Assert.Throws<InvalidOperationException>(() => LinuxCgroupContextReader.TryCapture(new ThrowingClock(),
            64, 16, 8, TimeSpan.FromSeconds(1), membership, mounts));
        Assert.All(membership, item => Assert.Equal((byte)0, item));
        Assert.All(mounts, item => Assert.Equal((byte)0, item));
    }

    [Fact]
    public void ContextAgreementIsUnqualifiedAndEveryRelevantIdentityChangeInvalidatesIt()
    {
        var before = Fixture(10, 20);
        var after = Fixture(30, 40);
        Assert.Equal(MemoryObservationState.Available, Compare(before, after));
        Assert.Equal(MemoryQualification.NotVerified, after.Qualification);
        var changed = after.Scope!.Identity with
        {
            MembershipPath = "/tenant/other"
        };
        Assert.Equal(MemoryObservationState.Stale, Compare(before, after with
        {
            Scope = after.Scope with
            {
                Identity = changed
            }
        }));
        changed = after.Scope.Identity with
        {
            MountId = 72
        };
        Assert.Equal(MemoryObservationState.Stale, Compare(before, after with
        {
            Scope = after.Scope with
            {
                Identity = changed
            }
        }));
        Assert.Equal(MemoryObservationState.Stale, Compare(before, after with
        {
            CgroupNamespaceAfter = 12
        }));
        Assert.Equal(MemoryObservationState.Stale, Compare(before, after with
        {
            MountNamespaceAfter = null
        }));
        Assert.Equal(MemoryObservationState.Stale, Compare(before, after with
        {
            Source = "different-source"
        }));
        Assert.Equal(MemoryObservationState.Stale, Compare(before,
            after with
            {
                Scope = after.Scope with
                {
                    ObservableDirectories = new[] { "/observed/groups/other" }
                }
            }));
    }

    [Theory]
    [InlineData(MemoryObservationState.Unknown)]
    [InlineData(MemoryObservationState.Denied)]
    [InlineData(MemoryObservationState.Malformed)]
    [InlineData(MemoryObservationState.Stale)]
    public void MissingPartialOrStaleContextsKeepTheirStateAndNeverAuthorizeAgreement(MemoryObservationState state)
    {
        var before = Fixture(10, 20);
        var after = Fixture(30, 40);
        Assert.Equal(state, Compare(before with
        {
            State = state,
            Scope = null
        }, after));
        Assert.Equal(state, Compare(before, after with
        {
            State = state,
            Scope = null
        }));
        Assert.Equal(MemoryObservationState.Stale, Compare(before, after with
        {
            Scope = null
        }));
    }

    [Fact]
    public void ReplayedClockResetOverflowExpiryAndFrequencyChangeInvalidateContextAgreement()
    {
        var before = Fixture(10, 20);
        var after = Fixture(30, 40);
        Assert.Equal(MemoryObservationState.Stale, Compare(before, after with
        {
            Timestamp = 19
        }));
        Assert.Equal(MemoryObservationState.Stale, Compare(before, after with
        {
            TimestampFrequency = 2000
        }));
        Assert.Equal(MemoryObservationState.Stale, Compare(before, after with
        {
            SampledAt = before.SampledAt.AddSeconds(-1)
        }));
        Assert.Equal(MemoryObservationState.Stale, Compare(before, after with
        {
            SampledAt = before.SampledAt.AddMinutes(1)
        }));
        Assert.Equal(MemoryObservationState.Stale, Compare(before, after with
        {
            Timestamp = long.MaxValue - 1,
            CompletedTimestamp = long.MaxValue
        }));
        Assert.Equal(MemoryObservationState.Stale, Compare(before with
        {
            Timestamp = long.MinValue,
            CompletedTimestamp = long.MinValue + 1
        }, after));
        Assert.Equal(MemoryObservationState.Stale, LinuxCgroupContextReader.CompareContexts(before, after,
            before.SampledAt.AddMinutes(1), TimeSpan.FromSeconds(1)));
    }

    private static MemoryObservationState Compare(LinuxCgroupContextCapture before, LinuxCgroupContextCapture after)
        => LinuxCgroupContextReader.CompareContexts(before, after, before.SampledAt.AddSeconds(1), TimeSpan.FromSeconds(2));

    private static LinuxCgroupContextCapture Fixture(long started, long completed)
    {
        var identity = new LinuxCgroupScopeIdentity(2, 0, 10, 11, 71, "0:34", "/tenant", "/tenant/worker", "/observed/groups");
        var scope = new LinuxCgroupScope(identity, Array.AsReadOnly(new[] { "/observed/groups/worker", "/observed/groups" }));
        return new(MemoryObservationState.Available, LinuxCgroupScopeReason.Ready, scope,
            new DateTimeOffset(2026, 10, 8, 14, 30, 0, TimeSpan.Zero), started, completed, 1000,
            "controlled-context-fixture", 10, 10, 11, 11);
    }

    private static ulong NamespaceInode(string name)
    {
        string target = new FileInfo("/proc/self/ns/" + name).LinkTarget!;
        return ulong.Parse(target.AsSpan(name.Length + 2, target.Length - name.Length - 3));
    }

    private sealed class ThrowingClock : TimeProvider
    {
        public int Captures
        {
            get; private set;
        }
        public override DateTimeOffset GetUtcNow()
        {
            Captures++;
            throw new InvalidOperationException("Controlled clock fault.");
        }
    }

    private sealed class AdvancingClock : TimeProvider
    {
        private long _timestamp;
        public override long TimestampFrequency => 1000;
        public override long GetTimestamp() => Interlocked.Add(ref _timestamp, 1000);
    }

    private sealed class ReversingClock : TimeProvider
    {
        private int _reads;
        public override DateTimeOffset GetUtcNow() => DateTimeOffset.UnixEpoch.AddSeconds(-Interlocked.Increment(ref _reads));
    }

    private sealed class FrequencyClock : TimeProvider
    {
        private int _reads;
        public override long TimestampFrequency => Interlocked.Increment(ref _reads) < 3 ? 1000 : 2000;
    }
}
