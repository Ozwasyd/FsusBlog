using System.Buffers.Binary;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminEffectivePermissionsPostgresTests
{
    [PostgresFact]
    public async Task ReturnsOnlyTheCurrentIndependentPrincipalsEffectiveGrants()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = timeout.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var store = new AdminPasskeyStore(fixture.DataSource, null, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        var publications = new Publications(fixture.DataSource, new WebPages("<!--fsus-public-content-->"), NullLogger<Publications>.Instance);
        var (owner, firstToken) = await Add("first", CurrentSchema.CommentModeratePermission, CurrentSchema.ArticleWritePermission);
        var (other, secondToken) = await Add("second", CurrentSchema.SystemConfigPermission);

        var snapshot = await store.SessionWithPermissionBinding(firstToken, ct);
        var observed = await store.EffectivePermissions(firstToken, ct);
        Assert.Equal(snapshot.Snapshot.Generation, observed.Permissions.Generation);
        Assert.Equal(snapshot.PermissionSession, observed.PermissionSession);
        Assert.Matches("^[a-f0-9]{64}$", observed.PermissionSession);
        Assert.Equal(new[] { "admin.manage", "article.write", "comment.moderate" }, observed.Permissions.Grants);
        Assert.NotEqual(firstToken, observed.PermissionSession);
        var packet = Wire.EncodeAdminEffectivePermissions(observed.Permissions);
        var payload = Aeds.Decode(packet, FrameType.AdminEffectivePermissions).ToArray();
        Assert.Equal(1L, BinaryPrimitives.ReadInt64LittleEndian(payload));
        Assert.Equal(3, BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(8)));
        Assert.Throws<ProtocolException>(() => Wire.EncodeAdminEffectivePermissions(new(1, ["admin.manage", "audit.investigate"])));
        Assert.Throws<ProtocolException>(() => Wire.EncodeAdminEffectivePermissions(new(1, ["admin.manage", "admin.manage"])));

        var sibling = await store.EffectivePermissions(secondToken, ct);
        Assert.Equal(observed.Permissions.Generation, sibling.Permissions.Generation);
        Assert.NotEqual(observed.PermissionSession, sibling.PermissionSession);
        Assert.Equal(new[] { "admin.manage", "system.config" }, sibling.Permissions.Grants);
        await Denied(() => store.OperationsStatus(firstToken, publications, ct), Rejection.Forbidden);
        await Denied(() => store.EffectivePermissions(null, ct));

        // The offline authorization operation advances the principal generation and retires its sessions.
        var newToken = NewToken();
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            await ExecuteIn(tx, "update public.admin_principal set generation=generation+1 where id=$1", owner);
            await ExecuteIn(tx, "delete from public.admin_session where principal_id=$1", owner);
            await ExecuteIn(tx, "delete from public.admin_permission where principal_id=$1 and permission=$2", owner,
                CurrentSchema.CommentModeratePermission);
            await ExecuteIn(tx, "insert into public.admin_permission(principal_id,permission) values($1,$2)", owner,
                CurrentSchema.AuditReadPermission);
            await ExecuteIn(tx, """
                insert into public.admin_session(digest,principal_id,generation,expires_at)
                    values($2,$1,2,clock_timestamp()+interval '10 minutes')
                """, owner, Store.TokenDigest(newToken)!);
            await tx.CommitAsync(ct);
        }
        await Denied(() => store.EffectivePermissions(firstToken, ct));
        var renewed = await store.EffectivePermissions(newToken, ct);
        Assert.Equal(2L, renewed.Permissions.Generation);
        Assert.NotEqual(snapshot.PermissionSession, renewed.PermissionSession);
        Assert.Equal(new[] { "admin.manage", "article.write", "audit.read" }, renewed.Permissions.Grants);
        await store.OperationsStatus(newToken, publications, ct);
        await Denied(() => store.CommentQueue(newToken, Microsoft.AspNetCore.Http.QueryCollection.Empty, ct), Rejection.Forbidden);
        Assert.Equal(sibling.PermissionSession, (await store.EffectivePermissions(secondToken, ct)).PermissionSession);
        await Execute("update public.admin_principal set enabled=false where id=$1", other);
        await Denied(() => store.EffectivePermissions(secondToken, ct));

        async Task<(Guid Id, string Token)> Add(string handle, params string[] grants)
        {
            var principal = Guid.NewGuid();
            var token = NewToken();
            await Execute("insert into public.admin_principal(id,handle,user_handle,enabled,generation) values($1,$2,$3,true,1)",
                principal, handle, RandomNumberGenerator.GetBytes(32));
            await Execute("insert into public.admin_passkey_credential values($1,$2,$3,0,false,false)",
                RandomNumberGenerator.GetBytes(32), principal, new byte[] { 1 });
            foreach (var grant in grants.Prepend(CurrentSchema.AdminManagePermission))
                await Execute("insert into public.admin_permission values($1,$2)", principal, grant);
            await Execute("insert into public.admin_session values($1,$2,1,clock_timestamp()+interval '10 minutes')",
                Store.TokenDigest(token)!, principal);
            return (principal, token);
        }

        Task Execute(string sql, params object[] args) => ExecuteIn(null, sql, args);

        async Task ExecuteIn(Npgsql.NpgsqlTransaction? transaction, string sql, params object[] args)
        {
            await using var cmd = Store.Sql(db, transaction, sql, args);
            await cmd.ExecuteNonQueryAsync(ct);
        }
    }

    private static string NewToken() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    private static async Task Denied(Func<Task> action, Rejection reason = Rejection.Unauthorized) =>
        Assert.Equal(reason, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);
}
