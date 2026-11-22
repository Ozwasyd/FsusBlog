namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string AdminInboxStatusRelation = "public.inbox_admin_status";
    private static readonly SchemaFacts AdminInboxStatusShape = Table(
        "inbox_admin_status id:int8:d conversation_id:int8 principal_id:uuid session_reference:bytea previous_status:int2 current_status:int2 reason:text happened_at:timestamptz",
        "p id",
        "f conversation_id public.inbox_conversation:id",
        "f principal_id public.admin_principal:id",
        "c session_reference octet_length(session_reference)=32",
        "c previous_status previous_status>=0ANDprevious_status<=2",
        "c current_status current_status>=0ANDcurrent_status<=2",
        "c reason octet_length(reason)>=1ANDoctet_length(reason)<=1024",
        "c current_status,previous_status current_status<>previous_status");

}
