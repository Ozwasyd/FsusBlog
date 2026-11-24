namespace FsusBlog.V2.Server.Authoring;

internal static class MarkdownExportEndpoints
{
    internal const string Route = "/api/v2/authoring/draft/{id:int}/export.md";
    internal const string DownloadName = "article.md";
    internal const string ContentType = "text/markdown; charset=utf-8";
    internal const int MaxBytes = WireLimits.BodyBytes + WireLimits.TitleBytes * 6 + 128;

    internal static void Map(WebApplication app, string cookie, Func<HttpContext, string, int, string?> query,
        PdfDocumentExport? pdf)
    {
        Attach(Route, ContentType, DownloadName, (title, body, revision, _, _, _) => Task.FromResult(Encode(title, body, revision)));
        AttachDocument(DocumentExportFormat.Docx);
        AttachDocument(DocumentExportFormat.Html);
        AttachDocument(DocumentExportFormat.Epub);

        if (pdf is not null)
        {
            var (type, extension) = DocumentExportContract.Presentation(DocumentExportFormat.Pdf);
            Download(DocumentRoute(extension), type, $"article.{extension}", async (ctx, store, token, source, ct) =>
            {
                var revision = await store.WithSession(token, true,
                    (db, tx, actor) => ReadSource(ctx, db, tx, actor, token, source, ct), ct);
                using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct, app.Lifetime.ApplicationStopping);
                var result = await DocumentExportInput.Render(DocumentExportFormat.Pdf, revision.Title, revision.Body,
                    revision.HappenedAt, revision.Attachments, pdf, lifetime.Token);
                // Rendering releases database locks. Recheck the same permissions and frozen image proof before delivery.
                await store.WithSession(token, true, async (db, tx, actor) =>
                {
                    if (source.Attachments.Length == 0)
                        return await RevisionHistoryStore.LockCurrent(db, tx, actor, source.Id, source.Expected, lifetime.Token);
                    var current = await ReadSource(ctx, db, tx, actor, token, source, lifetime.Token);
                    var request = new DocumentExportCreate(Guid.Empty, source.Id, source.Expected, source.Selected, DocumentExportFormat.Pdf);
                    var provider = DocumentExportInput.ProviderFor(source.Attachments);
                    if (!CryptographicOperations.FixedTimeEquals(revision.Digest(request, provider, pdf.ToolDigest),
                        current.Digest(request, provider, pdf.ToolDigest)))
                        throw new PublicUnavailableException();
                    return source.Expected;
                }, lifetime.Token);
                return result;
            }, policy: PdfDocumentExport.RatePolicy, attachmentLimit: DocumentExportAttachment.MaximumImages);
        }

        void AttachDocument(DocumentExportFormat format)
        {
            var (type, extension) = DocumentExportContract.Presentation(format);
            var html = format == DocumentExportFormat.Html;
            Attach(DocumentRoute(extension), type, $"article.{extension}",
                (title, body, _, time, images, ct) => DocumentExportInput.Render(format, title, body, time, images, pdf, ct),
                DocumentExportAttachment.MaximumImages, html ? HtmlDocumentExport.ResponsePolicy : null);
        }

        static string DocumentRoute(string extension) => "/api/v2/authoring/draft/{id:int}/export." + extension;

        void Attach(string route, string mediaType, string filename,
            Func<string, string, long, DateTimeOffset, DocumentExportAttachment[], CancellationToken, Task<byte[]>> render,
            int attachmentLimit = 0, string? contentSecurityPolicy = null)
            => Download(route, mediaType, filename, (ctx, store, token, source, ct) =>
                store.WithSession(token, true, async (db, tx, actor) =>
                {
                    var input = await ReadSource(ctx, db, tx, actor, token, source, ct);
                    return await render(input.Title, input.Body, source.Selected, input.HappenedAt, input.Attachments, ct);
                }, ct), contentSecurityPolicy, attachmentLimit: attachmentLimit);

        async Task<DocumentExportInput> ReadSource(HttpContext ctx, NpgsqlConnection db, NpgsqlTransaction tx, Identity actor,
            string? token, DownloadSource source, CancellationToken ct)
        {
            if (source.Attachments.Length != 0)
            {
                if (!DocumentExportAttachment.PrivateTransport(ctx)) throw ArticleMediaStore.Missing();
                SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, SiteSessions.Requested(ctx));
            }
            await RevisionHistoryStore.LockCurrent(db, tx, actor, source.Id, source.Expected, ct);
            return await DocumentExportInput.Read(db, tx, source.Id, source.Selected, app.Services.GetService<MediaFiles>(),
                actor.Id, source.Attachments, ct);
        }

        void Download(string route, string mediaType, string filename,
            Func<HttpContext, Store, string?, DownloadSource, CancellationToken, Task<byte[]>> render,
            string? contentSecurityPolicy = null, string policy = "command", int attachmentLimit = 0)
        {
            app.MapGet(route, async (HttpContext ctx, Store store, int id, CancellationToken ct) =>
            {
                var expected = DraftRevisionQuery.Read(query(ctx, "revision", 19));
                var selected = DraftRevisionQuery.Read(query(ctx, "sourceRevision", 19));
                if (id <= 0 || selected > expected)
                    throw new BusinessException(Rejection.Invalid, "A valid source revision is required.");

                var attachment = DocumentExportAttachment.ReadSelections(ctx, attachmentLimit);
                var document = await render(ctx, store, ctx.Request.Cookies[cookie], new(id, expected, selected, attachment), ct);
                ct.ThrowIfCancellationRequested();
                ctx.Response.Headers.CacheControl = "private, no-store";
                if (contentSecurityPolicy is not null)
                    ctx.Response.Headers.ContentSecurityPolicy = attachment.Length == 0 ? contentSecurityPolicy : HtmlDocumentExport.ImageResponsePolicy;
                return Results.Bytes(document, mediaType, filename);
            }).RequireRateLimiting(policy);
        }
    }

    private readonly record struct DownloadSource(int Id, long Expected, long Selected, Guid[] Attachments);

    private static byte[] Encode(string title, string body, long revision)
    {
        var bodySize = Encoding.UTF8.GetByteCount(body);
        if (Encoding.UTF8.GetByteCount(title) > WireLimits.TitleBytes || bodySize > WireLimits.BodyBytes)
            throw new InvalidOperationException("A stored article exceeds the Markdown export limits.");
        // A JSON-quoted string is valid YAML and keeps stored titles from injecting extra frontmatter fields.
        var quotedTitle = JsonSerializer.Serialize(title);
        var prefix = $"---\nfsusFormat: fsusblog-markdown-v2\ntitle: {quotedTitle}\nrevision: {revision.ToString(CultureInfo.InvariantCulture)}\n---\n";
        var size = Encoding.UTF8.GetByteCount(prefix) + bodySize;
        if (size > MaxBytes) throw new InvalidOperationException("A stored article exceeds the Markdown export limits.");
        var bytes = new byte[size];
        var offset = Encoding.UTF8.GetBytes(prefix, bytes);
        Encoding.UTF8.GetBytes(body, bytes.AsSpan(offset));
        return bytes;
    }
}
