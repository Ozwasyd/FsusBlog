using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string AdminIdentityMarker = "public.admin_identity_schema";
    internal const int AdminIdentityVersion = 8;
    internal const int AdminSystemConfigVersion = 7;
    private const int AdminStepUpVersion = 5;
    private const int AdminModerationVersion = 6;
    internal const string AdminManagePermission = "admin.manage";
    internal const string AuditReadPermission = "audit.read";
    internal const string CommentModeratePermission = "comment.moderate";
    internal const string ArticleWritePermission = "article.write";
    internal const string SystemConfigPermission = "system.config";

    private static readonly string[] AdminIdentityColumns =
    [
        "admin_identity_schema singleton:bool version:int4",
        "admin_principal id:uuid handle:text user_handle:bytea enabled:bool generation:int8 generation_changed_at:timestamptz=clock_timestamp",
        "admin_permission principal_id:uuid permission:text",
        "admin_passkey_credential credential_id:bytea principal_id:uuid public_key:bytea sign_count:int8 backup_eligible:bool backed_up:bool",
        "admin_invitation digest:bytea principal_id:uuid generation:int8 expires_at:timestamptz",
        "admin_challenge digest:bytea principal_id:uuid? generation:int8? binding_digest:bytea kind:int4 options:text expires_at:timestamptz started_at:timestamptz=clock_timestamp",
        "admin_identity_audit id:int8:a principal_id:uuid action:text happened_at:timestamptz actor:text"
    ];

    private static readonly string[] AdminIdentityConstraints =
    [
        "admin_identity_schema p singleton",
        "admin_identity_schema c singleton singleton",
        "admin_principal p id",
        "admin_principal u handle",
        "admin_principal c handle handle~'^[a-z][a-z0-9_.-]{0,63}$'::text",
        "admin_principal u user_handle",
        "admin_principal c user_handle octet_length(user_handle)=32",
        "admin_principal c generation generation>0",
        "admin_permission p principal_id,permission",
        "admin_permission f principal_id public.admin_principal:id",
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
        "admin_session c digest octet_length(digest)=32",
        "admin_session c generation generation>0",
        "admin_identity_audit p id",
        "admin_identity_audit f principal_id public.admin_principal:id",
        "admin_identity_audit c action octet_length(action)>=1ANDoctet_length(action)<=48",
        "admin_identity_audit c actor octet_length(actor)>=1ANDoctet_length(actor)<=255"
    ];

    private static readonly string AdminStepUpColumns = StepUpColumns("admin_step_up");

    private static string StepUpColumns(string table) =>
        $"{table} digest:bytea principal_id:uuid session_digest:bytea generation:int8 action:int4 body_digest:bytea options:text? expires_at:timestamptz kind:int2";
    private const string AdminSessionColumns = "admin_session digest:bytea principal_id:uuid generation:int8 expires_at:timestamptz";
    private static readonly string[] AdminSignInColumns =
    [
        AdminSessionColumns + " sign_in_id:int8?",
        "admin_sign_in principal_id:uuid id:int8:a started_at:timestamptz expires_at:timestamptz ended_at:timestamptz?"
    ];

    private static string[] GetAdminIdentityColumns(int version) => version switch
    {
        AdminStepUpVersion => [.. AdminIdentityColumns, AdminSessionColumns, AdminStepUpColumns],
        AdminModerationVersion or AdminSystemConfigVersion or AdminIdentityVersion =>
        [
            .. AdminIdentityColumns, AdminStepUpColumns,
            "admin_comment_claim article_id:int4 comment_id:int8 principal_id:uuid session_digest:bytea admin_generation:int8 claim_digest:bytea claim_generation:int8 claim_version:int8 claimed_comment_version:int8 expires_at:timestamptz state:int2",
            "admin_comment_moderation id:int8:a article_id:int4 comment_id:int8 principal_id:uuid previous_status:int2 next_status:int2 reason:text happened_at:timestamptz comment_version:int8",
            .. (version == AdminIdentityVersion ? AdminSignInColumns : [AdminSessionColumns])
        ],
        _ => [.. AdminIdentityColumns, AdminSessionColumns]
    };

    private const string PriorPermissionConstraint = "admin_permission c permission permission='admin.manage'::textORpermission='audit.read'::textORpermission='comment.moderate'::textORpermission='article.write'::text";

    private static readonly string[] AdminStepUpConstraints = StepUpConstraints("admin_step_up", "action=1");

    private static string[] StepUpConstraints(string table, string action, bool validateOptions = true) =>
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
        ..(validateOptions ? new[]
        {
            $"{table} c options octet_length(options)>=1ANDoctet_length(options)<=8192",
            $"{table} c kind,options kind=1ANDoptionsISNOTNULLORkind=2ANDoptionsISNULL"
        } : [$"{table} c kind kind>=1ANDkind<=2"])
    ];

    private static readonly string[] AdminSignInConstraints =
    [
        "admin_session f principal_id,sign_in_id public.admin_sign_in:principal_id,id",
        "admin_sign_in p principal_id,id",
        "admin_sign_in f principal_id public.admin_principal:id",
        "admin_sign_in c expires_at,started_at expires_at>started_at",
        "admin_sign_in c ended_at,started_at,expires_at ended_at>=started_atANDended_at<=expires_at"
    ];

    private static string[] GetAdminIdentityConstraints(int version) => version switch
    {
        1 =>
        [
            .. AdminIdentityConstraints,
            "admin_identity_schema c version version=1",
            "admin_permission c permission permission='admin.manage'::text"
        ],
        2 =>
        [
            .. AdminIdentityConstraints,
            "admin_identity_schema c version version=2",
            "admin_permission c permission permission='admin.manage'::textORpermission='audit.read'::text"
        ],
        3 =>
        [
            .. AdminIdentityConstraints,
            "admin_identity_schema c version version=3",
            "admin_permission c permission permission='admin.manage'::textORpermission='audit.read'::textORpermission='comment.moderate'::text"
        ],
        4 =>
        [
            .. AdminIdentityConstraints,
            "admin_identity_schema c version version=4",
            PriorPermissionConstraint
        ],
        AdminStepUpVersion =>
        [
            .. AdminIdentityConstraints,
            "admin_identity_schema c version version=5",
            PriorPermissionConstraint,
            .. AdminStepUpConstraints
        ],
        AdminModerationVersion or AdminSystemConfigVersion or AdminIdentityVersion =>
        [
            .. AdminIdentityConstraints,
            $"admin_identity_schema c version version={version}",
            version >= AdminSystemConfigVersion ? PriorPermissionConstraint + "ORpermission='system.config'::text" : PriorPermissionConstraint,
            .. AdminStepUpConstraints,
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
            "admin_comment_moderation c comment_version comment_version>0",
            .. (version == AdminIdentityVersion ? AdminSignInConstraints : [])
        ],
        _ => throw new InvalidOperationException("Unsupported admin identity schema version.")
    };

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
