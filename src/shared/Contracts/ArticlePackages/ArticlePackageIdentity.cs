using FsusBlog.Shared.Contracts.ArticleEmbeds;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Closed kinds of package-local identities; source database coordinates are separate facts.</summary>
public enum ArticlePackageIdentityKind : byte
{
    Article = 1,
    Asset = 2,
    Definition = 3,
    Option = 4,
    Category = 5,
    Tag = 6
}

/// <summary>Closed failures shared by the package identity and inventory boundary.</summary>
public enum ArticlePackageErrorCode : byte
{
    InvalidIdentity = 1,
    UnsafePath = 2,
    UnknownPath = 3,
    NonRegularEntry = 4,
    DuplicatePath = 5,
    DuplicateIdentity = 6,
    MissingRequiredEntry = 7,
    InvalidSize = 8,
    BudgetExceeded = 9
}

/// <summary>Non-throwing validation result. Reasons are fixed codes and never contain package content.</summary>
public readonly record struct ArticlePackageValidationResult(
    bool IsValid,
    ArticlePackageErrorCode? ErrorCode,
    string? ReasonCode)
{
    public static ArticlePackageValidationResult Valid()
        => new(true, null, null);

    public static ArticlePackageValidationResult Invalid(
        ArticlePackageErrorCode errorCode,
        string reasonCode)
        => new(false, errorCode, reasonCode);
}

/// <summary>
/// Parses an explicit package identity without converting database IDs, names, URLs or source
/// identities. The namespace separates identity roles; syntax alone cannot prove provenance.
/// </summary>
public readonly record struct ArticlePackageIdentity
{
    private ArticlePackageIdentity(ArticlePackageIdentityKind kind, string value, string fileNameToken)
    {
        Kind = kind;
        Value = value;
        FileNameToken = fileNameToken;
    }

    public ArticlePackageIdentityKind Kind
    {
        get;
    }

    public string? Value
    {
        get;
    }

    /// <summary>Exact lowercase UUID spelling for layout projection; null for the invalid default value.</summary>
    public string? FileNameToken
    {
        get;
    }

    public static ArticlePackageValidationResult TryCreate(
        ArticlePackageIdentityKind kind,
        string? value,
        out ArticlePackageIdentity identity)
    {
        identity = default;
        string? prefix = kind switch
        {
            ArticlePackageIdentityKind.Article => "article:",
            ArticlePackageIdentityKind.Asset => "portable-asset:",
            ArticlePackageIdentityKind.Definition => "portable-definition:",
            ArticlePackageIdentityKind.Option => "portable-option:",
            ArticlePackageIdentityKind.Category => "portable-category:",
            ArticlePackageIdentityKind.Tag => "portable-tag:",
            _ => null
        };
        if (prefix is null
            || value is null
            || value.Length != prefix.Length + 36
            || !value.StartsWith(prefix, StringComparison.Ordinal))
        {
            return ArticlePackageValidationResult.Invalid(
                ArticlePackageErrorCode.InvalidIdentity,
                "article_package_identity_invalid");
        }

        string token = value[prefix.Length..];
        bool isCanonical = kind == ArticlePackageIdentityKind.Article
            ? ArticleEmbedTargetCodec.IsPortableArticleIdentity(value)
            : IsCanonicalToken(token);
        if (!isCanonical)
        {
            return ArticlePackageValidationResult.Invalid(
                ArticlePackageErrorCode.InvalidIdentity,
                "article_package_identity_invalid");
        }

        identity = new ArticlePackageIdentity(kind, value, token);
        return ArticlePackageValidationResult.Valid();
    }

    internal static bool IsCanonicalToken(string? value)
        => value is not null
            && value.Length == 36
            && ArticleEmbedTargetCodec.IsPortableArticleIdentity("article:" + value);
}
