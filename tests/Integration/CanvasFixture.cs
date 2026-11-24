namespace FsusBlog.V2.Integration.Tests;

internal sealed class CanvasFixture(ScratchDatabase database, CancellationToken token) : IAsyncDisposable
{
    private readonly Store _store = new(database.DataSource);
    internal CancellationToken Token => token;
    internal string ConnectionString => database.ConnectionString;

    internal static async Task<CanvasFixture> Open()
    {
        var database = await ScratchDatabase.CreateTimed(out var token);
        return new(database, token);
    }

    internal async Task<(string Token, Identity User)> Author(string name, bool author = true)
    {
        var (id, token, _) = author
            ? await database.SignInAdmin(name, Token, minutes: 5)
            : await database.SignInSiteUser(name, Token, minutes: 5);
        return (token, new Identity(id, author ? ScratchDatabase.AdminHandle(name, id) : name, 1, author, DateTimeOffset.UtcNow.AddMinutes(5)));
    }

    internal async Task<(string Token, Identity User)> SignIn(Guid id)
    {
        var (_, token, _) = await database.SignIn(id, Token, minutes: 5);
        return (token, new Identity(id, "admin", 1, true, DateTimeOffset.UtcNow.AddMinutes(5)));
    }

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

    public ValueTask DisposeAsync() => database.DisposeAsync();
}
