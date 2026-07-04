using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Core.Integrity;

public static class TransparencyLogEntryTypes
{
    public const string PublishProof = "publish-proof";
    public const string ArticleRightsProof = "article-rights-proof";
    public const string Checkpoint = "checkpoint";
}

public sealed record TransparencyLogEntryInput(
    long Seq,
    string EntryType,
    long? ProofId,
    int? ArticleId,
    long? ArticleRevisionId,
    int? RevisionNo,
    string EntryPayloadHash,
    string PrevEntryHash,
    DateTimeOffset CreatedAtUtc,
    string? SigningKeyId,
    string? SignatureBase64Url)
{
    public TransparencyLogEntryRecord ToRecord(string entryHash)
        => new(
            Seq,
            EntryType,
            ProofId,
            ArticleId,
            ArticleRevisionId,
            RevisionNo,
            EntryPayloadHash,
            PrevEntryHash,
            entryHash,
            CreatedAtUtc,
            SigningKeyId,
            SignatureBase64Url);
}

public sealed record TransparencyLogEntryRecord(
    long Seq,
    string EntryType,
    long? ProofId,
    int? ArticleId,
    long? ArticleRevisionId,
    int? RevisionNo,
    string EntryPayloadHash,
    string PrevEntryHash,
    string EntryHash,
    DateTimeOffset CreatedAtUtc,
    string? SigningKeyId,
    string? SignatureBase64Url)
{
    public TransparencyLogEntryInput ToInput()
        => new(
            Seq,
            EntryType,
            ProofId,
            ArticleId,
            ArticleRevisionId,
            RevisionNo,
            EntryPayloadHash,
            PrevEntryHash,
            CreatedAtUtc,
            SigningKeyId,
            SignatureBase64Url);
}

public sealed record TransparencyLogVerificationResult(
    bool IsValid,
    string? ErrorCode,
    long? FailedSeq,
    string? LatestHeadHash)
{
    public static TransparencyLogVerificationResult Valid(string? latestHeadHash)
        => new(true, null, null, latestHeadHash);

    public static TransparencyLogVerificationResult Invalid(string errorCode, long? failedSeq, string? latestHeadHash)
        => new(false, errorCode, failedSeq, latestHeadHash);
}

public static class TransparencyLogPayloadHasher
{
    public const string DomainSeparator = "fsusblog.integrity.transparency-log-payload.v1";

    public static string ComputeUtf8HashHex(string entryType, string payload)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(entryType);
        ArgumentNullException.ThrowIfNull(payload);

        byte[] bytes = Encoding.UTF8.GetBytes(
            string.Concat(
                DomainSeparator,
                "\nentryType:s:",
                Convert.ToBase64String(Encoding.UTF8.GetBytes(NormalizeText(entryType))),
                "\npayload:s:",
                Convert.ToBase64String(Encoding.UTF8.GetBytes(NormalizeText(payload))),
                "\n"));
        return ToLowerHex(SHA256.HashData(bytes));
    }

    private static string NormalizeText(string value)
        => value.Trim().Normalize(NormalizationForm.FormC);

    private static string ToLowerHex(byte[] bytes)
        => Convert.ToHexString(bytes).ToLowerInvariant();
}

public static class TransparencyLogEntryCanonicalizer
{
    public const string DomainSeparator = "fsusblog.integrity.transparency-log-entry.v1";
    public const string GenesisPreviousHash = "0000000000000000000000000000000000000000000000000000000000000000";

    public static string BuildPayloadUtf8(TransparencyLogEntryInput input)
    {
        ValidateInput(input);

        var builder = new StringBuilder(768);
        AppendRawLine(builder, DomainSeparator);
        AppendLongLine(builder, "seq", input.Seq);
        AppendStringLine(builder, "entryType", input.EntryType);
        AppendNullableLongLine(builder, "proofId", input.ProofId);
        AppendNullableIntLine(builder, "articleId", input.ArticleId);
        AppendNullableLongLine(builder, "articleRevisionId", input.ArticleRevisionId);
        AppendNullableIntLine(builder, "revisionNo", input.RevisionNo);
        AppendHashLine(builder, "entryPayloadHash", input.EntryPayloadHash);
        AppendHashLine(builder, "prevEntryHash", input.PrevEntryHash);
        AppendRawLine(builder, $"createdAt:t:{CanonicalUtc(input.CreatedAtUtc)}");
        AppendStringLine(builder, "signingKeyId", input.SigningKeyId);
        AppendStringLine(builder, "signature", input.SignatureBase64Url);
        return builder.ToString();
    }

    public static byte[] BuildPayloadBytes(TransparencyLogEntryInput input)
        => Encoding.UTF8.GetBytes(BuildPayloadUtf8(input));

    public static string ComputeEntryHashHex(TransparencyLogEntryInput input)
        => Convert.ToHexString(SHA256.HashData(BuildPayloadBytes(input))).ToLowerInvariant();

    private static void ValidateInput(TransparencyLogEntryInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentException.ThrowIfNullOrWhiteSpace(input.EntryType);
        ArgumentException.ThrowIfNullOrWhiteSpace(input.EntryPayloadHash);
        ArgumentException.ThrowIfNullOrWhiteSpace(input.PrevEntryHash);

        if (input.Seq <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.Seq), input.Seq, "Transparency log seq must be positive.");
        }

        if (input.ProofId is <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.ProofId), input.ProofId, "Proof id must be positive when present.");
        }

        if (input.ArticleId is <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.ArticleId), input.ArticleId, "Article id must be positive when present.");
        }

        if (input.ArticleRevisionId is <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.ArticleRevisionId), input.ArticleRevisionId, "Article revision id must be positive when present.");
        }

        if (input.RevisionNo is <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.RevisionNo), input.RevisionNo, "Revision no must be positive when present.");
        }

        ValidateHash(input.EntryPayloadHash, nameof(input.EntryPayloadHash));
        ValidateHash(input.PrevEntryHash, nameof(input.PrevEntryHash));
    }

    internal static bool IsSha256Hex(string value)
        => value.Length == 64 && value.All(static ch => Uri.IsHexDigit(ch));

    private static void ValidateHash(string value, string name)
    {
        if (!IsSha256Hex(value))
        {
            throw new ArgumentException("Transparency log hash must be a SHA-256 hex value.", name);
        }
    }

    private static void AppendRawLine(StringBuilder builder, string value)
        => builder.Append(value).Append('\n');

    private static void AppendLongLine(StringBuilder builder, string field, long value)
        => AppendRawLine(builder, $"{field}:i:{value.ToString(CultureInfo.InvariantCulture)}");

    private static void AppendNullableLongLine(StringBuilder builder, string field, long? value)
    {
        if (value.HasValue)
        {
            AppendLongLine(builder, field, value.Value);
            return;
        }

        AppendRawLine(builder, $"{field}:n");
    }

    private static void AppendNullableIntLine(StringBuilder builder, string field, int? value)
    {
        if (value.HasValue)
        {
            AppendRawLine(builder, $"{field}:i:{value.Value.ToString(CultureInfo.InvariantCulture)}");
            return;
        }

        AppendRawLine(builder, $"{field}:n");
    }

    private static void AppendHashLine(StringBuilder builder, string field, string value)
        => AppendRawLine(builder, $"{field}:h:{value.ToLowerInvariant()}");

    private static void AppendStringLine(StringBuilder builder, string field, string? value)
    {
        if (value is null)
        {
            AppendRawLine(builder, $"{field}:n");
            return;
        }

        string normalized = value.Trim().Normalize(NormalizationForm.FormC);
        AppendRawLine(builder, $"{field}:s:{Convert.ToBase64String(Encoding.UTF8.GetBytes(normalized))}");
    }

    private static string CanonicalUtc(DateTimeOffset value)
        => value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
}

public static class TransparencyLogChainVerifier
{
    public static TransparencyLogVerificationResult Verify(IEnumerable<TransparencyLogEntryRecord> entries)
    {
        ArgumentNullException.ThrowIfNull(entries);

        TransparencyLogEntryRecord[] orderedEntries = entries.ToArray();
        long? previousSeq = null;
        foreach (TransparencyLogEntryRecord entry in orderedEntries)
        {
            if (previousSeq.HasValue && entry.Seq <= previousSeq.Value)
            {
                return TransparencyLogVerificationResult.Invalid("seq-order", entry.Seq, null);
            }

            previousSeq = entry.Seq;
        }

        string? previousHash = null;
        long expectedSeq = 1;
        foreach (TransparencyLogEntryRecord entry in orderedEntries)
        {
            if (entry.Seq != expectedSeq)
            {
                return TransparencyLogVerificationResult.Invalid("seq-gap", entry.Seq, previousHash);
            }

            string expectedPreviousHash = previousHash ?? TransparencyLogEntryCanonicalizer.GenesisPreviousHash;
            if (!StringComparer.Ordinal.Equals(entry.PrevEntryHash, expectedPreviousHash))
            {
                return TransparencyLogVerificationResult.Invalid("prev-hash-mismatch", entry.Seq, previousHash);
            }

            string computed = TransparencyLogEntryCanonicalizer.ComputeEntryHashHex(entry.ToInput());
            if (!StringComparer.Ordinal.Equals(entry.EntryHash, computed))
            {
                return TransparencyLogVerificationResult.Invalid("entry-hash-mismatch", entry.Seq, previousHash);
            }

            previousHash = entry.EntryHash;
            expectedSeq++;
        }

        return TransparencyLogVerificationResult.Valid(previousHash);
    }
}
