using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public sealed record RevisionCompareAdmission(
    RevisionCompareAdmissionMode Mode,
    int BaseSourceByteCount,
    int CompareSourceByteCount,
    int BaseLineCount,
    int CompareLineCount,
    long InitialEstimatedMemoryBytes,
    long MinimumEstimatedOutputBytes,
    int TokenLimit,
    int HunkLimit,
    int ChunkLimit,
    string ContentDigest);

public sealed class RevisionComparePlan
{
    internal RevisionComparePlan(
        int schemaVersion,
        string plannerVersion,
        int articleId,
        RevisionCompareReadContext reader,
        RevisionCompareSourceSelector baseSelector,
        RevisionCompareSourceSelector compareSelector,
        RevisionComparePackageReference basePackage,
        RevisionComparePackageReference comparePackage,
        RevisionCompareOptions options,
        RevisionCompareBudgets budgets,
        RevisionCompareAdmission admission,
        string cancellationIdentity,
        DateTimeOffset expiresAtUtc,
        string contentDigest)
    {
        SchemaVersion = schemaVersion;
        PlannerVersion = plannerVersion;
        ArticleId = articleId;
        Reader = reader;
        BaseSelector = baseSelector;
        CompareSelector = compareSelector;
        BasePackage = basePackage;
        ComparePackage = comparePackage;
        Options = options with
        {
            MetadataFieldIds = options.MetadataFields
        };
        Budgets = budgets;
        Admission = admission;
        CancellationIdentity = cancellationIdentity;
        ExpiresAtUtc = expiresAtUtc;
        ContentDigest = contentDigest;
    }

    public int SchemaVersion
    {
        get;
    }

    public string PlannerVersion
    {
        get;
    }

    public int ArticleId
    {
        get;
    }

    public RevisionCompareReadContext Reader
    {
        get;
    }

    public RevisionCompareSourceSelector BaseSelector
    {
        get;
    }

    public RevisionCompareSourceSelector CompareSelector
    {
        get;
    }

    public RevisionComparePackageReference BasePackage
    {
        get;
    }

    public RevisionComparePackageReference ComparePackage
    {
        get;
    }

    public RevisionCompareOptions Options
    {
        get;
    }

    public RevisionCompareBudgets Budgets
    {
        get;
    }

    public RevisionCompareAdmission Admission
    {
        get;
    }

    public string CancellationIdentity
    {
        get;
    }

    public DateTimeOffset ExpiresAtUtc
    {
        get;
    }

    public string ContentDigest
    {
        get;
    }
}

public sealed record RevisionComparePlanReceipt(
    int SchemaVersion,
    Guid RequestId,
    RevisionComparePlanStatus Status,
    string ReasonCode,
    string? PlanDigest,
    string? BasePackageDigest,
    string? ComparePackageDigest,
    RevisionComparePackageReference? BasePackageReference,
    RevisionComparePackageReference? ComparePackageReference,
    string PermissionScopeDigest,
    string MetadataSchemaDigest,
    string OptionsDigest,
    string BudgetDigest,
    string? AdmissionDigest,
    string CancellationIdentity,
    string ContentDigest);

public sealed record RevisionComparePlanBundle(
    RevisionComparePlan Plan,
    RevisionComparePackage BasePackage,
    RevisionComparePackage ComparePackage,
    RevisionComparePlanReceipt Receipt);

public sealed record RevisionComparePlanResult(
    RevisionComparePlanStatus Status,
    RevisionComparePlanBundle? Bundle,
    RevisionComparePlanReceipt Receipt)
{
    public bool IsSuccess => Status == RevisionComparePlanStatus.Accepted && Bundle is not null;
}
