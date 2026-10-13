using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Shared.Contracts.AuthorArticlePins;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Maps only the five original authenticated facade operations. It never reads persistence,
/// mutates order, issues a receipt, opens an article or establishes query/currentness authority.
/// </summary>
public sealed class AuthorArticlePinTransport(
    IAuthorArticlePinApplicationFacade facade,
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration)
{
    public async Task<AuthorArticlePinReadResponse> ReadAsync(
        AuthorArticlePinReadRequest request, CancellationToken cancellationToken)
    {
        if (!AuthorArticlePinTransportContract.IsValidReadRequest(request))
            throw new AuthorArticlePinValidationException("article_pin_transport_read_invalid");
        RequestBinding binding = BindRequest();
        cancellationToken.ThrowIfCancellationRequested();
        AuthorArticlePinProjectionPage page = await facade.ReadAsync(new(
            request.RequestId, request.Limit, request.Cursor, request.ExpectedCollectionRevision,
            request.ExpectedArticleProjectionDigest, request.ExpectedPermissionRevision,
            request.ExpectedSiteRevision, request.ExpectedSessionRevision), cancellationToken).ConfigureAwait(false);
        VerifyRequest(binding, cancellationToken);
        if (page.SchemaVersion != AuthorArticlePinProjectionContract.SchemaVersion
            || !Enum.IsDefined(page.Status) || page.Items.Count > request.Limit
            || page.FilteredCount is < 0 or > AuthorArticlePinContract.MaxPinsPerOwner
            || page.Items.Any(static item => item.Status == Entities.ArticleStatus.Deleted))
            throw new AuthorArticlePinTamperDetectedException("transport_page_invalid");
        AuthorArticlePinProjectionReceipt? receipt = page.Receipt;
        if (receipt is not null)
        {
            VerifyOwner(binding, receipt.Owner);
            if (receipt.RequestId != request.RequestId || receipt.Status != page.Status
                || receipt.CollectionRevision != page.CollectionRevision || receipt.PageCount != page.Items.Count
                || receipt.ResultCount != page.FilteredCount
                || !string.Equals(receipt.ResultContentDigest, page.ContentDigest, StringComparison.Ordinal)
                || !string.Equals(page.ContentDigest, AuthorArticlePinProjectionContract.ComputePageDigest(page), StringComparison.Ordinal)
                || !string.Equals(receipt.ContentDigest, AuthorArticlePinProjectionContract.ComputeReceiptDigest(receipt), StringComparison.Ordinal))
                throw new AuthorArticlePinTamperDetectedException("transport_page_receipt_mismatch");
        }
        else if (page.Status == AuthorArticlePinProjectionStatus.Current || page.Items.Count != 0 || page.FilteredCount != 0)
        {
            throw new AuthorArticlePinTamperDetectedException("transport_page_receipt_missing");
        }
        var mapped = new AuthorArticlePinPage(
            (int)page.Status, page.SchemaVersion, page.CollectionRevision, page.CollectionDigest,
            page.ArticleProjectionDigest, page.PermissionRevision, page.SiteRevision, page.SessionRevision,
            page.FilteredCount, [.. page.Items.Select(MapItem)], page.NextCursor, page.HasMore,
            [.. page.StaleReasons], page.CacheReference, page.ContentDigest, receipt is null ? null : MapReceipt(receipt));
        VerifyRequest(binding, cancellationToken);
        return new(AuthorArticlePinTransportContract.SchemaVersion, request.RequestId, mapped);
    }

    public async Task<AuthorArticlePinMutationReceipt> AddAsync(
        AuthorArticlePinMutationRequest request, CancellationToken cancellationToken)
    {
        ValidateMutation(request);
        RequestBinding binding = BindRequest();
        cancellationToken.ThrowIfCancellationRequested();
        AuthorArticlePinWriteReceipt receipt = await facade.AddAsync(
            request.ArticleId, request.ExpectedRevision, request.RequestId, cancellationToken).ConfigureAwait(false);
        return MapWriteReceipt(binding, request.RequestId, request.ExpectedRevision, "add", [request.ArticleId], null,
            receipt, cancellationToken);
    }

    public async Task<AuthorArticlePinMutationReceipt> RemoveAsync(
        AuthorArticlePinMutationRequest request, CancellationToken cancellationToken)
    {
        ValidateMutation(request);
        RequestBinding binding = BindRequest();
        cancellationToken.ThrowIfCancellationRequested();
        AuthorArticlePinWriteReceipt receipt = await facade.RemoveAsync(
            request.ArticleId, request.ExpectedRevision, request.RequestId, cancellationToken).ConfigureAwait(false);
        return MapWriteReceipt(binding, request.RequestId, request.ExpectedRevision, "remove", [request.ArticleId], null,
            receipt, cancellationToken);
    }

    public async Task<AuthorArticlePinMutationReceipt> ReorderAsync(
        AuthorArticlePinReorderRequest request, CancellationToken cancellationToken)
    {
        if (!AuthorArticlePinTransportContract.IsValidReorderRequest(request))
            throw new AuthorArticlePinValidationException("article_pin_transport_reorder_invalid");
        // Capture the actual bounded plan before awaiting; caller-owned list mutation cannot change custody.
        int[] articleIds = [.. request.ArticleIds.Take(AuthorArticlePinContract.MaxReorderBatchSize + 1)];
        AuthorArticlePinContract.ValidateReorder(articleIds, request.AfterArticleId);
        RequestBinding binding = BindRequest();
        cancellationToken.ThrowIfCancellationRequested();
        AuthorArticlePinWriteReceipt receipt = await facade.ReorderAsync(
            request.ExpectedRevision, request.RequestId, articleIds, request.AfterArticleId, cancellationToken).ConfigureAwait(false);
        return MapWriteReceipt(binding, request.RequestId, request.ExpectedRevision, "reorder", articleIds,
            request.AfterArticleId, receipt, cancellationToken);
    }

    public async Task<AuthorArticlePinOpenResponse> RevalidateOpenAsync(
        AuthorArticlePinOpenRequest request, CancellationToken cancellationToken)
    {
        if (!AuthorArticlePinTransportContract.IsValidOpenRequest(request))
            throw new AuthorArticlePinProjectionValidationException("article_pin_transport_open_invalid");
        RequestBinding binding = BindRequest();
        cancellationToken.ThrowIfCancellationRequested();
        AuthorArticlePinOpenValidationResult result = await facade.RevalidateOpenAsync(new(
            request.RequestId, request.ArticleId, request.CollectionRevision, request.ArticleVersionReference,
            request.RevisionVersionReference, request.PermissionRevision, request.PermissionReference,
            request.SiteRevision, request.SessionRevision), cancellationToken).ConfigureAwait(false);
        VerifyRequest(binding, cancellationToken);
        if (!Enum.IsDefined(result.Status))
            throw new AuthorArticlePinTamperDetectedException("transport_open_status_invalid");
        if (result.Status == AuthorArticlePinOpenValidationStatus.Current
            && (!string.Equals(result.ArticleVersionReference, request.ArticleVersionReference, StringComparison.Ordinal)
                || !string.Equals(result.RevisionVersionReference, request.RevisionVersionReference, StringComparison.Ordinal)
                || !string.Equals(result.PermissionRevision, request.PermissionRevision, StringComparison.Ordinal)
                || !string.Equals(result.SiteRevision, request.SiteRevision, StringComparison.Ordinal)
                || !string.Equals(result.SessionRevision, request.SessionRevision, StringComparison.Ordinal)))
            throw new AuthorArticlePinTamperDetectedException("transport_open_correlation_invalid");
        return new(AuthorArticlePinTransportContract.SchemaVersion, request.RequestId, request.ArticleId,
            (int)result.Status, result.ArticleVersionReference, result.RevisionVersionReference,
            result.PermissionRevision, result.SiteRevision, result.SessionRevision, result.ReasonCode);
    }

    private static void ValidateMutation(AuthorArticlePinMutationRequest request)
    {
        if (!AuthorArticlePinTransportContract.IsValidMutationRequest(request))
            throw new AuthorArticlePinValidationException("article_pin_transport_mutation_invalid");
    }

    private AuthorArticlePinMutationReceipt MapWriteReceipt(
        RequestBinding binding, Guid requestId, long expectedRevision, string commandKind,
        IReadOnlyList<int> articleIds, int? afterArticleId, AuthorArticlePinWriteReceipt receipt,
        CancellationToken cancellationToken)
    {
        VerifyRequest(binding, cancellationToken);
        VerifyOwner(binding, receipt.Owner);
        string digest = AuthorArticlePinContract.ComputeCommandDigest(
            commandKind, receipt.Owner, expectedRevision, articleIds, afterArticleId);
        if (receipt.ReceiptId == Guid.Empty || receipt.RequestId != requestId
            || receipt.PreviousRevision != expectedRevision || receipt.Revision < receipt.PreviousRevision
            || receipt.CommandKind != commandKind || receipt.Status is not ("applied" or "noop")
            || !receipt.ArticleIds.SequenceEqual(articleIds) || receipt.AfterArticleId != afterArticleId
            || receipt.ItemCount is < 0 or > AuthorArticlePinContract.MaxPinsPerOwner
            || !string.Equals(receipt.CommandDigest, digest, StringComparison.Ordinal))
            throw new AuthorArticlePinTamperDetectedException("transport_write_receipt_mismatch");
        return new(AuthorArticlePinTransportContract.SchemaVersion, receipt.ReceiptId,
            new(receipt.Owner.AdminPrincipalId, receipt.Owner.SiteScope), receipt.RequestId,
            receipt.PreviousRevision, receipt.Revision, receipt.CommandKind, receipt.Status, receipt.ReasonCode,
            [.. receipt.ArticleIds], receipt.AfterArticleId, receipt.ItemCount, receipt.Rebalanced, receipt.IdempotentReplay,
            receipt.CommandDigest, receipt.ContentDigest, receipt.CreatedAtUtc);
    }

    private static AuthorArticlePinItem MapItem(AuthorArticlePinProjectionItem item)
        => new(item.PinId, item.ArticleId, item.OrderReference, item.Title, (int)item.Status,
            item.CurrentRevisionId, item.RevisionNo, item.ArticleVersionReference,
            item.RevisionVersionReference, item.PermissionReference, item.OpenEligible, item.ContentDigest);

    private static AuthorArticlePinReadReceipt MapReceipt(AuthorArticlePinProjectionReceipt receipt)
        => new(receipt.ReceiptId, receipt.RequestId, new(receipt.Owner.AdminPrincipalId, receipt.Owner.SiteScope),
            receipt.CollectionRevision, receipt.CollectionDigest, receipt.ArticleProjectionDigest,
            receipt.PermissionRevision, receipt.SiteRevision, receipt.SessionRevision, (int)receipt.Status,
            receipt.ResultCount, receipt.PageCount, [.. receipt.ResultArticleIds], [.. receipt.ResultOrderReferences],
            [.. receipt.ResultArticleVersionReferences], [.. receipt.ResultPermissionReferences],
            [.. receipt.ResultStatuses.Select(static status => (int)status)], [.. receipt.ResultItemDigests],
            receipt.InputCursorDigest, receipt.NextCursorDigest, receipt.CacheReference,
            receipt.ResultContentDigest, receipt.CreatedAtUtc, receipt.ContentDigest);

    private RequestBinding BindRequest()
    {
        HttpContext? context = httpContextAccessor.HttpContext;
        ClaimsPrincipal? principal = context?.User;
        string? sessionId = principal.GetAdminSessionId();
        if (context is null || principal?.Identity?.IsAuthenticated != true || !principal.IsAdminPrincipal()
            || !principal.TryGetAdminPrincipalId(out long adminPrincipalId) || adminPrincipalId <= 0
            || string.IsNullOrWhiteSpace(sessionId) || !principal.HasAdminPermission(AdminPermissions.ArticleWrite))
            throw new AuthorArticlePinAccessDeniedException();
        string siteScope = SqlAuthorArticlePinPermissionAuthority.ResolveSiteScope(configuration);
        string[] permissions = principal.Claims.Where(static claim => claim.Type == AdminPermissions.PermissionClaimType)
            .Select(static claim => claim.Value).Where(principal.HasAdminPermission)
            .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        return new(context, principal, adminPrincipalId, sessionId, siteScope, permissions);
    }

    private void VerifyRequest(RequestBinding expected, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequestBinding actual = BindRequest();
        if (!ReferenceEquals(actual.Context, expected.Context) || !ReferenceEquals(actual.Principal, expected.Principal)
            || actual.AdminPrincipalId != expected.AdminPrincipalId || actual.SessionId != expected.SessionId
            || actual.SiteScope != expected.SiteScope || !actual.Permissions.SequenceEqual(expected.Permissions))
            throw new AuthorArticlePinAccessDeniedException();
    }

    private static void VerifyOwner(RequestBinding binding, AuthorArticlePinOwner owner)
    {
        if (owner.AdminPrincipalId != binding.AdminPrincipalId || owner.SiteScope != binding.SiteScope)
            throw new AuthorArticlePinTamperDetectedException("transport_response_owner_mismatch");
    }

    private sealed record RequestBinding(
        HttpContext Context, ClaimsPrincipal Principal, long AdminPrincipalId,
        string SessionId, string SiteScope, string[] Permissions);
}
