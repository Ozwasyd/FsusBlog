using System.Security.Cryptography;
using System.Runtime.InteropServices;

using Microsoft.Win32.SafeHandles;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.SchemaMigration;

namespace FsusBlog.Migration;

// Reads the original explicit artifact; no reconstruction, latest discovery or
// second artifact registry. The host's sole publisher supplies its absolute path.
internal sealed class OfflineMigrationCurrentSchemaArtifactReader : IOfflineMigrationVerificationArtifactReader
{
    public async Task<ReadOnlyMemory<byte>> ReadAsync(
        CurrentSchemaArtifactReference artifact, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(artifact);
        CurrentSchemaReceiptCodec.RequireDigest(artifact.Sha256);
        string path = artifact.Reference;
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path)
            || path != Path.GetFullPath(path) || path.Any(char.IsControl)
            || path.Split('/', '\\').Any(value => value.Equals("latest", StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException("current_verify_original_artifact_path_required");
        }

        using SafeFileHandle handle = OpenOriginalRegularFile(path, cancellationToken);
        OriginalRegularFileIdentity initial = CaptureOriginalRegularFileIdentity(path, handle, cancellationToken);
        // The native descriptor has no managed IsAsync metadata. Use its actual
        // handle mode rather than claiming an asynchronous FileStream handle.
        await using var input = new FileStream(handle, FileAccess.Read, 4096);
        long length = input.Length;
        if (length is <= 0 or > CurrentSchemaReceiptCodec.MaximumEncodedBytes)
        {
            throw new InvalidOperationException("current_verify_artifact_size_invalid");
        }
        byte[] bytes = new byte[checked((int)length)];
        await input.ReadExactlyAsync(bytes.AsMemory(), cancellationToken).ConfigureAwait(false);
        byte[] trailing = new byte[1];
        if (await input.ReadAsync(trailing.AsMemory(), cancellationToken).ConfigureAwait(false) != 0)
        {
            throw new InvalidOperationException("current_verify_artifact_changed_during_read");
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != artifact.Sha256)
        {
            throw new InvalidOperationException("current_verify_original_artifact_sha_mismatch");
        }
        ValidateOriginalRegularFileUnchanged(path, handle, initial, cancellationToken);
        return bytes;
    }

    // The original producer may reuse this FD admission, but owns its distinct
    // input byte budget/hash; this port does not enlarge the receipt reader cap.
    internal static SafeFileHandle OpenOriginalRegularFile(string path, CancellationToken cancellationToken)
        => OpenOriginalRegularFileCore(path, cancellationToken, out _);

    // Callers capture before reading and validate after their original byte/hash
    // checks. The token contains native observations, never caller-supplied facts.
    internal static OriginalRegularFileIdentity CaptureOriginalRegularFileIdentity(
        string path, SafeFileHandle handle, CancellationToken cancellationToken)
        => OriginalRegularFileIdentity.Capture(path, handle, cancellationToken);

    internal static void ValidateOriginalRegularFileUnchanged(
        string path, SafeFileHandle handle, OriginalRegularFileIdentity initial, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(initial);
        initial.Validate(path, handle, cancellationToken);
    }

    private static SafeFileHandle OpenOriginalRegularFileCore(
        string path, CancellationToken cancellationToken, out NativeDirectoryIdentity[] directories)
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
        const int directoryFlags = 0x200000 | 0x10000 | 0x20000 | 0x80000; // PATH, DIRECTORY, NOFOLLOW, CLOEXEC
        const int fileFlags = 0x800 | 0x20000 | 0x80000; // RDONLY, NONBLOCK, NOFOLLOW, CLOEXEC
        string[] components = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (components.Length == 0)
            throw new InvalidOperationException("current_verify_regular_artifact_required");
        SafeFileHandle directory = Own(OpenAt(-100, "/", directoryFlags));
        try
        {
            List<NativeDirectoryIdentity> observedDirectories = [ObserveDirectory(directory)];
            foreach (string component in components[..^1])
            {
                cancellationToken.ThrowIfCancellationRequested();
                SafeFileHandle next = Own(OpenAt(directory.DangerousGetHandle().ToInt32(), component, directoryFlags));
                directory.Dispose();
                directory = next;
                observedDirectories.Add(ObserveDirectory(directory));
            }
            cancellationToken.ThrowIfCancellationRequested();
            string name = components[^1];
            NativeFileIdentity before = Observe(directory.DangerousGetHandle().ToInt32(), name, 0x100); // SYMLINK_NOFOLLOW
            RequireRegular(before);
            SafeFileHandle file = Own(OpenAt(directory.DangerousGetHandle().ToInt32(), name, fileFlags));
            try
            {
                // A replaced FIFO cannot block open: NONBLOCK precedes same-FD
                // validation. A replaced symlink cannot be followed at any depth.
                NativeFileIdentity opened = Observe(file.DangerousGetHandle().ToInt32(), "", 0x1000); // EMPTY_PATH
                RequireRegular(opened);
                if (!SameFileIdentity(before, opened))
                    throw new InvalidOperationException("current_verify_artifact_identity_changed");
                cancellationToken.ThrowIfCancellationRequested();
                directories = observedDirectories.ToArray();
                return file;
            }
            catch
            {
                file.Dispose();
                throw;
            }
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
        const uint requiredMask = 0x7df; // BASIC_STATS excluding atime, changed by reading.
        if (Statx(descriptor, name, flags, requiredMask, out NativeFileIdentity identity) != 0
            || (identity.Mask & requiredMask) != requiredMask)
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
        return new(identity.DeviceMajor, identity.DeviceMinor, identity.Inode, identity.Mode);
    }

    private static bool SameFileIdentity(NativeFileIdentity left, NativeFileIdentity right)
        => left.DeviceMajor == right.DeviceMajor && left.DeviceMinor == right.DeviceMinor
            && left.Inode == right.Inode && left.Mode == right.Mode && left.Links == right.Links
            && left.Size == right.Size && left.Uid == right.Uid && left.Gid == right.Gid
            && left.ChangedSeconds == right.ChangedSeconds && left.ChangedNanoseconds == right.ChangedNanoseconds
            && left.ModifiedSeconds == right.ModifiedSeconds && left.ModifiedNanoseconds == right.ModifiedNanoseconds;

    internal sealed class OriginalRegularFileIdentity
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

    private readonly record struct NativeDirectoryIdentity(uint DeviceMajor, uint DeviceMinor, ulong Inode, ushort Mode);

    private static void RequireRegular(NativeFileIdentity identity)
    {
        if ((identity.Mode & 0xf000) != 0x8000)
            throw new InvalidOperationException("current_verify_regular_artifact_required");
    }

    // The 256-byte Linux statx UAPI is architecture-neutral; only required fields
    // are projected. No old architecture-dependent struct stat is guessed here.
    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct NativeFileIdentity
    {
        [FieldOffset(0)] internal uint Mask;
        [FieldOffset(16)] internal uint Links;
        [FieldOffset(20)] internal uint Uid;
        [FieldOffset(24)] internal uint Gid;
        [FieldOffset(28)] internal ushort Mode;
        [FieldOffset(32)] internal ulong Inode;
        [FieldOffset(40)] internal ulong Size;
        [FieldOffset(96)] internal long ChangedSeconds;
        [FieldOffset(104)] internal uint ChangedNanoseconds;
        [FieldOffset(112)] internal long ModifiedSeconds;
        [FieldOffset(120)] internal uint ModifiedNanoseconds;
        [FieldOffset(136)] internal uint DeviceMajor;
        [FieldOffset(140)] internal uint DeviceMinor;
    }

    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenAt(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags,
        uint mask, out NativeFileIdentity identity);
}
