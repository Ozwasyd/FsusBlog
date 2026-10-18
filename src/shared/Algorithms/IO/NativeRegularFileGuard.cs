using System.Runtime.InteropServices;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.Algorithms.IO;

// Single native original-file identity owner shared by Server and Migration.
// Callers retain their own byte/hash budgets and never construct identity tokens.
// Existing current_verify_* refusal codes remain stable for original consumers.
public static class NativeRegularFileGuard
{
    // The original producer may reuse this FD admission, but owns its distinct
    // input byte budget/hash; this port does not enlarge the receipt reader cap.
    public static SafeFileHandle OpenOriginalRegularFile(string path, CancellationToken cancellationToken)
        => OpenOriginalRegularFileCore(path, cancellationToken, out _);

    // Callers capture before reading and validate after their original byte/hash
    // checks. The token contains native observations, never caller-supplied facts.
    public static OriginalRegularFileIdentity CaptureOriginalRegularFileIdentity(
        string path, SafeFileHandle handle, CancellationToken cancellationToken)
        => OriginalRegularFileIdentity.Capture(path, handle, cancellationToken);

    public static void ValidateOriginalRegularFileUnchanged(
        string path, SafeFileHandle handle, OriginalRegularFileIdentity initial, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(initial);
        initial.Validate(path, handle, cancellationToken);
    }

    // A live database owner supplies its actual native FD through a non-owning
    // wrapper. Never reopen/close the DB leaf: POSIX record locks are process-wide
    // and closing another FD for that inode can release SQLite's held locks.
    public static OriginalHeldRegularFileIdentity CaptureOriginalHeldRegularFileIdentity(
        string path, SafeFileHandle nonOwningActualFd, CancellationToken cancellationToken)
        => OriginalHeldRegularFileIdentity.Capture(path, nonOwningActualFd, cancellationToken);

    public static void ValidateOriginalHeldRegularFileUnchanged(
        string path, SafeFileHandle nonOwningActualFd, OriginalHeldRegularFileIdentity initial,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(initial);
        initial.Validate(path, nonOwningActualFd, cancellationToken);
    }

    private static SafeFileHandle OpenOriginalRegularFileCore(
        string path, CancellationToken cancellationToken, out NativeDirectoryIdentity[] directories)
        => WithOriginalParentDirectory(path, cancellationToken, (directory, name) =>
        {
            const int FileFlags = 0x800 | 0x20000 | 0x80000; // RDONLY, NONBLOCK, NOFOLLOW, CLOEXEC
            NativeFileIdentity before = Observe(directory.DangerousGetHandle().ToInt32(), name, 0x100); // SYMLINK_NOFOLLOW
            RequireRegular(before);
            SafeFileHandle file = Own(OpenAt(directory.DangerousGetHandle().ToInt32(), name, FileFlags));
            try
            {
                // A replaced FIFO cannot block open: NONBLOCK precedes same-FD
                // validation. A replaced symlink cannot be followed at any depth.
                NativeFileIdentity opened = Observe(file.DangerousGetHandle().ToInt32(), "", 0x1000); // EMPTY_PATH
                RequireRegular(opened);
                if (!SameFileIdentity(before, opened))
                    throw new InvalidOperationException("current_verify_artifact_identity_changed");
                cancellationToken.ThrowIfCancellationRequested();
                return file;
            }
            catch
            {
                file.Dispose();
                throw;
            }
        }, out directories);

    private static TResult WithOriginalParentDirectory<TResult>(
        string path, CancellationToken cancellationToken, Func<SafeFileHandle, string, TResult> observeLeaf,
        out NativeDirectoryIdentity[] directories)
    {
        directories = [];
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path)
            || path != Path.GetFullPath(path) || path.Any(char.IsControl))
            throw new InvalidOperationException("current_verify_original_artifact_path_required");
        // Linux UAPI flags/layout below are explicit. No generic synchronous-open
        // fallback is accepted on an unowned platform or architecture.
        if (!OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
            throw new InvalidOperationException("current_verify_native_file_owner_unavailable");
        const int DirectoryFlags = 0x200000 | 0x10000 | 0x20000 | 0x80000; // PATH, DIRECTORY, NOFOLLOW, CLOEXEC
        string[] components = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (components.Length == 0)
            throw new InvalidOperationException("current_verify_regular_artifact_required");
        SafeFileHandle directory = Own(OpenAt(-100, "/", DirectoryFlags));
        try
        {
            List<NativeDirectoryIdentity> observedDirectories = [ObserveDirectory(directory)];
            foreach (string component in components[..^1])
            {
                cancellationToken.ThrowIfCancellationRequested();
                SafeFileHandle next = Own(OpenAt(directory.DangerousGetHandle().ToInt32(), component, DirectoryFlags));
                directory.Dispose();
                directory = next;
                observedDirectories.Add(ObserveDirectory(directory));
            }
            cancellationToken.ThrowIfCancellationRequested();
            NativeDirectoryIdentity[] completedDirectories = observedDirectories.ToArray();
            TResult result = observeLeaf(directory, components[^1]);
            directories = completedDirectories;
            return result;
        }
        finally
        {
            directory.Dispose();
        }
    }

    private static SafeFileHandle Own(int descriptor)
        => descriptor >= 0 ? new SafeFileHandle((IntPtr)descriptor, ownsHandle: true)
            : throw new InvalidOperationException("current_verify_native_artifact_open_refused");

    private static NativeFileIdentity Observe(int descriptor, string name, int flags)
    {
        const uint RequiredMask = 0x7df; // BASIC_STATS excluding atime, changed by reading.
        if (Statx(descriptor, name, flags, RequiredMask, out NativeFileIdentity identity) != 0
            || (identity._mask & RequiredMask) != RequiredMask)
            throw new InvalidOperationException("current_verify_native_artifact_identity_unavailable");
        return identity;
    }

    private static NativeFileIdentity ObserveHandle(SafeFileHandle handle)
    {
        ArgumentNullException.ThrowIfNull(handle);
        bool retained = false;
        try
        {
            handle.DangerousAddRef(ref retained);
            if (handle.IsInvalid)
                throw new InvalidOperationException("current_verify_artifact_identity_changed");
            return Observe(handle.DangerousGetHandle().ToInt32(), "", 0x1000); // EMPTY_PATH
        }
        finally
        {
            if (retained)
                handle.DangerousRelease();
        }
    }

    private static NativeDirectoryIdentity ObserveDirectory(SafeFileHandle directory)
    {
        NativeFileIdentity identity = ObserveHandle(directory);
        return new(identity._deviceMajor, identity._deviceMinor, identity._inode, identity._mode);
    }

    private static bool SameFileIdentity(NativeFileIdentity left, NativeFileIdentity right)
        => left._deviceMajor == right._deviceMajor && left._deviceMinor == right._deviceMinor
            && left._inode == right._inode && left._mode == right._mode && left._links == right._links
            && left._size == right._size && left._uid == right._uid && left._gid == right._gid
            && left._changedSeconds == right._changedSeconds && left._changedNanoseconds == right._changedNanoseconds
            && left._modifiedSeconds == right._modifiedSeconds && left._modifiedNanoseconds == right._modifiedNanoseconds;

    public sealed class OriginalRegularFileIdentity
    {
        private readonly string _path;
        private readonly SafeFileHandle _handle;
        private readonly NativeFileIdentity _identity;
        private readonly NativeDirectoryIdentity[] _directories;

        private OriginalRegularFileIdentity(string path, SafeFileHandle handle, NativeFileIdentity identity,
            NativeDirectoryIdentity[] directories)
        {
            _path = path;
            _handle = handle;
            _identity = identity;
            _directories = directories;
        }

        internal static OriginalRegularFileIdentity Capture(string path, SafeFileHandle handle, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ArgumentNullException.ThrowIfNull(handle);
            using SafeFileHandle current = OpenOriginalRegularFileCore(path, cancellationToken, out NativeDirectoryIdentity[] directories);
            NativeFileIdentity initial = ObserveHandle(handle);
            RequireRegular(initial);
            if (!SameFileIdentity(initial, ObserveHandle(current)) || !SameFileIdentity(initial, ObserveHandle(handle)))
                throw new InvalidOperationException("current_verify_artifact_identity_changed");
            cancellationToken.ThrowIfCancellationRequested();
            return new(path, handle, initial, directories);
        }

        internal void Validate(string path, SafeFileHandle handle, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (path != _path || !ReferenceEquals(handle, _handle) || !SameFileIdentity(_identity, ObserveHandle(handle)))
                throw new InvalidOperationException("current_verify_artifact_identity_changed");
            using SafeFileHandle current = OpenOriginalRegularFileCore(path, cancellationToken, out NativeDirectoryIdentity[] directories);
            if (!_directories.SequenceEqual(directories) || !SameFileIdentity(_identity, ObserveHandle(current))
                || !SameFileIdentity(_identity, ObserveHandle(handle)))
                throw new InvalidOperationException("current_verify_artifact_identity_changed");
            cancellationToken.ThrowIfCancellationRequested();
        }
    }

    public sealed class OriginalHeldRegularFileIdentity
    {
        private readonly string _path;
        private readonly SafeFileHandle _handle;
        private readonly NativeDirectoryIdentity[] _directories;

        // Only the actual native observation constructs this identity. Live DB
        // content/size/time/link-count changes are not namespace-incarnation drift.
        public uint DeviceMajor { get; }
        public uint DeviceMinor { get; }
        public ulong Inode { get; }

        private OriginalHeldRegularFileIdentity(string path, SafeFileHandle handle,
            NativeFileIdentity identity, NativeDirectoryIdentity[] directories)
        {
            _path = path;
            _handle = handle;
            _directories = directories;
            DeviceMajor = identity._deviceMajor;
            DeviceMinor = identity._deviceMinor;
            Inode = identity._inode;
        }

        internal static OriginalHeldRegularFileIdentity Capture(
            string path, SafeFileHandle handle, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            NativeFileIdentity named = ObserveHeldPath(path, cancellationToken, out NativeDirectoryIdentity[] directories);
            NativeFileIdentity actual = ObserveHandle(handle);
            RequireRegular(actual);
            if (!SameIncarnation(actual, named) || !SameIncarnation(actual, ObserveHandle(handle)))
                throw new InvalidOperationException("current_verify_held_file_identity_changed");
            cancellationToken.ThrowIfCancellationRequested();
            return new(path, handle, actual, directories);
        }

        internal void Validate(string path, SafeFileHandle handle, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (path != _path || !ReferenceEquals(handle, _handle) || !Matches(ObserveHandle(handle)))
                throw new InvalidOperationException("current_verify_held_file_identity_changed");
            NativeFileIdentity named = ObserveHeldPath(path, cancellationToken, out NativeDirectoryIdentity[] directories);
            if (!_directories.SequenceEqual(directories) || !Matches(named) || !Matches(ObserveHandle(handle)))
                throw new InvalidOperationException("current_verify_held_file_identity_changed");
            cancellationToken.ThrowIfCancellationRequested();
        }

        private bool Matches(NativeFileIdentity identity)
            => (identity._mode & 0xf000) == 0x8000 && identity._deviceMajor == DeviceMajor
                && identity._deviceMinor == DeviceMinor && identity._inode == Inode;

        private static bool SameIncarnation(NativeFileIdentity left, NativeFileIdentity right)
            => (right._mode & 0xf000) == 0x8000 && left._deviceMajor == right._deviceMajor
                && left._deviceMinor == right._deviceMinor && left._inode == right._inode;

        private static NativeFileIdentity ObserveHeldPath(
            string path, CancellationToken cancellationToken, out NativeDirectoryIdentity[] directories)
            => WithOriginalParentDirectory(path, cancellationToken, (directory, name) =>
            {
                NativeFileIdentity named = Observe(directory.DangerousGetHandle().ToInt32(), name, 0x100); // SYMLINK_NOFOLLOW
                RequireRegular(named);
                return named;
            }, out directories);
    }

    private readonly record struct NativeDirectoryIdentity(uint DeviceMajor, uint DeviceMinor, ulong Inode, ushort Mode);

    private static void RequireRegular(NativeFileIdentity identity)
    {
        if ((identity._mode & 0xf000) != 0x8000)
            throw new InvalidOperationException("current_verify_regular_artifact_required");
    }

    // The 256-byte Linux statx UAPI is architecture-neutral; only required fields
    // are projected. No old architecture-dependent struct stat is guessed here.
    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct NativeFileIdentity
    {
        [FieldOffset(0)] internal uint _mask;
        [FieldOffset(16)] internal uint _links;
        [FieldOffset(20)] internal uint _uid;
        [FieldOffset(24)] internal uint _gid;
        [FieldOffset(28)] internal ushort _mode;
        [FieldOffset(32)] internal ulong _inode;
        [FieldOffset(40)] internal ulong _size;
        [FieldOffset(96)] internal long _changedSeconds;
        [FieldOffset(104)] internal uint _changedNanoseconds;
        [FieldOffset(112)] internal long _modifiedSeconds;
        [FieldOffset(120)] internal uint _modifiedNanoseconds;
        [FieldOffset(136)] internal uint _deviceMajor;
        [FieldOffset(140)] internal uint _deviceMinor;
    }

    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenAt(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mask, out NativeFileIdentity identity);
}
