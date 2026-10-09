using System.Globalization;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Services.ArticleVault;

/// <summary>
/// Associates the original reader with authenticated host context and exact stored document identities.
/// Current inputs must come from the trusted in-process acquisition owner, never an HTTP request body.
/// This adapter defines no transport, input provider, planner, writer or execution admission.
/// </summary>
public sealed class ArticleVaultAuthenticatedConflictReviewAdapter(
    IArticleVaultResolutionProposalStore proposals,
    ArticleVaultConflictReviewReader reader,
    string trustedVaultSiteIdentity)
{
    /// <summary>
    /// Prepares the canonical request handoff without registering an endpoint or response wire.
    /// Request fields name exact references; the caller separately supplies trusted current inputs.
    /// </summary>
    public Task<ArticleVaultConflictReviewSnapshot> ReadCurrentRequestFromHttpContextAsync(
        ArticleVaultCurrentReviewRequest request,
        HttpContext context,
        ArticleVaultResolutionPlanInput current,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        if (!ArticleVaultCurrentReviewWireContract.IsValid(request))
        {
            throw Rejected("article_vault_current_review_request_invalid");
        }
        ArticleVaultConflictReviewCheckpointReference? checkpoint = request.Checkpoint is { } exact
            ? new(exact.Operation, exact.Sequence, exact.ContentSha256)
            : null;
        var reference = new ArticleVaultConflictReviewReference(
            request.ResolutionOperationIdentity, request.ProposalSha256, checkpoint);
        return ReadFromHttpContextAsync(reference, request.ArticleId, context, current, cancellationToken);
    }

    /// <summary>Uses the original endpoint's admin-session claim mapping, never request DTO identity fields.</summary>
    public Task<ArticleVaultConflictReviewSnapshot> ReadFromHttpContextAsync(
        ArticleVaultConflictReviewReference reference,
        int articleId,
        HttpContext context,
        ArticleVaultResolutionPlanInput current,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        EndpointUserContext authenticated = EndpointUserContext.From(context) with
        {
            SessionId = context.User.GetAdminSessionId()
        };
        return ReadAsync(reference, articleId, authenticated, current, cancellationToken);
    }

    public async Task<ArticleVaultConflictReviewSnapshot> ReadAsync(
        ArticleVaultConflictReviewReference reference,
        int articleId,
        EndpointUserContext authenticated,
        ArticleVaultResolutionPlanInput current,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(current);
        cancellationToken.ThrowIfCancellationRequested();
        if (!authenticated.IsAuthenticated || !authenticated.IsAdminPrincipal
            || authenticated.AdminPrincipalId <= 0 || string.IsNullOrWhiteSpace(authenticated.SessionId))
        {
            throw Rejected("article_vault_conflict_review_authentication_required");
        }
        if (articleId <= 0 || string.IsNullOrWhiteSpace(trustedVaultSiteIdentity))
        {
            throw Rejected("article_vault_conflict_review_host_scope_unavailable");
        }
        ArticleVaultResolutionPlan proposal = await proposals.ReadExactAsync(reference.ResolutionOperationIdentity,
            reference.ProposalSha256, cancellationToken).ConfigureAwait(false)
            ?? throw Rejected("article_vault_conflict_review_proposal_missing");
        ArticleVaultOperationVerifier.Require(ArticleVaultResolutionPlanner.ValidateStructure(proposal));
        if (proposal.ResolutionOperationIdentity != reference.ResolutionOperationIdentity
            || proposal.ContentSha256 != reference.ProposalSha256
            || proposal.Binding.SiteIdentity != trustedVaultSiteIdentity
            || proposal.Binding.ServerArticleIdentity != articleId.ToString(CultureInfo.InvariantCulture))
        {
            throw Rejected("article_vault_conflict_review_document_mismatch");
        }
        // Vault/device/portable identities are read from the exact canonical proposal, not supplied by a route.
        // The reader still performs current live permission checks and original sealed-bundle actor validation.
        var document = new ArticleVaultConflictReviewContext(authenticated.AdminPrincipalId,
            trustedVaultSiteIdentity, proposal.Binding.VaultIdentity, proposal.Binding.DeviceIdentity,
            articleId, proposal.Binding.PortableArticleIdentity);
        return await reader.ReadAsync(reference, document, current, cancellationToken).ConfigureAwait(false);
    }

    private static ArticleVaultExecutionRejectedException Rejected(string reason) => new(reason);
}
