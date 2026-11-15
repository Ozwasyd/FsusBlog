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

    internal static async Task<bool> HasArticleReadSchemaAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select count(oid) from (values (pg_catalog.to_regclass('public.article_read_hour')),
                (pg_catalog.to_regclass('public.article_read_dwell')),
                (pg_catalog.to_regclass('public.article_read_epoch'))) expected(oid)
            """, db, tx);
        return await query.ExecuteScalarAsync(ct) switch
        {
            0L => false,
            3L => true,
            _ => throw new InvalidOperationException("Article read aggregate storage is incomplete.")
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
