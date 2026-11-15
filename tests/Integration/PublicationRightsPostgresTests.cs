using System.Buffers.Binary;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;
using Npgsql;

public sealed class PublicationRightsPostgresTests
{
    [PostgresFact]
    public async Task PreviousCatalogStillPublishesWithItsOwnOutbox()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var actor = Guid.NewGuid();
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        await using (var prepare = new NpgsqlCommand("""
            drop table public.publication_transparency_head, public.article_publication_transparency,
                public.article_publication_proof, public.publication_proof_key, public.article_publication_canonical;
            alter table public.article_publication_history drop constraint publication_history_native_binding;
            alter table public.article_publication_rights drop constraint publication_rights_native_binding;
            alter table public.blog_outbox drop constraint outbox_native_publication_binding;
            """, db)) await prepare.ExecuteNonQueryAsync(ct);
        await FixtureSql.ExecuteAsync(db, null, ct, "insert into public.blog_user values($1,'Previous catalog author',true,true,1)", actor);
        await using (var session = Store.Sql(db, null,
            "insert into public.user_session (digest,user_id,generation,expires_at) values($1,$2,1,clock_timestamp()+interval '5 minutes')",
            Store.TokenDigest(token)!, actor)) await session.ExecuteNonQueryAsync(ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var draft = await Send(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Prior catalog", "Without canonical storage"));
        var published = await Send(WireRoutes.Publish, new(draft.Id, draft.Revision, Guid.NewGuid(), "", ""));
        Assert.Contains("Without canonical storage", await server.Client.GetStringAsync($"/article/{draft.Id}", ct));
        await using var outbox = Store.Sql(db, null,
            "select count(*) from public.blog_outbox where kind='publish' and article_id=$1 and revision=$2", draft.Id, published.Revision);
        Assert.Equal(1L, (long)(await outbox.ExecuteScalarAsync(ct))!);

        async Task<Draft> Send(string path, ArticleCommand command)
        {
            using var request = SiteAedsFixture.Request(HttpMethod.Post, path, Wire.EncodeArticleCommand(command), token, handle: null);
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
        }
    }

    [PostgresFact]
    public async Task OnlyTheExactPublicationSnapshotIsPublicAndItSurvivesSubsequentEdits()
    {
        using var stop = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = stop.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var author = await SignIn("Rights owner");
        var other = await SignIn("Other rights owner");
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var initial = await Save(0, 0, "Rights marker", "Rights test body");
        var expected = Wire.DefaultRights(initial.Id, initial.Revision);
        Assert.Equal(expected, await Policy(initial, author));
        var change = new ArticleRightsCommand(initial.Id, initial.Revision, Guid.NewGuid(), true, "CC-BY-SA-4.0",
            "First holder & Co", 2026, "Original rights statement", "Credit {holder}", "excerpt-only", 240, false, true, false);
        await Set(change, other, HttpStatusCode.NotFound);
        await Set(change, null, HttpStatusCode.Unauthorized);
        var edited = Wire.DecodeArticleRightsPolicy(await Set(change, author));
        Assert.Equal(Wire.RightsPolicy(change, initial.Revision + 1), edited);
        Assert.Equal(edited, Wire.DecodeArticleRightsPolicy(await Set(change, author)));
        await Set(change with { LicenseType = "CC0-1.0" }, author, HttpStatusCode.Conflict);
        await Set(change with { IdempotencyKey = Guid.NewGuid() }, author, HttpStatusCode.Conflict);
        var firstCommand = Guid.NewGuid();
        var firstRelease = await Publish(initial.Id, edited.Revision, key: firstCommand);
        Assert.Equal(firstRelease, await Publish(initial.Id, edited.Revision, key: firstCommand));
        Assert.Equal(1L, await CanonicalCount(initial.Id));
        var firstRights = await Detail(initial.Id);
        Assert.Equal(("CC-BY-SA-4.0", "First holder & Co", "Original rights statement"),
            (firstRights.License, firstRights.Holder, firstRights.Statement));
        Assert.Equal(1 | 4 | 16 | 32 | 64 | 128, firstRights.Flags);
        var path = $"/article/{initial.Id}";
        Assert.Contains("First holder &amp; Co", await server.Client.GetStringAsync(path, ct));

        var next = Wire.DecodeArticleRightsPolicy(await Set(change with
        {
            ExpectedRevision = firstRelease.Revision, IdempotencyKey = Guid.NewGuid(),
            LicenseType = "CC0-1.0", CopyrightHolder = "Private later holder", RightsStatement = ""
        }, author));
        Assert.Equal(firstRights, await Detail(initial.Id));
        Assert.DoesNotContain("Private later holder", await server.Client.GetStringAsync(path, ct));
        await Execute("alter table public.blog_outbox add constraint force_rights_rollback check (kind <> 'publish') not valid");
        await Publish(initial.Id, next.Revision, HttpStatusCode.ServiceUnavailable);
        Assert.Equal(1L, await CanonicalCount(initial.Id));
        await Execute("alter table public.blog_outbox drop constraint force_rights_rollback");
        Assert.Equal(firstRights, await Detail(initial.Id));
        Assert.Equal(1L, await Count("select count(*) from public.article_publication_rights where article_id=$1", initial.Id));
        // Fail after the publish outbox has been written. The entire release, including outbox and history, must roll back.
        await Execute("alter table public.article_publication_canonical add constraint force_canonical_rollback check (publication_no=1) not valid");
        await Publish(initial.Id, next.Revision, HttpStatusCode.ServiceUnavailable);
        Assert.Equal(1L, await CanonicalCount(initial.Id));
        Assert.Equal(1L, await Count("select count(*) from public.blog_outbox where article_id=$1 and kind='publish'", initial.Id));
        Assert.Equal(firstRights, await Detail(initial.Id));
        await Execute("alter table public.article_publication_canonical drop constraint force_canonical_rollback");
        var secondRelease = await Publish(initial.Id, next.Revision);
        var secondRights = await Detail(initial.Id);
        Assert.NotEqual(firstRights.Id, secondRights.Id);
        Assert.Equal(secondRelease.Revision, secondRights.Revision);
        Assert.Equal("CC0-1.0", secondRights.License);
        Assert.Equal(2L, await CanonicalCount(initial.Id));
        Assert.Equal(2L, await Count("""
            select count(distinct x.policy_sha256) from public.article_publication_canonical x where x.article_id=$1
            """, initial.Id));
        var mismatch = await Assert.ThrowsAsync<PostgresException>(() => Execute("""
            update public.article_publication_canonical x set outbox_id=o.id
            from public.blog_outbox o where x.article_id=$1 and x.publication_no=2 and o.article_id=$1 and o.kind='save'
            """, initial.Id));
        Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, mismatch.SqlState);
        Assert.Equal(2L, await Count("select count(*) from public.article_publication_rights where article_id=$1", initial.Id));
        Assert.Equal("First holder & Co", await Scalar<string>("""
            select w.copyright_holder from public.article_revision_rights w join public.article_publication_rights s
            using (article_id,revision) where s.id=$1
            """, firstRights.Id));

        // Simulate an article imported before rights storage existed. Existing current pointer is retained privately.
        var missing = await Save(0, 0, "Untracked legacy marker", "Untracked legacy body");
        await Execute("delete from public.article_revision_rights where article_id=$1", missing.Id);
        await Execute("update public.article set published_revision=revision,publication_count=1 where id=$1", missing.Id);
        await Execute("insert into public.article_publication(article_id,revision,published_at) values($1,$2,now())", missing.Id, missing.Revision);
        await Execute("insert into public.blog_outbox(article_id,revision,kind) values($1,$2,'publish')", missing.Id, missing.Revision);
        Assert.False((await Policy(missing, author)).Present);
        await Publish(missing.Id, missing.Revision, HttpStatusCode.Conflict);
        using (var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(8)))
            while (await Count("select count(*) from public.blog_outbox where article_id=$1 and processed_at is null", missing.Id) != 0)
                await Task.Delay(25, deadline.Token);
        using (var hidden = await server.Client.GetAsync($"/article/{missing.Id}", ct))
            Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
        using (var hidden = await server.Client.GetAsync(WireRoutes.PublicArticle.Replace("{id}", missing.Id.ToString()), ct))
            Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
        Assert.DoesNotContain("Untracked legacy marker", await server.Client.GetStringAsync("/", ct));

        async Task<string> SignIn(string name)
        {
            var id = Guid.NewGuid();
            var ticket = RandomNumberGenerator.GetBytes(32);
            await Execute("insert into public.blog_user values($1,$2,true,true,1)", id, name);
            await Execute("insert into public.login_ticket values($1,$2,now()+interval '2 minutes')", SHA256.HashData(ticket), id);
            return (await new Store(fixture.DataSource).SignIn(Convert.ToHexStringLower(ticket), ct)).Token;
        }
        async Task<ArticleRightsPolicy> Policy(Draft draft, string token) =>
            Wire.DecodeArticleRightsPolicy(await Response(HttpMethod.Get,
                WireRoutes.DraftRights.Replace("{id:int}", draft.Id.ToString()) + $"?revision={draft.Revision}",
                token, null, HttpStatusCode.OK));
        Task<byte[]> Set(ArticleRightsCommand input, string? token, HttpStatusCode status = HttpStatusCode.OK) =>
            Response(HttpMethod.Post, WireRoutes.DraftRightsCommand, token, Wire.EncodeArticleRightsCommand(input), status);
        async Task<Draft> Save(int id, long revision, string title, string body) =>
            Wire.DecodeDraft(await Response(HttpMethod.Post, WireRoutes.Save, author,
                Wire.EncodeArticleCommand(new(id, revision, Guid.NewGuid(), title, body)), HttpStatusCode.OK));
        Task<long> CanonicalCount(int id) => Count("""
            select count(*) from public.article_publication_canonical x
            join public.blog_outbox o on (o.id,o.article_id,o.revision,o.kind)=(x.outbox_id,x.article_id,x.revision,'publish')
            join public.article_publication_history h on (h.publication_id,h.publication_no,h.happened_at)=(x.publication_id,x.publication_no,x.published_at)
            where x.article_id=$1 and x.canonical_version=2
            """, id);
        async Task<Draft> Publish(int id, long revision, HttpStatusCode status = HttpStatusCode.OK, Guid? key = null)
        {
            var packet = await Response(HttpMethod.Post, WireRoutes.Publish, author,
                Wire.EncodeArticleCommand(new(id, revision, key ?? Guid.NewGuid(), "", "")), status);
            return status == HttpStatusCode.OK ? Wire.DecodeDraft(packet) : null!;
        }
        async Task<byte[]> Response(HttpMethod method, string route, string? token, byte[]? body, HttpStatusCode status)
        {
            using var request = SiteAedsFixture.Request(method, route, body, token, handle: null);
            using var response = await server.Client.SendAsync(request, ct);
            var bytes = await response.Content.ReadAsByteArrayAsync(ct);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return bytes;
        }
        async Task<(long Id, long Revision, int Flags, string License, string Holder, string Statement)> Detail(int id)
        {
            var bytes = Aeds.Decode(await Response(HttpMethod.Get, WireRoutes.PublicArticle.Replace("{id}", id.ToString()),
                null, null, HttpStatusCode.OK), FrameType.ArticleDetail).ToArray();
            var rights = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(28));
            var blob = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(36));
            return (BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(rights)), BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(rights + 8)),
                BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(rights + 20)), Slice(32), Slice(40), Slice(48));
            string Slice(int slot) => Encoding.UTF8.GetString(bytes, blob + BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(rights + slot)),
                BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(rights + slot + 4)));
        }
        Task Execute(string sql, params object[] args) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, args);
        Task<long> Count(string sql, params object[] args) => Scalar<long>(sql, args);
        async Task<T> Scalar<T>(string sql, params object[] args)
        {
            return (T)(await FixtureSql.ScalarAsync(db, null, ct, sql, args))!;
        }
    }
}
