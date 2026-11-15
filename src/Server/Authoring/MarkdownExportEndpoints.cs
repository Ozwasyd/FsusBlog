using System.Globalization;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Sessions;

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
        Attach(Route, ContentType, DownloadName, (title, body, revision, _, _, _) => Encode(title, body, revision));
        Attach("/api/v2/authoring/draft/{id:int}/export.docx", WordDocumentExport.ContentType, "article.docx",
            (title, body, _, _, attachment, ct) => WordDocumentExport.Write(title, body, ct, attachment: attachment.SingleOrDefault()),
            attachmentLimit: 1);
        Attach("/api/v2/authoring/draft/{id:int}/export.html", HtmlDocumentExport.ContentType, "article.html",
            (title, body, _, _, attachment, ct) => HtmlDocumentExport.Write(title, body, attachment, ct),
            attachmentLimit: HtmlDocumentExport.MaximumImages, contentSecurityPolicy: HtmlDocumentExport.ResponsePolicy);
        Attach("/api/v2/authoring/draft/{id:int}/export.epub", EpubDocumentExport.ContentType, "article.epub",
            (title, body, _, happenedAt, attachment, ct) => EpubDocumentExport.Write(title, body, happenedAt, ct, attachment: attachment.SingleOrDefault()),
            attachmentLimit: 1);

        if (pdf is not null)
            Download("/api/v2/authoring/draft/{id:int}/export.pdf", PdfDocumentExport.ContentType, "article.pdf",
                async (_, store, token, source, ct) =>
                {
                    var revision = await ReadSource(store, token, source, ct);
                    using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct, app.Lifetime.ApplicationStopping);
                    var result = await pdf.WriteAsync(revision.Title, revision.Body, revision.HappenedAt, lifetime.Token);
                    // The subprocess did not hold database locks. Recheck the same owner and revision before delivery.
                    await store.WithSession(token, true, (db, tx, actor) =>
                        RevisionHistoryStore.LockCurrent(db, tx, actor, source.Id, source.Expected, lifetime.Token), lifetime.Token);
                    return result;
                }, policy: PdfDocumentExport.RatePolicy);

        void Attach(string route, string mediaType, string filename,
            Func<string, string, long, DateTimeOffset, DocumentExportAttachment[], CancellationToken, byte[]> render,
            int attachmentLimit = 0, string? contentSecurityPolicy = null)
            => Download(route, mediaType, filename, (ctx, store, token, source, ct) =>
                store.WithSession(token, true, async (db, tx, actor) =>
                {
                    if (source.Attachments.Length != 0)
                    {
                        if (!DocumentExportAttachment.PrivateTransport(ctx))
                            throw ArticleMediaStore.Missing();
                        SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, SiteSessions.Requested(ctx));
                    }
                    await RevisionHistoryStore.LockCurrent(db, tx, actor, source.Id, source.Expected, ct);
                    var (title, body, happenedAt) = await RevisionHistoryStore.ReadSource(db, tx, source.Id, source.Selected, ct);
                    var attachment = source.Attachments.Length == 0 ? [] : await DocumentExportAttachment.ReadAll(db, tx,
                        app.Services.GetService<MediaFiles>(), actor.Id, source.Id, source.Selected, source.Attachments, ct);
                    return render(title, body, source.Selected, happenedAt, attachment, ct);
                }, ct), contentSecurityPolicy, attachmentLimit: attachmentLimit);

        void Download(string route, string mediaType, string filename,
            Func<HttpContext, Store, string?, DownloadSource, CancellationToken, Task<byte[]>> render,
            string? contentSecurityPolicy = null, string policy = "command", int attachmentLimit = 0)
        {
            app.MapGet(route, async (HttpContext ctx, Store store, int id, CancellationToken ct) =>
            {
                var expected = ReadRevision(query(ctx, "revision", 19));
                var selected = ReadRevision(query(ctx, "sourceRevision", 19));
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

    private static Task<(string Title, string Body, DateTimeOffset HappenedAt)> ReadSource(
        Store store, string? token, DownloadSource source, CancellationToken ct)
        => store.WithSession(token, true, async (db, tx, actor) =>
        {
            await RevisionHistoryStore.LockCurrent(db, tx, actor, source.Id, source.Expected, ct);
            return await RevisionHistoryStore.ReadSource(db, tx, source.Id, source.Selected, ct);
        }, ct);

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

    private static long ReadRevision(string? text) =>
        long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value > 0 ? value :
            throw new BusinessException(Rejection.Invalid, "A valid draft revision is required.");
}
