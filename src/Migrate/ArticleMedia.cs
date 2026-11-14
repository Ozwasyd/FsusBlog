using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeArticleMediaAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        if (!await HasRelation(connection, tx, CurrentSchema.ArticleMediaRelation, ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: false);
            await ApplySchemaAddition(connection, tx, "private-media-references.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified private article attachment schema.");
    }
}
