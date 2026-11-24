namespace FsusBlog.V2.Integration.Tests;

internal sealed class AuthorPropertyFixture(ScratchDatabase database, HttpClient client, CancellationToken ct)
{
    private readonly Store _store = new(database.DataSource);
    private readonly Dictionary<int, long> _values = [];

    internal sealed record Field(Guid Id, long Revision);
    internal sealed record Actor(Guid Id, string Token, string? Handle)
    {
        internal long SchemaRevision { get; set; }
    }

    internal static Task<T> ReadyWithFacet<T>(Func<Task<T>> request,
        Func<T, (AuthorTextFacetedPage Search, AuthorTextPropertyFacet? Facet)> project) =>
        Ready(request, page =>
        {
            var (search, facet) = project(page);
            if (search.Ready) return true;
            Assert.Null(facet);
            Assert.Empty(search.Rows);
            Assert.Empty(search.NextCursor);
            Assert.Equal(0, search.Total);
            return false;
        }, "The fixture search index did not finish within eight requests.");

    internal static async Task<T> Ready<T>(Func<Task<T>> request, Func<T, bool> ready, string failure)
    {
        for (var attempt = 0; attempt < 8; attempt++)
        {
            var page = await request();
            if (ready(page)) return page;
        }
        throw new InvalidOperationException(failure);
    }

    internal static async Task<Actor> SignIn(ScratchDatabase database, string name, CancellationToken ct, bool canAuthor = true)
    {
        var (id, token, handle) = await database.SignIn(name, ct, canAuthor);
        return new(id, token, handle);
    }

    internal static async Task<Actor> SignIn(ScratchDatabase database, Guid id, CancellationToken ct)
    {
        var (_, token, handle) = await database.SignIn(id, ct);
        return new(id, token, handle);
    }

    internal Task<byte[]> Send(string route, byte[] data, Actor actor, HttpStatusCode status = HttpStatusCode.OK) =>
        SiteAedsFixture.ExpectPrivate(client, HttpMethod.Post, route, data, actor.Token, actor.Handle, status, ct);

    internal Task<Field> Create(Actor actor, string key, PropertyFieldKind kind, Guid? id = null, PropertyFieldOption[]? options = null) =>
        ChangeDefinition(actor, 1, id ?? Guid.NewGuid(), 0, key, key, kind, options);

    internal async Task<Field> Define(Actor actor, string key, PropertyFieldKind kind, bool filterable = false,
        bool searchable = false, bool sortable = false, Guid? id = null, PropertyFieldOption[]? options = null)
    {
        var field = await Create(actor, key, kind, id, options);
        if (filterable) field = await SetFilterable(actor, field);
        if (searchable || sortable) field = await SetProjection(actor, field, searchable, sortable);
        return field;
    }

    internal async Task<Field> ChangeDefinition(Actor actor, int operation, Guid id, long revision, string key = "", string label = "",
        PropertyFieldKind kind = PropertyFieldKind.Text, PropertyFieldOption[]? options = null)
    {
        var command = new PropertyDefinitionCommand(operation, id, Guid.NewGuid(), actor.SchemaRevision, revision, key, label);
        var wire = Wire.EncodePropertySchemaInput(new(command, kind, options ?? []));
        return Advance(actor, new(id, revision), await Send(WireRoutes.PropertySchemaCommand, wire, actor));
    }

    internal async Task<Field> SetProjection(Actor actor, Field field, bool searchable, bool sortable)
    {
        var wire = Wire.EncodePropertyDefinitionProjectionCommand(new(field.Id, Guid.NewGuid(), actor.SchemaRevision, field.Revision, searchable, sortable));
        return Advance(actor, field, await Send(WireRoutes.PropertySchemaCommand, wire, actor));
    }

    internal async Task<Field> SetFilterable(Actor actor, Field field)
    {
        var wire = Wire.EncodePropertyFilterabilityCommand(new(field.Id, Guid.NewGuid(), actor.SchemaRevision, field.Revision, true));
        return Advance(actor, field, await Send(WireRoutes.PropertyFilterability, wire, actor));
    }

    private static Field Advance(Actor actor, Field field, byte[] wire)
    {
        var receipt = Wire.DecodePropertyCommandReceipt(wire);
        Assert.Equal(new PropertyCommandReceipt(field.Id, actor.SchemaRevision + 1, field.Revision + 1), receipt);
        actor.SchemaRevision = receipt.SchemaRevision;
        return field with { Revision = receipt.Revision };
    }

    internal long ValueRevision(int article) => _values[article];

    internal async Task Put(Actor actor, ArticleState article, Field field, PropertyFieldValue value)
    {
        var prior = _values.GetValueOrDefault(article.Id);
        var input = new PropertyValueInput(article.Id, article.Revision, actor.SchemaRevision, prior, field.Id, field.Revision, Guid.NewGuid(), value);
        var receipt = Wire.DecodePropertyCommandReceipt(await Send(WireRoutes.PropertyValueCommand, Wire.EncodePropertyValueInput(input), actor));
        Assert.Equal(new PropertyCommandReceipt(field.Id, actor.SchemaRevision, prior + 1), receipt);
        _values[article.Id] = receipt.Revision;
    }

    internal Task PutIfPresent(Actor actor, ArticleState article, Field field, PropertyFieldValue value) =>
        value is PropertyFieldValue.Missing ? Task.CompletedTask : Put(actor, article, field, value);

    internal static void RequireSource(AuthorTextSearchRow row, int field, string raw, string term)
    {
        var start = raw.IndexOf(term, StringComparison.Ordinal);
        Assert.True(start >= 0);
        Assert.Equal(field, row.Field);
        Assert.Equal(term, row.Snippet[row.HighlightStart..row.HighlightEnd]);
        Assert.Equal((start, start + term.Length), (row.SourceStart, row.SourceEnd));
        Assert.Equal((Encoding.UTF8.GetByteCount(raw.AsSpan(0, start)), Encoding.UTF8.GetByteCount(raw.AsSpan(0, start + term.Length))),
            (row.SourceByteStart, row.SourceByteEnd));
        Assert.Equal(SHA256.HashData(Encoding.UTF8.GetBytes(raw)), row.SourceDigest);
    }

    internal static void RequireFacet(AuthorTextPropertyFacet? raw, Field field, PropertyFieldKind kind, int missing, int nil,
        int empty, params AuthorTextPropertyFacetBucket[] buckets)
    {
        var facet = Assert.IsType<AuthorTextPropertyFacet>(raw);
        Assert.Equal((field.Id, field.Revision, kind, missing, nil, empty),
            (facet.DefinitionId, facet.DefinitionRevision, facet.Kind, facet.Missing, facet.Null, facet.Empty));
        Assert.Equal(buckets, facet.Buckets);
    }

    internal static void RequireBoolFacet(AuthorTextPropertyFacet? raw, Field flag, int missing, int nil, int falseCount, int trueCount) =>
        RequireFacet(raw, flag, PropertyFieldKind.Boolean, missing, nil, 0, BoolFacet(false, falseCount), BoolFacet(true, trueCount));

    internal static AuthorTextPropertyFacetBucket BoolFacet(bool value, int count) => new(new PropertyFieldValue.Boolean(value), count);
    internal static AuthorTextPropertyFacetBucket ChoiceFacet(Guid id, int count) => new(new PropertyFieldValue.SingleSelect(id), count);

    internal Task<ArticleState> Save(Actor actor, string title, string body) =>
        ChangeArticle(actor, ArticleAction.Save, new(0, 0, Guid.NewGuid(), title, body));

    internal async Task<ArticleState> ChangeArticle(Actor actor, ArticleAction action, Edit edit) =>
        (await _store.WithSession(actor.Token, true, (db, tx, identity) => Store.Execute(db, tx, identity, action, edit, ct), ct)).Article;

    internal Task<(long Revision, DateTime Updated)> ArticleStamp(int id) =>
        database.QueryRowAsync(ct, "select revision,updated_at from public.article where id=$1",
            row => (row.GetInt64(0), row.GetDateTime(1)), id);

    internal Task<int> Execute(string sql, params object[] args) => database.ExecAsync(ct, sql, args);
}
