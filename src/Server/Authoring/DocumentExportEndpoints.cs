using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static class DocumentExportEndpoints
{
    internal const string Setting = "FSUSBLOG_DOCUMENT_EXPORT_TASKS";
    internal const string Marker = "<meta name=\"fsus-document-export-tasks\" content=\"1\">";
    internal static BusinessException Missing() => new(Rejection.NotFound, "Document export is unavailable.");

    internal static void Map(WebApplication app, string cookie, PdfDocumentExport? pdf,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapPost(WireRoutes.DocumentExportCreate, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var request = Wire.DecodeDocumentExportCreate(await readFrame(ctx, WireLimits.MaxDocumentExportCreateFrameBytes, ct));
            return await Session(ctx, store, async (db, tx, actor) =>
            {
                var task = await DocumentExportStore.Create(db, tx, actor, request, pdf?.ToolDigest, ct);
                return Results.Bytes(Wire.EncodeDocumentExportTask(task), Aeds.ContentType);
            }, ct);
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.DocumentExportTaskList, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
            Session(ctx, store, async (db, tx, actor) =>
            {
                if (id < 1) throw Missing();
                await RevisionHistoryStore.LockOwned(db, tx, actor.Id, id, ct);
                var tasks = await DocumentExportStore.List(db, tx, actor, id, ct);
                return Results.Bytes(Wire.EncodeDocumentExportTaskList(tasks), Aeds.ContentType);
            }, ct)).RequireRateLimiting("command");

        app.MapPost(WireRoutes.DocumentExportCancel, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var id = await ReadTaskRef(ctx, ct);
            return await Session(ctx, store, async (db, tx, actor) =>
            {
                var task = await DocumentExportStore.Cancel(db, tx, actor, id, ct);
                return Results.Bytes(Wire.EncodeDocumentExportTask(task), Aeds.ContentType);
            }, ct);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.DocumentExportDownload, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var id = await ReadTaskRef(ctx, ct);
            var result = await Session(ctx, store, (db, tx, actor) => DocumentExportStore.Download(db, tx, actor, id, ct), ct);
            ctx.Response.Headers.XContentTypeOptions = "nosniff";
            ctx.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
            ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
            if (result.Format == DocumentExportFormat.Html)
                ctx.Response.Headers.ContentSecurityPolicy = HtmlDocumentExport.ResponsePolicy;
            var (type, name) = result.Format switch
            {
                DocumentExportFormat.Html => (HtmlDocumentExport.ContentType, "article.html"),
                DocumentExportFormat.Pdf => (PdfDocumentExport.ContentType, "article.pdf"),
                DocumentExportFormat.Docx => (WordDocumentExport.ContentType, "article.docx"),
                DocumentExportFormat.Epub => (EpubDocumentExport.ContentType, "article.epub"),
                _ => throw new InvalidOperationException("Unregistered document format.")
            };
            return Results.Bytes(result.Bytes, type, name);
        }).RequireRateLimiting("document-export-download");

        async Task<Guid> ReadTaskRef(HttpContext ctx, CancellationToken ct) =>
            Wire.DecodeDocumentExportTaskRef(await readFrame(ctx, WireLimits.MaxDocumentExportTaskRefFrameBytes, ct));

        async Task<T> Session<T>(HttpContext ctx, Store store,
            Func<NpgsqlConnection, NpgsqlTransaction, Identity, Task<T>> operation, CancellationToken ct)
        {
            ctx.Response.Headers.CacheControl = "private, no-store";
            var token = ctx.Request.Cookies[cookie];
            var current = SiteSessions.Requested(ctx);
            return await store.WithSession(token, true, async (db, tx, actor) =>
            {
                SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, current);
                return await operation(db, tx, actor);
            }, ct);
        }
    }
}

internal sealed record DocumentExportInput(string Title, string Body, DateTimeOffset HappenedAt)
{
    internal byte[] Digest(DocumentExportCreate request, byte[]? pdfToolDigest)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData("FsusBlog document export 1 basic-layout 1"u8);
        Span<byte> coordinates = stackalloc byte[22];
        BinaryPrimitives.WriteInt32LittleEndian(coordinates, request.Article);
        BinaryPrimitives.WriteInt64LittleEndian(coordinates[4..], request.SourceRevision);
        BinaryPrimitives.WriteInt64LittleEndian(coordinates[12..], HappenedAt.UtcTicks);
        coordinates[20] = (byte)request.Format;
        coordinates[21] = 1;
        hash.AppendData(coordinates);
        if (request.Format == DocumentExportFormat.Pdf && pdfToolDigest is not null) hash.AppendData(pdfToolDigest);
        var title = Encoding.UTF8.GetBytes(Title);
        BinaryPrimitives.WriteInt32LittleEndian(coordinates, title.Length);
        hash.AppendData(coordinates[..4]);
        hash.AppendData(title);
        hash.AppendData(Encoding.UTF8.GetBytes(Body));
        return hash.GetHashAndReset();
    }

    internal static async Task<DocumentExportInput> Read(NpgsqlConnection db, NpgsqlTransaction tx,
        DocumentExportCreate request, CancellationToken ct)
    {
        var (title, body, happenedAt) = await RevisionHistoryStore.ReadSource(db, tx, request.Article, request.SourceRevision, ct);
        return new(title, body, happenedAt);
    }
}
