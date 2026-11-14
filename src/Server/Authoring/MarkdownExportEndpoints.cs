using System.Globalization;
using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Authoring;

internal static class MarkdownExportEndpoints
{
    internal const string Route = "/api/v2/authoring/draft/{id:int}/export.md";
    internal const string DownloadName = "article.md";
    internal const string ContentType = "text/markdown; charset=utf-8";
    internal const int MaxBytes = WireLimits.BodyBytes + WireLimits.TitleBytes * 6 + 128;

    internal static void Map(WebApplication app, string cookie, Func<HttpContext, string, int, string?> query)
    {
        Attach(Route, ContentType, DownloadName, (title, body, revision, _) => Encode(title, body, revision));
        Attach("/api/v2/authoring/draft/{id:int}/export.docx", WordDocumentExport.ContentType, "article.docx",
            (title, body, _, ct) => WordDocumentExport.Write(title, body, ct));

        void Attach(string route, string mediaType, string filename, Func<string, string, long, CancellationToken, byte[]> render)
        {
            app.MapGet(route, async (HttpContext ctx, Store store, int id, CancellationToken ct) =>
            {
                var expected = ReadRevision(query(ctx, "revision", 19));
                var selected = ReadRevision(query(ctx, "sourceRevision", 19));
                if (id <= 0 || selected > expected)
                    throw new BusinessException(Rejection.Invalid, "A valid source revision is required.");

                var document = await store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                {
                    await RevisionHistoryStore.LockCurrent(db, tx, actor, id, expected, ct);
                    var (title, body) = await RevisionHistoryStore.ReadSource(db, tx, id, selected, ct);
                    return render(title, body, selected, ct);
                }, ct);
                ct.ThrowIfCancellationRequested();
                ctx.Response.Headers.CacheControl = "private, no-store";
                return Results.Bytes(document, mediaType, filename);
            }).RequireRateLimiting("command");
        }
    }

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
