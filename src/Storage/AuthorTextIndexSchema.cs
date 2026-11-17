using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static string[] AuthorTextIndexColumns(bool hasSummary, bool hasHeading) =>
    [
        "author_text_document owner_id:uuid article_id:int4 revision:int8 profile:int4 title_digest:bytea body_digest:bytea" +
            (hasSummary ? " summary_digest:bytea" : ""),
        "author_text_posting owner_id:uuid article_id:int4 field:int4 ordinal:int4 term:bytea start_u16:int4 end_u16:int4 start_u8:int4 end_u8:int4" +
            (hasHeading ? " segment:int4=0" : "")
    ];

    private static string[] AuthorTextIndexConstraints(bool hasSummary, bool hasHeading) =>
    [
        "author_text_document p owner_id,article_id",
        "author_text_document f owner_id public.blog_user:id",
        "author_text_document f article_id,revision public.article_revision:article_id,revision",
        hasHeading ? "author_text_document c profile profile>=1ANDprofile<=3" :
            hasSummary ? "author_text_document c profile profile>=1ANDprofile<=2" : "author_text_document c profile profile=1",
        "author_text_document c title_digest octet_length(title_digest)=32",
        "author_text_document c body_digest octet_length(body_digest)=32",
        "author_text_posting p owner_id,term,article_id,field,ordinal",
        "author_text_posting u owner_id,article_id,field,ordinal",
        "author_text_posting f owner_id,article_id public.author_text_document:owner_id,article_id",
        hasHeading ? "author_text_posting c field field>=1ANDfield<=4" :
            hasSummary ? "author_text_posting c field field>=1ANDfield<=3" : "author_text_posting c field field>=1ANDfield<=2",
        "author_text_posting c ordinal ordinal>=0ANDordinal<=199999",
        "author_text_posting c term octet_length(term)>=1ANDoctet_length(term)<=512",
        "author_text_posting c start_u16 start_u16>=0",
        "author_text_posting c start_u8 start_u8>=0",
        "author_text_posting c start_u16,end_u16 start_u16<end_u16",
        "author_text_posting c start_u8,end_u8 start_u8<end_u8",
        .. (hasSummary ? new[] { "author_text_document c summary_digest octet_length(summary_digest)=32" } : []),
        .. (hasHeading ? new[] { "author_text_posting c field,segment field=4ANDsegment>=1ANDsegment<=200000ORfield<>4ANDsegment=0" } : [])
    ];

    internal static async Task<bool> HasAuthorTextIndexAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select case when count(obj.oid)=0 then 0
                        when count(*) filter (where obj.relkind::text=expected.kind)=4 then 1
                        else 2 end
            from (values (pg_catalog.to_regclass('public.author_text_document'), 'r'),
                         (pg_catalog.to_regclass('public.author_text_posting'), 'r'),
                         (pg_catalog.to_regclass('public.author_text_posting_owner_article'), 'i'),
                         (pg_catalog.to_regclass('public.author_text_article_owner'), 'i')) expected(oid,kind)
            left join pg_catalog.pg_class obj on obj.oid=expected.oid
            """, db, tx);
        return Complete(await query.ExecuteScalarAsync(ct), 1,
            "The author full-text index schema is incomplete.");
    }

    internal static Task<bool> HasAuthorTextSummaryIndexAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasColumnAndCheckAsync(db, tx, ct, "public.author_text_document", "summary_digest",
            "author_text_document_summary_digest_check", "The author full-text summary index schema is incomplete.");

    internal static Task<bool> HasAuthorTextHeadingIndexAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasColumnAndCheckAsync(db, tx, ct, "public.author_text_posting", "segment",
            "author_text_posting_segment_check", "The author full-text heading index schema is incomplete.", requireLocalValidated: true);

    private static async Task VerifyAuthorTextArticleOwnerIndexAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select exists (
                select from pg_catalog.pg_class rel
                join pg_catalog.pg_am method on method.oid=rel.relam and method.amname='btree'
                join pg_catalog.pg_index idx on idx.indexrelid=rel.oid and idx.indrelid='public.article'::regclass
                join pg_catalog.pg_attribute owner_key on owner_key.attrelid=idx.indrelid and owner_key.attname='owner_id'
                join pg_catalog.pg_attribute article_key on article_key.attrelid=idx.indrelid and article_key.attname='id'
                join pg_catalog.pg_opclass uuid_ops on uuid_ops.oid=idx.indclass[0] and uuid_ops.opcmethod=method.oid
                    and uuid_ops.opcnamespace='pg_catalog'::regnamespace and uuid_ops.opcname='uuid_ops'
                join pg_catalog.pg_opclass int_ops on int_ops.oid=idx.indclass[1] and int_ops.opcmethod=method.oid
                    and int_ops.opcnamespace='pg_catalog'::regnamespace and int_ops.opcname='int4_ops'
                where rel.oid='public.author_text_article_owner'::regclass and rel.relpersistence='p'
                    and idx.indisvalid and idx.indisready and idx.indislive and not idx.indisunique
                    and idx.indpred is null and idx.indexprs is null and idx.indnkeyatts=2 and idx.indnatts=2
                    and idx.indkey[0]=owner_key.attnum and idx.indkey[1]=article_key.attnum
                    and idx.indoption[0]=0 and idx.indoption[1]=0
            )
            """, db, tx);
        if (await query.ExecuteScalarAsync(ct) is not true)
            throw new InvalidOperationException("The author article owner index does not match the current schema.");
    }
}
