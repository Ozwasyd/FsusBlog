namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string AdminInboxStatusRelation = "public.inbox_admin_status";
    private static readonly string[] AdminInboxStatusColumns =
    [
        "inbox_admin_status id:int8:d conversation_id:int8 principal_id:uuid session_reference:bytea previous_status:int2 current_status:int2 reason:text happened_at:timestamptz"
    ];
    private static readonly string[] AdminInboxStatusConstraints =
    [
        "inbox_admin_status p id",
        "inbox_admin_status f conversation_id public.inbox_conversation:id",
        "inbox_admin_status f principal_id public.admin_principal:id",
        "inbox_admin_status c session_reference octet_length(session_reference)=32",
        "inbox_admin_status c previous_status previous_status>=0ANDprevious_status<=2",
        "inbox_admin_status c current_status current_status>=0ANDcurrent_status<=2",
        "inbox_admin_status c reason octet_length(reason)>=1ANDoctet_length(reason)<=1024",
        "inbox_admin_status c current_status,previous_status current_status<>previous_status"
    ];
}
