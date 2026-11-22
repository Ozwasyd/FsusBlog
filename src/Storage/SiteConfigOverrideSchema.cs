using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts SiteConfigOverrideShape = Tables(
        Table("site_config_override singleton:bool revision:int8 seo_json:text? compliance_json:text?",
            "p singleton",
            "c singleton singleton",
            "c revision revision>=0",
            "c seo_json octet_length(seo_json)<=16384",
            "c compliance_json octet_length(compliance_json)<=16384",
            "c revision,seo_json,compliance_json revision=0ANDseo_jsonISNULLANDcompliance_jsonISNULLORrevision>0ANDseo_jsonISNOTNULLANDcompliance_jsonISNOTNULL"),
        Table("site_config_audit revision:int8 principal_id:uuid previous_digest:bytea next_digest:bytea happened_at:timestamptz",
            "p revision",
            "c revision revision>0",
            "f principal_id public.admin_principal:id",
            "c previous_digest octet_length(previous_digest)=32",
            "c next_digest octet_length(next_digest)=32"),
        StepUpShape("admin_site_config_step_up", "action=13"));

    private static readonly RelationGroup SiteConfigOverrideRelations = new(
        "The site configuration override schema is partially installed.",
        "public.site_config_override", "public.site_config_audit", "public.admin_site_config_step_up");

    internal static Task<bool> HasSiteConfigOverrideSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        SiteConfigOverrideRelations.IsPresentAsync(db, tx, ct);

    private static readonly CatalogInvariant SiteConfigOverride = new(
        """
            select exists (select from public.site_config_override s where s.singleton and
              s.revision=coalesce((select max(a.revision) from public.site_config_audit a),0)
              and ((s.revision=0 and s.seo_json is null and s.compliance_json is null)
                or (s.revision>0 and s.seo_json is not null and s.compliance_json is not null
                    and exists (select from public.site_config_audit a where a.revision=s.revision))))
            """,
        "The site configuration override coordinates are incomplete.");
}
