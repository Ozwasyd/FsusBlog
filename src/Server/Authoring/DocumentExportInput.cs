using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal sealed record DocumentExportInput(string Title, string Body, DateTimeOffset HappenedAt,
    Guid[] Assets, DocumentExportAttachment[] Attachments)
{
    internal const byte CurrentProvider = 2, AttachmentProvider = 3, ImageListProvider = 4;

    internal byte[] Digest(DocumentExportCreate request, byte provider, byte[]? pdfToolDigest)
    {
        if (Assets.Length != Attachments.Length || (provider != ProviderFor(Assets) && !(provider == 1 && Assets.Length == 0)))
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
        int article, long revision, MediaFiles? media, Guid owner, Guid[] assets, CancellationToken ct)
    {
        var (title, body, happenedAt) = await RevisionHistoryStore.ReadSource(db, tx, article, revision, ct);
        var attachments = assets.Length == 0 ? [] : await DocumentExportAttachment.ReadAll(db, tx, media, owner, article, revision, assets, ct);
        return new(title, body, happenedAt, assets, attachments);
    }

    internal static async Task<Guid[]> ReadAttachmentIds(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, Guid id, short provider, CancellationToken ct)
    {
        if (provider is 1 or DocumentExportInput.CurrentProvider) return [];
        var list = provider == DocumentExportInput.ImageListProvider;
        return await SqlCommands.Scalar(db, tx, ct, $"""
            select {(list ? "attachment_ids" : "array[attachment_id]")} from public.author_document_export
            where owner_id=$1 and id=$2 and provider=$3
            """, owner, id, provider) is Guid[] assets && assets.All(asset => asset != Guid.Empty) &&
            assets.Distinct().Count() == assets.Length && DocumentExportInput.ProviderFor(assets) == provider
                ? assets : throw new PublicUnavailableException();
    }

    internal static async Task<DocumentExportInput> ReadVerified(NpgsqlConnection db, NpgsqlTransaction tx,
        DocumentExportCreate request, MediaFiles? media, Guid owner, short provider, byte[] sourceDigest,
        byte[]? pdfToolDigest, CancellationToken ct)
    {
        var assets = await ReadAttachmentIds(db, tx, owner, request.Id, provider, ct);
        var input = await Read(db, tx, request.Article, request.SourceRevision, media, owner, assets, ct);
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
            DocumentExportFormat.Pdf when pdf is not null => await pdf.WriteAsync(title, body, happenedAt, ct, includeTables, images),
            DocumentExportFormat.Docx => WordDocumentExport.WriteWithImages(title, body, images, ct, includeTables),
            DocumentExportFormat.Epub => EpubDocumentExport.WriteWithImages(title, body, happenedAt, images, ct, includeTables),
            _ => throw new PublicUnavailableException(),
        };
}
