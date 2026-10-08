using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// Observed inputs to the production pure policies. Null article/thread snapshots
/// mean the owning lookup established absence, never that a lookup was skipped.
/// Evidence digests bind supplied facts to the request; they do not authenticate them.
/// Article and root IDs must come from their owners' actual identity bindings.
/// </summary>
public sealed record CommentScalePolicyFacts(
    int ArticleId,
    long? RootCommentId,
    AnonymousCommentPolicySnapshot SitePolicy,
    ArticleCommentPolicy? ArticlePolicy,
    CommentThreadPolicy? ThreadPolicy,
    CommentActor Actor,
    string ActorEvidenceDigest,
    RegionModerationDecision Region,
    string RegionEvidenceDigest,
    bool PublicSendExplicitlySelected,
    bool ModelEnabled,
    bool ModelProviderAvailable,
    int? ReplyTargetAuthorAccountId);

/// <summary>
/// Pure policy facts, not graph admission or rows. Base moderation excludes the
/// production article-premoderation override. Candidate recipient excludes the
/// transactional active-account check. Credential validity is preserved verbatim,
/// not verified. Slow mode, thread coordinates/visibility, content, privacy, proof,
/// nullifier, management capability, revision and outbox remain unresolved.
/// </summary>
public sealed record CommentScalePolicyResolution(
    DateTime CreatedAtUtc,
    CommentAuthorModeDecision AuthorMode,
    CommentPolicyWriteDecision? ArticleWrite,
    bool RegionCanPublish,
    CommentInitialModerationDecision? BaseInitialModerationDecision,
    int? CandidateReplyRecipientId,
    CommentScaleCredentialValidity CredentialValidity);

/// <summary>
/// Consumes the production pure policies for one structurally inspected request.
/// The caller must verify original artifacts and owner facts before this stage;
/// neither a matching digest nor the .NET temporal adapter proves provenance.
/// No database, service construction, private clock or graph generation occurs.
/// </summary>
public static class CommentScalePolicyResolver
{
    /// <summary>
    /// Resolves policy decisions at the exact supplied semantic role instant.
    /// Production refusals stop subsequent decisions; mismatched inputs fail closed.
    /// </summary>
    public static CommentScalePolicyResolution Resolve(
        CommentScaleCommentRequest request,
        CommentScalePolicyFacts facts,
        CommentScaleArtifactReference temporalArtifact,
        ResolvedTemporalRoleContext temporal)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(facts);
        ArgumentNullException.ThrowIfNull(temporalArtifact);
        ArgumentNullException.ThrowIfNull(temporal);
        ArgumentNullException.ThrowIfNull(facts.SitePolicy);
        ArgumentNullException.ThrowIfNull(facts.Actor);
        ArgumentNullException.ThrowIfNull(facts.Region);

        if (!CommentScalePlanContract.IsRole(request.Role)
            || !CommentScalePlanContract.IsRole(request.CreatedAtRole)
            || string.IsNullOrWhiteSpace(request.ActorMode)
            || !Enum.IsDefined(request.CredentialValidity)
            || (request.ActorMode == CommentAuthorModes.Public
                && request.CredentialValidity != CommentScaleCredentialValidity.PublicAuthenticated)
            || (request.ActorMode == CommentAuthorModes.ZkAnonymous
                && request.CredentialValidity == CommentScaleCredentialValidity.PublicAuthenticated)
            || ((request.ParentRole is null) != (request.ReplyTargetRole is null))
            || (request.ParentRole is not null
                && (!CommentScalePlanContract.IsRole(request.ParentRole) || request.ParentRole == request.Role))
            || (request.ReplyTargetRole is not null
                && (!CommentScalePlanContract.IsRole(request.ReplyTargetRole) || request.ReplyTargetRole == request.Role)))
        {
            throw new InvalidOperationException("Comment policy request contains invalid consumed fields.");
        }

        if (temporalArtifact.Schema != "fsusblog.resolved-temporal-roles.v1"
            || temporalArtifact.ContentDigest != temporal.ContentDigest
            || !CommentScalePlanContract.IsDigest(request.ActorEvidenceDigest)
            || request.ActorEvidenceDigest != facts.ActorEvidenceDigest
            || !CommentScalePlanContract.IsDigest(request.RegionEvidenceDigest)
            || request.RegionEvidenceDigest != facts.RegionEvidenceDigest)
        {
            throw new InvalidOperationException("Comment policy fact or temporal ingress binding does not match the request.");
        }

        if (facts.ArticleId <= 0
            || facts.RootCommentId is <= 0
            || (facts.ArticlePolicy is not null && facts.ArticlePolicy.ArticleId != facts.ArticleId)
            || (facts.ThreadPolicy is not null
                && (facts.ThreadPolicy.ArticleId != facts.ArticleId
                    || facts.ThreadPolicy.RootCommentId != facts.RootCommentId))
            || (request.ParentRole is null && facts.RootCommentId is not null)
            || (request.ParentRole is not null && facts.RootCommentId is null)
            || (request.ReplyTargetRole is null && facts.ReplyTargetAuthorAccountId is not null))
        {
            throw new InvalidOperationException("Comment policy snapshots do not match the supplied article/thread binding.");
        }

        DateTime createdAtUtc = temporal.RequireInstant(request.CreatedAtRole).UtcDateTime;
        CommentAuthorModeDecision authorMode = AnonymousCommentPolicyService.EvaluateAuthorMode(
            facts.SitePolicy, request.ActorMode, facts.PublicSendExplicitlySelected);
        CommentPolicyWriteDecision? articleWrite = null;
        CommentInitialModerationDecision? baseModeration = null;
        int? recipient = null;
        if (authorMode.Allowed)
        {
            if (authorMode.EffectiveAuthorMode != facts.Actor.AuthorMode)
            {
                throw new InvalidOperationException("Resolved actor does not match the production author-mode decision.");
            }

            EffectiveArticleCommentPolicy policy = ArticleCommentPolicyService.Compose(
                facts.ArticleId, facts.SitePolicy, facts.ArticlePolicy, facts.ThreadPolicy);
            articleWrite = ArticleCommentPolicyService.EvaluateWrite(
                policy, authorMode.EffectiveAuthorMode, createdAtUtc);
            if (articleWrite.Allowed && facts.Region.CanPublish)
            {
                baseModeration = CommentModerationService.ResolveInitialState(
                    facts.Actor, facts.Region, facts.ModelEnabled, facts.ModelProviderAvailable);
                if (request.ReplyTargetRole is not null)
                {
                    recipient = CommentCommandService.ResolveReplyRecipientId(
                        facts.ReplyTargetAuthorAccountId, facts.Actor.UserId);
                }
            }
        }

        return new CommentScalePolicyResolution(
            createdAtUtc, authorMode, articleWrite, facts.Region.CanPublish,
            baseModeration, recipient, request.CredentialValidity);
    }
}
