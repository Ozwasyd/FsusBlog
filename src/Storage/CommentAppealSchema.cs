using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts CommentAppealShape = new(
        Columns: [
            "comment_appeal_challenge digest:bytea article_id:int4 comment_id:int8 user_id:uuid session_digest:bytea generation:int8 adverse_id:int8 comment_version:int8 expires_at:timestamptz",
            "comment_appeal id:int8:a article_id:int4 comment_id:int8 user_id:uuid adverse_id:int8 comment_version:int8 reason:text submitted_at:timestamptz",
            "comment_appeal_decision appeal_id:int8 principal_id:uuid session_reference:bytea granted:bool reason:text decided_at:timestamptz",
            "comment_appeal_event appeal_id:int8 kind:int2 previous_status:int2 next_status:int2 occurred_at:timestamptz",
            StepUpColumns("comment_appeal_admin_step_up")
        ],
        Constraints: [
            "comment_appeal_challenge p digest",
            "comment_appeal_challenge c digest octet_length(digest)=32",
            "comment_appeal_challenge c session_digest octet_length(session_digest)=32",
            "comment_appeal_challenge c generation generation>0",
            "comment_appeal_challenge c comment_version comment_version>0",
            "comment_appeal_challenge u article_id,comment_id,session_digest",
            "comment_appeal_challenge f adverse_id public.admin_comment_moderation:id",
            "comment_appeal_challenge f article_id,comment_id,user_id public.comment_account_owner:article_id,comment_id,user_id",
            "comment_appeal p id",
            "comment_appeal u adverse_id",
            "comment_appeal c comment_version comment_version>1",
            "comment_appeal c reason octet_length(reason)>=10ANDoctet_length(reason)<=4000",
            "comment_appeal f adverse_id public.admin_comment_moderation:id",
            "comment_appeal f article_id,comment_id,user_id public.comment_account_owner:article_id,comment_id,user_id",
            "comment_appeal_decision p appeal_id",
            "comment_appeal_decision f appeal_id public.comment_appeal:id",
            "comment_appeal_decision f principal_id public.admin_principal:id",
            "comment_appeal_decision c session_reference octet_length(session_reference)=32",
            "comment_appeal_decision c reason octet_length(reason)>=10ANDoctet_length(reason)<=4000",
            "comment_appeal_event p appeal_id,kind",
            "comment_appeal_event f appeal_id public.comment_appeal:id",
            "comment_appeal_event c kind kind>=1ANDkind<=2",
            "comment_appeal_event c previous_status previous_status=2",
            "comment_appeal_event c next_status next_status>=1ANDnext_status<=2",
            ..StepUpConstraints("comment_appeal_admin_step_up", "action=5")
        ]);

    private static readonly RelationGroup CommentAppealRelations = new(
        "Comment appeal storage is incomplete.",
        "public.comment_appeal_challenge", "public.comment_appeal", "public.comment_appeal_decision", "public.comment_appeal_event", "public.comment_appeal_admin_step_up");

    internal static Task<bool> HasCommentAppealSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        CommentAppealRelations.IsPresentAsync(db, tx, ct);
}
