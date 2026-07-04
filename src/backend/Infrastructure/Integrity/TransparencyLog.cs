using System.Data.Common;
using System.Globalization;
using System.Text;
using FsusBlog.Core.Integrity;
using FsusBlog.Server.Entities;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Integrity;

public interface IPublishProofTransparencyLog
{
    Task<IntegrityTransparencyLogEntry> AppendPublishProofAsync(long proofId, CancellationToken cancellationToken = default);

    Task<TransparencyLogVerificationResult> VerifyAsync(CancellationToken cancellationToken = default);

    Task<IntegrityTransparencyLogEntry?> GetLatestHeadAsync(CancellationToken cancellationToken = default);

    Task<IntegrityTransparencyLogEntry?> GetDailyHeadAsync(DateOnly date, CancellationToken cancellationToken = default);
}

public sealed class PublishProofTransparencyLog(ISqlSugarClient db) : IPublishProofTransparencyLog
{
    public async Task<IntegrityTransparencyLogEntry> AppendPublishProofAsync(
        long proofId,
        CancellationToken cancellationToken = default)
    {
        if (proofId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(proofId), proofId, "Proof id must be positive.");
        }

        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            await AcquireAppendLockAsync(cancellationToken).ConfigureAwait(false);

            IntegrityTransparencyLogEntry? existing = await db.Queryable<IntegrityTransparencyLogEntry>()
                .Where(entry => entry.EntryType == TransparencyLogEntryTypes.PublishProof && entry.ProofId == proofId)
                .FirstAsync(cancellationToken)
                .ConfigureAwait(false);
            if (existing is not null)
            {
                await LinkProofAsync(proofId, existing, cancellationToken).ConfigureAwait(false);
                return existing;
            }

            ArticlePublishProof proof = await LoadProofAsync(proofId, cancellationToken).ConfigureAwait(false);
            IntegrityTransparencyLogEntry? latest = await GetLatestHeadAsync(cancellationToken).ConfigureAwait(false);
            long seq = (latest?.Seq ?? 0) + 1;
            string prevHash = latest?.EntryHash ?? TransparencyLogEntryCanonicalizer.GenesisPreviousHash;
            DateTime createdAt = DateTime.UtcNow;
            string entryPayloadHash = ComputePublishProofPayloadHash(proof);
            var input = new TransparencyLogEntryInput(
                Seq: seq,
                EntryType: TransparencyLogEntryTypes.PublishProof,
                ProofId: proof.Id,
                ArticleId: proof.ArticleId,
                ArticleRevisionId: proof.ArticleRevisionId,
                RevisionNo: proof.RevisionNo,
                EntryPayloadHash: entryPayloadHash,
                PrevEntryHash: prevHash,
                CreatedAtUtc: new DateTimeOffset(createdAt, TimeSpan.Zero),
                SigningKeyId: proof.SigningKeyId,
                SignatureBase64Url: proof.SignatureBase64Url);
            string entryHash = TransparencyLogEntryCanonicalizer.ComputeEntryHashHex(input);
            var entry = new IntegrityTransparencyLogEntry
            {
                Seq = seq,
                EntryType = TransparencyLogEntryTypes.PublishProof,
                ProofId = proof.Id,
                ArticleId = proof.ArticleId,
                ArticleRevisionId = proof.ArticleRevisionId,
                RevisionNo = proof.RevisionNo,
                EntryPayloadHash = entryPayloadHash,
                PrevEntryHash = prevHash,
                EntryHash = entryHash,
                CreatedAt = createdAt,
                SigningKeyId = proof.SigningKeyId,
                SignatureBase64Url = proof.SignatureBase64Url
            };

            entry.Id = await db.Insertable(entry).ExecuteReturnBigIdentityAsync();
            await LinkProofAsync(proofId, entry, cancellationToken).ConfigureAwait(false);
            return entry;
        }).ConfigureAwait(false);

        if (!transaction.IsSuccess || transaction.Data is null)
        {
            throw new InvalidOperationException("Failed to append publish proof transparency log entry.", transaction.ErrorException);
        }

        return transaction.Data;
    }

    public async Task<TransparencyLogVerificationResult> VerifyAsync(CancellationToken cancellationToken = default)
    {
        List<IntegrityTransparencyLogEntry> entries = await db.Queryable<IntegrityTransparencyLogEntry>()
            .OrderBy(entry => entry.Seq)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        return TransparencyLogChainVerifier.Verify(entries.Select(ToRecord));
    }

    public async Task<IntegrityTransparencyLogEntry?> GetLatestHeadAsync(CancellationToken cancellationToken = default)
        => await db.Queryable<IntegrityTransparencyLogEntry>()
            .OrderByDescending(entry => entry.Seq)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);

    public async Task<IntegrityTransparencyLogEntry?> GetDailyHeadAsync(DateOnly date, CancellationToken cancellationToken = default)
    {
        DateTime start = date.ToDateTime(TimeOnly.MinValue, DateTimeKind.Utc);
        DateTime end = start.AddDays(1);
        return await db.Queryable<IntegrityTransparencyLogEntry>()
            .Where(entry => entry.CreatedAt >= start && entry.CreatedAt < end)
            .OrderByDescending(entry => entry.Seq)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task AcquireAppendLockAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT pg_advisory_xact_lock(hashtext('integrity_transparency_log'));")
            .ConfigureAwait(false);
        await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<ArticlePublishProof> LoadProofAsync(long proofId, CancellationToken cancellationToken)
    {
        ArticlePublishProof? proof = await db.Queryable<ArticlePublishProof>()
            .Where(item => item.Id == proofId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        return proof ?? throw new InvalidOperationException("Publish proof not found.");
    }

    private Task<int> LinkProofAsync(
        long proofId,
        IntegrityTransparencyLogEntry entry,
        CancellationToken cancellationToken)
        => db.Updateable<ArticlePublishProof>()
            .SetColumns(proof => proof.TransparencyLogEntryId == entry.Id)
            .SetColumns(proof => proof.TransparencyLogEntryHash == entry.EntryHash)
            .Where(proof => proof.Id == proofId)
            .ExecuteCommandAsync(cancellationToken);

    private static TransparencyLogEntryRecord ToRecord(IntegrityTransparencyLogEntry entry)
        => new(
            entry.Seq,
            entry.EntryType,
            entry.ProofId,
            entry.ArticleId,
            entry.ArticleRevisionId,
            entry.RevisionNo,
            entry.EntryPayloadHash,
            entry.PrevEntryHash,
            entry.EntryHash,
            new DateTimeOffset(DateTime.SpecifyKind(entry.CreatedAt, DateTimeKind.Utc)),
            entry.SigningKeyId,
            entry.SignatureBase64Url);

    private static string ComputePublishProofPayloadHash(ArticlePublishProof proof)
    {
        var builder = new StringBuilder(768);
        AppendLine(builder, "fsusblog.integrity.publish-proof-log-payload.v1");
        AppendLong(builder, "proofId", proof.Id);
        AppendInt(builder, "proofVersion", proof.ProofVersion);
        AppendInt(builder, "signaturePayloadVersion", proof.SignaturePayloadVersion);
        AppendInt(builder, "articleId", proof.ArticleId);
        AppendLong(builder, "articleRevisionId", proof.ArticleRevisionId);
        AppendInt(builder, "revisionNo", proof.RevisionNo);
        AppendString(builder, "idempotencyKey", proof.IdempotencyKey);
        AppendString(builder, "canonicalHash", proof.CanonicalHash);
        AppendString(builder, "aotHash", proof.AotHash);
        AppendString(builder, "articleDetailAedsHash", proof.ArticleDetailAedsHash);
        AppendString(builder, "publicHotReadHash", proof.PublicHotReadHash);
        AppendString(builder, "assetManifestHash", proof.AssetManifestHash);
        AppendString(builder, "feedHash", proof.FeedHash);
        AppendDateTime(builder, "publishedAt", proof.PublishedAt);
        AppendString(builder, "proofStatus", proof.ProofStatus);
        AppendString(builder, "signingKeyId", proof.SigningKeyId);
        AppendString(builder, "signingAlgorithm", proof.SigningAlgorithm);
        AppendString(builder, "signature", proof.SignatureBase64Url);
        return TransparencyLogPayloadHasher.ComputeUtf8HashHex(
            TransparencyLogEntryTypes.PublishProof,
            builder.ToString());
    }

    private static void AppendLine(StringBuilder builder, string value)
        => builder.Append(value).Append('\n');

    private static void AppendInt(StringBuilder builder, string field, int value)
        => AppendLine(builder, $"{field}:i:{value.ToString(CultureInfo.InvariantCulture)}");

    private static void AppendLong(StringBuilder builder, string field, long value)
        => AppendLine(builder, $"{field}:i:{value.ToString(CultureInfo.InvariantCulture)}");

    private static void AppendDateTime(StringBuilder builder, string field, DateTime value)
        => AppendLine(builder, $"{field}:t:{DateTime.SpecifyKind(value, DateTimeKind.Utc).ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture)}");

    private static void AppendString(StringBuilder builder, string field, string? value)
        => AppendLine(
            builder,
            value is null
                ? $"{field}:n"
                : $"{field}:s:{Convert.ToBase64String(Encoding.UTF8.GetBytes(value.Trim().Normalize(NormalizationForm.FormC)))}");
}
