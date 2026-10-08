using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.QueryEvidence;

/// <summary>
/// Compiled refusal controls over original producer parameter types. No producer
/// objects, fixture identities, expected results or receipts are constructed.
/// </summary>
internal static class QueryProducerRoleIntakeControls
{
    private static int Main()
    {
        try
        {
            Func<ArticleScaleGraphIdentityBindings?, CommentScaleResolvedGraphIntent?, QueryProducerRoleInspection> inspect
                = QueryProducerRoleIntake.Inspect;
            QueryProducerRoleInspection missing = inspect(null, null);
            string[] requiredBlockers =
            [
                "article_native_identity_bindings_missing",
                "comment_resolved_graph_intent_missing",
                "article_physical_graph_receipt_intake_missing",
                "comment_physical_graph_receipt_and_query_coordinates_missing"
            ];
            Require(missing.ArticleBindings is null && missing.CommentIntent is null,
                "Missing original inputs must remain absent.");
            Require(missing.Blockers.SequenceEqual(requiredBlockers),
                "Both missing-input and both physical-intake blockers must survive.");
            RequireRefusal(missing);
            RequireBlockedBeforeSubsequentStatement(missing);

            var emptyBlockers = new QueryProducerRoleInspection(null, null, Array.Empty<string>());
            RequireRefusal(emptyBlockers);
            RequireBlockedBeforeSubsequentStatement(emptyBlockers);

            QueryPostgresProducerInspection missingPostgres = QueryPostgresProducerIntake.Inspect(
                null, null, null, null, null, ReadOnlySpan<byte>.Empty);
            string[] requiredPostgresBlockers =
            [
                "postgres_article_production_missing",
                "article_canonical_plan_missing",
                "article_resolved_graph_batch_missing",
                "article_current_postgres_connection_missing",
                "article_current_checkpoint_identity_missing",
                "article_checkpoint_authentication_key_missing",
                "article_native_allocation_persistence_receipt_missing",
                "article_query_epoch_fixture_generation_and_seed_receipt_binding_missing",
                "article_whole_plan_materialization_receipt_missing",
                "article_signed_audit_and_complete_seed_acceptance_missing",
                "article_actual_publication_result_and_current_invocation_missing"
            ];
            Require(missingPostgres.Production is null && missingPostgres.ResolvedBatch is null
                && missingPostgres.CurrentIdentity is null && !missingPostgres.ComponentBindingsMatched,
                "Absent PostgreSQL producer inputs cannot become matched components.");
            Require(missingPostgres.Blockers.SequenceEqual(requiredPostgresBlockers),
                "All PostgreSQL missing-input and physical admission blockers must survive.");
            RequireRefusal(missingPostgres);
            RequireBlockedBeforeSubsequentStatement(missingPostgres);
            var emptyPostgresBlockers = new QueryPostgresProducerInspection(null, null, null, true, Array.Empty<string>());
            RequireRefusal(emptyPostgresBlockers);
            RequireBlockedBeforeSubsequentStatement(emptyPostgresBlockers);
            Console.WriteLine("PASS: null producer inputs preserve all four blockers.");
            Console.WriteLine("PASS: refusal prevents the subsequent statement.");
            Console.WriteLine("PASS: manually empty blockers cannot authorize queries.");
            Console.WriteLine("PASS: null PostgreSQL inputs preserve all eleven blockers without matching components.");
            Console.WriteLine("PASS: PostgreSQL refusal prevents the subsequent statement.");
            Console.WriteLine("PASS: manually empty PostgreSQL blockers cannot authorize queries.");
            Console.WriteLine("Scope: compiled refusal controls only; qualification and release eligibility are false.");
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"FAIL: {exception.GetType().Name}: {exception.Message}");
            return 1;
        }
    }

    private static void RequireRefusal(QueryProducerRoleInspection inspection)
    {
        Require(!inspection.CanExecuteQueries, "Original components cannot authorize query execution.");
        Require(!inspection.Qualification, "Source diagnostics cannot qualify product behavior.");
        Require(!inspection.ReleaseEvidenceEligible, "Source diagnostics cannot qualify release evidence.");
    }

    private static void RequireBlockedBeforeSubsequentStatement(QueryProducerRoleInspection inspection)
    {
        bool subsequentStatementReached = false;
        bool refused = false;
        try
        {
            inspection.ThrowBeforeQueryExecution();
            subsequentStatementReached = true;
        }
        catch (InvalidOperationException exception)
        {
            Require(exception.Message.StartsWith("query_producer_role_intake_blocked:", StringComparison.Ordinal),
                "Refusal must retain its dedicated failure code.");
            refused = true;
        }
        Require(refused && !subsequentStatementReached, "Refusal must stop the subsequent statement.");
    }

    private static void RequireRefusal(QueryPostgresProducerInspection inspection)
    {
        Require(!inspection.CanExecuteQueries, "PostgreSQL component linkage cannot authorize query execution.");
        Require(!inspection.Qualification, "PostgreSQL component linkage cannot qualify product behavior.");
        Require(!inspection.ReleaseEvidenceEligible, "PostgreSQL component linkage cannot qualify release evidence.");
    }

    private static void RequireBlockedBeforeSubsequentStatement(QueryPostgresProducerInspection inspection)
    {
        bool subsequentStatementReached = false;
        bool refused = false;
        try
        {
            inspection.ThrowBeforeQueryExecution();
            subsequentStatementReached = true;
        }
        catch (InvalidOperationException exception)
        {
            Require(exception.Message.StartsWith("query_postgres_producer_intake_blocked:", StringComparison.Ordinal),
                "PostgreSQL refusal must retain its dedicated failure code.");
            refused = true;
        }
        Require(refused && !subsequentStatementReached, "PostgreSQL refusal must stop the subsequent statement.");
    }

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }
}
