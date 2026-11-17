using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using FsusBlog.V2.Server.Content;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static class DocumentExportEndpoints
{
    internal const string Setting = "FSUSBLOG_DOCUMENT_EXPORT_TASKS";
    private const string ReceiptType = "application/vnd.fsus.document-export-receipt+json";
    private const string FormattingReceiptType = "application/vnd.fsus.document-export-receipt.v2+json";
    internal const string Marker = "<meta name=\"fsus-document-export-tasks\" content=\"1\">";
    internal static void Map(WebApplication app, string cookie, PdfDocumentExport? pdf,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var media = app.Services.GetService<MediaFiles>();
        app.MapPost(WireRoutes.DocumentExportCreate, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var request = Wire.DecodeDocumentExportCreate(await readFrame(ctx, WireLimits.MaxDocumentExportCreateFrameBytes, ct));
            return await Session(ctx, store, async (db, tx, actor) =>
            {
                var assets = DocumentExportAttachment.ReadSelections(ctx, DocumentExportAttachment.MaximumImages);
                if (assets.Length > 0 && !DocumentExportAttachment.PrivateTransport(ctx)) throw DocumentExportContract.Missing();
                var task = await DocumentExportStore.Create(db, tx, actor, request, pdf?.ToolDigest, media, assets, ct);
                return Results.Bytes(Wire.EncodeDocumentExportTask(task), Aeds.ContentType);
            }, ct);
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.DocumentExportTaskList, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
            Session(ctx, store, async (db, tx, actor) =>
            {
                if (id < 1) throw DocumentExportContract.Missing();
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
            var accept = ctx.Request.Headers.Accept.ToString();
            var receiptVersion = string.Equals(accept, FormattingReceiptType, StringComparison.OrdinalIgnoreCase) ? 2 :
                string.Equals(accept, ReceiptType, StringComparison.OrdinalIgnoreCase) ? 1 : 0;
            var result = await Session(ctx, store, (db, tx, actor) => DocumentExportStore.Download(db, tx, actor, id,
                media, DocumentExportAttachment.PrivateTransport(ctx), receiptVersion, pdf?.ToolDigest, ct), ct);
            ctx.Response.Headers.XContentTypeOptions = "nosniff";
            ctx.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
            ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
            ctx.Response.Headers.Vary = "Accept";
            if (receiptVersion != 0)
                return Results.Bytes(result.Bytes, receiptVersion == 2 ? FormattingReceiptType : ReceiptType, "article.export-receipt.json");
            if (result.Format == DocumentExportFormat.Html)
                ctx.Response.Headers.ContentSecurityPolicy = result.HasAttachment ? HtmlDocumentExport.ImageResponsePolicy : HtmlDocumentExport.ResponsePolicy;
            var (type, extension) = DocumentExportContract.Presentation(result.Format);
            return Results.Bytes(result.Bytes, type, $"article.{extension}");
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
