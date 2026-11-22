using System.Security.Cryptography;
using Fido2NetLib;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Operations;
using Npgsql;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed partial class PasskeyStore
{
    private sealed record RecoveryAccount(Guid Id, long Generation, byte[] Handle);

    internal async Task<string> VerifySiteRecoveryKey(RecoveryKeySecret secret, string key,
        Func<NpgsqlConnection, NpgsqlTransaction, Task> consumePow, CancellationToken ct)
    {
        var lookup = secret.Lookup(key);
        await using var db = await _source.OpenConnectionAsync(ct);
        // Spend the anonymous proof before running its protected operation, including failed guesses.
        await using (var proof = await InstanceLease.BeginProtected(db, _lease, ct))
        {
            await consumePow(db, proof);
            await InstanceLease.CommitProtected(proof, _lease, ct);
        }

        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        Guid account;
        long generation;
        await using (var select = Store.Sql(db, tx, """
            select u.id,u.generation from public.blog_user u where u.enabled and u.id=(
                select user_id from public.site_recovery_key where lookup_digest=$1 and used_at is null
            ) for update of u
            """, lookup))
        await using (var row = await select.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Denied();
            (account, generation) = (row.GetGuid(0), row.GetInt64(1));
        }
        byte[] salt, verifier;
        await using (var select = Store.Sql(db, tx, """
            select salt,verifier from public.site_recovery_key where user_id=$1 and lookup_digest=$2
                and used_at is null and (failed_count<8 or failure_until<=clock_timestamp()) for update
            """, account, lookup))
        await using (var row = await select.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Denied();
            (salt, verifier) = (row.GetFieldValue<byte[]>(0), row.GetFieldValue<byte[]>(1));
        }
        if (!secret.Verify(key, salt, verifier))
        {
            await RecoveryWrite(db, tx, ct, """
                update public.site_recovery_key set
                    failed_count=case when failure_until<=clock_timestamp() then 1 else failed_count+1 end,
                    failure_until=case when failure_until<=clock_timestamp()
                        then clock_timestamp()+interval '10 minutes' else failure_until end
                where user_id=$1
                """, account);
            await InstanceLease.CommitProtected(tx, _lease, ct);
            throw Denied();
        }
        var ticket = NewToken();
        await RecoveryWrite(db, tx, ct, """
            update public.site_recovery_key set failed_count=0, failure_until=clock_timestamp()
            where user_id=$1 and used_at is null
            """, account);
        await RecoveryWrite(db, tx, ct, """
            insert into public.site_recovery_rebind as pending(user_id,generation,ticket_digest,expires_at)
            values($1,$2,$3,clock_timestamp()+interval '10 minutes')
            on conflict(user_id) do update set generation=excluded.generation,ticket_digest=excluded.ticket_digest,
                expires_at=case when pending.generation=excluded.generation and pending.completed_at is null
                    and pending.expires_at>clock_timestamp() then pending.expires_at else excluded.expires_at end,
                challenge_digest=null,options=null,challenge_expires_at=null,
                request_digest=null,completed_at=null
            """, account, generation, TokenDigest(ticket));
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return ticket;
    }

    internal async Task<byte[]> BeginRecoveryRebind(string? ticket, CancellationToken ct)
    {
        var digest = RecoveryTokenDigest(ticket) ?? throw Denied();
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var account = await LockRecoveryAccount(db, tx, digest, ct);
        var options = _verifier.RequestRegistration(account.Handle);
        var challenge = NewToken();
        await RecoveryWrite(db, tx, ct, """
            update public.site_recovery_rebind set challenge_digest=$3,options=$4,
                challenge_expires_at=least(expires_at,clock_timestamp()+interval '2 minutes')
            where user_id=$1 and ticket_digest=$2 and generation=$5 and completed_at is null and expires_at>clock_timestamp()
            """, account.Id, digest, TokenDigest(challenge), options.ToJson(), account.Generation);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return options.RegistrationFrame(challenge);
    }

    internal async Task CompleteRecoveryRebind(string? ticket, PasskeyProvisionRequest request, byte[] requestDigest,
        CancellationToken ct)
    {
        var digest = RecoveryTokenDigest(ticket) ?? throw Denied();
        CheckId(request.CredentialId, request.RawId);
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var account = await LockRecoveryAccount(db, tx, digest, ct);
        string? options = null;
        await using (var select = Store.Sql(db, tx, """
            select generation,request_digest,case when challenge_digest=$3 and challenge_expires_at>clock_timestamp()
                then options end
            from public.site_recovery_rebind
            where user_id=$1 and ticket_digest=$2 and expires_at>clock_timestamp() for update
            """, account.Id, digest, TokenDigest(request.Token)))
        await using (var row = await select.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Denied();
            var generation = row.GetInt64(0);
            if (!row.IsDBNull(1))
            {
                if (account.Generation != generation + 1 ||
                    !CryptographicOperations.FixedTimeEquals(row.GetFieldValue<byte[]>(1), requestDigest)) throw Denied();
            }
            else
            {
                if (generation != account.Generation || row.IsDBNull(2)) throw Denied();
                options = row.GetString(2);
            }
        }
        if (options is null)
        {
            await InstanceLease.CommitProtected(tx, _lease, ct);
            return;
        }
        var registration = CredentialCreateOptions.FromJson(options);
        if (!CryptographicOperations.FixedTimeEquals(registration.User.Id, account.Handle)) throw Denied();

        // Insert before deleting old credentials so an existing credential ID cannot be registered as new.
        var replacementId = await RegisterCredential(db, tx, account.Id, request, registration, ct);
        await RecoveryExecute(db, tx, ct, "delete from public.user_session where user_id=$1", account.Id);
        await RecoveryExecute(db, tx, ct, "delete from public.passkey_credential where user_id=$1 and credential_id<>$2",
            account.Id, replacementId);
        await RecoveryExecute(db, tx, ct, "delete from public.login_ticket where user_id=$1", account.Id);
        await RecoveryExecute(db, tx, ct, "delete from public.passkey_challenge where user_id=$1", account.Id);
        await RecoveryExecute(db, tx, ct, "delete from public.mfa_flow where user_id=$1", account.Id);
        await RecoveryExecute(db, tx, ct, "delete from public.site_recovery_flow where user_id=$1", account.Id);
        await RecoveryWrite(db, tx, ct, """
            update public.site_recovery_key set used_at=clock_timestamp() where user_id=$1 and used_at is null
            """, account.Id);
        await RecoveryWrite(db, tx, ct, "update public.blog_user set generation=generation+1 where id=$1", account.Id);
        await RecoveryWrite(db, tx, ct, """
            update public.site_recovery_rebind set challenge_digest=null,options=null,challenge_expires_at=null,
                request_digest=$3,completed_at=clock_timestamp()
            where user_id=$1 and ticket_digest=$2 and expires_at>clock_timestamp() and challenge_expires_at>clock_timestamp()
            """, account.Id, digest, requestDigest);
        await InstanceLease.CommitProtected(tx, _lease, ct);
    }

    private static async Task<RecoveryAccount> LockRecoveryAccount(NpgsqlConnection db, NpgsqlTransaction tx, byte[] digest,
        CancellationToken ct)
    {
        await using var select = Store.Sql(db, tx, """
            select u.id,u.generation,p.user_handle from public.blog_user u
            join public.passkey_subject p on p.user_id=u.id where u.enabled and u.id=(
                select user_id from public.site_recovery_rebind where ticket_digest=$1 and expires_at>clock_timestamp()
            ) for update of u
            """, digest);
        await using var row = await select.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw Denied();
        return new(row.GetGuid(0), row.GetInt64(1), row.GetFieldValue<byte[]>(2));
    }

    private static async Task RecoveryWrite(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct,
        string sql, params object[] parameters)
    {
        if (await RecoveryExecute(db, tx, ct, sql, parameters) != 1) throw Denied();
    }

    private static async Task<int> RecoveryExecute(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct,
        string sql, params object[] parameters)
    {
        return await SqlCommands.Execute(db, tx, ct, sql, parameters);
    }
}
