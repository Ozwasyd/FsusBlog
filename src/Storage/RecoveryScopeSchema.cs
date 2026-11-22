using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts RecoveryScopeShape = Table(
        "authoring_recovery_site singleton:bool site_id:uuid",
        "p singleton",
        "c singleton singleton");

    internal static async Task<Guid> ReadRecoverySiteIdAsync(
        NpgsqlConnection database, NpgsqlTransaction transaction, CancellationToken cancellationToken)
    {
        await using var query = new NpgsqlCommand("select site_id from public.authoring_recovery_site where singleton",
            database, transaction);
        return await query.ExecuteScalarAsync(cancellationToken) is Guid id && id != Guid.Empty
            ? id : throw new InvalidOperationException("The recovery scope site id is missing.");
    }
}
