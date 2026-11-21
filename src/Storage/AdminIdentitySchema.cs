using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string AdminIdentityMarker = "public.admin_identity_schema";
    internal const int AdminIdentityVersion = 8;

    private static string StepUpColumns(string table) =>
        $"{table} digest:bytea principal_id:uuid session_digest:bytea generation:int8 action:int4 body_digest:bytea options:text? expires_at:timestamptz kind:int2";

    private static string[] StepUpConstraints(string table, string action) =>
    [
        $"{table} p digest",
        $"{table} f principal_id public.admin_principal:id",
        $"{table} f session_digest public.admin_session:digest delete-cascade",
        $"{table} u session_digest,kind",
        $"{table} c digest octet_length(digest)=32",
        $"{table} c session_digest octet_length(session_digest)=32",
        $"{table} c generation generation>0",
        $"{table} c action {action}",
        $"{table} c body_digest octet_length(body_digest)=32",
        $"{table} c options octet_length(options)>=1ANDoctet_length(options)<=8192",
        $"{table} c kind,options kind=1ANDoptionsISNOTNULLORkind=2ANDoptionsISNULL"
    ];

    private static readonly string[] AdminIdentityColumns =
    [
        "admin_identity_schema singleton:bool version:int4",
        "admin_passkey_credential credential_id:bytea principal_id:uuid public_key:bytea sign_count:int8 backup_eligible:bool backed_up:bool",
        "admin_invitation digest:bytea principal_id:uuid generation:int8 expires_at:timestamptz",
        "admin_challenge digest:bytea principal_id:uuid? generation:int8? binding_digest:bytea kind:int4 options:text expires_at:timestamptz started_at:timestamptz=clock_timestamp",
        "admin_identity_audit id:int8:a principal_id:uuid action:text happened_at:timestamptz actor:text",
        StepUpColumns("admin_step_up"),
        StepUpColumns("admin_reader_governance_step_up"),
        "admin_reader_governance_audit id:int8:a user_id:uuid principal_id:uuid command_id:uuid fingerprint:bytea previous_enabled:bool next_enabled:bool previous_generation:int8 next_generation:int8 revoked_session_count:int4 reason:text happened_at:timestamptz=clock_timestamp",
        "admin_comment_claim article_id:int4 comment_id:int8 principal_id:uuid session_digest:bytea admin_generation:int8 claim_digest:bytea claim_generation:int8 claim_version:int8 claimed_comment_version:int8 expires_at:timestamptz state:int2",
        "admin_comment_moderation id:int8:a article_id:int4 comment_id:int8 principal_id:uuid previous_status:int2 next_status:int2 reason:text happened_at:timestamptz comment_version:int8",
        "admin_session digest:bytea principal_id:uuid generation:int8 expires_at:timestamptz sign_in_id:int8?",
        "admin_sign_in principal_id:uuid id:int8:a started_at:timestamptz expires_at:timestamptz ended_at:timestamptz?"
    ];

    private static readonly string[] AdminIdentityConstraints =
    [
        "admin_identity_schema p singleton",
        "admin_identity_schema c singleton singleton",
        $"admin_identity_schema c version version={AdminIdentityVersion}",
        "admin_passkey_credential p credential_id",
        "admin_passkey_credential u principal_id",
        "admin_passkey_credential f principal_id public.admin_principal:id",
        "admin_passkey_credential c credential_id octet_length(credential_id)>=1ANDoctet_length(credential_id)<=1023",
        "admin_passkey_credential c public_key octet_length(public_key)>=1ANDoctet_length(public_key)<=16384",
        "admin_passkey_credential c sign_count sign_count>=0ANDsign_count<='4294967295'::bigint",
        "admin_passkey_credential c backed_up,backup_eligible NOTbacked_upORbackup_eligible",
        "admin_invitation p digest",
        "admin_invitation u principal_id",
        "admin_invitation f principal_id public.admin_principal:id",
        "admin_invitation c digest octet_length(digest)=32",
        "admin_invitation c generation generation>0",
        "admin_challenge p digest",
        "admin_challenge f principal_id public.admin_principal:id",
        "admin_challenge c digest octet_length(digest)=32",
        "admin_challenge c binding_digest octet_length(binding_digest)=32",
        "admin_challenge c options octet_length(options)>=1ANDoctet_length(options)<=8192",
        "admin_challenge c kind,principal_id,generation kind=1ANDprincipal_idISNULLANDgenerationISNULLORkind=2ANDprincipal_idISNOTNULLANDgenerationISNOTNULLANDgeneration>0",
        "admin_session p digest",
        "admin_session u principal_id",
        "admin_session f principal_id public.admin_principal:id",
        "admin_session f principal_id,sign_in_id public.admin_sign_in:principal_id,id",
        "admin_session c digest octet_length(digest)=32",
        "admin_session c generation generation>0",
        "admin_sign_in p principal_id,id",
        "admin_sign_in f principal_id public.admin_principal:id",
        "admin_sign_in c expires_at,started_at expires_at>started_at",
        "admin_sign_in c ended_at,started_at,expires_at ended_at>=started_atANDended_at<=expires_at",
        "admin_identity_audit p id",
        "admin_identity_audit f principal_id public.admin_principal:id",
        "admin_identity_audit c action octet_length(action)>=1ANDoctet_length(action)<=48",
        "admin_identity_audit c actor octet_length(actor)>=1ANDoctet_length(actor)<=255",
        .. StepUpConstraints("admin_step_up", "action=1"),
        .. StepUpConstraints("admin_reader_governance_step_up", "action=12"),
        "admin_reader_governance_audit p id",
        "admin_reader_governance_audit u principal_id,command_id",
        "admin_reader_governance_audit f user_id public.blog_user:id",
        "admin_reader_governance_audit f principal_id public.admin_principal:id",
        "admin_reader_governance_audit c fingerprint octet_length(fingerprint)=32",
        "admin_reader_governance_audit c previous_generation previous_generation>0",
        "admin_reader_governance_audit c next_generation next_generation>0",
        "admin_reader_governance_audit c revoked_session_count revoked_session_count>=0",
        "admin_reader_governance_audit c reason char_length(reason)>=1ANDchar_length(reason)<=500ANDoctet_length(reason)<=2000",
        "admin_reader_governance_audit c previous_enabled,next_enabled previous_enabled<>next_enabled",
        "admin_reader_governance_audit c next_generation,previous_generation next_generation=(previous_generation+1)",
        "admin_comment_claim p article_id,comment_id",
        "admin_comment_claim f article_id,comment_id public.comment_submit_command:article_id,comment_id",
        "admin_comment_claim f principal_id public.admin_principal:id",
        "admin_comment_claim c session_digest octet_length(session_digest)=32",
        "admin_comment_claim c admin_generation admin_generation>0",
        "admin_comment_claim c claim_digest octet_length(claim_digest)=32",
        "admin_comment_claim c claim_generation claim_generation>0",
        "admin_comment_claim c claim_version claim_version>0",
        "admin_comment_claim c claimed_comment_version claimed_comment_version>0",
        "admin_comment_claim c state state>=1ANDstate<=3",
        "admin_comment_moderation p id",
        "admin_comment_moderation f article_id,comment_id public.comment_submit_command:article_id,comment_id",
        "admin_comment_moderation f principal_id public.admin_principal:id",
        "admin_comment_moderation c previous_status previous_status=0",
        "admin_comment_moderation c next_status next_status>=1ANDnext_status<=2",
        "admin_comment_moderation c reason octet_length(reason)>=1ANDoctet_length(reason)<=1024",
        "admin_comment_moderation c comment_version comment_version>0"
    ];

    internal static async Task VerifyAdminIdentityMarkerAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (await ReadAdminIdentityVersionAsync(db, tx, ct) != AdminIdentityVersion)
            throw new InvalidOperationException($"Expected admin identity schema version {AdminIdentityVersion}.");
    }

    internal static async Task<int> ReadAdminIdentityVersionAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("select version from public.admin_identity_schema", db, tx);
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new InvalidOperationException("Expected a single admin identity schema marker.");
        var version = row.GetInt32(0);
        if (await row.ReadAsync(ct)) throw new InvalidOperationException("Expected a single admin identity schema marker.");
        return version;
    }
}
