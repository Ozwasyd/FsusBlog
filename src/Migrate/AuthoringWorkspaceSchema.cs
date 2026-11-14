using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeAuthoringWorkspaceAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var exists = await HasRelation(connection, tx, CurrentSchema.AuthoringWorkspaceRelation, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireAuthoringWorkspace: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (!exists)
        {
            await ApplySchemaAddition(connection, tx, "authoring-workspace.sql", ct);
        }
        if (!await CurrentSchema.HasAuthoringWorkspaceLayoutAsync(connection, tx, ct))
            await ApplySchemaAddition(connection, tx, "workspace-layout.sql", ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireAuthoringWorkspace: true);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the authoring workspace schema.");
    }
}
