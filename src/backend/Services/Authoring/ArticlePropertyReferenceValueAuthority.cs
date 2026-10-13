namespace FsusBlog.Server.Services.Authoring;

/// <summary>Property-specific request for the canonical relation/permission authority; no display data.</summary>
public sealed record ArticlePropertyReferenceValueQuery(
    ArticlePropertyDefinitionActor Actor,
    ArticlePropertyDefinitionOwner Owner,
    int SourceArticleId,
    Guid DefinitionId,
    long DefinitionSchemaRevision,
    ArticlePropertyReferencePolicy Policy,
    IReadOnlyList<long> TargetArticleIds);

/// <summary>
/// Must establish stable target identity, site, current read permission, lifecycle and self/cycle policy.
/// The missing canonical relation implementation is a hard refusal, never an assumed valid target.
/// </summary>
public interface IArticlePropertyReferenceValueAuthority
{
    Task RequireAllowedAsync(ArticlePropertyReferenceValueQuery query, CancellationToken cancellationToken);
}

/// <summary>Explicit current boundary until the relation owner supplies the real capability.</summary>
public sealed class UnavailableArticlePropertyReferenceValueAuthority : IArticlePropertyReferenceValueAuthority
{
    public Task RequireAllowedAsync(ArticlePropertyReferenceValueQuery query, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        throw new ArticlePropertyDefinitionValidationException("article_property_reference_authority_unavailable");
    }
}
