using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Operations;
using Microsoft.Net.Http.Headers;

namespace FsusBlog.V2.Server.Content;

internal static class WideSearchCorpusEndpoints
{
    internal const string Setting = "FSUSBLOG_WIDE_SEARCH_CORPUS";
    internal const string ManifestPolicy = "wide-search-manifest";
    internal const string PagePolicy = "wide-search-page";

    internal static void Map(WebApplication app, PublicProjection projection, InstanceLease lease)
    {
        app.MapMethods(WireRoutes.PublicSearchWideManifest, [HttpMethods.Get, HttpMethods.Head], (HttpContext ctx) =>
        {
            var head = HttpMethods.IsHead(ctx.Request.Method);
            var binding = Capture(projection, lease);
            var state = binding.State;
            var wide = head ? RequirePins(ctx, state) : RequireReady(state);
            var result = head ? Results.NoContent() : ServerHttp.Frame(wide.ManifestFrame);
            return new CurrentResponse(binding, wide, result);
        }).RequireRateLimiting(ManifestPolicy);
        app.MapGet(WireRoutes.PublicSearchWidePage, (HttpContext ctx, string page, CancellationToken ct) =>
            ReadPage(ctx, page, projection, lease, app.Logger, ct)).RequireRateLimiting(PagePolicy);
    }

    internal static async Task<IResult> ReadPage(HttpContext context, string pageText, PublicProjection projection,
        InstanceLease? lease, ILogger log, CancellationToken ct)
    {
        if (pageText.Length > 10 || !int.TryParse(pageText, NumberStyles.None, CultureInfo.InvariantCulture, out var page) ||
            page < 1 || pageText != page.ToString(CultureInfo.InvariantCulture))
            throw new BusinessException(Rejection.Invalid, "Use a canonical wide search page number.");

        var binding = Capture(projection, lease);
        var state = binding.State;
        var wide = RequirePins(context, state);
        var manifest = wide.Stage.Manifest;
        if (page > manifest.Pages.Count)
            throw new BusinessException(Rejection.NotFound, "Wide search corpus page not found.");
        var descriptor = manifest.Pages[page - 1];
        byte[] bytes;
        using (var read = wide.Stage.Borrow(page) ?? throw new PublicUnavailableException())
        {
            binding.RequireCurrent();
            bytes = new byte[descriptor.Length];
            using var leaseStop = lease is null ? null : CancellationTokenSource.CreateLinkedTokenSource(ct, lease.Stopped);
            try
            {
                await read.ReadAsync(bytes, leaseStop?.Token ?? ct);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested && lease?.IsCurrent is false)
            {
                throw new PublicUnavailableException();
            }
            catch (Exception error) when (error is IOException or InvalidDataException or AggregateException)
            {
                projection.TryBlockWide(state);
                log.LogWarning(error, "Wide search corpus page {Page} could not be verified for generation {Generation}.",
                    page, state.Source.Generation);
                throw new PublicUnavailableException();
            }
        }
        binding.RequireCurrent();
        var tag = new EntityTagHeaderValue($"\"{descriptor.Sha256}\"");
        return new CurrentResponse(binding, wide,
            Results.Bytes(bytes, Aeds.ContentType, enableRangeProcessing: false, entityTag: tag));
    }

    private static CurrentBinding Capture(PublicProjection projection, InstanceLease? lease)
    {
        if (lease?.IsCurrent is false || projection.Current is not { } state)
            throw new PublicUnavailableException();
        return new(projection, state, lease);
    }

    private static WideSearchCorpusReady RequireReady(PublicProjectionState state) =>
        state.Wide ?? throw new PublicUnavailableException();

    private static WideSearchCorpusReady RequirePins(HttpContext context, PublicProjectionState state)
    {
        var generation = RequiredQuery(context, "generation", 19);
        if (!long.TryParse(generation, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) ||
            generation != parsed.ToString(CultureInfo.InvariantCulture))
            throw new BusinessException(Rejection.Invalid, "Use a canonical public search generation.");
        var digest = RequiredQuery(context, "digest", 64);
        if (digest.Length != 64 || !digest.All(char.IsAsciiHexDigitLower))
            throw new BusinessException(Rejection.Invalid, "Use the bound wide search manifest digest.");
        if (parsed != state.Source.Generation)
            throw new BusinessException(Rejection.Conflict, "The wide search corpus changed.");
        var wide = RequireReady(state);
        if (!string.Equals(digest, wide.Stage.Manifest.ContentDigest, StringComparison.Ordinal))
            throw new BusinessException(Rejection.Conflict, "The wide search corpus changed.");
        return wide;
    }

    private static string RequiredQuery(HttpContext context, string key, int length)
    {
        if (!context.Request.Query.TryGetValue(key, out var values) || values.Count != 1 ||
            values[0] is not { Length: > 0 } value || value.Length > length)
            throw new BusinessException(Rejection.Invalid, "Provide the exact wide search corpus coordinates.");
        return value;
    }

    private readonly record struct CurrentBinding(PublicProjection Projection, PublicProjectionState State, InstanceLease? Lease)
    {
        internal void RequireCurrent()
        {
            if (Lease?.IsCurrent is false || !ReferenceEquals(Projection.Current, State))
                throw new PublicUnavailableException();
        }
    }

    private sealed record CurrentResponse(CurrentBinding Binding, WideSearchCorpusReady Wide, IResult Body) : IResult
    {
        public Task ExecuteAsync(HttpContext context)
        {
            context.Response.Headers.CacheControl = "no-store";
            Binding.RequireCurrent();
            context.Response.Headers[WireHeaders.SearchIndexGeneration] = Binding.State.Source.GenerationHeader;
            context.Response.Headers[WireHeaders.SearchCorpusDigest] = Wide.Stage.Manifest.ContentDigest;
            context.Response.Headers[WireHeaders.SearchIndexPages] = Wide.Stage.Manifest.Pages.Count.ToString(CultureInfo.InvariantCulture);
            return Body.ExecuteAsync(context);
        }
    }
}
