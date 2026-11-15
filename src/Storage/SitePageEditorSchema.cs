using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] SitePageEditorColumns =
    [
        "site_page_content slug:text revision:int8 markdown:text?",
        "site_page_publish_audit slug:text revision:int8 principal_id:uuid previous_digest:bytea next_digest:bytea happened_at:timestamptz",
        "admin_site_page_step_up digest:bytea principal_id:uuid session_digest:bytea generation:int8 action:int4 body_digest:bytea options:text? expires_at:timestamptz kind:int2"
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
        "admin_site_page_step_up p digest",
        "admin_site_page_step_up f principal_id public.admin_principal:id",
        "admin_site_page_step_up f session_digest public.admin_session:digest delete-cascade",
        "admin_site_page_step_up u session_digest,kind",
        "admin_site_page_step_up c digest octet_length(digest)=32",
        "admin_site_page_step_up c session_digest octet_length(session_digest)=32",
        "admin_site_page_step_up c generation generation>0",
        "admin_site_page_step_up c action action=2",
        "admin_site_page_step_up c body_digest octet_length(body_digest)=32",
        "admin_site_page_step_up c options octet_length(options)>=1ANDoctet_length(options)<=8192",
        "admin_site_page_step_up c kind,options kind=1ANDoptionsISNOTNULLORkind=2ANDoptionsISNULL"
    ];

    internal static Task<bool> HasSitePageEditorSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasCompleteRelationsAsync(db, tx, ct, "The site page editor schema is partially installed.",
            "public.site_page_content", "public.site_page_publish_audit", "public.admin_site_page_step_up");

    private static async Task VerifySitePageCoordinatesAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            select count(*)=4 and coalesce(bool_and(
                revision=coalesce((select max(a.revision) from public.site_page_publish_audit a where a.slug=p.slug),0)
            ),false) from public.site_page_content p
            """, db, tx);
        if (await command.ExecuteScalarAsync(ct) is not true)
            throw new InvalidOperationException("The site page editor publication coordinates are incomplete.");
    }
}
