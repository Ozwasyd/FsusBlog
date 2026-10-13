using System.Collections.Immutable;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles.Bulk;

/// <summary>
/// Integration-owned admission and transaction boundary, not an adapter permission provider.
/// There is deliberately no registration or available whole-set reservation implementation.
/// The original group owner's unregistered locked-facts stage reads actual prerequisites,
/// but ReserveAsync refuses until the actual document/editor admission producer exists.
/// The original owner must
/// admit the entire frozen explicit set, including site/session/policy, document and draft
/// lifecycle revisions, rights, locks, and every required transactional side-effect obligation.
/// A request already concluded by the canonical owner must be resolved by the existing read-only
/// recovery authority, never reserved again for mutation.
/// </summary>
internal interface IArticleBulkEditableLifecycleGroupAuthority
{
    int MaximumAtomicItems
    {
        get;
    }

    Task<IArticleBulkEditableLifecycleGroupReservation> ReserveAsync(
        ArticleBulkAtomicCommand command,
        CancellationToken cancellationToken);
}

/// <summary>
/// Owns one ambient transaction for the original admitted execution and frozen set. Database,
/// configuration, and authoritative UTC transition time remain fixed for its lifetime. The
/// reservation must lock/revalidate the full set and side-effect feasibility before returning.
/// The adapter never starts, commits, rolls back, or replaces this transaction itself.
/// </summary>
internal interface IArticleBulkEditableLifecycleGroupReservation : IAsyncDisposable
{
    ISqlSugarClient Database
    {
        get;
    }
    IConfiguration Configuration
    {
        get;
    }
    DateTime TransitionedAtUtc
    {
        get;
    }

    /// <summary>
    /// Rechecks original admission against every opaque canonical preparation and seals the
    /// actual whole-set preparation. This must bind the command identity, draft/document
    /// dependencies, original transaction, before coordinates, and required obligation owners.
    /// Returning a digest without that original source evidence does not grant admission.
    /// </summary>
    Task<string> SealPreparationAsync(
        ImmutableArray<ArticleLifecycleTransitionWriter.EditableTransitionPreparation> preparations,
        CancellationToken cancellationToken);

    /// <summary>Fresh whole-set authority check under the held transaction, before any writer call.</summary>
    Task RevalidateBeforeCommitAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Completes original draft/document and side-effect obligations, persists exactly one
    /// idempotent group result plus canonical item references in this transaction, then commits
    /// once. Only actual owner evidence may supply the outcome and item receipts. An uncertain
    /// finalization remains unknown/throws for existing reconciliation; it is never aborted
    /// based on absence of a response. This method must not invoke article commands again.
    /// </summary>
    Task<ArticleBulkAtomicOutcome> CompleteCommitAsync(
        ImmutableArray<ArticleLifecycleTransitionWriter.Result> results,
        CancellationToken cancellationToken);

    /// <summary>
    /// Releases the original reservation and proves zero visible business writes from actual
    /// authority observations. The reason is context only, not proof. Unknown release/rollback
    /// supplies no zero-write digest. Dispose is resource cleanup, not an outcome receipt.
    /// </summary>
    Task<ArticleBulkAtomicOutcome> AbortAsync(
        string reasonCode,
        bool cancelledBeforeCommit,
        CancellationToken cancellationToken);
}
