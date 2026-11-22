using System.Security.Cryptography;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Cli
{
    private static async Task AdminIdentityAsync(NpgsqlConnection connection, string[] arguments, CancellationToken ct)
    {
        var (action, handle) = arguments switch
        {
            ["bootstrap" or "rotate-passkey" or "revoke-all" or "disable", var name] => (arguments[0], name),
            _ => throw new ArgumentException("Use admin-identity bootstrap HANDLE, rotate-passkey HANDLE, revoke-all HANDLE, or disable HANDLE.")
        };
        if (handle.Length is < 1 or > 64 || !char.IsAsciiLetterLower(handle[0]) ||
            !handle.All(c => char.IsAsciiLetterLower(c) || char.IsAsciiDigit(c) || c is '_' or '-' or '.'))
            throw new ArgumentException("Use a lowercase administrator handle of up to 64 ASCII letters, digits, dots, underscores or hyphens, starting with a letter.");

        await CurrentSchema.VerifyAsync(connection, ct);
        await using var tx = await connection.BeginTransactionAsync(ct);
        await ExecuteAsync(connection, tx, "SET LOCAL search_path TO pg_catalog", ct);
        await using (var replication = new NpgsqlCommand("show session_replication_role", connection, tx))
            if (await replication.ExecuteScalarAsync(ct) is not "origin")
                throw new InvalidOperationException("Administrator identity requires ordinary integrity triggers.");

        Guid principal;
        long generation;
        if (action == "bootstrap")
        {
            principal = Guid.NewGuid();
            generation = 1;
            await RunAsync("""
                insert into public.admin_principal(id,handle,user_handle,enabled,generation) values($1,$2,$3,true,1)
                """, principal, handle, RandomNumberGenerator.GetBytes(32));
        }
        else
        {
            await using (var actor = ParameterizedCommand(connection, tx, "select id from public.admin_principal where handle=$1 and enabled for update", handle))
            {
                if (await actor.ExecuteScalarAsync(ct) is not Guid id)
                    throw new InvalidOperationException("Enabled administrator principal not found.");
                principal = id;
            }

            await using (var advance = ParameterizedCommand(connection, tx, """
                update public.admin_principal set generation=generation+1,generation_changed_at=pg_catalog.clock_timestamp(),enabled=$2
                where id=$1 returning generation
                """, principal, action != "disable"))
                generation = (long)(await advance.ExecuteScalarAsync(ct))!;

            await AdminSignInHistory.RetireAsync(connection, tx, principal, null, ct);
            await RunAsync("delete from public.admin_invitation where principal_id=$1", principal);
            await RunAsync("delete from public.admin_challenge where principal_id=$1", principal);
            if (action is "rotate-passkey" or "disable")
                await RunAsync("delete from public.admin_passkey_credential where principal_id=$1", principal);
        }

        await RunAsync("""
            insert into public.admin_identity_audit(principal_id,action,happened_at,actor)
            values($1,$2,pg_catalog.clock_timestamp(),session_user::text)
            """, principal, action);

        if (action is "bootstrap" or "rotate-passkey")
        {
            var secret = RandomNumberGenerator.GetBytes(32);
            try
            {
                await RunAsync("""
                    insert into public.admin_invitation(digest,principal_id,generation,expires_at)
                    values($1,$2,$3,pg_catalog.clock_timestamp()+interval '10 minutes')
                    """, SHA256.HashData(secret), principal, generation);
                await tx.CommitAsync(ct);
                Console.WriteLine(Convert.ToHexStringLower(secret));
            }
            finally { CryptographicOperations.ZeroMemory(secret); }
        }
        else
        {
            await tx.CommitAsync(ct);
            Console.WriteLine(action == "disable"
                ? "Disabled administrator principal."
                : "Revoked administrator sessions and invitations.");
        }

        async Task<int> RunAsync(string sql, params object[] values)
        {
            await using var command = ParameterizedCommand(connection, tx, sql, values);
            return await command.ExecuteNonQueryAsync(ct);
        }
    }
}
