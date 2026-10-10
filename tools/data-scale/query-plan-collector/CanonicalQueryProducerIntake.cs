#if QUERY_PRODUCER_INTAKE_LINKED
using System.Data.Common;
using System.Reflection;

using FsusBlog.QueryEvidence;
#endif
#if !QUERY_PRODUCER_INTAKE_LINKED
using FsusBlog.Server.Infrastructure.Testing;
#endif
#if QUERY_PRODUCER_INTAKE_LINKED
using FsusBlog.Server.Services.Fixtures.DataScale;
#endif

/// <summary>
/// Original native intake at the sole query runner's mapping boundary. The file
/// runner has no authenticated producer-object reader, so missing objects remain
/// null; scalar maps and verified flags cannot replace those original objects.
/// </summary>
internal static class CanonicalQueryProducerIntake
{
    internal static void RefuseMissingInputs(string outputPath, string sourceCommit)
    {
#if QUERY_PRODUCER_INTAKE_LINKED
        ValidateLinkedQuerySourceCommit(sourceCommit);
        QueryProducerRoleInspection role = QueryProducerRoleIntake.Inspect(null, null);
        QueryPostgresProducerInspection postgres = QueryPostgresProducerIntake.Inspect(
            null, null, null, null, null, ReadOnlySpan<byte>.Empty);
        QueryPlanCollector.WritePrivate(outputPath, new
        {
            sourceCommit,
            qualification = "not-performed",
            releaseEvidenceEligible = false,
            scope = "original-native-intake-missing-object-refusal-only",
            originalInterfacesLinked = true,
            originalProducerObjectsSupplied = false,
            originalPostgresResolvedHandoff = DescribeOriginalResolvedHandoff(),
            backendSourceCommit = typeof(ArticleScalePlan).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
                .SingleOrDefault(attribute => attribute.Key == "FsusBlog.SourceCommit")?.Value,
            roleBlockers = role.Blockers,
            postgresBlockers = postgres.Blockers
        });
        // Preserve the original first refusal. No status or checkpoint is normalized.
        role.ThrowBeforeQueryExecution();
        postgres.ThrowBeforeQueryExecution();
#else
        CurrentSchemaTestMaterializer.ValidateAssemblySourceCommit(sourceCommit);
        QueryPlanCollector.WritePrivate(outputPath, new
        {
            sourceCommit,
            qualification = "not-performed",
            releaseEvidenceEligible = false,
            scope = "current-backend-intake-source-link-unavailable",
            originalInterfacesLinked = false,
            originalProducerObjectsSupplied = false
        });
        throw new InvalidOperationException("query_producer_intake_source_link_unavailable");
#endif
    }

#if QUERY_PRODUCER_INTAKE_LINKED
    internal static void ValidateLinkedQuerySourceCommit(string sourceCommit)
    {
        string? compiledQueryCommit = typeof(CanonicalQueryProducerIntake).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .SingleOrDefault(attribute => attribute.Key == "FsusBlog.QuerySourceCommit")?.Value;
        if (compiledQueryCommit != sourceCommit)
        {
            throw new InvalidOperationException("query_producer_intake_query_source_mismatch");
        }
    }

    // This is compiled API metadata, not an invocation, producer result or receipt.
    private static object DescribeOriginalResolvedHandoff()
    {
        MethodInfo handoff = typeof(DataScalePostgresArticleProducer).GetMethod(
            nameof(DataScalePostgresArticleProducer.ProduceAndConsumeResolvedAsync),
            BindingFlags.Static | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("original_postgres_resolved_handoff_missing");
        string[] storeMethods =
        [
            nameof(DataScaleBatchCheckpointStore.PersistNativeAllocationEvidenceAsync),
            nameof(DataScaleBatchCheckpointStore.VerifyNativeAllocationEvidenceAsync),
            nameof(DataScaleBatchCheckpointStore.ReadAsync)
        ];
        foreach (string method in storeMethods)
        {
            _ = typeof(DataScaleBatchCheckpointStore).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("original_postgres_handoff_store_contract_missing");
        }
        return new
        {
            scope = "compiled-original-resolved-handoff-contract-only",
            entrypoint = $"{handoff.DeclaringType!.FullName}.{handoff.Name}",
            parameterTypes = handoff.GetParameters().Select(parameter => parameter.ParameterType.ToString()),
            allocationStoreMethods = storeMethods,
            originalResolvedValuesSupplied = false,
            sameLiveConnectionCallbackInvoked = false,
            qualification = false,
            releaseEvidenceEligible = false
        };
    }

    /// <summary>
    /// For an original in-process owner supplying real objects. Both existing
    /// APIs retain their own physical/epoch/whole-plan/publication refusal gates.
    /// No JSON input or alternate receipt is introduced by this pass-through.
    /// </summary>
    internal static void RequireBeforeExpectedMapping(
        ArticleScaleGraphIdentityBindings? articleBindings,
        CommentScaleResolvedGraphIntent? commentIntent,
        DataScalePostgresArticleProduction? production,
        ArticleScalePlan? plan,
        ArticleScaleResolvedGraphBatch? resolvedBatch,
        DbConnection? connection,
        DataScaleBatchCheckpointIdentity? currentIdentity,
        ReadOnlySpan<byte> taskKey)
    {
        QueryProducerRoleIntake.Inspect(articleBindings, commentIntent).ThrowBeforeQueryExecution();
        QueryPostgresProducerIntake.Inspect(production, plan, resolvedBatch, connection, currentIdentity, taskKey)
            .ThrowBeforeQueryExecution();
    }
#endif
}
