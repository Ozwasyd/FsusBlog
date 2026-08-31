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
        if (descriptor.Transactional)
        {
            var result = await db.Ado.UseTranAsync(async () =>
            {
                for (int i = 0; i < descriptor.Steps.Count; i++)
                {
                    await executeStep(descriptor.Steps[i], cancellationToken).ConfigureAwait(false);
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
