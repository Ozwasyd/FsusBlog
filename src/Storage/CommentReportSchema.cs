using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private const string CommentReportColumns =
        "comment_report id:int8 article_id:int4 comment_id:int8 reporter_id:uuid publication_id:int8 reason_code:text detail:text? created_at:timestamptz";

    private static readonly string[] CommentReportConstraints =
    [
        "comment_report p id",
        "comment_report c id id>0",
        "comment_report c publication_id publication_id>0",
        "comment_report c reason_code reason_code=ANY(ARRAY['spam'::text,'harassment'::text,'hate'::text,'privacy'::text,'illegal'::text,'misinformation'::text,'other'::text])",
        "comment_report c detail octet_length(detail)<=3000",
        "comment_report u article_id,comment_id,reporter_id",
        "comment_report f article_id,comment_id public.comment:article_id,id",
        "comment_report f reporter_id public.blog_user:id"
    ];

    private const string CommentReportRelation = "public.comment_report";

    internal static Task<bool> HasCommentReportSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, CommentReportRelation, ct);
}
