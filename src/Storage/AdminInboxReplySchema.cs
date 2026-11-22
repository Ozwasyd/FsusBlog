namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string AdminInboxReplyRelation = "public.inbox_admin_reply";
    private static readonly SchemaFacts AdminInboxReplyShape = new(
        Columns: [
            "inbox_admin_reply principal_id:uuid command_id:text fingerprint:bytea session_reference:bytea conversation_id:int8 message_id:int8"
        ],
        Constraints: [
            "inbox_admin_reply p principal_id,command_id",
            "inbox_admin_reply u message_id",
            "inbox_admin_reply f principal_id public.admin_principal:id",
            "inbox_admin_reply f conversation_id,message_id public.inbox_message:conversation_id,id",
            "inbox_admin_reply c command_id octet_length(command_id)>=1ANDoctet_length(command_id)<=64",
            "inbox_admin_reply c fingerprint octet_length(fingerprint)=32",
            "inbox_admin_reply c session_reference octet_length(session_reference)=32"
        ]);

}
