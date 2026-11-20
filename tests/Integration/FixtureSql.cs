using System.Security.Cryptography;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Integration.Tests;

internal static class FixtureSql
{
    internal static async Task<(Guid Id, string Token, byte[] Digest)> AdminAsync(NpgsqlConnection db, CancellationToken ct,
        string handle, int minutes, byte[] credential, byte[] key)
    {
        var id = Guid.NewGuid();
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var digest = Store.TokenDigest(token)!;
        await ExecuteAsync(db, null, ct, AdminSessionSql, AdminSessionArguments(id, handle,
            RandomNumberGenerator.GetBytes(32), credential, key, digest, minutes));
        return (id, token, digest);
    }

    internal static Task<int> AdminPrincipalAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        Guid id, string handle, bool enabled = true, long generation = 1) => ExecuteAsync(db, tx, ct, """
            insert into public.admin_principal(id,handle,user_handle,enabled,generation) values($1,$2,$3,$4,$5)
            """, id, handle, RandomNumberGenerator.GetBytes(32), enabled, generation);

    internal const string AdminSessionSql = """
            with principal as (
                insert into public.admin_principal(id,handle,user_handle,enabled,generation)
                values($1,$2,$3,true,1) returning id
            ), credential as (
                insert into public.admin_passkey_credential(credential_id,principal_id,public_key,sign_count,backup_eligible,backed_up)
                select $4,id,$5,0,false,false from principal
            )
            insert into public.admin_session(digest,principal_id,generation,expires_at)
            select $6,id,1,clock_timestamp()+$7*interval '1 minute' from principal
            """;

    internal static object[] AdminSessionArguments(Guid id, string handle, byte[] userHandle, byte[] credential,
        byte[] key, byte[] digest, int minutes) =>
        [id, handle, userHandle, credential, key, digest, minutes];

    internal static Task<int> SiteAccountAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        Guid id, string name, bool canAuthor = false, bool enabled = true) => ExecuteAsync(db, tx, ct, """
            insert into public.blog_user(id,name,enabled,generation) values($1,$2,$3,1)
            """, id, name, enabled);

    internal static Task<int> SitePasskeySubjectAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, Guid account) =>
        ExecuteAsync(db, tx, ct, "insert into public.passkey_subject(user_id,user_handle) values($1,$2)",
            account, RandomNumberGenerator.GetBytes(32));

    internal static async Task SitePasskeyAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        Guid account, byte[] credential, byte[] key)
    {
        await SitePasskeySubjectAsync(db, tx, ct, account);
        await ExecuteAsync(db, tx, ct, """
            insert into public.passkey_credential(credential_id,user_id,public_key,sign_count,backup_eligible,backed_up)
            values($1,$2,$3,0,false,false)
            """, credential, account, key);
    }

    internal static async Task<(string Token, string Id, byte[] Digest)> SiteSessionAsync(NpgsqlConnection db,
        Guid account, DateTimeOffset expiry, CancellationToken ct, long generation, byte[]? credential, bool mfa = false)
    {
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var digest = Store.TokenDigest(token)!;
        var passkey = new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bytea, Value = (object?)credential ?? DBNull.Value };
        await ExecuteAsync(db, null, ct, """
            insert into public.user_session(digest,user_id,generation,expires_at,passkey_credential_id,totp_verified_at)
            values($1,$2,$3,$4,$5,case when $6 then clock_timestamp() else null end)
            """, digest, account, generation, expiry, passkey, mfa);
        return (token, SiteSessions.Id(account, digest), digest);
    }

    internal static async Task<int> ExecuteAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string sql, params object[] arguments)
    {
        await using var command = Store.Sql(db, tx, sql, arguments);
        return await command.ExecuteNonQueryAsync(ct);
    }

    internal static async Task<string> IssueLoginTicketAsync(NpgsqlConnection db, NpgsqlTransaction? tx,
        CancellationToken ct, Guid account, int minutes = 2)
    {
        var secret = RandomNumberGenerator.GetBytes(32);
        await ExecuteAsync(db, tx, ct, """
            insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+make_interval(mins => $3))
            """, SHA256.HashData(secret), account, minutes);
        return Convert.ToHexStringLower(secret);
    }

    internal static async Task<object?> ScalarAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string sql, params object[] arguments)
    {
        await using var command = Store.Sql(db, tx, sql, arguments);
        return await command.ExecuteScalarAsync(ct);
    }
}
