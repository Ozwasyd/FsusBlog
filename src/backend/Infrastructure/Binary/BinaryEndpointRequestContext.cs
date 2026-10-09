using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Binary;

internal interface IBinaryEndpointRequestContext
{
    Task<BinaryRequestPayload> ReadFrameAsync(HttpContext httpContext, IAedsEncoder aeds, AedsFrameType expectedFrameType, CancellationToken cancellationToken, int? maxFrameBytes = null);
    Task<BinaryRequestPayload> ReadFrameAsync(HttpContext httpContext, IAedsEncoder aeds, IReadOnlyCollection<AedsFrameType> expectedFrameTypes, CancellationToken cancellationToken, int? maxFrameBytes = null);

    /// <summary>Reads one bounded frame and requires body completion before transferring its payload.</summary>
    async Task<BinaryRequestPayload> ReadExactFrameAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken,
        int? maxFrameBytes = null)
    {
        BinaryRequestPayload payload = await ReadFrameAsync(
            httpContext, aeds, expectedFrameType, cancellationToken, maxFrameBytes).ConfigureAwait(false);
        if (!payload.IsSuccess)
        {
            return payload;
        }
        try
        {
            if (await BinaryRequestBinder.HasReachedEndOfBodyAsync(
                httpContext.Request.BodyReader, cancellationToken).ConfigureAwait(false))
            {
                return payload;
            }
            payload.Dispose();
            return BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "AEDS payload length mismatch"));
        }
        catch (Exception)
        {
            payload.Dispose();
            throw;
        }
    }

    Task<NameMutationPayload> ReadNameMutationAsync(HttpContext httpContext, IAedsEncoder aeds, AedsFrameType expectedFrameType, CancellationToken cancellationToken);
    string BuildArticleViewerIdentity(HttpContext context, int articleId);
    ValueTask<long> GetArticleListCacheVersionAsync(ICacheStringReader cache);
    string BuildArticleHotCacheIdentity(int count);
    string? GetDeviceFingerprint(HttpContext context);
    bool TryReadMfaProof(HttpContext context, out string proofToken);
}

internal sealed class BinaryEndpointRequestContext(
    IBinaryRequestBinder binder,
    IHotArticlesCacheVersionProvider hotArticlesVersionProvider) : IBinaryEndpointRequestContext
{
    private const string DeviceFingerprintHeader = "X-Fsus-Device-Fp";
    private const string MfaProofHeader = "X-Fsus-Mfa-Proof";

    public Task<BinaryRequestPayload> ReadFrameAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken,
        int? maxFrameBytes = null)
        => binder.ReadFrameAsync(httpContext, aeds, expectedFrameType, cancellationToken, maxFrameBytes);

    public Task<BinaryRequestPayload> ReadFrameAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IReadOnlyCollection<AedsFrameType> expectedFrameTypes,
        CancellationToken cancellationToken,
        int? maxFrameBytes = null)
        => binder.ReadFrameAsync(httpContext, aeds, expectedFrameTypes, cancellationToken, maxFrameBytes);

    public Task<NameMutationPayload> ReadNameMutationAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken)
        => binder.ReadNameMutationAsync(httpContext, aeds, expectedFrameType, cancellationToken);

    public string BuildArticleViewerIdentity(HttpContext context, int articleId)
    {
        string? deviceFingerprint = GetDeviceFingerprint(context);
        if (!string.IsNullOrWhiteSpace(deviceFingerprint))
        {
            return $"article:{articleId}:viewer:fp:{deviceFingerprint}";
        }

        return $"article:{articleId}:viewer:ip:{context.GetClientIp()}";
    }

    public async ValueTask<long> GetArticleListCacheVersionAsync(ICacheStringReader cache)
    {
        string? version = await cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main");
        return long.TryParse(version, out long parsed) ? parsed : 0;
    }

    public string BuildArticleHotCacheIdentity(int count)
        => ArticleHotFrameIdentity.BuildHot(hotArticlesVersionProvider, count);

    public string? GetDeviceFingerprint(HttpContext context)
    {
        if (!context.Request.Headers.TryGetValue(DeviceFingerprintHeader, out var raw))
        {
            return null;
        }

        string? value = raw.ToString();
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return value.Length <= 128 ? value : value[..128];
    }

    public bool TryReadMfaProof(HttpContext context, out string proofToken)
    {
        proofToken = string.Empty;
        if (!context.Request.Headers.TryGetValue(MfaProofHeader, out var values))
        {
            return false;
        }

        string? token = values.ToString();
        if (string.IsNullOrWhiteSpace(token))
        {
            return false;
        }

        proofToken = token;
        return true;
    }
}
