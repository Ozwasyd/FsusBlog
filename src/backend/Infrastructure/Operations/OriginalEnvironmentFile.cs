using System.Security.Cryptography;

using FsusBlog.Algorithms.IO;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.Server.Infrastructure.Operations;

/// <summary>
/// Owns bounded original environment bytes and their live regular-file identity.
/// This is not a private-owner, single-link or atomic process-launch capability.
/// </summary>
public sealed class OriginalEnvironmentFile : IDisposable
{
    /// <summary>Server configuration budget, independent of any receipt reader budget.</summary>
    public const int MaximumEncodedBytes = 1024 * 1024;

    private readonly SafeFileHandle _handle;
    private readonly NativeRegularFileGuard.OriginalRegularFileIdentity _identity;
    private readonly byte[] _bytes;
    private bool _disposed;

    /// <summary>The once-resolved original input path; symbolic links are never followed.</summary>
    public string CanonicalPath { get; }

    /// <summary>SHA256 of the same original FD bytes consumed by the literal parser.</summary>
    public string ArtifactSha256 { get; }

    /// <summary>Comparison data from the actual captured full native epoch, not an identity import capability.</summary>
    public string ObservationSha256 => _identity.ObservationSha256;

    /// <summary>Immutable configuration literals, never interpolated or persisted by this owner.</summary>
    public IReadOnlyDictionary<string, string?> Values { get; }

    private OriginalEnvironmentFile(string path, SafeFileHandle handle,
        NativeRegularFileGuard.OriginalRegularFileIdentity identity, byte[] bytes,
        IReadOnlyDictionary<string, string?> values)
    {
        CanonicalPath = path;
        _handle = handle;
        _identity = identity;
        _bytes = bytes;
        Values = values;
        ArtifactSha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
    }

    internal static OriginalEnvironmentFile Open(string path, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrEmpty(path) || path.Any(char.IsControl))
            throw new InvalidOperationException("server_env_file_path_invalid");
        // Preserve relative passkey inputs without trimming path characters.
        string canonicalPath = Path.GetFullPath(path);
        SafeFileHandle handle = NativeRegularFileGuard.OpenOriginalRegularFile(canonicalPath, cancellationToken);
        return OpenHeldOriginal(canonicalPath, handle, null, null, cancellationToken);
    }

    internal static OriginalEnvironmentFile OpenFromInheritedDescriptor(
        string canonicalPath, int inheritedDescriptor,
        string expectedArtifactSha256, string expectedObservationSha256,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequireExpectedDigest(expectedArtifactSha256, "server_env_file_artifact_digest_invalid");
        RequireExpectedDigest(expectedObservationSha256, "server_env_file_epoch_digest_invalid");
        if (string.IsNullOrEmpty(canonicalPath) || !Path.IsPathFullyQualified(canonicalPath)
            || canonicalPath != Path.GetFullPath(canonicalPath) || canonicalPath.Any(char.IsControl))
            throw new InvalidOperationException("server_env_file_original_path_required");
        if (inheritedDescriptor < 3)
            throw new InvalidOperationException("server_env_file_inherited_descriptor_invalid");
        // The carrier owns its actual descriptor. This lease owns only the
        // kernel duplicate; neither the integer nor expected hashes are authority.
        using var actual = new SafeFileHandle((IntPtr)inheritedDescriptor, ownsHandle: false);
        SafeFileHandle duplicate = NativeRegularFileGuard.DuplicateOriginalReadOnlyRegularFile(actual, cancellationToken);
        return OpenHeldOriginal(canonicalPath, duplicate, expectedArtifactSha256,
            expectedObservationSha256, cancellationToken);
    }

    private static OriginalEnvironmentFile OpenHeldOriginal(string path, SafeFileHandle handle,
        string? expectedArtifactSha256, string? expectedObservationSha256,
        CancellationToken cancellationToken)
    {
        byte[]? bytes = null;
        try
        {
            NativeRegularFileGuard.OriginalRegularFileIdentity identity =
                NativeRegularFileGuard.CaptureOriginalRegularFileIdentity(path, handle, cancellationToken);
            if (expectedObservationSha256 is not null)
                identity.RequireObservedEpochSha256(expectedObservationSha256);
            bytes = ReadBoundedBytes(handle, cancellationToken);
            if (expectedArtifactSha256 is not null
                && !CryptographicOperations.FixedTimeEquals(
                    Convert.FromHexString(expectedArtifactSha256), SHA256.HashData(bytes)))
                throw new InvalidOperationException("server_env_file_original_bytes_changed");
            NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(path, handle, identity, cancellationToken);
            IReadOnlyDictionary<string, string?> values =
                ServerCommandEnvironmentFile.ParseOriginalBytes(bytes, cancellationToken);
            NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(path, handle, identity, cancellationToken);
            return new OriginalEnvironmentFile(path, handle, identity, bytes, values);
        }
        catch
        {
            if (bytes is not null)
                CryptographicOperations.ZeroMemory(bytes);
            handle.Dispose();
            throw;
        }
    }

    private static void RequireExpectedDigest(string digest, string code)
    {
        if (digest is null || digest.Length != 64
            || digest.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
            throw new InvalidOperationException(code);
    }

    /// <summary>Rechecks the actual held FD, original namespace and exact captured bytes.</summary>
    public void ValidateUnchanged(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ObjectDisposedException.ThrowIf(_disposed, this);
        NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(
            CanonicalPath, _handle, _identity, cancellationToken);
        byte[] current = ReadBoundedBytes(_handle, cancellationToken);
        try
        {
            if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(_bytes), SHA256.HashData(current)))
                throw new InvalidOperationException("server_env_file_original_bytes_changed");
            NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(
                CanonicalPath, _handle, _identity, cancellationToken);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(current);
        }
    }

    private static byte[] ReadBoundedBytes(SafeFileHandle handle, CancellationToken cancellationToken)
    {
        // dup/SCM_RIGHTS share an open-file description. Explicit offsets avoid
        // changing the original carrier's position, including repeated rehashes.
        long length = RandomAccess.GetLength(handle);
        if (length is < 0 or > MaximumEncodedBytes)
            throw new InvalidOperationException("server_env_file_size_invalid");
        // Permit the original empty-file parser semantics. One trailing byte
        // detects growth without unbounded IO, even at the exact maximum.
        byte[] bytes = new byte[checked((int)length)];
        try
        {
            int read = 0;
            while (read < bytes.Length)
            {
                cancellationToken.ThrowIfCancellationRequested();
                int count = RandomAccess.Read(handle, bytes.AsSpan(read, Math.Min(4096, bytes.Length - read)), read);
                if (count == 0)
                    throw new InvalidOperationException("server_env_file_size_changed");
                read += count;
            }
            cancellationToken.ThrowIfCancellationRequested();
            Span<byte> trailing = stackalloc byte[1];
            int trailingCount;
            try
            {
                trailingCount = RandomAccess.Read(handle, trailing, length);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(trailing);
            }
            if (trailingCount != 0)
                throw new InvalidOperationException("server_env_file_size_changed");
            cancellationToken.ThrowIfCancellationRequested();
            return bytes;
        }
        catch
        {
            CryptographicOperations.ZeroMemory(bytes);
            throw;
        }
    }

    /// <summary>Closes the owned descriptor and clears retained raw secret bytes.</summary>
    public void Dispose()
    {
        if (_disposed)
            return;
        _disposed = true;
        try
        {
            _handle.Dispose();
        }
        finally
        {
            CryptographicOperations.ZeroMemory(_bytes);
        }
    }
}
