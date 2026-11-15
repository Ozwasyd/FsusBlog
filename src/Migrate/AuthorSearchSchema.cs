using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeAuthorSearchAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var exists = await CurrentSchema.HasAuthorTextIndexAsync(connection, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireAuthorTextIndex: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (!exists)
            await ApplySchemaAddition(connection, tx, "author-search.sql", ct);
        if (!await CurrentSchema.HasAuthorTextSummaryIndexAsync(connection, tx, ct))
            await ApplySchemaAddition(connection, tx, "author-search.v2.sql", ct);
        if (!await CurrentSchema.HasAuthorTextHeadingIndexAsync(connection, tx, ct))
            await ApplySchemaAddition(connection, tx, "author-search.v3.sql", ct);
        if (!await CurrentSchema.HasAuthorTextPropertyIndexAsync(connection, tx, ct))
            await ApplySchemaAddition(connection, tx, "zz-author-search.v4.sql", ct);
        if (!await CurrentSchema.HasAuthorTextRebuildAsync(connection, tx, ct))
            await ApplySchemaAddition(connection, tx, "zz-author-search.v5.sql", ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireAuthorTextIndex: true,
            requireAuthorTextSummaryIndex: true, requireAuthorTextHeadingIndex: true, requireAuthorTextPropertyIndex: true,
            requireAuthorTextRebuild: true);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the author full-text index schema.");
    }
}
