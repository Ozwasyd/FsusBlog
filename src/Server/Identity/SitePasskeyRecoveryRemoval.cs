using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed partial class PasskeyStore
{
    private static async Task<long> CurrentRecoveryVersion(NpgsqlConnection db, NpgsqlTransaction tx, MfaStore.Subject actor,
        byte[] proof, CancellationToken ct)
    {
        if (!await CurrentSchema.HasSiteRecoveryKeySchemaAsync(db, tx, ct)) throw Denied();
        await using var query = Store.Sql(db, tx, """
            select k.version from public.site_recovery_rebind r join public.site_recovery_key k using (user_id)
            where r.user_id=$1 and r.generation=$2 and r.ticket_digest=$3 and r.completed_at is null
            and r.expires_at>clock_timestamp() and k.used_at is null
            and (k.failed_count<8 or k.failure_until<=clock_timestamp()) for update of r,k
            """, actor.Id, actor.Generation, proof);
        return await query.ExecuteScalarAsync(ct) is long version ? version : throw Denied();
    }

    private static async Task EnterPasskeyRecovery(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, CancellationToken ct)
    {
        foreach (var statement in new[]
        {
            "delete from public.login_ticket where user_id=$1",
            "delete from public.passkey_challenge where user_id=$1",
            "delete from public.mfa_flow where user_id=$1",
            "delete from public.site_recovery_flow where user_id=$1",
        }) await RecoveryExecute(db, tx, ct, statement, owner);
        await RecoveryWrite(db, tx, ct, "update public.blog_user set generation=generation+1 where id=$1", owner);
    }
}
