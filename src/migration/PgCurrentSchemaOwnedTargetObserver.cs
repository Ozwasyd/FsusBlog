using System.Data.Common;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Contracts.SchemaMigration;
using FsusBlog.Shared.Algorithms.Schema;

namespace FsusBlog.Migration;

// The target comes only from an actual original-owner invocation. The native
// database tuple comes from the issuer's sole capture, never from a plan.
internal sealed class PgCurrentSchemaOwnedTargetObserver(OwnedCurrentSchemaTarget owned) : IOfflineMigrationCurrentSchemaObserver
{
    internal OwnedCurrentSchemaTarget OwnedTarget { get; } = owned;

    public async Task<CurrentSchemaAdmissionObservation> ObserveAsync(
        DbConnection connection, DbTransaction transaction, CurrentSchemaDatabaseIdentity observedDatabase,
        CancellationToken cancellationToken)
    {
        CurrentSchemaReceiptCodec.ValidateDatabase(observedDatabase);
        if (observedDatabase.Provider != CurrentSchemaProviderKind.PostgreSql)
            throw new InvalidOperationException("current_schema_owned_native_provider_mismatch");
        await OwnedTarget.RevalidateRetainedArtifactAsync(cancellationToken).ConfigureAwait(false);
        PgCurrentOwnedSnapshot snapshot = await ReadOwnedDomainAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        CurrentSchemaCompletePhysicalProjection expected = OwnedTarget.ProjectExpectedPhysicalTarget(SchemaProviderKind.PostgreSql);
        IReadOnlyList<string> errors = Compare(expected, snapshot.Complete, snapshot.Effects);
        if (errors.Count != 0)
            throw new InvalidOperationException("current_schema_owned_native_mismatch:" + string.Join(',', errors));
        CurrentSchemaIdentity identity = OwnedTarget.Target;
        return new(new CurrentSchemaTargetIdentity(identity.ModelVersion, identity.ExtractorVersion, identity.GeneratorVersion,
            identity.SourceDigest, identity.ContentDigest), observedDatabase,
            CurrentSchemaCanonicalAuthority.ComputeObservationDigest(snapshot.Complete.Tables));
    }

    internal static async Task<PgCurrentOwnedSnapshot> ReadOwnedDomainAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        SchemaModelSnapshot complete = await PgCurrentSchemaCatalogObserver.ReadAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        PgCurrentSchemaEffectObservation effects = await PgCurrentSchemaEffectObserver.ReadAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        if (!complete.Tables.ContainsKey(OfflineMigrationStateStore.ApplyJournalTableName))
            return new(complete, complete, effects);
        // The original journal owner, not a copied current table mapping, validates
        // its exact control shape on this same connection and transaction. Retain
        // the complete native snapshot for its original physical observation hash.
        await OfflineMigrationStateStore.ValidateApplyJournalAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        var tables = complete.Tables.Where(static table => table.Key != OfflineMigrationStateStore.ApplyJournalTableName)
            .ToDictionary(static table => table.Key, static table => table.Value, StringComparer.Ordinal);
        // Domain is solely the empty-source predicate's business-table view.
        // Final target comparison uses Complete and every raw expression.
        return new(complete, new SchemaModelSnapshot(tables, complete.Identity, complete.Provider), effects);
    }

    internal static IReadOnlyList<string> Compare(CurrentSchemaCompletePhysicalProjection expected, SchemaModelSnapshot actual,
        PgCurrentSchemaEffectObservation effects)
        => PgCurrentSchemaNativeObserver.Compare(expected, actual, effects);
}

internal sealed record PgCurrentOwnedSnapshot(SchemaModelSnapshot Complete, SchemaModelSnapshot Domain, PgCurrentSchemaEffectObservation Effects);
