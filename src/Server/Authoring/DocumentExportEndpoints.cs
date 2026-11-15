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
    private const string ReceiptType = "application/vnd.fsus.document-export-receipt+json";
    internal const string Marker = "<meta name=\"fsus-document-export-tasks\" content=\"1\">";
    internal static BusinessException Missing() => new(Rejection.NotFound, "Document export is unavailable.");

    internal static (string ContentType, string Extension) Presentation(DocumentExportFormat format) => format switch
    {
        DocumentExportFormat.Html => (HtmlDocumentExport.ContentType, "html"),
        DocumentExportFormat.Pdf => (PdfDocumentExport.ContentType, "pdf"),
        DocumentExportFormat.Docx => (WordDocumentExport.ContentType, "docx"),
        DocumentExportFormat.Epub => (EpubDocumentExport.ContentType, "epub"),
        _ => throw new InvalidOperationException("Unregistered document format."),
    };

    internal static void Map(WebApplication app, string cookie, PdfDocumentExport? pdf,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var media = app.Services.GetService<MediaFiles>();
        app.MapPost(WireRoutes.DocumentExportCreate, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var request = Wire.DecodeDocumentExportCreate(await readFrame(ctx, WireLimits.MaxDocumentExportCreateFrameBytes, ct));
            return await Session(ctx, store, async (db, tx, actor) =>
            {
                var assets = DocumentExportAttachment.ReadSelections(ctx,
                    request.Format == DocumentExportFormat.Pdf ? 0 : DocumentExportAttachment.MaximumImages);
                if (assets.Length > 0 && !DocumentExportAttachment.PrivateTransport(ctx)) throw Missing();
                var task = await DocumentExportStore.Create(db, tx, actor, request, pdf?.ToolDigest, media, assets, ct);
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
            var receipt = string.Equals(ctx.Request.Headers.Accept, ReceiptType, StringComparison.OrdinalIgnoreCase);
            var result = await Session(ctx, store, (db, tx, actor) => DocumentExportStore.Download(db, tx, actor, id,
                media, DocumentExportAttachment.PrivateTransport(ctx), receipt, pdf?.ToolDigest, ct), ct);
            ctx.Response.Headers.XContentTypeOptions = "nosniff";
            ctx.Response.Headers["Cross-Origin-Resource-Policy"] = "same-origin";
            ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
            ctx.Response.Headers.Vary = "Accept";
            if (receipt) return Results.Bytes(result.Bytes, ReceiptType, "article.export-receipt.json");
            if (result.Format == DocumentExportFormat.Html)
                ctx.Response.Headers.ContentSecurityPolicy = result.HasAttachment ? HtmlDocumentExport.ImageResponsePolicy : HtmlDocumentExport.ResponsePolicy;
            var (type, extension) = Presentation(result.Format);
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

internal sealed record DocumentExportInput(string Title, string Body, DateTimeOffset HappenedAt,
    Guid[] Assets, DocumentExportAttachment[] Attachments)
{
    internal const byte CurrentProvider = 2, AttachmentProvider = 3, ImageListProvider = 4;

    internal byte[] Digest(DocumentExportCreate request, byte provider, byte[]? pdfToolDigest)
    {
        if (Assets.Length != Attachments.Length || (provider != ProviderFor(Assets) && !(provider == 1 && Assets.Length == 0)) ||
            (Assets.Length > 0 && request.Format == DocumentExportFormat.Pdf))
            throw new PublicUnavailableException();
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(provider switch
        {
            1 => "FsusBlog document export 1 basic-layout 1"u8,
            CurrentProvider => "FsusBlog document export 2 basic-layout 1"u8,
            AttachmentProvider => "FsusBlog document export 3 basic-layout 1"u8,
            ImageListProvider => "FsusBlog document export 4 basic-layout 1"u8,
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
        if (provider == ImageListProvider) hash.AppendData([(byte)Assets.Length]);
        for (var index = 0; index < Assets.Length; index++)
        {
            var image = Attachments[index];
            hash.AppendData(Assets[index].ToByteArray());
            BinaryPrimitives.WriteInt32LittleEndian(coordinates, image.Width);
            BinaryPrimitives.WriteInt32LittleEndian(coordinates[4..], image.Height);
            coordinates[8] = (byte)image.Format;
            hash.AppendData(coordinates[..9]);
            hash.AppendData(image.VerifiedDigest ?? throw new PublicUnavailableException());
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

    internal static byte ProviderFor(Guid[] assets) => assets.Length switch
    {
        0 => CurrentProvider,
        1 => AttachmentProvider,
        <= DocumentExportAttachment.MaximumImages => ImageListProvider,
        _ => throw new PublicUnavailableException(),
    };

    internal static async Task<DocumentExportInput> Read(NpgsqlConnection db, NpgsqlTransaction tx,
        DocumentExportCreate request, MediaFiles? media, Guid owner, Guid[] assets, CancellationToken ct)
    {
        var (title, body, happenedAt) = await RevisionHistoryStore.ReadSource(db, tx, request.Article, request.SourceRevision, ct);
        var attachments = assets.Length == 0 ? [] : await DocumentExportAttachment.ReadAll(db, tx, media, owner, request.Article,
            request.SourceRevision, assets, ct);
        return new(title, body, happenedAt, assets, attachments);
    }

    internal static async Task<DocumentExportInput> ReadVerified(NpgsqlConnection db, NpgsqlTransaction tx,
        DocumentExportCreate request, MediaFiles? media, Guid owner, short provider, byte[] sourceDigest,
        byte[]? pdfToolDigest, CancellationToken ct)
    {
        var assets = await DocumentExportStore.ReadAttachmentIds(db, tx, owner, request.Id, provider, ct);
        var input = await Read(db, tx, request, media, owner, assets, ct);
        if (provider is < 1 or > ImageListProvider ||
            !CryptographicOperations.FixedTimeEquals(sourceDigest, input.Digest(request, (byte)provider, pdfToolDigest)))
            throw new PublicUnavailableException();
        return input;
    }

    internal static async Task<byte[]> Render(DocumentExportFormat format, string title, string body, DateTimeOffset happenedAt,
        DocumentExportAttachment[] images, PdfDocumentExport? pdf, CancellationToken ct, bool includeTables = true) =>
        format switch
        {
            DocumentExportFormat.Html => HtmlDocumentExport.Write(title, body, images, ct, includeTables),
            DocumentExportFormat.Pdf when pdf is not null => await pdf.WriteAsync(title, body, happenedAt, ct, includeTables),
            DocumentExportFormat.Docx => WordDocumentExport.WriteWithImages(title, body, images, ct, includeTables),
            DocumentExportFormat.Epub => EpubDocumentExport.WriteWithImages(title, body, happenedAt, images, ct, includeTables),
            _ => throw new PublicUnavailableException(),
        };
}
