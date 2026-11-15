using System.Net;
using System.Net.Http.Headers;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Integration.Tests;

internal static class SiteAedsFixture
{
    internal static HttpRequestMessage Request(HttpMethod method, string route, byte[]? frame, string? token, string? handle)
    {
        var request = new HttpRequestMessage(method, route);
        if (frame is not null)
        {
            request.Content = new ByteArrayContent(frame);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
        }
        if (token is not null) request.Headers.Add("Cookie", $"fsus-v2-session={token}");
        if (handle is not null) request.Headers.Add(WireHeaders.CurrentSession, handle);
        return request;
    }

    internal static async Task<byte[]> ExpectPrivate(HttpClient client, HttpMethod method, string route, byte[]? frame,
        string token, string? handle, HttpStatusCode status, CancellationToken ct)
    {
        using var request = Request(method, route, frame, token, handle);
        using var response = await client.SendAsync(request, ct);
        Assert.Equal(status, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }
}
