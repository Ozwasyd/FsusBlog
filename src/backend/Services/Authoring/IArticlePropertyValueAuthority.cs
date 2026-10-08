using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>The sole article owner supplies current authorization, CAS and transaction admission.</summary>
public interface IArticlePropertyValueAuthority
{
    Task<ArticlePropertyValueMutationReceipt> MutateAsync(
        long actorAdminPrincipalId,
        ArticlePropertyValueMutationCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticlePropertyValueReadModel> ReadAsync(
        long actorAdminPrincipalId,
        ArticlePropertyDefinitionOwner owner,
        int articleId,
        CancellationToken cancellationToken = default);
}

public sealed record ArticlePropertyValueReadModel(
    int ArticleId,
    long ArticleRevisionId,
    long PropertyRevision,
    ArticlePropertyValuePersistedSnapshot? Current,
    IReadOnlyList<ArticlePropertyDefinition> Definitions,
    IReadOnlyList<ArticlePropertyValueReconciliation> Reconciliation);

public sealed record ArticlePropertyValueReconciliation(
    Guid DefinitionId,
    ArticlePropertyValueReconciliationStatus Status,
    string ReasonCode);

public enum ArticlePropertyValueReconciliationStatus : byte
{
    Current = 0,
    DefinitionUnavailable = 1,
    DefinitionInactive = 2,
    DefinitionChanged = 3,
    ValueRejected = 4,
    ReferenceAuthorityUnavailable = 5,
    RequiredValueMissing = 6,
    DefaultPending = 7
}
