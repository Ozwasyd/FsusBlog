using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Passkeys;
using FsusBlogV2.Storage;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminOperationsPostgresTests
{
    [PostgresFact]
    public async Task AuditPermissionKeepsActualPublicationStateInIndependentCurrentAdminSession()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var (admin, key, _) = await FixtureSql.AdminAsync(db, ct, "observer", 10, [1], [2]);
        var actor = Guid.NewGuid();

        var adminStore = new AdminPasskeyStore(fixture.DataSource, null, new PasskeyConfiguration(new Uri("http://localhost"), "localhost"));
        var publications = new Publications(fixture.DataSource, new WebPages("<!--fsus-public-content-->"), NullLogger<Publications>.Instance);
        await Denied(Rejection.Forbidden, () => adminStore.OperationsStatus(key, publications, ct));
        await Denied(Rejection.Unauthorized, () => adminStore.OperationsStatus(null, publications, ct));
        await Execute("insert into public.admin_permission values($1,$2)", admin, CurrentSchema.AuditReadPermission);
        var (empty, binding) = await adminStore.OperationsStatus(key, publications, ct);
        Assert.Equal((await adminStore.SessionWithPermissionBinding(key, ct)).PermissionSession, binding);
        Assert.Equal(new AdminOperationsStatus(false, 0, 0, 0), empty);

        var site = new Store(fixture.DataSource);
        var ticket = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await Execute("insert into public.blog_user(id,name,can_author,enabled,generation) values($1,'owner',true,true,1)", actor);
        await Execute("insert into public.login_ticket values($1,$2,clock_timestamp()+interval '5 minutes')", Store.TokenDigest(ticket)!, actor);
        var (siteToken, _) = await site.SignIn(ticket, ct);
        await Denied(Rejection.Unauthorized, () => adminStore.OperationsStatus(siteToken, publications, ct));
        var (draft, _) = await publications.Command(site, siteToken, ArticleAction.Save,
            new Edit(0, 0, Guid.NewGuid(), "A fixture article", "A fixture body"), ct);
        await publications.Command(site, siteToken, ArticleAction.Publish,
            new Edit(draft.Id, draft.Revision, Guid.NewGuid(), "A fixture article", "A fixture body"), ct);
        var (published, _) = await adminStore.OperationsStatus(key, publications, ct);
        Assert.True(published.SnapshotReady);
        Assert.True(published.PublicationWatermark > 0);
        Assert.Equal(0L, published.PendingPublicationEvents);

        var queued = DateTimeOffset.UtcNow.AddMinutes(-4);
        await Execute("""
            insert into public.blog_outbox(article_id,revision,kind,created_at)
            select id,revision,'retract',$2 from public.article where id=$1
            """, draft.Id, queued);
        var (lagging, _) = await adminStore.OperationsStatus(key, publications, ct);
        Assert.Equal(published.PublicationWatermark, lagging.PublicationWatermark);
        Assert.Equal(1L, lagging.PendingPublicationEvents);
        Assert.Equal(queued.ToUnixTimeMilliseconds(), lagging.OldestPendingAt);
        Assert.Equal(lagging, Wire.DecodeAdminOperationsStatus(Wire.EncodeAdminOperationsStatus(lagging)));
        await publications.Refresh(ct);
        var (caughtUp, _) = await adminStore.OperationsStatus(key, publications, ct);
        Assert.True(caughtUp.PublicationWatermark > lagging.PublicationWatermark);
        Assert.Equal(0L, caughtUp.PendingPublicationEvents);
        Assert.Equal(0L, caughtUp.OldestPendingAt);

        await Execute("update public.admin_principal set generation=generation+1 where id=$1", admin);
        await Denied(Rejection.Unauthorized, () => adminStore.OperationsStatus(key, publications, ct));

        Task Execute(string sql, params object[] arguments) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, arguments);
    }

    private static async Task Denied(Rejection expected, Func<Task> action) =>
        Assert.Equal(expected, (await Assert.ThrowsAsync<BusinessException>(action)).Rejection);
}
