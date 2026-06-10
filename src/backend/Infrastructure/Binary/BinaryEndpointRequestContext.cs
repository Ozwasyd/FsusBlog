using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Binary;

internal interface IBinaryEndpointRequestContext
{
    Task<BinaryRequestPayload> ReadFrameAsync(HttpContext httpContext, IAedsEncoder aeds, AedsFrameType expectedFrameType, CancellationToken cancellationToken, int? maxFrameBytes = null);
    Task<NameMutationPayload> ReadNameMutationAsync(HttpContext httpContext, IAedsEncoder aeds, AedsFrameType expectedFrameType, CancellationToken cancellationToken);
    string BuildArticleViewerIdentity(HttpContext context, int articleId);
    ValueTask<long> GetArticleListCacheVersionAsync(IUnifiedCache cache);
    string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string keyword = "");
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

    public async ValueTask<long> GetArticleListCacheVersionAsync(IUnifiedCache cache)
    {
        string? version = await cache.GetStringAsync(CachePolicyId.ArticleListVersion, "main");
        return long.TryParse(version, out long parsed) ? parsed : 0;
    }

    public string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string keyword = "")
        => $"core:v4:{(includePrivate ? "admin" : "public")}:{version}:{page}:{size}:{categoryId ?? 0}:{tagId ?? 0}:{(isDeleted ? 1 : 0)}:{status ?? -1}:{keyword}";

    public string BuildArticleHotCacheIdentity(int count)
        => hotArticlesVersionProvider.BuildVersionedHotArticlesIdentity($"core:v2:{count}");

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
