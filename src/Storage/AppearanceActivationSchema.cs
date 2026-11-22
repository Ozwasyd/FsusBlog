namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts AppearanceActivationShape = Tables(
        Table("appearance_activation singleton:bool revision:int8 theme_digest:text font_digest:text",
            "p singleton",
            "c singleton singleton",
            "c revision revision>=0",
            "c theme_digest theme_digest=''::textORtheme_digest~'^[0-9a-f]{64}$'::text",
            "c font_digest font_digest=''::textORfont_digest~'^[0-9a-f]{64}$'::text"),
        Table("appearance_activation_audit revision:int8 principal_id:uuid rollback:bool previous_theme_digest:text previous_font_digest:text theme_digest:text font_digest:text happened_at:timestamptz",
            "p revision",
            "c revision revision>0",
            "f principal_id public.admin_principal:id"),
        StepUpShape("admin_appearance_step_up", "action=4"));

    private static readonly RelationGroup AppearanceActivationRelations = new(
        "Appearance activation schema is partially installed.",
        "public.appearance_activation", "public.appearance_activation_audit", "public.admin_appearance_step_up");

    private static readonly CatalogInvariant AppearanceActivation = new(
        """
            select exists (select from public.appearance_activation s where s.singleton and
              s.revision=coalesce((select max(a.revision) from public.appearance_activation_audit a),0)
              and (s.revision=0 and s.theme_digest='' and s.font_digest='' or exists (
                select from public.appearance_activation_audit a where a.revision=s.revision
                  and a.theme_digest=s.theme_digest and a.font_digest=s.font_digest)))
            """,
        "Appearance activation coordinates are incomplete.");
}
