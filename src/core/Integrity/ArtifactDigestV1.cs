using System.Buffers;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Core.Integrity;

public enum ArtifactDigestKind
{
    PublicAotHtml = 1,
    PublicAotShell = 2,
    ArticleDetailAeds = 3,
    PublicHotRead = 4,
    RssFeed = 5,
    AtomFeed = 6,
    JsonFeed = 7,
    SitemapXml = 8,
    RobotsTxt = 9,
    PublicAsset = 10,
    PublicAssetManifest = 11
}

public enum ArtifactDigestState
{
    Ready = 1,
    Missing = 2,
    Pending = 3,
    Stale = 4,
    NotPublic = 5,
    Unknown = 6,
    Unavailable = 7,
    HashMismatch = 8
}

public sealed record ArtifactDigestEntry(
    ArtifactDigestKind Kind,
    string ArtifactKey,
    ArtifactDigestState State,
    string? Sha256Hex,
    long? Length,
    string? Reason = null,
    string? ExpectedSha256Hex = null)
{
    public int HashVersion => ArtifactDigestV1.HashVersion;
    public string DomainSeparator => ArtifactDigestV1.DomainSeparator;
    public string HashAlgorithm => ArtifactDigestV1.HashAlgorithm;
    public bool HasDigest => Sha256Hex is not null;
}

public static class ArtifactDigestV1
{
    public const int HashVersion = 1;
    public const string DomainSeparator = "fsusblog.integrity.artifact-digest.v1";
    public const string HashAlgorithm = "sha256";

    private const int StreamBufferSize = 64 * 1024;

    public static ArtifactDigestEntry ComputeUtf8(
        ArtifactDigestKind kind,
        string artifactKey,
        string content)
    {
        ArgumentNullException.ThrowIfNull(content);
        return ComputeBytes(kind, artifactKey, Encoding.UTF8.GetBytes(content));
    }

    public static ArtifactDigestEntry ComputeBytes(
        ArtifactDigestKind kind,
        string artifactKey,
        ReadOnlySpan<byte> bytes)
    {
        string normalizedKey = NormalizeArtifactKey(artifactKey);
        byte[] hash = SHA256.HashData(bytes);
        return Ready(kind, normalizedKey, ToLowerHex(hash), bytes.Length);
    }

    public static async Task<ArtifactDigestEntry> TryComputeFileAsync(
        ArtifactDigestKind kind,
        string artifactKey,
        string path,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        string normalizedKey = NormalizeArtifactKey(artifactKey);

        if (!File.Exists(path))
        {
            return Missing(kind, normalizedKey, "file-missing");
        }

        try
        {
            var options = new FileStreamOptions
            {
                Mode = FileMode.Open,
                Access = FileAccess.Read,
                Share = FileShare.ReadWrite | FileShare.Delete,
                BufferSize = StreamBufferSize,
                Options = FileOptions.Asynchronous | FileOptions.SequentialScan
            };
            await using FileStream stream = File.Open(path, options);
            return await TryComputeStreamAsync(kind, normalizedKey, stream, cancellationToken).ConfigureAwait(false);
        }
        catch (FileNotFoundException)
        {
            return Missing(kind, normalizedKey, "file-missing");
        }
        catch (DirectoryNotFoundException)
        {
            return Missing(kind, normalizedKey, "file-missing");
        }
        catch (UnauthorizedAccessException ex)
        {
            return Unavailable(kind, normalizedKey, BuildReason("file-unavailable", ex));
        }
        catch (IOException ex)
        {
            return Unavailable(kind, normalizedKey, BuildReason("file-unavailable", ex));
        }
        catch (NotSupportedException ex)
        {
            return Unavailable(kind, normalizedKey, BuildReason("file-unavailable", ex));
        }
    }

    public static async Task<ArtifactDigestEntry> TryComputeStreamAsync(
        ArtifactDigestKind kind,
        string artifactKey,
        Stream stream,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(stream);
        string normalizedKey = NormalizeArtifactKey(artifactKey);

        if (!stream.CanRead)
        {
            return Unavailable(kind, normalizedKey, "stream-not-readable");
        }

        byte[] buffer = ArrayPool<byte>.Shared.Rent(StreamBufferSize);
        try
        {
            using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long length = 0;
            while (true)
            {
                int read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken).ConfigureAwait(false);
                if (read == 0)
                {
                    break;
                }

                hash.AppendData(buffer.AsSpan(0, read));
                length += read;
            }

            return Ready(kind, normalizedKey, ToLowerHex(hash.GetHashAndReset()), length);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (IOException ex)
        {
            return Unavailable(kind, normalizedKey, BuildReason("read-failed", ex));
        }
        catch (UnauthorizedAccessException ex)
        {
            return Unavailable(kind, normalizedKey, BuildReason("read-failed", ex));
        }
        catch (NotSupportedException ex)
        {
            return Unavailable(kind, normalizedKey, BuildReason("read-failed", ex));
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer, clearArray: false);
        }
    }

    public static ArtifactDigestEntry FromAssetLibrarySha256(
        string artifactKey,
        string? assetLibrarySha256,
        long? length)
    {
        string normalizedKey = NormalizeArtifactKey(artifactKey);
        if (!TryNormalizeSha256(assetLibrarySha256, out string? normalized))
        {
            return Unknown(ArtifactDigestKind.PublicAsset, normalizedKey, "AssetLibraryItem.Sha256 missing-or-invalid");
        }

        return Ready(ArtifactDigestKind.PublicAsset, normalizedKey, normalized!, length);
    }

    public static ArtifactDigestEntry ValidateAssetLibrarySha256(
        string artifactKey,
        string? assetLibrarySha256,
        ReadOnlySpan<byte> actualBytes)
    {
        ArtifactDigestEntry actual = ComputeBytes(ArtifactDigestKind.PublicAsset, artifactKey, actualBytes);
        if (!TryNormalizeSha256(assetLibrarySha256, out string? expected))
        {
            return actual with
            {
                State = ArtifactDigestState.Unknown,
                Reason = "AssetLibraryItem.Sha256 missing-or-invalid"
            };
        }

        if (StringComparer.Ordinal.Equals(expected, actual.Sha256Hex))
        {
            return actual with { ExpectedSha256Hex = expected };
        }

        return actual with
        {
            State = ArtifactDigestState.HashMismatch,
            Reason = "AssetLibraryItem.Sha256 mismatch",
            ExpectedSha256Hex = expected
        };
    }

    public static ArtifactDigestEntry ComputePublicAssetManifest(
        string articleKey,
        IEnumerable<ArtifactDigestEntry> assets)
    {
        ArgumentNullException.ThrowIfNull(assets);
        string manifestKey = NormalizeArtifactKey(articleKey);
        byte[] payload = BuildManifestPayloadBytes(manifestKey, assets);
        return ComputeBytes(ArtifactDigestKind.PublicAssetManifest, manifestKey, payload);
    }

    public static string BuildManifestPayloadUtf8(
        string articleKey,
        IEnumerable<ArtifactDigestEntry> assets)
        => Encoding.UTF8.GetString(BuildManifestPayloadBytes(articleKey, assets));

    public static byte[] BuildManifestPayloadBytes(
        string articleKey,
        IEnumerable<ArtifactDigestEntry> assets)
    {
        ArgumentNullException.ThrowIfNull(assets);
        string manifestKey = NormalizeArtifactKey(articleKey);
        ArtifactDigestEntry[] normalizedAssets =
        [
            .. assets
                .Select(ValidateManifestEntry)
                .OrderBy(static entry => (int)entry.Kind)
                .ThenBy(static entry => entry.ArtifactKey, StringComparer.Ordinal)
        ];

        var builder = new StringBuilder(256 + normalizedAssets.Length * 160);
        AppendRawLine(builder, DomainSeparator);
        AppendRawLine(builder, $"hashVersion:i:{HashVersion.ToString(CultureInfo.InvariantCulture)}");
        AppendStringLine(builder, "manifestKey", manifestKey);
        AppendRawLine(builder, $"entryCount:i:{normalizedAssets.Length.ToString(CultureInfo.InvariantCulture)}");

        for (int i = 0; i < normalizedAssets.Length; i++)
        {
            ArtifactDigestEntry entry = normalizedAssets[i];
            AppendRawLine(builder, $"entry:{i.ToString(CultureInfo.InvariantCulture)}");
            AppendRawLine(builder, $"kind:i:{((int)entry.Kind).ToString(CultureInfo.InvariantCulture)}");
            AppendStringLine(builder, "kindName", entry.Kind.ToString());
            AppendStringLine(builder, "artifactKey", entry.ArtifactKey);
            AppendStringLine(builder, "state", entry.State.ToString());
            AppendStringLine(builder, "sha256", entry.Sha256Hex);
            AppendNullableLongLine(builder, "length", entry.Length);
            AppendStringLine(builder, "expectedSha256", entry.ExpectedSha256Hex);
            AppendStringLine(builder, "reason", entry.Reason);
        }

        return Encoding.UTF8.GetBytes(builder.ToString());
    }

    public static ArtifactDigestEntry Pending(ArtifactDigestKind kind, string artifactKey, string? reason = null)
        => State(kind, artifactKey, ArtifactDigestState.Pending, reason);

    public static ArtifactDigestEntry Stale(ArtifactDigestKind kind, string artifactKey, string? reason = null)
        => State(kind, artifactKey, ArtifactDigestState.Stale, reason);

    public static ArtifactDigestEntry NotPublic(ArtifactDigestKind kind, string artifactKey, string? reason = null)
        => State(kind, artifactKey, ArtifactDigestState.NotPublic, reason);

    public static ArtifactDigestEntry Missing(ArtifactDigestKind kind, string artifactKey, string? reason = null)
        => State(kind, artifactKey, ArtifactDigestState.Missing, reason);

    public static ArtifactDigestEntry Unknown(ArtifactDigestKind kind, string artifactKey, string? reason = null)
        => State(kind, artifactKey, ArtifactDigestState.Unknown, reason);

    public static ArtifactDigestEntry Unavailable(ArtifactDigestKind kind, string artifactKey, string? reason = null)
        => State(kind, artifactKey, ArtifactDigestState.Unavailable, reason);

    private static ArtifactDigestEntry Ready(
        ArtifactDigestKind kind,
        string artifactKey,
        string sha256Hex,
        long? length)
        => new(kind, NormalizeArtifactKey(artifactKey), ArtifactDigestState.Ready, NormalizeSha256(sha256Hex), length);

    private static ArtifactDigestEntry State(
        ArtifactDigestKind kind,
        string artifactKey,
        ArtifactDigestState state,
        string? reason)
    {
        if (state is ArtifactDigestState.Ready or ArtifactDigestState.HashMismatch)
        {
            throw new ArgumentOutOfRangeException(nameof(state), state, "Use digest-bearing factories for ready or mismatch states.");
        }

        return new ArtifactDigestEntry(kind, NormalizeArtifactKey(artifactKey), state, null, null, NormalizeOptionalText(reason));
    }

    private static ArtifactDigestEntry ValidateManifestEntry(ArtifactDigestEntry entry)
    {
        ArgumentNullException.ThrowIfNull(entry);
        string key = NormalizeArtifactKey(entry.ArtifactKey);
        string? sha256 = entry.Sha256Hex is null ? null : NormalizeSha256(entry.Sha256Hex);
        string? expected = entry.ExpectedSha256Hex is null ? null : NormalizeSha256(entry.ExpectedSha256Hex);
        string? reason = NormalizeOptionalText(entry.Reason);
        return entry with
        {
            ArtifactKey = key,
            Sha256Hex = sha256,
            ExpectedSha256Hex = expected,
            Reason = reason
        };
    }

    private static string NormalizeArtifactKey(string artifactKey)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(artifactKey);
        return NormalizeText(artifactKey.Trim());
    }

    private static string NormalizeSha256(string sha256)
    {
        if (!TryNormalizeSha256(sha256, out string? normalized))
        {
            throw new ArgumentException("SHA-256 must be a 64-character hexadecimal string.", nameof(sha256));
        }

        return normalized!;
    }

    private static bool TryNormalizeSha256(string? sha256, out string? normalized)
    {
        normalized = null;
        if (string.IsNullOrWhiteSpace(sha256))
        {
            return false;
        }

        string trimmed = sha256.Trim();
        if (trimmed.Length != 64)
        {
            return false;
        }

        foreach (char c in trimmed)
        {
            bool hex = c is >= '0' and <= '9'
                || c is >= 'a' and <= 'f'
                || c is >= 'A' and <= 'F';
            if (!hex)
            {
                return false;
            }
        }

        normalized = trimmed.ToLowerInvariant();
        return true;
    }

    private static string ToLowerHex(byte[] bytes)
        => Convert.ToHexString(bytes).ToLowerInvariant();

    private static string BuildReason(string prefix, Exception ex)
        => string.Concat(prefix, ":", ex.GetType().Name, ":", NormalizeText(ex.Message));

    private static void AppendRawLine(StringBuilder builder, string value)
        => builder.Append(value).Append('\n');

    private static void AppendNullableLongLine(StringBuilder builder, string field, long? value)
    {
        if (value.HasValue)
        {
            AppendRawLine(builder, $"{field}:i:{value.Value.ToString(CultureInfo.InvariantCulture)}");
            return;
        }

        AppendRawLine(builder, $"{field}:n");
    }

    private static void AppendStringLine(StringBuilder builder, string field, string? value)
    {
        if (value is null)
        {
            AppendRawLine(builder, $"{field}:n");
            return;
        }

        string encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(NormalizeText(value)));
        AppendRawLine(builder, $"{field}:s:{encoded}");
    }

    private static string? NormalizeOptionalText(string? value)
        => value is null ? null : NormalizeText(value);

    private static string NormalizeText(string value)
        => NormalizeLineEndings(value).Normalize(NormalizationForm.FormC);

    private static string NormalizeLineEndings(string value)
        => value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');
}
