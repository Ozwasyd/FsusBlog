namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts SitePageEditorShape = Tables(
        Table("site_page_content slug:text revision:int8 markdown:text?",
            "p slug",
            "c slug slug='about'::textORslug='privacy'::textORslug='guidelines'::textORslug='copyright'::text",
            "c markdown octet_length(markdown)<=600000",
            "c revision,markdown revision=0ANDmarkdownISNULLORrevision>0ANDmarkdownISNOTNULL"),
        Table("site_page_publish_audit slug:text revision:int8 principal_id:uuid previous_digest:bytea next_digest:bytea happened_at:timestamptz",
            "p slug,revision",
            "f slug public.site_page_content:slug",
            "f principal_id public.admin_principal:id",
            "c revision revision>0",
            "c previous_digest octet_length(previous_digest)=32",
            "c next_digest octet_length(next_digest)=32"),
        StepUpShape("admin_site_page_step_up", "action=2"));

    private static readonly RelationGroup SitePageEditorRelations = new(
        "The site page editor schema is partially installed.",
        "public.site_page_content", "public.site_page_publish_audit", "public.admin_site_page_step_up");

    private static readonly CatalogInvariant SitePageCoordinates = new(
        """
            select count(*)=4 and coalesce(bool_and(
                revision=coalesce((select max(a.revision) from public.site_page_publish_audit a where a.slug=p.slug),0)
            ),false) from public.site_page_content p
            """,
        "The site page editor publication coordinates are incomplete.");
}
