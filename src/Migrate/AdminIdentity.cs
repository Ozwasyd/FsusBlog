using System.Data;
using System.Security.Cryptography;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task AdminIdentityAsync(NpgsqlConnection connection, string[] arguments, CancellationToken ct)
    {
        if (arguments is ["schema"])
        {
            await InitializeAdminIdentityAsync(connection, ct);
            return;
        }

        (string action, string handle) = arguments switch
        {
            ["bootstrap", var name, CurrentSchema.AdminManagePermission] => ("bootstrap", name),
            ["rotate-passkey" or "revoke-all" or "disable", var name] => (arguments[0], name),
            _ => throw new ArgumentException("Use admin-identity schema, bootstrap HANDLE admin.manage, rotate-passkey HANDLE, revoke-all HANDLE, or disable HANDLE.")
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
            await RunAsync("insert into public.admin_permission(principal_id,permission) values($1,$2)", principal,
                CurrentSchema.AdminManagePermission);
        }
        else
        {
            await using var advance = Command("""
                update public.admin_principal set generation=generation+1,generation_changed_at=pg_catalog.clock_timestamp(),enabled=$2
                where handle=$1 and enabled
                returning id,generation
                """, handle, action != "disable");
            await using (var row = await advance.ExecuteReaderAsync(ct))
            {
                if (!await row.ReadAsync(ct)) throw new InvalidOperationException("Enabled administrator principal not found.");
                (principal, generation) = (row.GetGuid(0), row.GetInt64(1));
            }

            await RunAsync("delete from public.admin_session where principal_id=$1", principal);
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
            Console.WriteLine(action == "disable" ? "Disabled administrator principal." : "Revoked administrator sessions and invitations.");
        }

        NpgsqlCommand Command(string sql, params object[] values)
        {
            var command = new NpgsqlCommand(sql, connection, tx);
            foreach (var value in values) command.Parameters.Add(new NpgsqlParameter { Value = value });
            return command;
        }

        async Task RunAsync(string sql, params object[] values)
        {
            await using var command = Command(sql, values);
            await command.ExecuteNonQueryAsync(ct);
        }
    }

    private static async Task InitializeAdminIdentityAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var hasRecoveryScope = await HasRelation(connection, tx, "public.authoring_recovery_site", ct);
        var hasRevisionHistory = await HasRelation(connection, tx, "public.article_rollback", ct);
        var hasArticleSchedule = await HasRelation(connection, tx, CurrentSchema.ArticleScheduleRelation, ct);
        var hasPublicationHistory = await HasRelation(connection, tx, CurrentSchema.PublicationHistoryRelation, ct);
        if (!await HasRelation(connection, tx, CurrentSchema.AdminIdentityMarker, ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope, hasRevisionHistory,
                requireAdminIdentity: false, requirePublicationHistory: hasPublicationHistory,
                requireArticleSchedule: hasArticleSchedule);
            await ApplySchemaAddition(connection, tx, "admin-identity.sql", ct);
        }

        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope, hasRevisionHistory,
            requirePublicationHistory: hasPublicationHistory, requireArticleSchedule: hasArticleSchedule);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        if (hasRecoveryScope) await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified independent administrator identity schema.");
    }
}
