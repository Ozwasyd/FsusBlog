namespace FsusBlog.V2.Integration.Tests;

public sealed class AuthorTextPropertyIndexPostgresTests
{
    [PostgresFact]
    public async Task SavedEligibleTextReconcilesInBoundedRevisionWitnessedBatches()
    {
        await using var scratch = await ScratchDatabase.CreateTimed(out var ct);
        var actor = new Identity(Guid.NewGuid(), "Property search owner", 1, true, DateTimeOffset.UtcNow.AddMinutes(2));
        await scratch.AdminPrincipalAsync(actor.Id, "property-search-owner", ct: ct);

        var id = Guid.NewGuid();
        var created = await scratch.InTx((db, tx) => new PropertyStore(db, tx, actor).Change(
            new PropertyDefinitionCommand(1, id, Guid.NewGuid(), 0, 0, "evidence", "Evidence"), ct), ct);
        await BusinessAssert.Denied(Rejection.NotFound, () => Reconcile(created));
        var enabled = await SetEligibility(created, true);
        var articles = new List<ArticleState>();
        for (var index = 0; index < 10; index++)
        {
            var saved = await scratch.InTx((db, tx) => Store.Execute(db, tx, actor, ArticleAction.Save,
                new(0, 0, Guid.NewGuid(), "Article " + index, "Unrelated Markdown body"), ct), ct);
            articles.Add(saved.Article);
            if (index != 9) await Write(saved.Article, 0, index == 0 ? "Cafe\u0301 雪" : "Extra property");
        }

        await Reconcile(enabled);
        Assert.Equal(8L, await CountDocuments());
        Assert.Null(await Generation());
        await Reconcile(enabled);
        Assert.Equal(9L, await CountDocuments());
        var complete = Assert.IsType<byte[]>(await Generation());
        Assert.Equal(32, complete.Length);

        var postings = await scratch.QueryRowsAsync(ct, """
            select convert_from(p.term,'UTF8'),p.start_u16,p.end_u16,p.start_u8,p.end_u8,d.source_digest,d.value_revision
            from public.author_text_property_posting p join public.author_text_property_document d
                using (owner_id,definition_id,article_id)
            where p.owner_id=$1 and p.definition_id=$2 and p.article_id=$3 order by p.ordinal
            """, r => ((r.GetString(0), r.GetInt32(1), r.GetInt32(2), r.GetInt32(3), r.GetInt32(4)),
                r.GetFieldValue<byte[]>(5), r.GetInt64(6)), actor.Id, id, articles[0].Id);
        Assert.Equal(2, postings.Count);
        Assert.Equal(("café", 0, 4, 0, 5), postings[0].Item1);
        Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes("Café 雪")), postings[0].Item2);
        Assert.Equal(1L, postings[0].Item3);
        Assert.Equal(("雪", 5, 6, 6, 9), postings[1].Item1);

        await Write(articles[0], 1, "", remove: true);
        Assert.Null(await Generation());
        await Reconcile(enabled);
        Assert.Equal(8L, await CountDocuments());
        Assert.NotEqual(Convert.ToHexString(complete), Convert.ToHexString(Assert.IsType<byte[]>(await Generation())));
        var disabled = await SetEligibility(enabled, false);
        await BusinessAssert.Denied(Rejection.NotFound, () => Reconcile(disabled));

        Task<PropertyCommandReceipt> SetEligibility(PropertyCommandReceipt expected, bool eligible) =>
            scratch.InTx((db, tx) => new PropertyStore(db, tx, actor).Change(
                new PropertyDefinitionProjectionCommand(id, Guid.NewGuid(), expected.SchemaRevision, expected.Revision, eligible, false), ct), ct);

        Task<PropertyCommandReceipt> Write(ArticleState article, long valueRevision, string value, bool remove = false) =>
            scratch.InTx((db, tx) => new PropertyStore(db, tx, actor).WriteText(new(article.Id, article.Revision, enabled.SchemaRevision,
                valueRevision, id, enabled.Revision, Guid.NewGuid(), remove, value), ct), ct);

        Task<bool> Reconcile(PropertyCommandReceipt expected) => scratch.InTx(async (db, tx) =>
        {
            var store = new PropertyStore(db, tx, actor);
            await store.ReconcileTextProjection(await store.ResolveTextProjection(expected.SchemaRevision, id, expected.Revision, ct), ct);
            return true;
        }, ct);

        Task<long> CountDocuments() => scratch.ScalarAsync<long>(ct,
            "select count(*) from public.author_text_property_document where owner_id=$1 and definition_id=$2", actor.Id, id);

        async Task<byte[]?> Generation() => await scratch.ScalarAsync(ct, $$"""
            with eligible as (select id from public.article where owner_id=$1 and not deleted),
            {{AuthorTextPropertyIndex.Changes("eligible", 2, 3)}}
            select case when not exists(select from property_text_changed) then ({{AuthorTextPropertyIndex.Witness(2, 3)}}) end
            """, actor.Id, id, enabled.Revision) as byte[];
    }
}
