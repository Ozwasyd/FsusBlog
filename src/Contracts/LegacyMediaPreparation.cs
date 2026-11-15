using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.V2.Contracts;

public static class LegacyMediaPreparation
{
    public const string RequestFormat = "fsusblog.legacy-media-preparation-request.v1";
    public const string ResultFormat = "fsusblog.legacy-media-preparation-result.v1";
    public const int MaxAssets = 5_000;
    public const int MaxReferences = 20_000;
    public const int MaxFileBytes = 20 * 1024 * 1024;
    public const long MaxTotalBytes = 1024L * 1024 * 1024;
    public const int MaxManifestBytes = 16 * 1024 * 1024;

    public static JsonSerializerOptions Json { get; } = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        AllowDuplicateProperties = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 8,
        NumberHandling = JsonNumberHandling.Strict
    };
}

public sealed record LegacyMediaPreparationRequest(string Format, string PlanSha256, string ProjectionSha256,
    string CustodyManifestSha256, Guid SourceSiteId, Guid TargetSiteId,
    LegacyMediaPreparationAsset[] Assets, LegacyMediaPreparationReference[] References);

public sealed record LegacyMediaPreparationAsset(Guid AssetId, string RawSha256, int RawBytes, int Width, int Height,
    string MediaType, string Extension, long SourceOwnerId, Guid TargetOwnerId);

public sealed record LegacyMediaPreparationReference(Guid AssetId, int ArticleId, long SourceRevisionId, long Revision,
    int ReferenceCount, string? AltText);

public sealed record LegacyMediaPreparationResult(string Format, string RequestSha256, string NormalizerSha256,
    LegacyMediaPreparedAsset[] Assets);

public sealed record LegacyMediaPreparedAsset(Guid AssetId, string RawSha256, string NormalizedSha256, int Length,
    short Format, int Width, int Height);
