using System.Net;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Authoring;
using Npgsql;

public sealed class ArticleSchedulePostgresTests
{
    [PostgresFact]
    public async Task ScheduledDraftKeepsItsPublicPredecessorAndConsumesOnlyItsExactDueCommand()
    {
        using var stop = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = stop.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var author = Guid.NewGuid();
        var ticket = RandomNumberGenerator.GetBytes(32);
        await Execute("insert into public.blog_user values($1,'Scheduled author',true,true,1)", author);
        await Execute("insert into public.login_ticket values($1,$2,now()+interval '2 minutes')", SHA256.HashData(ticket), author);
        var session = await new Store(fixture.DataSource).SignIn(Convert.ToHexStringLower(ticket), ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var first = await Write(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Original", "original body"));
        var published = await Write(WireRoutes.Publish, new(first.Id, first.Revision, Guid.NewGuid(), "", ""));
        var publicId = await Scalar<long>("select publication_id from public.article_publication where article_id=$1", first.Id);
        var draft = await Write(WireRoutes.Save, new(first.Id, published.Revision, Guid.NewGuid(), "Replacement", "replacement body"));
        var dbNow = await Scalar<DateTime>("select clock_timestamp()");
        var future = new DateTimeOffset(dbNow).AddHours(1).ToUnixTimeMilliseconds();
        var past = new DateTimeOffset(dbNow).AddSeconds(-1).ToUnixTimeMilliseconds();
        var intent = new ArticleScheduleCommand(draft.Id, draft.Revision, Guid.NewGuid(), future);
        await Submit(intent with { DueUnixMs = past }, HttpStatusCode.BadRequest);
        var duplicates = await Task.WhenAll(Submit(intent), Submit(intent));
        Assert.Equal(duplicates[0], duplicates[1]);
        var pending = Wire.DecodeArticleSchedule(duplicates[0]);
        Assert.Equal((draft.Revision + 1, published.Revision, future), (pending.Revision, pending.PublishedRevision, pending.DueUnixMs));
        Assert.Equal(pending, await Read(draft.Id, pending.Revision));
        Assert.Contains("original body", await server.Client.GetStringAsync($"/article/{draft.Id}", ct));
        await Submit(intent with { DueUnixMs = future + 10 }, HttpStatusCode.Conflict);
        await Submit(intent with { IdempotencyKey = Guid.NewGuid() }, HttpStatusCode.Conflict);
        Assert.Equal(0, await Tick(future - 1));
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.article_publication_canonical where article_id=$1", draft.Id));

        var newDue = future + 10_000;
        var replaced = Wire.DecodeArticleSchedule(await Submit(new(draft.Id, pending.Revision, Guid.NewGuid(), newDue)));
        Assert.Equal(0, await Tick(future));
        var cancelled = Wire.DecodeArticleSchedule(await Submit(new(draft.Id, replaced.Revision, Guid.NewGuid(), 0)));
        Assert.Equal(0L, cancelled.DueUnixMs);
        Assert.Equal(0, await Tick(newDue));
        var obsolete = Wire.DecodeArticleSchedule(await Submit(new(draft.Id, cancelled.Revision, Guid.NewGuid(), newDue)));
        var modified = await Write(WireRoutes.Save, new(draft.Id, obsolete.Revision, Guid.NewGuid(), "Replacement", "replacement body"));
        Assert.Equal(0L, (await Read(draft.Id, modified.Revision)).DueUnixMs);
        Assert.Equal(0, await Tick(newDue));
        var finalCommand = new ArticleScheduleCommand(draft.Id, modified.Revision, Guid.NewGuid(), newDue);
        var final = Wire.DecodeArticleSchedule(await Submit(finalCommand));

        // Existing account lock order means a due pass can skip a concurrent account update without deadlocking.
        await using (var account = await db.BeginTransactionAsync(ct))
        {
            await using var busy = Store.Sql(db, account, "select id from public.blog_user where id=$1 for update", author);
            await busy.ExecuteScalarAsync(ct);
            Assert.Equal(0, await Tick(newDue));
            await account.RollbackAsync(ct);
        }

        await Execute("alter table public.blog_outbox add constraint forced_scheduler_failure check (kind <> 'publish') not valid");
        await Assert.ThrowsAsync<PostgresException>(() => Tick(newDue));
        Assert.Equal(final, await Read(draft.Id, final.Revision));
        Assert.Equal(publicId, await Scalar<long>("select publication_id from public.article_publication where article_id=$1", draft.Id));
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.article_publication_history where article_id=$1", draft.Id));
        await Execute("alter table public.blog_outbox drop constraint forced_scheduler_failure");

        var batch = await Task.WhenAll(Tick(newDue), Tick(newDue));
        Assert.Equal(new[] { 0, 1 }, batch.Order());
        Assert.Equal(final.Revision, await Scalar<long>("select revision from public.article_publication where article_id=$1", draft.Id));
        Assert.Equal(final.Revision, await Scalar<long>("select revision from public.article where id=$1", draft.Id));
        Assert.Equal(publicId, await Scalar<long>("select supersedes_id from public.article_publication_history where article_id=$1 and event_no=2", draft.Id));
        Assert.Equal("scheduled-replaced", await Scalar<string>("select reason from public.article_publication_history where article_id=$1 and event_no=2", draft.Id));
        Assert.Equal(finalCommand.IdempotencyKey, await Scalar<Guid>("select command_id from public.article_publication_history where article_id=$1 and event_no=2", draft.Id));
        Assert.Equal(1L, await Scalar<long>("select count(*) from public.blog_outbox where article_id=$1 and revision=$2 and kind='publish'", draft.Id, final.Revision));
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.article_publication_canonical c
            join public.article_publication p on p.publication_id=c.publication_id and p.published_at=c.published_at
            join public.blog_outbox o on o.id=c.outbox_id and o.kind='publish' and o.revision=p.revision
            where c.article_id=$1 and c.revision=$2 and c.transition='replace'
            """, draft.Id, final.Revision));
        Assert.Equal(0L, (await Read(draft.Id, final.Revision)).DueUnixMs);
        Assert.Equal(final, Wire.DecodeArticleSchedule(await Submit(finalCommand)));
        await Submit(new(draft.Id, final.Revision, Guid.NewGuid(), 0), HttpStatusCode.Conflict);

        var neverPublic = await Write(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Never public", "private"));
        await Submit(new(neverPublic.Id, neverPublic.Revision, Guid.NewGuid(), newDue));
        await Execute("update public.blog_user set generation=generation+1 where id=$1", author);
        Assert.Equal(0, await Tick(newDue));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_schedule where article_id=$1", neverPublic.Id));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_publication where article_id=$1", neverPublic.Id));

        var newTicket = RandomNumberGenerator.GetBytes(32);
        await Execute("insert into public.login_ticket values($1,$2,now()+interval '2 minutes')", SHA256.HashData(newTicket), author);
        session = await new Store(fixture.DataSource).SignIn(Convert.ToHexStringLower(newTicket), ct);
        var workerDraft = await Write(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Real worker", "real worker body"));
        var realDue = new DateTimeOffset(await Scalar<DateTime>("select clock_timestamp()")).AddSeconds(3).ToUnixTimeMilliseconds();
        var workerReceipt = Wire.DecodeArticleSchedule(await Submit(new(workerDraft.Id, workerDraft.Revision, Guid.NewGuid(), realDue)));
        using (var hidden = await server.Client.GetAsync($"/article/{workerDraft.Id}", ct))
            Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
        using (var timer = new CancellationTokenSource(TimeSpan.FromSeconds(12)))
        {
            while (true)
            {
                using var response = await server.Client.GetAsync($"/article/{workerDraft.Id}", timer.Token);
                if (response.StatusCode == HttpStatusCode.OK)
                {
                    Assert.Contains("real worker body", await response.Content.ReadAsStringAsync(timer.Token));
                    break;
                }
                Assert.True(response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.ServiceUnavailable);
                await Task.Delay(50, timer.Token);
            }
        }
        Assert.Equal(workerReceipt.Revision,
            await Scalar<long>("select revision from public.article_publication where article_id=$1", workerDraft.Id));
        Assert.Equal("scheduled-published", await Scalar<string>("select reason from public.article_publication_history where article_id=$1",
            workerDraft.Id));

        async Task<int> Tick(long now)
        {
            await using var connection = await fixture.DataSource.OpenConnectionAsync(ct);
            await using var tx = await connection.BeginTransactionAsync(ct);
            var result = await ArticleScheduleStore.PublishDue(connection, tx, ct, DateTimeOffset.FromUnixTimeMilliseconds(now).UtcDateTime);
            await tx.CommitAsync(ct);
            return result;
        }
        async Task<ArticleSchedule> Read(int id, long revision)
        {
            var path = WireRoutes.DraftSchedule.Replace("{id:int}", id.ToString()) + $"?revision={revision}";
            return Wire.DecodeArticleSchedule(await Request(HttpMethod.Get, path, null, HttpStatusCode.OK));
        }
        async Task<Draft> Write(string route, ArticleCommand command) =>
            Wire.DecodeDraft(await Request(HttpMethod.Post, route, Wire.EncodeArticleCommand(command), HttpStatusCode.OK));
        Task<byte[]> Submit(ArticleScheduleCommand input, HttpStatusCode status = HttpStatusCode.OK) =>
            Request(HttpMethod.Post, WireRoutes.DraftScheduleCommand, Wire.EncodeArticleScheduleCommand(input), status);
        async Task<byte[]> Request(HttpMethod method, string route, byte[]? body, HttpStatusCode status)
        {
            using var request = new HttpRequestMessage(method, route);
            request.Headers.Add("Cookie", $"fsus-v2-session={session.Token}");
            if (body is not null)
            {
                request.Content = new ByteArrayContent(body);
                request.Content.Headers.ContentType = new(Aeds.ContentType);
            }
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
        async Task Execute(string sql, params object[] values)
        {
            await using var cmd = Store.Sql(db, null, sql, values);
            await cmd.ExecuteNonQueryAsync(ct);
        }
        async Task<T> Scalar<T>(string sql, params object[] values)
        {
            await using var cmd = Store.Sql(db, null, sql, values);
            return (T)(await cmd.ExecuteScalarAsync(ct))!;
        }
    }
}
