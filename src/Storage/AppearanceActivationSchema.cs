using System;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] AppearanceActivationColumns =
    [
        "appearance_activation singleton:bool revision:int8 theme_digest:text font_digest:text",
        "appearance_activation_audit revision:int8 principal_id:uuid rollback:bool previous_theme_digest:text previous_font_digest:text theme_digest:text font_digest:text happened_at:timestamptz",
        StepUpColumns("admin_appearance_step_up")
    ];

    private static readonly string[] AppearanceActivationConstraints =
    [
        "appearance_activation p singleton",
        "appearance_activation c singleton singleton",
        "appearance_activation c revision revision>=0",
        "appearance_activation c theme_digest theme_digest=''::textORtheme_digest~'^[0-9a-f]{64}$'::text",
        "appearance_activation c font_digest font_digest=''::textORfont_digest~'^[0-9a-f]{64}$'::text",
        "appearance_activation_audit p revision",
        "appearance_activation_audit c revision revision>0",
        "appearance_activation_audit f principal_id public.admin_principal:id",
        ..StepUpConstraints("admin_appearance_step_up", "action=4")
    ];

    private static readonly string[] AppearanceActivationRelations =
        ["public.appearance_activation", "public.appearance_activation_audit", "public.admin_appearance_step_up"];

    private static bool HasAppearanceActivation(CatalogPresenceSnapshot catalog) =>
        catalog.HasCompleteRelations("Appearance activation schema is partially installed.", AppearanceActivationRelations);

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
