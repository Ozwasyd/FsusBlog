namespace FsusBlog.V2.Integration.Tests;

internal static class SiteAedsFixture
{
    internal static bool IsAuthoringRoute(string route) =>
        route.StartsWith("/api/v2/authoring", StringComparison.Ordinal) ||
        route.StartsWith("/api/v2/media", StringComparison.Ordinal) ||
        route.StartsWith("/api/binary/author/comments", StringComparison.Ordinal);

    internal static bool IsHttps(HttpClient client) =>
        string.Equals(client.BaseAddress?.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);

    internal static Task<ServerProcess> StartForwardedSite(ScratchDatabase database, string origin, string clientIp,
        CancellationToken ct, params (string Key, string Value)[] additionalSettings)
    {
        var settings = new Dictionary<string, string>
        {
            [LoopbackProxy.ConfigurationKey] = "true", [PublicSiteConfiguration.OriginKey] = origin,
        };
        foreach (var (key, value) in additionalSettings) settings.Add(key, value);
        var host = new Uri(origin).Authority;
        return ServerProcess.Start(database.ConnectionString, ct, settings, request => ForwardHttps(request, host, clientIp));
    }

    internal static void ForwardHttps(HttpRequestMessage request, string host, string clientIp)
    {
        request.Headers.Host = host;
        request.Headers.Add("X-Forwarded-Proto", "https");
        request.Headers.Add("X-Forwarded-For", clientIp);
    }

    internal static HttpRequestMessage Request(HttpMethod method, string route, byte[]? frame, string? token, string? handle,
        bool secure = false)
    {
        var request = new HttpRequestMessage(method, route);
        if (frame is not null)
        {
            request.Content = new ByteArrayContent(frame);
            request.Content.Headers.ContentType = new MediaTypeHeaderValue(Aeds.ContentType);
        }
        var authoring = IsAuthoringRoute(route);
        if (authoring && !secure) request.Headers.Host = ServerProcess.DefaultAdminHost;
        if (token is not null)
        {
            var cookie = authoring
                ? (secure ? "__Host-FsusAdminSession" : ServerProcess.DefaultAdminCookie)
                : "fsus-v2-session";
            request.Headers.Add("Cookie", $"{cookie}={token}");
        }
        if (handle is not null) request.Headers.Add(WireHeaders.CurrentSession, handle);
        return request;
    }

    internal static HttpRequestMessage AdminRequest(HttpMethod method, string route, string? token,
        byte[]? frame = null, bool includeOrigin = true)
    {
        var request = Request(method, route, frame, token: null, handle: null);
        request.Headers.Host = ServerProcess.DefaultAdminHost;
        if (includeOrigin && method != HttpMethod.Get) request.Headers.Add("Origin", ServerProcess.DefaultAdminOrigin);
        if (token is not null) request.Headers.Add("Cookie", $"{ServerProcess.DefaultAdminCookie}={token}");
        return request;
    }

    internal static async Task<HttpResponseMessage> AdminSend(HttpClient client, HttpMethod method, string route,
        string? token, CancellationToken ct, byte[]? frame = null, bool includeOrigin = true,
        Action<HttpRequestMessage>? configure = null)
    {
        using var request = AdminRequest(method, route, token, frame, includeOrigin);
        configure?.Invoke(request);
        return await client.SendAsync(request, ct);
    }

    internal static Task<byte[]> AdminBytes(HttpClient client, HttpMethod method, string route, string? token,
        CancellationToken ct, HttpStatusCode status = HttpStatusCode.OK, byte[]? frame = null, bool includeOrigin = true,
        Action<HttpRequestMessage>? configure = null) =>
        ExpectBytes(status, AdminSend(client, method, route, token, ct, frame, includeOrigin, configure), ct);

    internal static Task AdminStatus(HttpClient client, HttpMethod method, string route, string? token,
        CancellationToken ct, HttpStatusCode status, byte[]? frame = null, bool includeOrigin = true,
        Action<HttpRequestMessage>? configure = null) =>
        CheckStatusAsync(status, AdminSend(client, method, route, token, ct, frame, includeOrigin, configure));

    internal static async Task<string> AdminPow(HttpClient client, string powRoute, string token, byte[] frame, CancellationToken ct)
    {
        var nonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
        var challenge = await AdminBytes(client, HttpMethod.Post, powRoute, token, ct, frame: frame,
            configure: req => req.Headers.Add(WireHeaders.PowClientNonce, nonce));
        return PowFixture.SolveFrame(challenge, nonce, ct);
    }

    internal static (int Status, string Message, string Details, string TraceId) DecodeApiError(byte[] frame)
    {
        var payload = Aeds.Decode(frame, FrameType.ApiError);
        return (
            BinaryPrimitives.ReadInt32LittleEndian(payload.Slice(WireLayouts.ErrorStatusOffset, 4)),
            FixedText(payload[WireLayouts.ErrorMessageOffset..WireLayouts.ErrorDetailsOffset]),
            FixedText(payload[WireLayouts.ErrorDetailsOffset..WireLayouts.ErrorTraceIdOffset]),
            FixedText(payload[WireLayouts.ErrorTraceIdOffset..]));

        static string FixedText(ReadOnlySpan<byte> slice) =>
            Encoding.UTF8.GetString(slice.IndexOf((byte)0) is var zero and >= 0 ? slice[..zero] : slice);
    }

    internal static async Task<(int Status, string Message, string Details, string TraceId)> AssertAedsError(
        HttpResponseMessage response, HttpStatusCode status, CancellationToken ct)
    {
        Assert.Equal(status, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
        var error = DecodeApiError(await response.Content.ReadAsByteArrayAsync(ct));
        Assert.Equal((int)status, error.Status);
        return error;
    }

    internal static async Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string route, byte[]? frame,
        string? token, string? handle, CancellationToken ct, string? accept = null)
    {
        using var request = Request(method, route, frame, token, handle, IsHttps(client));
        if (accept is not null) request.Headers.Accept.ParseAdd(accept);
        return await client.SendAsync(request, ct);
    }

    internal static Task SendStatus(HttpClient client, HttpMethod method, string route, byte[]? frame,
        string? token, string? handle, HttpStatusCode status, CancellationToken ct) =>
        CheckStatusAsync(status, Send(client, method, route, frame, token, handle, ct));

    internal static Task<byte[]> ExpectStatus(HttpClient client, HttpMethod method, string route, byte[]? frame,
        string? token, string? handle, HttpStatusCode status, CancellationToken ct) =>
        ExpectBytes(status, Send(client, method, route, frame, token, handle, ct), ct);

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

    internal static Task<Draft> SaveDraft(HttpClient client, string token, string? handle, int id, long revision,
        string title, string body, CancellationToken ct) =>
        ArticleCommand(client, WireRoutes.Save, token, handle, new(id, revision, Guid.NewGuid(), title, body), ct);

    internal static async Task<Draft> SaveAndPublish(HttpClient client, string token, string title, string body, CancellationToken ct)
    {
        var draft = await SaveDraft(client, token, null, 0, 0, title, body, ct);
        return await ChangePublication(client, WireRoutes.Publish, token, draft.Id, draft.Revision, ct);
    }

    internal static Task<Draft> ChangePublication(HttpClient client, string route, string token, int id, long revision, CancellationToken ct) =>
        ArticleCommand(client, route, token, null, new(id, revision, Guid.NewGuid(), "", ""), ct);

    internal static async Task<Draft> ArticleCommand(HttpClient client, string route, string token, string? handle,
        ArticleCommand command, CancellationToken ct) =>
        Wire.DecodeDraft(await OkBytes(Send(client, HttpMethod.Post, route, Wire.EncodeArticleCommand(command), token, handle, ct), ct));
}
