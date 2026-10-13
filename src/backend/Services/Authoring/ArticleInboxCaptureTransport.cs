using FsusBlog.Contracts.ArticleCapture;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Capture-only authenticated adapter over the original create/lookup store. The original
/// live principal/session/site reader admits the request; receipt facts remain historical.
/// This adapter does not add historical site persistence or qualify a public rollout.
/// </summary>
public sealed class ArticleInboxCaptureTransport(
    IArticleCreateStore store,
    SqlAuthorRecentArticleHistoryPermissionAuthority permission,
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration)
{
    public Task<ArticleInboxCaptureResponse> CreateAsync(ArticleInboxCaptureRequest request,
        CancellationToken cancellationToken = default)
        => ExecuteAsync(request, reconcileOnly: false, cancellationToken);

    public Task<ArticleInboxCaptureResponse> ReconcileAsync(ArticleInboxCaptureRequest request,
        CancellationToken cancellationToken = default)
        => ExecuteAsync(request, reconcileOnly: true, cancellationToken);

    private async Task<ArticleInboxCaptureResponse> ExecuteAsync(ArticleInboxCaptureRequest request,
        bool reconcileOnly, CancellationToken cancellationToken)
    {
        if (!ArticleInboxCaptureContract.IsValidRequest(request))
        {
            throw new ArticleCreateValidationException("article_inbox_capture_request_invalid");
        }
        cancellationToken.ThrowIfCancellationRequested();
        AuthorRecentArticleHistoryOwner owner = ResolveOwner(request.ExpectedSiteScope);
        string session = httpContextAccessor.HttpContext!.User.GetAdminSessionId()!;
        AuthorRecentArticleHistoryPermissionSnapshot before = await AdmitAsync(owner, request.RequestId,
            cancellationToken).ConfigureAwait(false);
        var input = new ArticleInboxCreateRequest(request.SchemaVersion, request.Title, request.MarkdownContent);
        // This permission bit is projected only after the actual live authority validated it.
        var actor = new ArticleTemplateActor(owner.AdminPrincipalId, [AdminPermissions.ArticleWrite]);
        if (ResolveOwner(request.ExpectedSiteScope) != owner
            || httpContextAccessor.HttpContext!.User.GetAdminSessionId() != session)
        {
            throw new ArticleTemplateAccessDeniedException();
        }
        ArticleCreateReceipt? receipt = reconcileOnly
            ? await store.ReconcileInboxAsync(actor, request.RequestId, input, cancellationToken).ConfigureAwait(false)
            : await store.CreateInboxAsync(actor, request.RequestId, input, cancellationToken).ConfigureAwait(false);
        AuthorRecentArticleHistoryPermissionSnapshot after = await AdmitAsync(owner, request.RequestId,
            cancellationToken).ConfigureAwait(false);
        if (after.ContentDigest != before.ContentDigest || ResolveOwner(request.ExpectedSiteScope) != owner
            || httpContextAccessor.HttpContext!.User.GetAdminSessionId() != session)
        {
            // A create may have committed already. Never translate this refusal to zero writes.
            throw new ArticleTemplateAccessDeniedException();
        }
        cancellationToken.ThrowIfCancellationRequested();
        ArticleInboxCaptureReceipt? result = receipt is null ? null : MapReceipt(receipt, owner, request.RequestId);
        var response = new ArticleInboxCaptureResponse(ArticleInboxCaptureContract.SchemaVersion,
            request.RequestId, owner.AdminPrincipalId, owner.SiteScope, result);
        if (!ArticleInboxCaptureContract.MatchesRequest(request, response) || !reconcileOnly && result is null)
        {
            throw new ArticleCreateException("article_inbox_capture_response_binding_invalid");
        }
        return response;
    }

    private AuthorRecentArticleHistoryOwner ResolveOwner(string expectedSite)
    {
        HttpContext? context = httpContextAccessor.HttpContext;
        if (context?.User.Identity?.IsAuthenticated != true || !context.User.IsAdminPrincipal()
            || !context.User.TryGetAdminPrincipalId(out long id) || id <= 0
            || string.IsNullOrWhiteSpace(context.User.GetAdminSessionId())
            || !context.User.HasAdminPermission(AdminPermissions.ArticleWrite))
        {
            throw new ArticleTemplateAccessDeniedException();
        }
        string site = SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration);
        if (!string.Equals(site, expectedSite, StringComparison.Ordinal))
        {
            throw new ArticleTemplateAccessDeniedException();
        }
        var owner = new AuthorRecentArticleHistoryOwner(id, site);
        AuthorRecentArticleHistoryContract.ValidateOwner(owner);
        return owner;
    }

    private async Task<AuthorRecentArticleHistoryPermissionSnapshot> AdmitAsync(
        AuthorRecentArticleHistoryOwner owner, Guid requestId, CancellationToken cancellationToken)
    {
        AuthorRecentArticleHistoryPermissionSnapshot snapshot = await permission.ResolveAsync(
            new(owner, requestId, []), cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (snapshot.Status != AuthorRecentArticleHistoryPermissionSnapshotStatus.Current
            || snapshot.Owner != owner || snapshot.Decisions.Count != 0
            || snapshot.ContentDigest != AuthorRecentArticleHistoryContract.ComputePermissionDigest(snapshot))
        {
            throw new ArticleTemplateAccessDeniedException();
        }
        return snapshot;
    }

    private static ArticleInboxCaptureReceipt MapReceipt(ArticleCreateReceipt receipt,
        AuthorRecentArticleHistoryOwner owner, Guid requestId)
    {
        if (receipt.OwnerAdminPrincipalId != owner.AdminPrincipalId || receipt.RequestId != requestId
            || receipt.CreateMode != "inbox" || receipt.InitialStatus != "inbox"
            || receipt.TemplateId is not null || receipt.TemplateVersionId is not null
            || receipt.TemplateVersionNumber is not null || receipt.PlanDigest is not null
            || receipt.DefaultsDigest is not null || receipt.ReferenceDigest is not null
            || receipt.OccurredAtUtc.Kind != DateTimeKind.Utc)
        {
            throw new ArticleCreateException("article_inbox_capture_receipt_binding_invalid");
        }
        var result = new ArticleInboxCaptureReceipt(receipt.ReceiptId, receipt.RequestId,
            receipt.OwnerAdminPrincipalId, receipt.ArticleId, receipt.DraftId, receipt.DraftServerRevision,
            receipt.RevisionId, receipt.RevisionNo, receipt.OutboxEventId, receipt.AuditReference,
            receipt.AuditDigest, receipt.SourceDigest, receipt.ContentDigest, receipt.OccurredAtUtc.Ticks,
            receipt.IsIdempotentReplay);
        if (!ArticleInboxCaptureContract.IsValidReceipt(result))
        {
            throw new ArticleCreateException("article_inbox_capture_receipt_shape_invalid");
        }
        return result;
    }
}
