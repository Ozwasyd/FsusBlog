using System.Security.Cryptography;
using System.Net;
using System.Net.Http.Headers;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Authoring;

namespace FsusBlog.V2.Integration.Tests;

public sealed class CanvasPostgresTests
{
    [Fact]
    public void ConversionEscapesServerLabelAndRetainsEveryByteOutsideExplicitInsertion()
    {
        var owner = Guid.NewGuid();
        var actor = new Identity(owner, "Author", 1, true, DateTimeOffset.MaxValue);
        var body = "\uFEFF# Author's note\r\n\r\nExisting source 🐝";
        var host = new ArticleState(1, owner, 1, "Host", body, 1, false);
        var target = new CanvasTarget(2, owner, 3, "[See] \\ ](https://other.invalid)");
        var edge = new CanvasEdge(Guid.NewGuid(), Guid.NewGuid(), 1, 1, 2, true);
        var intent = new CanvasLinkIntent(edge.CanvasId, edge.EdgeId, 1, 1, 3, body.Length);

        var appended = CanvasStore.Build(edge, intent, host, target, actor);
        Assert.Equal(body, appended.Body[..body.Length]);
        Assert.StartsWith("\r\n\r\n[", appended.Inserted);
        Assert.EndsWith("](/article/2)", appended.Inserted);
        Assert.Contains("\\[See\\]", appended.Inserted);
        Assert.Equal(Rejection.Conflict, Assert.Throws<BusinessException>(() =>
            CanvasStore.Build(edge, intent with { SourceOffset = body.Length - 1 }, host, target, actor)).Rejection);
        Assert.Equal(Rejection.Invalid, Assert.Throws<BusinessException>(() =>
            CanvasStore.Build(edge with { ExplicitReference = false }, intent, host, target, actor)).Rejection);
        Assert.Equal(Rejection.Invalid, Assert.Throws<BusinessException>(() =>
            CanvasStore.Build(edge, intent with { SourceOffset = 3 }, host with { Body = "```" }, target, actor)).Rejection);
    }

    [PostgresFact]
    public async Task KestrelDecodesCanvasAedsAndRechecksSessionBeforeCommit()
    {
        await using var test = await Fixture.Open();
        var owner = await test.Author("HTTP owner");
        var host = await test.Save(owner.Token, "Host", "Visible source");
        var target = await test.Publish(owner.Token, await test.Save(owner.Token, "Target", "Draft target"));
        await using var server = await ServerProcess.Start(test.ConnectionString, test.Token);
        var input = new CanvasCreate(Guid.NewGuid(), Guid.NewGuid(), host.Id, target.Id);
        var payload = Wire.EncodeCanvasCreate(input);
        var invalid = (byte[])payload.Clone();
        invalid[^1] ^= 1;
        Aeds.Decode(await Post(WireRoutes.CanvasCreate, payload, HttpStatusCode.Unauthorized, null), FrameType.ApiError);
        Aeds.Decode(await Post(WireRoutes.CanvasCreate, invalid, HttpStatusCode.BadRequest, owner.Token), FrameType.ApiError);
        var canvas = Wire.DecodeCanvasCreated(await Post(WireRoutes.CanvasCreate, payload, HttpStatusCode.OK, owner.Token));
        var plan = Wire.DecodeCanvasLinkPlan(await Post(WireRoutes.CanvasPreview, Wire.EncodeCanvasPreview(
            new(canvas.CanvasId, canvas.EdgeId, canvas.CanvasRevision, host.Revision, target.Revision, host.Body.Length)),
            HttpStatusCode.OK, owner.Token));
        var receipt = Wire.DecodeCanvasLinked(await Post(WireRoutes.CanvasConfirm, Wire.EncodeCanvasConfirm(new(plan.PlanId)),
            HttpStatusCode.OK, owner.Token));
        Assert.Equal(new(plan.PlanId, host.Id, host.Revision + 1, canvas.CanvasRevision + 1), receipt);

        await test.Mutate("update public.blog_user set generation=generation+1 where id=$1", owner.User.Id);
        Aeds.Decode(await Post(WireRoutes.CanvasConfirm, Wire.EncodeCanvasConfirm(new(plan.PlanId)),
            HttpStatusCode.Unauthorized, owner.Token), FrameType.ApiError);

        async Task<byte[]> Post(string path, byte[] bytes, HttpStatusCode status, string? token)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = new ByteArrayContent(bytes) };
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
            if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-session={token}");
            using var response = await server.Client.SendAsync(request, test.Token);
            Assert.Equal(status, response.StatusCode);
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return await response.Content.ReadAsByteArrayAsync(test.Token);
        }
    }

    [PostgresFact]
    public async Task ConfirmAtomicallyAppendsOnceAndRetainsImmutablePublication()
    {
        await using var test = await Fixture.Open();
        var owner = await test.Author("owner");
        var outsider = await test.Author("outsider");
        var ignored = await test.Author("reader", false);
        var host = await test.Save(owner.Token, "Host", "Visible source");
        var original = await test.Publish(owner.Token, host);
        var unpublished = await test.Save(owner.Token, "Unpublished title", "Private target source");
        await Denied(Rejection.NotFound, test.WithCanvas(owner.Token, op => op.Create(
            new(Guid.NewGuid(), Guid.NewGuid(), host.Id, unpublished.Id), test.Token)));
        var target = await test.Publish(owner.Token, await test.Save(owner.Token, "Target", "Published target source"));
        var privateDraft = await test.Save(owner.Token, "Private target title", "Private draft", target.Id, target.Revision);
        var other = await test.Save(outsider.Token, "Other", "Private");
        var input = new CanvasCreate(Guid.NewGuid(), Guid.NewGuid(), original.Id, target.Id);
        var canvas = await test.WithCanvas(owner.Token, op => op.Create(input, test.Token));
        Assert.Equal(canvas, await test.WithCanvas(owner.Token, op => op.Create(input, test.Token)));

        await Denied(Rejection.NotFound, test.WithCanvas(outsider.Token, op => op.Create(input, test.Token)));
        await Denied(Rejection.Forbidden, test.WithCanvas(ignored.Token, op => op.Create(input, test.Token)));
        await Denied(Rejection.NotFound, test.WithCanvas(owner.Token, op => op.Create(
            new(Guid.NewGuid(), Guid.NewGuid(), host.Id, other.Id), test.Token)));

        var preview = new CanvasPreview(canvas.CanvasId, canvas.EdgeId, 1, original.Revision, target.Revision, original.Body.Length);
        await Denied(Rejection.NotFound, test.WithCanvas(outsider.Token, op => op.Preview(preview, test.Token)));
        var plan = await test.WithCanvas(owner.Token, op => op.Preview(preview, test.Token));
        Assert.Equal($"\n\n[Target](/article/{target.Id})", plan.InsertedMarkdown);
        var anotherOwnerSession = await test.SignIn(owner.User.Id);
        await Denied(Rejection.NotFound, test.WithCanvas(anotherOwnerSession.Token, op => op.Confirm(plan.PlanId, test.Token)));
        Assert.Equal(original, await test.Read(owner.Token, host.Id));
        Assert.Equal(1L, await test.Scalar("select revision from public.authoring_canvas where id=$1", canvas.CanvasId));
        await Denied(Rejection.NotFound, test.WithCanvas(outsider.Token, op => op.Confirm(plan.PlanId, test.Token)));

        var first = test.WithCanvas(owner.Token, op => op.Confirm(plan.PlanId, test.Token));
        var repeat = test.WithCanvas(owner.Token, op => op.Confirm(plan.PlanId, test.Token));
        var results = await Task.WhenAll(first, repeat);
        Assert.Equal(results[0], results[1]);
        Assert.Equal(new CanvasLinked(plan.PlanId, host.Id, original.Revision + 1, 2), results[0]);

        var edited = await test.Read(owner.Token, host.Id);
        Assert.Equal(original.Body + plan.InsertedMarkdown, edited.Body);
        Assert.Equal(original.Revision, edited.PublishedRevision);
        Assert.Equal(privateDraft, await test.Read(owner.Token, target.Id));
        Assert.Equal(original.Body, await test.Scalar(
            "select body from public.article_revision where article_id=$1 and revision=$2", host.Id, original.Revision));
        Assert.Equal(1L, await test.Scalar("select count(*) from public.canvas_edge where canvas_id=$1", canvas.CanvasId));
        Assert.Equal(1L, await test.Scalar("select count(*) from public.blog_outbox where article_id=$1 and revision=$2 and kind='save'",
            edited.Id, edited.Revision));
    }

    [PostgresFact]
    public async Task ExpiryDriftAndFailedReceiptPreserveBothAuthorities()
    {
        await using var test = await Fixture.Open();
        var author = await test.Author("author");
        var host = await test.Save(author.Token, "Host", "Source");
        var target = await test.Publish(author.Token, await test.Save(author.Token, "Target", "# Original title"));
        var canvas = await test.WithCanvas(author.Token, op => op.Create(
            new(Guid.NewGuid(), Guid.NewGuid(), host.Id, target.Id), test.Token));
        var preview = new CanvasPreview(canvas.CanvasId, canvas.EdgeId, 1, host.Revision, target.Revision, host.Body.Length);

        var expired = await test.WithCanvas(author.Token, op => op.Preview(preview, test.Token));
        await test.Mutate("update public.canvas_link_plan set expires_at=clock_timestamp() where id=$1", expired.PlanId);
        await Denied(Rejection.Conflict, test.WithCanvas(author.Token, op => op.Confirm(expired.PlanId, test.Token)));

        var stale = await test.WithCanvas(author.Token, op => op.Preview(preview, test.Token));
        var changed = await test.Publish(author.Token,
            await test.Save(author.Token, "New target label", target.Body, target.Id, target.Revision));
        await Denied(Rejection.Conflict, test.WithCanvas(author.Token, op => op.Confirm(stale.PlanId, test.Token)));
        await test.Mutate("update public.canvas_edge set explicit_reference=false where canvas_id=$1", canvas.CanvasId);
        await Denied(Rejection.Invalid, test.WithCanvas(author.Token, op => op.Preview(
            preview with { TargetRevision = changed.Revision }, test.Token)));
        await test.Mutate("update public.canvas_edge set explicit_reference=true where canvas_id=$1", canvas.CanvasId);

        var current = await test.WithCanvas(author.Token, op => op.Preview(
            preview with { TargetRevision = changed.Revision }, test.Token));
        await test.Mutate("alter table public.canvas_link_plan add constraint test_receipt_failure check(applied_revision is null)");
        var fault = await Assert.ThrowsAsync<Npgsql.PostgresException>(() =>
            test.WithCanvas(author.Token, op => op.Confirm(current.PlanId, test.Token)));
        Assert.Equal("test_receipt_failure", fault.ConstraintName);
        Assert.Equal(host, await test.Read(author.Token, host.Id));
        Assert.Equal(1L, await test.Scalar("select revision from public.authoring_canvas where id=$1", canvas.CanvasId));
        Assert.Equal(0L, await test.Scalar("select count(*) from public.article_command where command_id=$1", current.PlanId));
        Assert.Equal(0L, await test.Scalar("select count(*) from public.blog_outbox where article_id=$1 and revision>1", host.Id));

        await test.Mutate("alter table public.canvas_link_plan drop constraint test_receipt_failure");
        var retry = await test.WithCanvas(author.Token, op => op.Confirm(current.PlanId, test.Token));
        Assert.Equal(2L, retry.ArticleRevision);
        await test.Mutate("update public.blog_user set generation=generation+1 where id=$1", author.User.Id);
        await Denied(Rejection.Unauthorized, test.WithCanvas(author.Token, op => op.Confirm(current.PlanId, test.Token)));
    }

    private static async Task Denied<T>(Rejection rejection, Task<T> command) =>
        Assert.Equal(rejection, (await Assert.ThrowsAsync<BusinessException>(() => command)).Rejection);

    private sealed class Fixture(ScratchDatabase database, CancellationTokenSource deadline) : IAsyncDisposable
    {
        private readonly Store _store = new(database.DataSource);
        internal CancellationToken Token => deadline.Token;
        internal string ConnectionString => database.ConnectionString;

        internal static async Task<Fixture> Open()
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
            var id = Guid.NewGuid();
            await Mutate("insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)", id, name, author);
            return await SignIn(id);
        }

        internal async Task<(string Token, Identity User)> SignIn(Guid id)
        {
            var secret = RandomNumberGenerator.GetBytes(32);
            await Mutate("insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '2 minutes')",
                SHA256.HashData(secret), id);
            return await _store.SignIn(Convert.ToHexStringLower(secret), Token);
        }

        internal Task<T> WithCanvas<T>(string token, Func<CanvasStore, Task<T>> operation) =>
            _store.WithSession(token, true, (db, tx, actor) => operation(new(db, tx, actor, Store.TokenDigest(token)!)), Token);

        internal Task<ArticleState> Read(string token, int id) =>
            _store.WithSession(token, true, (db, tx, actor) => Store.Find(db, tx, actor, id, false, Token), Token);

        internal Task<ArticleState> Save(string token, string title, string body, int id = 0, long revision = 0) =>
            Command(token, ArticleAction.Save, new(id, revision, Guid.NewGuid(), title, body));

        internal Task<ArticleState> Publish(string token, ArticleState source) =>
            Command(token, ArticleAction.Publish, new(source.Id, source.Revision, Guid.NewGuid(), "", ""));

        private async Task<ArticleState> Command(string token, ArticleAction action, Edit edit)
        {
            edit = Publishing.Validate(action, edit);
            return (await _store.WithSession(token, true, (db, tx, actor) => Store.Execute(db, tx, actor, action, edit, Token), Token)).Article;
        }

        internal async Task Mutate(string sql, params object[] args) => await Scalar(sql, args);
        internal async Task<object?> Scalar(string sql, params object[] args)
        {
            await using var db = await database.DataSource.OpenConnectionAsync(Token);
            await using var command = Store.Sql(db, null, sql, args);
            return await command.ExecuteScalarAsync(Token);
        }

        public async ValueTask DisposeAsync()
        {
            try { await database.DisposeAsync(); }
            finally { deadline.Dispose(); }
        }
    }
}
