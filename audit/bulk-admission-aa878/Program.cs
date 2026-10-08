using System.Collections.Immutable;
using System.Text.Json;

using FsusBlog.Server.Services.Articles.Bulk;
using FsusBlog.Server.Tests.Unit;

// Admission/observation protocol diagnostics only. Existing owner pure inputs are consumed with
// actual source and fsync journal. No successful business/commit/outbox/rollback receipt is supplied.
internal static class Program
{
    private const string Candidate = "aa8783767599a3ac0e2fa8f99e8a0161f5775b23";
    private const string PrivateMarker = "private-current-observation-marker";

    private static async Task<int> Main(string[] args)
    {
        if (args.Length != 1)
        {
            return 2;
        }
        string directory = Path.Combine(Path.GetTempPath(), $"fsusblog-admission-audit-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            return args[0] switch
            {
                "global" => await GlobalAsync(directory),
                "per-item" => await PerItemAsync(directory),
                "atomic" => await AtomicAsync(directory),
                _ => 2
            };
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static ArticleBulkFileJournalAuthority Journal(string directory, ArticleBulkExecutorTestFixture fixture)
        => new(new ArticleBulkFileJournalOptions(directory,
            ArticleBulkFileJournalDurabilityScope.SingleHostLinuxLocalAtomicRename), fixture.Time);

    private static async Task<int> GlobalAsync(string root)
    {
        var results = new List<object>();
        bool allPassed = true;
        foreach (string change in new[] { "policy", "permission-policy", "actor", "source", "tamper", "expiry", "order", "shape", "interrupted" })
        {
            string directory = Path.Combine(root, change);
            Directory.CreateDirectory(directory);
            var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.add");
            var plan = fixture.Plan;
            var input = fixture.Input;
            var planner = fixture.Planner;
            if (change == "actor")
            {
                input = input with
                {
                    Actor = input.Actor with
                    {
                        SiteId = "another-site"
                    }
                };
            }
            if (change == "source")
            {
                input = input with
                {
                    Source = input.Source with
                    {
                        Commit = new string('b', 40)
                    }
                };
            }
            if (change == "tamper")
            {
                plan = plan with
                {
                    ContentDigest = ArticleBulkDigest.Of("different-content")
                };
            }
            if (change == "expiry")
            {
                planner = new ArticleBulkPlanAuthority(fixture.Selection, fixture.Preflight, new ExpiredTime());
            }
            if (change is "order" or "shape" or "interrupted")
            {
                fixture.Preflight.Transform = observation => change switch
                {
                    "order" => observation with { ArticleId = "different-identity" },
                    "shape" => observation with { PermissionDigest = "invalid-digest" },
                    _ => throw new IOException("audit-observation-no-conclusion")
                };
            }
            var journal = Journal(directory, fixture);
            var authority = new GlobalDrift(fixture.Authority, change);
            var framework = new ArticleBulkExecutionFramework(planner, journal, authority, fixture.Time);
            var command = new UnknownItem(plan);
            string? rejection = null;
            try
            {
                await new ArticleBulkPerItemExecutor(framework, journal, command).ExecuteAsync(plan, input);
            }
            catch (Exception exception)
            {
                rejection = exception is ArticleBulkContractException contract ? contract.Code : exception.GetType().Name;
            }
            bool noJournal = !Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories).Any();
            string expectedRejection = change switch
            {
                "policy" or "permission-policy" => "article-bulk.execution-authority-drift",
                "actor" or "source" => "article-bulk.execution-drift",
                "tamper" => "article-bulk.plan-tampered",
                "expiry" => "article-bulk.plan-expired",
                "order" => "article-bulk.execution-article-order-drift",
                "shape" => "article-bulk.preflight-observation-invalid",
                _ => "IOException"
            };
            bool passed = rejection == expectedRejection && command.Calls.Count == 0 && noJournal;
            allPassed &= passed;
            results.Add(new
            {
                Change = change,
                Rejection = rejection,
                CommandCalls = command.Calls.Count,
                NoJournal = noJournal,
                Passed = passed
            });
        }
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Candidate,
            Probe = "global",
            Results = results,
            Passed = allPassed
        }));
        return allPassed ? 0 : 1;
    }

    private static async Task<int> PerItemAsync(string root)
    {
        var results = new List<object>();
        var privateRefusalDigests = new List<string>();
        bool allPassed = true;
        foreach (string change in new[] { "revision", "permission", "site", "absence", "permission-digest", "state", "applicability", "dependency" })
        {
            string directory = Path.Combine(root, change);
            Directory.CreateDirectory(directory);
            var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("category.add");
            var items = fixture.Plan.Items.ToArray();
            string affected = items[0].ArticleId;
            fixture.Preflight.Transform = observation => observation.ArticleId == affected ? Change(observation, change) : observation;
            var decisions = await fixture.Planner.ReadCurrentItemExecutionDecisionsAsync(fixture.Plan);
            bool healthyEligible = decisions.Length == items.Length
                && decisions.Skip(1).All(static decision => decision.RejectionReasonCode is null);
            var journal = Journal(directory, fixture);
            var framework = new ArticleBulkExecutionFramework(fixture.Planner, journal, fixture.Authority, fixture.Time);
            var command = new UnknownItem(fixture.Plan);
            var result = await new ArticleBulkPerItemExecutor(framework, journal, command).ExecuteAsync(fixture.Plan, fixture.Input);
            await framework.VerifyExecutionAsync(result.Request, fixture.Plan, result.Head);
            var receipts = new List<ArticleBulkItemReceipt>();
            await foreach (var receipt in journal.ReadItemReceiptsAsync(result.Head, default))
            {
                receipts.Add(receipt);
            }
            var refused = receipts.Single(receipt => receipt.ArticleId == affected);
            string artifacts = JsonSerializer.Serialize(decisions) + JsonSerializer.Serialize(receipts);
            foreach (string file in Directory.EnumerateFiles(directory, "*.json", SearchOption.AllDirectories))
            {
                artifacts += await File.ReadAllTextAsync(file);
            }
            bool privacy = !artifacts.Contains(PrivateMarker, StringComparison.Ordinal)
                && !artifacts.Contains("foreign-private-site", StringComparison.Ordinal);
            if (change is "permission" or "site" or "absence")
            {
                privateRefusalDigests.Add(refused.ContentDigest);
            }
            bool passed = healthyEligible && command.Calls.SequenceEqual(new[] { items[1].ArticleId })
                && refused.ExecutionStatus == ArticleBulkItemStatus.Failed && refused.ReasonCode == Reason(change)
                && refused.ExpectedRevision == items[0].ExpectedRevision && refused.ObservedRevision is null
                && refused.NewRevision is null && refused.SideEffects.IsEmpty && privacy
                && result.Head.State == ArticleBulkExecutionState.RecoveryRequired && result.Receipt!.SucceededCount == 0
                && fixture.Plan.ContentDigest == result.Request.PlanDigest && fixture.Selection.Calls == 1;
            allPassed &= passed;
            results.Add(new
            {
                Change = change,
                HealthyDecisionSetPreserved = healthyEligible,
                CalledExactNextHealthyItem = command.Calls.SequenceEqual(new[] { items[1].ArticleId }),
                Reason = refused.ReasonCode,
                Privacy = privacy,
                Passed = passed
            });
        }
        bool indistinguishable = privateRefusalDigests.Distinct(StringComparer.Ordinal).Count() == 1;
        allPassed &= indistinguishable;
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Candidate,
            Probe = "per-item",
            Results = results,
            DeniedAbsentForeignReceiptIndistinguishable = indistinguishable,
            Boundary = "next healthy invocation demonstrated; injected unknown outcome safely stops subsequent business commands",
            Passed = allPassed
        }));
        return allPassed ? 0 : 1;
    }

    private static async Task<int> AtomicAsync(string root)
    {
        var results = new List<object>();
        bool allPassed = true;
        foreach (string change in new[] { "revision", "permission", "site", "absence", "permission-digest", "state", "applicability", "dependency" })
        {
            string directory = Path.Combine(root, change);
            Directory.CreateDirectory(directory);
            var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
            string affected = fixture.Plan.Items.ElementAt(1).ArticleId;
            fixture.Preflight.Transform = observation => observation.ArticleId == affected ? Change(observation, change) : observation;
            var journal = Journal(directory, fixture);
            var framework = new ArticleBulkExecutionFramework(fixture.Planner, journal, fixture.Authority, fixture.Time);
            var command = new UnknownPreparation(fixture.Plan);
            string? rejection = null;
            try
            {
                await new ArticleBulkAtomicExecutor(framework, journal, command).ExecuteAsync(fixture.Plan, fixture.Input);
            }
            catch (ArticleBulkContractException exception)
            {
                rejection = exception.Code;
            }
            bool noJournal = !Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories).Any();
            bool passed = rejection == "article-bulk.execution-article-drift" && command.Calls == 0 && noJournal
                && fixture.Selection.Calls == 1;
            allPassed &= passed;
            results.Add(new
            {
                Change = change,
                Rejection = rejection,
                PrepareCalls = command.Calls,
                NoJournal = noJournal,
                Passed = passed
            });
        }
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            Candidate,
            Probe = "atomic",
            Results = results,
            Passed = allPassed
        }));
        return allPassed ? 0 : 1;
    }

    private static ArticleBulkArticleObservation Change(ArticleBulkArticleObservation observation, string change)
    {
        var changed = change switch
        {
            "revision" => observation with { Revision = "changed-revision" },
            "permission" => observation with { Permitted = false },
            "site" => observation with { SiteId = "foreign-private-site" },
            "absence" => observation with { Exists = false },
            "permission-digest" => observation with { PermissionDigest = ArticleBulkDigest.Of("changed-permission") },
            "state" => observation with { Lifecycle = "deleted" },
            "applicability" => observation with { Applicable = false },
            "dependency" => observation with { DependencyDigests = [ArticleBulkDigest.Of("changed-dependency")] },
            _ => throw new InvalidOperationException(change)
        };
        return change is "permission" or "site" or "absence"
            ? changed with
            {
                Revision = PrivateMarker,
                Lifecycle = PrivateMarker,
                StateDigest = ArticleBulkDigest.Of(PrivateMarker)
            }
            : changed;
    }

    private static string Reason(string change) => change switch
    {
        "revision" => "revision-conflict",
        "permission" or "site" or "absence" => "article-inaccessible",
        "permission-digest" => "permission-conflict",
        "state" => "article-state-blocked",
        "applicability" => "operation-not-applicable",
        _ => "precondition-conflict"
    };

    private sealed class GlobalDrift(IArticleBulkExecutionAuthority inner, string change) : IArticleBulkExecutionAuthority
    {
        public async Task<ArticleBulkExecutionAuthoritySnapshot> ReadCurrentAsync(ArticleBulkPlan plan, CancellationToken cancellationToken)
        {
            var snapshot = await inner.ReadCurrentAsync(plan, cancellationToken);
            return change switch
            {
                "policy" => snapshot with { PolicyDigest = ArticleBulkDigest.Of("changed-global-policy") },
                "permission-policy" => snapshot with { PermissionPolicyDigest = ArticleBulkDigest.Of("changed-global-permission-policy") },
                _ => snapshot
            };
        }

        public Task ValidateGroupOutcomeAsync(ArticleBulkPlan plan, ArticleBulkGroupCommitOutcome outcome,
            string? groupReceiptDigest, string? zeroWriteProofDigest, CancellationToken cancellationToken)
            => inner.ValidateGroupOutcomeAsync(plan, outcome, groupReceiptDigest, zeroWriteProofDigest, cancellationToken);
    }

    private sealed class UnknownItem(ArticleBulkPlan plan) : IArticleBulkPerItemCommandAuthority
    {
        public string CommandOwner => ArticleBulkOperationRegistry.Get(plan.OperationId).CommandOwner;
        public ImmutableArray<string> OperationIds => [plan.OperationId];
        public string RegistryDigest => plan.RegistryDigest;
        internal List<string> Calls { get; } = [];
        public Task<ArticleBulkItemReceipt> ExecuteAsync(ArticleBulkItemCommand command, CancellationToken cancellationToken)
        {
            Calls.Add(command.Item.ArticleId);
            throw new IOException("audit-canonical-outcome-no-conclusion");
        }
    }

    private sealed class UnknownPreparation(ArticleBulkPlan plan) : IArticleBulkAtomicCommandAuthority
    {
        public string CommandOwner => ArticleBulkOperationRegistry.Get(plan.OperationId).CommandOwner;
        public ImmutableArray<string> OperationIds => [plan.OperationId];
        public string RegistryDigest => plan.RegistryDigest;
        public int MaximumAtomicItems => 10_000;
        internal int Calls
        {
            get; private set;
        }
        public Task<ArticleBulkAtomicPreparation> PrepareAsync(ArticleBulkAtomicCommand command, CancellationToken cancellationToken)
        {
            Calls++;
            throw new IOException("audit-preparation-should-not-start");
        }
    }

    private sealed class ExpiredTime : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => ArticleBulkExecutorTestFixture.Now.AddHours(1);
    }
}
