namespace FsusBlog.V2.Integration.Tests;

internal static class HttpResponseAssert
{
    internal static HttpResponseMessage Ok(HttpResponseMessage response) =>
        Expect(HttpStatusCode.OK, response);

    internal static HttpResponseMessage Expect(HttpStatusCode status, HttpResponseMessage response)
    {
        try
        {
            Assert.Equal(status, response.StatusCode);
            return response;
        }
        catch
        {
            response.Dispose();
            throw;
        }
    }

    internal static void CheckStatus(HttpStatusCode status, HttpResponseMessage response)
    {
        using (response) Assert.Equal(status, response.StatusCode);
    }

    internal static async Task CheckStatusAsync(HttpStatusCode status, Task<HttpResponseMessage> response) =>
        CheckStatus(status, await response);

    internal static Task<byte[]> OkBytes(Task<HttpResponseMessage> response, CancellationToken ct) =>
        ExpectBytes(HttpStatusCode.OK, response, ct);

    internal static async Task<byte[]> ExpectBytes(HttpStatusCode status, Task<HttpResponseMessage> response, CancellationToken ct)
    {
        using var message = Expect(status, await response);
        return await message.Content.ReadAsByteArrayAsync(ct);
    }

    internal static Task<string> OkString(Task<HttpResponseMessage> response, CancellationToken ct) =>
        ExpectString(HttpStatusCode.OK, response, ct);

    internal static async Task<string> ExpectString(HttpStatusCode status, Task<HttpResponseMessage> response, CancellationToken ct)
    {
        using var message = Expect(status, await response);
        return await message.Content.ReadAsStringAsync(ct);
    }
}
