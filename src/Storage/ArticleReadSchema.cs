using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] ArticleReadColumns =
    [
        "article_read_hour article_id:int4 hour_utc:timestamptz count:int8",
        "article_read_dwell article_id:int4 day_utc:date bucket:int4 count:int8",
        "article_read_epoch singleton:bool last_epoch:int8?"
    ];

    private static readonly string[] ArticleReadConstraints =
    [
        "article_read_hour p article_id,hour_utc",
        "article_read_hour f article_id public.article:id",
        "article_read_hour c article_id article_id>0",
        "article_read_hour c hour_utc isfinite(hour_utc)",
        "article_read_hour c hour_utc hour_utc=date_trunc('hour'::text,hour_utc,'UTC'::text)",
        "article_read_hour c count count>0",
        "article_read_dwell p article_id,day_utc,bucket",
        "article_read_dwell f article_id public.article:id",
        "article_read_dwell c article_id article_id>0",
        "article_read_dwell c day_utc isfinite(day_utc)",
        "article_read_dwell c bucket bucket>=0ANDbucket<=3",
        "article_read_dwell c count count>0",
        "article_read_epoch p singleton",
        "article_read_epoch c singleton singleton",
        "article_read_epoch c last_epoch last_epoch>=0"
    ];

    private static readonly string[] ArticleReadTotalColumns = ["article_read_total article_id:int4 views:int4"];

    private static readonly string[] ArticleReadTotalConstraints =
    [
        "article_read_total p article_id",
        "article_read_total f article_id public.article:id",
        "article_read_total c article_id article_id>0",
        "article_read_total c views views>0"
    ];

    internal static Task<bool> HasArticleReadSchemaAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct) =>
        HasCompleteRelationsAsync(db, tx, ct, "Article read aggregate storage is incomplete.",
            "public.article_read_hour", "public.article_read_dwell", "public.article_read_epoch");

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
        return await query.ExecuteScalarAsync(ct) switch
        {
            0 => false,
            1 => true,
            _ => throw new InvalidOperationException("Article read totals or their descending btree index do not match the current schema.")
        };
    }

    private static async Task VerifyArticleReadEpochAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select last_epoch is not null or (
                not exists (select from public.article_read_hour)
                and not exists (select from public.article_read_dwell))
            from public.article_read_epoch where singleton
            """, db, tx);
        if (await query.ExecuteScalarAsync(ct) is not true)
            throw new InvalidOperationException("The article read epoch watermark is missing or inconsistent with the aggregate storage.");
    }
}
