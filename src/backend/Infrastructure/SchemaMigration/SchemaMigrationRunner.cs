using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public interface ISchemaMigrationRunner
{
    Task RunAsync(CancellationToken cancellationToken);
}

public sealed class CurrentSchemaMismatchException : InvalidOperationException
{
    public CurrentSchemaMismatchException(
        string expectedDigest,
        string actualDigest,
        string mismatchRef,
        IReadOnlyList<string> errors)
        : base(
            $"schema_current_mismatch ref={mismatchRef} expectedDigest={expectedDigest} actualDigest={actualDigest}{FormatErrors(errors)}")
    {
        ExpectedDigest = expectedDigest;
        ActualDigest = actualDigest;
        MismatchRef = mismatchRef;
        Errors = errors;
    }

    public string ExpectedDigest
    {
        get;
    }

    public string ActualDigest
    {
        get;
    }

    public string MismatchRef
    {
        get;
    }

    public IReadOnlyList<string> Errors
    {
        get;
    }

    private static string FormatErrors(IReadOnlyList<string> errors)
        => errors.Count == 0
            ? string.Empty
            : $"{Environment.NewLine}- {string.Join($"{Environment.NewLine}- ", errors)}";
}

/// <summary>A production receipt admission failure that must stop the business host in every environment.</summary>
public sealed class CurrentSchemaAdmissionException : InvalidOperationException
{
    internal CurrentSchemaAdmissionException(bool cancelled)
        : base(cancelled ? "current_schema_receipt_admission_cancelled" : "current_schema_receipt_admission_failed")
    {
    }
}

public sealed class CurrentSchemaStartupVerifier(
    ISqlSugarClient db,
    ISchemaModelInspector inspector,
    Microsoft.Extensions.Configuration.IConfiguration configuration,
    CurrentSchemaAdmissionState admissionState) : ISchemaMigrationRunner
{
    internal const string HistoryTableName = "__fsus_schema_migration_history";

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        admissionState.Clear();
        try
        {
            string receiptPath = configuration["SchemaMigration:CurrentReceipt:Path"] ?? string.Empty;
            string receiptSha256 = configuration["SchemaMigration:CurrentReceipt:Sha256"] ?? string.Empty;
            string sourceRevision = configuration["SchemaMigration:CurrentReceipt:CandidateSourceRevision"] ?? string.Empty;
            CurrentSchemaAdmissionResult result = await CurrentSchemaReceiptAdmission.VerifyAsync(
                receiptPath, receiptSha256, sourceRevision, db, inspector, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            admissionState.Publish(result);
        }
        catch (Exception exception) when (exception is not CurrentSchemaMismatchException
            and not CurrentSchemaAdmissionException)
        {
            // Keep file/connection exception details out of startup reporting. A fixed
            // fatal category, rather than environment-specific logging, owns admission.
            throw new CurrentSchemaAdmissionException(exception is OperationCanceledException);
        }
    }

    internal static async Task<byte[]> ReadBoundedReceiptAsync(
        string path,
        CancellationToken cancellationToken)
    {
        const int MaximumBytes = FsusBlog.Contracts.SchemaMigration.CurrentSchemaReceiptCodec.MaximumEncodedBytes;
        await using var file = new FileStream(
            path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.Asynchronous);
        if (file.Length == 0 || file.Length > MaximumBytes)
        {
            throw new InvalidOperationException("current_schema_receipt_size_invalid");
        }
        using var bytes = new MemoryStream((int)file.Length);
        byte[] buffer = new byte[4096];
        int count;
        while ((count = await file.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) != 0)
        {
            if (bytes.Length + count > MaximumBytes)
            {
                throw new InvalidOperationException("current_schema_receipt_size_exceeded");
            }
            bytes.Write(buffer, 0, count);
        }
        return bytes.ToArray();
    }
}
