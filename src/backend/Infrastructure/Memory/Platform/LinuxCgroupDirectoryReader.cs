using System.Globalization;
using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

public sealed record LinuxCgroupDirectoryIdentity(int Version, ulong Inode, ulong MountId,
    uint DeviceMajor, uint DeviceMinor)
{
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

public enum LinuxCgroupScalar
{
    UsageBytes, HighBytes, HardLimitBytes, SwapUsageBytes, SwapLimitBytes
}

public sealed record LinuxCgroupScalarCapture(MemoryObservationState State, long? Value, bool Unlimited,
    LinuxCgroupDirectoryIdentity Identity);
public sealed record LinuxCgroupDirectoryProbe(MemoryObservationState State,
    LinuxCgroupDirectoryIdentity? Identity, MemoryFailure? Failure);

/// <summary>
/// Owns a read-only kernel cgroup directory descriptor. Capture uses caller-owned,
/// already admitted scratch and fixed controller filenames. Raw native identity and
/// scalar observations do not qualify a process domain or authorize growth. The caller
/// must validate stable membership/mount context and pair each ancestor's usage/limits.
/// </summary>
public sealed class LinuxCgroupDirectoryReader : IDisposable
{
    private const int DirectoryFlag = 0x10000;
    private const int NoFollowFlag = 0x20000;
    private const int CloseOnExecFlag = 0x80000;
    private const int EmptyPathFlag = 0x1000;
    private const uint IdentityMask = 0x1105;
    private readonly object _gate = new();
    private readonly SafeFileHandle _directory;
    private readonly int _maximumScalarBytes;
    private bool _disposed;

    private LinuxCgroupDirectoryReader(SafeFileHandle directory, LinuxCgroupDirectoryIdentity identity, int maximumScalarBytes)
    {
        _directory = directory;
        Identity = identity;
        _maximumScalarBytes = maximumScalarBytes;
    }

    public LinuxCgroupDirectoryIdentity Identity
    {
        get;
    }

    public static MemoryOperationResult<LinuxCgroupDirectoryIdentity> TryInspectDirectory(string path, int version)
    {
        LinuxCgroupDirectoryProbe probe = ProbeDirectory(path, version);
        return probe.Identity is null
            ? MemoryOperationResult<LinuxCgroupDirectoryIdentity>.Reject(probe.Failure!.Value)
            : MemoryOperationResult<LinuxCgroupDirectoryIdentity>.Success(probe.Identity);
    }

    public static LinuxCgroupDirectoryProbe ProbeDirectory(string path, int version)
    {
        var opened = OpenDirectory(path, version, out MemoryObservationState state);
        if (!opened.Succeeded)
        {
            return new(state, null, opened.Failure);
        }
        using SafeFileHandle handle = opened.Value!;
        var identity = Inspect(handle, version);
        return new(identity.Succeeded ? MemoryObservationState.Available : MemoryObservationState.Unknown,
            identity.Value, identity.Failure);
    }

    /// <summary>
    /// Opens an observed kernel directory only when its complete native identity still
    /// matches. This raw read surface has no process-membership or admission authority.
    /// </summary>
    public static MemoryOperationResult<LinuxCgroupDirectoryReader> TryOpenObservedDirectory(string path,
        LinuxCgroupDirectoryIdentity expected, int maximumScalarBytes)
    {
        ArgumentNullException.ThrowIfNull(expected);
        if (maximumScalarBytes <= 0 || maximumScalarBytes == int.MaxValue)
        {
            return MemoryOperationResult<LinuxCgroupDirectoryReader>.Reject(MemoryFailure.BoundsViolation);
        }
        var opened = OpenDirectory(path, expected.Version, out _);
        if (!opened.Succeeded)
        {
            return MemoryOperationResult<LinuxCgroupDirectoryReader>.Reject(opened.Failure!.Value);
        }
        SafeFileHandle handle = opened.Value!;
        bool transferred = false;
        try
        {
            var inspected = Inspect(handle, expected.Version);
            if (!inspected.Succeeded || inspected.Value != expected)
            {
                return MemoryOperationResult<LinuxCgroupDirectoryReader>.Reject(inspected.Failure ?? MemoryFailure.StaleLocation);
            }
            var result = MemoryOperationResult<LinuxCgroupDirectoryReader>.Success(new(handle, expected, maximumScalarBytes));
            transferred = true;
            return result;
        }
        finally
        {
            if (!transferred)
            {
                handle.Dispose();
            }
        }
    }

    public static MemoryOperationResult<LinuxCgroupDirectoryReader> TryOpen(LinuxCgroupScope scope,
        int ancestorIndex, int maximumScalarBytes)
    {
        ArgumentNullException.ThrowIfNull(scope);
        ArgumentNullException.ThrowIfNull(scope.Identity);
        ArgumentNullException.ThrowIfNull(scope.ObservableDirectories);
        if (!OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            return MemoryOperationResult<LinuxCgroupDirectoryReader>.Reject(MemoryFailure.UnsupportedCapability);
        }
        if (maximumScalarBytes <= 0 || maximumScalarBytes == int.MaxValue || ancestorIndex < 0
            || ancestorIndex >= scope.ObservableDirectories.Count || !ValidPath(scope.Identity.MountRoot)
            || !ValidPath(scope.Identity.MembershipPath) || !ValidPath(scope.Identity.MountPoint))
        {
            return MemoryOperationResult<LinuxCgroupDirectoryReader>.Reject(MemoryFailure.BoundsViolation);
        }
        if (!NamespaceMatches("cgroup", scope.Identity.CgroupNamespaceInode)
            || !NamespaceMatches("mnt", scope.Identity.MountNamespaceInode))
        {
            return MemoryOperationResult<LinuxCgroupDirectoryReader>.Reject(MemoryFailure.StaleLocation);
        }
        string path = scope.ObservableDirectories[ancestorIndex];
        if (!ValidPath(path) || !MatchesAncestor(scope, path, ancestorIndex))
        {
            return MemoryOperationResult<LinuxCgroupDirectoryReader>.Reject(MemoryFailure.BoundsViolation);
        }
        var opened = OpenDirectory(path, scope.Identity.Version, out _);
        if (!opened.Succeeded)
        {
            return MemoryOperationResult<LinuxCgroupDirectoryReader>.Reject(opened.Failure!.Value);
        }
        SafeFileHandle handle = opened.Value!;
        bool transferred = false;
        try
        {
            var inspected = Inspect(handle, scope.Identity.Version);
            if (!inspected.Succeeded)
            {
                return MemoryOperationResult<LinuxCgroupDirectoryReader>.Reject(inspected.Failure!.Value);
            }
            LinuxCgroupDirectoryIdentity identity = inspected.Value!;
            string device = identity.DeviceMajor.ToString(CultureInfo.InvariantCulture) + ":"
                + identity.DeviceMinor.ToString(CultureInfo.InvariantCulture);
            if (scope.Identity.MountId <= 0 || identity.MountId != (ulong)scope.Identity.MountId
                || device != scope.Identity.DeviceIdentity)
            {
                return MemoryOperationResult<LinuxCgroupDirectoryReader>.Reject(MemoryFailure.StaleLocation);
            }
            var result = MemoryOperationResult<LinuxCgroupDirectoryReader>.Success(new(handle, identity, maximumScalarBytes));
            transferred = true;
            return result;
        }
        finally
        {
            if (!transferred)
            {
                handle.Dispose();
            }
        }
    }

    public LinuxCgroupScalarCapture Capture(LinuxCgroupScalar scalar, Span<byte> admittedScratch)
    {
        if (!Enum.IsDefined(scalar) || admittedScratch.Length <= _maximumScalarBytes)
        {
            throw new ArgumentException("Capture requires the declared scratch bound plus one overflow byte.", nameof(admittedScratch));
        }
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var before = Inspect(_directory, Identity.Version);
            if (!before.Succeeded)
            {
                return new(MemoryObservationState.Unknown, null, false, Identity);
            }
            if (before.Value != Identity)
            {
                return new(MemoryObservationState.Stale, null, false, Identity);
            }
            string? name = FileName(Identity.Version, scalar);
            if (name is null)
            {
                return new(MemoryObservationState.Unknown, null, false, Identity);
            }
            Span<byte> scratch = admittedScratch[..(_maximumScalarBytes + 1)];
            try
            {
                int fd = OpenAt(_directory, name, NoFollowFlag | CloseOnExecFlag, 0);
                if (fd < 0)
                {
                    int error = Marshal.GetLastPInvokeError();
                    return new(error is 1 or 13 ? MemoryObservationState.Denied : MemoryObservationState.Unknown,
                        null, false, Identity);
                }
                using var file = new SafeFileHandle(fd, true);
                if (!SameFileDomain(file))
                {
                    return new(MemoryObservationState.Unknown, null, false, Identity);
                }
                using var stream = new FileStream(file, FileAccess.Read, 1, isAsync: false);
                int length = 0;
                while (length < scratch.Length)
                {
                    int read = stream.Read(scratch[length..]);
                    if (read == 0)
                    {
                        break;
                    }
                    length += read;
                }
                if (length == scratch.Length)
                {
                    return new(MemoryObservationState.Malformed, null, false, Identity);
                }
                var after = Inspect(_directory, Identity.Version);
                if (!after.Succeeded)
                {
                    return new(MemoryObservationState.Unknown, null, false, Identity);
                }
                if (after.Value != Identity)
                {
                    return new(MemoryObservationState.Stale, null, false, Identity);
                }
                return ParseScalar(scratch[..length], scalar is LinuxCgroupScalar.HighBytes or LinuxCgroupScalar.HardLimitBytes
                    or LinuxCgroupScalar.SwapLimitBytes, Identity);
            }
            catch (UnauthorizedAccessException)
            {
                return new(MemoryObservationState.Denied, null, false, Identity);
            }
            catch (IOException)
            {
                return new(MemoryObservationState.Unknown, null, false, Identity);
            }
            finally
            {
                scratch.Clear();
            }
        }
    }

    internal static LinuxCgroupScalarCapture ParseScalar(ReadOnlySpan<byte> bytes, bool limit, LinuxCgroupDirectoryIdentity identity)
    {
        bytes = bytes.Trim(" \t\r\n"u8);
        if (limit && bytes.SequenceEqual("max"u8))
        {
            return new(MemoryObservationState.Unknown, null, true, identity);
        }
        if (bytes.IsEmpty)
        {
            return new(MemoryObservationState.Unknown, null, false, identity);
        }
        long value = 0;
        try
        {
            foreach (byte digit in bytes)
            {
                if (digit is < (byte)'0' or > (byte)'9')
                {
                    return new(MemoryObservationState.Malformed, null, false, identity);
                }
                value = checked(value * 10 + (digit - (byte)'0'));
            }
        }
        catch (OverflowException)
        {
            return new(MemoryObservationState.Malformed, null, false, identity);
        }
        return new(MemoryObservationState.Available, value, false, identity);
    }

    private bool SameFileDomain(SafeFileHandle file)
        => Statx(file, "", EmptyPathFlag, IdentityMask, out NativeIdentity identity) == 0
            && (identity._mask & IdentityMask) == IdentityMask && (identity._mode & 0xf000) == 0x8000
            && identity._links != 0 && identity._mountId == Identity.MountId
            && identity._deviceMajor == Identity.DeviceMajor && identity._deviceMinor == Identity.DeviceMinor;

    private static string? FileName(int version, LinuxCgroupScalar scalar) => (version, scalar) switch
    {
        (2, LinuxCgroupScalar.UsageBytes) => "memory.current",
        (2, LinuxCgroupScalar.HighBytes) => "memory.high",
        (2, LinuxCgroupScalar.HardLimitBytes) => "memory.max",
        (2, LinuxCgroupScalar.SwapUsageBytes) => "memory.swap.current",
        (2, LinuxCgroupScalar.SwapLimitBytes) => "memory.swap.max",
        (1, LinuxCgroupScalar.UsageBytes) => "memory.usage_in_bytes",
        (1, LinuxCgroupScalar.HardLimitBytes) => "memory.limit_in_bytes",
        // v1 memsw combines memory+swap and must not be called swap occupancy.
        _ => null
    };

    private static MemoryOperationResult<SafeFileHandle> OpenDirectory(string path, int version,
        out MemoryObservationState state)
    {
        state = MemoryObservationState.Unknown;
        if (!OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            return MemoryOperationResult<SafeFileHandle>.Reject(MemoryFailure.UnsupportedCapability);
        }
        if (!ValidPath(path) || version is not (1 or 2))
        {
            state = MemoryObservationState.Malformed;
            return MemoryOperationResult<SafeFileHandle>.Reject(MemoryFailure.BoundsViolation);
        }
        int fd = Open(path, DirectoryFlag | NoFollowFlag | CloseOnExecFlag, 0);
        if (fd < 0)
        {
            int error = Marshal.GetLastPInvokeError();
            state = error is 1 or 13 ? MemoryObservationState.Denied : MemoryObservationState.Unknown;
        }
        else
        {
            state = MemoryObservationState.Available;
        }
        return fd < 0 ? MemoryOperationResult<SafeFileHandle>.Reject(MemoryFailure.TierUnavailable)
            : MemoryOperationResult<SafeFileHandle>.Success(new(fd, true));
    }

    private static MemoryOperationResult<LinuxCgroupDirectoryIdentity> Inspect(SafeFileHandle handle, int version)
    {
        try
        {
            if (FileSystemStats(handle, out NativeFileSystem fs) != 0
                || fs._type != (version == 2 ? 0x63677270 : 0x27e0eb))
            {
                return MemoryOperationResult<LinuxCgroupDirectoryIdentity>.Reject(MemoryFailure.UnsupportedCapability);
            }
            if (Statx(handle, "", EmptyPathFlag, IdentityMask, out NativeIdentity identity) != 0
                || (identity._mask & IdentityMask) != IdentityMask || (identity._mode & 0xf000) != 0x4000
                || identity._inode == 0 || identity._links == 0 || identity._mountId == 0)
            {
                return MemoryOperationResult<LinuxCgroupDirectoryIdentity>.Reject(MemoryFailure.TierUnavailable);
            }
            return MemoryOperationResult<LinuxCgroupDirectoryIdentity>.Success(new(version, identity._inode,
                identity._mountId, identity._deviceMajor, identity._deviceMinor));
        }
        catch (EntryPointNotFoundException)
        {
            return MemoryOperationResult<LinuxCgroupDirectoryIdentity>.Reject(MemoryFailure.UnsupportedCapability);
        }
    }

    private static bool NamespaceMatches(string name, ulong expected)
    {
        try
        {
            string? target = new FileInfo("/proc/self/ns/" + name).LinkTarget;
            return expected != 0 && target is not null && target.StartsWith(name + ":[", StringComparison.Ordinal)
                && target.EndsWith(']') && ulong.TryParse(target.AsSpan(name.Length + 2, target.Length - name.Length - 3),
                    NumberStyles.None, CultureInfo.InvariantCulture, out ulong observed) && observed == expected;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool ValidPath(string? path)
        => !string.IsNullOrWhiteSpace(path) && path.Length <= 4096 && path.StartsWith('/') && !path.Contains('\0')
            && !path.Split('/').Any(part => part is "." or "..");

    private static bool MatchesAncestor(LinuxCgroupScope scope, string path, int index)
    {
        string member = scope.Identity.MembershipPath;
        string root = scope.Identity.MountRoot;
        if (root != "/" && member != root && !member.StartsWith(root + "/", StringComparison.Ordinal))
        {
            return false;
        }
        string relative = root == "/" ? member[1..] : member[root.Length..].TrimStart('/');
        string cursor = relative.Length == 0 ? scope.Identity.MountPoint
            : scope.Identity.MountPoint == "/" ? "/" + relative : scope.Identity.MountPoint + "/" + relative;
        for (int ancestor = 0; ancestor < index; ancestor++)
        {
            if (cursor == scope.Identity.MountPoint)
            {
                return false;
            }
            int slash = cursor.LastIndexOf('/');
            cursor = slash == 0 ? "/" : cursor[..slash];
        }
        return cursor == path;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (!_disposed)
            {
                _disposed = true;
                _directory.Dispose();
            }
        }
    }

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct NativeIdentity
    {
        [FieldOffset(0)] internal uint _mask;
        [FieldOffset(16)] internal uint _links;
        [FieldOffset(28)] internal ushort _mode;
        [FieldOffset(32)] internal ulong _inode;
        [FieldOffset(136)] internal uint _deviceMajor;
        [FieldOffset(140)] internal uint _deviceMinor;
        [FieldOffset(144)] internal ulong _mountId;
    }

    [StructLayout(LayoutKind.Explicit, Size = 120)]
    private struct NativeFileSystem
    {
        [FieldOffset(0)] internal long _type;
    }

    [DllImport("libc", EntryPoint = "open", SetLastError = true)]
    private static extern int Open(string path, int flags, uint mode);
    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenAt(SafeFileHandle directory, string name, int flags, uint mode);
    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(SafeFileHandle file, string name, int flags, uint mask, out NativeIdentity identity);
    [DllImport("libc", EntryPoint = "fstatfs", SetLastError = true)]
    private static extern int FileSystemStats(SafeFileHandle file, out NativeFileSystem identity);
}
