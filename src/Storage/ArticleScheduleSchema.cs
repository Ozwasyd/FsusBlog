namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string ArticleScheduleRelation = "public.article_schedule";

    private static readonly SchemaFacts ArticleScheduleShape = Tables(
        Table("article_schedule_receipt actor_id:uuid command_id:uuid due_at:timestamptz? published_revision:int8",
            "p actor_id,command_id",
            "f actor_id,command_id public.article_command:actor_id,command_id",
            "c published_revision published_revision>=0"),
        Table("article_schedule article_id:int4 revision:int8 actor_id:uuid generation:int8 command_id:uuid due_at:timestamptz",
            "p article_id",
            "f article_id,revision public.article_revision:article_id,revision",
            "f actor_id,command_id public.article_schedule_receipt:actor_id,command_id",
            "c generation generation>0"));


}
