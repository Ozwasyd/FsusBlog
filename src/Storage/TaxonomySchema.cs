namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] TaxonomyColumns =
    [
        "category id:int4:d name:text description:text?",
        "tag id:int4:d name:text description:text?",
        "tag_url_name name_key:text tag_id:int4",
        "article_revision_category article_id:int4 revision:int8 category_id:int4",
        "article_revision_tag article_id:int4 revision:int8 tag_id:int4"
    ];

    private static readonly string[] TaxonomyConstraints =
    [
        "category p id",
        "category u name",
        "category c name char_length(name)>=1ANDchar_length(name)<=128",
        "category c description char_length(description)>=1ANDchar_length(description)<=500",
        "tag p id",
        "tag u name",
        "tag c name char_length(name)>=1ANDchar_length(name)<=128",
        "tag c description char_length(description)>=1ANDchar_length(description)<=500",
        "tag_url_name p name_key",
        "tag_url_name c name_key char_length(name_key)>=1ANDchar_length(name_key)<=256",
        "tag_url_name f tag_id public.tag:id",
        "article_revision_category p article_id,revision",
        "article_revision_category f category_id public.category:id",
        "article_revision_category f article_id,revision public.article_revision:article_id,revision",
        "article_revision_tag p article_id,revision,tag_id",
        "article_revision_tag f tag_id public.tag:id",
        "article_revision_tag f article_id,revision public.article_revision:article_id,revision"
    ];
}
