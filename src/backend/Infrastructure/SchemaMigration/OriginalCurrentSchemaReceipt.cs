using System.Security.Cryptography;

using Microsoft.Win32.SafeHandles;

using FsusBlog.Algorithms.IO;
using FsusBlog.Contracts.SchemaMigration;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

/// <summary>Retains original FD5 receipt bytes; file custody never grants execution or native qualification.</summary>
internal sealed class OriginalCurrentSchemaReceipt : IDisposable
{
    internal const int InheritedDescriptor = 5;

    private readonly SafeFileHandle _handle;
    private readonly NativeRegularFileGuard.OriginalRegularFileIdentity _identity;
    private readonly byte[] _bytes;
    private bool _disposed;

    internal string CanonicalPath { get; }
    internal string ArtifactSha256 { get; }
    internal string ObservationSha256 => _identity.ObservationSha256;

    private OriginalCurrentSchemaReceipt(string path, SafeFileHandle handle,
        NativeRegularFileGuard.OriginalRegularFileIdentity identity, byte[] bytes, string artifactSha256)
    {
        CanonicalPath = path;
        _handle = handle;
        _identity = identity;
        _bytes = bytes;
        ArtifactSha256 = artifactSha256;
    }

    internal static OriginalCurrentSchemaReceipt OpenFromInheritedDescriptor(
        string canonicalPath, int inheritedDescriptor, string expectedArtifactSha256,
        string expectedObservationSha256, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        CurrentSchemaReceiptCodec.RequireDigest(expectedArtifactSha256);
        CurrentSchemaReceiptCodec.RequireDigest(expectedObservationSha256);
        if (string.IsNullOrWhiteSpace(canonicalPath) || !Path.IsPathFullyQualified(canonicalPath)
            || canonicalPath != Path.GetFullPath(canonicalPath) || canonicalPath.Any(char.IsControl)
            || canonicalPath.Split('/', '\\').Any(segment => segment.Equals("latest", StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException("current_schema_explicit_receipt_required");
        }
        if (inheritedDescriptor != InheritedDescriptor)
        {
            throw new InvalidOperationException("current_schema_receipt_original_descriptor_required");
        }
        // The transport retains FD5. This owner closes only its kernel duplicate.
        using var borrowed = new SafeFileHandle((IntPtr)inheritedDescriptor, ownsHandle: false);
        SafeFileHandle handle = NativeRegularFileGuard.DuplicateOriginalReadOnlyRegularFile(borrowed, cancellationToken);
        byte[]? bytes = null;
        try
        {
            NativeRegularFileGuard.OriginalRegularFileIdentity identity =
                NativeRegularFileGuard.CaptureOriginalRegularFileIdentity(canonicalPath, handle, cancellationToken);
            identity.RequireObservedEpochSha256(expectedObservationSha256);
            bytes = ReadBoundedBytes(handle, cancellationToken);
            if (!CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(expectedArtifactSha256), SHA256.HashData(bytes)))
            {
                throw new InvalidOperationException("current_receipt_artifact_digest_mismatch");
            }
            NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(canonicalPath, handle, identity, cancellationToken);
            var original = new OriginalCurrentSchemaReceipt(canonicalPath, handle, identity, bytes, expectedArtifactSha256);
            original.ValidateUnchanged(cancellationToken);
            return original;
        }
        catch
        {
            try
            {
                handle.Dispose();
            }
            finally
            {
                if (bytes is not null)
                {
                    CryptographicOperations.ZeroMemory(bytes);
                }
            }
            throw;
        }
    }

    internal void ValidateUnchanged(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ObjectDisposedException.ThrowIf(_disposed, this);
        NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(CanonicalPath, _handle, _identity, cancellationToken);
        byte[] current = ReadBoundedBytes(_handle, cancellationToken);
        try
        {
            if (!CryptographicOperations.FixedTimeEquals(_bytes, current))
            {
                throw new InvalidOperationException("current_receipt_artifact_digest_mismatch");
            }
            NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(CanonicalPath, _handle, _identity, cancellationToken);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(current);
        }
    }

    internal CurrentSchemaReceipt ValidateAgainst(
        CurrentSchemaAdmissionObservation actual, CancellationToken cancellationToken)
    {
        ValidateUnchanged(cancellationToken);
        CurrentSchemaReceipt receipt = CurrentSchemaReceiptAdmission.Validate(_bytes, ArtifactSha256, actual);
        ValidateUnchanged(cancellationToken);
        return receipt;
    }

    private static byte[] ReadBoundedBytes(SafeFileHandle handle, CancellationToken cancellationToken)
    {
        long length = RandomAccess.GetLength(handle);
        if (length is <= 0 or > CurrentSchemaReceiptCodec.MaximumEncodedBytes)
        {
            throw new InvalidOperationException("current_schema_receipt_size_invalid");
        }
        byte[] bytes = new byte[checked((int)length)];
        try
        {
            int read = 0;
            while (read < bytes.Length)
            {
                cancellationToken.ThrowIfCancellationRequested();
                int count = RandomAccess.Read(handle, bytes.AsSpan(read, Math.Min(4096, bytes.Length - read)), read);
                if (count == 0)
                {
                    throw new InvalidOperationException("current_schema_receipt_size_changed");
                }
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
            {
                throw new InvalidOperationException("current_schema_receipt_size_exceeded");
            }
            cancellationToken.ThrowIfCancellationRequested();
            return bytes;
        }
        catch
        {
            CryptographicOperations.ZeroMemory(bytes);
            throw;
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
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
