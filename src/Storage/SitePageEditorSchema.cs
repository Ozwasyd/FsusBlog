using System;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] SitePageEditorColumns =
    [
        "site_page_content slug:text revision:int8 markdown:text?",
        "site_page_publish_audit slug:text revision:int8 principal_id:uuid previous_digest:bytea next_digest:bytea happened_at:timestamptz",
        StepUpColumns("admin_site_page_step_up")
    ];

    private static readonly string[] SitePageEditorConstraints =
    [
        "site_page_content p slug",
        "site_page_content c slug slug='about'::textORslug='privacy'::textORslug='guidelines'::textORslug='copyright'::text",
        "site_page_content c markdown octet_length(markdown)<=600000",
        "site_page_content c revision,markdown revision=0ANDmarkdownISNULLORrevision>0ANDmarkdownISNOTNULL",
        "site_page_publish_audit p slug,revision",
        "site_page_publish_audit f slug public.site_page_content:slug",
        "site_page_publish_audit f principal_id public.admin_principal:id",
        "site_page_publish_audit c revision revision>0",
        "site_page_publish_audit c previous_digest octet_length(previous_digest)=32",
        "site_page_publish_audit c next_digest octet_length(next_digest)=32",
        ..StepUpConstraints("admin_site_page_step_up", "action=2")
    ];

    private static readonly string[] SitePageEditorRelations =
        ["public.site_page_content", "public.site_page_publish_audit", "public.admin_site_page_step_up"];

    private static bool HasSitePageEditorSchema(CatalogPresenceSnapshot catalog) =>
        catalog.HasCompleteRelations("The site page editor schema is partially installed.", SitePageEditorRelations);

    private static readonly CatalogInvariant SitePageCoordinates = new(
        """
            select count(*)=4 and coalesce(bool_and(
                revision=coalesce((select max(a.revision) from public.site_page_publish_audit a where a.slug=p.slug),0)
            ),false) from public.site_page_content p
            """,
        "The site page editor publication coordinates are incomplete.");
}
