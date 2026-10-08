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
            Console.WriteLine("PASS: null producer inputs preserve all four blockers.");
            Console.WriteLine("PASS: refusal prevents the subsequent statement.");
            Console.WriteLine("PASS: manually empty blockers cannot authorize queries.");
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

    private static void Require(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }
}
