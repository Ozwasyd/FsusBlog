using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task UpgradeMediaFormatsAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        var enabled = await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
        if (!enabled)
        {
            await AllowWebpFormatAsync(db, tx, "private_media", ct);
            await AllowWebpFormatAsync(db, tx, "private_media_upload", ct);
            if (await CurrentSchema.HasPublicationMediaAsync(db, tx, ct))
                await AllowWebpFormatAsync(db, tx, "article_publication_media", ct);
            if (!await CurrentSchema.VerifyCatalogAsync(db, tx, ct))
                throw new InvalidOperationException("The static WebP schema was not installed.");
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified static WebP media schema.");
    }

    private static async Task AllowWebpFormatAsync(NpgsqlConnection db, NpgsqlTransaction tx, string table, CancellationToken ct)
    {
        await using var lookup = new NpgsqlCommand("""
            select c.conname::text
            from pg_catalog.pg_constraint c join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attname='format'
            where c.conrelid=pg_catalog.to_regclass($1) and c.contype='c' and c.conkey=array[a.attnum]
            """, db, tx);
        lookup.Parameters.AddWithValue("public." + table);
        if (await lookup.ExecuteScalarAsync(ct) is not string name)
            throw new InvalidOperationException("The verified media format check was not found.");

        using var identifiers = new NpgsqlCommandBuilder();
        var relation = identifiers.QuoteIdentifier(table);
        var constraint = identifiers.QuoteIdentifier(name);
        await ExecuteAsync(db, tx, $"""
            ALTER TABLE public.{relation} DROP CONSTRAINT {constraint},
              ADD CONSTRAINT {constraint} CHECK (format >= 1 AND format <= 3)
            """, ct);
    }
}
