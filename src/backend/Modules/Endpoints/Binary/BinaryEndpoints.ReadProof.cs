using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private const int ReadProofDefaultMinDwellMs = 8000;
    private const int ReadProofMaxRouteKeyLength = 200;

    private static void MapBinaryReadProofEndpoints(IEndpointRouteBuilder group)
    {
        group.MapPost("/read-proof/challenge.aeds", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IHumanReadProofEndpointAdapter proofAdapter,
            ISecurityRiskSignalSink riskSignalSink,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            await HandleHumanReadChallengeAsync(httpContext, proofAdapter, riskSignalSink, aeds, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("read_proof");

        group.MapPost("/read-proof/submit.aeds", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IHumanReadProofEndpointAdapter proofAdapter,
            ISecurityRiskSignalSink riskSignalSink,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            await HandleHumanReadSubmitAsync(httpContext, proofAdapter, riskSignalSink, aeds, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("read_proof");
    }

    internal static async Task<BinaryFrameResult> HandleHumanReadChallengeAsync(
        HttpContext httpContext,
        IHumanReadProofEndpointAdapter proofAdapter,
        ISecurityRiskSignalSink riskSignalSink,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.HumanReadChallengeRequest, cancellationToken);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeHumanReadChallengeRequest(payload.Payload, out HumanReadChallengeRequest request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "read_proof_challenge_request_invalid"), aeds);
        }

        HumanReadChallengeResponse? response = await proofAdapter.CreateChallengeAsync(httpContext, request, cancellationToken);
        if (response is null)
        {
            await riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
                httpContext,
                SecurityRiskReason.ReadProofRejected,
                5,
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.HumanReadProof,
                "read_proof_rejected",
                "challenge_rejected"), cancellationToken);
        }

        response ??= CreateRejectedChallenge(request.Scope, request.RouteKey, request.ArticleId);
        return BinaryResults.Frame(aeds, AedsFrameType.HumanReadChallengeResponse, writer => PodBinaryCodec.WriteHumanReadChallengeResponse(response, writer));
    }

    internal static async Task<BinaryFrameResult> HandleHumanReadSubmitAsync(
        HttpContext httpContext,
        IHumanReadProofEndpointAdapter proofAdapter,
        ISecurityRiskSignalSink riskSignalSink,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.HumanReadSubmitRequest, cancellationToken);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeHumanReadSubmitRequest(payload.Payload, out HumanReadSubmitRequest request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "read_proof_submit_request_invalid"), aeds);
        }

        HumanReadSubmitResponse response = await proofAdapter.SubmitAsync(httpContext, request, cancellationToken);
        if (response.Counted)
        {
            await riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
                httpContext,
                SecurityRiskReason.ReadProofAccepted,
                -20,
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.HumanReadProof,
                RiskActionNames.PublicRead,
                response.Status), cancellationToken);
        }
        else if (ShouldScoreRejectedSubmit(response.Status))
        {
            await riskSignalSink.AddRiskAsync(new SecurityRiskSignal(
                httpContext,
                SecurityRiskReason.ReadProofRejected,
                ReadProofRiskScore(response.Status),
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.HumanReadProof,
                "read_proof_rejected",
                response.Status), cancellationToken);
        }

        return BinaryResults.Frame(aeds, AedsFrameType.HumanReadSubmitResponse, writer => PodBinaryCodec.WriteHumanReadSubmitResponse(response, writer));
    }

    private static HumanReadChallengeResponse CreateRejectedChallenge(string scope, string routeKey, int? articleId)
    {
        string normalizedScope = string.Equals(scope, "article", StringComparison.OrdinalIgnoreCase)
            ? "article"
            : "site";
        string normalizedRouteKey = string.IsNullOrWhiteSpace(routeKey)
            ? normalizedScope
            : routeKey.Trim();
        if (normalizedRouteKey.Length > ReadProofMaxRouteKeyLength)
        {
            normalizedRouteKey = normalizedRouteKey[..ReadProofMaxRouteKeyLength];
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
            ReadProofDefaultMinDwellMs,
            now,
            now);
    }

    private static bool ShouldScoreRejectedSubmit(string status)
        => !string.Equals(status, "paused", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(status, "duplicate_viewer", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(status, "dedup_unavailable", StringComparison.OrdinalIgnoreCase);

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
