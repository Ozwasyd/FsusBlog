using System.Security.Cryptography;
using FsusBlog.V2.Server;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

internal static class FixtureSql
{
    internal static async Task<(Guid Id, string Token, byte[] Digest)> AdminAsync(NpgsqlConnection db, CancellationToken ct,
        string handle, int minutes, byte[] credential, byte[] key, params string[] grants)
    {
        var id = Guid.NewGuid();
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        var digest = Store.TokenDigest(token)!;
        await ExecuteAsync(db, null, ct, """
            with principal as (
                insert into public.admin_principal(id,handle,user_handle,enabled,generation)
                values($1,$2,$3,true,1) returning id
            ), credential as (
                insert into public.admin_passkey_credential(credential_id,principal_id,public_key,sign_count,backup_eligible,backed_up)
                select $4,id,$5,0,false,false from principal
            ), permissions as (
                insert into public.admin_permission(principal_id,permission)
                select id,permission from principal cross join unnest($6::text[]) grants(permission)
            )
            insert into public.admin_session(digest,principal_id,generation,expires_at)
            select $7,id,1,clock_timestamp()+$8*interval '1 minute' from principal
            """, id, handle, RandomNumberGenerator.GetBytes(32), credential, key,
            grants.Prepend(CurrentSchema.AdminManagePermission).ToArray(), digest, minutes);
        return (id, token, digest);
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
