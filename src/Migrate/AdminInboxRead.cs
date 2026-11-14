using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeAdminInboxReadAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        if (!await HasRelation(connection, tx, CurrentSchema.AdminInboxReadRelation, ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireAdminInboxRead: false);
            await ApplySchemaAddition(connection, tx, "inbox-admin-read.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireAdminInboxRead: true);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified shared administrator inbox read schema.");
    }
}
