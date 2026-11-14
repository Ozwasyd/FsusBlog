using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] AppearanceActivationColumns =
    [
        "appearance_activation singleton:bool revision:int8 theme_digest:text font_digest:text",
        "appearance_activation_audit revision:int8 principal_id:uuid rollback:bool previous_theme_digest:text previous_font_digest:text theme_digest:text font_digest:text happened_at:timestamptz",
        "admin_appearance_step_up digest:bytea principal_id:uuid session_digest:bytea generation:int8 action:int4 body_digest:bytea options:text? expires_at:timestamptz kind:int2"
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
        "admin_appearance_step_up p digest",
        "admin_appearance_step_up f principal_id public.admin_principal:id",
        "admin_appearance_step_up f session_digest public.admin_session:digest delete-cascade",
        "admin_appearance_step_up u session_digest,kind",
        "admin_appearance_step_up c digest octet_length(digest)=32",
        "admin_appearance_step_up c session_digest octet_length(session_digest)=32",
        "admin_appearance_step_up c generation generation>0",
        "admin_appearance_step_up c action action=4",
        "admin_appearance_step_up c body_digest octet_length(body_digest)=32",
        "admin_appearance_step_up c options octet_length(options)>=1ANDoctet_length(options)<=8192",
        "admin_appearance_step_up c kind,options kind=1ANDoptionsISNOTNULLORkind=2ANDoptionsISNULL"
    ];

    internal static async Task<bool> HasAppearanceActivationAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            select num_nonnulls(pg_catalog.to_regclass('public.appearance_activation'),
              pg_catalog.to_regclass('public.appearance_activation_audit'),pg_catalog.to_regclass('public.admin_appearance_step_up'))
            """, db, tx);
        return await command.ExecuteScalarAsync(ct) switch
        {
            0 => false,
            3 => true,
            _ => throw new InvalidOperationException("Appearance activation schema is partially installed.")
        };
    }

    private static async Task VerifyAppearanceActivationAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            select exists (select from public.appearance_activation s where s.singleton and
              s.revision=coalesce((select max(a.revision) from public.appearance_activation_audit a),0)
              and (s.revision=0 and s.theme_digest='' and s.font_digest='' or exists (
                select from public.appearance_activation_audit a where a.revision=s.revision
                  and a.theme_digest=s.theme_digest and a.font_digest=s.font_digest)))
            """, db, tx);
        if (await command.ExecuteScalarAsync(ct) is not true)
            throw new InvalidOperationException("Appearance activation coordinates are incomplete.");
    }
}
