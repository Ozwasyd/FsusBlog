using FsusBlog.Server.Entities;
using SqlSugar;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Audit;

public interface IAuditCheckpointRecordSource
{
    Task<IReadOnlyList<AuditLog>> ReadAfterAsync(
        long afterRecordId,
        int limit,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<AuditLog>> ReadRangeAsync(
        long fromRecordId,
        long toRecordId,
        CancellationToken cancellationToken = default);
}

public sealed class SqlAuditCheckpointRecordSource(ISqlSugarClient db) : IAuditCheckpointRecordSource
{
    public async Task<IReadOnlyList<AuditLog>> ReadAfterAsync(
        long afterRecordId,
        int limit,
        CancellationToken cancellationToken = default)
    {
        int boundedLimit = Math.Clamp(limit, 1, 10_000);
        return await db.Queryable<AuditLog>()
            .Where(record => record.Id > afterRecordId)
            .OrderBy(record => record.Id)
            .Take(boundedLimit)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<AuditLog>> ReadRangeAsync(
        long fromRecordId,
        long toRecordId,
        CancellationToken cancellationToken = default)
    {
        if (fromRecordId <= 0 || toRecordId < fromRecordId)
        {
            throw new ArgumentOutOfRangeException(nameof(fromRecordId), "Audit checkpoint record range is invalid.");
        }

        return await db.Queryable<AuditLog>()
            .Where(record => record.Id >= fromRecordId && record.Id <= toRecordId)
            .OrderBy(record => record.Id)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
    }
}

public sealed class AuditDetachedCheckpointService(
    IAuditCheckpointRecordSource recordSource,
    IAuditCheckpointImporter importer,
    IAuditCheckpointExporter exporter,
    AuditCheckpointSigningService signingService,
    TimeProvider timeProvider)
{
    public async Task<AuditDetachedCheckpointEnvelope?> CreateNextAsync(
        int maxRecords,
        CancellationToken cancellationToken = default)
    {
        if (maxRecords <= 0 || maxRecords > 10_000)
        {
            throw new ArgumentOutOfRangeException(nameof(maxRecords), maxRecords, "Checkpoint record count must be in 1..10000.");
        }

        IReadOnlyList<AuditDetachedCheckpointEnvelope> existing = await importer.ImportAsync(cancellationToken)
            .ConfigureAwait(false);
        AuditDetachedCheckpointEnvelope? previous = existing.Count == 0 ? null : existing[^1];
        ValidateEnvelopeChain(existing, signingService);
        long afterRecordId = previous?.Manifest.ToRecordId ?? 0;
        IReadOnlyList<AuditLog> logs = await recordSource.ReadAfterAsync(afterRecordId, maxRecords, cancellationToken)
            .ConfigureAwait(false);
        if (logs.Count == 0)
        {
            return null;
        }

        AuditCheckpointRecordSet records = AuditCheckpointRecordSetBuilder.Build(logs);
        var manifest = new AuditDetachedCheckpointManifest(
            AuditDetachedCheckpointConstants.ManifestVersion,
            AuditDetachedCheckpointConstants.TrustDomain,
            Sequence: (previous?.Manifest.Sequence ?? 0) + 1,
            PreviousCheckpointDigest: previous?.CheckpointDigest,
            records.FromRecordId,
            records.ToRecordId,
            records.RecordCount,
            records.MerkleRootHash,
            records.AuditHeadHash,
            timeProvider.GetUtcNow().ToUniversalTime());
        AuditDetachedCheckpointEnvelope envelope = signingService.Sign(manifest);
        await exporter.ExportAsync(envelope, cancellationToken).ConfigureAwait(false);
        return envelope;
    }

    internal static void ValidateEnvelopeChain(
        IReadOnlyList<AuditDetachedCheckpointEnvelope> checkpoints,
        AuditCheckpointSigningService signingService)
    {
        string? previousDigest = null;
        long previousToRecordId = 0;
        for (int index = 0; index < checkpoints.Count; index++)
        {
            AuditDetachedCheckpointEnvelope checkpoint = checkpoints[index];
            long expectedSequence = index + 1L;
            if (checkpoint.Manifest.Sequence != expectedSequence)
            {
                throw new InvalidDataException("audit_checkpoint_sequence_gap");
            }

            if (!StringComparer.Ordinal.Equals(checkpoint.Manifest.PreviousCheckpointDigest, previousDigest))
            {
                throw new InvalidDataException("audit_checkpoint_predecessor_mismatch");
            }

            if (checkpoint.Manifest.FromRecordId <= previousToRecordId)
            {
                throw new InvalidDataException("audit_checkpoint_record_range_overlap");
            }

            AuditCheckpointSignatureVerificationResult signature = signingService.Verify(checkpoint);
            if (!signature.Accepted)
            {
                throw new InvalidDataException(string.Concat("audit_checkpoint_signature_", signature.Code));
            }

            previousDigest = checkpoint.CheckpointDigest;
            previousToRecordId = checkpoint.Manifest.ToRecordId;
        }
    }
}

public sealed record AuditDetachedCheckpointVerificationResult(
    bool Accepted,
    string Code,
    int VerifiedCheckpointCount,
    AuditDetachedCheckpointTrustAnchor? VerifiedHead = null,
    long? FailedSequence = null);

public sealed class AuditDetachedCheckpointVerifier(
    IAuditCheckpointRecordSource recordSource,
    IAuditCheckpointImporter importer,
    AuditCheckpointKeyRegistry publicKeyRegistry)
{
    private readonly AuditCheckpointSigningService _signatureVerifier = new(publicKeyRegistry);

    public async Task<AuditDetachedCheckpointVerificationResult> VerifyAsync(
        AuditDetachedCheckpointTrustAnchor? expectedHead = null,
        CancellationToken cancellationToken = default)
    {
        IReadOnlyList<AuditDetachedCheckpointEnvelope> checkpoints;
        try
        {
            checkpoints = await importer.ImportAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is InvalidDataException or JsonException)
        {
            return Reject("checkpoint-file-invalid", 0);
        }

        if (checkpoints.Count == 0)
        {
            return expectedHead is null
                ? Reject("checkpoint-chain-empty", 0)
                : Reject("checkpoint-rollback-detected", 0);
        }

        string? previousDigest = null;
        long previousToRecordId = 0;
        for (int index = 0; index < checkpoints.Count; index++)
        {
            AuditDetachedCheckpointEnvelope checkpoint = checkpoints[index];
            long expectedSequence = index + 1L;
            if (checkpoint.Manifest.Sequence != expectedSequence)
            {
                return Reject("checkpoint-sequence-gap", index, checkpoint.Manifest.Sequence);
            }

            if (!StringComparer.Ordinal.Equals(checkpoint.Manifest.PreviousCheckpointDigest, previousDigest))
            {
                return Reject("checkpoint-predecessor-mismatch", index, checkpoint.Manifest.Sequence);
            }

            if (checkpoint.Manifest.FromRecordId <= previousToRecordId)
            {
                return Reject("checkpoint-record-range-overlap", index, checkpoint.Manifest.Sequence);
            }

            AuditCheckpointSignatureVerificationResult signature = _signatureVerifier.Verify(checkpoint);
            if (!signature.Accepted)
            {
                return Reject(string.Concat("checkpoint-signature-", signature.Code), index, checkpoint.Manifest.Sequence);
            }

            IReadOnlyList<AuditLog> logs;
            try
            {
                logs = await recordSource.ReadRangeAsync(
                    checkpoint.Manifest.FromRecordId,
                    checkpoint.Manifest.ToRecordId,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
            {
                return Reject("audit-record-source-invalid", index, checkpoint.Manifest.Sequence);
            }

            AuditDetachedCheckpointManifest manifest = checkpoint.Manifest;
            if (logs.Count != manifest.RecordCount)
            {
                return Reject("audit-record-range-mismatch", index, manifest.Sequence);
            }

            AuditCheckpointRecordSet records;
            try
            {
                records = AuditCheckpointRecordSetBuilder.Build(logs);
            }
            catch (InvalidOperationException ex)
            {
                return Reject(MapRecordFailure(ex.Message), index, checkpoint.Manifest.Sequence);
            }
            catch (ArgumentException)
            {
                return Reject("audit-record-identity-invalid", index, checkpoint.Manifest.Sequence);
            }

            if (records.RecordCount != manifest.RecordCount
                || records.FromRecordId != manifest.FromRecordId
                || records.ToRecordId != manifest.ToRecordId)
            {
                return Reject("audit-record-range-mismatch", index, manifest.Sequence);
            }

            if (!AuditTamperEvidence.FixedTimeEqualsHexSha256(records.MerkleRootHash, manifest.MerkleRootHash))
            {
                return Reject("audit-record-merkle-root-mismatch", index, manifest.Sequence);
            }

            if (!AuditTamperEvidence.FixedTimeEqualsHexSha256(records.AuditHeadHash, manifest.AuditHeadHash))
            {
                return Reject("audit-record-head-mismatch", index, manifest.Sequence);
            }

            previousDigest = checkpoint.CheckpointDigest;
            previousToRecordId = manifest.ToRecordId;
        }

        AuditDetachedCheckpointEnvelope head = checkpoints[^1];
        AuditDetachedCheckpointTrustAnchor actualHead = AuditDetachedCheckpointTrustAnchor.FromEnvelope(head);
        if (expectedHead is not null
            && (!StringComparer.Ordinal.Equals(expectedHead.TrustDomain, actualHead.TrustDomain)
                || expectedHead.Sequence != actualHead.Sequence
                || !AuditTamperEvidence.FixedTimeEqualsHexSha256(expectedHead.CheckpointDigest, actualHead.CheckpointDigest)
                || !StringComparer.Ordinal.Equals(expectedHead.SigningKeyId, actualHead.SigningKeyId)))
        {
            return Reject("checkpoint-rollback-detected", checkpoints.Count, head.Manifest.Sequence);
        }

        return new AuditDetachedCheckpointVerificationResult(true, "accepted", checkpoints.Count, actualHead);
    }

    private static string MapRecordFailure(string message)
        => message switch
        {
            "audit_checkpoint_record_set_empty" => "audit-record-range-mismatch",
            "audit_checkpoint_record_hash_mismatch" => "audit-record-hash-mismatch",
            "audit_checkpoint_record_order_invalid" => "audit-record-order-invalid",
            "audit_checkpoint_record_chain_invalid" => "audit-record-chain-invalid",
            _ => "audit-record-invalid"
        };

    private static AuditDetachedCheckpointVerificationResult Reject(
        string code,
        int verifiedCount,
        long? failedSequence = null)
        => new(false, code, verifiedCount, FailedSequence: failedSequence);
}
