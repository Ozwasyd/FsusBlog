public sealed class ArticleTrashPostgresTests
{
    [PostgresFact]
    public async Task SoftDeleteFailsClosedAndRestorationKeepsExactPrivateRevisionAndLineage()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var owner = (await fixture.SignIn("trash owner", ct, canAuthor: true, minutes: 1)).Token;
        var other = (await fixture.SignIn("other author", ct, canAuthor: true, minutes: 1)).Token;
        var reader = (await fixture.SignIn("site reader", ct, canAuthor: false, minutes: 1)).Token;
        await fixture.Exec("insert into public.category(id,name) values(41,'Taxonomy category'); insert into public.tag(id,name) values(81,'Taxonomy tag');");
        var settings = new Dictionary<string, string>
        {
            ["FSUSBLOG_PUBLIC_ORIGIN"] = "https://blog.example.test",
            ["FSUSBLOG_ADMIN_ORIGIN"] = ServerProcess.DefaultAdminOrigin,
        };
        const string marker = "Article trash public marker";
        Draft restored;
        string publicPath, editorPath;
        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, settings))
        {
            var client = server.Client;
            const string title = "Latest private revision", body = "Latest Markdown body with ![image](/media/keep.png).", propertyValue = "Preserved private property";
            var draft = Wire.DecodeDraft(await Command(WireRoutes.Save, new(0, 0, Guid.NewGuid(), marker, "Published body"), owner));
            var publicDraft = Wire.DecodeDraft(await Command(WireRoutes.Publish, Mutation(draft.Id, draft.Revision), owner));
            publicPath = $"/article/{draft.Id}";
            var binaryPath = WireRoutes.PublicArticle.Replace("{id}", draft.Id.ToString());
            editorPath = WireRoutes.Draft.Replace("{id:int}", draft.Id.ToString());
            Assert.Contains(marker, await client.GetStringAsync(publicPath, ct));
            Assert.Contains(marker, await client.GetStringAsync("/feed/rss.xml", ct));

            var saved = Wire.DecodeDraft(await Command(WireRoutes.Save, new(draft.Id, publicDraft.Revision, Guid.NewGuid(), title, body), owner));
            var taxonomy = Wire.DecodeDraftTaxonomy(await Post(WireRoutes.TaxonomyAssignment,
                Wire.EncodeTaxonomyAssignment(new(draft.Id, saved.Revision, Guid.NewGuid(), 41, [81])), owner));
            var schedule = Wire.DecodeArticleSchedule(await Post(WireRoutes.DraftScheduleCommand,
                Wire.EncodeArticleScheduleCommand(new(draft.Id, taxonomy.Revision, Guid.NewGuid(), DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds())), owner));
            var definition = new PropertyDefinitionCommand(1, Guid.NewGuid(), Guid.NewGuid(), 0, 0, "subtitle", "Subtitle");
            Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertyDefinitionCommand, Wire.EncodePropertyDefinitionCommand(definition), owner));
            Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertyTextCommand, Wire.EncodePropertyTextCommand(
                new(draft.Id, schedule.Revision, 1, 0, definition.DefinitionId, 1, Guid.NewGuid(), false, propertyValue)), owner));
            var delete = Mutation(draft.Id, schedule.Revision);
            var restore = Mutation(draft.Id, schedule.Revision + 1);
            foreach (var (route, cmd, tok, expected) in new[]
            {
                (WireRoutes.Restore, delete, (string?)owner, Conflict),
                (WireRoutes.Delete, delete with { ExpectedRevision = saved.Revision }, owner, Conflict),
                (WireRoutes.Delete, delete, reader, Unauthorized),
                (WireRoutes.Delete, delete with { Id = 999_999 }, other, NotFound),
            })
                await Command(route, cmd, tok, expected);

            // Force a post-commit projection failure for the real delete command. The old public artifacts must close immediately.
            await fixture.Exec("alter table public.blog_outbox add constraint test_delete_projection_failure check (kind <> 'delete' or processed_at is null)");
            await Command(WireRoutes.Delete, delete, owner, ServiceUnavailable);
            foreach (var path in new[] { "/health/ready", "/", publicPath, binaryPath, WireRoutes.PublicIndex,
                WireRoutes.PublicSearchCorpus, "/feed/rss.xml", "/feed/atom.xml", "/feed/feed.json", "/sitemap.xml" })
                await Read(client, path, ServiceUnavailable);
            Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.blog_outbox where article_id=$1 and kind='delete' and processed_at is null", draft.Id));
            Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article_schedule where article_id=$1", draft.Id));
            await fixture.Exec("alter table public.blog_outbox drop constraint test_delete_projection_failure");
            Aeds.Decode(await Command(WireRoutes.Delete, delete, owner), FrameType.EmptySuccess);
            await Read(client, publicPath, NotFound);
            await Read(client, binaryPath, NotFound);
            await Read(client, editorPath, NotFound, owner);
            Assert.Equal("publish,delete", await History());

            foreach (var (cmd, tok, expected) in new[]
            {
                (restore, (string?)null, Unauthorized),
                (restore, reader, Unauthorized),
                (restore with { Id = 999_999 }, other, NotFound),
                (restore with { ExpectedRevision = delete.ExpectedRevision }, owner, Conflict),
            })
                await Command(WireRoutes.Restore, cmd, tok, expected);

            // A failed private outbox insert must roll restore back. Exact retries then commit one revision only.
            await fixture.Exec("alter table public.blog_outbox add constraint test_restore_rollback check (kind <> 'restore')");
            await Command(WireRoutes.Restore, restore, owner, ServiceUnavailable);
            await Read(client, editorPath, NotFound, owner);
            await fixture.Exec("alter table public.blog_outbox drop constraint test_restore_rollback");
            var results = await Task.WhenAll(Command(WireRoutes.Restore, restore, owner), Command(WireRoutes.Restore, restore, owner));
            Assert.Equal(results[0], results[1]);
            restored = Wire.DecodeDraft(results[0]);
            Assert.Equal(new Draft(draft.Id, restore.ExpectedRevision + 1, title, body, false), restored);
            await Command(WireRoutes.Restore, restore with { IdempotencyKey = Guid.NewGuid() }, owner, Conflict);
            await Command(WireRoutes.Delete, restore, owner, Conflict);
            Assert.Equal(1L, await fixture.Scalar<long>("select count(*) from public.blog_outbox where article_id=$1 and kind='restore'", draft.Id));
            Assert.Equal("publish,delete", await History());
            var recoveredTaxonomy = Wire.DecodeDraftTaxonomy(await Read(client,
                $"{WireRoutes.DraftTaxonomy.Replace("{id:int}", draft.Id.ToString())}?revision={restored.Revision}", OK, owner));
            Assert.Equal((restored.Revision, 41, 81), (recoveredTaxonomy.Revision, recoveredTaxonomy.CategoryId, Assert.Single(recoveredTaxonomy.TagIds)));
            var restoredProperty = Wire.DecodePropertyWorkspace(await Post(WireRoutes.PropertyWorkspace,
                Wire.EncodePropertyWorkspaceRequest(new(draft.Id, restored.Revision, 0, 0, "")), owner));
            Assert.Equal(propertyValue, Assert.Single(restoredProperty.Fields).Value);
            Assert.Equal(marker, await fixture.Scalar<string>("select title from public.article_revision where article_id=$1 and revision=$2", draft.Id, publicDraft.Revision));
            await Read(client, publicPath, NotFound);
            await Read(client, binaryPath, NotFound);
            Assert.DoesNotContain(marker, await client.GetStringAsync("/feed/rss.xml", ct));
            Assert.DoesNotContain(publicPath, await client.GetStringAsync("/sitemap.xml", ct));

            static ArticleCommand Mutation(int id, long revision) => new(id, revision, Guid.NewGuid(), "", "");
            Task<byte[]> Command(string path, ArticleCommand command, string? token, HttpStatusCode expected = OK) =>
                Post(path, Wire.EncodeArticleCommand(command), token, expected);
            Task<byte[]> Post(string path, byte[] frame, string? token, HttpStatusCode expected = OK) =>
                Send(client, HttpMethod.Post, path, frame, token, expected);
            Task<string> History() => fixture.Scalar<string>(
                "select string_agg(kind, ',' order by event_no) from public.article_publication_history where article_id=$1", draft.Id);
        }

        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct, settings);
        await Read(restarted.Client, publicPath, NotFound);
        Assert.Equal(restored, Wire.DecodeDraft(await Read(restarted.Client, editorPath, OK, owner)));

        Task<byte[]> Read(HttpClient endpoint, string path, HttpStatusCode expected, string? token = null) =>
            Send(endpoint, HttpMethod.Get, path, null, token, expected);

        async Task<byte[]> Send(HttpClient endpoint, HttpMethod method, string path, byte[]? frame, string? token, HttpStatusCode expected)
        {
            using var response = Expect(expected, await SiteAedsFixture.Send(endpoint, method, path, frame, token, null, ct));
            if (expected != OK || token is not null) Assert.True(response.Headers.CacheControl?.NoStore);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            if (expected != OK) Assert.DoesNotContain(marker, Encoding.UTF8.GetString(bytes));
            return bytes;
        }
    }
}
