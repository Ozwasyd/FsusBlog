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

    internal static async Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string route, byte[]? frame,
        string? token, string? handle, CancellationToken ct, string? accept = null)
    {
        using var request = Request(method, route, frame, token, handle);
        if (accept is not null) request.Headers.Accept.ParseAdd(accept);
        return await client.SendAsync(request, ct);
    }

    internal static async Task<byte[]> ExpectStatus(HttpClient client, HttpMethod method, string route, byte[]? frame,
        string? token, string? handle, HttpStatusCode status, CancellationToken ct)
    {
        using var response = await Send(client, method, route, frame, token, handle, ct);
        Assert.Equal(status, response.StatusCode);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    internal static async Task<byte[]> ExpectPrivate(HttpClient client, HttpMethod method, string route, byte[]? frame,
        string? token, string? handle, HttpStatusCode status, CancellationToken ct)
    {
        using var response = await ExpectPrivateResponse(client, method, route, frame, token, handle, status, ct);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    internal static async Task<HttpResponseMessage> ExpectPrivateResponse(HttpClient client, HttpMethod method, string route,
        byte[]? frame, string? token, string? handle, HttpStatusCode status, CancellationToken ct, string? accept = null)
    {
        var response = await Send(client, method, route, frame, token, handle, ct, accept);
        try
        {
            Assert.Equal(status, response.StatusCode);
            Assert.True(response.Headers.CacheControl?.NoStore);
            return response;
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    internal static async Task<Draft> SaveDraft(HttpClient client, string token, string? handle, int id, long revision,
        string title, string body, CancellationToken ct)
    {
        using var response = await Send(client, HttpMethod.Post, WireRoutes.Save,
            Wire.EncodeArticleCommand(new(id, revision, Guid.NewGuid(), title, body)), token, handle, ct);
        response.EnsureSuccessStatusCode();
        return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
    }
}
