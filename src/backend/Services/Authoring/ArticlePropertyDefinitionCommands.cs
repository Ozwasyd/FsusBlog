namespace FsusBlog.Server.Services.Authoring;

public sealed record CreateArticlePropertyDefinitionCommand(
    ArticlePropertyDefinitionActor Actor,
    ArticlePropertyDefinitionOwner Owner,
    Guid DefinitionId,
    Guid RequestId,
    long ExpectedOwnerRevision,
    string MachineKey,
    IReadOnlyList<ArticlePropertyLocalizedName> DisplayNames,
    ArticlePropertyValueType ValueType,
    ArticlePropertyCardinality Cardinality,
    bool Required,
    ArticlePropertyPresencePolicy Presence,
    ArticlePropertyDefaultValue? DefaultValue,
    ArticlePropertyConstraints Constraints,
    IReadOnlyList<ArticlePropertyOption> Options,
    ArticlePropertyReferencePolicy? ReferencePolicy,
    ArticlePropertyUrlPolicy? UrlPolicy,
    bool SearchEligible,
    bool Filterable,
    bool Sortable,
    ArticlePropertyDisplayPlacement DisplayPlacement,
    ArticlePropertyVisibilityScope VisibilityScope);

public sealed record UpdateArticlePropertyDefinitionCommand(
    ArticlePropertyDefinitionActor Actor,
    ArticlePropertyDefinitionOwner Owner,
    Guid DefinitionId,
    Guid RequestId,
    long ExpectedOwnerRevision,
    long ExpectedSchemaRevision,
    ArticlePropertyValueType ValueType,
    ArticlePropertyCardinality Cardinality,
    bool Required,
    ArticlePropertyPresencePolicy Presence,
    ArticlePropertyDefaultValue? DefaultValue,
    ArticlePropertyConstraints Constraints,
    IReadOnlyList<ArticlePropertyOption> Options,
    ArticlePropertyReferencePolicy? ReferencePolicy,
    ArticlePropertyUrlPolicy? UrlPolicy,
    bool SearchEligible,
    bool Filterable,
    bool Sortable,
    ArticlePropertyDisplayPlacement DisplayPlacement,
    ArticlePropertyVisibilityScope VisibilityScope);

public sealed record RenameArticlePropertyDefinitionCommand(
    ArticlePropertyDefinitionActor Actor,
    ArticlePropertyDefinitionOwner Owner,
    Guid DefinitionId,
    Guid RequestId,
    long ExpectedOwnerRevision,
    long ExpectedSchemaRevision,
    IReadOnlyList<ArticlePropertyLocalizedName> DisplayNames);

public sealed record DeprecateArticlePropertyDefinitionCommand(
    ArticlePropertyDefinitionActor Actor,
    ArticlePropertyDefinitionOwner Owner,
    Guid DefinitionId,
    Guid RequestId,
    long ExpectedOwnerRevision,
    long ExpectedSchemaRevision);

public sealed record DeleteArticlePropertyDefinitionCommand(
    ArticlePropertyDefinitionActor Actor,
    ArticlePropertyDefinitionOwner Owner,
    Guid DefinitionId,
    Guid RequestId,
    long ExpectedOwnerRevision,
    long ExpectedSchemaRevision);

public sealed class ArticlePropertyDefinitionValidationException(string code) : ArgumentException(code)
{
    public string Code { get; } = code;
}

public sealed class ArticlePropertyDefinitionAccessDeniedException()
    : UnauthorizedAccessException("article_property_definition_access_denied");

public sealed class ArticlePropertyDefinitionNotFoundException()
    : KeyNotFoundException("article_property_definition_not_found");

public sealed class ArticlePropertyDefinitionConflictException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}

public sealed class ArticlePropertyDefinitionBudgetExceededException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}

public sealed class ArticlePropertyDefinitionIntegrityException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}
