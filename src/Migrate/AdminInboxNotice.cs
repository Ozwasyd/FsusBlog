using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeAdminInboxNoticeAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        if (!await HasRelation(connection, tx, CurrentSchema.AdminInboxNoticeRelation, ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireAdminInboxNotice: false);
            await ApplySchemaAddition(connection, tx, "inbox-admin-notice.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireAdminInboxNotice: true);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified administrator inbox notice attribution schema.");
    }
}
