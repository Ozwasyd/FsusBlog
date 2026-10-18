using System.Security.Cryptography;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

// One Migration-owned immutable artifact publisher. Producing bytes or a SHA does
// not confer plan/receipt authority; each caller must complete its original verifier.
internal static class OfflineMigrationArtifactPublisher
{
    internal static async Task<CurrentSchemaArtifactReference> PublishAsync(
        string absoluteOutputPath, ReadOnlyMemory<byte> bytes, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!Path.IsPathFullyQualified(absoluteOutputPath) || Path.GetFullPath(absoluteOutputPath) != absoluteOutputPath
            || absoluteOutputPath.Any(char.IsControl) || bytes.IsEmpty)
        {
            throw new InvalidOperationException("offline_artifact_publication_input_invalid");
        }
        // ReadOnlyMemory can still alias a mutable caller array. Freeze one owned
        // snapshot so the hash and written bytes cannot diverge during an await.
        byte[] frozen = bytes.ToArray();
        string sha256 = Convert.ToHexStringLower(SHA256.HashData(frozen));
        string staging = absoluteOutputPath + "." + Guid.NewGuid().ToString("N") + ".staging";
        bool created = false;
        try
        {
            var options = new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                Options = FileOptions.Asynchronous
            };
            if (!OperatingSystem.IsWindows())
            {
                options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            }
            await using (var output = new FileStream(staging, options))
            {
                created = true;
                await output.WriteAsync(frozen, cancellationToken).ConfigureAwait(false);
                await output.FlushAsync(cancellationToken).ConfigureAwait(false);
                output.Flush(flushToDisk: true);
            }
            cancellationToken.ThrowIfCancellationRequested();
            File.Move(staging, absoluteOutputPath, overwrite: false);
            return new(absoluteOutputPath, sha256);
        }
        finally
        {
            if (created) File.Delete(staging);
        }
    }
}
