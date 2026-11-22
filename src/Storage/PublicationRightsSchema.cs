namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string PublicationRightsRelation = "public.article_publication_rights";

    private static readonly SchemaFacts PublicationRightsShape = Tables(
        Table("article_revision_rights article_id:int4 revision:int8 enabled:bool license_type:text copyright_holder:text copyright_year:int4 rights_statement:text attribution_template:text copy_policy:text max_excerpt_chars:int4 allow_code_copy:bool show_public_badge:bool proof_binding_enabled:bool",
            "p article_id,revision",
            "f article_id,revision public.article_revision:article_id,revision",
            "c max_excerpt_chars max_excerpt_chars>=0ANDmax_excerpt_chars<=10000"),
        Table("article_publication_rights id:int8:a article_id:int4 publication_id:int8 revision:int8",
            "p id",
            "u publication_id",
            "c publication_id publication_id>0",
            "f article_id,revision public.article_revision_rights:article_id,revision"));


}
