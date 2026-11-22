namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts PropertyShape = Tables(
        Table("property_schema owner_id:uuid revision:int8",
            "p owner_id",
            "f owner_id public.admin_principal:id",
            "c revision revision>=0"),
        Table("property_definition owner_id:uuid id:uuid machine_key:text revision:int8 digest:text shape:jsonb",
            "p owner_id,id",
            "u owner_id,machine_key",
            "f owner_id public.property_schema:owner_id",
            "c revision revision>0",
            "c digest char_length(digest)=64"),
        Table("property_schema_command owner_id:uuid request_id:uuid receipt:jsonb",
            "p owner_id,request_id",
            "f owner_id public.property_schema:owner_id"),
        Table("property_article article_id:int4 owner_id:uuid revision:int8",
            "p article_id",
            "u article_id,owner_id",
            "f article_id public.article:id",
            "f owner_id public.property_schema:owner_id",
            "c revision revision>0"),
        Table("property_value article_id:int4 owner_id:uuid definition_id:uuid data:jsonb references_ids:_int4",
            "p article_id,definition_id",
            "f article_id,owner_id public.property_article:article_id,owner_id",
            "f owner_id,definition_id public.property_definition:owner_id,id",
            "c references_ids cardinality(references_ids)<=32"),
        Table("property_value_command article_id:int4 request_id:uuid fingerprint:bytea definition_id:uuid revision:int8",
            "p article_id,request_id",
            "f article_id public.property_article:article_id",
            "c fingerprint octet_length(fingerprint)=32",
            "c revision revision>0"));


}
