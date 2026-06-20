using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryAnonymousCredentialEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/anonymous-credential/root", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAnonymousCredentialRootService rootService,
            CancellationToken cancellationToken) =>
            await HandleAnonymousCredentialRootAsync(httpContext, aeds, rootService, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read");

        group.MapGet("/anonymous-credential/circuit", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAnonymousCredentialRootService rootService,
            CancellationToken cancellationToken) =>
            await HandleAnonymousCredentialRootAsync(httpContext, aeds, rootService, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read");

        group.MapPost("/anonymous-credential/revocation-witness", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAnonymousCredentialRevocationWitnessService witnessService,
            CancellationToken cancellationToken) =>
            await HandleAnonymousCredentialRevocationWitnessAsync(httpContext, aeds, witnessService, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .RequireNoStoreResponse()
        .RequireStrongAnonymousRequest();

        group.MapPost("/anonymous-credential/issue", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAnonymousCredentialIssuerService issuer,
            CancellationToken cancellationToken) =>
            await HandleAnonymousCredentialIssueAsync(httpContext, aeds, issuer, cancellationToken))
        .RequireAuthorization()
        .RequireRateLimiting("fixed_ip")
        .RequireNoStoreResponse();
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousCredentialRootAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAnonymousCredentialRootService rootService,
        CancellationToken cancellationToken)
    {
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, StatusCodes.Status406NotAcceptable);
        }

        Result<AnonymousCredentialRootSnapshotCoreModel> root = await rootService.GetCurrentSnapshotAsync(cancellationToken);
        if (!root.IsSuccess)
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(root.Error.Code, string.IsNullOrWhiteSpace(root.Error.Message) ? "anonymous_root_unavailable" : root.Error.Message),
                aeds,
                StatusCodes.Status503ServiceUnavailable);
        }

        AnonymousCredentialRootSnapshotCoreModel snapshot = root.Value;
        return BinaryResults.Frame(
            aeds,
            AedsFrameType.AnonymousCredentialRootSnapshot,
            writer => PodBinaryCodec.WriteAnonymousCredentialRootSnapshot(snapshot, writer));
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousCredentialRevocationWitnessAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAnonymousCredentialRevocationWitnessService witnessService,
        CancellationToken cancellationToken)
    {
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, StatusCodes.Status406NotAcceptable);
        }

        BinaryRequestPayload payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.AnonymousCredentialRevocationWitnessRequest,
            cancellationToken,
            AnonymousCredentialRevocationWitnessLimits.MaxRequestFrameBytes);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeAnonymousCredentialRevocationWitnessRequest(
                payload.Payload,
                out AnonymousCredentialRevocationWitnessRequestCoreModel request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "anonymous_credential_revocation_witness_request_invalid"), aeds);
        }

        Result<AnonymousCredentialRevocationWitnessResponseCoreModel> witness =
            await witnessService.CreateWitnessAsync(request, cancellationToken);
        return witness.IsSuccess && witness.Value is { } response
            ? BinaryResults.Frame(
                aeds,
                AedsFrameType.AnonymousCredentialRevocationWitnessResponse,
                writer => PodBinaryCodec.WriteAnonymousCredentialRevocationWitnessResponse(response, writer))
            : BinaryResults.FromError(witness.Error, aeds);
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousCredentialIssueAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAnonymousCredentialIssuerService issuer,
        CancellationToken cancellationToken)
    {
        if (!AcceptsBinaryResponse(httpContext.Request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), aeds, StatusCodes.Status406NotAcceptable);
        }

        int userId = httpContext.GetUserId();
        if (userId <= 0)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "anonymous_credential_auth_required"), aeds, StatusCodes.Status401Unauthorized);
        }

        BinaryRequestPayload payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.AnonymousCredentialIssueRequest,
            cancellationToken,
            AnonymousCredentialIssuerLimits.MaxIssueRequestFrameBytes);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeAnonymousCredentialIssueRequest(payload.Payload, out AnonymousCredentialIssueRequestCoreModel request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "anonymous_credential_issue_request_invalid"), aeds);
        }

        Result<AnonymousCredentialIssueResponseCoreModel> issued = await issuer.IssueAsync(
            userId,
            request,
            httpContext.TraceIdentifier,
            cancellationToken);
        return issued.IsSuccess && issued.Value is { } response
            ? BinaryResults.Frame(aeds, AedsFrameType.AnonymousCredentialIssueResponse, writer => PodBinaryCodec.WriteAnonymousCredentialIssueResponse(response, writer))
            : BinaryResults.FromError(issued.Error, aeds);
    }
}
