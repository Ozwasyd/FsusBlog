namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts RevisionHistoryShape = Table(
        "article_rollback article_id:int4 revision:int8 previous_revision:int8 source_revision:int8 actor_id:uuid command_id:uuid reason:text",
        "p article_id,revision",
        "f article_id,revision public.article_revision:article_id,revision",
        "f article_id,previous_revision public.article_revision:article_id,revision",
        "f article_id,source_revision public.article_revision:article_id,revision",
        "f actor_id,command_id public.article_command:actor_id,command_id",
        "c previous_revision,revision,source_revision previous_revision=(revision-1)ANDsource_revision<previous_revision",
        "c reason char_length(reason)>=8ANDchar_length(reason)<=500");


}
