namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string AdminInboxNoticeRelation = "public.inbox_admin_notice";
    private static readonly SchemaFacts AdminInboxNoticeShape = Table(
        "inbox_admin_notice source_event_id:int8 account_id:uuid conversation_id:int8 message_id:int8 principal_id:uuid session_reference:bytea fingerprint:bytea sent_at:timestamptz",
        "p source_event_id",
        "u conversation_id",
        "f account_id,conversation_id public.inbox_conversation:account_id,id",
        "f conversation_id,message_id public.inbox_message:conversation_id,id",
        "f principal_id public.admin_principal:id",
        "c source_event_id source_event_id>0",
        "c session_reference octet_length(session_reference)=32",
        "c fingerprint octet_length(fingerprint)=32");

}
