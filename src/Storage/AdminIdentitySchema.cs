namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const int AdminIdentityVersion = 8;

    private static SchemaFacts StepUpShape(string table, string action) => Table(
        $"{table} digest:bytea principal_id:uuid session_digest:bytea generation:int8 action:int4 body_digest:bytea options:text? expires_at:timestamptz kind:int2",
        "p digest", "f principal_id public.admin_principal:id",
        "f session_digest public.admin_session:digest delete-cascade", "u session_digest,kind",
        Bytes32("digest", "session_digest", "body_digest"),
        "c generation generation>0", $"c action {action}",
        "c options octet_length(options)>=1ANDoctet_length(options)<=8192",
        "c kind,options kind=1ANDoptionsISNOTNULLORkind=2ANDoptionsISNULL");

    private static string[] PasskeyCredentialConstraints(string ownerCol, string ownerTarget) =>
    [
        "p credential_id", $"f {ownerCol} {ownerTarget}",
        "c credential_id octet_length(credential_id)>=1ANDoctet_length(credential_id)<=1023",
        "c public_key octet_length(public_key)>=1ANDoctet_length(public_key)<=16384",
        "c sign_count sign_count>=0ANDsign_count<='4294967295'::bigint",
        "c backed_up,backup_eligible NOTbacked_upORbackup_eligible"
    ];

    private static readonly SchemaFacts AdminIdentityShape = Tables(
        Singleton("admin_identity_schema singleton:bool version:int4", $"c version version={AdminIdentityVersion}"),
        Table("admin_passkey_credential credential_id:bytea principal_id:uuid public_key:bytea sign_count:int8 backup_eligible:bool backed_up:bool",
            "u principal_id", PasskeyCredentialConstraints("principal_id", "public.admin_principal:id")),
        Table("admin_invitation digest:bytea principal_id:uuid generation:int8 expires_at:timestamptz",
            "p digest", "u principal_id", "f principal_id public.admin_principal:id",
            Bytes32("digest"), Pos("generation")),
        Table("admin_challenge digest:bytea principal_id:uuid? generation:int8? binding_digest:bytea kind:int4 options:text expires_at:timestamptz started_at:timestamptz=clock_timestamp",
            "p digest", "f principal_id public.admin_principal:id", Bytes32("digest", "binding_digest"),
            "c options octet_length(options)>=1ANDoctet_length(options)<=8192",
            "c kind,principal_id,generation kind=1ANDprincipal_idISNULLANDgenerationISNULLORkind=2ANDprincipal_idISNOTNULLANDgenerationISNOTNULLANDgeneration>0"),
        Table("admin_identity_audit id:int8:a principal_id:uuid action:text happened_at:timestamptz actor:text",
            "p id", "f principal_id public.admin_principal:id",
            "c action octet_length(action)>=1ANDoctet_length(action)<=48",
            "c actor octet_length(actor)>=1ANDoctet_length(actor)<=255"),
        StepUpShape("admin_step_up", "action=1"),
        StepUpShape("admin_reader_governance_step_up", "action=12"),
        Table("admin_reader_governance_audit id:int8:a user_id:uuid principal_id:uuid command_id:uuid fingerprint:bytea previous_enabled:bool next_enabled:bool previous_generation:int8 next_generation:int8 revoked_session_count:int4 reason:text happened_at:timestamptz=clock_timestamp",
            "p id", "u principal_id,command_id", "f user_id public.blog_user:id", "f principal_id public.admin_principal:id",
            Bytes32("fingerprint"), Pos("previous_generation", "next_generation"), NonNeg("revoked_session_count"),
            "c reason char_length(reason)>=1ANDchar_length(reason)<=500ANDoctet_length(reason)<=2000",
            "c previous_enabled,next_enabled previous_enabled<>next_enabled",
            "c next_generation,previous_generation next_generation=(previous_generation+1)"),
        StepUpShape("admin_handle_step_up", "action=14"),
        Table("admin_handle_rename_audit id:int8:a principal_id:uuid command_id:uuid fingerprint:bytea previous_handle:text next_handle:text happened_at:timestamptz=clock_timestamp",
            "p id", "u principal_id,command_id", "f principal_id public.admin_principal:id", Bytes32("fingerprint"),
            "c previous_handle previous_handle~'^[a-z][a-z0-9_.-]{0,63}$'::text",
            "c next_handle next_handle~'^[a-z][a-z0-9_.-]{0,63}$'::text",
            "c previous_handle,next_handle previous_handle<>next_handle"),
        Table("admin_comment_claim article_id:int4 comment_id:int8 principal_id:uuid session_digest:bytea admin_generation:int8 claim_digest:bytea claim_generation:int8 claim_version:int8 claimed_comment_version:int8 expires_at:timestamptz state:int2",
            "p article_id,comment_id", "f article_id,comment_id public.comment_submit_command:article_id,comment_id",
            "f principal_id public.admin_principal:id", Bytes32("session_digest", "claim_digest"),
            Pos("admin_generation", "claim_generation", "claim_version", "claimed_comment_version"),
            "c state state>=1ANDstate<=3"),
        Table("admin_comment_moderation id:int8:a article_id:int4 comment_id:int8 principal_id:uuid previous_status:int2 next_status:int2 reason:text happened_at:timestamptz comment_version:int8",
            "p id", "f article_id,comment_id public.comment_submit_command:article_id,comment_id",
            "f principal_id public.admin_principal:id", "c previous_status previous_status=0",
            "c next_status next_status>=1ANDnext_status<=2",
            "c reason octet_length(reason)>=1ANDoctet_length(reason)<=1024", Pos("comment_version")),
        Table("admin_session digest:bytea principal_id:uuid generation:int8 expires_at:timestamptz sign_in_id:int8?",
            "p digest", "u principal_id", "f principal_id public.admin_principal:id",
            "f principal_id,sign_in_id public.admin_sign_in:principal_id,id", Bytes32("digest"), Pos("generation")),
        Table("admin_sign_in principal_id:uuid id:int8:a started_at:timestamptz expires_at:timestamptz ended_at:timestamptz?",
            "p principal_id,id", "f principal_id public.admin_principal:id",
            "c expires_at,started_at expires_at>started_at",
            "c ended_at,started_at,expires_at ended_at>=started_atANDended_at<=expires_at"));

    internal static async Task VerifyAdminIdentityMarkerAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (await ReadSingleVersionAsync(db, tx, "select version from public.admin_identity_schema",
                "Expected a single admin identity schema marker.", ct) != AdminIdentityVersion)
            throw new InvalidOperationException($"Expected admin identity schema version {AdminIdentityVersion}.");
    }

    private static async Task<int> ReadSingleVersionAsync(NpgsqlConnection db, NpgsqlTransaction tx, string sql, string error, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand(sql, db, tx);
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new InvalidOperationException(error);
        var version = row.GetInt32(0);
        if (await row.ReadAsync(ct)) throw new InvalidOperationException(error);
        return version;
    }
}
