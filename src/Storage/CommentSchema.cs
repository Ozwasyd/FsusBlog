namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] CommentColumns =
    [
        "comment article_id:int4 id:int8:d parent_id:int8? root_id:int8 parent_depth:int4? reply_to_id:int8? depth:int4 moderation_status:int2 deleted:bool body:text author_mode:int2 display_name:text display_language:text scope_label:text? created_at:timestamptz edited_at:timestamptz?",
        "comment_blocked_region article_id:int4 comment_id:int8 region_code:text",
        "comment_public_handle user_id:uuid display_name:text",
        "comment_public_write article_id:int4",
        "comment_submit_command user_id:uuid command_id:uuid fingerprint:bytea article_id:int4 comment_id:int8",
        "comment_moderation_log id:int8:a article_id:int4 comment_id:int8 previous_status:int2 next_status:int2 moderator_db_role:text reason:text occurred_at:timestamptz=now",
        "scoped_pow_consumed digest:bytea expires_at:timestamptz"
    ];

    private static readonly string[] CommentConstraints =
    [
        "comment f article_id public.article:id",
        "comment f article_id,root_id,parent_id,parent_depth public.comment:article_id,root_id,id,depth",
        "comment f article_id,root_id,reply_to_id public.comment:article_id,root_id,id",
        "comment p article_id,id",
        "comment u article_id,root_id,id",
        "comment u article_id,root_id,id,depth",
        "comment c moderation_status moderation_status>=0ANDmoderation_status<=3",
        "comment c body octet_length(body)<=12288",
        "comment c author_mode author_mode=ANY(ARRAY[1,3,4])",
        "comment c display_name octet_length(display_name)>=1ANDoctet_length(display_name)<=384",
        "comment c display_language display_language=ANY(ARRAY['zh-CN'::text,'en'::text])",
        "comment c scope_label,author_mode scope_labelISNULLORauthor_mode<>3ANDoctet_length(scope_label)<=512",
        "comment c id id>0",
        "comment c depth depth>=0ANDdepth<=256",
        "comment c parent_id,parent_depth,depth,root_id,id,reply_to_id parent_idISNULLANDparent_depthISNULLANDdepth=0ANDroot_id=idANDreply_to_idISNULLORparent_idISNOTNULLANDparent_depthISNOTNULLANDparent_id<idANDparent_depth=(depth-1)ANDdepth>0",
        "comment c reply_to_id,id reply_to_idISNULLORreply_to_id<id",
        "comment_blocked_region c region_code octet_length(region_code)>=1ANDoctet_length(region_code)<=16",
        "comment_blocked_region p article_id,comment_id,region_code",
        "comment_blocked_region f article_id,comment_id public.comment:article_id,id",
        "comment_public_handle p user_id",
        "comment_public_handle f user_id public.blog_user:id",
        "comment_public_handle c display_name octet_length(display_name)>=1ANDoctet_length(display_name)<=384",
        "comment_public_write p article_id",
        "comment_public_write f article_id public.article:id",
        "comment_submit_command p user_id,command_id",
        "comment_submit_command f user_id public.blog_user:id",
        "comment_submit_command f article_id,comment_id public.comment:article_id,id",
        "comment_submit_command u article_id,comment_id",
        "comment_submit_command c fingerprint octet_length(fingerprint)=32",
        "comment_moderation_log p id",
        "comment_moderation_log f article_id,comment_id public.comment:article_id,id",
        "comment_moderation_log c previous_status previous_status>=0ANDprevious_status<=3",
        "comment_moderation_log c next_status next_status>=1ANDnext_status<=3",
        "comment_moderation_log c reason octet_length(reason)>=1ANDoctet_length(reason)<=1024",
        "scoped_pow_consumed p digest",
        "scoped_pow_consumed c digest octet_length(digest)=32"
    ];
}
