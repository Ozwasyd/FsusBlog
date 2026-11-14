using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Integration.Tests;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;

public sealed class PublishingPostgresTests
{
    [PostgresFact]
    public async Task PublishAndRetractUseOneAuthorizedDurableRevision()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_DB")!, ct);
        var store = new Store(fixture.DataSource);
        var publications = new Publications(fixture.DataSource, new WebPages("<body><!--fsus-public-content--></body>"), NullLogger<Publications>.Instance);
        await publications.Refresh(ct);
        var issue = await IssueTicket(fixture.DataSource, "original owner", true, ct);
        var session = await store.SignIn(issue.Token, ct);
        Assert.Equal(Rejection.Unauthorized, (await Assert.ThrowsAsync<BusinessException>(() => store.SignIn(issue.Token, ct))).Rejection);
        var command = new Edit(0, 0, Guid.NewGuid(), "Saved title", "Saved Markdown body");
        var first = publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        var retry = publications.Command(store, session.Token, ArticleAction.Save, command, ct);
        var saved = (await first).Article;
        Assert.Equal(saved, (await retry).Article);
        Assert.Null(publications.Snapshot!.Article(saved.Id));

        var next = new Edit(saved.Id, saved.Revision, Guid.NewGuid(), "Published title", "Published Markdown body");
        var newDraft = (await publications.Command(store, session.Token, ArticleAction.Save, next, ct)).Article;
        var oldPublication = new Edit(saved.Id, saved.Revision, Guid.NewGuid(), "", "");
        Assert.Equal(Rejection.Conflict, (await Assert.ThrowsAsync<BusinessException>(() =>
            publications.Command(store, session.Token, ArticleAction.Publish, oldPublication, ct))).Rejection);
        var publish = oldPublication with { ExpectedRevision = newDraft.Revision };
        var published = (await publications.Command(store, session.Token, ArticleAction.Publish, publish, ct)).Article;
        Assert.Equal(published.Revision, publications.Snapshot!.Article(saved.Id)!.Article.Revision);

        var outsider = await store.SignIn((await IssueTicket(fixture.DataSource, "other author", true, ct)).Token, ct);
        var retract = new Edit(saved.Id, published.Revision, Guid.NewGuid(), "", "");
        Assert.Equal(Rejection.NotFound, (await Assert.ThrowsAsync<BusinessException>(() =>
            publications.Command(store, outsider.Token, ArticleAction.Retract, retract, ct))).Rejection);
        await publications.Command(store, session.Token, ArticleAction.Retract, retract, ct);
        Assert.Null(publications.Snapshot!.Article(saved.Id));
        await using var connection = await fixture.DataSource.OpenConnectionAsync(ct);
        await using var rows = Store.Sql(connection, null, "select count(*), count(distinct revision) from public.blog_outbox where article_id=$1", saved.Id);
        await using var result = await rows.ExecuteReaderAsync(ct);
        Assert.True(await result.ReadAsync(ct));
        Assert.Equal(4, result.GetInt64(0));
        Assert.Equal(4, result.GetInt64(1));
    }

    private static async Task<(Guid Id, string Token)> IssueTicket(NpgsqlDataSource source, string name, bool author, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var secret = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
        await using var connection = await source.OpenConnectionAsync(ct);
        await using (var user = Store.Sql(connection, null, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)", id, name, author))
            await user.ExecuteNonQueryAsync(ct);
        await using (var ticket = Store.Sql(connection, null, "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '1 minute')",
            System.Security.Cryptography.SHA256.HashData(secret), id)) await ticket.ExecuteNonQueryAsync(ct);
        return (id, Convert.ToHexStringLower(secret));
    }
}
