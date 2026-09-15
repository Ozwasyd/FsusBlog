namespace FsusBlog.Shared.Contracts.BlockLinks;

/// <summary>Defines the sole Blog-side projection of the FsusUI #289 block-anchor contract.</summary>
public static class BlockAnchorSchemas
{
    public const int Version = 1;
    public const string Contract = "fsusblog.block-anchor-contract.v1";
    public const string UpstreamContract = "fsusui.markdown-anchor.v1";
    public const string Grammar = "[a-z][a-z0-9-]{0,63}";
    public const string SourceMarkerPrefix = "^";
    public const string UrlFragmentPrefix = "#";
    public const string MarkdownRoutePrefix = "/posts/";
    public const string DigestAlgorithm = "sha256";
    public const string CanonicalSerialization = "length-prefixed-utf8-v1";
    public const string VerificationReceipt = "fsusblog.block-anchor-verification-receipt.v1";

    public static string ContractDigest => BlockAnchorContractDigest.ComputeContract();
}

/// <summary>Closed error taxonomy for the identity and codec boundary.</summary>
public enum BlockAnchorErrorCode : byte
{
    InvalidGrammar = 1,
    UnsupportedSyntax = 2,
    Duplicate = 3,
    MissingArticle = 4,
    MissingAnchor = 5,
    CodecMismatch = 6
}

/// <summary>Pairs one closed error code with a safe, non-content reason code.</summary>
public sealed record BlockAnchorError(
    BlockAnchorErrorCode Code,
    string ReasonCode);

/// <summary>Non-throwing result used by all boundary parsers and validators.</summary>
public readonly record struct BlockAnchorValidationResult(
    bool IsValid,
    BlockAnchorErrorCode? ErrorCode,
    string? ReasonCode)
{
    public static BlockAnchorValidationResult Valid()
        => new(true, null, null);

    public static BlockAnchorValidationResult Invalid(
        BlockAnchorErrorCode errorCode,
        string reasonCode)
        => new(false, errorCode, reasonCode);
}

/// <summary>
/// The only Blog value object for a block anchor. It preserves the exact lowercase ASCII
/// spelling accepted by FsusUI #289 and has no normalization or compatibility constructor.
/// </summary>
public readonly record struct BlockAnchorId
{
    private BlockAnchorId(string value)
    {
        Value = value;
    }

    public string Value
    {
        get;
    }

    public static BlockAnchorValidationResult TryCreate(
        string? value,
        out BlockAnchorId id)
    {
        id = default;
        if (!IsCanonical(value))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.InvalidGrammar,
                "block_anchor_invalid_grammar");
        }

        id = new BlockAnchorId(value!);
        return BlockAnchorValidationResult.Valid();
    }

    public static BlockAnchorId Create(string value)
    {
        BlockAnchorValidationResult validation = TryCreate(value, out BlockAnchorId id);
        return validation.IsValid
            ? id
            : throw new ArgumentException(validation.ReasonCode, nameof(value));
    }

    public static bool IsCanonical(string? value)
    {
        if (value is null || value.Length is < 1 or > 64)
        {
            return false;
        }

        if (value[0] is < 'a' or > 'z')
        {
            return false;
        }

        for (int index = 1; index < value.Length; index++)
        {
            char character = value[index];
            if (!((character is >= 'a' and <= 'z')
                || (character is >= '0' and <= '9')
                || character == '-'))
            {
                return false;
            }
        }

        return true;
    }

    public override string ToString() => Value ?? string.Empty;
}

/// <summary>
/// Stable durable target. The article identity is the existing portable article identity;
/// the route slug and URL remain projections and are intentionally absent from this record.
/// </summary>
public sealed record ArticleBlockTarget(
    string ArticleIdentity,
    BlockAnchorId AnchorId)
{
    public static BlockAnchorValidationResult TryCreate(
        string? articleIdentity,
        string? anchor,
        out ArticleBlockTarget? target)
    {
        target = null;
        if (string.IsNullOrEmpty(articleIdentity))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.MissingArticle,
                "block_anchor_article_missing");
        }

        if (string.IsNullOrEmpty(anchor))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.MissingAnchor,
                "block_anchor_anchor_missing");
        }

        BlockAnchorValidationResult anchorValidation = BlockAnchorId.TryCreate(anchor, out BlockAnchorId id);
        if (!anchorValidation.IsValid)
        {
            return anchorValidation;
        }

        if (!BlockAnchorContractValidator.IsStableArticleIdentity(articleIdentity))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.InvalidGrammar,
                "block_anchor_article_identity_invalid");
        }

        target = new ArticleBlockTarget(articleIdentity!, id);
        return BlockAnchorValidationResult.Valid();
    }

    public static ArticleBlockTarget Create(
        string articleIdentity,
        BlockAnchorId anchorId)
    {
        BlockAnchorValidationResult validation = BlockAnchorContractValidator.Validate(
            new ArticleBlockTarget(articleIdentity, anchorId));
        return validation.IsValid
            ? new ArticleBlockTarget(articleIdentity, anchorId)
            : throw new ArgumentException(validation.ReasonCode, nameof(articleIdentity));
    }
}

/// <summary>Non-durable current route projection used only while building a standard Markdown link.</summary>
public sealed record ArticleBlockRouteProjection(
    ArticleBlockTarget Target,
    string CanonicalSlug);

/// <summary>Parsed standard Markdown link; the route is retained as a projection, never as target identity.</summary>
public sealed record BlockAnchorMarkdownLink(
    string DisplayText,
    string RoutePath,
    BlockAnchorId AnchorId);

/// <summary>Contract coordinate carried by future query/index/picker/refactor/package identities.</summary>
public sealed record BlockAnchorConsumerIdentity(
    string ConsumerKind,
    int ConsumerVersion,
    int ContractVersion,
    string ContractDigest,
    string InputDigest,
    string IdentityDigest);

/// <summary>Independent round-trip input used by the verifier without any query or UI authority.</summary>
public sealed record BlockAnchorRoundTripCase(
    ArticleBlockTarget Target,
    string CanonicalSlug,
    string DisplayText);

/// <summary>Stable, non-sensitive verifier result for one identity/codec round trip.</summary>
public sealed record BlockAnchorVerificationResult(
    string Schema,
    int SchemaVersion,
    bool IsValid,
    IReadOnlyList<string> ReasonCodes,
    string ContractDigest,
    string VerificationDigest);
