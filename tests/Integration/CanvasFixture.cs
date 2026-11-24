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

    internal Task<CanvasCreated> CreateCanvas(string token, CanvasCreate input) => WithCanvas(token, op => op.Create(input, Token));
    internal Task<CanvasLinkPlan> Preview(string token, CanvasPreview input, bool visualOnly = false) => WithCanvas(token, op => op.Preview(input, Token, visualOnly));
    internal Task<CanvasLinked> Confirm(string token, Guid planId) => WithCanvas(token, op => op.Confirm(planId, Token));

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

    internal Task<CanvasGraphReceipt> WriteGraph(string token, CanvasGraphCommand command)
    {
        var digest = SHA256.HashData(Wire.EncodeCanvasGraphCommand(command));
        return WithGraph(token, graph => graph.Write(command, digest, Token));
    }

    internal static CanvasGraphCommand GraphCommand(Guid document, long revision, CanvasGraphAction action) =>
        new(document, Guid.NewGuid(), revision, action, "", null, []);

    internal static CanvasChangeFrame PutNode(Guid id, int kind, int? article = null, string? anchor = null,
        long? pinned = null, string? text = null, Guid[]? members = null) =>
        new CanvasChangeFrame.PutNode(new(id, kind, 0, 0, 12000, 8000, article, anchor, pinned, text, members));

    internal static byte[] ProtocolFixture(string name)
    {
        for (var at = new DirectoryInfo(AppContext.BaseDirectory); at is not null; at = at.Parent)
        {
            var path = Path.Combine(at.FullName, "tests", "Protocol", "fixtures", name + ".hex");
            if (File.Exists(path)) return Convert.FromHexString(File.ReadAllText(path).Trim());
        }
        throw new FileNotFoundException($"Missing independent Canvas fixture {name}.");
    }

    internal Task Mutate(string sql, params object[] args) => database.ExecAsync(Token, sql, args);
    internal Task<object?> Scalar(string sql, params object[] args) => database.ScalarAsync(Token, sql, args);
    internal Task<long> TableCount(string table) => database.ScalarAsync<long>(Token, $"select count(*) from {table}");
    internal Task<long> CanvasCount(string table, Guid canvasId) =>
        database.ScalarAsync<long>(Token, $"select count(*) from public.{table} where canvas_id=$1", canvasId);

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
        else
        {
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            if (status != HttpStatusCode.OK) Aeds.Decode(bytes, FrameType.ApiError);
        }
        return bytes;
    }

    internal static async Task Denied<T>(Rejection rejection, Task<T> command) =>
        Assert.Equal(rejection, (await Assert.ThrowsAsync<BusinessException>(() => command)).Rejection);

    public ValueTask DisposeAsync() => database.DisposeAsync();
}
