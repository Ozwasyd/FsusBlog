namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string ArticleScheduleRelation = "public.article_schedule";

    private static readonly SchemaFacts ArticleScheduleShape = new(
        Columns: [
            "article_schedule_receipt actor_id:uuid command_id:uuid due_at:timestamptz? published_revision:int8",
            "article_schedule article_id:int4 revision:int8 actor_id:uuid generation:int8 command_id:uuid due_at:timestamptz"
        ],
        Constraints: [
            "article_schedule_receipt p actor_id,command_id",
            "article_schedule_receipt f actor_id,command_id public.article_command:actor_id,command_id",
            "article_schedule_receipt c published_revision published_revision>=0",
            "article_schedule p article_id",
            "article_schedule f article_id,revision public.article_revision:article_id,revision",
            "article_schedule f actor_id,command_id public.article_schedule_receipt:actor_id,command_id",
            "article_schedule c generation generation>0"
        ]);


}
