namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string AdminInboxReplyRelation = "public.inbox_admin_reply";
    private static readonly SchemaFacts AdminInboxReplyShape = Table(
        "inbox_admin_reply principal_id:uuid command_id:text fingerprint:bytea session_reference:bytea conversation_id:int8 message_id:int8",
        "p principal_id,command_id",
        "u message_id",
        "f principal_id public.admin_principal:id",
        "f conversation_id,message_id public.inbox_message:conversation_id,id",
        "c command_id octet_length(command_id)>=1ANDoctet_length(command_id)<=64",
        "c fingerprint octet_length(fingerprint)=32",
        "c session_reference octet_length(session_reference)=32");

}
