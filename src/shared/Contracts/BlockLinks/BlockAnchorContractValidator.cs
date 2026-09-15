using System.Security.Cryptography;

using FsusBlog.Shared.Contracts.ArticleEmbeds;

namespace FsusBlog.Shared.Contracts.BlockLinks;

/// <summary>Fail-closed validation for the canonical block-anchor contract and its projections.</summary>
public static class BlockAnchorContractValidator
{
    public static BlockAnchorValidationResult Validate(string? value)
    {
        return BlockAnchorId.IsCanonical(value)
            ? BlockAnchorValidationResult.Valid()
            : BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.InvalidGrammar,
                "block_anchor_invalid_grammar");
    }

    public static BlockAnchorValidationResult Validate(BlockAnchorId id)
        => Validate(id.Value);

    public static BlockAnchorValidationResult Validate(BlockAnchorError? error)
    {
        if (error is null
            || !Enum.IsDefined(error.Code)
            || !IsReasonCode(error.ReasonCode))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_error_invalid");
        }

        return BlockAnchorValidationResult.Valid();
    }

    public static BlockAnchorValidationResult Validate(ArticleBlockTarget? target)
    {
        if (target is null)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.MissingAnchor,
                "block_anchor_target_missing");
        }

        if (string.IsNullOrEmpty(target.ArticleIdentity))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.MissingArticle,
                "block_anchor_article_missing");
        }

        if (string.IsNullOrEmpty(target.AnchorId.Value))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.MissingAnchor,
                "block_anchor_anchor_missing");
        }

        if (!IsStableArticleIdentity(target.ArticleIdentity))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.InvalidGrammar,
                "block_anchor_article_identity_invalid");
        }

        return Validate(target.AnchorId);
    }

    public static BlockAnchorValidationResult Validate(ArticleBlockRouteProjection? projection)
    {
        if (projection is null)
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_route_projection_missing");
        }

        BlockAnchorValidationResult target = Validate(projection.Target);
        return !target.IsValid
            ? target
            : IsCanonicalSlug(projection.CanonicalSlug)
                ? BlockAnchorValidationResult.Valid()
                : BlockAnchorValidationResult.Invalid(
                    BlockAnchorErrorCode.CodecMismatch,
                    "block_anchor_route_projection_invalid");
    }

    public static BlockAnchorValidationResult Validate(BlockAnchorConsumerIdentity? identity)
    {
        if (identity is null
            || !IsConsumerIdentifier(identity.ConsumerKind)
            || identity.ConsumerVersion < 1
            || identity.ContractVersion != BlockAnchorSchemas.Version
            || identity.ContractDigest is null
            || !BlockAnchorContractDigest.IsSha256(identity.ContractDigest)
            || identity.InputDigest is null
            || !BlockAnchorContractDigest.IsSha256(identity.InputDigest)
            || !BlockAnchorContractDigest.IsSha256(identity.IdentityDigest))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_consumer_identity_invalid");
        }

        if (!DigestEquals(identity.ContractDigest, BlockAnchorContractDigest.ComputeContract())
            || !DigestEquals(identity.IdentityDigest, BlockAnchorContractDigest.ComputeConsumerIdentity(identity)))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_consumer_identity_digest_mismatch");
        }

        return BlockAnchorValidationResult.Valid();
    }

    public static BlockAnchorValidationResult Validate(BlockAnchorVerificationResult? receipt)
    {
        if (receipt is null
            || receipt.Schema != BlockAnchorSchemas.VerificationReceipt
            || receipt.SchemaVersion != BlockAnchorSchemas.Version
            || receipt.ReasonCodes is null
            || !BlockAnchorContractDigest.IsSha256(receipt.ContractDigest)
            || !BlockAnchorContractDigest.IsSha256(receipt.VerificationDigest)
            || receipt.IsValid != (receipt.ReasonCodes.Count == 0)
            || receipt.ReasonCodes.Any(reason => !IsReasonCode(reason)))
        {
            return BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_verification_receipt_invalid");
        }

        return DigestEquals(receipt.ContractDigest, BlockAnchorContractDigest.ComputeContract())
            ? BlockAnchorValidationResult.Valid()
            : BlockAnchorValidationResult.Invalid(
                BlockAnchorErrorCode.CodecMismatch,
                "block_anchor_verification_contract_digest_mismatch");
    }

    public static BlockAnchorConsumerIdentity SealConsumerIdentity(
        string consumerKind,
        int consumerVersion,
        string inputDigest)
    {
        var unsigned = new BlockAnchorConsumerIdentity(
            consumerKind,
            consumerVersion,
            BlockAnchorSchemas.Version,
            BlockAnchorContractDigest.ComputeContract(),
            inputDigest,
            string.Empty);
        return unsigned with
        {
            IdentityDigest = BlockAnchorContractDigest.ComputeConsumerIdentity(unsigned)
        };
    }

    public static bool IsStableArticleIdentity(string? value)
        => ArticleEmbedTargetCodec.IsPortableArticleIdentity(value);

    public static bool IsCanonicalSlug(string? value)
    {
        if (value is null || value.Length is < 1 or > 512)
        {
            return false;
        }

        foreach (char character in value)
        {
            if (char.IsControl(character)
                || character is '/' or '\\' or '?' or '#'
                || character == '^')
            {
                return false;
            }
        }

        return true;
    }

    public static bool IsDisplayText(string? value)
    {
        if (value is null || value.Length is < 1 or > 1024)
        {
            return false;
        }

        foreach (char character in value)
        {
            if (char.IsControl(character) && character is not '\t'
                || character is '[' or ']')
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsConsumerIdentifier(string? value)
    {
        if (value is null || value.Length is < 1 or > 128)
        {
            return false;
        }

        foreach (char character in value)
        {
            if (!((character is >= 'a' and <= 'z')
                || (character is >= '0' and <= '9')
                || character is '_' or '-' or '.'))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsReasonCode(string? value)
    {
        if (value is null || value.Length is < 3 or > 128)
        {
            return false;
        }

        foreach (char character in value)
        {
            if (!((character is >= 'a' and <= 'z')
                || (character is >= '0' and <= '9')
                || character is '_' or '-'))
            {
                return false;
            }
        }

        return true;
    }

    private static bool DigestEquals(string supplied, string expected)
        => BlockAnchorContractDigest.IsSha256(supplied)
            && CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(supplied),
                Convert.FromHexString(expected));
}
