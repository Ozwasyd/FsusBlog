using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Models.Dtos;

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
            CancellationToken cancellationToken) =>
        {
            var response = await proofAdapter.CreateChallengeAsync(
                context,
                new HumanReadChallengeRequest(scope, routeKey, articleId),
                cancellationToken);

            return Results.Ok(JsonApiResponse<HumanReadChallengeResponse>.Ok(
                response ?? CreateRejectedChallenge(scope, routeKey, articleId)));
        });

        group.MapPost("/submit", async (
            HumanReadSubmitRequest request,
            HttpContext context,
            IHumanReadProofEndpointAdapter proofAdapter,
            CancellationToken cancellationToken) =>
        {
            HumanReadSubmitResponse response = await proofAdapter.SubmitAsync(context, request, cancellationToken);
            return Results.Ok(JsonApiResponse<HumanReadSubmitResponse>.Ok(response));
        });

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
}
