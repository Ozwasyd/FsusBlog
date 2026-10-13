using System.Collections.Immutable;
using System.Globalization;

using FsusBlog.Contracts.Articles;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles.Bulk;

/// <summary>
/// Explicit-ID adapter for the canonical editable lifecycle writer. It retains every opaque
/// preparation in the same original-owner transaction and performs no per-item transaction,
/// direct storage write, selection query, permission fallback, compensation, or journal work.
/// Genuine group admission and durable conclusions are mandatory integration-owned capabilities;
/// this class remains unregistered until those capabilities exist and are qualified.
/// </summary>
internal sealed class ArticleBulkEditableLifecycleAdapter(
    ArticleBulkPlanAuthority planAuthority,
    IArticleBulkEditableLifecycleGroupAuthority groupAuthority) : IArticleBulkAtomicCommandAuthority
{
    public string CommandOwner => "article-lifecycle-command";

    public ImmutableArray<string> OperationIds
    {
        get;
    } =
    ["lifecycle.archive", "lifecycle.draft-to-inbox", "lifecycle.inbox-to-draft", "lifecycle.restore"];

    public string RegistryDigest => ArticleBulkOperationRegistry.Current.ContentDigest;

    public int MaximumAtomicItems => Math.Min(10_000, groupAuthority.MaximumAtomicItems);

    public async Task<ArticleBulkAtomicPreparation> PrepareAsync(
        ArticleBulkAtomicCommand command,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(command);
        planAuthority.ValidateForExecution(command.Plan);
        ArticleBulkPlan plan = command.Plan;
        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(plan.OperationId);
        if (plan.Selection.Kind != ArticleBulkSelectionKind.Explicit
            || !plan.Executable
            || plan.Strategy != ArticleBulkExecutionStrategy.AllOrNothing
            || operation.Strategy != plan.Strategy
            || operation.CommandOwner != CommandOwner
            || !OperationIds.Contains(operation.Id, StringComparer.Ordinal))
        {
            throw new ArticleBulkContractException("article-bulk.editable-lifecycle-scope-unsupported");
        }
        int maximumAtomicItems = MaximumAtomicItems;
        if (maximumAtomicItems <= 0 || plan.Impact.SelectedCount < 1
            || plan.Impact.SelectedCount > maximumAtomicItems
            || plan.Impact.SelectedCount != plan.Impact.EligibleCount
            || plan.Impact.BlockedCount != 0)
        {
            throw new ArticleBulkContractException("article-bulk.atomic-size-or-admission-blocked");
        }
        ValidateCommandBinding(command);
        long principalId = ParsePositiveInt64(plan.Actor.UserId);
        ImmutableArray<ArticleBulkPlanItem> items = [.. plan.Items];
        if (!items.Select(static item => item.ArticleId)
            .SequenceEqual(plan.Selection.ArticleIds, StringComparer.Ordinal))
        {
            throw new ArticleBulkContractException("article-bulk.editable-frozen-set-inexact");
        }
        ArticleStatusTransitionOperation transition = ResolveTransition(plan.OperationId);
        foreach (ArticleBulkPlanItem item in items)
        {
            _ = ParseArticleId(item.ArticleId);
            _ = ParsePositiveInt64(item.ExpectedRevision);
            if (item.Status != ArticleBulkPlanItemStatus.Eligible
                || item.Lifecycle is null || !operation.ExpectedArticleStates.Contains(item.Lifecycle, StringComparer.Ordinal)
                || plan.OperationId == "lifecycle.archive" && item.Lifecycle != "inbox")
            {
                // The accepted editable API archives Inbox only. Broader archive and schedule
                // remain with their canonical owner; this adapter cannot reinterpret Update.
                throw new ArticleBulkContractException("article-bulk.editable-lifecycle-source-unsupported");
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        IArticleBulkEditableLifecycleGroupReservation group = await groupAuthority
            .ReserveAsync(command, cancellationToken).ConfigureAwait(false);
        try
        {
            ISqlSugarClient database = group.Database;
            IConfiguration configuration = group.Configuration;
            DateTime transitionedAtUtc = group.TransitionedAtUtc;
            object transaction = database.Ado.Transaction
                ?? throw new ArticleBulkContractException("article-bulk.original-transaction-unavailable");
            var scope = new TransactionScope(database, configuration, transaction, transitionedAtUtc);
            if (transitionedAtUtc.Kind != DateTimeKind.Utc)
            {
                throw new ArticleBulkContractException("article-bulk.original-transition-time-invalid");
            }
            string semanticRole = $"article-bulk:{plan.OperationId}:{plan.NormalizedParameters["reasonCode"]}";
            var preparations = ImmutableArray.CreateBuilder<ArticleLifecycleTransitionWriter.EditableTransitionPreparation>(items.Length);
            foreach (ArticleBulkPlanItem item in items)
            {
                RequireTransaction(group, scope);
                ArticleLifecycleTransitionWriter.EditableTransitionPreparation prepared = await
                    ArticleLifecycleTransitionWriter.PrepareEditableTransitionAsync(
                        database,
                        new ArticleLifecycleTransitionWriter.EditableTransitionRequest(
                            ParseArticleId(item.ArticleId), ParsePositiveInt64(item.ExpectedRevision),
                            transitionedAtUtc, principalId, semanticRole),
                        transition,
                        cancellationToken).ConfigureAwait(false);
                if (prepared.ArticleId != ParseArticleId(item.ArticleId)
                    || prepared.ExpectedRevisionId != ParsePositiveInt64(item.ExpectedRevision)
                    || prepared.Operation != transition
                    || ArticleStatusValues.Token((int)prepared.Before.Status) != item.Lifecycle)
                {
                    throw new ArticleBulkContractException("article-bulk.canonical-preparation-inexact");
                }
                preparations.Add(prepared);
            }
            RequireTransaction(group, scope);
            ImmutableArray<ArticleLifecycleTransitionWriter.EditableTransitionPreparation> frozen = preparations.ToImmutable();
            string preparationDigest = await group.SealPreparationAsync(frozen, cancellationToken)
                .ConfigureAwait(false);
            if (!IsDigest(preparationDigest))
            {
                throw new ArticleBulkContractException("article-bulk.original-preparation-unbound");
            }
            RequireTransaction(group, scope);
            return new ArticleBulkAtomicPreparation(
                new Prepared(group, scope, frozen, preparationDigest), null);
        }
        catch (Exception)
        {
            // Only the original owner can prove that preparation was released. An exception
            // from abort/disposal propagates; the existing executor retains unresolved recovery.
            try
            {
                ArticleBulkAtomicOutcome rejection = await group.AbortAsync(
                    "article-bulk.editable-preparation-failed", cancellationToken.IsCancellationRequested,
                    CancellationToken.None).ConfigureAwait(false);
                if (rejection.Outcome is not (ArticleBulkGroupCommitOutcome.RejectedZeroWrite
                        or ArticleBulkGroupCommitOutcome.FailedZeroWrite)
                    || !IsDigest(rejection.ZeroWriteProofDigest) || rejection.GroupReceiptDigest is not null)
                {
                    throw new ArticleBulkContractException("article-bulk.original-release-unproved");
                }
                return new ArticleBulkAtomicPreparation(null, rejection);
            }
            finally
            {
                await group.DisposeAsync().ConfigureAwait(false);
            }
        }
    }

    private static void ValidateCommandBinding(ArticleBulkAtomicCommand command)
    {
        ArticleBulkExecutionRequest request = command.Request;
        ArticleBulkPlan plan = command.Plan;
        if (request.PlanDigest != plan.ContentDigest || request.RegistryDigest != plan.RegistryDigest
            || request.OperationId != plan.OperationId || request.Strategy != plan.Strategy
            || request.ParametersDigest != plan.ParametersDigest || request.FrozenSetDigest != plan.FrozenSetDigest
            || request.Actor != plan.Actor || request.Source != plan.Source
            || request.PolicyDigest != plan.PolicyDigest || request.PermissionPolicyDigest != plan.PermissionPolicyDigest
            || !IsDigest(request.AdmissionAuthorityReceiptDigest)
            || request.ContentDigest != ArticleBulkDigest.Of(request with { ContentDigest = string.Empty })
            || command.GroupIdempotencyKey != ArticleBulkDigest.Of(new
            {
                request.ExecutionIdentityDigest,
                WholeFrozenSet = plan.FrozenSetDigest
            }))
        {
            throw new ArticleBulkContractException("article-bulk.editable-command-unbound");
        }
    }

    private static ArticleStatusTransitionOperation ResolveTransition(string operationId) => operationId switch
    {
        "lifecycle.draft-to-inbox" => ArticleStatusTransitionOperation.MoveToInbox,
        "lifecycle.inbox-to-draft" => ArticleStatusTransitionOperation.TriageInbox,
        "lifecycle.archive" => ArticleStatusTransitionOperation.ArchiveInbox,
        "lifecycle.restore" => ArticleStatusTransitionOperation.RestoreArchived,
        _ => throw new ArticleBulkContractException("article-bulk.editable-lifecycle-scope-unsupported")
    };

    private static int ParseArticleId(string? value)
    {
        long id = ParsePositiveInt64(value);
        return id <= int.MaxValue ? (int)id
            : throw new ArticleBulkContractException("article-bulk.canonical-identity-invalid");
    }

    private static long ParsePositiveInt64(string? value)
    {
        if (!long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long id)
            || id <= 0 || id.ToString(CultureInfo.InvariantCulture) != value)
        {
            throw new ArticleBulkContractException("article-bulk.canonical-identity-invalid");
        }
        return id;
    }

    private static bool IsDigest(string? value) => value is { Length: 71 }
        && value.StartsWith("sha256:", StringComparison.Ordinal)
        && value.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private sealed record TransactionScope(
        ISqlSugarClient Database,
        IConfiguration Configuration,
        object Transaction,
        DateTime TransitionedAtUtc);

    private static void RequireTransaction(
        IArticleBulkEditableLifecycleGroupReservation group,
        TransactionScope scope)
    {
        if (!ReferenceEquals(scope.Database, group.Database)
            || !ReferenceEquals(scope.Configuration, group.Configuration)
            || !ReferenceEquals(scope.Transaction, scope.Database.Ado.Transaction)
            || scope.TransitionedAtUtc != group.TransitionedAtUtc)
        {
            throw new ArticleBulkContractException("article-bulk.original-transaction-changed");
        }
    }

    private sealed class Prepared(
        IArticleBulkEditableLifecycleGroupReservation group,
        TransactionScope scope,
        ImmutableArray<ArticleLifecycleTransitionWriter.EditableTransitionPreparation> preparations,
        string preparationDigest) : IArticleBulkAtomicPreparedCommand
    {
        private readonly SemaphoreSlim _gate = new(1, 1);
        private bool _terminalStarted;
        private bool _disposed;

        public string PreparationReceiptDigest => preparationDigest;

        public async Task<ArticleBulkAtomicOutcome> CommitAsync(CancellationToken cancellationToken)
        {
            await _gate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try
            {
                RequirePrepared();
                _terminalStarted = true;
                var results = ImmutableArray.CreateBuilder<ArticleLifecycleTransitionWriter.Result>(preparations.Length);
                try
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    RequireTransaction(group, scope);
                    // Once mutation starts, request cancellation cannot kill a member or the
                    // original transaction. The existing executor owns the cancel boundary.
                    await group.RevalidateBeforeCommitAsync(CancellationToken.None).ConfigureAwait(false);
                    foreach (ArticleLifecycleTransitionWriter.EditableTransitionPreparation prepared in preparations)
                    {
                        RequireTransaction(group, scope);
                        ArticleLifecycleTransitionWriter.Result result = await
                            ArticleLifecycleTransitionWriter.CommitEditableTransitionAsync(
                                scope.Database, scope.Configuration, prepared, CancellationToken.None)
                                .ConfigureAwait(false);
                        if (result.ArticleId != prepared.ArticleId
                            || (result.Before with { TagIds = prepared.Before.TagIds }) != prepared.Before
                            || !result.Before.TagIds.SequenceEqual(prepared.Before.TagIds)
                            || result.After.Status != prepared.TargetStatus || result.After.IsDeleted
                            || result.After.RevisionId is null || result.After.RevisionId == prepared.ExpectedRevisionId)
                        {
                            throw new ArticleBulkContractException("article-bulk.canonical-result-inexact");
                        }
                        results.Add(result);
                    }
                    RequireTransaction(group, scope);
                }
                catch (Exception)
                {
                    return await group.AbortAsync("article-bulk.editable-command-failed", false,
                        CancellationToken.None).ConfigureAwait(false);
                }
                // This is the sole transaction conclusion. Its exceptions/unknowns propagate
                // for canonical reconciliation; they never trigger guessed rollback evidence.
                return await group.CompleteCommitAsync(results.ToImmutable(), CancellationToken.None)
                    .ConfigureAwait(false);
            }
            finally
            {
                _gate.Release();
            }
        }

        public async Task<ArticleBulkAtomicOutcome> AbortAsync(CancellationToken cancellationToken)
        {
            await _gate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try
            {
                RequirePrepared();
                _terminalStarted = true;
                return await group.AbortAsync("article-bulk.editable-preparation-cancelled", true,
                    CancellationToken.None).ConfigureAwait(false);
            }
            finally
            {
                _gate.Release();
            }
        }

        public async ValueTask DisposeAsync()
        {
            await _gate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try
            {
                if (_disposed)
                {
                    return;
                }
                _disposed = true;
                await group.DisposeAsync().ConfigureAwait(false);
            }
            finally
            {
                _gate.Release();
            }
        }

        private void RequirePrepared()
        {
            if (_disposed || _terminalStarted)
            {
                throw new ArticleBulkContractException("article-bulk.original-preparation-already-concluded");
            }
        }
    }
}
