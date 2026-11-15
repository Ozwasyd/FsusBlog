using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Sessions;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

public sealed class DocumentExportPostgresTests
{
    private const string Route = "/api/v2/authoring/document-exports";
    private const string CreateRoute = Route + "/create.aeds";
    private const string CancelRoute = Route + "/cancel.aeds";
    private const string DownloadRoute = Route + "/download.aeds";
    private const FrameType CreateFrame = (FrameType)33044;
    private const FrameType RefFrame = (FrameType)33045;
    private const FrameType TaskFrame = (FrameType)33046;
    private const FrameType ListFrame = (FrameType)33047;
    private const int TaskBytes = 140;
    private const byte Queued = 1, Running = 2, Succeeded = 3, Cancelled = 5, Cancelling = 7;
    private static readonly Dictionary<string, string> Settings = new()
    {
        ["FSUSBLOG_DOCUMENT_EXPORT_TASKS"] = "true",
        ["FSUSBLOG_PDF_TOOL_ROOT"] = "",
        ["FSUSBLOG_PDF_TOOL_SHA256"] = "",
    };

    [PostgresFact]
    public async Task DocumentTasksFreezeSavedSourceAndProtectDurableDownloads()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var store = new Store(fixture.DataSource);
        var owner = await Login(db, store, "Document task owner", canAuthor: true, ct);
        var outsider = await Login(db, store, "Document task outsider", canAuthor: true, ct);
        var reader = await Login(db, store, "Document task reader", canAuthor: false, ct);

        const string title = "Pinned Chinese 中文 title";
        const string body = "## Frozen section\n\nHistorical document marker.\n";
        const string newerText = "Unrelated current document marker.";
        var htmlId = Guid.NewGuid();
        var wordId = Guid.NewGuid();
        var epubId = Guid.NewGuid();
        var cancelId = Guid.NewGuid();
        ExportTask savedHtml;
        ExportTask savedWord;
        ExportTask savedEpub;
        Draft older;
        byte[] htmlBytes;

        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, Settings))
        {
            var client = server.Client;
            older = await Save(client, owner, 0, 0, title, body, ct);
            var sourceTime = await SourceTime(db, older, ct);
            var current = await Save(client, owner, older.Id, older.Revision, "Current private title", newerText, ct);
            await HoldClaim(db, htmlId, ct);
            var htmlRequest = Create(htmlId, current.Id, current.Revision, older.Revision, format: 1);
            var first = await ReadTask(client, CreateRoute, owner, htmlRequest, ct);
            AssertReceipt(first, htmlId, current, older.Revision, format: 1);
            Assert.Equal(Queued, first.State);
            var replay = await ReadTask(client, CreateRoute, owner, htmlRequest, ct);
            Assert.Equal(first.Created, replay.Created);
            Assert.Equal(first.SourceDigest, replay.SourceDigest);
            await Reject(client, CreateRoute, owner, Create(htmlId, current.Id, current.Revision, older.Revision, format: 3), HttpStatusCode.Conflict, ct);
            await Reject(client, CreateRoute, owner, Create(Guid.NewGuid(), current.Id, current.Revision, older.Revision, format: 2), HttpStatusCode.BadRequest, ct);

            await Reject(client, CreateRoute, null, htmlRequest, HttpStatusCode.Unauthorized, ct);
            await Reject(client, CreateRoute, outsider, htmlRequest, HttpStatusCode.NotFound, ct);
            await Reject(client, CreateRoute, reader, htmlRequest, HttpStatusCode.Forbidden, ct);
            await Reject(client, CreateRoute, owner with { Handle = outsider.Handle }, htmlRequest, HttpStatusCode.Conflict, ct);
            await Reject(client, DownloadRoute, owner with { Handle = null }, Reference(htmlId), HttpStatusCode.Conflict, ct);
            await RejectList(client, current.Id, outsider, HttpStatusCode.NotFound, ct);
            await RejectList(client, current.Id, null, HttpStatusCode.Unauthorized, ct);
            await Reject(client, CancelRoute, outsider, Reference(htmlId), HttpStatusCode.NotFound, ct);

            AssertReceipt(await ReadTask(client, CreateRoute, owner, Create(wordId, current.Id, current.Revision, older.Revision, 3), ct),
                wordId, current, older.Revision, 3);
            AssertReceipt(await ReadTask(client, CreateRoute, owner, Create(epubId, current.Id, current.Revision, older.Revision, 4), ct),
                epubId, current, older.Revision, 4);
            var newer = await Save(client, owner, older.Id, current.Revision, "New saved private title", newerText, ct);
            Assert.True(newer.Revision > current.Revision);
            Assert.Equal(Queued, Assert.Single(await List(client, owner, older.Id, ct), task => task.Id == htmlId).State);
            await ReleaseClaim(db, ct);
            await Reject(client, CreateRoute, owner, Create(Guid.NewGuid(), current.Id, current.Revision, older.Revision, 1), HttpStatusCode.Conflict, ct);
            var afterEdit = await ReadTask(client, CreateRoute, owner, htmlRequest, ct);
            Assert.Equal(first.Created, afterEdit.Created);
            Assert.Equal(first.SourceDigest, afterEdit.SourceDigest);

            savedHtml = await AwaitTask(client, owner, older.Id, htmlId, Succeeded, ct);
            savedWord = await AwaitTask(client, owner, older.Id, wordId, Succeeded, ct);
            savedEpub = await AwaitTask(client, owner, older.Id, epubId, Succeeded, ct);
            foreach (var task in new[] { savedHtml, savedWord, savedEpub })
                Assert.Equal(SourceDigest(task, title, body, sourceTime), task.SourceDigest);
            Assert.Equal(first.SourceDigest, savedHtml.SourceDigest);
            Assert.Equal(current.Revision, savedHtml.ExpectedRevision);
            Assert.Equal(older.Revision, savedHtml.SourceRevision);
            Assert.Equal(new[] { htmlId, wordId, epubId }.Order(),
                (await List(client, owner, older.Id, ct)).Select(task => task.Id).Order());

            htmlBytes = await Download(client, owner, savedHtml, "text/html", "article.html", ct);
            var html = Encoding.UTF8.GetString(htmlBytes);
            Assert.Contains("<h2>Frozen section</h2>", html, StringComparison.Ordinal);
            Assert.Contains("Historical document marker.", html, StringComparison.Ordinal);
            Assert.DoesNotContain(newerText, html, StringComparison.Ordinal);
            WordDocumentExportTests.AssertFile(await Download(client, owner, savedWord, "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "article.docx", ct), title, "Historical document marker.");
            var chapter = EpubDocumentExportTests.AssertFile(await Download(client, owner, savedEpub, "application/epub+zip", "article.epub", ct),
                title, sourceTime.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture));
            Assert.Contains("Historical document marker.", chapter.Root!.Value, StringComparison.Ordinal);
            Assert.DoesNotContain(newerText, chapter.Root!.Value, StringComparison.Ordinal);
            await Reject(client, DownloadRoute, outsider, Reference(htmlId), HttpStatusCode.NotFound, ct);
            await Reject(client, DownloadRoute, reader, Reference(htmlId), HttpStatusCode.Forbidden, ct);
            await Reject(client, DownloadRoute, null, Reference(htmlId), HttpStatusCode.Unauthorized, ct);
            await CancelOwnedQueuedTask(db, client, owner, newer, older.Revision, cancelId, ct);
        }

        await using (var restarted = await ServerProcess.Start(fixture.ConnectionString, ct, Settings))
        {
            Assert.Equal(new[] { htmlId, wordId, epubId, cancelId }.Order(),
                (await List(restarted.Client, owner, older.Id, ct)).Select(task => task.Id).Order());
            Assert.Equal(htmlBytes, await Download(restarted.Client, owner, savedHtml, "text/html", "article.html", ct));

            Assert.Equal(1, await Execute(db, """
                update public.author_document_export set output=set_byte(output,0,(get_byte(output,0)+1)%256)
                where owner_id=$1 and id=$2
                """, ct, owner.Id, htmlId));
            await Reject(restarted.Client, DownloadRoute, owner, Reference(htmlId), HttpStatusCode.ServiceUnavailable, ct);
            var cancelled = await AwaitTask(restarted.Client, owner, older.Id, cancelId, Cancelled, ct);
            Assert.True(cancelled.Finished >= cancelled.Created);
            Assert.Equal(0, cancelled.Length);
            Assert.All(cancelled.OutputDigest, value => Assert.Equal(0, value));
            Assert.Equal(Cancelled, (await ReadTask(restarted.Client, CancelRoute, owner, Reference(cancelId), ct)).State);
            await Reject(restarted.Client, DownloadRoute, owner, Reference(cancelId), HttpStatusCode.NotFound, ct);

            // Preserve the internally consistent timestamps while making exactly one owned row expired.
            Assert.Equal(1, await Execute(db, """
                update public.author_document_export set
                  created_at=created_at-(expires_at-statement_timestamp()+interval '1 second'),
                  started_at=started_at-(expires_at-statement_timestamp()+interval '1 second'),
                  finished_at=finished_at-(expires_at-statement_timestamp()+interval '1 second'),
                  expires_at=statement_timestamp()-interval '1 second'
                where owner_id=$1 and id=$2
                """, ct, owner.Id, epubId));
            await Reject(restarted.Client, DownloadRoute, owner, Reference(epubId), HttpStatusCode.NotFound, ct);
            Assert.DoesNotContain(await List(restarted.Client, owner, older.Id, ct), task => task.Id == epubId);
        }

        await using var final = await ServerProcess.Start(fixture.ConnectionString, ct, Settings);
        Assert.Equal(Cancelled, Assert.Single(await List(final.Client, owner, older.Id, ct), task => task.Id == cancelId).State);
        await Reject(final.Client, DownloadRoute, owner, Reference(epubId), HttpStatusCode.NotFound, ct);
        await Poll(async token =>
        {
            await using var query = Store.Sql(db, null, "select not exists(select 1 from public.author_document_export where owner_id=$1 and id=$2)",
                owner.Id, epubId);
            return await query.ExecuteScalarAsync(token) is true;
        }, "The expired task was not removed by the worker on restart.", ct);
        await Execute(db, "delete from public.user_session where digest=$1", ct, Store.TokenDigest(owner.Token)!);
        await RejectList(final.Client, older.Id, owner, HttpStatusCode.Unauthorized, ct);
    }

    private static async Task CancelOwnedQueuedTask(NpgsqlConnection db, HttpClient client, Actor owner, Draft current, long source, Guid id,
        CancellationToken ct)
    {
        await HoldClaim(db, id, ct);
        try
        {
            var task = await ReadTask(client, CreateRoute, owner, Create(id, current.Id, current.Revision, source, format: 1), ct);
            Assert.Equal(Queued, task.State);
            Assert.Equal(Queued, Assert.Single(await List(client, owner, current.Id, ct), item => item.Id == id).State);
            Assert.Equal(Cancelled, (await ReadTask(client, CancelRoute, owner, Reference(id), ct)).State);
        }
        finally
        {
            await ReleaseClaim(db, ct);
        }
    }

    // Prevent only the selected fixture task from starting, regardless of the worker timer.
    private static Task<int> HoldClaim(NpgsqlConnection db, Guid id, CancellationToken ct) => Execute(db, $"""
        create function public.document_export_fixture_hold() returns trigger language plpgsql
        as $$ begin return null; end; $$;
        create trigger document_export_fixture_hold before update of state on public.author_document_export
        for each row when (old.id='{id:D}'::uuid and old.state=1 and new.state=2)
        execute function public.document_export_fixture_hold();
        """, ct);

    private static Task<int> ReleaseClaim(NpgsqlConnection db, CancellationToken ct) => Execute(db, """
        drop trigger document_export_fixture_hold on public.author_document_export;
        drop function public.document_export_fixture_hold();
        """, ct);

    private static async Task<ExportTask> AwaitTask(HttpClient client, Actor owner, int article, Guid id, byte state, CancellationToken ct)
    {
        ExportTask? ready = null;
        await Poll(async token =>
        {
            var task = Assert.Single(await List(client, owner, article, token), row => row.Id == id);
            if (task.State is Queued or Running or Cancelling) return false;
            Assert.Equal(state, task.State);
            ready = task;
            return true;
        }, $"Document task {id} did not reach a terminal state.", ct);
        return ready!;
    }

    private static async Task Poll(Func<CancellationToken, Task<bool>> condition, string failure, CancellationToken ct)
    {
        using var wait = CancellationTokenSource.CreateLinkedTokenSource(ct);
        wait.CancelAfter(TimeSpan.FromSeconds(15));
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(75));
        try
        {
            do { if (await condition(wait.Token)) return; }
            while (await timer.WaitForNextTickAsync(wait.Token));
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
        Assert.Fail(failure);
    }

    private static void AssertReceipt(ExportTask task, Guid id, Draft expected, long source, byte format)
    {
        Assert.Equal(id, task.Id);
        Assert.Equal(expected.Id, task.ArticleId);
        Assert.Equal(expected.Revision, task.ExpectedRevision);
        Assert.Equal(source, task.SourceRevision);
        Assert.Equal(format, task.Format);
        Assert.Equal(1, task.Provider);
        Assert.True(task.Created > 0 && task.Expires > task.Created);
        Assert.Contains(task.SourceDigest, value => value != 0);
    }

    private static async Task<DateTimeOffset> SourceTime(NpgsqlConnection db, Draft draft, CancellationToken ct)
    {
        await using var command = Store.Sql(db, null, "select happened_at from public.article_revision where article_id=$1 and revision=$2",
            draft.Id, draft.Revision);
        await using var row = await command.ExecuteReaderAsync(ct);
        Assert.True(await row.ReadAsync(ct));
        return row.GetFieldValue<DateTimeOffset>(0);
    }

    private static byte[] SourceDigest(ExportTask task, string title, string body, DateTimeOffset time)
    {
        using var payload = new MemoryStream();
        payload.Write("FsusBlog document export 1 basic-layout 1"u8);
        using var writer = new BinaryWriter(payload, Encoding.UTF8, leaveOpen: true);
        writer.Write(task.ArticleId);
        writer.Write(task.SourceRevision);
        writer.Write(time.UtcTicks);
        writer.Write(task.Format);
        writer.Write(task.Provider);
        var titleBytes = Encoding.UTF8.GetBytes(title);
        writer.Write(titleBytes.Length);
        writer.Write(titleBytes);
        writer.Write(Encoding.UTF8.GetBytes(body));
        return SHA256.HashData(payload.ToArray());
    }

    private static async Task<byte[]> Download(HttpClient client, Actor owner, ExportTask task, string mediaType, string name, CancellationToken ct)
    {
        using var response = await Send(client, DownloadRoute, owner, Reference(task.Id), ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.True(response.Headers.CacheControl?.Private);
        Assert.Equal(mediaType, response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
        Assert.Equal(name, response.Content.Headers.ContentDisposition?.FileNameStar);
        Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
        var output = await response.Content.ReadAsByteArrayAsync(ct);
        Assert.True(task.Started >= task.Created && task.Finished >= task.Started);
        Assert.Equal(0, task.Failure);
        Assert.Equal(task.Length, output.Length);
        Assert.Equal(task.OutputDigest, SHA256.HashData(output));
        return output;
    }

    private static async Task<ExportTask> ReadTask(HttpClient client, string route, Actor owner, byte[] command, CancellationToken ct) =>
        DecodeTask(Aeds.Decode(await ReadFrame(client, route, owner, command, HttpStatusCode.OK, ct), TaskFrame));

    private static async Task<ExportTask[]> List(HttpClient client, Actor owner, int article, CancellationToken ct) =>
        DecodeList(await ReadFrame(client, ListRoute(article), owner, null, HttpStatusCode.OK, ct));

    private static Task RejectList(HttpClient client, int article, Actor? owner, HttpStatusCode status, CancellationToken ct) =>
        Reject(client, ListRoute(article), owner, null, status, ct);

    private static async Task Reject(HttpClient client, string route, Actor? owner, byte[]? packet, HttpStatusCode status, CancellationToken ct)
    {
        var packetOut = await ReadFrame(client, route, owner, packet, status, ct);
        Assert.False(Aeds.Decode(packetOut, FrameType.ApiError).IsEmpty);
    }

    private static async Task<byte[]> ReadFrame(HttpClient client, string route, Actor? owner, byte[]? packet, HttpStatusCode status, CancellationToken ct)
    {
        using var response = await Send(client, route, owner, packet, ct);
        Assert.Equal(status, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
        Assert.Null(response.Content.Headers.ContentDisposition);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    private static async Task<HttpResponseMessage> Send(HttpClient client, string route, Actor? owner, byte[]? packet, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(packet is null ? HttpMethod.Get : HttpMethod.Post, route);
        if (owner is not null) request.Headers.Add("Cookie", $"fsus-v2-session={owner.Token}");
        if (owner?.Handle is { } handle) request.Headers.Add(WireHeaders.CurrentSession, handle);
        if (packet is not null)
        {
            request.Content = new ByteArrayContent(packet);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
        }
        return await client.SendAsync(request, ct);
    }

    private static async Task<Draft> Save(HttpClient client, Actor owner, int id, long revision, string title, string body, CancellationToken ct)
    {
        using var response = await Send(client, WireRoutes.Save, owner, Wire.EncodeArticleCommand(new(id, revision, Guid.NewGuid(), title, body)), ct);
        response.EnsureSuccessStatusCode();
        return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
    }

    private static async Task<Actor> Login(NpgsqlConnection db, Store store, string name, bool canAuthor, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var ticket = RandomNumberGenerator.GetBytes(32);
        await Execute(db, "insert into public.blog_user(id,name,can_author,enabled,generation) values($1,$2,$3,true,1)", ct, id, name, canAuthor);
        await Execute(db, "insert into public.login_ticket(digest,user_id,expires_at) values($1,$2,now()+interval '2 minutes')",
            ct, SHA256.HashData(ticket), id);
        var token = (await store.SignIn(Convert.ToHexStringLower(ticket), ct)).Token;
        return new(id, token, SiteSessions.Id(id, Store.TokenDigest(token)!));
    }

    private static async Task<int> Execute(NpgsqlConnection db, string sql, CancellationToken ct, params object[] values)
    {
        await using var command = Store.Sql(db, null, sql, values);
        return await command.ExecuteNonQueryAsync(ct);
    }

    private static string ListRoute(int article) => FormattableString.Invariant($"{Route}/{article}/tasks.aeds");

    private static byte[] Create(Guid id, int article, long expected, long source, byte format)
    {
        var payload = new byte[37];
        id.TryWriteBytes(payload, bigEndian: true, out _);
        BinaryPrimitives.WriteInt32LittleEndian(payload.AsSpan(16), article);
        BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(20), expected);
        BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(28), source);
        payload[36] = format;
        return Aeds.Encode(CreateFrame, payload);
    }

    private static byte[] Reference(Guid id) => Aeds.Encode(RefFrame, id.ToByteArray(bigEndian: true));

    private static ExportTask[] DecodeList(byte[] frame)
    {
        var payload = Aeds.Decode(frame, ListFrame);
        Assert.False(payload.IsEmpty);
        var count = payload[0];
        Assert.InRange(count, 0, 4);
        Assert.Equal(1 + count * TaskBytes, payload.Length);
        var result = new ExportTask[count];
        for (var i = 0; i < count; i++) result[i] = DecodeTask(payload.Slice(1 + i * TaskBytes, TaskBytes));
        return result;
    }

    private static ExportTask DecodeTask(ReadOnlySpan<byte> payload)
    {
        Assert.Equal(TaskBytes, payload.Length);
        return new(new Guid(payload[..16], bigEndian: true), BinaryPrimitives.ReadInt32LittleEndian(payload[16..]),
            BinaryPrimitives.ReadInt64LittleEndian(payload[20..]), BinaryPrimitives.ReadInt64LittleEndian(payload[28..]),
            payload[36], payload[37], payload[38], payload[39], BinaryPrimitives.ReadInt64LittleEndian(payload[40..]),
            BinaryPrimitives.ReadInt64LittleEndian(payload[48..]), BinaryPrimitives.ReadInt64LittleEndian(payload[56..]),
            BinaryPrimitives.ReadInt64LittleEndian(payload[64..]), payload[72..104].ToArray(), payload[104..136].ToArray(),
            BinaryPrimitives.ReadInt32LittleEndian(payload[136..]));
    }

    private sealed record Actor(Guid Id, string Token, string? Handle);
    private sealed record ExportTask(Guid Id, int ArticleId, long ExpectedRevision, long SourceRevision, byte Format, byte State, byte Failure,
        byte Provider, long Created, long Started, long Finished, long Expires, byte[] SourceDigest, byte[] OutputDigest, int Length);
}
