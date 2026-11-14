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

        (string action, string handle, string? permission) = arguments switch
        {
            ["bootstrap", var name, CurrentSchema.AdminManagePermission] => ("bootstrap", name, null),
            ["grant" or "revoke", var name, CurrentSchema.AuditReadPermission or CurrentSchema.CommentModeratePermission
                or CurrentSchema.ArticleWritePermission] =>
                (arguments[0], name, arguments[2]),
            ["rotate-passkey" or "revoke-all" or "disable", var name] => (arguments[0], name, null),
            _ => throw new ArgumentException("Use admin-identity schema, bootstrap HANDLE admin.manage, grant|revoke HANDLE audit.read|comment.moderate|article.write, rotate-passkey HANDLE, revoke-all HANDLE, or disable HANDLE.")
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
            await using (var actor = Command("select id from public.admin_principal where handle=$1 and enabled for update", handle))
            {
                if (await actor.ExecuteScalarAsync(ct) is not Guid id)
                    throw new InvalidOperationException("Enabled administrator principal not found.");
                principal = id;
            }

            if (permission is not null)
            {
                var changed = action == "grant"
                    ? await RunAsync("insert into public.admin_permission(principal_id,permission) values($1,$2) on conflict do nothing",
                        principal, permission)
                    : await RunAsync("delete from public.admin_permission where principal_id=$1 and permission=$2",
                        principal, permission);
                if (changed == 0)
                {
                    await tx.CommitAsync(ct);
                    Console.WriteLine("Administrator permissions unchanged.");
                    return;
                }
            }

            await using (var advance = Command("""
                update public.admin_principal set generation=generation+1,generation_changed_at=pg_catalog.clock_timestamp(),enabled=$2
                where id=$1 returning generation
                """, principal, action != "disable"))
                generation = (long)(await advance.ExecuteScalarAsync(ct))!;

            await RunAsync("delete from public.admin_session where principal_id=$1", principal);
            await RunAsync("delete from public.admin_invitation where principal_id=$1", principal);
            await RunAsync("delete from public.admin_challenge where principal_id=$1", principal);
            if (action is "rotate-passkey" or "disable")
                await RunAsync("delete from public.admin_passkey_credential where principal_id=$1", principal);
        }

        await RunAsync("""
            insert into public.admin_identity_audit(principal_id,action,happened_at,actor)
            values($1,$2,pg_catalog.clock_timestamp(),session_user::text)
            """, principal, permission is null ? action : $"{action}:{permission}");

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
            Console.WriteLine(action switch
            {
                "disable" => "Disabled administrator principal.",
                "grant" => $"Granted {permission} and revoked prior administrator sessions and invitations.",
                "revoke" => $"Revoked {permission} and prior administrator sessions and invitations.",
                _ => "Revoked administrator sessions and invitations."
            });
        }

        NpgsqlCommand Command(string sql, params object[] values)
        {
            var command = new NpgsqlCommand(sql, connection, tx);
            foreach (var value in values) command.Parameters.Add(new NpgsqlParameter { Value = value });
            return command;
        }

        async Task<int> RunAsync(string sql, params object[] values)
        {
            await using var command = Command(sql, values);
            return await command.ExecuteNonQueryAsync(ct);
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
        var hasMediaUpload = await HasRelation(connection, tx, CurrentSchema.MediaUploadRelation, ct);
        var hasCanvasNode = await HasRelation(connection, tx, "public.canvas_node", ct);
        var hasCanvasEvent = await HasRelation(connection, tx, "public.canvas_document_event", ct);
        var hasCanvasHistory = await HasRelation(connection, tx, "public.canvas_history_patch", ct);
        var hasCanvasTransition = await HasRelation(connection, tx, "public.canvas_history_transition", ct);
        if (hasCanvasNode != hasCanvasEvent || hasCanvasHistory != hasCanvasTransition || hasCanvasHistory && !hasCanvasNode)
            throw new InvalidOperationException("The Canvas schema matches neither exact supported layout.");
        var legacyCanvas = !hasCanvasNode;
        var hasPublicationRights = await HasRelation(connection, tx, CurrentSchema.PublicationRightsRelation, ct);
        if (!await HasRelation(connection, tx, CurrentSchema.AdminIdentityMarker, ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope, hasRevisionHistory,
                requireAdminIdentity: false, requirePublicationHistory: hasPublicationHistory,
                requireArticleSchedule: hasArticleSchedule, requireMediaUpload: hasMediaUpload, legacyCanvas: legacyCanvas,
                requirePublicationRights: hasPublicationRights, requireCanvasHistory: hasCanvasHistory);
            await ApplySchemaAddition(connection, tx, "admin-identity.sql", ct);
            await ApplySchemaAddition(connection, tx, "admin-step-up.sql", ct);
        }
        else if (await CurrentSchema.ReadAdminIdentityVersionAsync(connection, tx, ct) is (1 or 2 or 3 or 4) and var previousVersion)
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope, hasRevisionHistory,
                requirePublicationHistory: hasPublicationHistory, requireArticleSchedule: hasArticleSchedule,
                requireMediaUpload: hasMediaUpload, legacyCanvas: legacyCanvas, adminIdentityVersion: previousVersion,
                requirePublicationRights: hasPublicationRights, requireCanvasHistory: hasCanvasHistory);
            if (previousVersion < 4)
                await ExecuteAsync(connection, tx, """
                    alter table public.admin_permission drop constraint admin_permission_permission_check;
                    alter table public.admin_permission add constraint admin_permission_permission_check
                        check (permission = 'admin.manage' or permission = 'audit.read' or permission = 'comment.moderate' or permission = 'article.write');
                    """, ct);
            await ApplySchemaAddition(connection, tx, "admin-step-up.sql", ct);
            await ExecuteAsync(connection, tx, """
                alter table public.admin_identity_schema drop constraint admin_identity_schema_version_check;
                update public.admin_identity_schema set version=5 where singleton and version in (1,2,3,4);
                alter table public.admin_identity_schema add constraint admin_identity_schema_version_check check (version=5);
                """, ct);
        }

        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope, hasRevisionHistory,
            requirePublicationHistory: hasPublicationHistory, requireArticleSchedule: hasArticleSchedule,
            requireMediaUpload: hasMediaUpload, legacyCanvas: legacyCanvas,
            requirePublicationRights: hasPublicationRights, requireCanvasHistory: hasCanvasHistory);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        if (hasRecoveryScope) await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine($"Verified independent administrator identity schema version {CurrentSchema.AdminIdentityVersion}.");
    }
}
