using System.Runtime.ExceptionServices;

using FsusBlog.Algorithms.IO;
using FsusBlog.Contracts.Schema;

using Microsoft.Win32.SafeHandles;

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
        => await WithBoundedReceiptAsync(path, static bytes => Task.FromResult(bytes), cancellationToken).ConfigureAwait(false);

    internal static async Task<T> WithBoundedReceiptAsync<T>(
        string path,
        Func<byte[], Task<T>> observe,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(path)
            || path.Split('/', '\\').Any(value => value.Equals("latest", StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException("current_schema_explicit_receipt_required");
        }
        const int MaximumBytes = FsusBlog.Contracts.SchemaMigration.CurrentSchemaReceiptCodec.MaximumEncodedBytes;
        SafeFileHandle? handle = null;
        FileStream? file = null;
        NativeRegularFileGuard.OriginalRegularFileIdentity? initial = null;
        byte[]? original = null;
        T result = default!;
        Exception? primary = null;
        var secondary = new List<Exception>();
        try
        {
            handle = NativeRegularFileGuard.OpenOriginalRegularFile(path, cancellationToken);
            initial = NativeRegularFileGuard.CaptureOriginalRegularFileIdentity(path, handle, cancellationToken);
            // A native descriptor is synchronous; do not claim managed async-handle metadata.
            file = new FileStream(handle, FileAccess.Read, 4096);
            long length = file.Length;
            if (length is <= 0 or > MaximumBytes)
            {
                throw new InvalidOperationException("current_schema_receipt_size_invalid");
            }
            byte[] bytes = new byte[checked((int)length)];
            await file.ReadExactlyAsync(bytes.AsMemory(), cancellationToken).ConfigureAwait(false);
            byte[] trailing = new byte[1];
            if (await file.ReadAsync(trailing.AsMemory(), cancellationToken).ConfigureAwait(false) != 0)
            {
                throw new InvalidOperationException("current_schema_receipt_size_exceeded");
            }
            NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(path, handle, initial, cancellationToken);
            original = bytes.ToArray();
            result = await observe(bytes).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            primary = exception;
        }
        finally
        {
            if (file is not null && handle is not null && initial is not null && original is not null)
            {
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                try
                {
                    NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(path, handle, initial, cleanup.Token);
                    file.Position = 0;
                    byte[] after = new byte[original.Length];
                    await file.ReadExactlyAsync(after.AsMemory(), cleanup.Token).ConfigureAwait(false);
                    byte[] trailing = new byte[1];
                    if (!original.AsSpan().SequenceEqual(after)
                        || await file.ReadAsync(trailing.AsMemory(), cleanup.Token).ConfigureAwait(false) != 0)
                    {
                        throw new InvalidOperationException("current_receipt_artifact_changed");
                    }
                    NativeRegularFileGuard.ValidateOriginalRegularFileUnchanged(path, handle, initial, cleanup.Token);
                }
                catch (Exception exception)
                {
                    secondary.Add(exception);
                }
            }
            if (file is not null)
            {
                try
                {
                    await file.DisposeAsync().ConfigureAwait(false);
                }
                catch (Exception exception)
                {
                    secondary.Add(exception);
                }
            }
            try
            {
                handle?.Dispose();
            }
            catch (Exception exception)
            {
                secondary.Add(exception);
            }
        }
        if (secondary.Count > 0)
        {
            if (primary is not null)
            {
                secondary.Insert(0, primary);
            }
            throw new AggregateException("current_schema_receipt_scope_failed", secondary);
        }
        if (primary is not null)
        {
            ExceptionDispatchInfo.Capture(primary).Throw();
        }
        cancellationToken.ThrowIfCancellationRequested();
        return result;
    }
}
