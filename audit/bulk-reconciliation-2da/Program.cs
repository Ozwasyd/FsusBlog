using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Services.Articles.Bulk;
using FsusBlog.Server.Tests.Unit;

// Observe only null/still-unknown canonical recovery. No known business receipt/proof is invented.
internal static class Program
{
    private static async Task<int> Main()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-preservation-audit-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        try
        {
            var results = new List<object>();
            bool passed = true;
            foreach (string mode in new[] { "null", "still-unknown" })
            {
                string directory = Path.Combine(root, mode);
                Directory.CreateDirectory(directory);
                var fixture = await ArticleBulkExecutorTestFixture.CreateAsync("lifecycle.archive");
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
                var original = await journal.ResolveIdempotencyAsync(admission.Request.IdempotencyKey,
                    admission.Request.ExecutionIdentityDigest, default);
                string originalReceipt = original.TerminalReceipt!.ContentDigest;
                var filesBefore = await FilesAsync(directory);
                int selectionCalls = fixture.Selection.Calls;
                int preflightCalls = fixture.Preflight.Calls;
                int lateReads = 0;
                bool identityPreserved = true;
                fixture.Authority.GroupRecovery = (request, plan, checkpoint) =>
                {
                    lateReads++;
                    identityPreserved &= request.ContentDigest == admission.Request.ContentDigest
                        && request.ExecutionIdentityDigest == admission.Request.ExecutionIdentityDigest
                        && plan.ContentDigest == fixture.Plan.ContentDigest && checkpoint.ContentDigest == head.ContentDigest;
                    return Task.FromResult<ArticleBulkGroupRecoveryEvidence?>(mode == "null" ? null
                        : new ArticleBulkGroupRecoveryEvidence(request.ExecutionIdentityDigest, plan.ContentDigest,
                            ArticleBulkGroupCommitOutcome.UnknownRecovery, null, null, EmptyReceipts()));
                };
                bool noObservation = true;
                bool sameHead = true;
                for (int observation = 0; observation < 3; observation++)
                {
                    journal = new ArticleBulkFileJournalAuthority(options, fixture.Time);
                    framework = new ArticleBulkExecutionFramework(fixture.Planner, journal, fixture.Authority, fixture.Time);
                    var resumed = await framework.ResumeAsync(admission.Request, fixture.Plan, head);
                    sameHead &= resumed.ContentDigest == head.ContentDigest;
                    noObservation &= await framework.ReadReconciliationAsync(admission.Request, fixture.Plan, head) is null;
                }
                var after = await journal.ResolveIdempotencyAsync(admission.Request.IdempotencyKey,
                    admission.Request.ExecutionIdentityDigest, default);
                var filesAfter = await FilesAsync(directory);
                bool bytesPreserved = filesBefore.Count == filesAfter.Count
                    && filesBefore.All(pair => filesAfter.TryGetValue(pair.Key, out string? digest) && digest == pair.Value);
                int startMarkers = 0;
                await foreach (var batch in journal.ReadEventBatchesAsync(head, 128, default))
                {
                    startMarkers += batch.Count(entry => entry.Kind is ArticleBulkJournalEventKind.GroupCommitStarted
                        or ArticleBulkJournalEventKind.ItemStarted);
                }
                bool casePassed = lateReads == 3 && identityPreserved && sameHead && bytesPreserved && noObservation
                    && after.TerminalReceipt!.ContentDigest == originalReceipt
                    && after.TerminalReceipt.ZeroWriteProofDigest is null && !after.TerminalReceipt.RetryEligible
                    && fixture.Selection.Calls == selectionCalls && fixture.Preflight.Calls == preflightCalls
                    && startMarkers == 1;
                passed &= casePassed;
                results.Add(new
                {
                    Mode = mode,
                    LateAuthorityReads = lateReads,
                    OriginalIdentityPreserved = identityPreserved,
                    OriginalHeadPreserved = sameHead,
                    AllJournalFileBytesPreserved = bytesPreserved,
                    NoNewObservationJournal = noObservation,
                    OriginalReceiptPreserved = after.TerminalReceipt!.ContentDigest == originalReceipt,
                    NoSelectionOrPreflightRequery = fixture.Selection.Calls == selectionCalls && fixture.Preflight.Calls == preflightCalls,
                    OriginalJournalStartMarkers = startMarkers,
                    Passed = casePassed
                });
            }
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                Candidate = "2da720435c28cc481763af0ea7c117c82ea8ed0e",
                Probe = "late-unknown-preservation",
                Results = results,
                Passed = passed
            }));
            return passed ? 0 : 1;
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static async Task<Dictionary<string, string>> FilesAsync(string directory)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
        {
            result.Add(Path.GetRelativePath(directory, file), Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(file))));
        }
        return result;
    }

    private static async IAsyncEnumerable<ArticleBulkItemReceipt> EmptyReceipts()
    {
        await Task.CompletedTask;
        yield break;
    }
}
