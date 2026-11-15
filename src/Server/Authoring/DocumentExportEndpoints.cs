using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using FsusBlog.V2.Server.Content;
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
        var media = app.Services.GetService<MediaFiles>();
        app.MapPost(WireRoutes.DocumentExportCreate, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var request = Wire.DecodeDocumentExportCreate(await readFrame(ctx, WireLimits.MaxDocumentExportCreateFrameBytes, ct));
            return await Session(ctx, store, async (db, tx, actor) =>
            {
                var asset = DocumentExportAttachment.ReadSelection(ctx, request.Format != DocumentExportFormat.Pdf);
                if (asset.HasValue && !DocumentExportAttachment.PrivateTransport(ctx)) throw Missing();
                var task = await DocumentExportStore.Create(db, tx, actor, request, pdf?.ToolDigest, media, asset, ct);
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
            var result = await Session(ctx, store, (db, tx, actor) => DocumentExportStore.Download(db, tx, actor, id,
                media, DocumentExportAttachment.PrivateTransport(ctx), ct), ct);
            ctx.Response.Headers.XContentTypeOptions = "nosniff";
            ctx.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
            ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
            if (result.Format == DocumentExportFormat.Html)
                ctx.Response.Headers.ContentSecurityPolicy = result.HasAttachment ? HtmlDocumentExport.ImageResponsePolicy : HtmlDocumentExport.ResponsePolicy;
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

internal sealed record DocumentExportInput(string Title, string Body, DateTimeOffset HappenedAt,
    Guid? Asset, DocumentExportAttachment? Attachment)
{
    internal const byte CurrentProvider = 2, AttachmentProvider = 3;

    internal byte[] Digest(DocumentExportCreate request, byte provider, byte[]? pdfToolDigest)
    {
        if ((provider == AttachmentProvider) != (Asset.HasValue && Attachment is not null) ||
            (provider == AttachmentProvider && request.Format == DocumentExportFormat.Pdf))
            throw new PublicUnavailableException();
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(provider switch
        {
            1 => "FsusBlog document export 1 basic-layout 1"u8,
            CurrentProvider => "FsusBlog document export 2 basic-layout 1"u8,
            AttachmentProvider => "FsusBlog document export 3 basic-layout 1"u8,
            _ => throw new PublicUnavailableException(),
        });
        Span<byte> coordinates = stackalloc byte[22];
        BinaryPrimitives.WriteInt32LittleEndian(coordinates, request.Article);
        BinaryPrimitives.WriteInt64LittleEndian(coordinates[4..], request.SourceRevision);
        BinaryPrimitives.WriteInt64LittleEndian(coordinates[12..], HappenedAt.UtcTicks);
        coordinates[20] = (byte)request.Format;
        coordinates[21] = provider;
        hash.AppendData(coordinates);
        if (request.Format == DocumentExportFormat.Pdf && pdfToolDigest is not null) hash.AppendData(pdfToolDigest);
        if (Attachment is { } image && Asset is Guid asset)
        {
            hash.AppendData(asset.ToByteArray());
            BinaryPrimitives.WriteInt32LittleEndian(coordinates, image.Width);
            BinaryPrimitives.WriteInt32LittleEndian(coordinates[4..], image.Height);
            coordinates[8] = (byte)image.Format;
            hash.AppendData(coordinates[..9]);
            hash.AppendData(SHA256.HashData(image.Bytes));
            Text(image.Name);
        }
        Text(Title);
        hash.AppendData(Encoding.UTF8.GetBytes(Body));
        return hash.GetHashAndReset();

        void Text(string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            Span<byte> size = stackalloc byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(size, bytes.Length);
            hash.AppendData(size);
            hash.AppendData(bytes);
        }
    }

    internal static async Task<DocumentExportInput> Read(NpgsqlConnection db, NpgsqlTransaction tx,
        DocumentExportCreate request, MediaFiles? media, Guid owner, Guid? asset, CancellationToken ct)
    {
        var (title, body, happenedAt) = await RevisionHistoryStore.ReadSource(db, tx, request.Article, request.SourceRevision, ct);
        var attachment = asset is Guid id ? await DocumentExportAttachment.Read(db, tx, media, owner, request.Article,
            request.SourceRevision, id, ct) : null;
        return new(title, body, happenedAt, asset, attachment);
    }
}
