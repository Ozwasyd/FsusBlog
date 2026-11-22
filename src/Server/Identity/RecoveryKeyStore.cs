using FsusBlogV2.Storage;
using Fido2NetLib;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Operations;
using Npgsql;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed partial class PasskeyStore
{
    private const short RecoveryAssertion = 1;
    private const short RecoveryProof = 2;

    internal async Task<bool> RecoveryKeyStatus(string? session, CancellationToken ct)
    {
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var actor = await MfaStore.RequireSession(db, tx, session, ct);
        var active = await SqlCommands.Scalar(db, tx, ct, "select exists (select from public.site_recovery_key where user_id=$1 and used_at is null)", actor.Id) is true;
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return active;
    }

    internal async Task<byte[]> BeginRecoveryKeyStepUp(string? session, RecoveryKeyOperation operation, CancellationToken ct)
    {
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var actor = await MfaStore.RequireSession(db, tx, session, ct);
        var (options, ids) = await RestrictedAssertion(db, tx, actor.Id, ct);
        var token = await SaveRecoveryFlow(db, tx, actor, (short)operation.Operation, RecoveryAssertion, options.ToJson(), 120, ct);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return PasskeyWire.LoginBegin(token, checked((uint)options.Timeout), options.RpId!, options.Challenge, ids);
    }

    internal async Task<byte[]> CompleteRecoveryKeyStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct)
    {
        if (request.RememberMe) throw Denied();
        CheckId(request.CredentialId, request.RawId);
        await using var db = await _source.OpenConnectionAsync(ct);
        MfaStore.Subject original;
        short operation;
        string options;
        await using (var consume = await InstanceLease.BeginProtected(db, _lease, ct))
        {
            original = await MfaStore.RequireSession(db, consume, session, ct);
            await using (var select = Store.Sql(db, consume, """
                delete from public.site_recovery_flow
                where digest=$1 and user_id=$2 and generation=$3 and session_digest=$4 and kind=$5
                    and expires_at>clock_timestamp()
                returning purpose,options
                """, MfaStore.FlowDigest(request.Token), original.Id, original.Generation, original.Scope, RecoveryAssertion))
            await using (var row = await select.ExecuteReaderAsync(ct))
            {
                await row.ReadRequired(ct, Denied);
                (operation, options) = (row.GetInt16(0), row.GetString(1));
            }
            await InstanceLease.CommitProtected(consume, _lease, ct);
        }

        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var current = await MfaStore.RequireSession(db, tx, session, ct);
        if (current.Id != original.Id || current.Generation != original.Generation ||
            !current.Scope.AsSpan().SequenceEqual(original.Scope)) throw Denied();
        await VerifyAssertion(db, tx, request, current.Id, AssertionOptions.FromJson(options), requireHandle: false, ct);
        var proof = await SaveRecoveryFlow(db, tx, current, operation, RecoveryProof, null, 45, ct);
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return MfaWire.EncodeChallenge(true, operation == 1 ? "recovery-key.create" : "recovery-key.rotate", proof);
    }

    internal async Task<RecoveryKeyIssued> IssueRecoveryKey(RecoveryKeySecret secret, string? session,
        RecoveryKeyOperation operation, string? proof, CancellationToken ct)
    {
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        var actor = await MfaStore.RequireSession(db, tx, session, ct);
        if (RecoveryTokenDigest(proof) is not { } proofDigest) throw new RecoveryKeyProofRequiredException();
        if (await SqlCommands.Execute(db, tx, ct, """
            delete from public.site_recovery_flow
            where digest=$1 and user_id=$2 and generation=$3 and session_digest=$4 and purpose=$5 and kind=$6
                and expires_at>clock_timestamp()
            """, proofDigest, actor.Id, actor.Generation, actor.Scope, (short)operation.Operation, RecoveryProof) != 1)
            throw new RecoveryKeyProofRequiredException();
        if (await SqlCommands.Scalar(db, tx, ct, """
            select not exists (
                select from public.site_recovery_rebind where user_id=$1 and generation=$2
                    and expires_at>clock_timestamp() and completed_at is null
            ) and (
                $3 or not exists (select from public.site_recovery_key where user_id=$1 and used_at is null)
            )
            """, actor.Id, actor.Generation, operation.Operation == 2) is not true)
            throw new BusinessException(Rejection.Conflict, "A current key or recovery ceremony already exists.");
        var key = secret.Generate();
        RecoveryKeyIssued receipt;
        await using (var insert = Store.Sql(db, tx, """
            insert into public.site_recovery_key as existing
                (user_id,lookup_digest,salt,verifier,version,created_at,failed_count)
            values ($1,$2,$3,$4,1,clock_timestamp(),0)
            on conflict (user_id) do update set lookup_digest=excluded.lookup_digest, salt=excluded.salt,
                verifier=excluded.verifier,version=existing.version+1,created_at=excluded.created_at,used_at=null,
                failed_count=0,failure_until=clock_timestamp()
            returning version,created_at
            """, actor.Id, key.Lookup, key.Salt, key.Verifier))
        await using (var row = await insert.ExecuteReaderAsync(ct))
        {
            await row.ReadAsync(ct);
            receipt = new(key.Key, row.GetInt64(0), row.GetUnixMilliseconds(1));
        }
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return receipt;
    }

    private static async Task<string> SaveRecoveryFlow(NpgsqlConnection db, NpgsqlTransaction tx, MfaStore.Subject actor,
        short purpose, short kind, string? options, int seconds, CancellationToken ct)
    {
        var token = NewToken();
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.site_recovery_flow(digest,user_id,generation,session_digest,purpose,kind,options,expires_at)
            values($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8 * interval '1 second')
            on conflict(user_id,purpose,kind) do update set digest=excluded.digest,generation=excluded.generation,
                session_digest=excluded.session_digest,options=excluded.options,expires_at=excluded.expires_at
            """, TokenDigest(token), actor.Id, actor.Generation, actor.Scope, purpose, kind,
            SqlCommands.Optional(NpgsqlTypes.NpgsqlDbType.Text, options), seconds);
        return token;
    }

    private static byte[]? RecoveryTokenDigest(string? token) => token is { Length: 43 } &&
        token.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_') ? TokenDigest(token) : null;
}

internal sealed class RecoveryKeyProofRequiredException : Exception;
