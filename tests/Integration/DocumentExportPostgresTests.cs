namespace FsusBlog.V2.Integration.Tests;

public sealed partial class DocumentExportPostgresTests
{
    private const string DocxType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
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
        var owner = await Login(fixture, "Versioned document owner", canAuthor: true, ct);
        const string title = "Versions of one document";
        const string body = "| Left | Right |\n| --- | --- |\n| One | Two |\n";
        Draft source;
        await using (var before = await ServerProcess.Start(fixture.ConnectionString, ct))
            source = await new ExportClient(before.Client, owner, ct).Save(0, 0, title, body);
        var time = await SourceTime(fixture, source, ct);
        var legacyId = Guid.NewGuid();
        var legacyDigest = SourceDigest(source.Id, source.Revision, DocumentExportFormat.Html, 1, title, body, time);
        await fixture.Exec("""
            insert into public.author_document_export
            (owner_id,id,article_id,expected_revision,source_revision,author_generation,format,state,created_at,expires_at,source_digest)
            values ($1,$2,$3,$4,$4,1,1,1,statement_timestamp(),statement_timestamp()+interval '30 minutes',$5)
            """, owner.Id, legacyId, source.Id, source.Revision, legacyDigest);

        await using var after = await ServerProcess.Start(fixture.ConnectionString, ct, Settings);
        var exp = new ExportClient(after.Client, owner, ct);
        var currentId = Guid.NewGuid();
        var current = await exp.CreateTask(currentId, source, source.Revision, DocumentExportFormat.Html);
        AssertReceipt(current, currentId, source, source.Revision, DocumentExportFormat.Html);
        Assert.NotEqual(legacyDigest, current.SourceDigest);
        Assert.Equal(SourceDigest(current, title, body, time), current.SourceDigest);
        var oldResult = await exp.Await(source.Id, legacyId, DocumentExportState.Succeeded);
        var newResult = await exp.Await(source.Id, currentId, DocumentExportState.Succeeded);
        Assert.Equal(1, oldResult.Provider);
        Assert.Equal(legacyDigest, oldResult.SourceDigest);
        var plain = Encoding.UTF8.GetString(await exp.Download(oldResult, "text/html", "article.html"));
        var structured = Encoding.UTF8.GetString(await exp.Download(newResult, "text/html", "article.html"));
        Assert.Contains("| One | Two |", plain, StringComparison.Ordinal);
        Assert.DoesNotContain("<table", plain, StringComparison.Ordinal);
        Assert.Contains("<table", structured, StringComparison.Ordinal);
    }

    [PostgresFact]
    public async Task DocumentTasksFreezeSavedSourceAndProtectDurableDownloads()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await Login(fixture, "Document task owner", canAuthor: true, ct);
        var outsider = await Login(fixture, "Document task outsider", canAuthor: true, ct);
        var reader = await Login(fixture, "Document task reader", canAuthor: false, ct);

        const string title = "Pinned Chinese 中文 title";
        const string body = "## Frozen section\n\nHistorical document marker.\n\n### Subsection\n\n~~~js\nconst saved = true;\n~~~\n";
        const string newerText = "Unrelated current document marker.";
        var (htmlId, wordId, epubId, cancelId) = (Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid());
        DocumentExportTask savedHtml, savedWord, savedEpub;
        Draft older;
        byte[] htmlBytes, epubReceipt;

        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, Settings))
        {
            var exp = new ExportClient(server.Client, owner, ct);
            older = await exp.Save(0, 0, title, body);
            var sourceTime = await SourceTime(fixture, older, ct);
            var current = await exp.Save(older.Id, older.Revision, "Current private title", newerText);
            await HoldClaim(fixture, htmlId, ct);
            var htmlRequest = Create(htmlId, current.Id, current.Revision, older.Revision, DocumentExportFormat.Html);
            var first = await exp.ReadTask(WireRoutes.DocumentExportCreate, htmlRequest);
            AssertReceipt(first, htmlId, current, older.Revision, DocumentExportFormat.Html);
            Assert.Equal(DocumentExportState.Queued, first.State);
            var replay = await exp.ReadTask(WireRoutes.DocumentExportCreate, htmlRequest);
            Assert.Equal(first.Created, replay.Created);
            Assert.Equal(first.SourceDigest, replay.SourceDigest);
            foreach (var (route, actor, packet, status) in new (string, Actor?, byte[]?, HttpStatusCode)[]
            {
                (WireRoutes.DocumentExportCreate, owner, Create(htmlId, current.Id, current.Revision, older.Revision, DocumentExportFormat.Docx), Conflict),
                (WireRoutes.DocumentExportCreate, owner, Create(Guid.NewGuid(), current.Id, current.Revision, older.Revision, DocumentExportFormat.Pdf), BadRequest),
                (WireRoutes.DocumentExportCreate, null, htmlRequest, Unauthorized),
                (WireRoutes.DocumentExportCreate, outsider, htmlRequest, NotFound),
                (WireRoutes.DocumentExportCreate, reader, htmlRequest, Unauthorized),
                (WireRoutes.DocumentExportCreate, owner with { Handle = outsider.Handle }, htmlRequest, Conflict),
                (WireRoutes.DocumentExportDownload, owner with { Handle = null }, Reference(htmlId), Conflict),
                (ListRoute(current.Id), outsider, null, NotFound),
                (ListRoute(current.Id), null, null, Unauthorized),
                (WireRoutes.DocumentExportCancel, outsider, Reference(htmlId), NotFound),
            })
                await exp.Reject(route, packet, status, actor);

            AssertReceipt(await exp.CreateTask(wordId, current, older.Revision, DocumentExportFormat.Docx), wordId, current, older.Revision, DocumentExportFormat.Docx);
            AssertReceipt(await exp.CreateTask(epubId, current, older.Revision, DocumentExportFormat.Epub), epubId, current, older.Revision, DocumentExportFormat.Epub);
            var newer = await exp.Save(older.Id, current.Revision, "New saved private title", newerText);
            Assert.True(newer.Revision > current.Revision);
            Assert.Equal(DocumentExportState.Queued, Assert.Single(await exp.List(older.Id), task => task.Request.Id == htmlId).State);
            await ReleaseClaim(fixture, ct);
            await exp.Reject(WireRoutes.DocumentExportCreate, Create(Guid.NewGuid(), current.Id, current.Revision, older.Revision, DocumentExportFormat.Html), Conflict);
            var afterEdit = await exp.ReadTask(WireRoutes.DocumentExportCreate, htmlRequest);
            Assert.Equal(first.Created, afterEdit.Created);
            Assert.Equal(first.SourceDigest, afterEdit.SourceDigest);

            savedHtml = await exp.Await(older.Id, htmlId, DocumentExportState.Succeeded);
            savedWord = await exp.Await(older.Id, wordId, DocumentExportState.Succeeded);
            savedEpub = await exp.Await(older.Id, epubId, DocumentExportState.Succeeded);
            foreach (var task in new[] { savedHtml, savedWord, savedEpub })
                Assert.Equal(SourceDigest(task, title, body, sourceTime), task.SourceDigest);
            Assert.Equal(first.SourceDigest, savedHtml.SourceDigest);
            Assert.Equal((current.Revision, older.Revision), (savedHtml.Request.Revision, savedHtml.Request.SourceRevision));
            Assert.Equal(new[] { htmlId, wordId, epubId }.Order(), (await exp.List(older.Id)).Select(task => task.Request.Id).Order());

            htmlBytes = await exp.Download(savedHtml, "text/html", "article.html");
            var html = Encoding.UTF8.GetString(htmlBytes);
            Assert.Contains("<h2>Frozen section</h2>", html, StringComparison.Ordinal);
            Assert.Contains("Historical document marker.", html, StringComparison.Ordinal);
            Assert.DoesNotContain(newerText, html, StringComparison.Ordinal);
            WordDocumentExportTests.AssertFile(await exp.Download(savedWord, DocxType, "article.docx"), title, "Historical document marker.");
            var chapter = EpubDocumentExportTests.AssertFile(await exp.Download(savedEpub, "application/epub+zip", "article.epub"),
                title, sourceTime.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture));
            Assert.Contains("Historical document marker.", chapter.Root!.Value, StringComparison.Ordinal);
            Assert.DoesNotContain(newerText, chapter.Root!.Value, StringComparison.Ordinal);
            Assert.Contains(chapter.Descendants(), element => element.Name.LocalName == "h3" && element.Value == "Subsection");
            Assert.Equal("language-js", (string?)Assert.Single(chapter.Descendants(), element => element.Name.LocalName == "code").Attribute("class"));
            epubReceipt = await exp.Receipt(epubId, OK, version: 2);
            var report = JsonNode.Parse(epubReceipt)!;
            Assert.Equal(2, (int)report["version"]!);
            Assert.Equal(Convert.ToHexStringLower(savedEpub.OutputDigest!), (string?)report["output"]?["sha256"]);
            var warnings = report["warnings"]!.AsArray();
            Assert.Equal(new[] { "epub-headings-outside-contents", "epub-code-unhighlighted" }, warnings.Select(item => (string)item!["code"]!));
            Assert.Equal((2, 0, body.IndexOf("~~~js", StringComparison.Ordinal)),
                ((int)warnings[0]!["occurrences"]!, (int)warnings[0]!["start"]!, (int)warnings[1]!["start"]!));
            foreach (var (actor, status) in new (Actor?, HttpStatusCode)[] { (outsider, NotFound), (reader, Unauthorized), (null, Unauthorized) })
                await exp.Reject(WireRoutes.DocumentExportDownload, Reference(htmlId), status, actor);
            await exp.Receipt(htmlId, NotFound, actor: outsider);

            await HoldClaim(fixture, cancelId, ct);
            try
            {
                var queued = await exp.CreateTask(cancelId, newer, older.Revision, DocumentExportFormat.Html);
                Assert.Equal(DocumentExportState.Queued, queued.State);
                Assert.Equal(DocumentExportState.Queued, Assert.Single(await exp.List(newer.Id), item => item.Request.Id == cancelId).State);
                Assert.Equal(DocumentExportState.Cancelled, (await exp.Cancel(cancelId)).State);
            }
            finally { await ReleaseClaim(fixture, ct); }
        }

        await using (var restarted = await ServerProcess.Start(fixture.ConnectionString, ct, Settings))
        {
            var exp = new ExportClient(restarted.Client, owner, ct);
            Assert.Equal(new[] { htmlId, wordId, epubId, cancelId }.Order(), (await exp.List(older.Id)).Select(task => task.Request.Id).Order());
            Assert.Equal(htmlBytes, await exp.Download(savedHtml, "text/html", "article.html"));
            Assert.Equal(epubReceipt, await exp.Receipt(epubId, OK, version: 2));

            Assert.Equal(1, await fixture.Exec("""
                update public.author_document_export set output=set_byte(output,0,(get_byte(output,0)+1)%256)
                where owner_id=$1 and id=$2
                """, owner.Id, htmlId));
            await exp.Reject(WireRoutes.DocumentExportDownload, Reference(htmlId), ServiceUnavailable);
            var cancelled = await exp.Await(older.Id, cancelId, DocumentExportState.Cancelled);
            Assert.True(cancelled.Finished >= cancelled.Created);
            Assert.Equal(0, cancelled.OutputBytes);
            Assert.Null(cancelled.OutputDigest);
            Assert.Equal(DocumentExportState.Cancelled, (await exp.Cancel(cancelId)).State);
            await exp.Reject(WireRoutes.DocumentExportDownload, Reference(cancelId), NotFound);

            // Preserve the internally consistent timestamps while making exactly one owned row expired.
            Assert.Equal(1, await fixture.Exec("""
                update public.author_document_export set
                  created_at=created_at-(expires_at-statement_timestamp()+interval '1 second'),
                  started_at=started_at-(expires_at-statement_timestamp()+interval '1 second'),
                  finished_at=finished_at-(expires_at-statement_timestamp()+interval '1 second'),
                  expires_at=statement_timestamp()-interval '1 second'
                where owner_id=$1 and id=$2
                """, owner.Id, epubId));
            await exp.Reject(WireRoutes.DocumentExportDownload, Reference(epubId), NotFound);
            await exp.Receipt(epubId, NotFound);
            Assert.DoesNotContain(await exp.List(older.Id), task => task.Request.Id == epubId);
        }

        await using var final = await ServerProcess.Start(fixture.ConnectionString, ct, Settings);
        var last = new ExportClient(final.Client, owner, ct);
        Assert.Equal(DocumentExportState.Cancelled, Assert.Single(await last.List(older.Id), task => task.Request.Id == cancelId).State);
        await last.Reject(WireRoutes.DocumentExportDownload, Reference(epubId), NotFound);
        await Poll(token => fixture.ScalarAsync<bool>(token,
            "select not exists(select 1 from public.author_document_export where owner_id=$1 and id=$2)", owner.Id, epubId),
            "The expired task was not removed by the worker on restart.", ct);
        await fixture.Exec("delete from public.admin_session where digest=$1", Store.TokenDigest(owner.Token)!);
        await last.Reject(ListRoute(older.Id), null, Unauthorized);
        await last.Receipt(wordId, Unauthorized);
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
        var id = Guid.NewGuid();
        byte[] audited;
        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, Settings))
        {
            var exp = new ExportClient(server.Client, owner, ct);
            var source = await exp.Save(0, 0, "Original formatting", body);
            var current = await exp.Save(source.Id, source.Revision, "Later source", "Plain text.");
            await exp.CreateTask(id, current, source.Revision, DocumentExportFormat.Docx);
            var ready = await exp.Await(source.Id, id, DocumentExportState.Succeeded);
            var document = await exp.Download(ready, DocxType, "article.docx");
            WordDocumentExportTests.AssertFile(document, "- **First**", "> [Link](https://export.invalid/reference)", "`inline code`");
            var receipt = JsonNode.Parse(await exp.Receipt(id, OK))!;
            Assert.Equal(1, (int)receipt["version"]!);
            Assert.Null(receipt["warnings"]);
            audited = await exp.Receipt(id, OK, version: 2);
            var details = JsonNode.Parse(audited)!;
            Assert.Equal(2, (int)details["version"]!);
            Assert.Equal(Convert.ToHexStringLower(ready.OutputDigest!), (string?)details["output"]?["sha256"]);
            var warnings = details["warnings"]!.AsArray().ToDictionary(item => (string)item!["code"]!);
            Assert.Equal(11, warnings.Count);
            foreach (var (code, prefix, occurrences) in new[]
            {
                ("list-as-text", "- **First**", 1),
                ("link-as-text", "[Link]", 1),
                ("emphasis-as-text", "*markup*", 3),
                ("render-directive-as-code", "~~~mermaid", 1),
                ("code-language-omitted", "~~~js", 1),
            })
            {
                var warning = warnings[code]!;
                Assert.Equal(occurrences, (int)warning["occurrences"]!);
                Assert.StartsWith(prefix, body.Substring((int)warning["start"]!, (int)warning["length"]!), StringComparison.Ordinal);
            }
        }
        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct, Settings);
        Assert.Equal(audited, await new ExportClient(restarted.Client, owner, ct).Receipt(id, OK, version: 2));
    }

    [PostgresFact]
    public async Task WorkerRefusesSavedMetadataDriftAndRestartKeepsTheFailedAttempt()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await Login(fixture, "Export retry witness", canAuthor: true, ct);
        const string title = "Selected title";
        const string body = "Frozen export witness.";
        var firstId = Guid.NewGuid();
        Draft source, edited;
        DateTimeOffset sourceTime;
        byte[] firstRequest, firstReceipt, originalDigest;
        await using (var server = await ServerProcess.Start(fixture.ConnectionString, ct, Settings))
        {
            var exp = new ExportClient(server.Client, owner, ct);
            source = await exp.Save(0, 0, title, body);
            sourceTime = await SourceTime(fixture, source, ct);
            firstRequest = Create(firstId, source.Id, source.Revision, source.Revision, DocumentExportFormat.Html);
            await HoldClaim(fixture, firstId, ct);
            try
            {
                var queued = await exp.ReadTask(WireRoutes.DocumentExportCreate, firstRequest);
                Assert.Equal(DocumentExportState.Queued, queued.State);
                originalDigest = SourceDigest(queued, title, body, sourceTime);
                Assert.Equal(originalDigest, queued.SourceDigest);
                Assert.Equal(1, await fixture.Exec("""
                    update public.article_revision set happened_at=happened_at+interval '1 minute'
                    where article_id=$1 and revision=$2
                    """, source.Id, source.Revision));
            }
            finally { await ReleaseClaim(fixture, ct); }

            var drifted = await exp.Await(source.Id, firstId, DocumentExportState.Failed);
            Assert.Equal(DocumentExportFailure.Unavailable, drifted.Failure);
            Assert.Equal(originalDigest, drifted.SourceDigest);
            AssertNoOutput(drifted);
            await exp.Reject(WireRoutes.DocumentExportDownload, Reference(firstId), NotFound);
            firstReceipt = await exp.ReadFrame(WireRoutes.DocumentExportCreate, firstRequest, OK);
            Assert.Equal(1, await fixture.Exec("update public.article_revision set happened_at=$1 where article_id=$2 and revision=$3",
                sourceTime, source.Id, source.Revision));
            edited = await exp.Save(source.Id, source.Revision, "Later private revision", "![unsupported](https://export.invalid/saved.png)");
        }

        await using var restarted = await ServerProcess.Start(fixture.ConnectionString, ct, Settings);
        var resumed = new ExportClient(restarted.Client, owner, ct);
        Assert.Equal(firstReceipt, await resumed.ReadFrame(WireRoutes.DocumentExportCreate, firstRequest, OK));
        var nextId = Guid.NewGuid();
        var next = await resumed.CreateTask(nextId, edited, source.Revision, DocumentExportFormat.Html);
        AssertReceipt(next, nextId, edited, source.Revision, DocumentExportFormat.Html);
        Assert.Equal(originalDigest, next.SourceDigest);
        var succeeded = await resumed.Await(source.Id, nextId, DocumentExportState.Succeeded);
        var html = Encoding.UTF8.GetString(await resumed.Download(succeeded, "text/html", "article.html"));
        Assert.Contains(body, html, StringComparison.Ordinal);
        Assert.DoesNotContain("Later private revision", html, StringComparison.Ordinal);

        var unsupportedId = Guid.NewGuid();
        var unsupportedRequest = Create(unsupportedId, edited.Id, edited.Revision, edited.Revision, DocumentExportFormat.Html);
        await resumed.ReadTask(WireRoutes.DocumentExportCreate, unsupportedRequest);
        var unsupported = await resumed.Await(source.Id, unsupportedId, DocumentExportState.Failed);
        Assert.Equal(DocumentExportFailure.Unsupported, unsupported.Failure);
        AssertNoOutput(unsupported);
        await resumed.Reject(WireRoutes.DocumentExportDownload, Reference(unsupportedId), NotFound);
        Assert.Equal(firstReceipt, await resumed.ReadFrame(WireRoutes.DocumentExportCreate, firstRequest, OK));
        Assert.Equal(DocumentExportState.Failed, (await resumed.ReadTask(WireRoutes.DocumentExportCreate, unsupportedRequest)).State);
        Assert.Equal(new[] { firstId, nextId, unsupportedId }.Order(), (await resumed.List(source.Id)).Select(task => task.Request.Id).Order());

        static void AssertNoOutput(DocumentExportTask task)
        {
            Assert.True(task.Started >= task.Created && task.Finished >= task.Started);
            Assert.Equal(0, task.OutputBytes);
            Assert.Null(task.OutputDigest);
        }
    }

    // Prevent only the selected fixture task from starting, regardless of the worker timer.
    internal static Task<int> HoldClaim(ScratchDatabase fixture, Guid id, CancellationToken ct) => fixture.ExecAsync(ct, $"""
        create function public.document_export_fixture_hold() returns trigger language plpgsql
        as $$ begin return null; end; $$;
        create trigger document_export_fixture_hold before update of state on public.author_document_export
        for each row when (old.id='{id:D}'::uuid and old.state=1 and new.state=2)
        execute function public.document_export_fixture_hold();
        """);

    internal static Task<int> ReleaseClaim(ScratchDatabase fixture, CancellationToken ct) => fixture.ExecAsync(ct, """
        drop trigger document_export_fixture_hold on public.author_document_export;
        drop function public.document_export_fixture_hold();
        """);

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

    private static void AssertReceipt(DocumentExportTask task, Guid id, Draft expected, long source, DocumentExportFormat format)
    {
        Assert.Equal(new DocumentExportCreate(id, expected.Id, expected.Revision, source, format), task.Request);
        Assert.Equal(2, task.Provider);
        Assert.True(task.Created > 0 && task.Expires > task.Created);
        Assert.Contains(task.SourceDigest, value => value != 0);
    }

    private static Task<DateTimeOffset> SourceTime(ScratchDatabase fixture, Draft draft, CancellationToken ct) =>
        fixture.QueryRowAsync(ct, "select happened_at from public.article_revision where article_id=$1 and revision=$2",
            row => row.GetFieldValue<DateTimeOffset>(0), draft.Id, draft.Revision);

    private static byte[] SourceDigest(DocumentExportTask task, string title, string body, DateTimeOffset time) =>
        SourceDigest(task.Request.Article, task.Request.SourceRevision, task.Request.Format, task.Provider, title, body, time);

    private static byte[] SourceDigest(int articleId, long sourceRevision, DocumentExportFormat format, byte provider,
        string title, string body, DateTimeOffset time)
    {
        using var payload = new MemoryStream();
        payload.Write(Encoding.UTF8.GetBytes(FormattableString.Invariant($"FsusBlog document export {provider} basic-layout 1")));
        using var writer = new BinaryWriter(payload, Encoding.UTF8, leaveOpen: true);
        writer.Write(articleId);
        writer.Write(sourceRevision);
        writer.Write(time.UtcTicks);
        writer.Write((byte)format);
        writer.Write(provider);
        var titleBytes = Encoding.UTF8.GetBytes(title);
        writer.Write(titleBytes.Length);
        writer.Write(titleBytes);
        writer.Write(Encoding.UTF8.GetBytes(body));
        return SHA256.HashData(payload.ToArray());
    }

    private static async Task<Actor> Login(ScratchDatabase fixture, string name, bool canAuthor, CancellationToken ct)
    {
        var (id, token, handle) = await fixture.SignIn(name, ct, canAuthor);
        return new(id, token, handle);
    }

    private static string ListRoute(int article) =>
        WireRoutes.DocumentExportTaskList.Replace("{id:int}", article.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);

    private static byte[] Create(Guid id, int article, long expected, long source, DocumentExportFormat format) =>
        Wire.EncodeDocumentExportCreate(new(id, article, expected, source, format));

    private static byte[] Reference(Guid id) => Wire.EncodeDocumentExportTaskRef(id);

    private sealed class ExportClient(HttpClient client, Actor owner, CancellationToken defaultCt)
    {
        internal Task<Draft> Save(int id, long revision, string title, string body, CancellationToken? ct = null) =>
            SiteAedsFixture.SaveDraft(client, owner.Token, owner.Handle, id, revision, title, body, ct ?? defaultCt);

        internal Task<DocumentExportTask> CreateTask(Guid id, Draft expected, long source, DocumentExportFormat format, CancellationToken? ct = null) =>
            ReadTask(WireRoutes.DocumentExportCreate, Create(id, expected.Id, expected.Revision, source, format), ct);

        internal Task<DocumentExportTask> Cancel(Guid id, CancellationToken? ct = null) =>
            ReadTask(WireRoutes.DocumentExportCancel, Reference(id), ct);

        internal async Task<DocumentExportTask> ReadTask(string route, byte[] command, CancellationToken? ct = null) =>
            Wire.DecodeDocumentExportTask(await ReadFrame(route, command, OK, owner, ct));

        internal async Task<IReadOnlyList<DocumentExportTask>> List(int article, CancellationToken? ct = null) =>
            Wire.DecodeDocumentExportTaskList(await ReadFrame(ListRoute(article), null, OK, owner, ct));

        internal async Task<DocumentExportTask> Await(int article, Guid id, DocumentExportState state, CancellationToken? ct = null)
        {
            DocumentExportTask? ready = null;
            await Poll(async token =>
            {
                var task = Assert.Single(await List(article, token), row => row.Request.Id == id);
                if (task.State is DocumentExportState.Queued or DocumentExportState.Running or DocumentExportState.Cancelling) return false;
                Assert.Equal(state, task.State);
                ready = task;
                return true;
            }, $"Document task {id} did not reach a terminal state.", ct ?? defaultCt);
            return ready!;
        }

        internal async Task<byte[]> Download(DocumentExportTask task, string mediaType, string name, CancellationToken? ct = null)
        {
            var token = ct ?? defaultCt;
            using var response = await SiteAedsFixture.ExpectPrivateResponse(client, HttpMethod.Post, WireRoutes.DocumentExportDownload,
                Reference(task.Request.Id), owner.Token, owner.Handle, OK, token);
            ExportResponseFixture.Attachment(response, mediaType, name);
            var output = await response.Content.ReadAsByteArrayAsync(token);
            Assert.True(task.Started >= task.Created && task.Finished >= task.Started);
            Assert.Equal((DocumentExportFailure.None, output.Length), (task.Failure, task.OutputBytes));
            Assert.Equal(task.OutputDigest, SHA256.HashData(output));
            return output;
        }

        internal Task<byte[]> Receipt(Guid id, HttpStatusCode status, int version = 1, Actor? actor = null, CancellationToken? ct = null)
        {
            var target = actor ?? owner;
            return ExportResponseFixture.Receipt(client, id, target.Token, target.Handle, status, ct ?? defaultCt, version);
        }

        internal Task Reject(string route, byte[]? packet, HttpStatusCode status, CancellationToken? ct = null) =>
            Reject(route, packet, status, owner, ct);

        internal async Task Reject(string route, byte[]? packet, HttpStatusCode status, Actor? actor, CancellationToken? ct = null) =>
            Assert.False(Aeds.Decode(await ReadFrame(route, packet, status, actor, ct), FrameType.ApiError).IsEmpty);

        internal Task<byte[]> ReadFrame(string route, byte[]? packet, HttpStatusCode status, CancellationToken? ct = null) =>
            ReadFrame(route, packet, status, owner, ct);

        internal async Task<byte[]> ReadFrame(string route, byte[]? packet, HttpStatusCode status, Actor? actor, CancellationToken? ct = null)
        {
            var token = ct ?? defaultCt;
            using var response = await SiteAedsFixture.ExpectPrivateResponse(client, packet is null ? HttpMethod.Get : HttpMethod.Post,
                route, packet, actor?.Token, actor?.Handle, status, token);
            ExportResponseFixture.AedsWithoutAttachment(response);
            return await response.Content.ReadAsByteArrayAsync(token);
        }
    }

    private sealed record Actor(Guid Id, string Token, string? Handle);
}
