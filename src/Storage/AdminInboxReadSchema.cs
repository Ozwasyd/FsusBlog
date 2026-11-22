namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string AdminInboxReadRelation = "public.inbox_admin_read";
    private static readonly SchemaFacts AdminInboxReadShape = new(
        Columns: [
            "inbox_admin_read conversation_id:int8 read_through:int8 read_at:timestamptz principal_id:uuid session_reference:bytea"
        ],
        Constraints: [
            "inbox_admin_read p conversation_id",
            "inbox_admin_read f conversation_id,read_through public.inbox_message:conversation_id,id",
            "inbox_admin_read f principal_id public.admin_principal:id",
            "inbox_admin_read c session_reference octet_length(session_reference)=32"
        ]);

}
