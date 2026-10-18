namespace FsusBlog.Server.Infrastructure.Memory.Disk;

/// <summary>Classification supplied by the existing content owner, never inferred from availability.</summary>
public enum DiskSpillClassification
{
    Unclassified,
    PrivateResponse,
    Credentials,
    UnpublishedDraft,
    Authoritative,
    PublicImmutableReconstructible
}

/// <summary>Generic spill eligibility is subordinate to the data owner's deny decision.</summary>
public static class DiskSpillEligibility
{
    public static bool IsEligible(DiskSpillClassification classification)
        => classification == DiskSpillClassification.PublicImmutableReconstructible;

    public static bool IsEligible(DiskSpillClassification classification, bool dataOwnerAllows)
        => dataOwnerAllows && IsEligible(classification);
}
