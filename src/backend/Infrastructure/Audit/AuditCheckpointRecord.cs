using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed record AuditCheckpointRecord(
    long Id,
    string ChainId,
    string? PrevHash,
    string RecordHash,
    string? RecordMac,
    string CanonicalRecordHash,
    string? ContextPayloadHash,
    string SnapshotHash)
{
    public static AuditCheckpointRecord FromAuditLog(AuditLog log)
    {
        ArgumentNullException.ThrowIfNull(log);
        if (log.Id <= 0 || string.IsNullOrWhiteSpace(log.ChainId) || string.IsNullOrWhiteSpace(log.RecordHash))
        {
            throw new ArgumentException("Audit record checkpoint identity is incomplete.", nameof(log));
        }

        string canonicalRecordHash = AuditTamperEvidence.ComputeRecordHash(log);
        string? contextPayloadHash = log.ContextPayload is { Length: > 0 }
            ? Convert.ToHexStringLower(SHA256.HashData(log.ContextPayload))
            : null;
        var unsigned = new AuditCheckpointRecord(
            log.Id,
            log.ChainId.Trim(),
            NormalizeNullableHash(log.PrevHash),
            NormalizeHash(log.RecordHash),
            NormalizeNullableHash(log.RecordMac),
            canonicalRecordHash,
            contextPayloadHash,
            SnapshotHash: string.Empty);
        return unsigned with
        {
            SnapshotHash = AuditCheckpointRecordCanonicalizer.ComputeSnapshotHash(unsigned)
        };
    }

    private static string NormalizeHash(string value)
    {
        if (!HexText.IsSha256Hex(value))
        {
            throw new ArgumentException("Audit record hash must be SHA-256 hex.", nameof(value));
        }

        return value.ToLowerInvariant();
    }

    private static string? NormalizeNullableHash(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : NormalizeHash(value.Trim());
}

public sealed record AuditCheckpointRecordSet(
    long FromRecordId,
    long ToRecordId,
    int RecordCount,
    string MerkleRootHash,
    string AuditHeadHash,
    IReadOnlyList<AuditCheckpointRecord> Records);

public static class AuditCheckpointRecordSetBuilder
{
    public static AuditCheckpointRecordSet Build(
        IEnumerable<AuditLog> logs,
        bool verifyAdjacentChainLinks = true)
    {
        ArgumentNullException.ThrowIfNull(logs);
        AuditCheckpointRecord[] records = logs.Select(AuditCheckpointRecord.FromAuditLog).ToArray();
        if (records.Length == 0)
        {
            throw new InvalidOperationException("audit_checkpoint_record_set_empty");
        }

        for (int index = 0; index < records.Length; index++)
        {
            AuditCheckpointRecord current = records[index];
            if (!AuditTamperEvidence.FixedTimeEqualsHexSha256(current.RecordHash, current.CanonicalRecordHash))
            {
                throw new InvalidOperationException("audit_checkpoint_record_hash_mismatch");
            }

            if (index == 0)
            {
                continue;
            }

            AuditCheckpointRecord previous = records[index - 1];
            if (current.Id <= previous.Id)
            {
                throw new InvalidOperationException("audit_checkpoint_record_order_invalid");
            }

            if (verifyAdjacentChainLinks
                && StringComparer.Ordinal.Equals(current.ChainId, previous.ChainId)
                && !AuditTamperEvidence.FixedTimeEqualsHexSha256(current.PrevHash, previous.RecordHash))
            {
                throw new InvalidOperationException("audit_checkpoint_record_chain_invalid");
            }
        }

        MerkleCheckpointBuildResult merkle = MerkleCheckpointBuilder.Build(
            records.Select(static record => new MerkleLeafInput(
                record.Id,
                record.SnapshotHash,
                ProofId: null,
                ArticleId: null,
                ArticleRevisionId: null,
                RevisionNo: null)),
            preserveInputOrder: true);
        return new AuditCheckpointRecordSet(
            records[0].Id,
            records[^1].Id,
            records.Length,
            merkle.RootHash,
            records[^1].RecordHash,
            records);
    }
}

public static class AuditCheckpointRecordCanonicalizer
{
    public const string DomainSeparator = "fsusblog.audit.detached-checkpoint.record.v1";

    public static string ComputeSnapshotHash(AuditCheckpointRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
        var builder = new StringBuilder(512);
        AppendLine(builder, DomainSeparator);
        AppendLine(builder, $"id:i:{record.Id.ToString(CultureInfo.InvariantCulture)}");
        AppendString(builder, "chainId", record.ChainId);
        AppendNullableHash(builder, "prevHash", record.PrevHash);
        AppendHash(builder, "recordHash", record.RecordHash);
        AppendNullableHash(builder, "recordMac", record.RecordMac);
        AppendHash(builder, "canonicalRecordHash", record.CanonicalRecordHash);
        AppendNullableHash(builder, "contextPayloadHash", record.ContextPayloadHash);
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(builder.ToString())));
    }

    private static void AppendLine(StringBuilder builder, string value)
        => builder.Append(value).Append('\n');

    private static void AppendString(StringBuilder builder, string field, string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        string normalized = value.Trim().Normalize(NormalizationForm.FormC);
        AppendLine(builder, $"{field}:s:{Convert.ToBase64String(Encoding.UTF8.GetBytes(normalized))}");
    }

    private static void AppendHash(StringBuilder builder, string field, string value)
        => AppendLine(builder, $"{field}:h:{NormalizeHash(value)}");

    private static void AppendNullableHash(StringBuilder builder, string field, string? value)
        => AppendLine(builder, value is null ? $"{field}:n" : $"{field}:h:{NormalizeHash(value)}");

    private static string NormalizeHash(string value)
    {
        if (!HexText.IsSha256Hex(value))
        {
            throw new ArgumentException("Audit checkpoint record hash must be SHA-256 hex.", nameof(value));
        }

        return value.ToLowerInvariant();
    }
}
