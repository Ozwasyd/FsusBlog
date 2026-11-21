using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] SiteRecoveryKeyColumns =
    [
        "site_recovery_key user_id:uuid lookup_digest:bytea salt:bytea verifier:bytea version:int8 created_at:timestamptz used_at:timestamptz? failed_count:int2 failure_until:timestamptz=now",
        "site_recovery_flow digest:bytea user_id:uuid generation:int8 session_digest:bytea purpose:int2 kind:int2 options:text? expires_at:timestamptz",
        "site_recovery_rebind user_id:uuid generation:int8 ticket_digest:bytea expires_at:timestamptz challenge_digest:bytea? options:text? challenge_expires_at:timestamptz? request_digest:bytea? completed_at:timestamptz?"
    ];

    private static readonly string[] SiteRecoveryKeyConstraints =
    [
        "site_recovery_key p user_id",
        "site_recovery_key f user_id public.passkey_subject:user_id",
        "site_recovery_key u lookup_digest",
        "site_recovery_key c lookup_digest octet_length(lookup_digest)=32",
        "site_recovery_key c salt octet_length(salt)=16",
        "site_recovery_key c verifier octet_length(verifier)=32",
        "site_recovery_key c version version>0",
        "site_recovery_key c failed_count failed_count>=0ANDfailed_count<=8",
        "site_recovery_flow p digest",
        "site_recovery_flow f user_id public.passkey_subject:user_id",
        "site_recovery_flow c digest octet_length(digest)=32",
        "site_recovery_flow c generation generation>0",
        "site_recovery_flow c session_digest octet_length(session_digest)=32",
        "site_recovery_flow c purpose purpose>=1ANDpurpose<=2",
        "site_recovery_flow c options octet_length(options)>=1ANDoctet_length(options)<=8192",
        "site_recovery_flow u user_id,purpose,kind",
        "site_recovery_flow c kind,options kind=1ANDoptionsISNOTNULLORkind=2ANDoptionsISNULL",
        "site_recovery_rebind p user_id",
        "site_recovery_rebind f user_id public.passkey_subject:user_id",
        "site_recovery_rebind c generation generation>0",
        "site_recovery_rebind u ticket_digest",
        "site_recovery_rebind c ticket_digest octet_length(ticket_digest)=32",
        "site_recovery_rebind c challenge_digest octet_length(challenge_digest)=32",
        "site_recovery_rebind c options octet_length(options)>=1ANDoctet_length(options)<=8192",
        "site_recovery_rebind c request_digest octet_length(request_digest)=32",
        "site_recovery_rebind c challenge_digest,options (challenge_digestISNULL)=(optionsISNULL)",
        "site_recovery_rebind c challenge_digest,challenge_expires_at (challenge_digestISNULL)=(challenge_expires_atISNULL)",
        "site_recovery_rebind c request_digest,completed_at (request_digestISNULL)=(completed_atISNULL)"
    ];

    private static readonly string[] SiteRecoveryKeyRelations =
        ["public.site_recovery_key", "public.site_recovery_flow", "public.site_recovery_rebind"];

    internal static Task<bool> HasSiteRecoveryKeySchemaAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken ct) =>
        HasCompleteRelationsAsync(connection, transaction, ct, "The site Recovery Key schema is partially installed.",
            SiteRecoveryKeyRelations);

    private static bool HasSiteRecoveryKeySchema(CatalogPresenceSnapshot catalog) =>
        catalog.HasCompleteRelations("The site Recovery Key schema is partially installed.", SiteRecoveryKeyRelations);

    // An issued Recovery Key is durable evidence that this account passed Passkey enrollment.
    internal static async Task<bool> RequiresSiteRecoveryAsync(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, CancellationToken ct)
    {
        if (!await HasSiteRecoveryKeySchemaAsync(db, tx, ct)) return false;
        await using var query = new NpgsqlCommand("""
            select exists(select from public.site_recovery_key where user_id=$1)
                and not exists(select from public.passkey_credential where user_id=$1)
            """, db, tx);
        query.Parameters.AddWithValue(owner);
        return await query.ExecuteScalarAsync(ct) is true;
    }
}
