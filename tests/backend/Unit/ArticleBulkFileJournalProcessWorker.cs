using System.Collections.Immutable;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;

using FsusBlog.Server.Services.Articles.Bulk;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static class ArticleBulkFileJournalProcessWorker
{
    internal const string Command = "article-bulk-file-journal-worker";
    internal const string ResultPrefix = "article-bulk-file-journal-result ";
    internal const int InvalidArgumentsExitCode = 64;
    internal const int WorkerFailureExitCode = 71;
    private static readonly DateTimeOffset s_now = new(2026, 9, 4, 18, 0, 0, TimeSpan.Zero);
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web);

    internal static async Task<int> RunAsync(string[] args)
    {
        if (args.Length != 2 || !Path.IsPathFullyQualified(args[1]))
        {
            return InvalidArgumentsExitCode;
        }

        try
        {
            string mode = args[0];
            bool crashEnvelope = mode == "resume-crash-envelope";
            bool crashPointer = mode is "append-admitted-crash-pointer" or "resume-crash-pointer";
            var time = new FixedTimeProvider(s_now);
            var planAuthority = new ArticleBulkPlanAuthority(
                new SelectionAuthority(["article-00000"]),
                new PreflightAuthority(),
                time);
            ArticleBulkPlan plan = await planAuthority.CreateAsync(CreateRequest());
            var journal = new ArticleBulkFileJournalAuthority(
                new ArticleBulkFileJournalOptions(
                    args[1],
                    ArticleBulkFileJournalDurabilityScope.SingleHostLinuxLocalAtomicRename),
                time,
                (stage, _) =>
                {
                    if (crashEnvelope && stage == ArticleBulkFileJournalCommitStage.EnvelopeDurable
                        || crashPointer && stage == ArticleBulkFileJournalCommitStage.PointerSealed)
                    {
                        Process.GetCurrentProcess().Kill();
                    }
                    return ValueTask.CompletedTask;
                });
            var framework = new ArticleBulkExecutionFramework(planAuthority, journal, time);
            ArticleBulkIdempotencyResolution current = await journal.ResolveIdempotencyAsync(
                "idempotency-1",
                ExecutionIdentity(plan),
                CancellationToken.None);
            ArticleBulkExecutionRequest request = current.ExistingRequest
                ?? throw new InvalidDataException("missing execution request");
            ArticleBulkJournalHead head = current.Head
                ?? throw new InvalidDataException("missing journal head");

            ArticleBulkAdmission? admission = null;
            if (mode == "duplicate")
            {
                admission = await framework.AdmitAsync(
                    plan,
                    "plan-store:one",
                    "attempt-1",
                    "idempotency-1",
                    plan.Actor,
                    plan.Source,
                    plan.PolicyDigest,
                    plan.PermissionPolicyDigest);
                head = admission.Head;
            }
            else if (mode is "resume" or "resume-crash-envelope" or "resume-crash-pointer")
            {
                head = await framework.ResumeAsync(request, plan, head);
            }
            else if (mode is "append-admitted" or "append-admitted-crash-pointer")
            {
                (head, _) = await framework.AppendAsync(
                    head,
                    plan,
                    ArticleBulkJournalEventKind.Admitted,
                    ArticleBulkExecutionState.Admitted);
            }
            else
            {
                return InvalidArgumentsExitCode;
            }

            Console.Out.WriteLine(ResultPrefix + JsonSerializer.Serialize(
                new ArticleBulkFileJournalWorkerResult(
                    mode,
                    admission?.IsExisting,
                    head.State,
                    head.EventCount,
                    head.ContentDigest),
                s_jsonOptions));
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"{exception.GetType().Name}:{exception.Message}");
            return WorkerFailureExitCode;
        }
    }

    private static string ExecutionIdentity(ArticleBulkPlan plan)
        => ArticleBulkDigest.Of(new
        {
            plan.ContentDigest,
            plan.RegistryDigest,
            plan.OperationId,
            plan.Strategy,
            plan.ParametersDigest,
            plan.FrozenSetDigest,
            actor = plan.Actor,
            source = plan.Source,
            policyDigest = plan.PolicyDigest,
            permissionPolicyDigest = plan.PermissionPolicyDigest
        });

    private static ArticleBulkPlanRequest CreateRequest()
        => new(
            "category.add",
            new Dictionary<string, JsonElement>(StringComparer.Ordinal)
            {
                ["categoryId"] = JsonSerializer.SerializeToElement("category-1")
            },
            new ArticleBulkSelection(
                ArticleBulkSelectionKind.Explicit,
                ["article-00000"],
                null,
                ArticleBulkDigest.Of("selection")),
            new ArticleBulkActor("user-1", "site-1", ArticleBulkDigest.Of("actor")),
            new ArticleBulkSource(new string('a', 40), ArticleBulkDigest.Of("build")),
            ArticleBulkDigest.Of("policy"),
            ArticleBulkDigest.Of("permission-policy"),
            s_now,
            s_now.AddMinutes(30));

    private sealed class SelectionAuthority(IEnumerable<string> articleIds) : IArticleBulkSelectionAuthority
    {
        public Task<ArticleBulkSelectionResolution> ResolveAsync(
            ArticleBulkSelection selection,
            ArticleBulkActor actor,
            CancellationToken cancellationToken)
            => Task.FromResult(new ArticleBulkSelectionResolution(
                ArticleBulkDigest.Of("selection-authority"),
                ArticleBulkDigest.Of("selection-resolution"),
                Stream(articleIds, cancellationToken)));
    }

    private sealed class PreflightAuthority : IArticleBulkPreflightAuthority
    {
        public async IAsyncEnumerable<ArticleBulkArticleObservation> ObserveAsync(
            IReadOnlyList<string> orderedArticleIds,
            ArticleBulkOperation operation,
            IReadOnlyDictionary<string, object> normalizedParameters,
            ArticleBulkActor actor,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            foreach (string articleId in orderedArticleIds)
            {
                cancellationToken.ThrowIfCancellationRequested();
                yield return new ArticleBulkArticleObservation(
                    articleId,
                    Exists: true,
                    SiteId: actor.SiteId,
                    Revision: $"revision-{articleId}",
                    Lifecycle: "inbox",
                    Permitted: true,
                    Applicable: true,
                    PermissionDigest: ArticleBulkDigest.Of($"permission-{articleId}"),
                    StateDigest: ArticleBulkDigest.Of($"state-{articleId}"),
                    DependencyDigests: [ArticleBulkDigest.Of($"dependency-{articleId}")]);
                await Task.Yield();
            }
        }
    }

    private static async IAsyncEnumerable<string> Stream(
        IEnumerable<string> values,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        foreach (string value in values)
        {
            cancellationToken.ThrowIfCancellationRequested();
            yield return value;
            await Task.Yield();
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}

internal sealed record ArticleBulkFileJournalWorkerResult(
    string Mode,
    bool? IsExisting,
    ArticleBulkExecutionState State,
    long EventCount,
    string HeadDigest);
