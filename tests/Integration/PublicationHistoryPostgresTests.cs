using System.Net;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Integration.Tests;
using FsusBlog.V2.Server;
using Npgsql;

public sealed class PublicationHistoryPostgresTests
{
    [PostgresFact]
    public async Task PublicTransitionsAppendLineageAndCommitWithTheirOutbox()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var actor = Guid.NewGuid();
        var ticket = RandomNumberGenerator.GetBytes(32);
        await Execute("insert into public.blog_user values($1,'Publication history owner',true,true,1)", actor);
        await Execute("insert into public.login_ticket values($1,$2,now()+interval '2 minutes')", SHA256.HashData(ticket), actor);
        var session = await new Store(fixture.DataSource).SignIn(Convert.ToHexStringLower(ticket), ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        var created = Wire.DecodeDraft(await Post(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "First publication", "First body")));
        var initialCommand = Mutation(created);
        var initial = Wire.DecodeDraft(await Post(WireRoutes.Publish, initialCommand));
        var initialId = await ActiveId();
        var initialHistory = Assert.Single(await History());
        Assert.Equal(new Event(1, initial.Revision, 1, initialId, null, "publish", "author-published", actor, initialCommand.IdempotencyKey),
            initialHistory);
        Assert.Equal(initial.Revision, await Scalar<long>("select revision from public.article_publication where article_id=$1", created.Id));
        Assert.Equal(1L, await Scalar<long>("""
            select count(*) from public.article_publication p
            join public.article_publication_history h on h.article_id=p.article_id and h.publication_id=p.publication_id
            where p.article_id=$1 and h.happened_at=p.published_at and h.happened_at<=h.recorded_at
            """, created.Id));
        var saved = Wire.DecodeDraft(await Post(WireRoutes.Save,
            new(created.Id, initial.Revision, Guid.NewGuid(), "Replacement publication", "Second body")));
        Assert.Equal(initialHistory, Assert.Single(await History()));

        var replaceCommand = Mutation(saved);
        await Execute("alter table public.blog_outbox add constraint forced_history_failure check (kind <> 'publish') not valid");
        await Post(WireRoutes.Publish, replaceCommand, HttpStatusCode.ServiceUnavailable);
        await Execute("alter table public.blog_outbox drop constraint forced_history_failure");
        Assert.Equal(initialHistory, Assert.Single(await History()));
        Assert.Equal(initialId, await ActiveId());
        Assert.Equal(saved.Revision, await Scalar<long>("select revision from public.article where id=$1", created.Id));
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_command where command_id=$1", replaceCommand.IdempotencyKey));
        Assert.Contains("First body", await server.Client.GetStringAsync($"/article/{created.Id}", ct));

        var concurrent = await Task.WhenAll(Post(WireRoutes.Publish, replaceCommand), Post(WireRoutes.Publish, replaceCommand));
        Assert.Equal(concurrent[0], concurrent[1]);
        var replacement = Wire.DecodeDraft(concurrent[0]);
        var replacementId = await ActiveId();
        Assert.NotEqual(initialId, replacementId);
        await Post(WireRoutes.Retract, replaceCommand, HttpStatusCode.Conflict);
        await Post(WireRoutes.Retract, replaceCommand with { IdempotencyKey = Guid.NewGuid() }, HttpStatusCode.Conflict);
        Assert.Contains("Second body", await server.Client.GetStringAsync($"/article/{created.Id}", ct));

        var retractCommand = Mutation(replacement);
        var retracted = Wire.DecodeDraft(await Post(WireRoutes.Retract, retractCommand));
        using (var hidden = await server.Client.GetAsync($"/article/{created.Id}", ct))
            Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
        var republishCommand = Mutation(retracted);
        var republished = Wire.DecodeDraft(await Post(WireRoutes.Publish, republishCommand));
        var republishedId = await ActiveId();
        var deleteCommand = Mutation(republished);
        var deleted = await Post(WireRoutes.Delete, deleteCommand);
        Assert.Equal(deleted, await Post(WireRoutes.Delete, deleteCommand));
        using (var hidden = await server.Client.GetAsync($"/article/{created.Id}", ct))
            Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
        Assert.Equal(0L, await Scalar<long>("select count(*) from public.article_publication where article_id=$1", created.Id));

        Assert.Equal(new[]
        {
            initialHistory,
            new Event(2, replacement.Revision, 2, replacementId, initialId, "replace", "author-replaced", actor, replaceCommand.IdempotencyKey),
            new Event(3, retracted.Revision, 2, null, replacementId, "retract", "author-withdrew", actor, retractCommand.IdempotencyKey),
            new Event(4, republished.Revision, 3, republishedId, null, "publish", "author-published", actor, republishCommand.IdempotencyKey),
            new Event(5, republished.Revision + 1, 3, null, republishedId, "delete", "author-deleted", actor, deleteCommand.IdempotencyKey),
        }, await History());
        Assert.Equal(5L, await Scalar<long>("""
            select count(*) from public.article_publication_history h
            join public.blog_outbox o on o.article_id=h.article_id and o.revision=h.revision
                and o.kind=case when h.kind='replace' then 'publish' else h.kind end
            where h.article_id=$1
            """, created.Id));

        // Direct fixture-style imports retain only the observed active release before the first real mutation.
        var imported = Wire.DecodeDraft(await Post(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Imported article", "Retained body")));
        await Execute("update public.article set published_revision=revision,publication_count=4 where id=$1", imported.Id);
        await Execute("insert into public.article_publication(article_id,revision,publication_no,published_at) values($1,$2,4,now())",
            imported.Id, imported.Revision);
        var observedId = await Scalar<long>("select publication_id from public.article_publication where article_id=$1", imported.Id);
        var importedCommand = Mutation(imported);
        var firstObserved = Wire.DecodeDraft(await Post(WireRoutes.Publish, importedCommand));
        var importedHistory = await History(imported.Id);
        Assert.Equal(new Event(1, imported.Revision, 4, observedId, null, "retained-active", "pre-history", null, null), importedHistory[0]);
        Assert.Equal((firstObserved.Revision, 5, observedId, "replace"), (importedHistory[1].Revision,
            importedHistory[1].PublicationNo, importedHistory[1].Supersedes, importedHistory[1].Kind));

        Task<long> ActiveId() => Scalar<long>("select publication_id from public.article_publication where article_id=$1", created.Id);

        async Task<Event[]> History(int? article = null)
        {
            await using var cmd = Store.Sql(db, null, """
                select event_no,revision,publication_no,publication_id,supersedes_id,kind,reason,actor_id,command_id
                from public.article_publication_history where article_id=$1 order by event_no
                """, article ?? created.Id);
            await using var rows = await cmd.ExecuteReaderAsync(ct);
            var result = new List<Event>();
            while (await rows.ReadAsync(ct))
                result.Add(new(rows.GetInt32(0), rows.GetInt64(1), rows.GetInt32(2), rows.IsDBNull(3) ? null : rows.GetInt64(3),
                    rows.IsDBNull(4) ? null : rows.GetInt64(4), rows.GetString(5), rows.GetString(6),
                    rows.IsDBNull(7) ? null : rows.GetGuid(7), rows.IsDBNull(8) ? null : rows.GetGuid(8)));
            return result.ToArray();
        }

        Task Execute(string sql, params object[] values) =>
            FixtureSql.ExecuteAsync(db, null, ct, sql, values);

        async Task<T> Scalar<T>(string sql, params object[] values)
        {
            return (T)(await FixtureSql.ScalarAsync(db, null, ct, sql, values))!;
        }

        Task<byte[]> Post(string route, ArticleCommand command, HttpStatusCode expected = HttpStatusCode.OK) =>
            SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Post, route, Wire.EncodeArticleCommand(command),
                session.Token, null, expected, ct);
    }

    private static ArticleCommand Mutation(Draft draft) => new(draft.Id, draft.Revision, Guid.NewGuid(), "", "");

    private sealed record Event(int EventNo, long Revision, int PublicationNo, long? Publication, long? Supersedes,
        string Kind, string Reason, Guid? Actor, Guid? Command);

}
