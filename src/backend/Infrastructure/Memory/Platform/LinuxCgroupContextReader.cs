using System.Globalization;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

public sealed record LinuxCgroupContextCapture(MemoryObservationState State, LinuxCgroupScopeReason Reason,
    LinuxCgroupScope? Scope, DateTimeOffset SampledAt, long Timestamp, long CompletedTimestamp,
    long TimestampFrequency, string Source, ulong? CgroupNamespaceBefore, ulong? CgroupNamespaceAfter,
    ulong? MountNamespaceBefore, ulong? MountNamespaceAfter)
{
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

/// <summary>
/// Captures actual process membership/mount metadata with caller-owned admitted
/// buffers and explicit parsing/time bounds. The background sampling owner controls
/// policy and lifetime; this surface registers no sampler, timer or admission source.
/// Context agreement never qualifies a backend or substitutes for each native inode.
/// </summary>
public static class LinuxCgroupContextReader
{
    private static readonly string s_sourceIdentity = $"Linux.procfs.context;pid={Environment.ProcessId};instance={Guid.NewGuid():D};cgroup+mountinfo+namespace";

    public static MemoryOperationResult<LinuxCgroupContextCapture> TryCapture(TimeProvider clock,
        int maximumInputBytes, int maximumMountRecords, int maximumAncestors, TimeSpan maximumDuration,
        Span<byte> membershipScratch, Span<byte> mountScratch)
    {
        ArgumentNullException.ThrowIfNull(clock);
        if (maximumInputBytes <= 0 || maximumInputBytes == int.MaxValue
            || maximumMountRecords <= 0 || maximumAncestors <= 0 || maximumDuration <= TimeSpan.Zero
            || membershipScratch.Length <= maximumInputBytes || mountScratch.Length <= maximumInputBytes
            || membershipScratch.Overlaps(mountScratch) || clock.TimestampFrequency <= 0)
        {
            return MemoryOperationResult<LinuxCgroupContextCapture>.Reject(MemoryFailure.BoundsViolation);
        }
        if (!OperatingSystem.IsLinux())
        {
            return MemoryOperationResult<LinuxCgroupContextCapture>.Reject(MemoryFailure.UnsupportedCapability);
        }
        Span<byte> member = membershipScratch[..(maximumInputBytes + 1)];
        Span<byte> mounts = mountScratch[..(maximumInputBytes + 1)];
        try
        {
            DateTimeOffset sampledAt = clock.GetUtcNow();
            long started = clock.GetTimestamp();
            long frequency = clock.TimestampFrequency;
            var beforeCgroup = CaptureNamespace("cgroup");
            var beforeMount = CaptureNamespace("mnt");
            var membership = ReadBounded("/proc/self/cgroup", member);
            var mountInfo = ReadBounded("/proc/self/mountinfo", mounts);
            var afterCgroup = CaptureNamespace("cgroup");
            var afterMount = CaptureNamespace("mnt");
            long completed = clock.GetTimestamp();
            DateTimeOffset completedAt = clock.GetUtcNow();
            var resolution = LinuxCgroupScopeResolver.Resolve(member[..membership.Length], mounts[..mountInfo.Length],
                membership.State, mountInfo.State, beforeCgroup.Inode, beforeMount.Inode,
                maximumInputBytes, maximumMountRecords, maximumAncestors);
            MemoryObservationState namespaceState = NamespaceState(beforeCgroup, afterCgroup, beforeMount, afterMount);
            if (namespaceState != MemoryObservationState.Available)
            {
                resolution = new(namespaceState, LinuxCgroupScopeReason.Unavailable, null);
            }
            if (!WithinClockBound(sampledAt, completedAt, started, completed, frequency, clock, maximumDuration))
            {
                resolution = new(MemoryObservationState.Stale, LinuxCgroupScopeReason.Unavailable, null);
            }
            return MemoryOperationResult<LinuxCgroupContextCapture>.Success(new(resolution.State,
                resolution.Reason, resolution.Scope, sampledAt, started, completed, frequency, s_sourceIdentity,
                beforeCgroup.State == MemoryObservationState.Available ? beforeCgroup.Inode : null,
                afterCgroup.State == MemoryObservationState.Available ? afterCgroup.Inode : null,
                beforeMount.State == MemoryObservationState.Available ? beforeMount.Inode : null,
                afterMount.State == MemoryObservationState.Available ? afterMount.Inode : null));
        }
        finally
        {
            member.Clear();
            mounts.Clear();
        }
    }

    public static MemoryObservationState CompareContexts(LinuxCgroupContextCapture before,
        LinuxCgroupContextCapture after, DateTimeOffset now, TimeSpan maximumAge)
    {
        ArgumentNullException.ThrowIfNull(before);
        ArgumentNullException.ThrowIfNull(after);
        if (maximumAge <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumAge));
        }
        if (before.State != MemoryObservationState.Available)
        {
            return before.State;
        }
        if (after.State != MemoryObservationState.Available)
        {
            return after.State;
        }
        if (before.Scope is null || after.Scope is null || before.Source != after.Source
            || before.Scope.Identity != after.Scope.Identity
            || !NamespaceAgrees(before) || !NamespaceAgrees(after)
            || !before.Scope.ObservableDirectories.SequenceEqual(after.Scope.ObservableDirectories, StringComparer.Ordinal))
        {
            return MemoryObservationState.Stale;
        }
        if (before.TimestampFrequency <= 0 || before.TimestampFrequency != after.TimestampFrequency
            || before.Timestamp > before.CompletedTimestamp || before.CompletedTimestamp > after.Timestamp
            || after.Timestamp > after.CompletedTimestamp || after.SampledAt < before.SampledAt
            || after.SampledAt > now || now - before.SampledAt > maximumAge || now - after.SampledAt > maximumAge)
        {
            return MemoryObservationState.Stale;
        }
        try
        {
            long elapsed = checked(after.CompletedTimestamp - before.Timestamp);
            if (elapsed < 0 || elapsed / (double)before.TimestampFrequency > maximumAge.TotalSeconds)
            {
                return MemoryObservationState.Stale;
            }
        }
        catch (OverflowException)
        {
            return MemoryObservationState.Stale;
        }
        return MemoryObservationState.Available;
    }

    private static bool NamespaceAgrees(LinuxCgroupContextCapture capture)
        => capture.Scope is not null && capture.CgroupNamespaceBefore is > 0 && capture.MountNamespaceBefore is > 0
            && capture.CgroupNamespaceBefore == capture.CgroupNamespaceAfter
            && capture.MountNamespaceBefore == capture.MountNamespaceAfter
            && capture.CgroupNamespaceBefore == capture.Scope.Identity.CgroupNamespaceInode
            && capture.MountNamespaceBefore == capture.Scope.Identity.MountNamespaceInode;

    private static (MemoryObservationState State, int Length) ReadBounded(string path, Span<byte> scratch)
    {
        int length = 0;
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1);
            while (length < scratch.Length)
            {
                int read = stream.Read(scratch[length..]);
                if (read == 0)
                {
                    break;
                }
                length += read;
            }
            return (length == scratch.Length ? MemoryObservationState.Malformed : MemoryObservationState.Available, length);
        }
        catch (UnauthorizedAccessException)
        {
            return (MemoryObservationState.Denied, 0);
        }
        catch (IOException)
        {
            return (MemoryObservationState.Unknown, 0);
        }
    }

    private static (MemoryObservationState State, ulong Inode) CaptureNamespace(string name)
    {
        try
        {
            string? target = new FileInfo("/proc/self/ns/" + name).LinkTarget;
            if (target is null)
            {
                return (MemoryObservationState.Unknown, 0);
            }
            if (!target.StartsWith(name + ":[", StringComparison.Ordinal) || !target.EndsWith(']')
                || !ulong.TryParse(target.AsSpan(name.Length + 2, target.Length - name.Length - 3),
                    NumberStyles.None, CultureInfo.InvariantCulture, out ulong inode) || inode == 0)
            {
                return (MemoryObservationState.Malformed, 0);
            }
            return (MemoryObservationState.Available, inode);
        }
        catch (UnauthorizedAccessException)
        {
            return (MemoryObservationState.Denied, 0);
        }
        catch (IOException)
        {
            return (MemoryObservationState.Unknown, 0);
        }
    }

    private static MemoryObservationState NamespaceState((MemoryObservationState State, ulong Inode) beforeCgroup,
        (MemoryObservationState State, ulong Inode) afterCgroup, (MemoryObservationState State, ulong Inode) beforeMount,
        (MemoryObservationState State, ulong Inode) afterMount)
    {
        if (beforeCgroup.State != MemoryObservationState.Available)
        {
            return beforeCgroup.State;
        }
        if (beforeMount.State != MemoryObservationState.Available)
        {
            return beforeMount.State;
        }
        if (afterCgroup.State != MemoryObservationState.Available)
        {
            return afterCgroup.State;
        }
        if (afterMount.State != MemoryObservationState.Available)
        {
            return afterMount.State;
        }
        return beforeCgroup.Inode != afterCgroup.Inode || beforeMount.Inode != afterMount.Inode
            ? MemoryObservationState.Stale : MemoryObservationState.Available;
    }

    private static bool WithinClockBound(DateTimeOffset sampledAt, DateTimeOffset completedAt,
        long started, long completed, long frequency, TimeProvider clock, TimeSpan maximumDuration)
    {
        try
        {
            return frequency == clock.TimestampFrequency && completedAt >= sampledAt
                && completedAt - sampledAt <= maximumDuration && checked(completed - started) >= 0
                && clock.GetElapsedTime(started, completed) <= maximumDuration;
        }
        catch (OverflowException)
        {
            return false;
        }
    }
}
