using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts SiteRecoveryKeyShape = Tables(
        Table("site_recovery_key user_id:uuid lookup_digest:bytea salt:bytea verifier:bytea version:int8 created_at:timestamptz used_at:timestamptz? failed_count:int2 failure_until:timestamptz=now",
            "p user_id",
            "f user_id public.passkey_subject:user_id",
            "u lookup_digest",
            "c lookup_digest octet_length(lookup_digest)=32",
            "c salt octet_length(salt)=16",
            "c verifier octet_length(verifier)=32",
            "c version version>0",
            "c failed_count failed_count>=0ANDfailed_count<=8"),
        Table("site_recovery_flow digest:bytea user_id:uuid generation:int8 session_digest:bytea purpose:int2 kind:int2 options:text? expires_at:timestamptz",
            "p digest",
            "f user_id public.passkey_subject:user_id",
            "c digest octet_length(digest)=32",
            "c generation generation>0",
            "c session_digest octet_length(session_digest)=32",
            "c purpose purpose>=1ANDpurpose<=2",
            "c options octet_length(options)>=1ANDoctet_length(options)<=8192",
            "u user_id,purpose,kind",
            "c kind,options kind=1ANDoptionsISNOTNULLORkind=2ANDoptionsISNULL"),
        Table("site_recovery_rebind user_id:uuid generation:int8 ticket_digest:bytea expires_at:timestamptz challenge_digest:bytea? options:text? challenge_expires_at:timestamptz? request_digest:bytea? completed_at:timestamptz?",
            "p user_id",
            "f user_id public.passkey_subject:user_id",
            "c generation generation>0",
            "u ticket_digest",
            "c ticket_digest octet_length(ticket_digest)=32",
            "c challenge_digest octet_length(challenge_digest)=32",
            "c options octet_length(options)>=1ANDoctet_length(options)<=8192",
            "c request_digest octet_length(request_digest)=32",
            "c challenge_digest,options (challenge_digestISNULL)=(optionsISNULL)",
            "c challenge_digest,challenge_expires_at (challenge_digestISNULL)=(challenge_expires_atISNULL)",
            "c request_digest,completed_at (request_digestISNULL)=(completed_atISNULL)"));

    private static readonly RelationGroup SiteRecoveryKeyRelations = new(
        "The site Recovery Key schema is partially installed.",
        "public.site_recovery_key", "public.site_recovery_flow", "public.site_recovery_rebind");

    internal static Task<bool> HasSiteRecoveryKeySchemaAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken ct) =>
        SiteRecoveryKeyRelations.IsPresentAsync(connection, transaction, ct);

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
