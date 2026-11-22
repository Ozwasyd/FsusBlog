namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts SiteRefreshShape = Tables(
        Table("site_session_refresh family_id:uuid access_digest:bytea refresh_digest:bytea previous_access_digest:bytea? generation:int8 idle_expires_at:timestamptz absolute_expires_at:timestamptz rotated_at:timestamptz",
            "p family_id",
            "u access_digest",
            "f access_digest public.user_session:digest delete-cascade update-cascade",
            "c access_digest octet_length(access_digest)=32",
            "u refresh_digest",
            "c refresh_digest octet_length(refresh_digest)=32",
            "c previous_access_digest octet_length(previous_access_digest)=32",
            "c generation generation>=0",
            "c idle_expires_at,absolute_expires_at idle_expires_at<=absolute_expires_at"),
        Table("site_session_refresh_tombstone refresh_digest:bytea family_id:uuid generation:int8 used_at:timestamptz expires_at:timestamptz",
            "p refresh_digest",
            "c refresh_digest octet_length(refresh_digest)=32",
            "f family_id public.site_session_refresh:family_id delete-cascade",
            "c generation generation>=0",
            "c used_at,expires_at used_at<expires_at"));

    private static readonly RelationGroup SiteRefreshRelations = new(
        "The site refresh schema is partially installed.",
        "public.site_session_refresh", "public.site_session_refresh_tombstone");
}
