using System.Net;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Authoring;

namespace FsusBlog.V2.Integration.Tests;

internal sealed class CanvasFixture(ScratchDatabase database, CancellationTokenSource deadline) : IAsyncDisposable
{
    private readonly Store _store = new(database.DataSource);
    internal CancellationToken Token => deadline.Token;
    internal string ConnectionString => database.ConnectionString;

    internal static async Task<CanvasFixture> Open()
    {
        var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        try
        {
            return new(await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, deadline.Token), deadline);
        }
        catch { deadline.Dispose(); throw; }
    }

    internal async Task<(string Token, Identity User)> Author(string name, bool author = true)
    {
        var (_, ticket) = await database.IssueTicket(name, Token, author);
        return await _store.SignIn(ticket, Token);
    }

    internal async Task<(string Token, Identity User)> SignIn(Guid id) =>
        await _store.SignIn(await database.IssueTicket(id, Token), Token);

    internal Task<T> WithGraph<T>(string token, Func<CanvasGraphStore, Task<T>> operation) =>
        _store.WithSession(token, true, (db, tx, actor) => operation(new(db, tx, actor)), Token);

    internal Task<T> WithCanvas<T>(string token, Func<CanvasStore, Task<T>> operation) =>
        _store.WithSession(token, true, (db, tx, actor) => operation(new(db, tx, actor, Store.TokenDigest(token)!)), Token);

    internal Task<ArticleState> Read(string token, int id) =>
        _store.WithSession(token, true, (db, tx, actor) => Store.Find(db, tx, actor, id, false, Token), Token);

    internal Task<ArticleState> Save(string token, string title, string body, int id = 0, long revision = 0) =>
        Command(token, ArticleAction.Save, new(id, revision, Guid.NewGuid(), title, body));

    internal Task<ArticleState> Publish(string token, ArticleState source) =>
        Command(token, ArticleAction.Publish, new(source.Id, source.Revision, Guid.NewGuid(), "", ""));

    internal async Task<ArticleState> Command(string token, ArticleAction action, Edit edit)
    {
        edit = Publishing.Validate(action, edit);
        return (await _store.WithSession(token, true, (db, tx, actor) => Store.Execute(db, tx, actor, action, edit, Token), Token)).Article;
    }

    internal async Task Mutate(string sql, params object[] args) => await Scalar(sql, args);
    internal async Task<object?> Scalar(string sql, params object[] args)
    {
        await using var db = await database.DataSource.OpenConnectionAsync(Token);
        return await FixtureSql.ScalarAsync(db, null, Token, sql, args);
    }

    internal async Task<byte[]> ReadFrame(HttpClient client, HttpMethod method, string path, string? token,
        HttpStatusCode status, byte[]? body = null, string[]? sessions = null, bool bundle = false)
    {
        using var request = SiteAedsFixture.Request(method, path, body, token, handle: null);
        if (sessions is not null) request.Headers.Add(WireHeaders.CurrentSession, sessions);
        using var response = await client.SendAsync(request, Token);
        Assert.Equal(status, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
        var bytes = await response.Content.ReadAsByteArrayAsync(Token);
        if (bundle)
        {
            Assert.Equal(Wire.CanvasBundleContentType, response.Content.Headers.ContentType?.MediaType);
            Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
        }
        else if (status != HttpStatusCode.OK) Aeds.Decode(bytes, FrameType.ApiError);
        return bytes;
    }

    internal static async Task Denied<T>(Rejection rejection, Task<T> command) =>
        Assert.Equal(rejection, (await Assert.ThrowsAsync<BusinessException>(() => command)).Rejection);

    public async ValueTask DisposeAsync()
    {
        try { await database.DisposeAsync(); }
        finally { deadline.Dispose(); }
    }
}
