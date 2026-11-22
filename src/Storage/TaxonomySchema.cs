namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts TaxonomyShape = Tables(
        Table("category id:int4:d name:text description:text?",
            "p id",
            "u name",
            "c name char_length(name)>=1ANDchar_length(name)<=128",
            "c description char_length(description)>=1ANDchar_length(description)<=500"),
        Table("tag id:int4:d name:text description:text?",
            "p id",
            "u name",
            "c name char_length(name)>=1ANDchar_length(name)<=128",
            "c description char_length(description)>=1ANDchar_length(description)<=500"),
        Table("tag_url_name name_key:text tag_id:int4",
            "p name_key",
            "c name_key char_length(name_key)>=1ANDchar_length(name_key)<=256",
            "f tag_id public.tag:id"),
        Table("article_revision_category article_id:int4 revision:int8 category_id:int4",
            "p article_id,revision",
            "f category_id public.category:id",
            "f article_id,revision public.article_revision:article_id,revision"),
        Table("article_revision_tag article_id:int4 revision:int8 tag_id:int4",
            "p article_id,revision,tag_id",
            "f tag_id public.tag:id",
            "f article_id,revision public.article_revision:article_id,revision"));


}
