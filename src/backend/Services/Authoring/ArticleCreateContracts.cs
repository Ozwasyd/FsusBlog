using System.Text;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Articles;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Closed create modes: blank Draft, explicit template Draft, or explicit Inbox.</summary>
public enum ArticleCreateMode
{
    Blank = 0,
    Template = 1,
    Inbox = 2
}

/// <summary>
/// Immutable Quick Capture input for the existing Inbox create transaction. Title and
/// Markdown are retained verbatim; at least one must contain non-whitespace input.
/// This source contract does not admit URL or template fields or grant actor authority.
/// </summary>
public sealed class ArticleInboxCreateRequest
{
    public const int CurrentSchemaVersion = 1;

    public ArticleInboxCreateRequest(int schemaVersion, string title, string markdownContent)
    {
        ArgumentNullException.ThrowIfNull(title);
        ArgumentNullException.ThrowIfNull(markdownContent);
        if (schemaVersion != CurrentSchemaVersion)
        {
            throw new ArticleCreateValidationException("article_inbox_create_schema_unknown");
        }
        if (title.Length > ArticleProductionNormalizers.MaxTitleLength || title.Any(char.IsControl))
        {
            throw new ArticleCreateValidationException("article_inbox_create_title_invalid");
        }
        try
        {
            _ = new UTF8Encoding(false, true).GetByteCount(title);
        }
        catch (EncoderFallbackException)
        {
            throw new ArticleCreateValidationException("article_inbox_create_title_invalid_utf16");
        }
        string source = ArticleMarkdownSourceAdmission.Require(markdownContent);
        if (string.IsNullOrWhiteSpace(title) && string.IsNullOrWhiteSpace(source))
        {
            throw new ArticleCreateValidationException("article_inbox_create_input_empty");
        }
        SchemaVersion = schemaVersion;
        Title = title;
        MarkdownContent = source;
        ContentDigest = ArticleTemplateContract.ComputeCommandDigest(
            "article-inbox-create-input", schemaVersion, title, Encoding.UTF8.GetBytes(source));
    }

    public int SchemaVersion
    {
        get;
    }
    public string Title
    {
        get;
    }
    public string MarkdownContent
    {
        get;
    }
    public string ContentDigest
    {
        get;
    }
}

/// <summary>
/// Closed, versioned create request. <see cref="ArticleCreateMode.Blank"/> requires every
/// template field to be absent; <see cref="ArticleCreateMode.Template"/> requires the
/// template identity, version, verified expansion plan, and its digest as one complete set.
/// There is no implicit, defaulted, or recommended template path.
/// </summary>
public sealed class ArticleCreateCommand
{
    public ArticleCreateCommand(
        ArticleTemplateActor actor,
        Guid requestId,
        ArticleCreateMode mode,
        Guid? templateId = null,
        Guid? templateVersionId = null,
        ArticleTemplateExpansionPlan? plan = null,
        string? planDigest = null)
        : this(actor, requestId, mode, templateId, templateVersionId, plan, planDigest, null)
    {
    }

    public ArticleCreateCommand(ArticleTemplateActor actor, Guid requestId, ArticleInboxCreateRequest request)
        : this(actor, requestId, ArticleCreateMode.Inbox, null, null, null, null,
            request ?? throw new ArgumentNullException(nameof(request)))
    {
    }

    private ArticleCreateCommand(
        ArticleTemplateActor actor,
        Guid requestId,
        ArticleCreateMode mode,
        Guid? templateId,
        Guid? templateVersionId,
        ArticleTemplateExpansionPlan? plan,
        string? planDigest,
        ArticleInboxCreateRequest? inboxRequest)
    {
        ArticleTemplateContract.ValidateActor(actor);
        if (requestId == Guid.Empty || !Enum.IsDefined(mode))
        {
            throw new ArticleCreateValidationException("article_create_mode_invalid");
        }
        if (inboxRequest is not null && mode != ArticleCreateMode.Inbox)
        {
            throw new ArticleCreateValidationException("article_inbox_create_mode_mismatch");
        }

        bool completeTemplateSet = templateId.HasValue
            && templateVersionId.HasValue
            && plan is not null
            && !string.IsNullOrEmpty(planDigest);
        bool anyTemplateField = templateId.HasValue
            || templateVersionId.HasValue
            || plan is not null
            || planDigest is not null;
        switch (mode)
        {
            case ArticleCreateMode.Blank or ArticleCreateMode.Inbox when anyTemplateField:
                throw new ArticleCreateValidationException("article_create_mode_invalid");
            case ArticleCreateMode.Template when !completeTemplateSet:
                throw new ArticleCreateValidationException("article_create_mode_incomplete_template_set");
            case ArticleCreateMode.Template:
                if (templateId == Guid.Empty
                    || templateVersionId == Guid.Empty
                    || plan!.Input.TemplateId != templateId
                    || plan.VersionId != templateVersionId
                    || !string.Equals(plan.ContentDigest, planDigest, StringComparison.Ordinal))
                {
                    throw new ArticleCreateValidationException("article_create_plan_binding_invalid");
                }
                if (plan.Input.Actor.AdminPrincipalId != actor.AdminPrincipalId)
                {
                    throw new ArticleTemplateAccessDeniedException();
                }
                break;
        }

        Actor = actor;
        RequestId = requestId;
        Mode = mode;
        TemplateId = templateId;
        TemplateVersionId = templateVersionId;
        Plan = plan;
        PlanDigest = planDigest;
        InboxRequest = inboxRequest;
    }

    public ArticleTemplateActor Actor
    {
        get;
    }
    public Guid RequestId
    {
        get;
    }
    public ArticleCreateMode Mode
    {
        get;
    }
    public string ModeToken => Mode switch
    {
        ArticleCreateMode.Blank => "blank",
        ArticleCreateMode.Template => "template",
        ArticleCreateMode.Inbox => ArticleStatusValues.Token(ArticleStatusValues.Inbox),
        _ => throw new ArticleCreateValidationException("article_create_mode_invalid")
    };
    public Guid? TemplateId
    {
        get;
    }
    public Guid? TemplateVersionId
    {
        get;
    }
    public ArticleTemplateExpansionPlan? Plan
    {
        get;
    }
    public string? PlanDigest
    {
        get;
    }
    public ArticleInboxCreateRequest? InboxRequest
    {
        get;
    }
}

/// <summary>Durable receipt for one canonical create. It binds mode, template/plan refs,
/// new identities, digests, and audit/outbox coordinates — never article or template body.</summary>
public sealed record ArticleCreateReceipt(
    Guid ReceiptId,
    Guid RequestId,
    long OwnerAdminPrincipalId,
    string CreateMode,
    Guid? TemplateId,
    Guid? TemplateVersionId,
    int? TemplateVersionNumber,
    string? PlanDigest,
    int ArticleId,
    long DraftId,
    long DraftServerRevision,
    long RevisionId,
    int RevisionNo,
    string OutboxEventId,
    Guid AuditReference,
    string AuditDigest,
    string SourceDigest,
    string? DefaultsDigest,
    string? ReferenceDigest,
    string ContentDigest,
    DateTime OccurredAtUtc,
    bool IsIdempotentReplay = false,
    string InitialStatus = "draft");

public sealed record ArticleCreateVerificationSnapshot(
    ArticleCreateReceipt Receipt,
    int? ArticleId,
    int? ArticleStatus,
    long? ArticleCurrentRevisionId,
    DateTime? ArticlePublishedAt,
    long? DraftId,
    long? DraftServerRevision,
    string? DraftTitle,
    long? RevisionId,
    int? RevisionNo,
    long AssetReferenceCount,
    bool OutboxEventPresent,
    ArticleTemplateAuditLink? AuditLink,
    int? DraftStatus = null,
    int? DraftArticleId = null,
    long? DraftBaseRevisionId = null,
    long? DraftOwnerAdminPrincipalId = null,
    string? DraftKey = null);

public interface IArticleCreateStore
{
    Task<ArticleCreateReceipt> CreateInboxAsync(
        ArticleTemplateActor actor,
        Guid requestId,
        ArticleInboxCreateRequest request,
        CancellationToken cancellationToken = default);

    Task<ArticleCreateReceipt> CreateInboxAsync(
        ArticleTemplateActor actor,
        Guid requestId,
        CancellationToken cancellationToken = default);

    Task<ArticleCreateReceipt> CreateAsync(
        ArticleCreateCommand command,
        CancellationToken cancellationToken = default);

    Task<ArticleCreateVerificationResult> VerifyReceiptAsync(
        ArticleTemplateActor actor,
        Guid receiptId,
        CancellationToken cancellationToken = default);
}

public interface IArticleCreatePersistence
{
    /// <summary>
    /// Exact-once pre-resolution for one request id: replays the stored receipt when the
    /// request digest matches, throws <see cref="ArticleCreateConflictException"/> when a
    /// different request shape reuses the id, and returns null when the id is unseen. Runs
    /// before any plan verification so a network retry never re-executes or re-validates.
    /// </summary>
    Task<ArticleCreateReceipt?> ResolveRequestAsync(
        long ownerAdminPrincipalId,
        Guid requestId,
        string requestDigest,
        CancellationToken cancellationToken = default);

    Task<ArticleCreateReceipt> ExecuteAsync(
        ArticleCreateCommand command,
        ArticleCreatePayload payload,
        string requestDigest,
        CancellationToken cancellationToken = default);

    Task<ArticleCreateVerificationSnapshot?> ReadVerificationSnapshotAsync(
        Guid receiptId,
        CancellationToken cancellationToken = default);
}

/// <summary>Fully resolved field values the canonical writer persists for one create.</summary>
public sealed record ArticleCreatePayload(
    string Title,
    string? Summary,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    string MarkdownContent,
    IReadOnlyList<Guid> ExplicitAssetIds,
    string SourceDigest,
    string? DefaultsDigest,
    string? ReferenceDigest);

public sealed record ArticleCreateVerificationResult(
    bool Valid,
    IReadOnlyList<ArticleTemplateVerificationViolation> Violations);

public sealed class ArticleCreateValidationException(string code) : ArgumentException(code)
{
    public string Code { get; } = code;
}

public sealed class ArticleCreateConflictException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}

public sealed class ArticleCreateException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}
