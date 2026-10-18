using System.Runtime.ExceptionServices;
using System.Security.Cryptography;

using FsusBlog.Contracts.SchemaMigration;

using Npgsql;

namespace FsusBlog.Migration;

// Only the original compiled native verifier implements the production port. A
// recorded JSON proof, public carrier or CLI callback cannot produce this result.
internal interface IOfflineMigrationVerifiedReceiptProducer
{
    Task<OfflineMigrationCurrentSchemaIssuedArtifact> IssueAsync(
        OfflineMigrationVerifyCommandOptions options, CancellationToken cancellationToken);
}

internal sealed class OfflineMigrationOwnedVerifyEvidence(
    OfflineMigrationCurrentSchemaVerificationCapabilities owners) : IOfflineMigrationVerifiedReceiptProducer
{
    public async Task<OfflineMigrationCurrentSchemaIssuedArtifact> IssueAsync(
        OfflineMigrationVerifyCommandOptions options, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        OfflineMigrationCurrentSchemaIssuer.ValidateRequest(options.Request);
        if (owners.Artifacts is null || owners.Authority is null || owners.CurrentSchema is null || owners.Operations is null)
        {
            throw new InvalidOperationException("current_verify_native_owners_not_configured");
        }
        string connectionString = await OfflineMigrationHost.ReadRequiredConnectionStringAsync(
            options.EnvironmentFilePath, cancellationToken).ConfigureAwait(false);
        var connection = new NpgsqlConnection(connectionString);
        CurrentSchemaReceipt? receipt = null;
        Exception? primary = null;
        try
        {
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            // The issuer owns its original same-session read-only transaction, native
            // DB identity, complete journal and operation observers. Nothing is supplied
            // here from a plan's assertions as a substitute for those observations.
            receipt = await OfflineMigrationCurrentSchemaIssuer.IssueAsync(
                options.Request, connection, owners, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            primary = error;
        }
        try
        {
            // Await the actual connection terminal. There is no timed wait followed by
            // disposing a still-active task. Bounded physical escalation belongs to the
            // admitted native execution owner and is not proved by Dispose returning.
            await connection.DisposeAsync().ConfigureAwait(false);
        }
        catch
        {
            string category = primary is OperationCanceledException ? "cancelled" : primary is null ? "none" : "failed";
            throw new InvalidOperationException("current_verify_connection_cleanup_unverified_primary_" + category);
        }
        ThrowObservedFailure(primary);
        cancellationToken.ThrowIfCancellationRequested();
        if (receipt is null)
            throw new InvalidOperationException("current_verify_native_receipt_missing");
        byte[] bytes = CurrentSchemaReceiptCodec.Serialize(receipt);
        string sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
        return new(new($"current-schema/v1/{sha256}", sha256), receipt, bytes);
    }

    internal static void ThrowObservedFailure(Exception? primary)
    {
        // The original issuer records a secondary read-only transaction disposal
        // failure on the primary exception. Preserve it across the Host's OCE branch:
        // ordinary cancellation must not conceal an unverified native cleanup.
        if (primary?.Data["current_verify_read_only_cleanup_failed"] is true)
        {
            string category = primary is OperationCanceledException ? "cancelled" : "failed";
            throw new InvalidOperationException("current_verify_transaction_cleanup_unverified_primary_" + category);
        }
        if (primary is not null)
            ExceptionDispatchInfo.Capture(primary).Throw();
    }
}

internal static class OfflineMigrationVerifyEvidence
{
    internal static IOfflineMigrationVerifiedReceiptProducer ComposeOwned(
        OfflineMigrationCurrentSchemaVerificationCapabilities owners)
    {
        ArgumentNullException.ThrowIfNull(owners);
        return new OfflineMigrationOwnedVerifyEvidence(owners);
    }

    internal static IOfflineMigrationVerifiedReceiptProducer CreateOwned()
    {
        // Resolve the original owners before credential reads or opening a connection.
        // This composes real capability ports; missing target/operations/backup bindings
        // retain the original factory's refusal rather than substituting a recorded proof.
        return ComposeOwned(OfflineMigrationCurrentSchemaVerificationOwners.CreateOwned());
    }
}
