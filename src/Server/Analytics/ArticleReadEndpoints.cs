using System.Net;
using System.Text;
using System.Threading.RateLimiting;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Microsoft.AspNetCore.RateLimiting;

namespace FsusBlog.V2.Server.Analytics;

internal static class ArticleReadEndpoints
{
    internal const string Setting = "FSUSBLOG_ARTICLE_READ_PROOF";
    internal const string PageMarker = "<meta name=\"fsus-article-read-proof\" content=\"enabled\">";
    private const string RatePolicy = "article-read-proof";

    internal static void AddRateLimit(RateLimiterOptions options) => options.AddFixedWindowLimiter(RatePolicy, limiter =>
    {
        limiter.PermitLimit = 48;
        limiter.Window = TimeSpan.FromSeconds(1);
        limiter.QueueLimit = 0;
        limiter.QueueProcessingOrder = QueueProcessingOrder.OldestFirst;
    });

    internal static void Map(WebApplication app, string origin, Publications publications,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapPost(WireRoutes.ArticleReadChallenge, async (HttpContext ctx, int id, long publication,
            ArticleReadAuthority authority, CancellationToken ct) =>
        {
            var (address, agent) = RequireBrowser(ctx, id, publication, origin);
            Wire.DecodeArticleReadChallengeRequest(await readFrame(ctx, Aeds.HeaderSize, ct));
            try
            {
                var snapshot = publications.Snapshot;
                if (snapshot is null) return Unavailable(ctx);
                if (snapshot.Article(id) is not { } current)
                    return Error(ctx, 404, "Article not found.");
                if (current.Publication != publication)
                    return Error(ctx, 409, "The article publication changed.");
                var ticket = await authority.Challenge(id, publication, address, agent, ct);
                return ticket is null ? Error(ctx, 409, "The article publication changed.")
                    : ServerHttp.Frame(Wire.EncodeArticleReadChallenge(ticket));
            }
            catch (ArticleReadUnavailableException) { return Unavailable(ctx); }
        }).RequireRateLimiting(RatePolicy);

        app.MapPost(WireRoutes.ArticleReadSubmit, async (HttpContext ctx, int id, long publication,
            ArticleReadAuthority authority, CancellationToken ct) =>
        {
            var (address, agent) = RequireBrowser(ctx, id, publication, origin);
            var frame = await readFrame(ctx, Wire.ArticleReadSubmitFrameSize, ct);
            var (dwellMs, ticket) = Wire.DecodeArticleReadSubmit(frame);
            try
            {
                var counted = await authority.Submit(id, publication, address, agent, ticket, dwellMs, ct);
                return ServerHttp.Frame(Wire.EncodeArticleReadReceipt(counted));
            }
            catch (ArticleReadUnavailableException) { return Unavailable(ctx); }
        }).RequireRateLimiting(RatePolicy);
    }

    private static (IPAddress Address, string Agent) RequireBrowser(HttpContext ctx, int id, long publication, string origin)
    {
        var request = ctx.Request;
        var headers = request.Headers;
        var host = request.Host.Port == 443 ? new HostString(request.Host.Host) : request.Host;
        if (!request.IsHttps || !string.Equals($"https://{host}", origin, StringComparison.OrdinalIgnoreCase) ||
            headers.Origin.Count != 1 || !string.Equals(headers.Origin[0], origin, StringComparison.OrdinalIgnoreCase) ||
            !IsHeader("Sec-Fetch-Site", "same-origin") ||
            (!IsHeader("Sec-Fetch-Mode", "cors") && !IsHeader("Sec-Fetch-Mode", "same-origin")) ||
            !IsHeader("Sec-Fetch-Dest", "empty") || headers.Authorization.Count != 0 || headers.Cookie.Count != 0)
            throw new BusinessException(Rejection.Forbidden, "Article read proof requires same-origin browser context.");

        if (request.QueryString.HasValue || id <= 0 || publication <= 0 || ctx.Connection.RemoteIpAddress is not { } address ||
            headers.UserAgent.Count != 1 || headers.UserAgent[0] is not { Length: > 0 and <= ArticleReadTickets.MaxUserAgentBytes } agent ||
            Encoding.UTF8.GetByteCount(agent) > ArticleReadTickets.MaxUserAgentBytes)
            throw new BusinessException(Rejection.Invalid, "Invalid article read proof request.");
        return (address, agent);

        bool IsHeader(string name, string expected) => headers[name].Count == 1 && headers[name][0] == expected;
    }

    private static IResult Unavailable(HttpContext ctx) => Error(ctx, 503, "Article read proof is temporarily unavailable.");

    private static IResult Error(HttpContext ctx, int status, string message) =>
        new AedsError(status, Wire.EncodeError(status, message, traceId: ctx.TraceIdentifier));
}
