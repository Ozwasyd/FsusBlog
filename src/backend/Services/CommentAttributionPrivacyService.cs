using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Services;

public interface ICommentAttributionPrivacyService
{
    bool CanEnforceAnonymousNullifier
    {
        get;
    }

    Task<CommentActor?> ResolvePublicActorAsync(
        int userId,
        CommentDto request,
        string normalizedContent,
        string? submitRegion,
        CancellationToken cancellationToken);

    Task<AnonymousCommentTicketPayload?> ReadStrongAnonymousTicketAsync(
        AnonymousCommentCreateRequestCoreModel request,
        string normalizedContent,
        CancellationToken cancellationToken);

    Task FinalizeStrongAnonymousTicketAsync(
        AnonymousCommentCreateRequestCoreModel request,
        CancellationToken cancellationToken);

    Task<CommentActor?> ResolveStrongAnonymousActorAsync(
        AnonymousCommentTicketPayload ticket,
        AnonymousCommentCreateRequestCoreModel request,
        string? submitRegion,
        CancellationToken cancellationToken);

    bool RequiresAnonymousNullifierEnforcement(CommentActor actor);

    string HashAnonymousScopeForLog(string? scope);

    Task<NullifierReservationResult> ConsumeAnonymousNullifierAsync(
        CommentActor actor,
        long commentId,
        CancellationToken cancellationToken);

    ValueTask RecordNullifierAbuseRiskSignalAsync(
        string? scope,
        string status,
        CancellationToken cancellationToken);
}

public sealed class CommentAttributionPrivacyService(
    ILogger<CommentAttributionPrivacyService> logger,
    ICommentActorResolver? actors = null,
    IAnonymousCommentPolicyService? policy = null,
    ICommentAnonymousNullifierService? nullifiers = null,
    ISecurityRiskSignalSink? riskSignals = null,
    IHttpContextAccessor? httpContextAccessor = null,
    IAnonymousCommentTicketService? tickets = null,
    ICommentAnonymousDisplayNameGenerator? displayNames = null,
    IConfiguration? configuration = null,
    IZkAnonymousProofService? zkProofs = null) : ICommentAttributionPrivacyService
{
    public bool CanEnforceAnonymousNullifier => nullifiers is not null;

    public async Task<CommentActor?> ResolvePublicActorAsync(
        int userId,
        CommentDto request,
        string normalizedContent,
        string? submitRegion,
        CancellationToken cancellationToken)
    {
        AnonymousCommentPolicySnapshot snapshot = await ResolvePolicyAsync(cancellationToken);
        if (!IsContentWithinLimit(normalizedContent, snapshot) || actors is null)
        {
            return null;
        }

        CommentActorResolveResult result = await actors.ResolveAsync(
            new CommentActorResolveRequest(
                UserId: userId > 0 ? userId : null,
                ArticleId: request.ArticleId,
                AuthorMode: request.AuthorMode,
                PublicSendExplicitlySelected: request.PublicSendExplicitlySelected,
                AnonymousScope: request.AnonymousScope,
                DisplayLanguage: request.DisplayLanguage,
                ProofToken: request.ProofToken,
                ZkProof: request.ZkProof,
                SubmitRegion: submitRegion),
            cancellationToken);
        return result.Allowed ? result.Actor : null;
    }

    public async Task<AnonymousCommentTicketPayload?> ReadStrongAnonymousTicketAsync(
        AnonymousCommentCreateRequestCoreModel request,
        string normalizedContent,
        CancellationToken cancellationToken)
    {
        if (policy is null || zkProofs is null || !IsZkSubmissionReady(zkProofs.CurrentZkCommentPolicy))
        {
            return null;
        }

        AnonymousCommentPolicySnapshot snapshot = await policy.GetCurrentAsync(cancellationToken);
        if (!snapshot.AnonymousCommentsEnabled
            || !snapshot.ZkAnonymousEnabled
            || !IsContentWithinLimit(normalizedContent, snapshot))
        {
            return null;
        }

        if (tickets is null)
        {
            logger.LogWarning("匿名评论 ticket service 未注册，拒绝匿名评论写入 | Article: {ArticleId}", request.ArticleId);
            return null;
        }

        CacheReadResult<AnonymousCommentTicketPayload> consumed = await tickets.ReadTicketAsync(
            request.Ticket,
            cancellationToken);
        if (!consumed.Hit || consumed.Value is null || !TicketMatchesRequest(consumed.Value, request))
        {
            if (consumed.Hit && consumed.Value is not null)
            {
                logger.LogInformation(
                    "匿名评论 ticket 绑定校验失败 | Article: {ArticleId} | ScopeHash: {ScopeHash}",
                    request.ArticleId,
                    HashScopeForLog(NormalizeScope(request.AnonymousScope)));
            }

            return null;
        }

        return consumed.Value;
    }

    public async Task FinalizeStrongAnonymousTicketAsync(
        AnonymousCommentCreateRequestCoreModel request,
        CancellationToken cancellationToken)
    {
        if (tickets is null)
        {
            return;
        }

        await tickets.ConsumeTicketAsync(request.Ticket, cancellationToken);
    }

    public async Task<CommentActor?> ResolveStrongAnonymousActorAsync(
        AnonymousCommentTicketPayload ticket,
        AnonymousCommentCreateRequestCoreModel request,
        string? submitRegion,
        CancellationToken cancellationToken)
    {
        if (policy is null || zkProofs is null)
        {
            return null;
        }

        AnonymousCommentPolicySnapshot current = await policy.GetCurrentAsync(cancellationToken);
        if (!current.AnonymousCommentsEnabled
            || !current.ZkAnonymousEnabled
            || !IsZkSubmissionReady(zkProofs.CurrentZkCommentPolicy))
        {
            return null;
        }

        string language = CommentAnonymousDisplayNameGenerator.NormalizeDisplayLanguage(
            request.DisplayLanguage,
            submitRegion);
        ICommentAnonymousDisplayNameGenerator generator = displayNames ?? new CommentAnonymousDisplayNameGenerator();
        CommentAnonymousDisplayName display = generator.Generate(new CommentAnonymousDisplayNameRequest(
            language,
            ticket.Scope,
            ticket.NullifierHash));
        return new CommentActor(
            UserId: null,
            AuthorMode: CommentAuthorModes.ZkAnonymous,
            PublicHandle: null,
            AnonymousHandle: $"anon-{ticket.NullifierHash[..Math.Min(ticket.NullifierHash.Length, 12)]}",
            DisplayName: display.DisplayName,
            DisplayLanguage: display.DisplayLanguage,
            AnonymousNullifierHash: ticket.NullifierHash,
            AnonymousScope: ticket.Scope,
            ModerationSubjectHash: Convert.ToHexStringLower(AnonymousCommentTicketService.CreateModerationSubjectHash(
                ticket.NullifierHash,
                configuration ?? throw new InvalidOperationException("Moderation:Pepper must be configured."))),
            RateClass: ticket.RateClass,
            RequiresModeration: ticket.RequiresModeration);
    }

    public bool RequiresAnonymousNullifierEnforcement(CommentActor actor)
        => !string.IsNullOrWhiteSpace(actor.AnonymousNullifierHash)
            && !string.IsNullOrWhiteSpace(actor.AnonymousScope)
            && string.Equals(actor.AuthorMode, CommentAuthorModes.ZkAnonymous, StringComparison.Ordinal);

    public string HashAnonymousScopeForLog(string? scope) => HashScopeForLog(scope);

    public Task<NullifierReservationResult> ConsumeAnonymousNullifierAsync(
        CommentActor actor,
        long commentId,
        CancellationToken cancellationToken)
        => (nullifiers ?? throw new InvalidOperationException("Anonymous nullifier enforcement is not registered."))
            .TryConsumeAsync(actor.AnonymousNullifierHash!, actor.AnonymousScope!, commentId, cancellationToken);

    public async ValueTask RecordNullifierAbuseRiskSignalAsync(
        string? scope,
        string status,
        CancellationToken cancellationToken)
    {
        if (riskSignals is null || httpContextAccessor?.HttpContext is not { } httpContext)
        {
            return;
        }

        await riskSignals.AddRiskAsync(new SecurityRiskSignal(
            httpContext,
            SecurityRiskReason.CommentNullifierAbuse,
            25,
            TimeSpan.FromMinutes(30),
            SecurityRiskSources.RiskControl,
            ResolveRiskAction(httpContext),
            $"nullifier:{TextHelpers.NormalizeNullable(status, 64) ?? "rejected"};scope:{TextHelpers.NormalizeNullable(scope, 64) ?? "unknown"}"), cancellationToken);
    }

    private async Task<AnonymousCommentPolicySnapshot> ResolvePolicyAsync(CancellationToken cancellationToken)
        => policy is null
            ? AnonymousCommentPolicySnapshot.Default
            : await policy.GetCurrentAsync(cancellationToken);

    private static bool IsContentWithinLimit(string content, AnonymousCommentPolicySnapshot policySnapshot)
        => !string.IsNullOrWhiteSpace(content)
            && content.Length <= policySnapshot.CommentMaxChars
            && Encoding.UTF8.GetByteCount(content) <= policySnapshot.CommentMaxUtf8Bytes;

    private static bool IsZkSubmissionReady(ZkCommentPolicySnapshot policySnapshot)
        => policySnapshot.Enabled
            && policySnapshot.NativeVerifierConfigured
            && policySnapshot.TrustedSetupVerified
            && policySnapshot.CredentialRequired
            && policySnapshot.CredentialRootReady
            && string.IsNullOrWhiteSpace(policySnapshot.UnavailableReason);

    private static bool TicketMatchesRequest(
        AnonymousCommentTicketPayload ticket,
        AnonymousCommentCreateRequestCoreModel request)
    {
        if (!TryParseOptionalPositiveCommentId(request.ParentId, out long? parentId)
            || !TryParseOptionalPositiveCommentId(request.RootId, out long? rootId)
            || !TryParseOptionalPositiveCommentId(request.ReplyToCommentId, out long? replyToCommentId))
        {
            return false;
        }

        string scope = NormalizeScope(request.AnonymousScope);
        if (ticket.ArticleId != request.ArticleId
            || ticket.ExpiresAtUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            || !string.Equals(ticket.Scope, scope, StringComparison.Ordinal)
            || !AnonymousCommentScopePolicy.TryParse(scope, out AnonymousCommentScopeDescriptor descriptor)
            || descriptor.ArticleId != request.ArticleId)
        {
            return false;
        }

        return descriptor.Kind switch
        {
            AnonymousCommentScopeKind.TopLevel =>
                ticket.ParentId is null && ticket.RootId is null && ticket.ReplyToCommentId is null &&
                parentId is null && rootId is null && replyToCommentId is null,
            AnonymousCommentScopeKind.ThreadReply =>
                ticket.ParentId is null && ticket.ReplyToCommentId is null &&
                ticket.RootId == descriptor.RootId &&
                parentId is > 0 && rootId == descriptor.RootId && replyToCommentId == parentId,
            _ => false
        };
    }

    private static bool TryParseOptionalPositiveCommentId(string? raw, out long? value)
    {
        value = null;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return true;
        }

        if (long.TryParse(raw, out long parsed) && parsed > 0)
        {
            value = parsed;
            return true;
        }

        return false;
    }

    private static string NormalizeScope(string? value)
        => TextHelpers.TrimOrEmpty(value);

    private static string HashScopeForLog(string? scope)
    {
        string normalized = TextHelpers.TrimOrNull(scope) ?? "unknown";
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)))[..16];
    }

    private static string ResolveRiskAction(HttpContext httpContext)
        => httpContext.Items[RiskActionEndpointMetadata.HttpContextItemKey] is RiskActionEndpointMetadata metadata
            ? metadata.ActionName
            : RiskActionNames.CommentCreate;
}
