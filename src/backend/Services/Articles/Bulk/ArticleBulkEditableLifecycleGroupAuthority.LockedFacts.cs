using System.Collections.Immutable;
using System.Data;
using System.Globalization;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.Http;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles.Bulk;

/// <summary>Real locked persisted facts only; no document/editor admission, native grant or outcome receipt.</summary>
internal sealed record ArticleBulkEditableLifecycleLockedFacts(string RequestDigest, string PlanDigest,
    string FrozenSetDigest, ArticleLifecycleTransitionWriter.BulkCallerPermissionObservation Caller,
    ImmutableArray<ArticleLifecycleTransitionWriter.BulkRevisionFacts> OrderedArticles,
    AuthoringDraftLifecycleService.BulkDraftLockedFacts PersistedDrafts);

/// <summary>
/// Original unregistered group owner precondition stage. Reads actual caller/revision/draft facts
/// in the existing caller-owned native transaction. The existing full Reserve contract refuses
/// until document/editor/unsaved-state and every original obligation producer is implemented.
/// Failed/cancelled fact stages poison this instance; the original native caller must abort/release.
/// This class never starts, concludes, disposes or replaces that borrowed native transaction.
/// </summary>
internal sealed class ArticleBulkEditableLifecycleGroupAuthority(ISqlSugarClient database, IConfiguration configuration,
    AuthoringDraftLifecycleService drafts, ArticleBulkPlanAuthority plans, IHttpContextAccessor contexts)
    : IArticleBulkEditableLifecycleGroupAuthority
{
    private const int MaximumLockedFactItems = 10_000;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private LockedScope? _scope;
    private bool _failed;

    private sealed record LockedScope(NpgsqlTransaction Transaction, WeakReference<HttpContext> Context,
        ArticleBulkAtomicCommand Command, ImmutableArray<(int ArticleId, string ExpectedReference)> Ordered,
        ArticleLifecycleTransitionWriter.BulkCallerPermissionObservation Caller,
        AuthoringDraftLifecycleService.BulkDraftReservation DraftReservation,
        ArticleBulkEditableLifecycleLockedFacts Facts);

    // No full reservation capability is advertised by a persisted-only precondition reader.
    public int MaximumAtomicItems => 0;

    public async Task<IArticleBulkEditableLifecycleGroupReservation> ReserveAsync(ArticleBulkAtomicCommand command,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            // Refuse before acquiring any new native resources. Prior partial facts cannot be
            // reused after a failed full-reservation attempt; their caller still owns actual release.
            _failed = true;
            throw Failure("document-editor-admission-authority-unavailable");
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Actual precondition data for a future original Reserve implementation. Full ordered set,
    /// actual permission/site, native revision references and original persisted draft/source/rights
    /// are read and locked. Returning these data never returns a group reservation or commit right.
    /// </summary>
    internal async Task<ArticleBulkEditableLifecycleLockedFacts> PrepareReserveFactsAsync(
        ArticleBulkAtomicCommand command, CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_failed || _scope is not null)
                throw Failure("fact-stage-unavailable");
            HttpContext context = RequireOriginalContext();
            using var requestCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, context.RequestAborted);
            cancellationToken = requestCancellation.Token;
            NpgsqlTransaction transaction = RequireNativeTransaction();
            ImmutableArray<(int ArticleId, string ExpectedReference)> ordered = ValidateFrozenCommand(command);
            ArticleLifecycleTransitionWriter.BulkCallerPermissionObservation caller = await
                ArticleLifecycleTransitionWriter.CaptureBulkCallerPermissionAsync(database, transaction, context,
                    configuration, command.Plan.Actor.SiteId, command.Plan.OperationId, cancellationToken).ConfigureAwait(false);
            RequireCallerBinding(command, caller);
            AuthoringDraftLifecycleService.BulkDraftReservation draftReservation = await drafts.LockBulkDraftsAsync(
                transaction, command.Request, command.Plan, plans, cancellationToken).ConfigureAwait(false);
            ImmutableArray<ArticleLifecycleTransitionWriter.BulkRevisionFacts> articles = await
                ArticleLifecycleTransitionWriter.ReadLockedBulkRevisionSetAsync(database, transaction, ordered,
                    cancellationToken).ConfigureAwait(false);
            RequireArticleBinding(command, articles);
            AuthoringDraftLifecycleService.BulkDraftLockedFacts draftFacts = await drafts.ReadLockedBulkDraftFactsAsync(
                draftReservation, transaction, command.Request, command.Plan, plans, cancellationToken).ConfigureAwait(false);
            RequireOrderedDraftSet(ordered, draftFacts);
            RequireSameScope(transaction, context);
            await ArticleLifecycleTransitionWriter.RevalidateBulkCallerPermissionAfterLockAsync(database, transaction,
                context, configuration, caller, cancellationToken).ConfigureAwait(false);
            RequireFinalDeadlines(context, caller, command.Plan, cancellationToken);
            RequireSameScope(transaction, context);
            cancellationToken.ThrowIfCancellationRequested();
            var facts = new ArticleBulkEditableLifecycleLockedFacts(command.Request.ContentDigest, command.Plan.ContentDigest,
                command.Plan.FrozenSetDigest, caller, articles, draftFacts);
            _scope = new(transaction, new(context), command, ordered, caller, draftReservation, facts);
            return facts;
        }
        catch
        {
            _failed = true;
            throw;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Reacquires/rereads the entire exact locked set with the same original owners and request.
    /// Changed/foreign/cancelled facts poison this stage. It is not SealPreparation/precommit admission.
    /// </summary>
    internal async Task RevalidateReserveFactsAsync(ArticleBulkEditableLifecycleLockedFacts facts,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_failed || _scope is not { } scope || !ReferenceEquals(scope.Facts, facts)
                || !scope.Context.TryGetTarget(out HttpContext? originalContext))
                throw Failure("fact-stage-unavailable");
            HttpContext context = RequireOriginalContext();
            if (!ReferenceEquals(context, originalContext))
                throw Failure("original-context-changed");
            using var requestCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, context.RequestAborted);
            cancellationToken = requestCancellation.Token;
            RequireSameScope(scope.Transaction, context);
            ImmutableArray<(int ArticleId, string ExpectedReference)> ordered = ValidateFrozenCommand(scope.Command);
            if (!ordered.SequenceEqual(scope.Ordered))
                throw Failure("ordered-frozen-set-changed");
            RequireCallerBinding(scope.Command, scope.Caller);
            ImmutableArray<ArticleLifecycleTransitionWriter.BulkRevisionFacts> articles = await
                ArticleLifecycleTransitionWriter.ReadLockedBulkRevisionSetAsync(database, scope.Transaction, ordered,
                    cancellationToken).ConfigureAwait(false);
            RequireArticleBinding(scope.Command, articles);
            if (!articles.SequenceEqual(scope.Facts.OrderedArticles))
                throw Failure("locked-revision-facts-changed");
            AuthoringDraftLifecycleService.BulkDraftLockedFacts current = await drafts.ReadLockedBulkDraftFactsAsync(
                scope.DraftReservation, scope.Transaction, scope.Command.Request, scope.Command.Plan, plans,
                cancellationToken).ConfigureAwait(false);
            RequireOrderedDraftSet(ordered, current);
            if (!current.Drafts.SequenceEqual(scope.Facts.PersistedDrafts.Drafts))
                throw Failure("locked-draft-facts-changed");
            RequireSameScope(scope.Transaction, context);
            await ArticleLifecycleTransitionWriter.RevalidateBulkCallerPermissionAfterLockAsync(database, scope.Transaction,
                context, configuration, scope.Caller, cancellationToken).ConfigureAwait(false);
            RequireFinalDeadlines(context, scope.Caller, scope.Command.Plan, cancellationToken);
            RequireSameScope(scope.Transaction, context);
            cancellationToken.ThrowIfCancellationRequested();
        }
        catch
        {
            _failed = true;
            throw;
        }
        finally
        {
            _gate.Release();
        }
    }

    private ImmutableArray<(int ArticleId, string ExpectedReference)> ValidateFrozenCommand(ArticleBulkAtomicCommand command)
    {
        plans.ValidateForExecution(command.Plan);
        ArticleBulkPlan plan = command.Plan;
        ImmutableArray<ArticleBulkPlanItem> items = [.. plan.Items];
        if (plan.Selection.Kind != ArticleBulkSelectionKind.Explicit || !plan.Executable
            || plan.Strategy != ArticleBulkExecutionStrategy.AllOrNothing || items.Length is < 1 or > MaximumLockedFactItems
            || plan.Impact.SelectedCount != items.Length || plan.Impact.EligibleCount != items.Length || plan.Impact.BlockedCount != 0
            || !items.Select(static item => item.ArticleId).SequenceEqual(plan.Selection.ArticleIds, StringComparer.Ordinal)
            || plan.OperationId == "lifecycle.archive" && items.Any(static item => item.Lifecycle != "inbox"))
            throw Failure("ordered-frozen-set-invalid");
        AuthoringDraftLifecycleService.ValidateBulkDraftBinding(command.Request, plan, plans, items);
        if (command.GroupIdempotencyKey != ArticleBulkDigest.Of(new
        {
            command.Request.ExecutionIdentityDigest,
            WholeFrozenSet = plan.FrozenSetDigest
        }))
            throw Failure("original-group-identity-changed");
        var ordered = ImmutableArray.CreateBuilder<(int, string)>(items.Length);
        foreach (ArticleBulkPlanItem item in items)
        {
            // Original draft binding already enforces canonical positive numeric article IDs.
            // ExpectedRevision stays the opaque original writer reference, never a numeric revision.
            ArticleLifecycleTransitionWriter.RequireBulkRevisionReferenceShape(item.ExpectedRevision);
            ordered.Add((int.Parse(item.ArticleId, CultureInfo.InvariantCulture), item.ExpectedRevision!));
        }
        return ordered.ToImmutable();
    }

    private static void RequireCallerBinding(ArticleBulkAtomicCommand command,
        ArticleLifecycleTransitionWriter.BulkCallerPermissionObservation caller)
    {
        if (caller.AdminPrincipalId.ToString(CultureInfo.InvariantCulture) != command.Plan.Actor.UserId
            || caller.SiteScope != command.Plan.Actor.SiteId || caller.OperationId != command.Plan.OperationId
            || caller.PermissionPolicy != ArticleBulkOperationRegistry.Get(command.Plan.OperationId).PermissionPolicy
            || caller.Decision != ArticleLifecycleTransitionWriter.BulkCallerPermissionDecision.OriginalWriteAndExplicitOperationPresent)
            throw Failure("actual-caller-operation-denied");
    }

    private static void RequireArticleBinding(ArticleBulkAtomicCommand command,
        ImmutableArray<ArticleLifecycleTransitionWriter.BulkRevisionFacts> articles)
    {
        ArticleBulkPlanItem[] expected = [.. command.Plan.Items];
        if (articles.Length != expected.Length || articles.Where((row, index) => row.IsDeleted
            || row.ArticleId.ToString(CultureInfo.InvariantCulture) != expected[index].ArticleId
            || ArticleStatusValues.Token((int)row.Status) != expected[index].Lifecycle).Any())
            throw Failure("actual-article-set-changed");
    }

    private static void RequireOrderedDraftSet(ImmutableArray<(int ArticleId, string ExpectedReference)> ordered,
        AuthoringDraftLifecycleService.BulkDraftLockedFacts drafts)
    {
        if (!ordered.Select(static item => item.ArticleId).SequenceEqual(drafts.OrderedArticleIds))
            throw Failure("actual-draft-frozen-set-changed");
    }

    private HttpContext RequireOriginalContext()
    {
        HttpContext context = contexts.HttpContext ?? throw Failure("original-http-context-required");
        if (!ReferenceEquals(contexts, context.RequestServices.GetRequiredService<IHttpContextAccessor>())
            || !ReferenceEquals(configuration, context.RequestServices.GetRequiredService<IConfiguration>())
            || !ReferenceEquals(plans, context.RequestServices.GetRequiredService<ArticleBulkPlanAuthority>())
            || !ReferenceEquals(drafts, context.RequestServices.GetRequiredService<IAuthoringDraftLifecycle>()))
            throw Failure("original-scope-services-changed");
        return context;
    }

    private NpgsqlTransaction RequireNativeTransaction()
    {
        if (database.Ado.Transaction is not NpgsqlTransaction transaction || transaction.IsolationLevel != IsolationLevel.ReadCommitted
            || database.Ado.Connection is not NpgsqlConnection connection || connection.State != ConnectionState.Open
            || !ReferenceEquals(transaction.Connection, connection))
            throw Failure("original-native-transaction-required");
        return transaction;
    }

    private void RequireSameScope(NpgsqlTransaction transaction, HttpContext context)
    {
        if (!ReferenceEquals(transaction, RequireNativeTransaction()) || !ReferenceEquals(context, RequireOriginalContext()))
            throw Failure("original-native-scope-changed");
    }

    private static void RequireFinalDeadlines(HttpContext context,
        ArticleLifecycleTransitionWriter.BulkCallerPermissionObservation caller, ArticleBulkPlan plan, CancellationToken cancellationToken)
    {
        // One fresh same-business-clock read after the final blocking caller revalidation covers
        // both deadlines. A plan expiring during that wait cannot publish reusable locked facts.
        DateTimeOffset now = context.RequestServices.GetRequiredService<TimeProvider>().GetUtcNow();
        cancellationToken.ThrowIfCancellationRequested();
        if (now < caller.JwtNotBeforeUtc || now >= caller.JwtExpiresAtUtc || now >= plan.ExpiresAtUtc)
            throw Failure("final-caller-or-plan-expired");
    }

    private static ArticleBulkContractException Failure(string reason) => new($"article-bulk.locked-facts.{reason}");
}
