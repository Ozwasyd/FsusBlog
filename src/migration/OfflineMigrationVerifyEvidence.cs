using System.Runtime.ExceptionServices;
using System.Security.Cryptography;

using FsusBlog.Contracts.Migration;
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
    internal async Task<OfflineMigrationCurrentSchemaIssuedArtifact> VerifyExistingAsync(
        OfflineMigrationVerifyExistingCommandOptions options, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        OfflineMigrationHost.ValidateExistingVerifyOptions(options);
        if (owners.Artifacts is null || owners.Authority is null || owners.CurrentSchema is null || owners.Operations is null)
        {
            throw new InvalidOperationException("current_verify_native_owners_not_configured");
        }
        if (options.Request.Database.Provider == CurrentSchemaProviderKind.Sqlite)
        {
            // The current SQLite source observer is not a current-schema verification factory.
            // Refuse before artifact, credential or native reads instead of restoring a raw pair route.
            throw new InvalidOperationException("current_verify_sqlite_owned_current_schema_not_configured");
        }
        OfflineMigrationCurrentSchemaIssuedArtifact existing = await OfflineMigrationCurrentSchemaIssuer.ReadExistingArtifactAsync(
            options.Receipt, owners, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        // Reuse the original production owner: actual PG issuer or typed MySQL creator,
        // complete observation, custody checks and awaited terminal cleanup remain unchanged.
        OfflineMigrationCurrentSchemaIssuedArtifact independentlyObserved = await IssueAsync(
            new(options.Request, options.EnvironmentFilePath, options.Receipt.Reference, options.TimeoutSeconds),
            cancellationToken).ConfigureAwait(false);
        OfflineMigrationCurrentSchemaIssuer.ValidateObservedReceipt(existing.Receipt, independentlyObserved.Receipt);
        cancellationToken.ThrowIfCancellationRequested();
        return await OfflineMigrationCurrentSchemaIssuer.RecheckExistingArtifactAsync(
            options.Receipt, existing.Receipt, existing.Bytes, owners, cancellationToken).ConfigureAwait(false);
    }

    public async Task<OfflineMigrationCurrentSchemaIssuedArtifact> IssueAsync(
        OfflineMigrationVerifyCommandOptions options, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        OfflineMigrationVerifyEvidence.ValidateCommandRequest(options.Request);
        if (owners.Artifacts is null || owners.Authority is null || owners.CurrentSchema is null || owners.Operations is null)
        {
            throw new InvalidOperationException("current_verify_native_owners_not_configured");
        }
        if (options.Request.Database.Provider == CurrentSchemaProviderKind.Sqlite)
        {
            // Structural parsing cannot supply the missing current-schema factory.
            // Refuse before reading artifacts, credentials or a native session.
            throw new InvalidOperationException("current_verify_sqlite_owned_current_schema_not_configured");
        }
        if (options.Request.Database.Provider == CurrentSchemaProviderKind.MySql)
        {
            return await IssueOwnedMySqlArtifactAsync(options, cancellationToken).ConfigureAwait(false);
        }
        OfflineMigrationCurrentSchemaIssuer.ValidateRequest(options.Request);
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
        if (receipt is null) throw new InvalidOperationException("current_verify_native_receipt_missing");
        byte[] bytes = CurrentSchemaReceiptCodec.Serialize(receipt);
        string sha256 = Convert.ToHexStringLower(SHA256.HashData(bytes));
        return new(new($"current-schema/v1/{sha256}", sha256), receipt, bytes);
    }

    private async Task<OfflineMigrationCurrentSchemaIssuedArtifact> IssueOwnedMySqlArtifactAsync(
        OfflineMigrationVerifyCommandOptions options, CancellationToken cancellationToken)
    {
        OfflineMigrationCurrentSchemaIssuer.ValidateOwnedMySqlRequest(options.Request);
        if (owners.Artifacts is null || owners.Authority is null || owners.CurrentSchema is null || owners.Operations is null)
        {
            throw new InvalidOperationException("current_verify_native_owners_not_configured");
        }
        string connectionString = await OfflineMigrationHost.ReadRequiredConnectionStringAsync(
            options.EnvironmentFilePath, cancellationToken).ConfigureAwait(false);
        // Only the original creator opens, mints, invalidates and cleans up this
        // opaque consistent snapshot. Its awaited cleanup precedes serialization
        // or publication eligibility; a raw Snapshot transaction is not accepted.
        CurrentSchemaReceipt receipt = await OfflineMigrationMySqlNativeSession.ObserveOwnedReadAsync(
            connectionString, (context, token) => OfflineMigrationCurrentSchemaIssuer.IssueOwnedMySqlAsync(
                options.Request, context, owners, token), cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
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
        if (primary is not null) ExceptionDispatchInfo.Capture(primary).Throw();
    }
}

internal static class OfflineMigrationVerifyEvidence
{
    internal static void ValidateCommandRequest(OfflineMigrationCurrentSchemaVerifyRequest request)
    {
        // Reuse the original provider-neutral identity validator only. It reads no
        // receipt or native facts and grants no provider readiness or capability.
        OfflineMigrationCurrentSchemaIssuer.ValidateExistingRequest(request);
    }

    internal static OfflineMigrationOwnedVerifyEvidence ComposeOwnedExisting(
        OfflineMigrationCurrentSchemaVerificationCapabilities owners)
    {
        ArgumentNullException.ThrowIfNull(owners);
        return new(owners);
    }

    internal static OfflineMigrationOwnedVerifyEvidence CreateOwnedExisting()
        => ComposeOwnedExisting(OfflineMigrationCurrentSchemaVerificationOwners.CreateOwned());

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
