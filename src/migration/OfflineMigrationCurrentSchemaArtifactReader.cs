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
        return bytes;
    }

    private static SafeFileHandle OpenOriginalRegularFile(string path, CancellationToken cancellationToken)
    {
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
            foreach (string component in components[..^1])
            {
                cancellationToken.ThrowIfCancellationRequested();
                SafeFileHandle next = Own(OpenAt(directory.DangerousGetHandle().ToInt32(), component, directoryFlags));
                directory.Dispose();
                directory = next;
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
                if (before.Inode != opened.Inode || before.DeviceMajor != opened.DeviceMajor
                    || before.DeviceMinor != opened.DeviceMinor)
                    throw new InvalidOperationException("current_verify_artifact_identity_changed");
                cancellationToken.ThrowIfCancellationRequested();
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
        if (Statx(descriptor, name, flags, 0x301, out NativeFileIdentity identity) != 0
            || (identity.Mask & 0x301) != 0x301)
            throw new InvalidOperationException("current_verify_native_artifact_identity_unavailable");
        return identity;
    }

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
        [FieldOffset(28)] internal ushort Mode;
        [FieldOffset(32)] internal ulong Inode;
        [FieldOffset(40)] internal ulong Size;
        [FieldOffset(136)] internal uint DeviceMajor;
        [FieldOffset(140)] internal uint DeviceMinor;
    }

    [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
    private static extern int OpenAt(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags,
        uint mask, out NativeFileIdentity identity);
}
