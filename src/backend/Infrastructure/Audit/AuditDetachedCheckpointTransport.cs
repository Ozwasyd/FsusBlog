using FsusBlog.Core.Common;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.Audit;

public interface IAuditCheckpointExporter
{
    Task ExportAsync(AuditDetachedCheckpointEnvelope envelope, CancellationToken cancellationToken = default);
}

public interface IAuditCheckpointImporter
{
    Task<IReadOnlyList<AuditDetachedCheckpointEnvelope>> ImportAsync(CancellationToken cancellationToken = default);
}

public sealed class AuditCheckpointAppendConflictException(string message) : IOException(message);

public static class AuditDetachedCheckpointPackageCodec
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = false,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static byte[] Serialize(AuditDetachedCheckpointEnvelope envelope)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        AuditDetachedCheckpointCanonicalizer.ValidateEnvelope(envelope);
        return JsonSerializer.SerializeToUtf8Bytes(envelope, Options);
    }

    public static AuditDetachedCheckpointEnvelope Deserialize(ReadOnlySpan<byte> bytes)
    {
        AuditDetachedCheckpointEnvelope envelope = JsonSerializer.Deserialize<AuditDetachedCheckpointEnvelope>(bytes, Options)
            ?? throw new InvalidDataException("audit_checkpoint_package_empty");
        byte[] canonical = Serialize(envelope);
        if (!bytes.SequenceEqual(canonical))
        {
            throw new InvalidDataException("audit_checkpoint_package_noncanonical");
        }

        return envelope;
    }

    public static byte[] SerializeTrustAnchor(AuditDetachedCheckpointTrustAnchor anchor)
    {
        ArgumentNullException.ThrowIfNull(anchor);
        ValidateTrustAnchor(anchor);
        return JsonSerializer.SerializeToUtf8Bytes(anchor, Options);
    }

    public static AuditDetachedCheckpointTrustAnchor DeserializeTrustAnchor(ReadOnlySpan<byte> bytes)
    {
        AuditDetachedCheckpointTrustAnchor anchor =
            JsonSerializer.Deserialize<AuditDetachedCheckpointTrustAnchor>(bytes, Options)
            ?? throw new InvalidDataException("audit_checkpoint_trust_anchor_empty");
        ValidateTrustAnchor(anchor);
        byte[] canonical = SerializeTrustAnchor(anchor);
        if (!bytes.SequenceEqual(canonical))
        {
            throw new InvalidDataException("audit_checkpoint_trust_anchor_noncanonical");
        }

        return anchor;
    }

    private static void ValidateTrustAnchor(AuditDetachedCheckpointTrustAnchor anchor)
    {
        if (!StringComparer.Ordinal.Equals(anchor.TrustDomain, AuditDetachedCheckpointConstants.TrustDomain)
            || anchor.Sequence <= 0
            || !HexText.IsSha256Hex(anchor.CheckpointDigest)
            || string.IsNullOrWhiteSpace(anchor.SigningKeyId))
        {
            throw new ArgumentException("Audit checkpoint trust anchor is invalid.", nameof(anchor));
        }
    }
}

public sealed class LocalFileAuditCheckpointTransport(string rootPath)
    : IAuditCheckpointExporter, IAuditCheckpointImporter
{
    private readonly string _rootPath = NormalizeRootPath(rootPath);

    public async Task ExportAsync(
        AuditDetachedCheckpointEnvelope envelope,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(envelope);
        cancellationToken.ThrowIfCancellationRequested();
        Directory.CreateDirectory(_rootPath);
        string digest = envelope.CheckpointDigest;
        string finalPath = Path.Combine(_rootPath, BuildFileName(envelope.Manifest.Sequence, digest));
        string lockPath = Path.Combine(_rootPath, $"checkpoint-{envelope.Manifest.Sequence:D20}.lock");
        string tempPath = Path.Combine(_rootPath, $".checkpoint-{envelope.Manifest.Sequence:D20}-{Guid.NewGuid():N}.tmp");
        FileStream? lockStream = null;
        try
        {
            try
            {
                lockStream = new FileStream(lockPath, PrivateCreateNewOptions(FileOptions.WriteThrough));
            }
            catch (IOException ex)
            {
                throw new AuditCheckpointAppendConflictException(
                    $"audit_checkpoint_sequence_{envelope.Manifest.Sequence}_writer_conflict: {ex.Message}");
            }

            string prefix = $"checkpoint-{envelope.Manifest.Sequence:D20}-";
            if (Directory.EnumerateFiles(_rootPath, string.Concat(prefix, "*.json"), SearchOption.TopDirectoryOnly).Any())
            {
                throw new AuditCheckpointAppendConflictException(
                    $"audit_checkpoint_sequence_{envelope.Manifest.Sequence}_already_exists");
            }

            byte[] package = AuditDetachedCheckpointPackageCodec.Serialize(envelope);
            await using (var stream = new FileStream(tempPath, PrivateCreateNewOptions(FileOptions.WriteThrough)))
            {
                await stream.WriteAsync(package, cancellationToken).ConfigureAwait(false);
                await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
                stream.Flush(flushToDisk: true);
            }

            try
            {
                File.Move(tempPath, finalPath, overwrite: false);
            }
            catch (IOException ex)
            {
                throw new AuditCheckpointAppendConflictException(
                    $"audit_checkpoint_sequence_{envelope.Manifest.Sequence}_append_conflict: {ex.Message}");
            }
        }
        finally
        {
            bool ownedLock = lockStream is not null;
            lockStream?.Dispose();
            TryDelete(tempPath);
            if (ownedLock)
            {
                TryDelete(lockPath);
            }
        }
    }

    public async Task<IReadOnlyList<AuditDetachedCheckpointEnvelope>> ImportAsync(
        CancellationToken cancellationToken = default)
    {
        if (!Directory.Exists(_rootPath))
        {
            return [];
        }

        string[] files = Directory.EnumerateFiles(_rootPath, "checkpoint-*.json", SearchOption.TopDirectoryOnly)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var checkpoints = new List<AuditDetachedCheckpointEnvelope>(files.Length);
        foreach (string file in files)
        {
            cancellationToken.ThrowIfCancellationRequested();
            byte[] bytes = await File.ReadAllBytesAsync(file, cancellationToken).ConfigureAwait(false);
            AuditDetachedCheckpointEnvelope envelope;
            try
            {
                envelope = AuditDetachedCheckpointPackageCodec.Deserialize(bytes);
            }
            catch (Exception ex) when (ex is JsonException or InvalidDataException or ArgumentException)
            {
                throw new InvalidDataException($"audit_checkpoint_file_invalid:{Path.GetFileName(file)}", ex);
            }

            string expectedName = BuildFileName(envelope.Manifest.Sequence, envelope.CheckpointDigest);
            if (!StringComparer.Ordinal.Equals(Path.GetFileName(file), expectedName))
            {
                throw new InvalidDataException($"audit_checkpoint_file_identity_mismatch:{Path.GetFileName(file)}");
            }

            checkpoints.Add(envelope);
        }

        return checkpoints;
    }

    internal static string BuildFileName(long sequence, string checkpointDigest)
        => $"checkpoint-{sequence:D20}-{checkpointDigest}.json";

    private static FileStreamOptions PrivateCreateNewOptions(FileOptions options)
    {
        var streamOptions = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.None,
            Options = options,
            BufferSize = 16 * 1024
        };
        if (!OperatingSystem.IsWindows())
        {
            streamOptions.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        }

        return streamOptions;
    }

    private static string NormalizeRootPath(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        return Path.GetFullPath(value.Trim());
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
