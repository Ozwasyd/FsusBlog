using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] SiteConfigOverrideColumns =
    [
        "site_config_override singleton:bool revision:int8 seo_json:text? compliance_json:text?",
        "site_config_audit revision:int8 principal_id:uuid previous_digest:bytea next_digest:bytea happened_at:timestamptz",
        StepUpColumns("admin_site_config_step_up")
    ];

    private static readonly string[] SiteConfigOverrideConstraints =
    [
        "site_config_override p singleton",
        "site_config_override c singleton singleton",
        "site_config_override c revision revision>=0",
        "site_config_override c seo_json octet_length(seo_json)<=16384",
        "site_config_override c compliance_json octet_length(compliance_json)<=16384",
        "site_config_override c revision,seo_json,compliance_json revision=0ANDseo_jsonISNULLANDcompliance_jsonISNULLORrevision>0ANDseo_jsonISNOTNULLANDcompliance_jsonISNOTNULL",
        "site_config_audit p revision",
        "site_config_audit c revision revision>0",
        "site_config_audit f principal_id public.admin_principal:id",
        "site_config_audit c previous_digest octet_length(previous_digest)=32",
        "site_config_audit c next_digest octet_length(next_digest)=32",
        ..StepUpConstraints("admin_site_config_step_up", "action=13")
    ];

    private static readonly string[] SiteConfigOverrideRelations =
        ["public.site_config_override", "public.site_config_audit", "public.admin_site_config_step_up"];

    internal static Task<bool> HasSiteConfigOverrideSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasCompleteRelationsAsync(db, tx, ct, "The site configuration override schema is partially installed.",
            SiteConfigOverrideRelations);

    private static bool HasSiteConfigOverrideSchema(CatalogPresenceSnapshot catalog) =>
        catalog.HasCompleteRelations("The site configuration override schema is partially installed.", SiteConfigOverrideRelations);

    private static async Task VerifySiteConfigOverrideAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            select exists (select from public.site_config_override s where s.singleton and
              s.revision=coalesce((select max(a.revision) from public.site_config_audit a),0)
              and ((s.revision=0 and s.seo_json is null and s.compliance_json is null)
                or (s.revision>0 and s.seo_json is not null and s.compliance_json is not null
                    and exists (select from public.site_config_audit a where a.revision=s.revision))))
            """, db, tx);
        if (await command.ExecuteScalarAsync(ct) is not true)
            throw new InvalidOperationException("The site configuration override coordinates are incomplete.");
    }
}
