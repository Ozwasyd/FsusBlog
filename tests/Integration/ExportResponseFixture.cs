using System.Net;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Integration.Tests;

internal static class ExportResponseFixture
{
    internal static void Attachment(HttpResponseMessage response, string mediaType, string filename)
    {
        Assert.True(response.Headers.CacheControl?.Private);
        Assert.Equal(mediaType, response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("attachment", response.Content.Headers.ContentDisposition?.DispositionType);
        Assert.Equal(filename, response.Content.Headers.ContentDisposition?.FileNameStar);
        Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
    }

    internal static async Task<byte[]> Receipt(HttpClient client, Guid task, string? token, string? handle,
        HttpStatusCode status, CancellationToken ct)
    {
        const string mediaType = "application/vnd.fsus.document-export-receipt+json";
        using var response = await SiteAedsFixture.ExpectPrivateResponse(client, HttpMethod.Post, WireRoutes.DocumentExportDownload,
            Wire.EncodeDocumentExportTaskRef(task), token, handle, status, ct, mediaType);
        if (status == HttpStatusCode.OK) Attachment(response, mediaType, "article.export-receipt.json");
        else AedsWithoutAttachment(response);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    internal static void AedsWithoutAttachment(HttpResponseMessage response)
    {
        Assert.Null(response.Content.Headers.ContentDisposition);
        Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
    }
}
