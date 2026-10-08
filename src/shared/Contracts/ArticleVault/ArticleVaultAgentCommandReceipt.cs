namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Distinguishes local admission from actual canonical execution completion.</summary>
public enum ArticleVaultAgentCommandStatus
{
    Admitted,
    Blocked,
    Cancelled,
    Completed
}

/// <summary>Records only request identities, byte count, digests, closed status and reason.</summary>
public sealed record ArticleVaultAgentCommandReceipt(
    string Schema,
    ArticleVaultAgentBinding Binding,
    string RequestIdentity,
    string RequestSha256,
    long LeaseGeneration,
    string LeaseReceiptSha256,
    ArticleVaultAgentCommand Command,
    string CancellationIdentity,
    long DeadlineUnixMilliseconds,
    long FrameByteLength,
    ArticleVaultAgentCommandStatus Status,
    string? ReasonCode,
    string? CanonicalResultSha256,
    string ContentSha256);

/// <summary>Produces privacy-safe wire receipts; completed/cancelled require an actual owner receipt.</summary>
public static class ArticleVaultAgentCommandReceipts
{
    public const string Schema = "fsusblog.article-vault.agent-command-receipt.v1";

    /// <summary>Encodes only one closed result bound to the exact admitted request and frame.</summary>
    public static byte[] EncodeForRequest(
        ArticleVaultAgentRequest request,
        long frameByteLength,
        ArticleVaultAgentCommandReceipt receipt)
    {
        byte[] bytes = ArticleVaultAgentProtocol.Encode(receipt);
        ArticleVaultAgentCommandReceipt validated = Decode(bytes);
        if (!ArticleVaultAgentRequestCodec.Verify(request)
            || validated.Binding != request.Binding || validated.RequestIdentity != request.RequestIdentity
            || validated.RequestSha256 != request.ContentSha256 || validated.Command != request.Command
            || validated.LeaseGeneration != request.LeaseGeneration
            || validated.LeaseReceiptSha256 != request.LeaseReceiptSha256
            || validated.CancellationIdentity != request.CancellationIdentity
            || validated.DeadlineUnixMilliseconds != request.DeadlineUnixMilliseconds
            || validated.FrameByteLength != frameByteLength)
        {
            throw new InvalidDataException("agent_ipc_result_request_mismatch");
        }

        return bytes;
    }

    public static ArticleVaultAgentCommandReceipt Create(
        ArticleVaultAgentRequest request,
        long frameByteLength,
        ArticleVaultAgentCommandStatus status,
        string? reasonCode,
        string? canonicalResultSha256 = null)
    {
        if (!ArticleVaultAgentRequestCodec.Verify(request)
            || frameByteLength is < 1 or > ArticleVaultAgentProtocol.MaximumFrameBytes || !Enum.IsDefined(status)
            || (reasonCode is not null && (reasonCode.Length is < 1 or > 64
                || !reasonCode.All(static character => char.IsAsciiLetterOrDigit(character) || character == '_')))
            || (canonicalResultSha256 is not null && !ArticleVaultAgentProtocol.IsDigest(canonicalResultSha256))
            || (status is ArticleVaultAgentCommandStatus.Completed or ArticleVaultAgentCommandStatus.Cancelled
                ? canonicalResultSha256 is null : status == ArticleVaultAgentCommandStatus.Admitted && canonicalResultSha256 is not null)
            || (status is ArticleVaultAgentCommandStatus.Blocked or ArticleVaultAgentCommandStatus.Cancelled && reasonCode is null))
        {
            throw new InvalidDataException("agent_command_receipt_input_invalid");
        }

        var receipt = new ArticleVaultAgentCommandReceipt(Schema, request.Binding, request.RequestIdentity,
            request.ContentSha256, request.LeaseGeneration, request.LeaseReceiptSha256, request.Command,
            request.CancellationIdentity, request.DeadlineUnixMilliseconds, frameByteLength,
            status, reasonCode, canonicalResultSha256, string.Empty);
        return receipt with
        {
            ContentSha256 = ArticleVaultAgentProtocol.Digest(receipt)
        };
    }

    public static ArticleVaultAgentCommandReceipt Decode(ReadOnlySpan<byte> bytes)
    {
        ArticleVaultAgentCommandReceipt receipt = ArticleVaultAgentProtocol.Decode<ArticleVaultAgentCommandReceipt>(bytes);
        if (receipt.Schema != Schema || !ArticleVaultAgentProtocol.IsBinding(receipt.Binding)
            || !ArticleVaultAgentProtocol.IsIdentity(receipt.RequestIdentity)
            || !ArticleVaultAgentProtocol.IsIdentity(receipt.CancellationIdentity)
            || receipt.LeaseGeneration < 1 || receipt.DeadlineUnixMilliseconds < 0
            || !ArticleVaultAgentProtocol.IsDigest(receipt.LeaseReceiptSha256)
            || !ArticleVaultAgentProtocol.IsDigest(receipt.RequestSha256) || !Enum.IsDefined(receipt.Command)
            || !Enum.IsDefined(receipt.Status) || receipt.FrameByteLength is < 1 or > ArticleVaultAgentProtocol.MaximumFrameBytes
            || (receipt.ReasonCode is not null && (receipt.ReasonCode.Length is < 1 or > 64
                || !receipt.ReasonCode.All(static character => char.IsAsciiLetterOrDigit(character) || character == '_')))
            || (receipt.CanonicalResultSha256 is not null && !ArticleVaultAgentProtocol.IsDigest(receipt.CanonicalResultSha256))
            || (receipt.Status is ArticleVaultAgentCommandStatus.Completed or ArticleVaultAgentCommandStatus.Cancelled
                ? receipt.CanonicalResultSha256 is null : receipt.Status == ArticleVaultAgentCommandStatus.Admitted && receipt.CanonicalResultSha256 is not null)
            || (receipt.Status is ArticleVaultAgentCommandStatus.Blocked or ArticleVaultAgentCommandStatus.Cancelled && receipt.ReasonCode is null)
            || receipt.ContentSha256 != ArticleVaultAgentProtocol.Digest(receipt with
            {
                ContentSha256 = string.Empty
            }))
        {
            throw new InvalidDataException("agent_command_receipt_invalid");
        }

        return receipt;
    }
}
