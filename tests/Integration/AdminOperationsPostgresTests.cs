namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminOperationsPostgresTests
{
    [PostgresFact]
    public async Task AuditPermissionKeepsActualPublicationStateInIndependentCurrentAdminSession()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (admin, key, _) = await fixture.AdminAsync("observer", 10, [1], [2], ct);

        var gate = new AdminSessionGate(fixture.DataSource, null);
        var adminStore = new AdminOperationsStore(gate);
        var publications = PublicationFixture.Project(fixture.DataSource);
        await Denied(Rejection.Unauthorized, () => adminStore.OperationsStatus(null, publications, ct));
        var (empty, binding) = await adminStore.OperationsStatus(key, publications, ct);
        Assert.Equal((await gate.SessionWithPermissionBinding(key, ct)).PermissionSession, binding);
        Assert.Equal(new AdminOperationsStatus(false, 0, 0, 0), empty);

        var site = new Store(fixture.DataSource);
        var (_, siteToken, _) = await fixture.SignInSiteUser("reader", ct, minutes: 5);
        await Denied(Rejection.Unauthorized, () => adminStore.OperationsStatus(siteToken, publications, ct));
        var (_, authorToken, _) = await fixture.SignIn("owner", ct);
        var (draft, _) = await publications.Command(site, authorToken, ArticleAction.Save,
            new Edit(0, 0, Guid.NewGuid(), "A fixture article", "A fixture body"), ct);
        await publications.Command(site, authorToken, ArticleAction.Publish,
            new Edit(draft.Id, draft.Revision, Guid.NewGuid(), "A fixture article", "A fixture body"), ct);
        var (published, _) = await adminStore.OperationsStatus(key, publications, ct);
        Assert.True(published.SnapshotReady && published.PublicationWatermark > 0);
        Assert.Equal(0L, published.PendingPublicationEvents);

        var queued = DateTimeOffset.UtcNow.AddMinutes(-4);
        await fixture.Exec("""
            insert into public.blog_outbox(article_id,revision,kind,created_at)
            select id,revision,'retract',$2 from public.article where id=$1
            """, draft.Id, queued);
        var (lagging, _) = await adminStore.OperationsStatus(key, publications, ct);
        Assert.Equal((published.PublicationWatermark, 1L, queued.ToUnixTimeMilliseconds()),
            (lagging.PublicationWatermark, lagging.PendingPublicationEvents, lagging.OldestPendingAt));
        Assert.Equal(lagging, Wire.DecodeAdminOperationsStatus(Wire.EncodeAdminOperationsStatus(lagging)));
        await publications.Refresh(ct);
        var (caughtUp, _) = await adminStore.OperationsStatus(key, publications, ct);
        Assert.True(caughtUp.PublicationWatermark > lagging.PublicationWatermark);
        Assert.Equal((0L, 0L), (caughtUp.PendingPublicationEvents, caughtUp.OldestPendingAt));

        await fixture.Exec("update public.admin_principal set generation=generation+1 where id=$1", admin);
        await Denied(Rejection.Unauthorized, () => adminStore.OperationsStatus(key, publications, ct));
    }
}
