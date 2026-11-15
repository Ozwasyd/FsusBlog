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

    internal static void AedsWithoutAttachment(HttpResponseMessage response)
    {
        Assert.Null(response.Content.Headers.ContentDisposition);
        Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
    }
}
