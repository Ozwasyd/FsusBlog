public sealed class PublicationHistoryPostgresTests
{
    [PostgresFact]
    public async Task PublicTransitionsAppendLineageAndCommitWithTheirOutbox()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var (actor, token, _) = await fixture.SignIn("Publication history owner", ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);

        var created = Wire.DecodeDraft(await Post(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "First publication", "First body")));
        var initialCommand = Mutation(created);
        var initial = Wire.DecodeDraft(await Post(WireRoutes.Publish, initialCommand));
        var initialId = await ActiveId();
        var initialHistory = Assert.Single(await History());
        Assert.Equal(new Event(1, initial.Revision, 1, initialId, null, "publish", "author-published", actor, initialCommand.IdempotencyKey), initialHistory);
        Assert.Equal((initial.Revision, 1L), (
            await fixture.Scalar<long>("select revision from public.article_publication where article_id=$1", created.Id),
            await fixture.Scalar<long>("""
                select count(*) from public.article_publication p
                join public.article_publication_history h on h.article_id=p.article_id and h.publication_id=p.publication_id
                where p.article_id=$1 and h.happened_at=p.published_at and h.happened_at<=h.recorded_at
                """, created.Id)));
        var saved = Wire.DecodeDraft(await Post(WireRoutes.Save,
            new(created.Id, initial.Revision, Guid.NewGuid(), "Replacement publication", "Second body")));
        Assert.Equal(initialHistory, Assert.Single(await History()));

        var replaceCommand = Mutation(saved);
        await fixture.Exec("alter table public.blog_outbox add constraint forced_history_failure check (kind <> 'publish') not valid");
        await Post(WireRoutes.Publish, replaceCommand, ServiceUnavailable);
        await fixture.Exec("alter table public.blog_outbox drop constraint forced_history_failure");
        Assert.Equal((initialHistory, initialId, saved.Revision, 0L), (Assert.Single(await History()), await ActiveId(),
            await fixture.Scalar<long>("select revision from public.article where id=$1", created.Id),
            await fixture.Scalar<long>("select count(*) from public.article_command where command_id=$1", replaceCommand.IdempotencyKey)));
        Assert.Contains("First body", await server.Client.GetStringAsync($"/article/{created.Id}", ct));

        var concurrent = await Task.WhenAll(Post(WireRoutes.Publish, replaceCommand), Post(WireRoutes.Publish, replaceCommand));
        Assert.Equal(concurrent[0], concurrent[1]);
        var replacement = Wire.DecodeDraft(concurrent[0]);
        var replacementId = await ActiveId();
        Assert.NotEqual(initialId, replacementId);
        await Post(WireRoutes.Retract, replaceCommand, Conflict);
        await Post(WireRoutes.Retract, replaceCommand with { IdempotencyKey = Guid.NewGuid() }, Conflict);
        Assert.Contains("Second body", await server.Client.GetStringAsync($"/article/{created.Id}", ct));

        var retractCommand = Mutation(replacement);
        var retracted = Wire.DecodeDraft(await Post(WireRoutes.Retract, retractCommand));
        await CheckStatusAsync(NotFound, server.Client.GetAsync($"/article/{created.Id}", ct));
        var republishCommand = Mutation(retracted);
        var republished = Wire.DecodeDraft(await Post(WireRoutes.Publish, republishCommand));
        var republishedId = await ActiveId();
        var deleteCommand = Mutation(republished);
        var deleted = await Post(WireRoutes.Delete, deleteCommand);
        Assert.Equal(deleted, await Post(WireRoutes.Delete, deleteCommand));
        await CheckStatusAsync(NotFound, server.Client.GetAsync($"/article/{created.Id}", ct));
        Assert.Equal(0L, await fixture.Scalar<long>("select count(*) from public.article_publication where article_id=$1", created.Id));

        Assert.Equal(new[]
        {
            initialHistory,
            new Event(2, replacement.Revision, 2, replacementId, initialId, "replace", "author-replaced", actor, replaceCommand.IdempotencyKey),
            new Event(3, retracted.Revision, 2, null, replacementId, "retract", "author-withdrew", actor, retractCommand.IdempotencyKey),
            new Event(4, republished.Revision, 3, republishedId, null, "publish", "author-published", actor, republishCommand.IdempotencyKey),
            new Event(5, republished.Revision + 1, 3, null, republishedId, "delete", "author-deleted", actor, deleteCommand.IdempotencyKey),
        }, await History());
        Assert.Equal(5L, await fixture.Scalar<long>("""
            select count(*) from public.article_publication_history h
            join public.blog_outbox o on o.article_id=h.article_id and o.revision=h.revision
                and o.kind=case when h.kind='replace' then 'publish' else h.kind end
            where h.article_id=$1
            """, created.Id));

        // Direct fixture-style imports retain only the observed active release before the first real mutation.
        var imported = Wire.DecodeDraft(await Post(WireRoutes.Save, new(0, 0, Guid.NewGuid(), "Imported article", "Retained body")));
        await fixture.Exec("update public.article set published_revision=revision,publication_count=4 where id=$1", imported.Id);
        await fixture.Exec("insert into public.article_publication(article_id,revision,publication_no,published_at) values($1,$2,4,now())",
            imported.Id, imported.Revision);
        var observedId = await fixture.Scalar<long>("select publication_id from public.article_publication where article_id=$1", imported.Id);
        var firstObserved = Wire.DecodeDraft(await Post(WireRoutes.Publish, Mutation(imported)));
        var importedHistory = await History(imported.Id);
        Assert.Equal(new Event(1, imported.Revision, 4, observedId, null, "retained-active", "pre-history", null, null), importedHistory[0]);
        Assert.Equal((firstObserved.Revision, 5, observedId, "replace"), (importedHistory[1].Revision,
            importedHistory[1].PublicationNo, importedHistory[1].Supersedes, importedHistory[1].Kind));

        Task<long> ActiveId() => fixture.Scalar<long>("select publication_id from public.article_publication where article_id=$1", created.Id);

        Task<List<Event>> History(int? article = null) => fixture.QueryRows("""
            select event_no,revision,publication_no,publication_id,supersedes_id,kind,reason,actor_id,command_id
            from public.article_publication_history where article_id=$1 order by event_no
            """, r => new Event(r.GetInt32(0), r.GetInt64(1), r.GetInt32(2), r.IsDBNull(3) ? null : r.GetInt64(3),
                r.IsDBNull(4) ? null : r.GetInt64(4), r.GetString(5), r.GetString(6),
                r.IsDBNull(7) ? null : r.GetGuid(7), r.IsDBNull(8) ? null : r.GetGuid(8)), article ?? created.Id);

        Task<byte[]> Post(string route, ArticleCommand command, HttpStatusCode expected = OK) =>
            SiteAedsFixture.ExpectStatus(server.Client, HttpMethod.Post, route, Wire.EncodeArticleCommand(command), token, null, expected, ct);
    }

    private static ArticleCommand Mutation(Draft draft) => new(draft.Id, draft.Revision, Guid.NewGuid(), "", "");

    private sealed record Event(int EventNo, long Revision, int PublicationNo, long? Publication, long? Supersedes,
        string Kind, string Reason, Guid? Actor, Guid? Command);
}
