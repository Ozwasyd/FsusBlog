namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string PublicationHistoryRelation = "public.article_publication_history";

    private static readonly string[] PublicationHistoryColumns =
    [
        "article_publication_history article_id:int4 event_no:int4 revision:int8 publication_no:int4 publication_id:int8? supersedes_id:int8? kind:text reason:text happened_at:timestamptz? recorded_at:timestamptz=clock_timestamp actor_id:uuid? command_id:uuid?"
    ];

    private static readonly string[] PublicationHistoryConstraints =
    [
        "article_publication_history p article_id,event_no",
        "article_publication_history u article_id,revision",
        "article_publication_history u article_id,publication_id",
        "article_publication_history u publication_id",
        "article_publication_history u actor_id,command_id",
        "article_publication_history f article_id,revision public.article_revision:article_id,revision",
        "article_publication_history f article_id,supersedes_id public.article_publication_history:article_id,publication_id",
        "article_publication_history f actor_id,command_id public.article_command:actor_id,command_id",
        "article_publication_history c event_no event_no>0",
        "article_publication_history c publication_no publication_no>=0",
        "article_publication_history c actor_id,command_id (actor_idISNULL)=(command_idISNULL)",
        "article_publication_history c publication_id publication_idISNULLORpublication_id>0",
        "article_publication_history c supersedes_id,publication_id supersedes_idISNULLORsupersedes_idISDISTINCTFROMpublication_id",
        "article_publication_history c kind kind=ANY(ARRAY['retained-active'::text,'retained-hidden'::text,'publish'::text,'replace'::text,'retract'::text,'delete'::text])"
    ];

    private static string[] PublicationHistoryColumnsForAdminRollback =>
        [PublicationHistoryColumns[0] + " admin_actor_id:uuid? admin_command_id:uuid?"];

    private static readonly string[] PublicationHistoryAdminRollbackConstraints =
    [
        "article_publication_history f admin_actor_id,admin_command_id public.admin_article_rollback:principal_id,command_id",
        "article_publication_history u admin_actor_id,admin_command_id",
        "article_publication_history c admin_actor_id,admin_command_id (admin_actor_idISNULL)=(admin_command_idISNULL)",
        "article_publication_history c actor_id,admin_actor_id actor_idISNULLORadmin_actor_idISNULL"
    ];
}
