namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminCategoryMetadataPostgresTests
{
    [PostgresFact]
    public async Task CreateAndRenameKeepCategoryIdentityAndImmutableArticleCoordinates()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (adminId, token, _) = await fixture.AdminAsync("category-editor", 10, [1], [2], ct);
        var (_, authorToken, _) = await fixture.SignIn("category-publisher", ct);
        // Existing imports can have supplied IDs independently of the identity sequence.
        await fixture.Exec("""
            insert into public.category(id,name) values(1,'Imported category');
            insert into public.tag(id,name) values(1,'Café topics');
            insert into public.tag_url_name values('TAG ARCHIVE',1);
            """);

        await using var lease = new InstanceLease(fixture.ConnectionString);
        await lease.Start(NullLogger.Instance, ct, new(AdminCategoryMetadata: true));
        var admin = new AdminTagMetadataStore(new AdminSessionGate(fixture.DataSource, lease));
        var store = new Store(fixture.DataSource, lease);
        var publications = PublicationFixture.Project(fixture.DataSource, lease);
        await publications.Refresh(ct);
        var initial = publications.Snapshot!;
        Assert.Equal(0L, initial.TaxonomyEpoch);

        var pow = new ScopedPow(TimeProvider.System);
        var create = new AdminTagMetadataCommand(0, 0, Guid.NewGuid(), " Café topics ", " Original category description. ");
        var siteUser = await fixture.SignInSiteUser("category-site-user", ct);
        await BusinessAssert.Denied(Rejection.Unauthorized, () => admin.ReadCategoryMetadata(siteUser.Token, 1, ct));
        await BusinessAssert.Denied(Rejection.Unauthorized, () => Challenge(create, MakeNonce(), siteUser.Token));

        var createFrame = await Execute(create, await Proof(create));
        var created = Wire.DecodeAdminCategoryMetadata(createFrame);
        Assert.True(created.Id > 1);
        Assert.Equal(new AdminTagMetadata(created.Id, 1, "Café topics", "Original category description.", true), created);
        Assert.Equal(created with { Changed = false }, await admin.ReadCategoryMetadata(token, created.Id, ct));

        var initialCategory = publications.Snapshot!;
        Assert.NotEqual(initial.Generation, initialCategory.Generation);
        Assert.Equal((initial.Watermark, 1L, 0),
            (initialCategory.Watermark, initialCategory.TaxonomyEpoch, initialCategory.Taxonomy.ById(false, created.Id)!.Value.ArticleCount));
        Assert.Equal(createFrame, await Execute(create, null));
        Assert.Same(initialCategory, publications.Snapshot);

        await BusinessAssert.Denied(Rejection.Conflict, () => Execute(create with { Name = "Another category" }, null));
        var duplicate = create with { RequestId = Guid.NewGuid(), Name = "Café topics" };
        var duplicateProof = await Proof(duplicate);
        await BusinessAssert.Denied(Rejection.Conflict, () => Execute(duplicate, duplicateProof));
        Assert.Same(initialCategory, publications.Snapshot);

        var draft = await Edit(ArticleAction.Save, 0, 0, "Public category article", "A public source tied to the category ID.");
        var assigned = await store.WithSession(authorToken, true, (conn, tx, actor) => Store.AssignTaxonomy(conn, tx, actor,
            new TaxonomyAssignment(draft.Id, draft.Revision, Guid.NewGuid(), created.Id, [1]), ct), ct);
        var published = await Edit(ArticleAction.Publish, draft.Id, assigned.Revision);
        var privateDraft = await Edit(ArticleAction.Save, draft.Id, published.Revision, "Private subsequent revision", "Private category source.");
        var before = publications.Snapshot!;
        var publicArticle = Assert.IsType<Article>(before.Article(draft.Id));
        Assert.Equal(new TaxonomyName(created.Id, "Café topics"), publicArticle.Category);
        Assert.NotEqual(privateDraft.Revision, publicArticle.Revision);
        var outboxCount = await fixture.Scalar<long>("select count(*) from public.blog_outbox");
        var revisionCount = await fixture.Scalar<long>("select count(*) from public.article_revision where article_id=$1", draft.Id);

        var rename = new AdminTagMetadataCommand(created.Id, created.Revision, Guid.NewGuid(), "Renamed category", "New category description.");
        var wrongScopeNonce = MakeNonce();
        var wrongScope = pow.Issue(PowScope.AdminTagMetadata, rename.Id.ToString(CultureInfo.InvariantCulture), token,
            IPAddress.Loopback, wrongScopeNonce, Wire.EncodeAdminCategoryMetadataCommand(rename));
        var rejected = await Assert.ThrowsAsync<ScopedPowFailure>(() => Execute(rename, PowFixture.Solve(wrongScope, wrongScopeNonce, ct)));
        Assert.Equal("pow_rejected", rejected.Details);
        Assert.Same(before, publications.Snapshot);

        var renameFrame = await Execute(rename, await Proof(rename));
        var renamed = Wire.DecodeAdminCategoryMetadata(renameFrame);
        Assert.Equal(new AdminTagMetadata(created.Id, 2, "Renamed category", "New category description.", true), renamed);
        Assert.Equal(renamed with { Changed = false }, await admin.ReadCategoryMetadata(token, created.Id, ct));

        var after = publications.Snapshot!;
        Assert.NotEqual(before.Generation, after.Generation);
        Assert.Equal((before.Watermark, 2L), (after.Watermark, after.TaxonomyEpoch));
        var publicAfter = Assert.IsType<Article>(after.Article(draft.Id));
        Assert.Equal(publicArticle with { Category = new TaxonomyName(created.Id, "Renamed category"), Tags = publicAfter.Tags }, publicAfter);
        Assert.Equal<TaxonomyName>(publicArticle.Tags!, publicAfter.Tags!);
        var page = after.Taxonomy.ById(false, created.Id)!.Value;
        Assert.Equal(1, page.ArticleCount);
        var html = Encoding.UTF8.GetString(page.Html);
        foreach (var text in new[] { "Renamed category", "New category description.", "Public category article" })
            Assert.Contains(text, html);
        Assert.DoesNotContain("Private subsequent revision", html);
        Assert.Equal((1, (int?)null), (after.Taxonomy.TagByName("Café topics"), after.Taxonomy.TagByName("Renamed category")));

        Assert.Equal(renameFrame, await Execute(rename, null));
        foreach (var bad in new[]
        {
            rename with { RequestId = Guid.NewGuid(), Name = "Stale change" },
            rename with { RequestId = Guid.NewGuid(), ExpectedRevision = renamed.Revision, Name = "Imported category" },
        })
        {
            var proof = await Proof(bad);
            await BusinessAssert.Denied(Rejection.Conflict, () => Execute(bad, proof));
        }
        Assert.Same(after, publications.Snapshot);
        foreach (var (expected, sql) in new[]
        {
            (2L, "select count(*) from public.admin_category_metadata_command"),
            (2L, "select count(*) from public.scoped_pow_consumed"),
            (1L, "select count(*) from public.tag_url_name"),
            (2L, "select count(*) from public.category"),
            (outboxCount, "select count(*) from public.blog_outbox"),
        })
            Assert.Equal(expected, await fixture.Scalar<long>(sql));
        Assert.Equal(revisionCount, await fixture.Scalar<long>("select count(*) from public.article_revision where article_id=$1", draft.Id));
        Assert.Equal(3L, await fixture.Scalar<long>("""
            select count(*) from public.article_revision_category
            where article_id=$1 and category_id=$2 and revision in ($3,$4,$5)
            """, draft.Id, created.Id, assigned.Revision, published.Revision, privateDraft.Revision));

        var restarted = PublicationFixture.Project(fixture.DataSource, lease);
        await restarted.Refresh(ct);
        Assert.Equal((after.Generation, new TaxonomyName(created.Id, "Renamed category")),
            (restarted.Snapshot!.Generation, restarted.Snapshot.Article(draft.Id)!.Category));
        await fixture.Exec("update public.admin_principal set generation=generation+1 where id=$1", adminId);
        await BusinessAssert.Denied(Rejection.Unauthorized, () => Execute(rename, null));

        async Task<ArticleState> Edit(ArticleAction action, int id, long revision, string title = "", string body = "") =>
            (await publications.Command(store, authorToken, action, new(id, revision, Guid.NewGuid(), title, body), ct)).Article;

        Task<byte[]> Execute(AdminTagMetadataCommand change, string? proof) =>
            publications.AdministrativePublication(invalidate => admin.ChangeCategoryMetadata(token, change,
                Wire.EncodeAdminCategoryMetadataCommand(change), AdminTagMetadataPostgresTests.LoopbackContext(WireHeaders.PowProof, proof), pow, invalidate, ct), ct);

        Task<byte[]> Challenge(AdminTagMetadataCommand change, string nonce, string? actorToken = null) =>
            admin.ChangeCategoryMetadata(actorToken ?? token, change, Wire.EncodeAdminCategoryMetadataCommand(change),
                AdminTagMetadataPostgresTests.LoopbackContext(WireHeaders.PowClientNonce, nonce), pow, null, ct);

        async Task<string> Proof(AdminTagMetadataCommand change)
        {
            var nonce = MakeNonce();
            return PowFixture.SolveFrame(await Challenge(change, nonce), nonce, ct);
        }
    }

    private static string MakeNonce() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
}
