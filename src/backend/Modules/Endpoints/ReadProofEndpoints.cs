using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Modules.Endpoints;

public static class ReadProofEndpoints
{
    private const int DefaultMinDwellMs = 8000;
    private const int MaxRouteKeyLength = 200;

    public static IEndpointRouteBuilder MapReadProofEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/read-proof")
            .WithTags("ReadProof")
            .AllowAnonymous();

        group.MapGet("/challenge", async (
            string scope,
            string routeKey,
            int? articleId,
            HttpContext context,
            IHumanReadProofEndpointAdapter proofAdapter,
            ISecurityRiskSignalSink riskSignalSink,
            CancellationToken cancellationToken) =>
        {
            var response = await proofAdapter.CreateChallengeAsync(
                context,
                new HumanReadChallengeRequest(scope, routeKey, articleId),
                cancellationToken);
            if (response is null)
            {
                await riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
                    context,
                    SecurityRiskReason.ReadProofRejected,
                    5,
                    TimeSpan.FromMinutes(10),
                    SecurityRiskSources.HumanReadProof,
                    "read_proof_rejected",
                    "challenge_rejected"), cancellationToken);
            }

            return Results.Ok(JsonApiResponse<HumanReadChallengeResponse>.Ok(
                response ?? CreateRejectedChallenge(scope, routeKey, articleId)));
        }).RequireRateLimiting("read_proof");

        group.MapPost("/submit", async (
            HumanReadSubmitRequest request,
            HttpContext context,
            IHumanReadProofEndpointAdapter proofAdapter,
            ISecurityRiskSignalSink riskSignalSink,
            CancellationToken cancellationToken) =>
        {
            HumanReadSubmitResponse response = await proofAdapter.SubmitAsync(context, request, cancellationToken);
            if (!response.Counted && ShouldScoreRejectedSubmit(response.Status))
            {
                await riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
                    context,
                    SecurityRiskReason.ReadProofRejected,
                    ReadProofRiskScore(response.Status),
                    TimeSpan.FromMinutes(10),
                    SecurityRiskSources.HumanReadProof,
                    "read_proof_rejected",
                    response.Status), cancellationToken);
            }

            return Results.Ok(JsonApiResponse<HumanReadSubmitResponse>.Ok(response));
        }).RequireRateLimiting("read_proof");

        return app;
    }

    private static HumanReadChallengeResponse CreateRejectedChallenge(string scope, string routeKey, int? articleId)
    {
        string normalizedScope = string.Equals(scope, "article", StringComparison.OrdinalIgnoreCase)
            ? "article"
            : "site";
        string normalizedRouteKey = string.IsNullOrWhiteSpace(routeKey)
            ? normalizedScope
            : routeKey.Trim();
        if (normalizedRouteKey.Length > MaxRouteKeyLength)
        {
            normalizedRouteKey = normalizedRouteKey[..MaxRouteKeyLength];
        }

        int? normalizedArticleId = normalizedScope == "article" && articleId is > 0
            ? articleId
            : null;
        DateTimeOffset now = DateTimeOffset.UtcNow;
        return new HumanReadChallengeResponse(
            string.Empty,
            normalizedScope,
            normalizedRouteKey,
            normalizedArticleId,
            DefaultMinDwellMs,
            now,
            now);
    }

    private static bool ShouldScoreRejectedSubmit(string status)
        => !string.Equals(status, "paused", StringComparison.Ordinal)
            && !string.Equals(status, "duplicate_viewer", StringComparison.Ordinal);

    private static int ReadProofRiskScore(string status)
        => status switch
        {
            "proof_replayed" => 20,
            "proof_binding_mismatch" => 10,
            "fetch_metadata_invalid" => 10,
            "origin_invalid" => 10,
            "fingerprint_missing" => 5,
            _ => 5
        };
}
