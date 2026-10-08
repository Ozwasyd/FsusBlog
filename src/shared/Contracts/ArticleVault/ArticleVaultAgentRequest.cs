namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Lists the only local agent command classes; no arbitrary operation is accepted.</summary>
public enum ArticleVaultAgentCommand
{
    ObserveBatch,
    RequestPlanner,
    ExecuteVerifiedPlan,
    MaterializeVerifiedInstruction,
    InspectStatus,
    Cancel,
    Revoke
}

/// <summary>Identifies one closed content-addressed prerequisite, never a file or network location.</summary>
public enum ArticleVaultAgentReferenceKind
{
    ObservationBatch,
    PlannerInput,
    VerifiedPlan,
    VerifiedMaterializationInstruction,
    Operation
}

/// <summary>The wire reference is not proof of admission by the canonical referenced owner.</summary>
public sealed record ArticleVaultAgentReference(
    ArticleVaultAgentReferenceKind Kind,
    string Identity,
    string ContentSha256);

/// <summary>Contains only identity-bound command metadata and one necessary reference.</summary>
public sealed record ArticleVaultAgentRequest(
    string Schema,
    ArticleVaultAgentBinding Binding,
    string RequestIdentity,
    long LeaseGeneration,
    string LeaseReceiptSha256,
    ArticleVaultAgentCommand Command,
    long DeadlineUnixMilliseconds,
    string CancellationIdentity,
    ArticleVaultAgentReference? Reference,
    string ContentSha256);

/// <summary>Checks wire structure without claiming token, native IPC or business admission.</summary>
public static class ArticleVaultAgentRequestCodec
{
    public static ArticleVaultAgentRequest Decode(ReadOnlySpan<byte> bytes)
    {
        ArticleVaultAgentRequest request = ArticleVaultAgentProtocol.Decode<ArticleVaultAgentRequest>(bytes);
        if (!Verify(request))
        {
            throw new InvalidDataException("agent_request_invalid");
        }

        return request;
    }

    public static bool Verify(ArticleVaultAgentRequest? request)
    {
        if (request is null || request.Schema != ArticleVaultAgentProtocol.RequestSchema
            || !ArticleVaultAgentProtocol.IsBinding(request.Binding)
            || !ArticleVaultAgentProtocol.IsIdentity(request.RequestIdentity)
            || !ArticleVaultAgentProtocol.IsIdentity(request.CancellationIdentity)
            || request.LeaseGeneration < 1 || request.DeadlineUnixMilliseconds < 0
            || !ArticleVaultAgentProtocol.IsDigest(request.LeaseReceiptSha256)
            || !Enum.IsDefined(request.Command) || !ArticleVaultAgentProtocol.IsDigest(request.ContentSha256))
        {
            return false;
        }

        ArticleVaultAgentReferenceKind? kind = request.Command switch
        {
            ArticleVaultAgentCommand.ObserveBatch => ArticleVaultAgentReferenceKind.ObservationBatch,
            ArticleVaultAgentCommand.RequestPlanner => ArticleVaultAgentReferenceKind.PlannerInput,
            ArticleVaultAgentCommand.ExecuteVerifiedPlan => ArticleVaultAgentReferenceKind.VerifiedPlan,
            ArticleVaultAgentCommand.MaterializeVerifiedInstruction => ArticleVaultAgentReferenceKind.VerifiedMaterializationInstruction,
            ArticleVaultAgentCommand.Cancel => ArticleVaultAgentReferenceKind.Operation,
            _ => null
        };
        bool referenceValid = kind is null ? request.Reference is null
            : request.Reference is not null && request.Reference.Kind == kind
                && ArticleVaultAgentProtocol.IsIdentity(request.Reference.Identity)
                && ArticleVaultAgentProtocol.IsDigest(request.Reference.ContentSha256);
        return referenceValid
            && request.ContentSha256 == ArticleVaultAgentProtocol.Digest(request with
            {
                ContentSha256 = string.Empty
            });
    }
}
