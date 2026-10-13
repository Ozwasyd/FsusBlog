using System.Text;

using FsusBlog.Server.Infrastructure.Auth;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// The single canonical create entry point. Blank creates never consult defaults, recent
/// state, or any recommendation; template creates consume only a currently verified #2363
/// plan and re-verify it against live authorities before any write occurs.
/// </summary>
public sealed class ArticleCreateStore(
    IArticleCreatePersistence persistence,
    IArticleTemplateExpansionVerifier expansionVerifier) : IArticleCreateStore
{
    public Task<ArticleCreateReceipt> CreateInboxAsync(
        ArticleTemplateActor actor,
        Guid requestId,
        ArticleInboxCreateRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        return CreateAsync(new ArticleCreateCommand(actor, requestId, request), cancellationToken);
    }

    public Task<ArticleCreateReceipt> CreateInboxAsync(
        ArticleTemplateActor actor,
        Guid requestId,
        CancellationToken cancellationToken = default)
        => CreateAsync(new ArticleCreateCommand(actor, requestId, ArticleCreateMode.Inbox), cancellationToken);

    public async Task<ArticleCreateReceipt> CreateAsync(
        ArticleCreateCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        cancellationToken.ThrowIfCancellationRequested();
        RequireArticleWrite(command.Actor);

        // After current authorization, a replayed or conflicting request id resolves before any plan
        // verification, so retries stay exact even after the original plan expires.
        string requestDigest = ComputeRequestDigest(command);
        ArticleCreateReceipt? replayed = await persistence
            .ResolveRequestAsync(
                command.Actor.AdminPrincipalId, command.RequestId, requestDigest, cancellationToken)
            .ConfigureAwait(false);
        if (replayed is not null)
        {
            return replayed;
        }

        ArticleCreatePayload payload = command.Mode switch
        {
            ArticleCreateMode.Inbox when command.InboxRequest is not null => new ArticleCreatePayload(
                Title: command.InboxRequest.Title,
                Summary: null,
                CategoryId: 0,
                TagIds: Array.Empty<int>(),
                MarkdownContent: command.InboxRequest.MarkdownContent,
                ExplicitAssetIds: Array.Empty<Guid>(),
                SourceDigest: ArticleTemplateExpansionPlanner.ComputeSha256(
                    Encoding.UTF8.GetBytes(command.InboxRequest.MarkdownContent)),
                DefaultsDigest: null,
                ReferenceDigest: null),
            ArticleCreateMode.Blank or ArticleCreateMode.Inbox => new ArticleCreatePayload(
                Title: string.Empty,
                Summary: null,
                CategoryId: 0,
                TagIds: Array.Empty<int>(),
                MarkdownContent: string.Empty,
                ExplicitAssetIds: Array.Empty<Guid>(),
                SourceDigest: ArticleTemplateExpansionPlanner.ComputeSha256([]),
                DefaultsDigest: null,
                ReferenceDigest: null),
            ArticleCreateMode.Template => await ResolveTemplatePayloadAsync(command, cancellationToken)
                .ConfigureAwait(false),
            _ => throw new ArticleCreateValidationException("article_create_mode_invalid")
        };

        return await persistence.ExecuteAsync(command, payload, requestDigest, cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task<ArticleCreateVerificationResult> VerifyReceiptAsync(
        ArticleTemplateActor actor,
        Guid receiptId,
        CancellationToken cancellationToken = default)
    {
        RequireArticleWrite(actor);
        cancellationToken.ThrowIfCancellationRequested();
        ArticleCreateVerificationSnapshot? snapshot = await persistence
            .ReadVerificationSnapshotAsync(receiptId, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (snapshot is null || snapshot.Receipt.OwnerAdminPrincipalId != actor.AdminPrincipalId)
        {
            return new ArticleCreateVerificationResult(false, [new("receipt_missing", "no durable receipt")]);
        }
        return ArticleCreateVerifier.Verify(snapshot);
    }

    private static void RequireArticleWrite(ArticleTemplateActor actor)
    {
        ArticleTemplateContract.ValidateActor(actor);
        if (!actor.Permissions.Contains(AdminPermissions.ArticleWrite))
        {
            throw new ArticleTemplateAccessDeniedException();
        }
    }

    private async Task<ArticleCreatePayload> ResolveTemplatePayloadAsync(
        ArticleCreateCommand command,
        CancellationToken cancellationToken)
    {
        ArticleTemplateExpansionPlan plan = command.Plan!;
        ArticleTemplateVerificationResult verified = await expansionVerifier
            .VerifyAsync(plan, cancellationToken)
            .ConfigureAwait(false);
        if (!verified.Valid)
        {
            throw new ArticleCreateException(
                $"article_create_plan_stale:{verified.Violations.FirstOrDefault()?.Code ?? "unknown"}");
        }

        ArticleTemplateDefaults defaults = plan.Defaults;
        // Reference verification does not provide a transaction receiver. These defaults
        // must remain rejected until the canonical create aggregate can actually persist them.
        if (defaults.PropertyDefaults.Count > 0
            || defaults.RightsProfile is not null
            || defaults.ResponsibilityProfile is not null
            || defaults.PrepublishProfile is not null)
        {
            throw new ArticleCreateValidationException("article_create_defaults_receiver_unavailable");
        }
        string markdown = Encoding.UTF8.GetString(plan.ExpandedSource);
        return new ArticleCreatePayload(
            Title: plan.Input.Title ?? defaults.TitlePlaceholder ?? string.Empty,
            Summary: defaults.SummaryPlaceholder,
            CategoryId: defaults.CategoryId ?? 0,
            TagIds: defaults.TagIds,
            MarkdownContent: markdown,
            ExplicitAssetIds: [.. defaults.AssetIds.Select(static asset => asset.Value)],
            SourceDigest: plan.ExpandedSourceDigest,
            DefaultsDigest: plan.DefaultsDigest,
            ReferenceDigest: plan.ContentDigest);
    }

    internal static string ComputeRequestDigest(ArticleCreateCommand command)
    {
        var values = new List<object?>
        {
            (int)command.Mode,
            command.Actor.AdminPrincipalId,
            command.RequestId
        };
        if (command.Mode == ArticleCreateMode.Template)
        {
            values.Add(command.TemplateId);
            values.Add(command.TemplateVersionId);
            values.Add(command.PlanDigest);
        }
        if (command.InboxRequest is not null)
        {
            values.Add("article-inbox-create-input");
            values.Add(command.InboxRequest.SchemaVersion);
            values.Add(command.InboxRequest.ContentDigest);
        }
        return ArticleTemplateContract.ComputeCommandDigest([.. values]);
    }
}
