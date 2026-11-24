namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static SchemaFacts CommentActionChallenge(string table, string extraCols, params ConstraintRule[] extraConstraints) => Table(
        $"{table} digest:bytea article_id:int4 comment_id:int8 user_id:uuid session_digest:bytea generation:int8{extraCols} expires_at:timestamptz",
        "p digest", Bytes32("digest", "session_digest"), Pos("generation", "comment_version"),
        "u article_id,comment_id,session_digest",
        "f article_id,comment_id,user_id public.comment_account_owner:article_id,comment_id,user_id",
        extraConstraints);

    private static readonly SchemaFacts CommentAppealShape = Tables(
        CommentActionChallenge("comment_appeal_challenge", " adverse_id:int8 comment_version:int8",
            "f adverse_id public.admin_comment_moderation:id"),
        Table("comment_appeal id:int8:a article_id:int4 comment_id:int8 user_id:uuid adverse_id:int8 comment_version:int8 reason:text submitted_at:timestamptz",
            "p id", "u adverse_id", "c comment_version comment_version>1",
            "c reason octet_length(reason)>=10ANDoctet_length(reason)<=4000",
            "f adverse_id public.admin_comment_moderation:id",
            "f article_id,comment_id,user_id public.comment_account_owner:article_id,comment_id,user_id"),
        Table("comment_appeal_decision appeal_id:int8 principal_id:uuid session_reference:bytea granted:bool reason:text decided_at:timestamptz",
            "p appeal_id", "f appeal_id public.comment_appeal:id", "f principal_id public.admin_principal:id",
            Bytes32("session_reference"), "c reason octet_length(reason)>=10ANDoctet_length(reason)<=4000"),
        Table("comment_appeal_event appeal_id:int8 kind:int2 previous_status:int2 next_status:int2 occurred_at:timestamptz",
            "p appeal_id,kind", "f appeal_id public.comment_appeal:id",
            "c kind kind>=1ANDkind<=2", "c previous_status previous_status=2", "c next_status next_status>=1ANDnext_status<=2"),
        StepUpShape("comment_appeal_admin_step_up", "action=5"));

    private static readonly RelationGroup CommentAppealRelations = Relations(CommentAppealShape, "Comment appeal storage is incomplete.");

    internal static Task<bool> HasCommentAppealSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        CommentAppealRelations.IsPresentAsync(db, tx, ct);

    private static readonly SchemaFacts CommentAuthorDeleteShape = Tables(
        Table("comment_account_owner article_id:int4 comment_id:int8 user_id:uuid",
            "p article_id,comment_id", "u comment_id", "u article_id,comment_id,user_id",
            "f user_id public.blog_user:id", "f article_id,comment_id public.comment:article_id,id"),
        CommentActionChallenge("comment_author_delete_challenge", " comment_version:int8"),
        Table("comment_author_deleted article_id:int4 comment_id:int8 user_id:uuid comment_version:int8 moderation_status:int2 body_digest:bytea happened_at:timestamptz",
            "p article_id,comment_id", "c comment_version comment_version>1",
            "c moderation_status moderation_status>=0ANDmoderation_status<=3", Bytes32("body_digest"),
            "f article_id,comment_id,user_id public.comment_account_owner:article_id,comment_id,user_id"),
        Table("comment_author_delete_outbox article_id:int4 comment_id:int8 event_type:text",
            "p article_id,comment_id", "c event_type event_type='CommentDeleted'::text",
            "f article_id,comment_id public.comment_author_deleted:article_id,comment_id"));

    private static readonly RelationGroup CommentAuthorDeleteRelations = Relations(CommentAuthorDeleteShape, "Comment author deletion storage is incomplete.");

    internal static Task<bool> HasCommentAuthorDeleteSchemaAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct) =>
        CommentAuthorDeleteRelations.IsPresentAsync(connection, transaction, ct);

    private const string LegacyCommentAuthorEditStatus = "previous_status=1";
    private const string PendingCommentAuthorEditStatus = "previous_status>=0ANDprevious_status<=1";

    private static readonly SchemaFacts CommentAuthorEditBaseShape = Tables(
        CommentActionChallenge("comment_author_edit_challenge", " comment_version:int8 publication_id:int8", Pos("publication_id")),
        Table("comment_author_edited article_id:int4 comment_id:int8 user_id:uuid comment_version:int8 previous_version:int8 previous_status:int2 moderation_status:int2 previous_body:text body:text previous_body_digest:bytea body_digest:bytea happened_at:timestamptz",
            "p article_id,comment_id,comment_version",
            "f article_id,comment_id,user_id public.comment_account_owner:article_id,comment_id,user_id",
            Pos("previous_version"), "c moderation_status moderation_status=0",
            "c previous_body octet_length(previous_body)<=12288",
            "c body octet_length(body)>=1ANDoctet_length(body)<=4096",
            Bytes32("previous_body_digest", "body_digest"),
            "c comment_version,previous_version comment_version=(previous_version+1)"),
        Table("comment_author_edit_outbox article_id:int4 comment_id:int8 comment_version:int8 event_type:text",
            "p article_id,comment_id,comment_version", "c event_type event_type='CommentEdited'::text",
            "f article_id,comment_id,comment_version public.comment_author_edited:article_id,comment_id,comment_version"));

    private const string CommentAuthorEditedRelation = "public.comment_author_edited";
    private static readonly RelationGroup CommentAuthorEditRelations = Relations(CommentAuthorEditBaseShape, "Comment author edit storage is incomplete.");

    internal static Task<bool> HasCommentAuthorEditSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        CommentAuthorEditRelations.IsPresentAsync(db, tx, ct);

    internal static Task<bool> SupportsPendingCommentAuthorEditAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        ProbeAsync(db, tx, ct, [], [], [CommentAuthorEditedRelation],
            c => c.FindStrictLocalCheckExpression(CommentAuthorEditedRelation, "comment_author_edited_previous_status_check") == PendingCommentAuthorEditStatus);

    private static SchemaFacts ReadCommentAuthorEditShape(CatalogPresenceSnapshot catalog)
    {
        var status = catalog.FindStrictLocalCheckExpression(CommentAuthorEditedRelation, "comment_author_edited_previous_status_check");
        if (status is not (LegacyCommentAuthorEditStatus or PendingCommentAuthorEditStatus))
            throw new InvalidOperationException("FsusBlog V2 constraint shape mismatch. Comment author edit previous status is invalid.");
        return new(CommentAuthorEditBaseShape.Columns, [.. CommentAuthorEditBaseShape.Constraints, "comment_author_edited c previous_status " + status]);
    }

    private static readonly SchemaFacts CommentReplyShape = Table(
        "comment_reply_notice article_id:int4 reply_id:int8 recipient_id:uuid conversation_id:int8 message_id:int8 moderation_version:int8 delivered_at:timestamptz",
        "p article_id,reply_id", "u conversation_id", "c moderation_version moderation_version>1",
        "f article_id,reply_id public.comment_account_owner:article_id,comment_id",
        "f recipient_id,conversation_id public.inbox_conversation:account_id,id",
        "f conversation_id,message_id public.inbox_message:conversation_id,id");

    private const string CommentReplyRelation = "public.comment_reply_notice";
    internal static Task<bool> HasCommentReplySchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, CommentReplyRelation, ct);

    private static readonly SchemaFacts CommentReportShape = Table(
        "comment_report id:int8 article_id:int4 comment_id:int8 reporter_id:uuid publication_id:int8 reason_code:text detail:text? created_at:timestamptz",
        "p id", Pos("id", "publication_id"),
        "c reason_code reason_code=ANY(ARRAY['spam'::text,'harassment'::text,'hate'::text,'privacy'::text,'illegal'::text,'misinformation'::text,'other'::text])",
        "c detail octet_length(detail)<=3000",
        "u article_id,comment_id,reporter_id",
        "f article_id,comment_id public.comment:article_id,id", "f reporter_id public.blog_user:id");

    private const string CommentReportRelation = "public.comment_report";
    internal static Task<bool> HasCommentReportSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, CommentReportRelation, ct);

    private static SchemaFacts GetCommentShape(bool requireModerationVersion) => Tables(
        Table("comment article_id:int4 id:int8:d parent_id:int8? root_id:int8 parent_depth:int4? reply_to_id:int8? depth:int4 moderation_status:int2 deleted:bool body:text author_mode:int2 display_name:text display_language:text scope_label:text? created_at:timestamptz edited_at:timestamptz?" +
                (requireModerationVersion ? " moderation_version:int8=1" : ""),
            "f article_id public.article:id",
            "f article_id,root_id,parent_id,parent_depth public.comment:article_id,root_id,id,depth",
            "f article_id,root_id,reply_to_id public.comment:article_id,root_id,id",
            "p article_id,id", "u article_id,root_id,id", "u article_id,root_id,id,depth",
            "c moderation_status moderation_status>=0ANDmoderation_status<=3",
            "c body octet_length(body)<=12288", "c author_mode author_mode=ANY(ARRAY[1,3,4])",
            "c display_name octet_length(display_name)>=1ANDoctet_length(display_name)<=384",
            "c display_language display_language=ANY(ARRAY['zh-CN'::text,'en'::text])",
            "c scope_label,author_mode scope_labelISNULLORauthor_mode<>3ANDoctet_length(scope_label)<=512",
            Pos("id"), "c depth depth>=0ANDdepth<=256",
            "c parent_id,parent_depth,depth,root_id,id,reply_to_id parent_idISNULLANDparent_depthISNULLANDdepth=0ANDroot_id=idANDreply_to_idISNULLORparent_idISNOTNULLANDparent_depthISNOTNULLANDparent_id<idANDparent_depth=(depth-1)ANDdepth>0",
            "c reply_to_id,id reply_to_idISNULLORreply_to_id<id",
            requireModerationVersion ? Pos("moderation_version") : Array.Empty<string>()),
        Table("comment_blocked_region article_id:int4 comment_id:int8 region_code:text",
            "p article_id,comment_id,region_code", "f article_id,comment_id public.comment:article_id,id",
            "c region_code octet_length(region_code)>=1ANDoctet_length(region_code)<=16"),
        Table("comment_public_handle user_id:uuid display_name:text",
            "p user_id", "f user_id public.blog_user:id",
            "c display_name octet_length(display_name)>=1ANDoctet_length(display_name)<=384"),
        Table("comment_public_write article_id:int4", "p article_id", "f article_id public.article:id"),
        Table("comment_submit_command user_id:uuid command_id:uuid fingerprint:bytea article_id:int4 comment_id:int8",
            "p user_id,command_id", "u article_id,comment_id", Bytes32("fingerprint"),
            "f user_id public.blog_user:id", "f article_id,comment_id public.comment:article_id,id"),
        Table("comment_moderation_log id:int8:a article_id:int4 comment_id:int8 previous_status:int2 next_status:int2 moderator_db_role:text reason:text occurred_at:timestamptz=now",
            "p id", "f article_id,comment_id public.comment:article_id,id",
            "c previous_status previous_status>=0ANDprevious_status<=3",
            "c next_status next_status>=1ANDnext_status<=3",
            "c reason octet_length(reason)>=1ANDoctet_length(reason)<=1024"),
        Table("scoped_pow_consumed digest:bytea expires_at:timestamptz", "p digest", Bytes32("digest")));

    private static readonly SchemaFacts CommunicationShape = Tables(
        Table("inbox_conversation id:int8:d account_id:uuid subject:text status:int2 is_system:bool read_through:int8? last_message_id:int8? last_message_at:timestamptz",
            "p id", "u account_id,id", "f account_id public.blog_user:id",
            "f id,read_through public.inbox_message:conversation_id,id",
            "f id,last_message_id public.inbox_message:conversation_id,id",
            "c subject octet_length(subject)>=1ANDoctet_length(subject)<=640", "c status status>=0ANDstatus<=2"),
        Table("inbox_message conversation_id:int8 id:int8:d sender:int2 is_internal:bool body:text sent_at:timestamptz",
            "p conversation_id,id", "u id", "f conversation_id public.inbox_conversation:id",
            "c sender sender>=0ANDsender<=2", "c body octet_length(body)>=1ANDoctet_length(body)<=16000"),
        Table("inbox_command account_id:uuid is_service:bool command_id:text fingerprint:bytea conversation_id:int8 message_id:int8",
            "p account_id,is_service,command_id",
            "f account_id,conversation_id public.inbox_conversation:account_id,id",
            "f conversation_id,message_id public.inbox_message:conversation_id,id",
            "c command_id octet_length(command_id)>=1ANDoctet_length(command_id)<=64", Bytes32("fingerprint")),
        Table("inbox_delivery account_id:uuid last_sequence:int8",
            "p account_id", "f account_id public.blog_user:id", NonNeg("last_sequence")),
        Table("inbox_event account_id:uuid sequence:int8 kind:int2 conversation_id:int8 message_id:int8 occurred_at:timestamptz",
            "p account_id,sequence", "f account_id public.inbox_delivery:account_id",
            "f account_id,conversation_id public.inbox_conversation:account_id,id",
            "f conversation_id,message_id public.inbox_message:conversation_id,id",
            Pos("sequence"), "c kind kind>=12ANDkind<=14"));
}
