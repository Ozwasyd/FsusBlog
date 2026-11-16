namespace FsusBlog.V2.Contracts;

// Cover preparation binds dormant candidate custody, not a current-table projection or publication.
public sealed record LegacyCoverPreparationRequest(string Format, string PlanSha256, string CandidateSha256,
    string ProofSha256, string CustodyManifestSha256, Guid SourceSiteId, Guid TargetSiteId,
    LegacyMediaPreparationAsset[] Assets, LegacyCoverPreparationReference[] References)
{
    public const string RequestFormat = "fsusblog.legacy-cover-preparation-request.v1";
    public const string ResultFormat = "fsusblog.legacy-cover-preparation-result.v1";
    public const int MaxAssets = 32;
    public const int MaxReferences = 128;
    public const int MaxTotalBytes = 64 * 1024 * 1024;
}

public sealed record LegacyCoverPreparationReference(Guid AssetId, string SourceKind, int ArticleId, long SourceId,
    long SourceRevisionId, long Revision, long SourceOwnerId, Guid TargetOwnerId, string Role);
