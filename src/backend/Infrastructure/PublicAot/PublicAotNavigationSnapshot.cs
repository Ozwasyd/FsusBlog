using System.Security.Cryptography;
using System.Text;

using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed record PublicAotNavigationSnapshot
{
    public const string EnvelopeKind = "public-navigation-snapshot";
    public const string MediaType = "application/vnd.fsus.aeds";

    public required string PageKind
    {
        get; init;
    }
    public required PublicPageId PageId
    {
        get; init;
    }
    public required string RouteKey
    {
        get; init;
    }
    public required string Path
    {
        get; init;
    }
    public required string QueryString
    {
        get; init;
    }
    public required string CanonicalPath
    {
        get; init;
    }
    public required string RendererVersion
    {
        get; init;
    }
    public required string FrontendAssetVersion
    {
        get; init;
    }
    public required string BootstrapPayload
    {
        get; init;
    }
    public required string HydrationPropsPayload
    {
        get; init;
    }
    public required PublicSeoHeadModel SeoHead
    {
        get; init;
    }
    public required string PayloadHash
    {
        get; init;
    }
    public required DateTimeOffset GeneratedAtUtc
    {
        get; init;
    }

    public static PublicAotNavigationSnapshot Create(
        PublicAotRouteMatch match,
        PublicAotShellEntryContract entry,
        PublicSeoHeadModel seoHead,
        string frontendAssetVersion,
        DateTimeOffset generatedAtUtc)
    {
        if (!seoHead.HasValidContractAndDigest())
        {
            throw new ArgumentException("public_seo_head_contract_invalid", nameof(seoHead));
        }

        string rendererVersion = string.IsNullOrWhiteSpace(entry.RendererVersion)
            ? PublicAotShellService.PublicRendererVersion
            : entry.RendererVersion.Trim();
        string bootstrapPayload = entry.BootstrapPayload ?? string.Empty;
        string hydrationPropsPayload = entry.HydrationPropsPayload ?? string.Empty;
        string payloadHash = ComputePayloadHash(
            match,
            rendererVersion,
            frontendAssetVersion,
            bootstrapPayload,
            hydrationPropsPayload,
            seoHead.Digest);

        return new PublicAotNavigationSnapshot
        {
            PageKind = match.Kind.ToString(),
            PageId = match.PageId,
            RouteKey = entry.RouteKey ?? match.RouteKey,
            Path = match.Path,
            QueryString = match.QueryString,
            CanonicalPath = match.CanonicalPathAndQuery,
            RendererVersion = rendererVersion,
            FrontendAssetVersion = frontendAssetVersion,
            BootstrapPayload = bootstrapPayload,
            HydrationPropsPayload = hydrationPropsPayload,
            SeoHead = seoHead,
            PayloadHash = payloadHash,
            GeneratedAtUtc = generatedAtUtc
        };
    }

    public byte[] EncodeFrame()
        => PublicAotBinaryPayload.EncodeObjectFrame(ToPayload());

    public IReadOnlyDictionary<string, object?> ToPayload()
        => new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["kind"] = EnvelopeKind,
            ["pageKind"] = PageKind,
            ["pageId"] = (int)PageId,
            ["routeKey"] = RouteKey,
            ["path"] = Path,
            ["queryString"] = QueryString,
            ["fullPath"] = string.Concat(Path, QueryString),
            ["canonicalPath"] = CanonicalPath,
            ["rendererVersion"] = RendererVersion,
            ["frontendAssetVersion"] = FrontendAssetVersion,
            ["payloadHash"] = PayloadHash,
            ["generatedAtUtc"] = GeneratedAtUtc.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            ["bootstrapPayload"] = BootstrapPayload,
            ["hydrationPropsPayload"] = HydrationPropsPayload,
            ["seoHead"] = SeoHead.ToPayload()
        };

    public static string CreateEntityTag(ReadOnlySpan<byte> frame)
        => string.Concat("\"", ToLowerHex(SHA256.HashData(frame)), "\"");

    private static string ComputePayloadHash(
        PublicAotRouteMatch match,
        string rendererVersion,
        string frontendAssetVersion,
        string bootstrapPayload,
        string hydrationPropsPayload,
        string seoHeadDigest)
    {
        using var incremental = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Append(incremental, match.Kind.ToString());
        Append(incremental, match.PageId.ToString());
        Append(incremental, match.RouteKey);
        Append(incremental, match.Path);
        Append(incremental, match.QueryString);
        Append(incremental, match.CanonicalPath);
        Append(incremental, rendererVersion);
        Append(incremental, frontendAssetVersion);
        Append(incremental, bootstrapPayload);
        Append(incremental, hydrationPropsPayload);
        Append(incremental, seoHeadDigest);
        return ToLowerHex(incremental.GetHashAndReset());
    }

    private static void Append(IncrementalHash hash, string value)
    {
        Span<byte> separator = stackalloc byte[] { 0 };
        hash.AppendData(separator);
        hash.AppendData(Encoding.UTF8.GetBytes(value));
    }

    private static string ToLowerHex(byte[] bytes)
        => Convert.ToHexString(bytes).ToLowerInvariant();
}
