using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Core.Integrity;

namespace FsusBlog.Server.Infrastructure.Integrity;

public sealed record MerkleCheckpointManifest(
    int ManifestVersion,
    string CheckpointKind,
    string ScopeKey,
    string RootHash,
    long FromSeq,
    long ToSeq,
    int EntryCount,
    long LogHeadSeq,
    string LogHeadHash,
    DateTimeOffset CreatedAtUtc)
{
    public static MerkleCheckpointManifest Create(
        string checkpointKind,
        string scopeKey,
        MerkleCheckpointBuildResult checkpoint,
        long logHeadSeq,
        string logHeadHash,
        DateTimeOffset createdAtUtc)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(checkpointKind);
        ArgumentException.ThrowIfNullOrWhiteSpace(scopeKey);
        ArgumentNullException.ThrowIfNull(checkpoint);
        MerkleCheckpointHashGuards.ValidateHash(logHeadHash, nameof(logHeadHash));

        long fromSeq = checkpoint.Leaves.Count == 0 ? 0 : checkpoint.Leaves.Min(static leaf => leaf.Seq);
        long toSeq = checkpoint.Leaves.Count == 0 ? 0 : checkpoint.Leaves.Max(static leaf => leaf.Seq);
        if (checkpoint.Leaves.Count > 0 && logHeadSeq < toSeq)
        {
            throw new ArgumentOutOfRangeException(
                nameof(logHeadSeq),
                logHeadSeq,
                "Checkpoint log head must cover every Merkle leaf.");
        }

        return new MerkleCheckpointManifest(
            ManifestVersion: 1,
            CheckpointKind: NormalizeToken(checkpointKind, nameof(checkpointKind)),
            ScopeKey: scopeKey.Trim(),
            RootHash: MerkleCheckpointHashGuards.NormalizeHash(checkpoint.RootHash, nameof(checkpoint.RootHash)),
            FromSeq: fromSeq,
            ToSeq: toSeq,
            EntryCount: checkpoint.Leaves.Count,
            LogHeadSeq: logHeadSeq,
            LogHeadHash: MerkleCheckpointHashGuards.NormalizeHash(logHeadHash, nameof(logHeadHash)),
            CreatedAtUtc: createdAtUtc.ToUniversalTime());
    }

    private static string NormalizeToken(string value, string name)
    {
        string trimmed = value.Trim();
        if (trimmed.Length > 24)
        {
            throw new ArgumentOutOfRangeException(name, trimmed, "Checkpoint token is too long.");
        }

        return trimmed.ToLowerInvariant();
    }
}

public static class MerkleCheckpointManifestCanonicalizer
{
    public const string DomainSeparator = "fsusblog.integrity.merkle-checkpoint-manifest.v1";

    public static string BuildPayloadUtf8(MerkleCheckpointManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        ValidateManifest(manifest);

        var builder = new StringBuilder(512);
        AppendLine(builder, DomainSeparator);
        AppendLine(builder, $"manifestVersion:i:{manifest.ManifestVersion.ToString(CultureInfo.InvariantCulture)}");
        AppendString(builder, "checkpointKind", manifest.CheckpointKind);
        AppendString(builder, "scopeKey", manifest.ScopeKey);
        AppendHash(builder, "rootHash", manifest.RootHash);
        AppendLong(builder, "fromSeq", manifest.FromSeq);
        AppendLong(builder, "toSeq", manifest.ToSeq);
        AppendInt(builder, "entryCount", manifest.EntryCount);
        AppendLong(builder, "logHeadSeq", manifest.LogHeadSeq);
        AppendHash(builder, "logHeadHash", manifest.LogHeadHash);
        AppendLine(builder, $"createdAt:t:{CanonicalUtc(manifest.CreatedAtUtc)}");
        return builder.ToString();
    }

    public static byte[] BuildPayloadBytes(MerkleCheckpointManifest manifest)
        => Encoding.UTF8.GetBytes(BuildPayloadUtf8(manifest));

    public static string ComputeDigestHex(MerkleCheckpointManifest manifest)
        => Convert.ToHexString(SHA256.HashData(BuildPayloadBytes(manifest))).ToLowerInvariant();

    private static void ValidateManifest(MerkleCheckpointManifest manifest)
    {
        if (manifest.ManifestVersion != 1)
        {
            throw new ArgumentOutOfRangeException(nameof(manifest), manifest.ManifestVersion, "Unsupported checkpoint manifest version.");
        }

        ArgumentException.ThrowIfNullOrWhiteSpace(manifest.CheckpointKind);
        ArgumentException.ThrowIfNullOrWhiteSpace(manifest.ScopeKey);
        MerkleCheckpointHashGuards.ValidateHash(manifest.RootHash, nameof(manifest.RootHash));
        MerkleCheckpointHashGuards.ValidateHash(manifest.LogHeadHash, nameof(manifest.LogHeadHash));
        if (manifest.FromSeq < 0 || manifest.ToSeq < 0 || manifest.LogHeadSeq < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(manifest), "Checkpoint seq values cannot be negative.");
        }

        if (manifest.EntryCount < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(manifest), "Checkpoint entry count cannot be negative.");
        }

        if (manifest.EntryCount == 0 && (manifest.FromSeq != 0 || manifest.ToSeq != 0))
        {
            throw new ArgumentException("Empty checkpoint must use zero seq bounds.", nameof(manifest));
        }

        if (manifest.EntryCount > 0 && manifest.FromSeq <= 0)
        {
            throw new ArgumentException("Non-empty checkpoint must have a positive from seq.", nameof(manifest));
        }

        if (manifest.ToSeq < manifest.FromSeq)
        {
            throw new ArgumentException("Checkpoint seq range is invalid.", nameof(manifest));
        }

        if (manifest.LogHeadSeq < manifest.ToSeq)
        {
            throw new ArgumentException("Checkpoint log head must cover the checkpoint range.", nameof(manifest));
        }
    }

    private static void AppendLine(StringBuilder builder, string value)
        => builder.Append(value).Append('\n');

    private static void AppendInt(StringBuilder builder, string field, int value)
        => AppendLine(builder, $"{field}:i:{value.ToString(CultureInfo.InvariantCulture)}");

    private static void AppendLong(StringBuilder builder, string field, long value)
        => AppendLine(builder, $"{field}:i:{value.ToString(CultureInfo.InvariantCulture)}");

    private static void AppendHash(StringBuilder builder, string field, string value)
        => AppendLine(builder, $"{field}:h:{MerkleCheckpointHashGuards.NormalizeHash(value, field)}");

    private static void AppendString(StringBuilder builder, string field, string value)
        => AppendLine(builder, $"{field}:s:{Convert.ToBase64String(Encoding.UTF8.GetBytes(NormalizeText(value)))}");

    private static string CanonicalUtc(DateTimeOffset value)
        => value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);

    private static string NormalizeText(string value)
        => value.Trim()
            .Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace('\r', '\n')
            .Normalize(NormalizationForm.FormC);
}

public static class MerkleCheckpointSigning
{
    public const string ProofKind = "merkle-checkpoint";

    public static SiteIntegritySigningPayload BuildSigningPayload(MerkleCheckpointManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        return new SiteIntegritySigningPayload(
            ProofKind: ProofKind,
            Subject: string.Concat("checkpoint:", manifest.CheckpointKind, ':', manifest.ScopeKey),
            DigestSha256Hex: MerkleCheckpointManifestCanonicalizer.ComputeDigestHex(manifest),
            IssuedAtUtc: manifest.CreatedAtUtc.ToUniversalTime(),
            Fields: new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["checkpointKind"] = manifest.CheckpointKind,
                ["entryCount"] = manifest.EntryCount.ToString(CultureInfo.InvariantCulture),
                ["fromSeq"] = manifest.FromSeq.ToString(CultureInfo.InvariantCulture),
                ["logHeadHash"] = manifest.LogHeadHash,
                ["logHeadSeq"] = manifest.LogHeadSeq.ToString(CultureInfo.InvariantCulture),
                ["manifestVersion"] = manifest.ManifestVersion.ToString(CultureInfo.InvariantCulture),
                ["rootHash"] = manifest.RootHash,
                ["scopeKey"] = manifest.ScopeKey,
                ["toSeq"] = manifest.ToSeq.ToString(CultureInfo.InvariantCulture)
            });
    }
}

internal static class MerkleCheckpointHashGuards
{
    public static string NormalizeHash(string value, string name)
    {
        ValidateHash(value, name);
        return value.Trim().ToLowerInvariant();
    }

    public static void ValidateHash(string value, string name)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        string trimmed = value.Trim();
        if (!HexText.IsSha256Hex(trimmed))
        {
            throw new ArgumentException("Checkpoint hash must be SHA-256 hex.", name);
        }
    }
}
