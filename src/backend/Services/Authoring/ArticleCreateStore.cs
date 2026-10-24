using System.Text;

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
    public async Task<ArticleCreateReceipt> CreateAsync(
        ArticleCreateCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        cancellationToken.ThrowIfCancellationRequested();

        // Exact-once first: a replayed or conflicting request id resolves before any plan
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
            ArticleCreateMode.Blank => new ArticleCreatePayload(
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
        ArticleTemplateContract.ValidateActor(actor);
        ArticleCreateVerificationSnapshot? snapshot = await persistence
            .ReadVerificationSnapshotAsync(receiptId, cancellationToken)
            .ConfigureAwait(false);
        if (snapshot is null)
        {
            return new ArticleCreateVerificationResult(false, [new("receipt_missing", "no durable receipt")]);
        }
        return ArticleCreateVerifier.Verify(snapshot);
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
        return ArticleTemplateContract.ComputeCommandDigest([.. values]);
    }
}
