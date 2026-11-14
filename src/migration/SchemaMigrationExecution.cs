using SqlSugar;

namespace FsusBlog.Migration;

internal sealed record SchemaMigrationHistoryEntry(
    string MigrationId,
    string Checksum,
    DateTime AppliedAtUtc,
    string AppVersion,
    bool Succeeded);

internal static class SchemaMigrationTransactionExecutor
{
    internal static async Task ExecuteAsync(
        ISqlSugarClient db,
        ISchemaMigrationDescriptor descriptor,
        Func<SchemaMigrationStep, CancellationToken, Task> executeStep,
        CancellationToken cancellationToken)
    {
        bool requiresRawSessionPreflight = MessageRawSessionRetirementPreflight.RequiresGuard(descriptor);
        if (requiresRawSessionPreflight && !descriptor.Transactional)
        {
            throw new InvalidOperationException("message_raw_session_preflight_transaction_required");
        }
        if (descriptor.Transactional)
        {
            var result = await db.Ado.UseTranAsync(async () =>
            {
                var guardedConnection = requiresRawSessionPreflight ? db.Ado.Connection : null;
                var guardedTransaction = requiresRawSessionPreflight ? db.Ado.Transaction : null;
                if (requiresRawSessionPreflight)
                {
                    await MessageRawSessionRetirementPreflight.RequireEmptyAsync(db, cancellationToken).ConfigureAwait(false);
                }
                for (int i = 0; i < descriptor.Steps.Count; i++)
                {
                    RequireGuardedTransaction();
                    await executeStep(descriptor.Steps[i], cancellationToken).ConfigureAwait(false);
                    RequireGuardedTransaction();
                }

                void RequireGuardedTransaction()
                {
                    if (requiresRawSessionPreflight
                        && (!ReferenceEquals(db.Ado.Connection, guardedConnection)
                            || !ReferenceEquals(db.Ado.Transaction, guardedTransaction)
                            || !ReferenceEquals(guardedTransaction?.Connection, guardedConnection)))
                    {
                        throw new InvalidOperationException("message_raw_session_preflight_transaction_changed");
                    }
                }
            }).ConfigureAwait(false);

            if (!result.IsSuccess)
            {
                throw new InvalidOperationException(
                    $"Schema migration {descriptor.MigrationId} failed.",
                    result.ErrorException);
            }
            return;
        }

        for (int i = 0; i < descriptor.Steps.Count; i++)
        {
            await executeStep(descriptor.Steps[i], cancellationToken).ConfigureAwait(false);
        }
    }
}
