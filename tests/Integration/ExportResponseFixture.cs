using System.IO.Compression;

namespace FsusBlog.V2.Integration.Tests;

internal static class ExportResponseFixture
{
    internal static void Attachment(HttpResponseMessage response, string mediaType, string filename, bool noStore = false)
    {
        Assert.True(response.Headers.CacheControl?.Private);
        if (noStore) Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal(mediaType, response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
        Assert.Equal(filename, response.Content.Headers.ContentDisposition?.FileNameStar);
        Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
    }

    internal static async Task<byte[]> Receipt(HttpClient client, Guid task, string? token, string? handle,
        HttpStatusCode status, CancellationToken ct, int version = 1)
    {
        var mediaType = version == 2
            ? "application/vnd.fsus.document-export-receipt.v2+json"
            : "application/vnd.fsus.document-export-receipt+json";
        using var response = await SiteAedsFixture.ExpectPrivateResponse(client, HttpMethod.Post, WireRoutes.DocumentExportDownload,
            Wire.EncodeDocumentExportTaskRef(task), token, handle, status, ct, mediaType);
        if (status == HttpStatusCode.OK) Attachment(response, mediaType, "article.export-receipt.json");
        else AedsWithoutAttachment(response);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    internal static void AssertPdfBytes(byte[] bytes)
    {
        Assert.Equal("%PDF-", Encoding.ASCII.GetString(bytes, 0, 5));
        Assert.EndsWith("%%EOF", Encoding.ASCII.GetString(bytes[^16..]).TrimEnd(), StringComparison.Ordinal);
    }

    internal static ZipArchive OpenZip(byte[] bytes) => new(new MemoryStream(bytes), ZipArchiveMode.Read);

    internal static XDocument ReadZipXml(ZipArchive zip, string path)
    {
        using var part = zip.GetEntry(path)!.Open();
        return XDocument.Load(part);
    }

    internal static byte[] ReadZipBytes(ZipArchive zip, string path)
    {
        using var part = zip.GetEntry(path)!.Open();
        using var bytes = new MemoryStream();
        part.CopyTo(bytes);
        return bytes.ToArray();
    }

    internal static void AedsWithoutAttachment(HttpResponseMessage response)
    {
        Assert.Null(response.Content.Headers.ContentDisposition);
        Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
    }
}
