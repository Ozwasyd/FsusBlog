using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Authoring;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class AuthorTextPropertyIndexPostgresTests
{
    [PostgresFact]
    public async Task SavedEligibleTextReconcilesInBoundedRevisionWitnessedBatches()
    {
        await using var scratch = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await scratch.DataSource.OpenConnectionAsync(ct);
        var actor = new Identity(Guid.NewGuid(), "Property search owner", 1, true, DateTimeOffset.UtcNow.AddMinutes(2));
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,true,true,1)
            """, actor.Id, actor.Name);

        var id = Guid.NewGuid();
        var created = await Transaction(tx => new PropertyStore(db, tx, actor).Change(
            new PropertyDefinitionCommand(1, id, Guid.NewGuid(), 0, 0, "evidence", "Evidence"), ct));
        var unavailable = await Assert.ThrowsAsync<BusinessException>(() => Reconcile(created));
        Assert.Equal(Rejection.NotFound, unavailable.Rejection);
        var enabled = await SetEligibility(created, true);
        var articles = new List<ArticleState>();
        for (var index = 0; index < 10; index++)
        {
            var saved = await Transaction(tx => Store.Execute(db, tx, actor, ArticleAction.Save,
                new(0, 0, Guid.NewGuid(), "Article " + index, "Unrelated Markdown body"), ct));
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

        await using (var select = Store.Sql(db, null, """
            select convert_from(p.term,'UTF8'),p.start_u16,p.end_u16,p.start_u8,p.end_u8,d.source_digest,d.value_revision
            from public.author_text_property_posting p join public.author_text_property_document d
                using (owner_id,definition_id,article_id)
            where p.owner_id=$1 and p.definition_id=$2 and p.article_id=$3 order by p.ordinal
            """, actor.Id, id, articles[0].Id))
        await using (var row = await select.ExecuteReaderAsync(ct))
        {
            Assert.True(await row.ReadAsync(ct));
            Assert.Equal(("café", 0, 4, 0, 5), Position(row));
            Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes("Café 雪")), row.GetFieldValue<byte[]>(5));
            Assert.Equal(1L, row.GetInt64(6));
            Assert.True(await row.ReadAsync(ct));
            Assert.Equal(("雪", 5, 6, 6, 9), Position(row));
            Assert.False(await row.ReadAsync(ct));
        }

        await Write(articles[0], 1, "", remove: true);
        Assert.Null(await Generation());
        await Reconcile(enabled);
        Assert.Equal(8L, await CountDocuments());
        Assert.NotEqual(Convert.ToHexString(complete), Convert.ToHexString(Assert.IsType<byte[]>(await Generation())));
        var disabled = await SetEligibility(enabled, false);
        Assert.Equal(Rejection.NotFound, (await Assert.ThrowsAsync<BusinessException>(() => Reconcile(disabled))).Rejection);

        Task<PropertyCommandReceipt> SetEligibility(PropertyCommandReceipt expected, bool eligible) =>
            Transaction(tx => new PropertyStore(db, tx, actor).Change(
                new PropertyDefinitionProjectionCommand(id, Guid.NewGuid(), expected.SchemaRevision, expected.Revision, eligible, false), ct));

        Task<PropertyCommandReceipt> Write(ArticleState article, long valueRevision, string value, bool remove = false) =>
            Transaction(tx => new PropertyStore(db, tx, actor).WriteText(new(article.Id, article.Revision, enabled.SchemaRevision,
                valueRevision, id, enabled.Revision, Guid.NewGuid(), remove, value), ct));

        Task<bool> Reconcile(PropertyCommandReceipt expected) => Transaction(async tx =>
        {
            var store = new PropertyStore(db, tx, actor);
            var scope = await store.ResolveTextProjection(expected.SchemaRevision, id, expected.Revision, ct);
            await store.ReconcileTextProjection(scope, ct);
            return true;
        });

        async Task<long> CountDocuments()
        {
            return Assert.IsType<long>(await FixtureSql.ScalarAsync(db, null, ct, "select count(*) from public.author_text_property_document where owner_id=$1 and definition_id=$2", actor.Id, id));
        }

        async Task<byte[]?> Generation()
        {
            await using var command = Store.Sql(db, null, $$"""
                with eligible as (select id from public.article where owner_id=$1 and not deleted),
                {{AuthorTextPropertyIndex.Changes("eligible", 2, 3)}}
                select case when not exists(select from property_text_changed) then ({{AuthorTextPropertyIndex.Witness(2, 3)}}) end
                """, actor.Id, id, enabled.Revision);
            return await command.ExecuteScalarAsync(ct) as byte[];
        }

        async Task<T> Transaction<T>(Func<NpgsqlTransaction, Task<T>> operation)
        {
            await using var tx = await db.BeginTransactionAsync(ct);
            var result = await operation(tx);
            await tx.CommitAsync(ct);
            return result;
        }
    }

    private static (string Term, int Start, int End, int ByteStart, int ByteEnd) Position(NpgsqlDataReader row) =>
        (row.GetString(0), row.GetInt32(1), row.GetInt32(2), row.GetInt32(3), row.GetInt32(4));
}
