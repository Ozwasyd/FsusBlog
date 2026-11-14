namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] CommunicationColumns =
    [
        "inbox_conversation id:int8:d account_id:uuid subject:text status:int2 is_system:bool read_through:int8? last_message_id:int8? last_message_at:timestamptz",
        "inbox_message conversation_id:int8 id:int8:d sender:int2 is_internal:bool body:text sent_at:timestamptz",
        "inbox_command account_id:uuid is_service:bool command_id:text fingerprint:bytea conversation_id:int8 message_id:int8",
        "inbox_delivery account_id:uuid last_sequence:int8",
        "inbox_event account_id:uuid sequence:int8 kind:int2 conversation_id:int8 message_id:int8 occurred_at:timestamptz"
    ];

    private static readonly string[] CommunicationConstraints =
    [
        "inbox_conversation p id",
        "inbox_conversation u account_id,id",
        "inbox_conversation f account_id public.blog_user:id",
        "inbox_conversation f id,read_through public.inbox_message:conversation_id,id",
        "inbox_conversation f id,last_message_id public.inbox_message:conversation_id,id",
        "inbox_conversation c subject octet_lengthsubject>=1ANDoctet_lengthsubject<=640",
        "inbox_conversation c status status>=0ANDstatus<=2",
        "inbox_message p conversation_id,id",
        "inbox_message u id",
        "inbox_message f conversation_id public.inbox_conversation:id",
        "inbox_message c sender sender>=0ANDsender<=2",
        "inbox_message c body octet_lengthbody>=1ANDoctet_lengthbody<=16000",
        "inbox_command p account_id,is_service,command_id",
        "inbox_command f account_id,conversation_id public.inbox_conversation:account_id,id",
        "inbox_command f conversation_id,message_id public.inbox_message:conversation_id,id",
        "inbox_command c command_id octet_lengthcommand_id>=1ANDoctet_lengthcommand_id<=64",
        "inbox_command c fingerprint octet_lengthfingerprint=32",
        "inbox_delivery p account_id",
        "inbox_delivery f account_id public.blog_user:id",
        "inbox_delivery c last_sequence last_sequence>=0",
        "inbox_event p account_id,sequence",
        "inbox_event f account_id public.inbox_delivery:account_id",
        "inbox_event f account_id,conversation_id public.inbox_conversation:account_id,id",
        "inbox_event f conversation_id,message_id public.inbox_message:conversation_id,id",
        "inbox_event c sequence sequence>0",
        "inbox_event c kind kind>=12ANDkind<=14"
    ];
}
