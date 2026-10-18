using System.Globalization;
using System.Text.Json;

using FsusBlog.Server.Services.Articles;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault;

using SqlSugar;

namespace FsusBlog.Server.Services;

public partial class ArticleService : IArticleVaultCanonicalGroupWriter
{
    async Task<ArticleVaultGroupResultReceipt> IArticleVaultCanonicalGroupWriter.ExecuteGroupAsync(
        ArticleVaultSealedExecutionBundle bundle,
        VaultSyncPlanGroup group,
        IReadOnlyList<ArticleVaultCurrentArticleObservation> expectedCurrent,
        CancellationToken cancellationToken)
    {
        if (_vaultExecutionStore is null || _vaultGroupResultStore is null || _vaultAuditLogStore is null)
        {
            throw new InvalidOperationException("article_vault_execution_services_missing");
        }

        string idempotency = ArticleVaultExecutionIntegrity.ComputeGroupIdempotency(bundle.Plan, group);
        ArticleVaultGroupResultReceipt? replay = await _vaultExecutionStore.LoadGroupResultAsync(
            bundle.Plan.SiteIdentity,
            bundle.Plan.VaultIdentity,
            bundle.PlanSha256,
            group.GroupIdentity,
            idempotency,
            cancellationToken).ConfigureAwait(false);
        if (replay is not null)
        {
            return replay;
        }

        string auditChainId = (_timeProvider ?? TimeProvider.System).GetUtcNow()
            .ToString("yyyyMMdd", CultureInfo.InvariantCulture);
        var publicFenceScopes = new HashSet<int?>();
        List<Func<Task>>? committedPostCommitActions = null;
        bool groupCommitted = false;
        try
        {
            var transaction = await ExecuteForegroundWriteAsync(
                "article-vault-write",
                async gateCt =>
                {
                    gateCt.ThrowIfCancellationRequested();
                    return await _db.Ado.UseTranAsync(async () =>
                    {
                        await ArticleSourceGenerationAuthority.AcquireMutationLockAsync(_db, cancellationToken).ConfigureAwait(false);
                        await _db.Ado.ExecuteCommandAsync(
                            "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 0));",
                            new SugarParameter("@Identity", $"article-vault:{idempotency}"));
                        ArticleVaultGroupResultReceipt? concurrentReplay = await _vaultExecutionStore.LoadGroupResultAsync(
                            bundle.Plan.SiteIdentity,
                            bundle.Plan.VaultIdentity,
                            bundle.PlanSha256,
                            group.GroupIdentity,
                            idempotency,
                            cancellationToken).ConfigureAwait(false);
                        if (concurrentReplay is not null)
                        {
                            return concurrentReplay;
                        }

                        foreach (int articleId in group.Items
                            .Select(static item => item.ServerArticleIdentity)
                            .Where(static identity => ParseArticleId(identity, out _))
                            .Select(static identity => int.Parse(identity!, CultureInfo.InvariantCulture))
                            .Distinct()
                            .Order())
                        {
                            _ = await _db.Ado.GetScalarAsync(
                                "SELECT id FROM article WHERE id = @ArticleId FOR UPDATE;",
                                new SugarParameter("@ArticleId", articleId)).ConfigureAwait(false);
                        }

                        IReadOnlyList<ArticleVaultCurrentArticleObservation> lockedCurrent = await
                            ((IArticleVaultCurrentObservationAuthority)this).ObserveGroupAsync(
                                bundle,
                                group,
                                cancellationToken).ConfigureAwait(false);
                        if (!lockedCurrent.SequenceEqual(expectedCurrent))
                        {
                            throw new ArticleVaultExecutionRejectedException("article_vault_current_observation_drift");
                        }

                        _articleVaultGroupTransactionDepth++;
                        _articleVaultOutboxReferences = new Dictionary<int, string>();
                        _articleVaultPublicFenceScopes = publicFenceScopes;
                        _articleVaultPostCommitActions = new List<Func<Task>>();
                        try
                        {
                            Dictionary<string, ArticleVaultExecutionPayloadItem> payload = bundle.Payload.Items
                                .ToDictionary(static item => item.OperationIdentity, StringComparer.Ordinal);
                            var operationReceipts = new List<ArticleVaultOperationResultReceipt>(group.Items.Count);
                            for (int index = 0; index < group.Items.Count; index++)
                            {
                                cancellationToken.ThrowIfCancellationRequested();
                                VaultSyncPlanItem item = group.Items[index];
                                ArticleVaultCurrentArticleObservation before = lockedCurrent[index];
                                ArticleVaultOperationResultReceipt receipt = await ExecuteVaultOperationAsync(
                                    bundle,
                                    group,
                                    item,
                                    before,
                                    payload,
                                    operationReceipts,
                                    idempotency,
                                    auditChainId,
                                    cancellationToken).ConfigureAwait(false);
                                operationReceipts.Add(receipt);
                            }

                            ArticleVaultGroupResultReceipt groupReceipt = SealGroupReceipt(
                                bundle,
                                group,
                                idempotency,
                                committed: true,
                                operationReceipts,
                                reasonCode: null);
                            await _vaultGroupResultStore.SaveGroupResultAsync(groupReceipt, cancellationToken)
                                .ConfigureAwait(false);
                            return groupReceipt;
                        }
                        finally
                        {
                            committedPostCommitActions = _articleVaultPostCommitActions;
                            _articleVaultPostCommitActions = null;
                            _articleVaultPublicFenceScopes = null;
                            _articleVaultOutboxReferences = null;
                            _articleVaultGroupTransactionDepth--;
                        }
                    }).ConfigureAwait(false);
                },
                cancellationToken).ConfigureAwait(false);

            if (!transaction.IsSuccess)
            {
                throw transaction.ErrorException
                    ?? new InvalidOperationException(transaction.ErrorMessage);
            }

            groupCommitted = true;
            await DrainArticleVaultPostCommitActionsAsync(
                committedPostCommitActions ?? []).ConfigureAwait(false);
            return transaction.Data;
        }
        catch (Exception exception) when (exception is not OperationCanceledException && !groupCommitted)
        {
            string reason = exception is ArticleVaultExecutionRejectedException rejected
                ? rejected.ReasonCode
                : "article_vault_group_write_failed";
            ArticleVaultGroupResultReceipt failed = BuildFailedGroupReceipt(bundle, group, idempotency, reason);
            var terminal = await ExecuteForegroundWriteAsync(
                "article-vault-write",
                async gateCt =>
                {
                    gateCt.ThrowIfCancellationRequested();
                    return await _db.Ado.UseTranAsync(
                        () => _vaultGroupResultStore.SaveGroupResultAsync(failed, CancellationToken.None)).ConfigureAwait(false);
                },
                CancellationToken.None).ConfigureAwait(false);
            if (!terminal.IsSuccess)
            {
                ArticleVaultGroupResultReceipt? concurrent = await _vaultExecutionStore.LoadGroupResultAsync(
                    bundle.Plan.SiteIdentity,
                    bundle.Plan.VaultIdentity,
                    bundle.PlanSha256,
                    group.GroupIdentity,
                    idempotency,
                    CancellationToken.None).ConfigureAwait(false);
                if (concurrent is not null)
                {
                    return concurrent;
                }
                throw terminal.ErrorException ?? new InvalidOperationException(terminal.ErrorMessage);
            }
            return failed;
        }
        finally
        {
            await RecoverArticleVaultPublicMutationFencesAsync(publicFenceScopes).ConfigureAwait(false);
            if (!groupCommitted)
            {
                _vaultAuditLogStore?.InvalidateChainTailCache([auditChainId]);
            }
        }
    }

    private async Task RecoverArticleVaultPublicMutationFencesAsync(HashSet<int?> publicFenceScopes)
    {
        foreach (int? articleId in publicFenceScopes.ToArray())
        {
            await RecoverAbortedPublicMutationFenceAsync(
                articleId,
                "article-vault-group-fence-aborted").ConfigureAwait(false);
            publicFenceScopes.Remove(articleId);
        }
    }

    private async Task<ArticleVaultOperationResultReceipt> ExecuteVaultOperationAsync(
        ArticleVaultSealedExecutionBundle bundle,
        VaultSyncPlanGroup group,
        VaultSyncPlanItem item,
        ArticleVaultCurrentArticleObservation before,
        IReadOnlyDictionary<string, ArticleVaultExecutionPayloadItem> payload,
        IReadOnlyList<ArticleVaultOperationResultReceipt> previousReceipts,
        string idempotency,
        string auditChainId,
        CancellationToken cancellationToken)
    {
        int? articleId = ParseArticleId(item.ServerArticleIdentity, out int parsedId) ? parsedId : null;
        long? afterRevision = before.ServerRevision;
        ArticleVaultOperationOutcome outcome = ArticleVaultOperationOutcome.NoOp;
        string writerReference = "article-service/noop";
        string? outboxReference = null;
        string? auditReference = null;
        string? articleContentSha256 = before.SourceSha256;

        switch (item.Decision)
        {
            case VaultSyncDecision.PushCreate:
                {
                    ArticleVaultExecutionPayloadItem local = GetPayload(payload, item.OperationIdentity);
                    ArticleWriteRequestCoreModel request = BuildCreateRequest(local);
                    ArticleMutationResult mutation = await CreateMutationAsync(request, identity: null, cancellationToken)
                        .ConfigureAwait(false);
                    if (mutation.ArticleId <= 0)
                    {
                        throw new ArticleVaultExecutionRejectedException("article_vault_create_failed");
                    }
                    articleId = mutation.ArticleId;
                    afterRevision = mutation.RevisionId;
                    outcome = ArticleVaultOperationOutcome.Executed;
                    writerReference = WriterReference(articleId.Value, mutation.RevisionId);
                    articleContentSha256 = local.SourceSha256;
                    break;
                }
            case VaultSyncDecision.PushUpdate:
                {
                    if (!articleId.HasValue)
                    {
                        throw new ArticleVaultExecutionRejectedException("article_vault_update_identity_missing");
                    }
                    ArticleVaultExecutionPayloadItem local = GetPayload(payload, item.OperationIdentity);
                    ArticleUpdateState current = await LoadArticleUpdateStateAsync(articleId.Value).ConfigureAwait(false)
                        ?? throw new ArticleVaultExecutionRejectedException("article_vault_update_target_missing");
                    ArticleUpdateExecution? execution = null;
                    bool updated = await UpdateAsync(
                        articleId.Value,
                        BuildUpdateRequest(local, current),
                        transitionKind: null,
                        force: false,
                        rollback: null,
                        captureExecution: value => execution = value,
                        cancellationToken).ConfigureAwait(false);
                    if (!updated || !execution.HasValue)
                    {
                        throw new ArticleVaultExecutionRejectedException("article_vault_update_failed");
                    }
                    afterRevision = execution.Value.Version.RevisionId;
                    outcome = execution.Value.Outcome == ArticleMutationOutcome.NoChange
                        ? ArticleVaultOperationOutcome.NoOp
                        : ArticleVaultOperationOutcome.Executed;
                    writerReference = WriterReference(articleId.Value, afterRevision.Value);
                    articleContentSha256 = outcome == ArticleVaultOperationOutcome.Executed
                        ? local.SourceSha256
                        : before.SourceSha256;
                    break;
                }
            case VaultSyncDecision.PushDelete:
                if (!articleId.HasValue || !await DeleteAsync(articleId.Value, cancellationToken).ConfigureAwait(false))
                {
                    throw new ArticleVaultExecutionRejectedException("article_vault_delete_failed");
                }
                outcome = ArticleVaultOperationOutcome.Executed;
                writerReference = WriterReference(articleId.Value, afterRevision ?? 0);
                break;
            case VaultSyncDecision.NoOp:
            case VaultSyncDecision.PullCreate:
            case VaultSyncDecision.PullUpdate:
            case VaultSyncDecision.PullDelete:
                break;
            default:
                throw new ArticleVaultExecutionRejectedException("article_vault_operation_not_executable");
        }

        if (outcome == ArticleVaultOperationOutcome.Executed)
        {
            if (!articleId.HasValue
                || _articleVaultOutboxReferences is null
                || !_articleVaultOutboxReferences.TryGetValue(articleId.Value, out outboxReference))
            {
                throw new ArticleVaultExecutionRejectedException("article_vault_outbox_receipt_missing");
            }
            auditReference = ArticleVaultExecutionIntegrity.Digest(new
            {
                bundle.PlanSha256,
                group.GroupIdentity,
                item.OperationIdentity,
                articleId,
                before.ServerRevision,
                afterRevision,
                writerReference,
                outboxReference
            });
            await _vaultAuditLogStore!.WriteBatchAsync(
                [new AuditRecord(
                    AuditSourceCatalog.Article,
                    AuditTypeCatalog.Business,
                    (_timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime,
                    "Article Vault canonical mutation committed.",
                    ContextPayload: null,
                    Action: "article.write",
                    Outcome: AuditOutcomeCatalog.Success,
                    ActorType: AuditActorTypeCatalog.Admin,
                    ActorId: bundle.AdminPrincipalId.ToString(CultureInfo.InvariantCulture),
                    TargetType: "article-vault-operation",
                    TargetId: item.OperationIdentity,
                    IsHighValue: true,
                    ContextJson: JsonSerializer.Serialize(new
                    {
                        bundle.PlanSha256,
                        group.GroupIdentity,
                        item.OperationIdentity,
                        articleId,
                        beforeRevision = before.ServerRevision,
                        afterRevision,
                        writerReference,
                        outboxReference,
                        auditReference
                    }),
                    ChainId: auditChainId)],
                cancellationToken).ConfigureAwait(false);
        }

        string[] dependencyOutcomes = item.DependsOnOperationIdentities.Select(dependency =>
        {
            ArticleVaultOperationResultReceipt receipt = previousReceipts.Single(
                candidate => candidate.OperationIdentity == dependency);
            return ArticleVaultExecutionIntegrity.ComputeDependencyOutcome(
                receipt.OperationIdentity,
                receipt.Outcome,
                receipt.ContentSha256);
        }).ToArray();
        var unsigned = new ArticleVaultOperationResultReceipt(
            ArticleVaultExecutionSchemas.OperationReceipt,
            ArticleVaultExecutionSchemas.Version,
            bundle.Plan.SiteIdentity,
            bundle.Plan.VaultIdentity,
            bundle.PlanSha256,
            group.GroupIdentity,
            item.OperationIdentity,
            item.PortableArticleIdentity,
            item.Decision,
            outcome,
            articleId,
            before.ServerRevision,
            afterRevision,
            writerReference,
            outboxReference,
            auditReference,
            item.DependsOnOperationIdentities,
            dependencyOutcomes,
            idempotency,
            articleContentSha256,
            ReasonCode: outcome == ArticleVaultOperationOutcome.NoOp ? "no_server_mutation" : null,
            string.Empty);
        return unsigned with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealOperationReceipt(unsigned)
        };
    }

    private static ArticleWriteRequestCoreModel BuildCreateRequest(ArticleVaultExecutionPayloadItem local)
        => new(
            local.Title,
            local.Content,
            local.Summary,
            local.CoverImageUrl,
            local.CategoryId,
            local.TagIds,
            Status: (int)ArticleStatus.Draft,
            ScheduledPublishAt: null,
            Rights: null,
            RightsMutation: ArticleRightsMutationMode.Preserve,
            BaseRevisionId: null);

    private static ArticleWriteRequestCoreModel BuildUpdateRequest(
        ArticleVaultExecutionPayloadItem local,
        ArticleUpdateState current)
        => new(
            local.Title,
            local.Content,
            local.Summary,
            local.CoverImageUrl,
            local.CategoryId,
            local.TagIds,
            Status: (int)current.Status,
            ScheduledPublishAt: current.ScheduledPublishAt,
            Rights: null,
            RightsMutation: ArticleRightsMutationMode.Preserve,
            BaseRevisionId: current.CurrentRevisionId);

    private static ArticleVaultExecutionPayloadItem GetPayload(
        IReadOnlyDictionary<string, ArticleVaultExecutionPayloadItem> payload,
        string operationIdentity)
        => payload.TryGetValue(operationIdentity, out ArticleVaultExecutionPayloadItem? item)
            ? item
            : throw new ArticleVaultExecutionRejectedException("article_vault_operation_payload_missing");

    private static string WriterReference(int articleId, long revisionId)
        => $"article-service:{articleId.ToString(CultureInfo.InvariantCulture)}:{revisionId.ToString(CultureInfo.InvariantCulture)}";

    private static ArticleVaultGroupResultReceipt SealGroupReceipt(
        ArticleVaultSealedExecutionBundle bundle,
        VaultSyncPlanGroup group,
        string idempotency,
        bool committed,
        IReadOnlyList<ArticleVaultOperationResultReceipt> operations,
        string? reasonCode)
    {
        var unsigned = new ArticleVaultGroupResultReceipt(
            ArticleVaultExecutionSchemas.GroupReceipt,
            ArticleVaultExecutionSchemas.Version,
            bundle.Plan.SiteIdentity,
            bundle.Plan.VaultIdentity,
            bundle.PlanSha256,
            group.GroupIdentity,
            idempotency,
            committed,
            operations,
            reasonCode,
            string.Empty);
        return unsigned with
        {
            ContentSha256 = ArticleVaultExecutionIntegrity.SealGroupReceipt(unsigned)
        };
    }

    private static ArticleVaultGroupResultReceipt BuildFailedGroupReceipt(
        ArticleVaultSealedExecutionBundle bundle,
        VaultSyncPlanGroup group,
        string idempotency,
        string reasonCode)
    {
        var operations = new List<ArticleVaultOperationResultReceipt>(group.Items.Count);
        foreach (VaultSyncPlanItem item in group.Items)
        {
            string[] dependencies = item.DependsOnOperationIdentities.Select(dependency =>
            {
                ArticleVaultOperationResultReceipt receipt = operations.Single(
                    candidate => candidate.OperationIdentity == dependency);
                return ArticleVaultExecutionIntegrity.ComputeDependencyOutcome(
                    receipt.OperationIdentity,
                    receipt.Outcome,
                    receipt.ContentSha256);
            }).ToArray();
            var unsigned = new ArticleVaultOperationResultReceipt(
                ArticleVaultExecutionSchemas.OperationReceipt,
                ArticleVaultExecutionSchemas.Version,
                bundle.Plan.SiteIdentity,
                bundle.Plan.VaultIdentity,
                bundle.PlanSha256,
                group.GroupIdentity,
                item.OperationIdentity,
                item.PortableArticleIdentity,
                item.Decision,
                ArticleVaultOperationOutcome.Failed,
                ParseArticleId(item.ServerArticleIdentity, out int articleId) ? articleId : null,
                item.Preconditions.ExpectedServerRevision,
                item.Preconditions.ExpectedServerRevision,
                "article-service/rolled-back",
                null,
                null,
                item.DependsOnOperationIdentities,
                dependencies,
                idempotency,
                item.Server.Source?.Sha256,
                reasonCode,
                string.Empty);
            operations.Add(unsigned with
            {
                ContentSha256 = ArticleVaultExecutionIntegrity.SealOperationReceipt(unsigned)
            });
        }
        return SealGroupReceipt(bundle, group, idempotency, committed: false, operations, reasonCode);
    }
}
