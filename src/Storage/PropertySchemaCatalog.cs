namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] PropertyColumns =
    [
        "property_schema owner_id:uuid revision:int8",
        "property_definition owner_id:uuid id:uuid machine_key:text revision:int8 shape:jsonb",
        "property_schema_command owner_id:uuid request_id:uuid receipt:jsonb",
        "property_article article_id:int4 owner_id:uuid revision:int8",
        "property_text_value article_id:int4 owner_id:uuid definition_id:uuid value:text",
        "property_value_command article_id:int4 request_id:uuid fingerprint:bytea definition_id:uuid revision:int8"
    ];

    private static readonly string[] PropertyConstraints =
    [
        "property_schema p owner_id",
        "property_schema f owner_id public.blog_user:id",
        "property_schema c revision revision>=0",
        "property_definition p owner_id,id",
        "property_definition u owner_id,machine_key",
        "property_definition f owner_id public.property_schema:owner_id",
        "property_definition c revision revision>0",
        "property_schema_command p owner_id,request_id",
        "property_schema_command f owner_id public.property_schema:owner_id",
        "property_article p article_id",
        "property_article u article_id,owner_id",
        "property_article f article_id public.article:id",
        "property_article f owner_id public.property_schema:owner_id",
        "property_article c revision revision>0",
        "property_text_value p article_id,definition_id",
        "property_text_value f article_id,owner_id public.property_article:article_id,owner_id",
        "property_text_value f owner_id,definition_id public.property_definition:owner_id,id",
        "property_text_value c value char_length(value)<=16384",
        "property_value_command p article_id,request_id",
        "property_value_command f article_id public.property_article:article_id",
        "property_value_command c fingerprint octet_length(fingerprint)=32",
        "property_value_command c revision revision>0"
    ];
}
