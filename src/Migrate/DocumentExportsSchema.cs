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
        const string imageListCheck = """
            check (attachment_ids is null or (format between 1 and 4 and cardinality(attachment_ids) between 2 and 4
                and array_ndims(attachment_ids)=1 and array_position(attachment_ids,null) is null))
            """;
        if (!exists)
            await ApplySchemaAddition(db, tx, "document-exports.sql", ct);
        else if (!await CurrentSchema.HasDocumentExportAttachmentsAsync(db, tx, ct, list: true))
        {
            var single = await CurrentSchema.HasDocumentExportAttachmentsAsync(db, tx, ct);
            await using var constraint = new NpgsqlCommand("""
                select conname::text from pg_catalog.pg_constraint
                where conrelid='public.author_document_export'::pg_catalog.regclass and contype='c' and convalidated
                    and pg_catalog.pg_get_constraintdef(oid,true)=$1
                """, db, tx);
            constraint.Parameters.AddWithValue(single ? CurrentSchema.SingleAttachmentProviderConstraint :
                await CurrentSchema.HasCurrentDocumentExportProviderAsync(db, tx, ct)
                    ? CurrentSchema.CurrentDocumentExportProviderConstraint : CurrentSchema.LegacyDocumentExportProviderConstraint);
            var oldName = await constraint.ExecuteScalarAsync(ct) as string ??
                throw new InvalidOperationException("The legacy document export provider constraint is unavailable.");
            using var quoting = new NpgsqlCommandBuilder();
            var identifier = quoting.QuoteIdentifier(oldName);
            var addSingle = single ? "" : """
                ,add column attachment_id uuid,
                add constraint author_document_export_attachment_check check ((provider=3)=(attachment_id is not null))
                """;
            await using var upgrade = new NpgsqlCommand($"""
                alter table public.author_document_export drop constraint {identifier},
                    add constraint author_document_export_provider_check check (provider between 1 and 4){addSingle},
                    add column attachment_ids uuid[],
                    add check ((provider=4)=(attachment_ids is not null)),
                    add {imageListCheck}
                """, db, tx);
            await upgrade.ExecuteNonQueryAsync(ct);
        }
        else if ((await CurrentSchema.FindExportImageListConstraintAsync(db, tx, ct, ExportImageScope.Portable) ??
            await CurrentSchema.FindExportImageListConstraintAsync(db, tx, ct, ExportImageScope.Html)) is { } previous)
        {
            using var quoting = new NpgsqlCommandBuilder();
            await using var extend = new NpgsqlCommand($"""
                alter table public.author_document_export drop constraint {quoting.QuoteIdentifier(previous)},
                    add {imageListCheck}
                """, db, tx);
            await extend.ExecuteNonQueryAsync(ct);
        }
        if (await CurrentSchema.FindExportImageListConstraintAsync(db, tx, ct, ExportImageScope.All) is null)
            throw new InvalidOperationException("The document export attachment schema is unavailable.");
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireDocumentExports: true);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the private author document exports schema.");
    }
}
