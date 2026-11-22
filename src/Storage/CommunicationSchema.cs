namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts CommunicationShape = Tables(
        Table("inbox_conversation id:int8:d account_id:uuid subject:text status:int2 is_system:bool read_through:int8? last_message_id:int8? last_message_at:timestamptz",
            "p id",
            "u account_id,id",
            "f account_id public.blog_user:id",
            "f id,read_through public.inbox_message:conversation_id,id",
            "f id,last_message_id public.inbox_message:conversation_id,id",
            "c subject octet_length(subject)>=1ANDoctet_length(subject)<=640",
            "c status status>=0ANDstatus<=2"),
        Table("inbox_message conversation_id:int8 id:int8:d sender:int2 is_internal:bool body:text sent_at:timestamptz",
            "p conversation_id,id",
            "u id",
            "f conversation_id public.inbox_conversation:id",
            "c sender sender>=0ANDsender<=2",
            "c body octet_length(body)>=1ANDoctet_length(body)<=16000"),
        Table("inbox_command account_id:uuid is_service:bool command_id:text fingerprint:bytea conversation_id:int8 message_id:int8",
            "p account_id,is_service,command_id",
            "f account_id,conversation_id public.inbox_conversation:account_id,id",
            "f conversation_id,message_id public.inbox_message:conversation_id,id",
            "c command_id octet_length(command_id)>=1ANDoctet_length(command_id)<=64",
            "c fingerprint octet_length(fingerprint)=32"),
        Table("inbox_delivery account_id:uuid last_sequence:int8",
            "p account_id",
            "f account_id public.blog_user:id",
            "c last_sequence last_sequence>=0"),
        Table("inbox_event account_id:uuid sequence:int8 kind:int2 conversation_id:int8 message_id:int8 occurred_at:timestamptz",
            "p account_id,sequence",
            "f account_id public.inbox_delivery:account_id",
            "f account_id,conversation_id public.inbox_conversation:account_id,id",
            "f conversation_id,message_id public.inbox_message:conversation_id,id",
            "c sequence sequence>0",
            "c kind kind>=12ANDkind<=14"));


}
