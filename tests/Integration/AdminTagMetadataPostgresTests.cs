namespace FsusBlog.V2.Integration.Tests;

public sealed class AdminTagMetadataPostgresTests
{
    [PostgresFact]
    public async Task UnusedTagChangesRetainAliasesAndAdvanceOnlyTheTaxonomyWatermark()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (id, token, _) = await fixture.AdminAsync("tag-editor", 10, [1], [2], ct);
        await fixture.Exec("""
            insert into public.tag(id,name,description) values(1,'Ancienne','Original description'),(2,'Other',null),(3,'Peer',null);
            insert into public.tag_url_name values('ARCHIVED',2);
            """);

        await using var lease = new InstanceLease(fixture.ConnectionString);
        await lease.Start(NullLogger.Instance, ct, new(AdminTagMetadata: true));
        var admin = new AdminTagMetadataStore(new AdminSessionGate(fixture.DataSource, lease));
        var publications = Project();
        await publications.Refresh(ct);
        var baseline = publications.Snapshot!;
        Assert.Equal((0L, 1), (baseline.TaxonomyEpoch, baseline.Taxonomy.TagByName("Ancienne")));
        var siteUser = await fixture.SignInSiteUser("tag-site-user", ct);
        await BusinessAssert.Denied(Rejection.Unauthorized, () => admin.ReadTagMetadata(siteUser.Token, 1, ct));

        var pow = new ScopedPow(TimeProvider.System);
        var first = new AdminTagMetadataCommand(1, 0, Guid.NewGuid(), "Cafe\u0301 nouveau", " Changed description. ");
        var receipt = Wire.DecodeAdminTagMetadata(await Execute(first, Proof(first)));
        Assert.Equal(new AdminTagMetadata(1, 1, "Café nouveau", "Changed description.", true), receipt);
        var changed = publications.Snapshot!;
        Assert.NotEqual(baseline.Generation, changed.Generation);
        Assert.Equal((baseline.Watermark, 1L, 1, 1),
            (changed.Watermark, changed.TaxonomyEpoch, changed.Taxonomy.TagByName("ancienne"), changed.Taxonomy.TagByName("CAFE\u0301 NOUVEAU")));
        Assert.Contains("Changed description.", Encoding.UTF8.GetString(changed.Taxonomy.ById(true, 1)!.Value.Html));
        Assert.Equal(receipt, Wire.DecodeAdminTagMetadata(await Execute(first, null)));
        Assert.Same(changed, publications.Snapshot);

        foreach (var rejected in new[]
        {
            first with { RequestId = Guid.NewGuid(), Name = "Too late" },
            first with { Id = 3, RequestId = Guid.NewGuid(), Name = "Archived" },
            first with { Id = 3, RequestId = Guid.NewGuid(), Name = "CAFÉ NOUVEAU" },
        })
            await Assert.ThrowsAsync<BusinessException>(() => Execute(rejected, Proof(rejected)));
        var wrongProof = first with { Id = 2, RequestId = Guid.NewGuid(), Name = "Other changed" };
        await Assert.ThrowsAsync<ScopedPowFailure>(() => Execute(wrongProof, Proof(wrongProof with { Name = "Different intent" })));
        var cleared = first with { RequestId = Guid.NewGuid(), ExpectedRevision = 1, Description = "    " };
        Assert.Equal(new AdminTagMetadata(1, 2, "Café nouveau", "", true),
            Wire.DecodeAdminTagMetadata(await Execute(cleared, Proof(cleared))));
        var epochTwo = publications.Snapshot!;
        Assert.NotEqual(changed.Generation, epochTwo.Generation);
        Assert.Equal(2L, await fixture.Scalar<long>("select count(*) from public.tag_url_name where tag_id=1"));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.blog_outbox"));
        var noWrite = cleared with { RequestId = Guid.NewGuid(), ExpectedRevision = 2 };
        Assert.False(Wire.DecodeAdminTagMetadata(await Execute(noWrite, Proof(noWrite))).Changed);
        Assert.Same(epochTwo, publications.Snapshot);
        Assert.Equal(3L, await fixture.Scalar<long>("select count(*) from public.admin_tag_metadata_command"));
        Assert.Equal(2L, await fixture.Scalar<long>("select count(*) from public.admin_tag_metadata_command where changed"));

        // Same database, newly built instance, no administrator feature detection from the request path.
        var restarted = Project();
        await restarted.Refresh(ct);
        Assert.Equal((epochTwo.Generation, 1), (restarted.Snapshot!.Generation, restarted.Snapshot.Taxonomy.TagByName("Ancienne")));
        await fixture.Exec("update public.admin_principal set generation=generation+1 where id=$1", id);
        await Assert.ThrowsAsync<BusinessException>(() => Execute(first, null));

        Publications Project() => new(fixture.DataSource, new WebPages("<html><head></head><!--fsus-public-content--></html>"),
            NullLogger<Publications>.Instance, lease);

        Task<byte[]> Execute(AdminTagMetadataCommand change, string? proof) =>
            publications.AdministrativePublication(invalidate => admin.ChangeTagMetadata(token, change,
                Wire.EncodeAdminTagMetadataCommand(change), LoopbackContext(WireHeaders.PowProof, proof), pow, invalidate, ct), ct);

        string Proof(AdminTagMetadataCommand change)
        {
            var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
            var challenge = pow.Issue(PowScope.AdminTagMetadata, change.Id.ToString(CultureInfo.InvariantCulture), token,
                IPAddress.Loopback, nonce, Wire.EncodeAdminTagMetadataCommand(change));
            return PowFixture.Solve(challenge, nonce, ct);
        }
    }

    [PostgresFact]
    public async Task CreateTagReservesCanonicalNameWithoutTakingExistingAliases()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (_, token, _) = await fixture.AdminAsync("tag-creator", 10, [1], [2], ct);
        await fixture.Exec("insert into public.tag(id,name) values(4,'Retired tag successor'),(70,$1)", "Cafe\u0301 existant");
        await fixture.Exec("insert into public.tag_url_name values('RETIRED TOPIC',4)");
        await using var lease = new InstanceLease(fixture.ConnectionString);
        await lease.Start(NullLogger.Instance, ct, new(AdminTagMetadata: true));
        var admin = new AdminTagMetadataStore(new AdminSessionGate(fixture.DataSource, lease));
        var publications = PublicationFixture.Project(fixture.DataSource, lease);
        await publications.Refresh(ct);
        var before = publications.Snapshot!;
        Assert.Equal((4, 70), (before.Taxonomy.TagByName("retired topic"), before.Taxonomy.TagByName("CAFÉ EXISTANT")));

        var pow = new ScopedPow(TimeProvider.System);
        var create = new AdminTagMetadataCommand(0, 0, Guid.NewGuid(), " Nouveau cafe\u0301 ", " New tag description. ");
        Assert.Throws<ProtocolException>(() => Wire.EncodeAdminTagMetadataCommand(create));
        var input = Wire.EncodeAdminTagCreateCommand(create);
        Assert.Throws<ProtocolException>(() => Wire.DecodeAdminTagMetadataCommand(input));
        Assert.Equal(create, Wire.DecodeAdminTagCreateCommand(input));
        var output = await Execute(create, await Proof(create));
        var receipt = Wire.DecodeAdminTagMetadata(output);
        Assert.True(receipt.Id > 70);
        Assert.Equal(new AdminTagMetadata(receipt.Id, 1, "Nouveau café", "New tag description.", true), receipt);
        Assert.Equal(receipt with { Changed = false }, await admin.ReadTagMetadata(token, receipt.Id, ct));
        var after = publications.Snapshot!;
        Assert.NotEqual(before.Generation, after.Generation);
        Assert.Equal((before.Watermark, before.TaxonomyEpoch + 1, receipt.Id, 0),
            (after.Watermark, after.TaxonomyEpoch, after.Taxonomy.TagByName("NOUVEAU CAFE\u0301"), after.Taxonomy.ById(true, receipt.Id)!.Value.ArticleCount));
        Assert.Equal(receipt.Id, await fixture.Scalar<int>("select tag_id from public.tag_url_name where name_key='NOUVEAU CAFÉ'"));
        Assert.Equal(output, await Execute(create, null));

        foreach (var existing in new[] { " retired topic ", " CAFÉ EXISTANT " })
        {
            var duplicate = create with { RequestId = Guid.NewGuid(), Name = existing };
            var proof = await Proof(duplicate);
            await BusinessAssert.Denied(Rejection.Conflict, () => Execute(duplicate, proof));
        }
        await BusinessAssert.Denied(Rejection.Conflict, () => Execute(create with { Name = "Different tag" }, null));
        Assert.Same(after, publications.Snapshot);
        Assert.Equal((4, 70), (after.Taxonomy.TagByName("Retired topic"), after.Taxonomy.TagByName("cafe\u0301 existant")));
        foreach (var (expected, sql) in new[]
        {
            (3L, "select count(*) from public.tag"),
            (2L, "select count(*) from public.tag_url_name"),
            (1L, "select count(*) from public.admin_tag_metadata_command where changed"),
            (1L, "select count(*) from public.scoped_pow_consumed"),
            (0L, "select count(*) from public.blog_outbox"),
            (0L, "select count(*) from public.article_revision_tag"),
        })
            Assert.Equal(expected, await fixture.Scalar<long>(sql));

        Task<byte[]> Execute(AdminTagMetadataCommand value, string? proof) =>
            publications.AdministrativePublication(invalidate => admin.ChangeTagMetadata(token, value,
                Wire.EncodeAdminTagCreateCommand(value), LoopbackContext(WireHeaders.PowProof, proof), pow, invalidate, ct), ct);

        async Task<string> Proof(AdminTagMetadataCommand value)
        {
            var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
            var frame = await admin.ChangeTagMetadata(token, value, Wire.EncodeAdminTagCreateCommand(value),
                LoopbackContext(WireHeaders.PowClientNonce, nonce), pow, null, ct);
            return PowFixture.SolveFrame(frame, nonce, ct);
        }
    }

    [PostgresFact]
    public async Task LoopbackAdminHttpCreatesEditsDeletesTaxonomyAndPassesSchemaVerification()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (adminId, token, _) = await fixture.AdminAsync("loopback-taxonomy-admin", 10, [1], [2], ct);

        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct))
        {
            var client = server.Client;
            // Loopback HTTP admin origin automatically enables tag & category metadata endpoints.
            foreach (var path in new[] { WireRoutes.AdminTagMetadataAvailability, WireRoutes.AdminCategoryMetadataAvailability })
                await SiteAedsFixture.AdminStatus(client, HttpMethod.Get, path, token, ct, NoContent);

            // 1. Tag: create -> edit -> reject cross-origin delete -> delete (AEDS EmptySuccess) -> 404.
            var createdTag = await SubmitTaxonomy(client, WireRoutes.AdminTagCreatePow, WireRoutes.AdminTagCreate,
                HttpMethod.Post, Wire.EncodeAdminTagCreateCommand(new(0, 0, Guid.NewGuid(), "LoopbackTag", "Initial tag note")),
                Wire.DecodeAdminTagMetadata);
            Assert.True(createdTag.Id > 0);
            Assert.Equal("LoopbackTag", createdTag.Name);

            var editedTag = await SubmitTaxonomy(client, WithId(WireRoutes.AdminTagMetadataPow, createdTag.Id),
                WithId(WireRoutes.AdminTagMetadata, createdTag.Id), HttpMethod.Put,
                Wire.EncodeAdminTagMetadataCommand(new(createdTag.Id, createdTag.Revision, Guid.NewGuid(), "LoopbackTagRenamed", "Updated tag note")),
                Wire.DecodeAdminTagMetadata);
            Assert.Equal(("LoopbackTagRenamed", "Updated tag note"), (editedTag.Name, editedTag.Description));

            var tagDeletePath = WithId(WireRoutes.AdminTagDelete, createdTag.Id);
            await SiteAedsFixture.AdminStatus(client, HttpMethod.Post, tagDeletePath, token, ct, Forbidden, includeOrigin: false);
            await AssertEmptySuccessDelete(client, tagDeletePath);
            await SiteAedsFixture.AdminStatus(client, HttpMethod.Get, WithId(WireRoutes.AdminTagMetadata, createdTag.Id), token, ct, NotFound);

            // 2. Category: create -> edit -> conflict while referenced -> delete unreferenced (AEDS EmptySuccess).
            var usedCategory = await SubmitTaxonomy(client, WireRoutes.AdminCategoryCreatePow, WireRoutes.AdminCategoryCreate,
                HttpMethod.Post, Wire.EncodeAdminCategoryMetadataCommand(new(0, 0, Guid.NewGuid(), "ReferencedCat", "In use")),
                Wire.DecodeAdminCategoryMetadata);
            await fixture.InTx(async (db, tx) =>
            {
                await FixtureSql.ExecuteAsync(db, tx, ct, """
                    insert into public.article(id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at)
                    overriding system value values(100,$1,1,'Draft','Body',null,0,false,clock_timestamp(),clock_timestamp())
                    """, adminId);
                await FixtureSql.ExecuteAsync(db, tx, ct, """
                    insert into public.article_revision(article_id,revision,title,body,happened_at) values(100,1,'Draft','Body',clock_timestamp())
                    """);
                await FixtureSql.ExecuteAsync(db, tx, ct, """
                    insert into public.article_revision_category(article_id,revision,category_id) values(100,1,$1)
                    """, usedCategory.Id);
            }, ct);

            await SiteAedsFixture.AdminStatus(client, HttpMethod.Post, WithId(WireRoutes.AdminCategoryDelete, usedCategory.Id), token, ct, Conflict);

            var freeCategory = await SubmitTaxonomy(client, WireRoutes.AdminCategoryCreatePow, WireRoutes.AdminCategoryCreate,
                HttpMethod.Post, Wire.EncodeAdminCategoryMetadataCommand(new(0, 0, Guid.NewGuid(), "UnusedCat", "Temp")),
                Wire.DecodeAdminCategoryMetadata);
            var editedCategory = await SubmitTaxonomy(client, WithId(WireRoutes.AdminCategoryMetadataPow, freeCategory.Id),
                WithId(WireRoutes.AdminCategoryMetadata, freeCategory.Id), HttpMethod.Put,
                Wire.EncodeAdminCategoryMetadataCommand(new(freeCategory.Id, freeCategory.Revision, Guid.NewGuid(), "UnusedCat2", "Temp2")),
                Wire.DecodeAdminCategoryMetadata);
            Assert.Equal("UnusedCat2", editedCategory.Name);
            await AssertEmptySuccessDelete(client, WithId(WireRoutes.AdminCategoryDelete, freeCategory.Id));
        }

        // 3. After deleting tag & category (removing their FK-bound command rows while advancing taxonomy_epoch),
        //    schema verification and a fresh server startup must succeed cleanly.
        await fixture.WithConnection(db => CurrentSchema.VerifyAsync(db, ct), ct);
        await using (var restarted = await ServerProcess.Start(fixture.ConnectionString, ct))
            await SiteAedsFixture.AdminStatus(restarted.Client, HttpMethod.Get, WireRoutes.AdminCategories, token, ct, OK);

        static string WithId(string route, int id) => route.Replace("{id:int}", id.ToString(CultureInfo.InvariantCulture));

        async Task AssertEmptySuccessDelete(HttpClient client, string path)
        {
            using var resp = Ok(await SiteAedsFixture.AdminSend(client, HttpMethod.Post, path, token, ct));
            Assert.Equal(Aeds.ContentType, resp.Content.Headers.ContentType?.MediaType);
            Assert.Equal([1, 0, 0, 0], Aeds.Decode(await resp.Content.ReadAsByteArrayAsync(ct), FrameType.EmptySuccess).ToArray());
        }

        async Task<AdminTagMetadata> SubmitTaxonomy(HttpClient client, string powPath, string mutationPath,
            HttpMethod method, byte[] frame, Func<ReadOnlySpan<byte>, AdminTagMetadata> decode)
        {
            var powProof = await SiteAedsFixture.AdminPow(client, powPath, token, frame, ct);
            using var mutResp = Ok(await SiteAedsFixture.AdminSend(client, method, mutationPath, token, ct, frame: frame,
                configure: req => req.Headers.Add(WireHeaders.PowProof, powProof)));
            Assert.Equal(Aeds.ContentType, mutResp.Content.Headers.ContentType?.MediaType);
            return decode(await mutResp.Content.ReadAsByteArrayAsync(ct));
        }
    }

    internal static DefaultHttpContext LoopbackContext(string header, string? value)
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Loopback;
        if (value is not null) context.Request.Headers[header] = value;
        return context;
    }
}
