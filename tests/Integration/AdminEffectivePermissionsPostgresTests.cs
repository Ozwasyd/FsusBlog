namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminEffectivePermissionsPostgresTests
{
    [PostgresFact]
    public async Task SessionBindingTracksLiveUnifiedAdministratorGenerationAndRevocation()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var store = new AdminSessionGate(fixture.DataSource, null);
        var operations = new AdminOperationsStore(store);
        var commentQueue = new AdminCommentQueueStore(store);
        var publications = PublicationFixture.Project(fixture.DataSource);
        var (owner, firstToken, _) = await fixture.AdminAsync("first", 10, RandomNumberGenerator.GetBytes(32), [1], ct);
        var (other, secondToken, _) = await fixture.AdminAsync("second", 10, RandomNumberGenerator.GetBytes(32), [1], ct);
        var siteUser = await fixture.SignInSiteUser("ordinary-site-user", ct);

        var snapshot = await store.SessionWithPermissionBinding(firstToken, ct);
        Assert.Equal(1L, snapshot.Snapshot.Generation);
        Assert.Matches("^[a-f0-9]{64}$", snapshot.PermissionSession);
        Assert.NotEqual(firstToken, snapshot.PermissionSession);

        var sibling = await store.SessionWithPermissionBinding(secondToken, ct);
        Assert.Equal(snapshot.Snapshot.Generation, sibling.Snapshot.Generation);
        Assert.NotEqual(snapshot.PermissionSession, sibling.PermissionSession);
        await operations.OperationsStatus(firstToken, publications, ct);
        await commentQueue.CommentQueue(firstToken, QueryCollection.Empty, ct);
        await Denied(() => store.SessionWithPermissionBinding(null, ct));
        await Denied(() => store.SessionWithPermissionBinding(siteUser.Token, ct));

        // Rotating the principal generation retires its prior session and binds a fresh opaque session digest.
        var newToken = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await fixture.InTx(async (db, tx) =>
        {
            await FixtureSql.ExecuteAsync(db, tx, ct, "update public.admin_principal set generation=generation+1 where id=$1", owner);
            await FixtureSql.ExecuteAsync(db, tx, ct, "delete from public.admin_session where principal_id=$1", owner);
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.admin_session(digest,principal_id,generation,expires_at)
                    values($2,$1,2,clock_timestamp()+interval '10 minutes')
                """, owner, Store.TokenDigest(newToken)!);
        }, ct);
        await Denied(() => store.SessionWithPermissionBinding(firstToken, ct));
        var renewed = await store.SessionWithPermissionBinding(newToken, ct);
        Assert.Equal(2L, renewed.Snapshot.Generation);
        Assert.NotEqual(snapshot.PermissionSession, renewed.PermissionSession);
        await operations.OperationsStatus(newToken, publications, ct);
        await commentQueue.CommentQueue(newToken, QueryCollection.Empty, ct);
        Assert.Equal(sibling.PermissionSession, (await store.SessionWithPermissionBinding(secondToken, ct)).PermissionSession);
        await fixture.Exec("update public.admin_principal set enabled=false where id=$1", other);
        await Denied(() => store.SessionWithPermissionBinding(secondToken, ct));
    }

    [PostgresFact]
    public async Task BootstrapCreatesUnifiedAdministratorWithFullAuthoringAndManagementAccess()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var result = await FixtureProcess.Run(FixtureProcess.Cli(fixture.ConnectionString, null, "admin-identity", "bootstrap", "unified-admin"), ct);
        Assert.True(result.Code == 0, $"Cli exited with {result.Code}: {result.Error}");
        var unifiedSecret = result.Output.Trim();
        Assert.Matches("^[0-9a-f]{64}$", unifiedSecret);

        var principalId = await fixture.Scalar<Guid>("select id from public.admin_principal where handle=$1 and enabled", "unified-admin");
        Assert.Equal(1L, await fixture.Scalar<long>(
            "select count(*) from public.admin_invitation where principal_id=$1 and digest=$2",
            principalId, SHA256.HashData(Convert.FromHexString(unifiedSecret))));

        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await fixture.Exec("""
            insert into public.admin_passkey_credential(credential_id,principal_id,public_key,sign_count,backup_eligible,backed_up)
            values($1,$2,$3,0,false,false)
            """, RandomNumberGenerator.GetBytes(32), principalId, new byte[] { 1 });
        await fixture.Exec("""
            insert into public.admin_session(digest,principal_id,generation,expires_at)
            values($1,$2,1,clock_timestamp()+interval '10 minutes')
            """, Store.TokenDigest(token)!, principalId);

        var adminStore = new AdminSessionGate(fixture.DataSource, null);
        var publications = PublicationFixture.Project(fixture.DataSource);
        Assert.Equal("unified-admin", (await adminStore.SessionWithPermissionBinding(token, ct)).Snapshot.Handle);
        await new AdminOperationsStore(adminStore).OperationsStatus(token, publications, ct);
        await new AdminCommentQueueStore(adminStore).CommentQueue(token, QueryCollection.Empty, ct);
        var article = (await publications.Command(new Store(fixture.DataSource), token, ArticleAction.Save,
            new Edit(0, 0, Guid.NewGuid(), "Unified admin article", "Body"), ct)).Article;
        Assert.True(article.Id > 0);
        Assert.Equal(principalId, await fixture.Scalar<Guid>("select owner_id from public.article where id=$1", article.Id));
    }
}
