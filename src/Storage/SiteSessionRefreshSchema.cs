namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] SiteRefreshColumns =
    [
        "site_session_refresh family_id:uuid access_digest:bytea refresh_digest:bytea previous_access_digest:bytea? generation:int8 idle_expires_at:timestamptz absolute_expires_at:timestamptz rotated_at:timestamptz",
        "site_session_refresh_tombstone refresh_digest:bytea family_id:uuid generation:int8 used_at:timestamptz expires_at:timestamptz"
    ];

    private static readonly string[] SiteRefreshConstraints =
    [
        "site_session_refresh p family_id",
        "site_session_refresh u access_digest",
        "site_session_refresh f access_digest public.user_session:digest delete-cascade update-cascade",
        "site_session_refresh c access_digest octet_length(access_digest)=32",
        "site_session_refresh u refresh_digest",
        "site_session_refresh c refresh_digest octet_length(refresh_digest)=32",
        "site_session_refresh c previous_access_digest octet_length(previous_access_digest)=32",
        "site_session_refresh c generation generation>=0",
        "site_session_refresh c idle_expires_at,absolute_expires_at idle_expires_at<=absolute_expires_at",
        "site_session_refresh_tombstone p refresh_digest",
        "site_session_refresh_tombstone c refresh_digest octet_length(refresh_digest)=32",
        "site_session_refresh_tombstone f family_id public.site_session_refresh:family_id delete-cascade",
        "site_session_refresh_tombstone c generation generation>=0",
        "site_session_refresh_tombstone c used_at,expires_at used_at<expires_at"
    ];

    private static readonly string[] SiteRefreshRelations =
        ["public.site_session_refresh", "public.site_session_refresh_tombstone"];

    private static bool HasSiteRefreshSchema(CatalogPresenceSnapshot catalog) =>
        catalog.HasCompleteRelations("The site refresh schema is partially installed.", SiteRefreshRelations);
}
