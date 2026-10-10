#if QUERY_PRODUCER_INTAKE_LINKED
using FsusBlog.Server.Services.Fixtures.DataScale;

// Explicit ordinary refusal units. No producer, resolved content, key or prepared bundle is constructed.
internal static class OriginalPostgresQueryAdapterControls
{
    private static readonly string[] s_unitIds =
    [
        "missing-store", "missing-factory-batch", "non-utc-clock", "empty-batch", "oversized-batch",
        "missing-production", "cancelled-handoff", "missing-expected-inputs"
    ];
    internal static IReadOnlyList<string> UnitIds => Array.AsReadOnly(s_unitIds);

    internal static async Task RunAsync(string unit, string directory, string sourceCommit)
    {
        CanonicalQueryProducerIntake.ValidateLinkedQuerySourceCommit(sourceCommit);
        if (!UnitIds.Contains(unit, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("unknown_original_adapter_unit");
        }
        Directory.CreateDirectory(directory);
        string storeDirectory = Path.Combine(directory, "empty-original-store");
        var store = new DataScaleBatchCheckpointStore(storeDirectory);
        DateTime epoch = DateTime.UnixEpoch;
        Exception? observed = null;
        try
        {
            switch (unit)
            {
                case "missing-store":
                    _ = OriginalPostgresQueryAdapter.CreateExpectedConsumer(null!, [], epoch);
                    break;
                case "missing-factory-batch":
                    _ = OriginalPostgresQueryAdapter.CreateExpectedConsumer(store, null!, epoch);
                    break;
                case "non-utc-clock":
                    _ = OriginalPostgresQueryAdapter.CreateExpectedConsumer(store, [], DateTime.SpecifyKind(epoch, DateTimeKind.Unspecified));
                    break;
                case "empty-batch":
                    _ = OriginalPostgresQueryAdapter.CreateExpectedConsumer(store, [], epoch);
                    break;
                case "oversized-batch":
                    _ = OriginalPostgresQueryAdapter.CreateExpectedConsumer(store, new ArticleScaleArticleGraph[1001], epoch);
                    break;
                case "missing-production":
                    _ = await OriginalPostgresQueryAdapter.InspectHandoffAsync(store, null!, null!, null!, null!, null!,
                        ReadOnlyMemory<byte>.Empty, null!, CancellationToken.None).ConfigureAwait(false);
                    break;
                case "cancelled-handoff":
                    _ = await OriginalPostgresQueryAdapter.InspectHandoffAsync(store, null!, null!, null!, null!, null!,
                        ReadOnlyMemory<byte>.Empty, null!, new CancellationToken(canceled: true)).ConfigureAwait(false);
                    break;
                case "missing-expected-inputs":
                    _ = CanonicalQueryExpectedArticles.ProjectResolvedBatch(null!, [], null!, null!, epoch);
                    break;
            }
        }
        catch (Exception exception)
        {
            observed = exception;
        }
        string? requiredCode = unit switch
        {
            "non-utc-clock" => "query_expected_business_epoch_not_utc",
            "empty-batch" or "oversized-batch" => "query_expected_factory_batch_bound_invalid",
            _ => null
        };
        bool correct = requiredCode is not null
            ? observed is InvalidOperationException && observed.Message == requiredCode
            : unit == "cancelled-handoff" ? observed is OperationCanceledException : observed is ArgumentNullException;
        if (!correct || Directory.EnumerateFileSystemEntries(storeDirectory).Any())
        {
            throw new InvalidOperationException("original_adapter_unit_failed");
        }
        Directory.Delete(storeDirectory);
        QueryPlanCollector.WritePrivate(Path.Combine(directory, "unit-result.json"), new
        {
            sourceCommit,
            scope = "ordinary-original-adapter-refusal-unit-only",
            unit,
            status = "passed",
            observedFailure = observed!.GetType().Name,
            storeFilesCreated = 0,
            qualification = false,
            releaseEvidenceEligible = false
        });
    }
}
#endif
