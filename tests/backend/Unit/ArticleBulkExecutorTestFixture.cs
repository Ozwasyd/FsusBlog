using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using System.Text.Json;

using FsusBlog.Server.Services.Articles.Bulk;

namespace FsusBlog.Server.Tests.Unit;

// These isolated protocol doubles exercise production executors and journal validation. They are
// not database, canonical business-adapter, HTTP, or production zero-write qualification.
internal sealed class ArticleBulkExecutorTestFixture
{
    internal static DateTimeOffset Now { get; } = new(2026, 10, 8, 6, 0, 0, TimeSpan.Zero);

    internal required ArticleBulkPlan Plan
    {
        get; init;
    }
    internal required ArticleBulkExecutionFramework Framework
    {
        get; init;
    }
    internal required ArticleBulkExecutionInput Input
    {
        get; init;
    }
    internal required JournalDouble Journal
    {
        get; init;
    }
    internal required AuthorityDouble Authority
    {
        get; init;
    }
    internal required SelectionDouble Selection
    {
        get; init;
    }
    internal required ArticleBulkPlanAuthority Planner
    {
        get; init;
    }
    internal required PreflightDouble Preflight
    {
        get; init;
    }

    internal required TimeProvider Time
    {
        get; init;
    }

    internal static async Task<ArticleBulkExecutorTestFixture> CreateAsync(string operationId, int count = 3)
    {
        ImmutableArray<string> ids = [.. Enumerable.Range(0, count).Select(static index => $"article-{index:D5}")];
        var selection = new SelectionDouble(ids);
        var time = new FixedTime();
        var preflight = new PreflightDouble();
        var planner = new ArticleBulkPlanAuthority(selection, preflight, time);
        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(operationId);
        Dictionary<string, JsonElement> parameters = operation.Parameters.ToDictionary(
            static field => field.Name,
            static field => field.Type switch
            {
                ArticleBulkParameterType.Digest => JsonSerializer.SerializeToElement(ArticleBulkDigest.Of("parameter")),
                ArticleBulkParameterType.StableIdArray => JsonSerializer.SerializeToElement(new[] { "check-1" }),
                ArticleBulkParameterType.Rfc3339Utc => JsonSerializer.SerializeToElement("2026-10-09T06:00:00Z"),
                _ => JsonSerializer.SerializeToElement("catalog-1")
            },
            StringComparer.Ordinal);
        ArticleBulkPlan plan = await planner.CreateAsync(new ArticleBulkPlanRequest(
            "plan-1",
            null,
            operationId,
            parameters,
            new ArticleBulkSelection(ArticleBulkSelectionKind.Explicit, ids, null, ArticleBulkDigest.Of(ids)),
            new ArticleBulkActor("user-1", "site-1", ArticleBulkDigest.Of("actor")),
            new ArticleBulkSource(new string('a', 40), ArticleBulkDigest.Of("build")),
            ArticleBulkDigest.Of("policy"),
            ArticleBulkDigest.Of("permission"),
            Now,
            Now.AddMinutes(30)));
        var confirmation = new ArticleBulkPlanConfirmation(
            "confirmation-1", plan.PlanIdentity, plan.ContentDigest, plan.Actor.AuthorityDigest, Now, string.Empty);
        confirmation = confirmation with
        {
            ContentDigest = ArticleBulkDigest.Of(confirmation)
        };
        var journal = new JournalDouble();
        var authority = new AuthorityDouble();
        return new ArticleBulkExecutorTestFixture
        {
            Plan = plan,
            Preflight = preflight,
            Input = new ArticleBulkExecutionInput(
                confirmation, "plan-store:one", "attempt-1", "idempotency-1",
                plan.Actor, plan.Source, plan.PolicyDigest, plan.PermissionPolicyDigest),
            Journal = journal,
            Authority = authority,
            Selection = selection,
            Planner = planner,
            Time = time,
            Framework = new ArticleBulkExecutionFramework(planner, journal, authority, time)
        };
    }

    internal static ArticleBulkItemReceipt ItemReceipt(
        ArticleBulkExecutionRequest request,
        ArticleBulkPlan plan,
        ArticleBulkPlanItem item,
        ArticleBulkItemStatus status = ArticleBulkItemStatus.Succeeded,
        string reason = "succeeded")
    {
        ArticleBulkOperation operation = ArticleBulkOperationRegistry.Get(plan.OperationId);
        return ArticleBulkExecutionFramework.SealItemReceipt(new ArticleBulkItemReceipt(
            request.AttemptId,
            plan.ContentDigest,
            plan.RegistryDigest,
            plan.OperationId,
            item.ArticleId,
            item.ExpectedRevision!,
            item.ExpectedRevision,
            status == ArticleBulkItemStatus.Succeeded && operation.MutatesBusinessState ? "new-revision" : null,
            item.Status,
            status,
            reason,
            operation.CommandOwner,
            ArticleBulkDigest.Of(new
            {
                item.ArticleId,
                reason
            }),
            status == ArticleBulkItemStatus.Succeeded
                ? [.. operation.SideEffectOwners.Select(owner => new ArticleBulkSideEffectReceipt(
                    owner, ArticleBulkDigest.Of(new { owner, item.ArticleId })))]
                : [],
            ArticleBulkDigest.Of(new
            {
                request.AttemptId,
                item.ArticleId,
                Retry = true
            }),
            string.Empty));
    }

    internal sealed class SelectionDouble(ImmutableArray<string> ids) : IArticleBulkSelectionAuthority
    {
        internal int Calls
        {
            get; private set;
        }

        public Task<ArticleBulkSelectionResolution> ResolveAsync(
            ArticleBulkSelection selection,
            ArticleBulkActor actor,
            CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(new ArticleBulkSelectionResolution(
                ArticleBulkDigest.Of("selection-owner"), ArticleBulkDigest.Of(ids), Stream(ids, cancellationToken)));
        }
    }

    internal sealed class PreflightDouble : IArticleBulkPreflightAuthority
    {
        internal Func<ArticleBulkArticleObservation, ArticleBulkArticleObservation>? Transform
        {
            get; set;
        }
        internal int Calls
        {
            get; private set;
        }

        public async IAsyncEnumerable<ArticleBulkArticleObservation> ObserveAsync(
            IReadOnlyList<string> orderedArticleIds,
            ArticleBulkOperation operation,
            IReadOnlyDictionary<string, object> normalizedParameters,
            ArticleBulkActor actor,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            Calls++;
            foreach (string id in orderedArticleIds)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var observation = new ArticleBulkArticleObservation(
                    id, true, actor.SiteId, $"revision-{id}", operation.ExpectedArticleStates[0], true, true,
                    ArticleBulkDigest.Of("permission"), ArticleBulkDigest.Of("state"), []);
                yield return Transform?.Invoke(observation) ?? observation;
            }
            await Task.CompletedTask;
        }
    }

    internal sealed class AuthorityDouble : IArticleBulkExecutionAuthority
    {
        internal bool RejectGroupProof
        {
            get; set;
        }
        internal int GroupProofChecks
        {
            get; private set;
        }

        public Task<ArticleBulkExecutionAuthoritySnapshot> ReadCurrentAsync(
            ArticleBulkPlan plan,
            CancellationToken cancellationToken)
            => Task.FromResult(new ArticleBulkExecutionAuthoritySnapshot(
                plan.PolicyDigest, plan.PermissionPolicyDigest, ArticleBulkDigest.Of("authority"), null));

        internal Func<ArticleBulkExecutionRequest, ArticleBulkPlan, ArticleBulkJournalHead,
            Task<ArticleBulkGroupRecoveryEvidence?>>? GroupRecovery
        {
            get; set;
        }

        public Task<ArticleBulkGroupRecoveryEvidence?> ReadGroupRecoveryAsync(
            ArticleBulkExecutionRequest request,
            ArticleBulkPlan plan,
            ArticleBulkJournalHead checkpoint,
            CancellationToken cancellationToken)
            => GroupRecovery?.Invoke(request, plan, checkpoint)
                ?? Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(null);

        public Task ValidateGroupOutcomeAsync(
            ArticleBulkPlan plan,
            ArticleBulkGroupCommitOutcome outcome,
            string? groupReceiptDigest,
            string? zeroWriteProofDigest,
            CancellationToken cancellationToken)
        {
            GroupProofChecks++;
            if (RejectGroupProof)
            {
                throw new ArticleBulkContractException("test.group-proof-rejected");
            }
            return Task.CompletedTask;
        }
    }

    internal sealed class JournalDouble : IArticleBulkJournalAuthority
    {
        internal ArticleBulkExecutionRequest? Request
        {
            get; private set;
        }
        internal ArticleBulkJournalHead? Head
        {
            get; private set;
        }
        internal ArticleBulkAggregateReceipt? Terminal
        {
            get; private set;
        }
        internal List<ArticleBulkJournalEvent> Events { get; } = [];
        internal List<ArticleBulkItemReceipt> Receipts { get; } = [];
        private readonly Dictionary<string, ArticleBulkItemStatus> _statuses = new(StringComparer.Ordinal);

        public Task<ArticleBulkIdempotencyResolution> ResolveIdempotencyAsync(
            string idempotencyKey,
            string executionIdentityDigest,
            CancellationToken cancellationToken)
            => Task.FromResult(new ArticleBulkIdempotencyResolution(
                Request is null ? ArticleBulkIdempotencyKind.Missing
                    : Request.IdempotencyKey != idempotencyKey || Request.ExecutionIdentityDigest != executionIdentityDigest
                        ? ArticleBulkIdempotencyKind.Conflict
                        : Terminal is null ? ArticleBulkIdempotencyKind.InProgress : ArticleBulkIdempotencyKind.Terminal,
                Request, Head, Terminal));

        public Task<ArticleBulkJournalAppendReceipt> CreateAsync(
            string idempotencyKey,
            ArticleBulkExecutionRequest request,
            ArticleBulkJournalEvent firstEvent,
            ArticleBulkJournalHead firstHead,
            CancellationToken cancellationToken)
        {
            if (Request is not null)
            {
                throw new ArticleBulkContractException("article-bulk.idempotency-conflict");
            }
            Request = request;
            Head = firstHead;
            Events.Add(firstEvent);
            return Task.FromResult(AppendReceipt(firstEvent, firstHead));
        }

        public Task<ArticleBulkJournalAppendReceipt> AppendAsync(
            ArticleBulkJournalAppend append,
            CancellationToken cancellationToken)
        {
            if (Head?.ContentDigest != append.ExpectedHeadDigest)
            {
                throw new ArticleBulkContractException("test.head-cas-conflict");
            }
            if (append.ArticleId is not null)
            {
                ArticleBulkItemStatus? observed = _statuses.TryGetValue(append.ArticleId, out var status) ? status : null;
                if (observed != append.ExpectedItemStatus)
                {
                    throw new ArticleBulkContractException("test.item-cas-conflict");
                }
                _statuses[append.ArticleId] = append.NextItemStatus!.Value;
            }
            Events.Add(append.Event);
            Head = append.NextHead;
            Receipts.AddRange(append.ItemReceipts);
            Terminal = append.AggregateReceipt ?? Terminal;
            return Task.FromResult(AppendReceipt(append.Event, append.NextHead));
        }

        public async IAsyncEnumerable<IReadOnlyList<ArticleBulkJournalEvent>> ReadEventBatchesAsync(
            ArticleBulkJournalHead sealedHead,
            int maximumBatchSize,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            foreach (ArticleBulkJournalEvent[] batch in Events.Take((int)sealedHead.EventCount).Chunk(maximumBatchSize))
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return batch;
            }
            await Task.CompletedTask;
        }

        public IAsyncEnumerable<ArticleBulkItemReceipt> ReadItemReceiptsAsync(
            ArticleBulkJournalHead sealedHead,
            CancellationToken cancellationToken)
            => Stream(Receipts, cancellationToken);

        private static ArticleBulkJournalAppendReceipt AppendReceipt(
            ArticleBulkJournalEvent journalEvent,
            ArticleBulkJournalHead head)
            => new(head.AttemptId, journalEvent.Ordinal, journalEvent.ContentDigest, head.ContentDigest,
                ArticleBulkDigest.Of("test-journal-authority"));
    }

    internal static async IAsyncEnumerable<T> Stream<T>(
        IEnumerable<T> values,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        foreach (T value in values)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return value;
        }
        await Task.CompletedTask;
    }

    private sealed class FixedTime : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => Now;
    }
}
