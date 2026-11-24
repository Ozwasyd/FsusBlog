namespace FsusBlog.V2.Integration.Tests;

public sealed partial class DocumentExportPostgresTests
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
    public async Task AQueuedLegacyProviderRendersItsOriginalProfileBesideCurrentTasks()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await Login(fixture, "Versioned document owner", canAuthor: true, ct);
        const string title = "Versions of one document";
        const string body = "| Left | Right |\n| --- | --- |\n| One | Two |\n";
        Draft source;
        await using (var before = await ServerProcess.Start(fixture.ConnectionString, ct))
            source = await Save(before.Client, owner, 0, 0, title, body, ct);
        var time = await SourceTime(db, source, ct);
        var legacy = new ExportTask(Guid.NewGuid(), source.Id, source.Revision, source.Revision,
            1, Queued, 0, 1, 0, 0, 0, 0, [], [], 0);
        var legacyDigest = SourceDigest(legacy, title, body, time);
        await FixtureSql.ExecuteAsync(db, null, ct, """
            insert into public.author_document_export
            (owner_id,id,article_id,expected_revision,source_revision,author_generation,format,state,created_at,expires_at,source_digest)
            values ($1,$2,$3,$4,$4,1,1,1,statement_timestamp(),statement_timestamp()+interval '30 minutes',$5)
            """, owner.Id, legacy.Id, source.Id, source.Revision, legacyDigest);

        await using var after = await ServerProcess.Start(fixture.ConnectionString, ct, Settings);
        var currentId = Guid.NewGuid();
        var current = await ReadTask(after.Client, CreateRoute, owner,
            Create(currentId, source.Id, source.Revision, source.Revision, 1), ct);
        AssertReceipt(current, currentId, source, source.Revision, 1);
        Assert.NotEqual(legacyDigest, current.SourceDigest);
        Assert.Equal(SourceDigest(current, title, body, time), current.SourceDigest);
        var oldResult = await AwaitTask(after.Client, owner, source.Id, legacy.Id, Succeeded, ct);
        var newResult = await AwaitTask(after.Client, owner, source.Id, currentId, Succeeded, ct);
        Assert.Equal(1, oldResult.Provider);
        Assert.Equal(legacyDigest, oldResult.SourceDigest);
        var plain = await Download(after.Client, owner, oldResult, "text/html", "article.html", ct);
        var structured = await Download(after.Client, owner, newResult, "text/html", "article.html", ct);
        Assert.Contains("| One | Two |", Encoding.UTF8.GetString(plain), StringComparison.Ordinal);
        Assert.DoesNotContain("<table", Encoding.UTF8.GetString(plain), StringComparison.Ordinal);
        Assert.Contains("<table", Encoding.UTF8.GetString(structured), StringComparison.Ordinal);
    }

    [PostgresFact]
    public async Task DocumentTasksFreezeSavedSourceAndProtectDurableDownloads()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await Login(fixture, "Document task owner", canAuthor: true, ct);
        var outsider = await Login(fixture, "Document task outsider", canAuthor: true, ct);
        var reader = await Login(fixture, "Document task reader", canAuthor: false, ct);

        const string title = "Pinned Chinese 中文 title";
        const string body = "## Frozen section\n\nHistorical document marker.\n\n### Subsection\n\n~~~js\nconst saved = true;\n~~~\n";
        const string newerText = "Unrelated current document marker.";
        var htmlId = Guid.NewGuid();
        var wordId = Guid.NewGuid();
        var epubId = Guid.NewGuid();
        var cancelId = Guid.NewGuid();
        ExportTask savedHtml;
        ExportTask savedWord;
        ExportTask savedEpub;
        Draft older;
        byte[] htmlBytes, epubReceipt;

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
            await Reject(client, CreateRoute, reader, htmlRequest, HttpStatusCode.Unauthorized, ct);
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
            Assert.Contains(chapter.Descendants(), element => element.Name.LocalName == "h3" && element.Value == "Subsection");
            Assert.Equal("language-js", (string?)Assert.Single(chapter.Descendants(), element => element.Name.LocalName == "code").Attribute("class"));
            epubReceipt = await ReadEpubFormatting(client);
            var report = JsonNode.Parse(epubReceipt)!;
            Assert.Equal(2, (int)report["version"]!);
            Assert.Equal(Convert.ToHexStringLower(savedEpub.OutputDigest), (string?)report["output"]?["sha256"]);
            var warnings = report["warnings"]!.AsArray();
            Assert.Equal(new[] { "epub-headings-outside-contents", "epub-code-unhighlighted" },
                warnings.Select(item => (string)item!["code"]!));
            Assert.Equal(2, (int)warnings[0]!["occurrences"]!);
            Assert.Equal(0, (int)warnings[0]!["start"]!);
            Assert.Equal(body.IndexOf("~~~js", StringComparison.Ordinal), (int)warnings[1]!["start"]!);
            await Reject(client, DownloadRoute, outsider, Reference(htmlId), HttpStatusCode.NotFound, ct);
            await ExportResponseFixture.Receipt(client, htmlId, outsider.Token, outsider.Handle, HttpStatusCode.NotFound, ct);
            await Reject(client, DownloadRoute, reader, Reference(htmlId), HttpStatusCode.Unauthorized, ct);
            await Reject(client, DownloadRoute, null, Reference(htmlId), HttpStatusCode.Unauthorized, ct);
            await CancelOwnedQueuedTask(db, client, owner, newer, older.Revision, cancelId, ct);
        }

        await using (var restarted = await ServerProcess.Start(fixture.ConnectionString, ct, Settings))
        {
            Assert.Equal(new[] { htmlId, wordId, epubId, cancelId }.Order(),
                (await List(restarted.Client, owner, older.Id, ct)).Select(task => task.Id).Order());
            Assert.Equal(htmlBytes, await Download(restarted.Client, owner, savedHtml, "text/html", "article.html", ct));
            Assert.Equal(epubReceipt, await ReadEpubFormatting(restarted.Client));

            Assert.Equal(1, await FixtureSql.ExecuteAsync(db, null, ct, """
                update public.author_document_export set output=set_byte(output,0,(get_byte(output,0)+1)%256)
                where owner_id=$1 and id=$2
                """, owner.Id, htmlId));
            await Reject(restarted.Client, DownloadRoute, owner, Reference(htmlId), HttpStatusCode.ServiceUnavailable, ct);
            var cancelled = await AwaitTask(restarted.Client, owner, older.Id, cancelId, Cancelled, ct);
            Assert.True(cancelled.Finished >= cancelled.Created);
            Assert.Equal(0, cancelled.Length);
            Assert.All(cancelled.OutputDigest, value => Assert.Equal(0, value));
            Assert.Equal(Cancelled, (await ReadTask(restarted.Client, CancelRoute, owner, Reference(cancelId), ct)).State);
            await Reject(restarted.Client, DownloadRoute, owner, Reference(cancelId), HttpStatusCode.NotFound, ct);

            // Preserve the internally consistent timestamps while making exactly one owned row expired.
            Assert.Equal(1, await FixtureSql.ExecuteAsync(db, null, ct, """
                update public.author_document_export set
                  created_at=created_at-(expires_at-statement_timestamp()+interval '1 second'),
                  started_at=started_at-(expires_at-statement_timestamp()+interval '1 second'),
                  finished_at=finished_at-(expires_at-statement_timestamp()+interval '1 second'),
                  expires_at=statement_timestamp()-interval '1 second'
                where owner_id=$1 and id=$2
                """, owner.Id, epubId));
            await Reject(restarted.Client, DownloadRoute, owner, Reference(epubId), HttpStatusCode.NotFound, ct);
            await ExportResponseFixture.Receipt(restarted.Client, epubId, owner.Token, owner.Handle, HttpStatusCode.NotFound, ct);
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
        await FixtureSql.ExecuteAsync(db, null, ct, "delete from public.admin_session where digest=$1", Store.TokenDigest(owner.Token)!);
        await RejectList(final.Client, older.Id, owner, HttpStatusCode.Unauthorized, ct);
        await ExportResponseFixture.Receipt(final.Client, wordId, owner.Token, owner.Handle, HttpStatusCode.Unauthorized, ct);

        async Task<byte[]> ReadEpubFormatting(HttpClient client)
        {
            const string type = "application/vnd.fsus.document-export-receipt.v2+json";
            using var response = await SiteAedsFixture.ExpectPrivateResponse(client, HttpMethod.Post, DownloadRoute, Reference(epubId),
                owner.Token, owner.Handle, HttpStatusCode.OK, ct, type);
            ExportResponseFixture.Attachment(response, type, "article.export-receipt.json");
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
    }

    [PostgresFact]
    public async Task WordReceiptReportsTheSavedSourcesLiteralFormattingWithoutChangingOutput()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await Login(fixture, "Word warning owner", canAuthor: true, ct);
        const string body = """
            #### Heading *markup*

            - **First**
            - *Second*

            > [Link](https://export.invalid/reference)

            `inline code` and ![image](media.png).

            ---

            ~~~mermaid
            ignored **[markup](https://export.invalid/code)** in the directive
            ~~~

            ~~~js
            const plain = 'code';
            ~~~
            """;
        const string type = "application/vnd.fsus.document-export-receipt.v2+json";
        var id = Guid.NewGuid();
        byte[] audited;
        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, Settings))
        {
            var source = await Save(server.Client, owner, 0, 0, "Original formatting", body, ct);
            var current = await Save(server.Client, owner, source.Id, source.Revision, "Later source", "Plain text.", ct);
            await ReadTask(server.Client, CreateRoute, owner, Create(id, source.Id, current.Revision, source.Revision, 3), ct);
            var ready = await AwaitTask(server.Client, owner, source.Id, id, Succeeded, ct);
            var document = await Download(server.Client, owner, ready,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "article.docx", ct);
            WordDocumentExportTests.AssertFile(document, "- **First**", "> [Link](https://export.invalid/reference)", "`inline code`");
            var receipt = JsonNode.Parse(await ExportResponseFixture.Receipt(server.Client, id, owner.Token,
                owner.Handle, HttpStatusCode.OK, ct))!;
            Assert.Equal(1, (int)receipt["version"]!);
            Assert.Null(receipt["warnings"]);
            audited = await ReadWordWarnings(server.Client);
            var details = JsonNode.Parse(audited)!;
            Assert.Equal(2, (int)details["version"]!);
            Assert.Equal(Convert.ToHexStringLower(ready.OutputDigest), (string?)details["output"]?["sha256"]);
            var warnings = details["warnings"]!.AsArray().ToDictionary(item => (string)item!["code"]!);
            Assert.Equal(11, warnings.Count);
            Span("list-as-text", "- **First**", 1);
            Span("link-as-text", "[Link]", 1);
            Span("emphasis-as-text", "*markup*", 3);
            Span("render-directive-as-code", "~~~mermaid", 1);
            Span("code-language-omitted", "~~~js", 1);
            void Span(string code, string prefix, int occurrences)
            {
                var warning = warnings[code]!;
                Assert.Equal(occurrences, (int)warning["occurrences"]!);
                Assert.StartsWith(prefix, body.Substring((int)warning["start"]!, (int)warning["length"]!), StringComparison.Ordinal);
            }
        }
        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct, Settings);
        Assert.Equal(audited, await ReadWordWarnings(restarted.Client));

        async Task<byte[]> ReadWordWarnings(HttpClient client)
        {
            using var response = await SiteAedsFixture.ExpectPrivateResponse(client, HttpMethod.Post, DownloadRoute, Reference(id),
                owner.Token, owner.Handle, HttpStatusCode.OK, ct, type);
            ExportResponseFixture.Attachment(response, type, "article.export-receipt.json");
            return await response.Content.ReadAsByteArrayAsync(ct);
        }
    }

    [PostgresFact]
    public async Task WorkerRefusesSavedMetadataDriftAndRestartKeepsTheFailedAttempt()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        await using var db = await fixture.DataSource.OpenConnectionAsync(ct);
        var owner = await Login(fixture, "Export retry witness", canAuthor: true, ct);
        const string title = "Selected title";
        const string body = "Frozen export witness.";
        var failed = (byte)DocumentExportState.Failed;
        var firstId = Guid.NewGuid();
        Draft source;
        Draft edited;
        DateTimeOffset sourceTime;
        byte[] firstRequest;
        byte[] firstReceipt;
        byte[] originalDigest;
        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, Settings))
        {
            var client = server.Client;
            source = await Save(client, owner, 0, 0, title, body, ct);
            sourceTime = await SourceTime(db, source, ct);
            firstRequest = Create(firstId, source.Id, source.Revision, source.Revision, 1);
            await HoldClaim(db, firstId, ct);
            try
            {
                var queued = await ReadTask(client, CreateRoute, owner, firstRequest, ct);
                Assert.Equal(Queued, queued.State);
                originalDigest = SourceDigest(queued, title, body, sourceTime);
                Assert.Equal(originalDigest, queued.SourceDigest);
                Assert.Equal(1, await FixtureSql.ExecuteAsync(db, null, ct, """
                    update public.article_revision set happened_at=happened_at+interval '1 minute'
                    where article_id=$1 and revision=$2
                    """, source.Id, source.Revision));
            }
            finally { await ReleaseClaim(db, ct); }

            var drifted = await AwaitTask(client, owner, source.Id, firstId, failed, ct);
            Assert.Equal((byte)DocumentExportFailure.Unavailable, drifted.Failure);
            Assert.Equal(originalDigest, drifted.SourceDigest);
            AssertNoOutput(drifted);
            await Reject(client, DownloadRoute, owner, Reference(firstId), HttpStatusCode.NotFound, ct);
            firstReceipt = await ReadFrame(client, CreateRoute, owner, firstRequest, HttpStatusCode.OK, ct);
            Assert.Equal(1, await FixtureSql.ExecuteAsync(db, null, ct, """
                update public.article_revision set happened_at=$1 where article_id=$2 and revision=$3
                """, sourceTime, source.Id, source.Revision));
            edited = await Save(client, owner, source.Id, source.Revision, "Later private revision",
                "![unsupported](https://export.invalid/saved.png)", ct);
        }

        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct, Settings);
        var resumed = restarted.Client;
        Assert.Equal(firstReceipt, await ReadFrame(resumed, CreateRoute, owner, firstRequest, HttpStatusCode.OK, ct));
        var nextId = Guid.NewGuid();
        var next = await ReadTask(resumed, CreateRoute, owner, Create(nextId, edited.Id, edited.Revision, source.Revision, 1), ct);
        AssertReceipt(next, nextId, edited, source.Revision, 1);
        Assert.Equal(originalDigest, next.SourceDigest);
        var succeeded = await AwaitTask(resumed, owner, source.Id, nextId, Succeeded, ct);
        var html = Encoding.UTF8.GetString(await Download(resumed, owner, succeeded, "text/html", "article.html", ct));
        Assert.Contains(body, html, StringComparison.Ordinal);
        Assert.DoesNotContain("Later private revision", html, StringComparison.Ordinal);

        var unsupportedId = Guid.NewGuid();
        var unsupportedRequest = Create(unsupportedId, edited.Id, edited.Revision, edited.Revision, 1);
        await ReadTask(resumed, CreateRoute, owner, unsupportedRequest, ct);
        var unsupported = await AwaitTask(resumed, owner, source.Id, unsupportedId, failed, ct);
        Assert.Equal((byte)DocumentExportFailure.Unsupported, unsupported.Failure);
        AssertNoOutput(unsupported);
        await Reject(resumed, DownloadRoute, owner, Reference(unsupportedId), HttpStatusCode.NotFound, ct);
        Assert.Equal(firstReceipt, await ReadFrame(resumed, CreateRoute, owner, firstRequest, HttpStatusCode.OK, ct));
        Assert.Equal(failed, (await ReadTask(resumed, CreateRoute, owner, unsupportedRequest, ct)).State);
        Assert.Equal(new[] { firstId, nextId, unsupportedId }.Order(),
            (await List(resumed, owner, source.Id, ct)).Select(task => task.Id).Order());

        static void AssertNoOutput(ExportTask task)
        {
            Assert.True(task.Started >= task.Created && task.Finished >= task.Started);
            Assert.Equal(0, task.Length);
            Assert.All(task.OutputDigest, value => Assert.Equal(0, value));
        }
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
    internal static Task<int> HoldClaim(NpgsqlConnection db, Guid id, CancellationToken ct) => FixtureSql.ExecuteAsync(db, null, ct, $"""
        create function public.document_export_fixture_hold() returns trigger language plpgsql
        as $$ begin return null; end; $$;
        create trigger document_export_fixture_hold before update of state on public.author_document_export
        for each row when (old.id='{id:D}'::uuid and old.state=1 and new.state=2)
        execute function public.document_export_fixture_hold();
        """);

    internal static Task<int> ReleaseClaim(NpgsqlConnection db, CancellationToken ct) => FixtureSql.ExecuteAsync(db, null, ct, """
        drop trigger document_export_fixture_hold on public.author_document_export;
        drop function public.document_export_fixture_hold();
        """);

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
        Assert.Equal(2, task.Provider);
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
        payload.Write(Encoding.UTF8.GetBytes(FormattableString.Invariant($"FsusBlog document export {task.Provider} basic-layout 1")));
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
        using var response = await SiteAedsFixture.ExpectPrivateResponse(client, HttpMethod.Post, DownloadRoute,
            Reference(task.Id), owner.Token, owner.Handle, HttpStatusCode.OK, ct);
        ExportResponseFixture.Attachment(response, mediaType, name);
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
        using var response = await SiteAedsFixture.ExpectPrivateResponse(client, packet is null ? HttpMethod.Get : HttpMethod.Post,
            route, packet, owner?.Token, owner?.Handle, status, ct);
        ExportResponseFixture.AedsWithoutAttachment(response);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    private static Task<Draft> Save(HttpClient client, Actor owner, int id, long revision, string title, string body, CancellationToken ct) =>
        SiteAedsFixture.SaveDraft(client, owner.Token, owner.Handle, id, revision, title, body, ct);

    private static async Task<Actor> Login(ScratchDatabase fixture, string name, bool canAuthor, CancellationToken ct)
    {
        var (id, token, handle) = await fixture.SignIn(name, ct, canAuthor);
        return new(id, token, handle);
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
