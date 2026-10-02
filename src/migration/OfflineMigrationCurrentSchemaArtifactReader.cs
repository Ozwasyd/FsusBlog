using System.Security.Cryptography;

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

        await using var input = new FileStream(path, new FileStreamOptions
        {
            Mode = FileMode.Open,
            Access = FileAccess.Read,
            Share = FileShare.Read,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan
        });
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
}
