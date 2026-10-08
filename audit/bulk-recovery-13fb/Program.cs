using System.Text.Json;

using FsusBlog.Server.Services.Articles.Bulk;
using FsusBlog.Server.Tests.Unit;

// New-interface reachability only: no canonical business conclusion or receipt is fabricated.
// Original owner pure plan inputs and actual fsync journal/framework are used unchanged.
internal static class Program
{
    private static async Task<int> Main()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"fsusblog-late-recovery-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
            int firstReads = 0;
            fixture.Authority.GroupRecovery = (_, _, _) =>
            {
                firstReads++;
                return Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(null);
            };
            var options = new ArticleBulkFileJournalOptions(directory,
                ArticleBulkFileJournalDurabilityScope.SingleHostLinuxLocalAtomicRename);
            var journal = new ArticleBulkFileJournalAuthority(options, fixture.Time);
            var framework = new ArticleBulkExecutionFramework(fixture.Planner, journal, fixture.Authority, fixture.Time);
            var admission = await ArticleBulkExecutorProtocol.AdmitAsync(framework, fixture.Plan, fixture.Input, default);
            var head = await ArticleBulkExecutorProtocol.StartAsync(framework, fixture.Plan, admission.Head, default);
            (head, _) = await framework.AppendAsync(head, fixture.Plan,
                ArticleBulkJournalEventKind.GroupCommitStarted, head.State,
                commandOwner: ArticleBulkOperationRegistry.Get(fixture.Plan.OperationId).CommandOwner);
            head = await framework.ResumeAsync(admission.Request, fixture.Plan, head);

            int lateReads = 0;
            fixture.Authority.GroupRecovery = (_, _, _) =>
            {
                lateReads++;
                return Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(null);
            };
            journal = new ArticleBulkFileJournalAuthority(options, fixture.Time);
            framework = new ArticleBulkExecutionFramework(fixture.Planner, journal, fixture.Authority, fixture.Time);
            var restored = await ArticleBulkExecutorProtocol.AdmitAsync(framework, fixture.Plan, fixture.Input, default);
            var resumed = await framework.ResumeAsync(admission.Request, fixture.Plan, restored.Head);
            var resolution = await journal.ResolveIdempotencyAsync(fixture.Input.IdempotencyKey,
                admission.Request.ExecutionIdentityDigest, default);
            bool passed = lateReads > 0 && resumed.State == ArticleBulkExecutionState.RecoveryRequired
                && resolution.TerminalReceipt?.ZeroWriteProofDigest is null;
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                Probe = "late-unknown-reconciliation-read",
                Candidate = "13fb1166c8ae6ba772f847caadec9c14d5ffa754",
                InitialAuthorityReads = firstReads,
                LateAuthorityReads = lateReads,
                After = resumed.State.ToString(),
                SameHead = resumed.ContentDigest == head.ContentDigest,
                Outcome = resolution.TerminalReceipt?.GroupCommitOutcome?.ToString(),
                Passed = passed
            }));
            return passed ? 0 : 1;
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
