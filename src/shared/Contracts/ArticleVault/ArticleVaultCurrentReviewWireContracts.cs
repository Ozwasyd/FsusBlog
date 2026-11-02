using System.Text;

namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Names an exact checkpoint; construction and wire decoding confer no admission.</summary>
public sealed record ArticleVaultCurrentReviewCheckpointReference(
    ArticleVaultOperationIdentity Operation,
    long Sequence,
    string ContentSha256);

/// <summary>Requests an immutable proposal for an article under server-owned current authority.</summary>
public sealed record ArticleVaultCurrentReviewRequest(
    int ArticleId,
    string ResolutionOperationIdentity,
    string ProposalSha256,
    ArticleVaultCurrentReviewCheckpointReference? Checkpoint);

/// <summary>
/// Defines only the bounded request POD. The original owner must supply current inputs and verify
/// stored proposal/operation bindings. An approved current-response projection is still required.
/// </summary>
public static class ArticleVaultCurrentReviewWireContract
{
    /// <summary>Identifies the current-review request POD, independent of historical requests.</summary>
    public const uint RequestMagic = 0x31524356;
    /// <summary>Closed request POD layout version.</summary>
    public const ushort Version = 1;
    /// <summary>Exact request payload size, including zeroed absent checkpoint storage.</summary>
    public const int RequestPayloadBytes = 3_176;
    /// <summary>Exact complete request frame size, including the sixteen-byte AEDS header.</summary>
    public const int RequestFrameBytes = RequestPayloadBytes + 16;
    /// <summary>Fixed UTF-8 identity slot size, with canonical zero padding.</summary>
    public const int IdentitySlotBytes = 512;
    /// <summary>Original canonical identity bound measured in UTF-16 code units.</summary>
    public const int MaxIdentityUtf16Units = 128;
    /// <summary>Largest exact integer supported by the TypeScript wire consumer.</summary>
    public const long MaxWireInteger = 9_007_199_254_740_991;

    /// <summary>Checks closed reference syntax and wire bounds, never actual checkpoint admission.</summary>
    public static bool IsValid(ArticleVaultCurrentReviewRequest? value)
    {
        if (value is null || value.ArticleId <= 0
            || value.ResolutionOperationIdentity is not { Length: 75 }
            || !value.ResolutionOperationIdentity.StartsWith("resolution-", StringComparison.Ordinal)
            || !IsDigest(value.ResolutionOperationIdentity[11..]) || !IsDigest(value.ProposalSha256))
        {
            return false;
        }
        if (value.Checkpoint is not { } checkpoint)
        {
            return true;
        }
        ArticleVaultOperationIdentity? operation = checkpoint.Operation;
        return checkpoint.Sequence is >= 0 and <= MaxWireInteger && IsDigest(checkpoint.ContentSha256)
            && operation is not null && operation.Schema == ArticleVaultOperationSchemas.Identity
            && operation.SchemaVersion == ArticleVaultOperationSchemas.Version
            && IsIdentity(operation.SiteIdentity) && IsIdentity(operation.VaultIdentity)
            && IsIdentity(operation.DeviceIdentity) && IsIdentity(operation.AgentIdentity)
            && IsIdentity(operation.PlanReference) && IsDigest(operation.PlanSha256)
            && IsDigest(operation.RequestSha256) && IsDigest(operation.IdempotencySha256)
            && operation.DeadlineUnixMs is > 0 and <= MaxWireInteger
            && IsDigest(operation.OperationIdentity) && IsDigest(operation.ContentSha256);
    }

    private static bool IsDigest(string? value)
        => value is { Length: 64 } && value.All(static c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static bool IsIdentity(string? value)
    {
        if (value is not { Length: >= 3 and <= MaxIdentityUtf16Units }
            || value.Any(static c => char.IsWhiteSpace(c) || c is '\0' or '/' or '\\'))
        {
            return false;
        }
        try
        {
            return new UTF8Encoding(false, true).GetByteCount(value) < IdentitySlotBytes;
        }
        catch (EncoderFallbackException)
        {
            return false;
        }
    }
}
