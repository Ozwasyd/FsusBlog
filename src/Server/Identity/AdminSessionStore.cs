using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Operations;
using Microsoft.AspNetCore.WebUtilities;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    private sealed record Principal(Guid Id, string Handle, byte[] UserHandle, long Generation, DateTimeOffset GenerationChangedAt);
    private sealed record Challenge(Guid? Principal, long? Generation, string Options, DateTimeOffset StartedAt);

    internal async Task<AdminSessionSnapshot> Session(string? token, CancellationToken ct)
    {
        var digest = Store.TokenDigest(token) ?? throw Denied();
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        AdminSessionSnapshot result;
        await using (var cmd = Store.Sql(db, tx, """
            select p.handle,p.generation,s.expires_at
            from public.admin_principal p join public.admin_session s on s.principal_id=p.id
            where s.digest=$1 and p.enabled and s.generation=p.generation and s.expires_at>clock_timestamp()
            and exists (select from public.admin_permission where principal_id=p.id and permission=$2)
            and exists (select from public.admin_passkey_credential where principal_id=p.id)
            for share of p,s
            """, digest, Permission))
        await using (var row = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Denied();
            result = new(row.GetString(0), row.GetInt64(1), row.GetFieldValue<DateTimeOffset>(2).ToUnixTimeMilliseconds());
        }
        if (result.ExpiresAt <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) throw Denied();
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return result;
    }

    internal async Task SignOut(string? token, CancellationToken ct)
    {
        if (Store.TokenDigest(token) is not { } digest) return;
        await using var db = await _source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        await Execute(db, tx, ct, "delete from public.admin_session where digest=$1", digest);
        await InstanceLease.CommitProtected(tx, _lease, ct);
    }

    private static async Task<Principal> BootstrapPrincipal(NpgsqlConnection db, NpgsqlTransaction tx, byte[] digest, CancellationToken ct)
    {
        var principal = await LockPrincipal(db, tx, """
            select principal_id from public.admin_invitation where digest=$1
            """, digest, ct);
        await using var check = Store.Sql(db, tx, """
            select exists(select from public.admin_invitation
                where digest=$1 and principal_id=$2 and generation=$3 and expires_at>clock_timestamp())
            and not exists(select from public.admin_passkey_credential where principal_id=$2)
            """, digest, principal.Id, principal.Generation);
        if (await check.ExecuteScalarAsync(ct) is not true) throw Denied();
        return principal;
    }

    private static async Task<Principal> LockPrincipal(NpgsqlConnection db, NpgsqlTransaction tx, string selector,
        byte[] digestOrCredential, CancellationToken ct)
    {
        Principal principal;
        await using (var cmd = Store.Sql(db, tx, """
            select id,handle,user_handle,generation,generation_changed_at from public.admin_principal where enabled and id=(
            """ + selector + ") for update", digestOrCredential))
        await using (var row = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Denied();
            principal = new(row.GetGuid(0), row.GetString(1), row.GetFieldValue<byte[]>(2), row.GetInt64(3), row.GetFieldValue<DateTimeOffset>(4));
        }
        await using var grant = Store.Sql(db, tx, """
            select exists (select from public.admin_permission where principal_id=$1 and permission=$2)
            """, principal.Id, Permission);
        if (await grant.ExecuteScalarAsync(ct) is not true) throw Denied();
        return principal;
    }

    private static async Task SaveChallenge(NpgsqlConnection db, NpgsqlTransaction tx, string token, byte[] binding, int kind,
        Principal? principal, string options, CancellationToken ct)
    {
        await Execute(db, tx, ct, "select pg_catalog.pg_advisory_xact_lock($1)", ChallengeLock);
        await Execute(db, tx, ct, "delete from public.admin_challenge where expires_at<=clock_timestamp() or principal_id=$1",
            Optional(NpgsqlDbType.Uuid, principal?.Id));
        await using var cmd = Store.Sql(db, tx, """
            insert into public.admin_challenge(digest,principal_id,generation,binding_digest,kind,options,expires_at,started_at)
            select $1,$2,$3,$4,$5,$6,statement_timestamp()+interval '2 minutes',statement_timestamp()
            where (select count(*) from public.admin_challenge)<$7
            """, ChallengeDigest(token, null), Optional(NpgsqlDbType.Uuid, principal?.Id), Optional(NpgsqlDbType.Bigint, principal?.Generation),
            binding, kind, options, ChallengeLimit);
        if (await cmd.ExecuteNonQueryAsync(ct) != 1) throw new PublicUnavailableException();
    }

    private async Task<Challenge> ConsumeChallenge(NpgsqlConnection db, string token, byte[] binding, int kind, CancellationToken ct)
    {
        await using var tx = await InstanceLease.BeginProtected(db, _lease, ct);
        Challenge result;
        await using (var cmd = Store.Sql(db, tx, """
            delete from public.admin_challenge where digest=$1 and binding_digest=$2 and kind=$3 and expires_at>clock_timestamp()
            returning principal_id,generation,options,started_at
            """, ChallengeDigest(token, null), binding, kind))
        await using (var row = await cmd.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw Denied();
            result = new(row.IsDBNull(0) ? null : row.GetGuid(0), row.IsDBNull(1) ? null : row.GetInt64(1), row.GetString(2),
                row.GetFieldValue<DateTimeOffset>(3));
        }
        await InstanceLease.CommitProtected(tx, _lease, ct);
        return result;
    }

    private static string Token() => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    private static byte[] ChallengeDigest(string? text, byte[]? ticket)
    {
        if (text is not { Length: 43 } || !text.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_')) throw Denied();
        Span<byte> bytes = stackalloc byte[43 + (ticket?.Length ?? 0)];
        Encoding.ASCII.GetBytes(text, bytes);
        if (ticket is not null) ticket.AsSpan().CopyTo(bytes[43..]);
        return SHA256.HashData(bytes);
    }

    private static void RequireCredentialId(string text, byte[] raw)
    {
        if (WebEncoders.Base64UrlEncode(raw) != text) throw Denied();
    }

    private static NpgsqlParameter Optional(NpgsqlDbType type, object? value) => new() { NpgsqlDbType = type, Value = value ?? DBNull.Value };

    private static async Task Execute(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct, string sql, params object[] parameters)
    {
        await using var cmd = Store.Sql(db, tx, sql, parameters);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    internal static BusinessException Denied() => new(Rejection.Unauthorized, "Administrator verification failed or expired.");
}
