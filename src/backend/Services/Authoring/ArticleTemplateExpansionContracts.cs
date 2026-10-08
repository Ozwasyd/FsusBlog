using FsusBlog.Shared.Contracts.Localization;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Closed expansion request for one exact template version. The input binds the template
/// identity, the acting principal, the explicit create-side fields, business time with an
/// explicit IANA time zone, and the caller-declared site locale. Unknown fields do not exist
/// and cannot be smuggled through: every member is a constructor argument.
/// </summary>
public sealed record ArticleTemplateExpansionInput
{
    public ArticleTemplateExpansionInput(
        ArticleTemplateActor actor,
        Guid templateId,
        Guid versionId,
        string? title,
        DateTimeOffset businessTimeUtc,
        string timeZoneId,
        string localeCode)
    {
        ArticleTemplateContract.ValidateActor(actor);
        if (templateId == Guid.Empty || versionId == Guid.Empty)
        {
            throw new ArticleTemplateValidationException("article_template_expansion_identity_invalid");
        }
        if (title is not null)
        {
            title = ArticleTemplateContract.NormalizeName(title);
        }
        if (businessTimeUtc.Offset != TimeSpan.Zero)
        {
            throw new ArticleTemplateValidationException("article_template_expansion_time_not_utc");
        }
        try
        {
            _ = string.IsNullOrWhiteSpace(timeZoneId)
                ? throw new ArticleTemplateValidationException("article_template_expansion_timezone_unknown")
                : TimeZoneInfo.FindSystemTimeZoneById(timeZoneId);
        }
        catch (TimeZoneNotFoundException)
        {
            throw new ArticleTemplateValidationException("article_template_expansion_timezone_unknown");
        }
        if (!LocaleCatalog.TryParse(localeCode, out LocaleDescriptor locale))
        {
            throw new ArticleTemplateValidationException("article_template_expansion_locale_unknown");
        }

        Actor = actor;
        TemplateId = templateId;
        VersionId = versionId;
        Title = title;
        BusinessTimeUtc = businessTimeUtc;
        TimeZoneId = timeZoneId;
        LocaleCode = locale.Code;
    }

    public ArticleTemplateActor Actor
    {
        get;
    }
    public Guid TemplateId
    {
        get;
    }
    public Guid VersionId
    {
        get;
    }
    public string? Title
    {
        get;
    }
    public DateTimeOffset BusinessTimeUtc
    {
        get;
    }
    public string TimeZoneId
    {
        get;
    }
    public string LocaleCode
    {
        get;
    }
}

/// <summary>Point-in-time pin of one reusable asset reference inside a plan.</summary>
public sealed record ArticleTemplateAssetPin(
    Guid AssetId,
    string State,
    string StorageClass,
    string? Sha256,
    DateTime UpdatedAtUtc);

/// <summary>
/// Current revision truth for every external reference the plan relies on. Pins record the
/// authority state observed while planning so staleness is detectable, never repaired by name.
/// </summary>
public sealed record ArticleTemplateExpansionDependencies
{
    public ArticleTemplateExpansionDependencies(
        int? categoryId,
        IReadOnlyList<int> tagIds,
        IReadOnlyList<ArticleTemplateAssetPin> assetPins,
        IReadOnlyList<ArticleTemplatePropertyDefault> propertyDefaults,
        ArticleTemplateProfileReference? rightsProfile,
        ArticleTemplateProfileReference? responsibilityProfile,
        ArticleTemplateProfileReference? prepublishProfile)
    {
        ArgumentNullException.ThrowIfNull(tagIds);
        ArgumentNullException.ThrowIfNull(assetPins);
        ArgumentNullException.ThrowIfNull(propertyDefaults);
        if (tagIds.Count > ArticleTemplateContract.MaxTags
            || assetPins.Count > ArticleTemplateContract.MaxAssets
            || propertyDefaults.Count > ArticleTemplateContract.MaxPropertyDefaults)
        {
            throw new ArticleTemplateBudgetExceededException("article_template_expansion_dependency_budget_exceeded");
        }

        CategoryId = categoryId;
        TagIds = Array.AsReadOnly(tagIds.ToArray());
        AssetPins = Array.AsReadOnly(assetPins.ToArray());
        PropertyDefaults = Array.AsReadOnly(propertyDefaults.ToArray());
        RightsProfile = rightsProfile;
        ResponsibilityProfile = responsibilityProfile;
        PrepublishProfile = prepublishProfile;
    }

    public int? CategoryId
    {
        get;
    }
    public IReadOnlyList<int> TagIds
    {
        get;
    }
    public IReadOnlyList<ArticleTemplateAssetPin> AssetPins
    {
        get;
    }
    public IReadOnlyList<ArticleTemplatePropertyDefault> PropertyDefaults
    {
        get;
    }
    public ArticleTemplateProfileReference? RightsProfile
    {
        get;
    }
    public ArticleTemplateProfileReference? ResponsibilityProfile
    {
        get;
    }
    public ArticleTemplateProfileReference? PrepublishProfile
    {
        get;
    }
}

/// <summary>
/// Immutable, recomputable expansion result. The plan intentionally carries no article
/// identity, revision, or execution outcome: the create writer can only consume a verified
/// current plan, and any drift in inputs or authorities changes the content digest.
/// </summary>
public sealed class ArticleTemplateExpansionPlan
{
    private readonly byte[] _expandedSource;

    public ArticleTemplateExpansionPlan(
        ArticleTemplateExpansionInput input,
        Guid versionId,
        int versionNumber,
        long templateRevision,
        ArticleTemplateScope scope,
        byte[] expandedSource,
        string expandedSourceDigest,
        ArticleTemplateDefaults defaults,
        string defaultsDigest,
        ArticleTemplateExpansionDependencies dependencies,
        IReadOnlyList<string> warnings,
        DateTime issuedAtUtc,
        DateTime expiresAtUtc)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(expandedSource);
        ArgumentNullException.ThrowIfNull(defaults);
        ArgumentNullException.ThrowIfNull(dependencies);
        ArgumentNullException.ThrowIfNull(warnings);
        if (versionId != input.VersionId
            || versionNumber is < 1 or > ArticleTemplateContract.MaxVersionsPerTemplate
            || templateRevision < 1
            || issuedAtUtc.Kind != DateTimeKind.Utc
            || expiresAtUtc.Kind != DateTimeKind.Utc
            || expiresAtUtc <= issuedAtUtc
            || expandedSource.Length > ArticleTemplateContract.MaxExpandedSourceBytes)
        {
            throw new ArticleTemplateIntegrityException("article_template_expansion_plan_invalid");
        }

        Input = input;
        VersionId = versionId;
        VersionNumber = versionNumber;
        TemplateRevision = templateRevision;
        Scope = scope;
        _expandedSource = [.. expandedSource];
        ExpandedSourceDigest = expandedSourceDigest;
        Defaults = defaults;
        DefaultsDigest = defaultsDigest;
        Dependencies = dependencies;
        Warnings = Array.AsReadOnly(warnings.ToArray());
        IssuedAtUtc = issuedAtUtc;
        ExpiresAtUtc = expiresAtUtc;
        ContentDigest = ArticleTemplateContract.ComputeExpansionPlanDigest(this);
    }

    public ArticleTemplateExpansionInput Input
    {
        get;
    }
    public Guid VersionId
    {
        get;
    }
    public int VersionNumber
    {
        get;
    }
    public long TemplateRevision
    {
        get;
    }
    public ArticleTemplateScope Scope
    {
        get;
    }
    /// <summary>Returns a detached copy so validation and consumption observe the same immutable bytes.</summary>
    public byte[] ExpandedSource => [.. _expandedSource];
    public string ExpandedSourceDigest
    {
        get;
    }
    public ArticleTemplateDefaults Defaults
    {
        get;
    }
    public string DefaultsDigest
    {
        get;
    }
    public ArticleTemplateExpansionDependencies Dependencies
    {
        get;
    }
    public IReadOnlyList<string> Warnings
    {
        get;
    }
    public DateTime IssuedAtUtc
    {
        get;
    }
    public DateTime ExpiresAtUtc
    {
        get;
    }
    public string ContentDigest
    {
        get;
    }
}

public interface IArticleTemplateExpansionAuthority
{
    /// <summary>Resolves the acting principal's canonical display name.</summary>
    Task<string> ResolveActorDisplayNameAsync(
        long adminPrincipalId,
        CancellationToken cancellationToken = default);

    /// <summary>Pins the current state of every referenced reusable asset.</summary>
    Task<IReadOnlyList<ArticleTemplateAssetPin>> PinAssetsAsync(
        IReadOnlyList<Guid> assetIds,
        CancellationToken cancellationToken = default);
}

public interface IArticleTemplateExpansionPlanner
{
    Task<ArticleTemplateExpansionPlan> PlanAsync(
        ArticleTemplateExpansionInput input,
        CancellationToken cancellationToken = default);
}

public interface IArticleTemplateExpansionVerifier
{
    Task<ArticleTemplateVerificationResult> VerifyAsync(
        ArticleTemplateExpansionPlan plan,
        CancellationToken cancellationToken = default);
}

public sealed class ArticleTemplateExpansionException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}
