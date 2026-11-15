using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private const string DocumentExportColumns =
        "author_document_export owner_id:uuid id:uuid article_id:int4 expected_revision:int8 source_revision:int8 " +
        "author_generation:int8 format:int2 state:int2 failure:int2=0 provider:int2=1 created_at:timestamptz " +
        "started_at:timestamptz? finished_at:timestamptz? expires_at:timestamptz source_digest:bytea output_digest:bytea? output:bytea?";

    private static readonly string[] DocumentExportConstraints =
    [
        "author_document_export p owner_id,id",
        "author_document_export f owner_id public.blog_user:id delete-cascade",
        "author_document_export f article_id,source_revision public.article_revision:article_id,revision delete-cascade",
        "author_document_export c source_revision,expected_revision source_revision>=1ANDsource_revision<=expected_revision",
        "author_document_export c author_generation author_generation>0",
        "author_document_export c format format>=1ANDformat<=4",
        "author_document_export c state state>=1ANDstate<=7",
        "author_document_export c failure failure>=0ANDfailure<=4",
        "author_document_export c expires_at,created_at expires_at>created_at",
        "author_document_export c started_at,created_at started_at>=created_at",
        "author_document_export c finished_at,started_at,created_at finished_at>=COALESCE(started_at,created_at)",
        "author_document_export c state,finished_at (state>=3ANDstate<=6)=(finished_atISNOTNULL)",
        "author_document_export c state,started_at (state<>ALL(ARRAY[2,3,7]))ORstarted_atISNOTNULL",
        "author_document_export c state,failure (state=ANY(ARRAY[4,6]))=(failure<>0)",
        "author_document_export c source_digest octet_length(source_digest)=32",
        "author_document_export c output_digest octet_length(output_digest)=32",
        "author_document_export c output octet_length(output)>=1ANDoctet_length(output)<=4194304",
        "author_document_export c state,output (state=3)=(outputISNOTNULL)",
        "author_document_export c state,output_digest (state=3)=(output_digestISNOTNULL)"
    ];

    internal const string LegacyDocumentExportProviderConstraint = "CHECK (provider = 1)";
    internal const string CurrentDocumentExportProviderConstraint = "CHECK (provider >= 1 AND provider <= 2)";
    internal const string SingleAttachmentProviderConstraint = "CHECK (provider >= 1 AND provider <= 3)";

    internal static async Task<bool> HasCurrentDocumentExportProviderAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select exists(select from pg_catalog.pg_constraint
                where conrelid=pg_catalog.to_regclass('public.author_document_export') and contype='c' and convalidated
                and pg_catalog.pg_get_constraintdef(oid,true) in ($1,$2,$3))
            """, db, tx);
        query.Parameters.AddWithValue(CurrentDocumentExportProviderConstraint);
        query.Parameters.AddWithValue(SingleAttachmentProviderConstraint);
        query.Parameters.AddWithValue("CHECK (provider >= 1 AND provider <= 4)");
        return await query.ExecuteScalarAsync(ct) is true;
    }

    internal static async Task<bool> HasDocumentExportAttachmentsAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, bool list = false)
    {
        await using var query = new NpgsqlCommand("""
            select exists(select from pg_catalog.pg_attribute
                where attrelid=pg_catalog.to_regclass('public.author_document_export') and attname=$1 and not attisdropped)
            """, db, tx);
        query.Parameters.AddWithValue(list ? "attachment_ids" : "attachment_id");
        return await query.ExecuteScalarAsync(ct) is true;
    }

    internal static string ExportImageListCondition(bool portable) =>
        $"attachment_idsISNULLORformat{(portable ? "<>2" : "=1")}ANDcardinality(attachment_ids)>=2ANDcardinality(attachment_ids)<=4ANDarray_ndims(attachment_ids)=1ANDarray_position(attachment_ids,NULL::uuid)ISNULL";

    internal static async Task<string?> FindExportImageListConstraintAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, bool portable)
    {
        await using var query = new NpgsqlCommand("""
            select conname::text from pg_catalog.pg_constraint
            where conrelid=pg_catalog.to_regclass('public.author_document_export') and contype='c' and convalidated
            and regexp_replace(pg_catalog.pg_get_expr(conbin,conrelid,true),'[[:space:]]','','g')=$1
            """, db, tx);
        query.Parameters.AddWithValue(ExportImageListCondition(portable));
        return await query.ExecuteScalarAsync(ct) as string;
    }

    private static readonly string[] DocumentExportIndexes =
    [
        "CREATE INDEX author_document_export_pending ON public.author_document_export USING btree (state, created_at, owner_id, id)",
        "CREATE INDEX author_document_export_expiry ON public.author_document_export USING btree (expires_at)",
        "CREATE INDEX author_document_export_article ON public.author_document_export USING btree (owner_id, article_id, created_at, id)"
    ];

    internal static async Task<bool> HasDocumentExportsAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand(
            "select pg_catalog.to_regclass('public.author_document_export') is not null", db, tx);
        return await query.ExecuteScalarAsync(ct) is true;
    }

    private static async Task VerifyDocumentExportIndexesAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select pg_catalog.pg_get_indexdef(indexrelid) ||
                case when indisvalid and indisready and indislive then '' else ' unexpected-index' end
            from pg_catalog.pg_index
            where indrelid='public.author_document_export'::pg_catalog.regclass
                and not indisprimary
            """, db, tx);
        await using var rows = await query.ExecuteReaderAsync(ct);
        var observed = new List<string>();
        while (await rows.ReadAsync(ct)) observed.Add(rows.GetString(0));
        AssertShape("document export index", DocumentExportIndexes, observed);
    }
}
