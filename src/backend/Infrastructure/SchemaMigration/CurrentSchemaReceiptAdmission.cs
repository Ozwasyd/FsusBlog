using System.Reflection;
using System.Security.Cryptography;

using FsusBlog.Contracts.SchemaMigration;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

/// <summary>
/// Current-only startup admission. Historical plan, backup, operation and journal
/// validation belongs to the offline tool, never the Server production graph.
/// </summary>
public static class CurrentSchemaReceiptAdmission
{
    /// <summary>Observes an explicit formal receipt and complete native current facts without publishing readiness.</summary>
    public static async Task<CurrentSchemaVerifiedReadObservation> ObserveVerifiedAsync(
        string receiptPath,
        string expectedArtifactSha256,
        string candidateSourceRevision,
        ISqlSugarClient db,
        ISchemaModelInspector inspector,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(receiptPath) || !Path.IsPathFullyQualified(receiptPath)
            || receiptPath != receiptPath.Trim() || receiptPath.Any(char.IsControl))
        {
            throw new InvalidOperationException("current_schema_explicit_receipt_required");
        }
        CurrentSchemaReceiptCodec.RequireDigest(expectedArtifactSha256);
        string actualSourceRevision = ValidateCandidateSource(candidateSourceRevision);
        return await CurrentSchemaStartupVerifier.WithBoundedReceiptAsync(receiptPath, async bytes =>
        {
            if (Convert.ToHexStringLower(SHA256.HashData(bytes)) != expectedArtifactSha256
                || CurrentSchemaReceiptCodec.Deserialize(bytes).Status != CurrentSchemaReceiptStatus.VerifiedCurrent)
            {
                throw new InvalidOperationException("current_receipt_artifact_admission_failed");
            }
            var observer = new CurrentSchemaReadObserver(db, inspector);
            CurrentSchemaOwnedReadSnapshot snapshot = await observer.ReadOwnedAdmissionSnapshotAsync(cancellationToken)
                .ConfigureAwait(false);
            CurrentSchemaReceipt receipt = Validate(bytes, expectedArtifactSha256, snapshot.Admission);
            cancellationToken.ThrowIfCancellationRequested();
            return new CurrentSchemaVerifiedReadObservation(
                new CurrentSchemaAdmissionResult(receipt, actualSourceRevision, expectedArtifactSha256),
                snapshot.Schema, snapshot.Session);
        }, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Re-reads the explicit receipt and live database without publishing readiness or issuing writes.</summary>
    public static async Task<CurrentSchemaAdmissionResult> VerifyAsync(
        string receiptPath,
        string expectedArtifactSha256,
        string candidateSourceRevision,
        ISqlSugarClient db,
        ISchemaModelInspector inspector,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(receiptPath) || !Path.IsPathFullyQualified(receiptPath)
            || receiptPath != receiptPath.Trim() || receiptPath.Any(char.IsControl))
        {
            throw new InvalidOperationException("current_schema_explicit_receipt_required");
        }
        CurrentSchemaReceiptCodec.RequireDigest(expectedArtifactSha256);
        string actualSourceRevision = ValidateCandidateSource(candidateSourceRevision);
        byte[] bytes = await CurrentSchemaStartupVerifier.ReadBoundedReceiptAsync(
            receiptPath, cancellationToken).ConfigureAwait(false);
        var observer = new CurrentSchemaReadObserver(db, inspector);
        CurrentSchemaAdmissionObservation actual = await observer.ReadAdmissionAsync(cancellationToken)
            .ConfigureAwait(false);
        CurrentSchemaReceipt receipt = Validate(bytes, expectedArtifactSha256, actual);
        cancellationToken.ThrowIfCancellationRequested();
        return new CurrentSchemaAdmissionResult(receipt, actualSourceRevision, expectedArtifactSha256);
    }

    /// <summary>Consumes actual retained receipt bytes through the original fresh read-only observer.</summary>
    internal static async Task<CurrentSchemaAdmissionResult> VerifyOriginalHeldReceiptAsync(
        OriginalCurrentSchemaReceipt original,
        string candidateSourceRevision,
        ISqlSugarClient db,
        ISchemaModelInspector inspector,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(original);
        cancellationToken.ThrowIfCancellationRequested();
        string actualSourceRevision = ValidateCandidateSource(candidateSourceRevision);
        original.ValidateUnchanged(cancellationToken);
        var observer = new CurrentSchemaReadObserver(db, inspector);
        CurrentSchemaAdmissionObservation actual = await observer.ReadAdmissionAsync(cancellationToken)
            .ConfigureAwait(false);
        original.ValidateUnchanged(cancellationToken);
        CurrentSchemaReceipt receipt = original.ValidateAgainst(actual, cancellationToken);
        original.ValidateUnchanged(cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        return new CurrentSchemaAdmissionResult(receipt, actualSourceRevision, original.ArtifactSha256);
    }

    /// <summary>Binds the original artifact bytes to fresh target, native database and physical-schema facts.</summary>
    public static CurrentSchemaReceipt Validate(
        ReadOnlyMemory<byte> receiptBytes,
        string expectedArtifactSha256,
        CurrentSchemaAdmissionObservation actual)
    {
        ArgumentNullException.ThrowIfNull(actual);
        CurrentSchemaReceiptCodec.RequireDigest(expectedArtifactSha256);
        string actualArtifactSha256 = Convert.ToHexStringLower(SHA256.HashData(receiptBytes.Span));
        if (expectedArtifactSha256 != actualArtifactSha256)
        {
            throw new InvalidOperationException("current_receipt_artifact_digest_mismatch");
        }
        CurrentSchemaReceipt receipt = CurrentSchemaReceiptCodec.Deserialize(receiptBytes);
        CurrentSchemaReceiptCodec.ValidateTarget(actual.Target);
        CurrentSchemaReceiptCodec.ValidateDatabase(actual.Database);
        CurrentSchemaReceiptCodec.RequireDigest(actual.ActualSchemaDigest);
        if (receipt.Status != CurrentSchemaReceiptStatus.VerifiedCurrent
            || receipt.Target != actual.Target || receipt.Database != actual.Database
            || receipt.ActualSchemaDigest != actual.ActualSchemaDigest)
        {
            throw new InvalidOperationException("current_receipt_live_admission_mismatch");
        }
        return receipt;
    }

    /// <summary>Requires the deployment-pinned candidate revision to match this assembly's real source metadata.</summary>
    public static string ValidateCandidateSource(string expectedSourceRevision)
    {
        string? source = typeof(CurrentSchemaReceiptAdmission).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .SingleOrDefault(static attribute => attribute.Key == "FsusBlog.SourceCommit")?.Value;
        if (expectedSourceRevision is null || expectedSourceRevision.Length != 40
            || expectedSourceRevision.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
            || expectedSourceRevision == new string('0', 40) || source != expectedSourceRevision)
        {
            throw new InvalidOperationException("current_receipt_candidate_source_mismatch");
        }
        return expectedSourceRevision;
    }
}

/// <summary>A completed owned read-only observation; this data does not publish startup state or execution qualification.</summary>
public sealed record CurrentSchemaVerifiedReadObservation(
    CurrentSchemaAdmissionResult Admission,
    CurrentSchemaReadObservation Schema,
    CurrentSchemaNativeSessionIdentity Session);

/// <summary>Published only after real current-only startup admission; no default success exists.</summary>
public sealed record CurrentSchemaAdmissionResult(
    CurrentSchemaReceipt Receipt,
    string CandidateSourceRevision,
    string ArtifactSha256);

/// <summary>Holds only a completed startup admission and starts without any readiness claim.</summary>
public sealed class CurrentSchemaAdmissionState
{
    private CurrentSchemaAdmissionResult? _current;

    /// <summary>The latest successful startup admission, or null before success or after a new attempt begins.</summary>
    public CurrentSchemaAdmissionResult? Current => Volatile.Read(ref _current);

    internal void Publish(CurrentSchemaAdmissionResult result) => Volatile.Write(ref _current, result);

    internal void Clear() => Volatile.Write(ref _current, null);
}
