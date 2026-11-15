using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeDocumentExportsAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        var exists = await CurrentSchema.HasDocumentExportsAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireDocumentExports: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
        if (!exists)
            await ApplySchemaAddition(db, tx, "document-exports.sql", ct);
        else if (!await CurrentSchema.HasDocumentExportAttachmentsAsync(db, tx, ct))
        {
            await using var constraint = new NpgsqlCommand("""
                select conname::text from pg_catalog.pg_constraint
                where conrelid='public.author_document_export'::pg_catalog.regclass and contype='c' and convalidated
                    and pg_catalog.pg_get_constraintdef(oid,true)=$1
                """, db, tx);
            constraint.Parameters.AddWithValue(await CurrentSchema.HasCurrentDocumentExportProviderAsync(db, tx, ct)
                ? CurrentSchema.CurrentDocumentExportProviderConstraint : CurrentSchema.LegacyDocumentExportProviderConstraint);
            var oldName = await constraint.ExecuteScalarAsync(ct) as string ??
                throw new InvalidOperationException("The legacy document export provider constraint is unavailable.");
            using var quoting = new NpgsqlCommandBuilder();
            var identifier = quoting.QuoteIdentifier(oldName);
            await using var upgrade = new NpgsqlCommand($"""
                alter table public.author_document_export drop constraint {identifier},
                    add constraint author_document_export_provider_check check (provider between 1 and 3),
                    add column attachment_id uuid,
                    add constraint author_document_export_attachment_check check ((provider=3)=(attachment_id is not null))
                """, db, tx);
            await upgrade.ExecuteNonQueryAsync(ct);
        }
        if (!await CurrentSchema.HasDocumentExportAttachmentsAsync(db, tx, ct))
            throw new InvalidOperationException("The document export attachment schema is unavailable.");
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireDocumentExports: true);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the private author document exports schema.");
    }
}
