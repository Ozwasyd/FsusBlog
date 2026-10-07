using System.Security.Cryptography;

using Microsoft.Win32.SafeHandles;

using FsusBlog.Algorithms.IO;
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

    // Preserve the original Migration surface and caller-owned budgets. Native
    // observation belongs to the sole neutral Shared owner.
    internal static SafeFileHandle OpenOriginalRegularFile(string path, CancellationToken cancellationToken)
        => NativeRegularFileGuard.OpenOriginalRegularFile(path, cancellationToken);

    internal static OriginalRegularFileIdentity CaptureOriginalRegularFileIdentity(
        string path, SafeFileHandle handle, CancellationToken cancellationToken)
        => new(NativeRegularFileGuard.CaptureOriginalRegularFileIdentity(path, handle, cancellationToken));

    internal static void ValidateOriginalRegularFileUnchanged(
        string path, SafeFileHandle handle, OriginalRegularFileIdentity initial, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(initial);
        NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(path, handle, initial.Native, cancellationToken);
    }

    internal static OriginalHeldRegularFileIdentity CaptureOriginalHeldRegularFileIdentity(
        string path, SafeFileHandle nonOwningActualFd, CancellationToken cancellationToken)
        => new(NativeRegularFileGuard.CaptureOriginalHeldRegularFileIdentity(path, nonOwningActualFd, cancellationToken));

    internal static void ValidateOriginalHeldRegularFileUnchanged(
        string path, SafeFileHandle nonOwningActualFd, OriginalHeldRegularFileIdentity initial,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(initial);
        NativeRegularFileGuard.ValidateOriginalHeldRegularFileUnchanged(path, nonOwningActualFd, initial.Native,
            cancellationToken);
    }

    internal sealed class OriginalRegularFileIdentity(NativeRegularFileGuard.OriginalRegularFileIdentity native)
    {
        internal NativeRegularFileGuard.OriginalRegularFileIdentity Native { get; } = native;
    }

    internal sealed class OriginalHeldRegularFileIdentity(NativeRegularFileGuard.OriginalHeldRegularFileIdentity native)
    {
        internal NativeRegularFileGuard.OriginalHeldRegularFileIdentity Native { get; } = native;
        internal uint DeviceMajor => Native.DeviceMajor;
        internal uint DeviceMinor => Native.DeviceMinor;
        internal ulong Inode => Native.Inode;
    }
}
