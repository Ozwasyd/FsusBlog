using System.Net;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;

public sealed class ArticleTrashPostgresTests
{
    [PostgresFact]
    public async Task SoftDeleteFailsClosedAndRestorationKeepsExactPrivateRevisionAndLineage()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = (await fixture.SignIn("trash owner", ct, canAuthor: true, minutes: 1)).Token;
        var other = (await fixture.SignIn("other author", ct, canAuthor: true, minutes: 1)).Token;
        var reader = (await fixture.SignIn("site reader", ct, canAuthor: false, minutes: 1)).Token;
        await Sql("insert into public.category(id,name) values(41,'Taxonomy category'); insert into public.tag(id,name) values(81,'Taxonomy tag');");
        var settings = new Dictionary<string, string> { ["FSUSBLOG_PUBLIC_ORIGIN"] = "https://blog.example.test" };
        const string marker = "Article trash public marker";
        Draft restored;
        string publicPath;
        string editorPath;
        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, settings))
        {
            var client = server.Client;
            const string title = "Latest private revision";
            const string body = "Latest Markdown body with ![image](/media/keep.png).";
            const string propertyValue = "Preserved private property";
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
            var due = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds();
            var schedule = Wire.DecodeArticleSchedule(await Post(WireRoutes.DraftScheduleCommand,
                Wire.EncodeArticleScheduleCommand(new(draft.Id, taxonomy.Revision, Guid.NewGuid(), due)), owner));
            var definition = new PropertyDefinitionCommand(1, Guid.NewGuid(), Guid.NewGuid(), 0, 0, "subtitle", "Subtitle");
            _ = Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertyDefinitionCommand, Wire.EncodePropertyDefinitionCommand(definition), owner));
            var property = new PropertyTextCommand(draft.Id, schedule.Revision, 1, 0, definition.DefinitionId, 1, Guid.NewGuid(), false, propertyValue);
            _ = Wire.DecodePropertyCommandReceipt(await Post(WireRoutes.PropertyTextCommand, Wire.EncodePropertyTextCommand(property), owner));
            var delete = Mutation(draft.Id, schedule.Revision);
            var restore = Mutation(draft.Id, schedule.Revision + 1);
            await Command(WireRoutes.Restore, delete, owner, HttpStatusCode.Conflict);
            await Command(WireRoutes.Delete, delete with { ExpectedRevision = saved.Revision }, owner, HttpStatusCode.Conflict);
            await Command(WireRoutes.Delete, delete, other, HttpStatusCode.NotFound);

            // Force a post-commit projection failure for the real delete command. The old public artifacts must close immediately.
            await Sql("alter table public.blog_outbox add constraint test_delete_projection_failure check (kind <> 'delete' or processed_at is null)");
            await Command(WireRoutes.Delete, delete, owner, HttpStatusCode.ServiceUnavailable);
            foreach (var path in new[] { "/health/ready", "/", publicPath, binaryPath, WireRoutes.PublicIndex,
                         WireRoutes.PublicSearchCorpus, "/feed/rss.xml", "/feed/atom.xml", "/feed/feed.json", "/sitemap.xml" })
                await Read(client, path, HttpStatusCode.ServiceUnavailable);
            Assert.Equal(1L, (long)(await Sql("select count(*) from public.blog_outbox where article_id=$1 and kind='delete' and processed_at is null", draft.Id))!);
            Assert.Equal(0L, (long)(await Sql("select count(*) from public.article_schedule where article_id=$1", draft.Id))!);
            await Sql("alter table public.blog_outbox drop constraint test_delete_projection_failure");
            Aeds.Decode(await Command(WireRoutes.Delete, delete, owner), FrameType.EmptySuccess);
            await Read(client, publicPath, HttpStatusCode.NotFound);
            await Read(client, binaryPath, HttpStatusCode.NotFound);
            await Read(client, editorPath, HttpStatusCode.NotFound, owner);
            Assert.Equal("publish,delete", await History());

            await Command(WireRoutes.Restore, restore, null, HttpStatusCode.Unauthorized);
            await Command(WireRoutes.Restore, restore, reader, HttpStatusCode.Forbidden);
            await Command(WireRoutes.Restore, restore, other, HttpStatusCode.NotFound);
            await Command(WireRoutes.Restore, restore with { ExpectedRevision = delete.ExpectedRevision }, owner, HttpStatusCode.Conflict);

            // A failed private outbox insert must roll restore back. Exact retries then commit one revision only.
            await Sql("alter table public.blog_outbox add constraint test_restore_rollback check (kind <> 'restore')");
            await Command(WireRoutes.Restore, restore, owner, HttpStatusCode.ServiceUnavailable);
            await Read(client, editorPath, HttpStatusCode.NotFound, owner);
            await Sql("alter table public.blog_outbox drop constraint test_restore_rollback");
            var results = await Task.WhenAll(Command(WireRoutes.Restore, restore, owner), Command(WireRoutes.Restore, restore, owner));
            Assert.Equal(results[0], results[1]);
            restored = Wire.DecodeDraft(results[0]);
            Assert.Equal(new Draft(draft.Id, restore.ExpectedRevision + 1, title, body, false), restored);
            await Command(WireRoutes.Restore, restore with { IdempotencyKey = Guid.NewGuid() }, owner, HttpStatusCode.Conflict);
            await Command(WireRoutes.Delete, restore, owner, HttpStatusCode.Conflict);
            Assert.Equal(1L, (long)(await Sql("select count(*) from public.blog_outbox where article_id=$1 and kind='restore'", draft.Id))!);
            Assert.Equal("publish,delete", await History());
            var recoveredTaxonomy = Wire.DecodeDraftTaxonomy(await Read(client,
                $"{WireRoutes.DraftTaxonomy.Replace("{id:int}", draft.Id.ToString())}?revision={restored.Revision}", HttpStatusCode.OK, owner));
            Assert.Equal((restored.Revision, 41, 81), (recoveredTaxonomy.Revision, recoveredTaxonomy.CategoryId,
                Assert.Single(recoveredTaxonomy.TagIds)));
            var restoredProperty = Wire.DecodePropertyWorkspace(await Post(WireRoutes.PropertyWorkspace,
                Wire.EncodePropertyWorkspaceRequest(new(draft.Id, restored.Revision, 0, 0, "")), owner));
            Assert.Equal(propertyValue, Assert.Single(restoredProperty.Fields).Value);
            Assert.Equal(marker, await Sql("select title from public.article_revision where article_id=$1 and revision=$2", draft.Id, publicDraft.Revision));
            await Read(client, publicPath, HttpStatusCode.NotFound);
            await Read(client, binaryPath, HttpStatusCode.NotFound);
            Assert.DoesNotContain(marker, await client.GetStringAsync("/feed/rss.xml", ct));
            Assert.DoesNotContain(publicPath, await client.GetStringAsync("/sitemap.xml", ct));

            ArticleCommand Mutation(int id, long revision) => new(id, revision, Guid.NewGuid(), "", "");

            Task<byte[]> Command(string path, ArticleCommand command, string? token, HttpStatusCode expected = HttpStatusCode.OK) =>
                Post(path, Wire.EncodeArticleCommand(command), token, expected);

            async Task<byte[]> Post(string path, byte[] frame, string? token, HttpStatusCode expected = HttpStatusCode.OK)
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new ByteArrayContent(frame) };
                request.Content.Headers.ContentType = new(Aeds.ContentType);
                return await Send(client, request, token, expected);
            }

            Task<object?> History() => Sql("select string_agg(kind, ',' order by event_no) from public.article_publication_history where article_id=$1", draft.Id);
        }

        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct, settings);
        await Read(restarted.Client, publicPath, HttpStatusCode.NotFound);
        Assert.Equal(restored, Wire.DecodeDraft(await Read(restarted.Client, editorPath, HttpStatusCode.OK, owner)));

        async Task<byte[]> Read(HttpClient endpoint, string path, HttpStatusCode expected, string? token = null)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, path);
            return await Send(endpoint, request, token, expected);
        }

        async Task<byte[]> Send(HttpClient endpoint, HttpRequestMessage request, string? token, HttpStatusCode expected)
        {
            if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            using var response = await endpoint.SendAsync(request, ct);
            Assert.Equal(expected, response.StatusCode);
            if (expected != HttpStatusCode.OK || token is not null) Assert.True(response.Headers.CacheControl?.NoStore);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            if (expected != HttpStatusCode.OK) Assert.DoesNotContain(marker, System.Text.Encoding.UTF8.GetString(bytes));
            return bytes;
        }

        Task<object?> Sql(string sql, params object[] parameters) =>
            FixtureSql.ScalarAsync(db, null, ct, sql, parameters);

    }
}
