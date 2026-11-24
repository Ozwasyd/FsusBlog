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

    internal static void Map(WebApplication app, string origin, Publications publications)
    {
        app.MapPost(WireRoutes.ArticleReadChallenge, async (HttpContext ctx, int id, long publication,
            ArticleReadAuthority authority, CancellationToken ct) =>
        {
            var (address, agent) = RequireBrowser(ctx, id, publication, origin);
            Wire.DecodeArticleReadChallengeRequest(await ServerHttp.ReadFrame(ctx, Aeds.HeaderSize, ct));
            try
            {
                var snapshot = publications.Snapshot;
                if (snapshot is null) return Unavailable(ctx);
                if (snapshot.Article(id) is not { } current)
                    return ServerHttp.ErrorFrame(ctx, 404, "Article not found.");
                if (current.Publication != publication)
                    return ServerHttp.ErrorFrame(ctx, 409, "The article publication changed.");
                var ticket = await authority.Challenge(id, publication, address, agent, ct);
                return ticket is null ? ServerHttp.ErrorFrame(ctx, 409, "The article publication changed.")
                    : ServerHttp.Frame(Wire.EncodeArticleReadChallenge(ticket));
            }
            catch (ArticleReadUnavailableException) { return Unavailable(ctx); }
        }).RequireRateLimiting(RatePolicy);

        app.MapPost(WireRoutes.ArticleReadSubmit, async (HttpContext ctx, int id, long publication,
            ArticleReadAuthority authority, CancellationToken ct) =>
        {
            var (address, agent) = RequireBrowser(ctx, id, publication, origin);
            var frame = await ServerHttp.ReadFrame(ctx, Wire.ArticleReadSubmitFrameSize, ct);
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

    private static IResult Unavailable(HttpContext ctx) =>
        ServerHttp.ErrorFrame(ctx, 503, "Article read proof is temporarily unavailable.");
}

internal sealed class ArticleReadTickets(TimeProvider clock) : IDisposable
{
    internal const int EpochSeconds = 15 * 60;
    internal const int MaxUserAgentBytes = 512;
    private const int PrefixSize = 24;
    private const int DigestSize = 32;
    private static readonly TimeSpan Dwell = TimeSpan.FromMilliseconds(WireLayouts.ArticleReadDwellMs);
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);
    private readonly long _started = clock.GetTimestamp();
    private readonly byte[] _ticketKey = RandomNumberGenerator.GetBytes(DigestSize);
    private readonly byte[] _dedupKey = RandomNumberGenerator.GetBytes(DigestSize);

    internal static long Epoch(DateTimeOffset utc) => utc.ToUnixTimeSeconds() / EpochSeconds;
    internal static bool CanIssue(DateTimeOffset utc, long epoch) =>
        epoch >= 0 && DateTimeOffset.FromUnixTimeSeconds(checked((epoch + 1) * EpochSeconds)) - utc > Dwell;

    internal byte[] Viewer(int article, long epoch, IPAddress address, string userAgent)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        Span<byte> context = stackalloc byte[sizeof(int) + sizeof(long) + 1 + 16 + MaxUserAgentBytes];
        BinaryPrimitives.WriteInt32LittleEndian(context, article);
        BinaryPrimitives.WriteInt64LittleEndian(context[sizeof(int)..], epoch);
        const int addressOffset = sizeof(int) + sizeof(long) + 1;
        try
        {
            if (!address.TryWriteBytes(context.Slice(addressOffset, 16), out var addressBytes))
                throw new InvalidOperationException("Unsupported read proof address.");
            context[addressOffset - 1] = (byte)addressBytes;
            var agentOffset = addressOffset + addressBytes;
            var agentBytes = Encoding.UTF8.GetBytes(userAgent, context[agentOffset..]);
            return HMACSHA256.HashData(_dedupKey, context[..(agentOffset + agentBytes)]);
        }
        finally { CryptographicOperations.ZeroMemory(context); }
    }

    internal byte[] Issue(int article, long publication, long epoch, ReadOnlySpan<byte> viewer)
    {
        var ticket = new byte[WireLayouts.ArticleReadTicketSize];
        BinaryPrimitives.WriteInt64LittleEndian(ticket, clock.GetElapsedTime(_started).Ticks);
        RandomNumberGenerator.Fill(ticket.AsSpan(sizeof(long), PrefixSize - sizeof(long)));
        Sign(article, publication, epoch, viewer, ticket.AsSpan(0, PrefixSize), ticket.AsSpan(PrefixSize));
        return ticket;
    }

    internal bool Accept(int article, long publication, long epoch, ReadOnlySpan<byte> viewer, ReadOnlySpan<byte> ticket, int dwellMs)
    {
        if (ticket.Length != WireLayouts.ArticleReadTicketSize || dwellMs < WireLayouts.ArticleReadDwellMs ||
            dwellMs > Lifetime.TotalMilliseconds) return false;
        Span<byte> digest = stackalloc byte[DigestSize];
        Sign(article, publication, epoch, viewer, ticket[..PrefixSize], digest);
        if (!CryptographicOperations.FixedTimeEquals(digest, ticket[PrefixSize..])) return false;
        var issued = BinaryPrimitives.ReadInt64LittleEndian(ticket);
        var now = clock.GetElapsedTime(_started).Ticks;
        if (issued < 0 || issued > now) return false;
        var elapsed = now - issued;
        return elapsed >= Dwell.Ticks && elapsed <= Lifetime.Ticks && elapsed >= dwellMs * TimeSpan.TicksPerMillisecond;
    }

    private void Sign(int article, long publication, long epoch, ReadOnlySpan<byte> viewer, ReadOnlySpan<byte> prefix, Span<byte> digest)
    {
        const int coordinates = sizeof(int) + 2 * sizeof(long);
        Span<byte> context = stackalloc byte[coordinates + DigestSize + PrefixSize];
        BinaryPrimitives.WriteInt32LittleEndian(context, article);
        BinaryPrimitives.WriteInt64LittleEndian(context[sizeof(int)..], publication);
        BinaryPrimitives.WriteInt64LittleEndian(context[(sizeof(int) + sizeof(long))..], epoch);
        viewer.CopyTo(context[coordinates..]);
        prefix.CopyTo(context[(coordinates + DigestSize)..]);
        HMACSHA256.HashData(_ticketKey, context, digest);
    }

    internal static int DwellBucket(int dwellMs) => dwellMs switch { < 10_000 => 0, < 30_000 => 1, < 120_000 => 2, _ => 3 };

    public void Dispose() { CryptographicOperations.ZeroMemory(_ticketKey); CryptographicOperations.ZeroMemory(_dedupKey); }
}
