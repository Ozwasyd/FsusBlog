using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts ArticleReadShape = Tables(
        Table("article_read_hour article_id:int4 hour_utc:timestamptz count:int8",
            "p article_id,hour_utc",
            "f article_id public.article:id",
            "c article_id article_id>0",
            "c hour_utc isfinite(hour_utc)",
            "c hour_utc hour_utc=date_trunc('hour'::text,hour_utc,'UTC'::text)",
            "c count count>0"),
        Table("article_read_dwell article_id:int4 day_utc:date bucket:int4 count:int8",
            "p article_id,day_utc,bucket",
            "f article_id public.article:id",
            "c article_id article_id>0",
            "c day_utc isfinite(day_utc)",
            "c bucket bucket>=0ANDbucket<=3",
            "c count count>0"),
        Table("article_read_epoch singleton:bool last_epoch:int8?",
            "p singleton",
            "c singleton singleton",
            "c last_epoch last_epoch>=0"));

    private static readonly SchemaFacts ArticleReadTotalShape = Table(
        "article_read_total article_id:int4 views:int4",
        "p article_id",
        "f article_id public.article:id",
        "c article_id article_id>0",
        "c views views>0");

    private static readonly RelationGroup ArticleReadRelations = new(
        "Article read aggregate storage is incomplete.",
        "public.article_read_hour", "public.article_read_dwell", "public.article_read_epoch");

    internal static Task<bool> HasArticleReadSchemaAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        ArticleReadRelations.IsPresentAsync(db, tx, ct);

    internal static async Task<bool> HasArticleReadTotalSchemaAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select case
                when names.table_oid is null and names.index_oid is null then 0
                when total.relkind='r' and ranked.relkind='i' and tree.amname='btree'
                    and idx.indrelid=names.table_oid and idx.indisvalid and idx.indisready and idx.indislive
                    and not idx.indisunique and idx.indpred is null and idx.indexprs is null
                    and idx.indnkeyatts=2 and idx.indnatts=2
                    and idx.indkey[0]=views.attnum and idx.indkey[1]=article.attnum
                    and idx.indoption[0]=3 and idx.indoption[1]=3
                    and idx.indclass[0]=operators.oid and idx.indclass[1]=operators.oid then 1
                else 2
            end
            from (select pg_catalog.to_regclass('public.article_read_total') table_oid,
                         pg_catalog.to_regclass('public.article_read_total_rank') index_oid) names
            left join pg_catalog.pg_class total on total.oid=names.table_oid
            left join pg_catalog.pg_index idx on idx.indexrelid=names.index_oid
            left join pg_catalog.pg_class ranked on ranked.oid=idx.indexrelid
            left join pg_catalog.pg_am tree on tree.oid=ranked.relam
            left join pg_catalog.pg_attribute views on views.attrelid=total.oid and views.attname='views' and not views.attisdropped
            left join pg_catalog.pg_attribute article on article.attrelid=total.oid and article.attname='article_id' and not article.attisdropped
            left join pg_catalog.pg_opclass operators on operators.opcmethod=tree.oid
                and operators.opcnamespace='pg_catalog'::regnamespace and operators.opcname='int4_ops'
            """, db, tx);
        return Complete(await query.ExecuteScalarAsync(ct), 1,
            "Article read totals or their descending btree index do not match the current schema.");
    }

    private static readonly CatalogInvariant ArticleReadEpoch = new(
        """
            select last_epoch is not null or (
                not exists (select from public.article_read_hour)
                and not exists (select from public.article_read_dwell))
            from public.article_read_epoch where singleton
            """,
        "The article read epoch watermark is missing or inconsistent with the aggregate storage.");
}
