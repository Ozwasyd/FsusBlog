using System.Globalization;
using System.Net;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Administration;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Operations;
using FsusBlog.V2.Server.Sessions;
using Microsoft.AspNetCore.Http.Features;
using Npgsql;

namespace FsusBlog.V2.Server;

internal static class ServerHttp
{
    internal const string SessionCookie = "fsus-v2-session";
    internal const string BinaryContentType = Aeds.ContentType;
    internal const string HtmlContentType = "text/html; charset=utf-8";
    internal const string TextContentType = "text/plain; charset=utf-8";
    internal const string ContentSecurityPolicy =
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

    internal static string AuthorCookie(SiteCapabilities capabilities) =>
        capabilities.AdminIdentity is { } adminIdentity
            ? AdminIdentityEndpoints.SessionCookieName(adminIdentity)
            : SessionCookie;

    internal static void NoStore(HttpContext ctx) => ctx.Response.Headers.CacheControl = "no-store";

    internal static IResult Error(HttpContext ctx, int status, string message, string? details = null)
    {
        NoStore(ctx);
        return new AedsError(status, Wire.EncodeError(status, message, details, ctx.TraceIdentifier));
    }

    internal static PublicSnapshot Snapshot(HttpContext ctx, Publications publications)
    {
        NoStore(ctx);
        var snapshot = publications.Snapshot ?? throw new PublicUnavailableException();
        ctx.Response.Headers[WireHeaders.SearchIndexGeneration] = snapshot.GenerationHeader;
        return snapshot;
    }

    internal static void RequireCurrentSnapshot(HttpContext ctx, Publications publications, PublicSnapshot snapshot)
    {
        if (ReferenceEquals(snapshot, publications.Snapshot)) return;
        ctx.Response.Headers.Remove(WireHeaders.SearchIndexGeneration);
        throw new PublicUnavailableException();
    }

    internal static string? Query(HttpContext ctx, string name, int limit)
    {
        if (!ctx.Request.Query.TryGetValue(name, out var value)) return null;
        if (value.Count != 1 || value[0] is not { } text || text.Length > limit)
            throw new BusinessException(Rejection.Invalid, "Invalid query parameter.");
        return text;
    }

    internal static string? ReadListCursor(HttpContext ctx)
    {
        if (!ctx.Request.Query.TryGetValue("cursor", out var values)) return null;
        if (values.Count != 1 || values[0] is not { Length: > 0 and <= WireLayouts.ArticleListCursorMaxBytes } value)
            throw PublicListFailure.InvalidCursor();
        return value;
    }

    internal static void VerifyMutation(HttpContext ctx)
    {
        if (!ctx.Request.IsHttps && (ctx.Connection.RemoteIpAddress is not { } peer || !IPAddress.IsLoopback(peer)))
            throw new BusinessException(Rejection.Forbidden, "Secure transport is required.");
        var origin = ctx.Request.Headers.Origin;
        var expected = $"{ctx.Request.Scheme}://{ctx.Request.Host}";
        if (origin.Count > 0 && (origin.Count != 1 || !string.Equals(origin[0], expected, StringComparison.OrdinalIgnoreCase)))
            throw new BusinessException(Rejection.Forbidden, "Cross-origin requests are denied.");
        if (ctx.Request.Headers.TryGetValue("Sec-Fetch-Site", out var site) && site.ToString() != "same-origin")
            throw new BusinessException(Rejection.Forbidden, "Cross-origin requests are denied.");
    }

    internal static async Task<byte[]> ReadFrame(HttpContext ctx, int maximum, CancellationToken ct)
    {
        if (!string.Equals(ctx.Request.ContentType, BinaryContentType, StringComparison.OrdinalIgnoreCase))
            throw new BadHttpRequestException("Expected AEDS.", 415);
        if (ctx.Request.ContentLength > maximum) throw new BadHttpRequestException("Request too large.", 413);
        var localLimit = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (localLimit is { IsReadOnly: false }) localLimit.MaxRequestBodySize = maximum;
        using var memory = new MemoryStream();
        await ctx.Request.Body.CopyToAsync(memory, ct);
        return memory.ToArray();
    }

    internal static CookieOptions CookieSettings(HttpContext ctx, DateTimeOffset? expiresAt = null) => new()
    {
        HttpOnly = true, Secure = ctx.Request.IsHttps, SameSite = SameSiteMode.Strict, Path = "/", Expires = expiresAt
    };

    internal static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);

    internal static IResult EmptyFrame() => Frame(Wire.EncodeEmptySuccess());

    internal static IResult SessionResponse(HttpContext ctx, Identity actor, string token)
    {
        ctx.Response.Headers[WireHeaders.AccessExpiresAtUtc] = actor.ExpiresAt.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);
        ctx.Response.Headers[WireHeaders.CurrentSession] = SiteSessions.Id(actor.Id, Store.TokenDigest(token)!);
        return Frame(Wire.EncodeSession(new(actor.Name, actor.Generation, actor.CanAuthor)));
    }

    internal static IResult DraftResponse(ArticleState state) =>
        Frame(Wire.EncodeDraft(new(state.Id, state.Revision, state.Title, state.Body, state.PublishedRevision is not null)));

    internal static (int Status, string Message, string? Details) MapException(Exception ex) => ex switch
    {
        BusinessException err => (err.Rejection switch
        {
            Rejection.Invalid => 400,
            Rejection.Unauthorized => 401,
            Rejection.Forbidden => 403,
            Rejection.NotFound => 404,
            Rejection.Conflict => 409,
            _ => 500
        }, err.Message, (string?)null),
        PublicListFailure err => (err.Status, err.Message, err.Details),
        AuthorHeadingBudgetException => (422, "A saved article exceeds the heading parser's work limit.", null),
        ProtocolException => (400, "Invalid AEDS payload.", null),
        BadHttpRequestException bad => (bad.StatusCode, "Invalid HTTP request.", null),
        PublicUnavailableException or NpgsqlException => (503, "This operation is temporarily unavailable.", null),
        _ => (500, "An internal error occurred.", null)
    };
}
