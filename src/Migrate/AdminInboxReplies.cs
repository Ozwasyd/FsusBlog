using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeAdminInboxRepliesAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        if (!await HasRelation(connection, tx, CurrentSchema.AdminInboxReplyRelation, ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireAdminInboxReply: false);
            await ApplySchemaAddition(connection, tx, "inbox-admin-replies.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireAdminInboxReply: true);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified administrator inbox reply attribution schema.");
    }
}
