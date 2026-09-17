namespace FsusBlog.Server.Services.Authoring;

public sealed record CreateArticleTemplateCommand(
    ArticleTemplateActor Actor,
    ArticleTemplateScope Scope,
    Guid TemplateId,
    Guid VersionId,
    Guid RequestId,
    long ExpectedScopeRevision,
    string Name,
    string? Description,
    ArticleTemplateSource Source,
    ArticleTemplateDefaults Defaults);

public sealed record CreateArticleTemplateVersionCommand(
    ArticleTemplateActor Actor,
    Guid TemplateId,
    Guid VersionId,
    Guid RequestId,
    long ExpectedScopeRevision,
    long ExpectedTemplateRevision,
    int ExpectedCurrentVersionNumber,
    ArticleTemplateSource Source,
    ArticleTemplateDefaults Defaults);

public sealed record RenameArticleTemplateCommand(
    ArticleTemplateActor Actor,
    Guid TemplateId,
    Guid RequestId,
    long ExpectedScopeRevision,
    long ExpectedTemplateRevision,
    string Name,
    string? Description);

public sealed record RetireArticleTemplateCommand(
    ArticleTemplateActor Actor,
    Guid TemplateId,
    Guid RequestId,
    long ExpectedScopeRevision,
    long ExpectedTemplateRevision);

public sealed record DeleteArticleTemplateCommand(
    ArticleTemplateActor Actor,
    Guid TemplateId,
    Guid RequestId,
    long ExpectedScopeRevision,
    long ExpectedTemplateRevision);

public sealed class ArticleTemplateValidationException(string code) : ArgumentException(code)
{
    public string Code { get; } = code;
}

public sealed class ArticleTemplateAccessDeniedException() : UnauthorizedAccessException("article_template_access_denied");

public sealed class ArticleTemplateNotFoundException() : KeyNotFoundException("article_template_not_found");

public sealed class ArticleTemplateConflictException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}

public sealed class ArticleTemplateBudgetExceededException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}

public sealed class ArticleTemplateReferenceException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}
