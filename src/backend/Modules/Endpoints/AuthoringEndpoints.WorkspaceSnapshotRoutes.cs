using FsusBlog.Contracts.AuthoringWorkspace;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.AuthoringWorkspace;

namespace FsusBlog.Server.Modules.Endpoints;

public static partial class AuthoringEndpoints
{
    private static void MapWorkspaceSnapshotRoutes(IEndpointRouteBuilder group)
    {
        RouteGroupBuilder workspace = group.MapGroup("/workspace")
            .RequireAdminPermission(AdminPermissions.ArticleWrite)
            .RequireNoStoreResponse()
            .AddEndpointFilterWithMetadata<WorkspaceSnapshotBoundaryFilter>();
        workspace.MapGet("/default", static async Task<BinaryFrameResult> (
            HttpContext context, IAedsEncoder aeds, AuthoringWorkspaceSnapshotTransport transport,
            CancellationToken cancellationToken) =>
        {
            AuthoringWorkspaceSnapshotResponse result = await transport.ReadAsync(
                WorkspaceSnapshotScope(context), cancellationToken).ConfigureAwait(false);
            return WorkspaceSnapshotFrame(aeds, result);
        })
        .WithName("binary_author_workspace_snapshot_read")
        .WithMetadata(new FsusOpenApiAedsContractMetadata(null, AedsFrameType.AuthoringWorkspaceSnapshotResponse));

        workspace.MapPost("/default", static async Task<BinaryFrameResult> (
            HttpContext context, IAedsEncoder aeds, IBinaryEndpointRequestContext binder,
            AuthoringWorkspaceSnapshotTransport transport, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await binder.ReadFrameAsync(context, aeds,
                AedsFrameType.AuthoringWorkspaceSnapshotRequest, cancellationToken,
                maxFrameBytes: AuthoringWorkspaceSnapshotContract.MaxBytes + 32).ConfigureAwait(false);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeAuthoringWorkspaceSnapshotRequest(payload.Payload,
                out AuthoringWorkspaceSnapshotRequest request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "workspace_snapshot_binary_request_invalid"), aeds);
            }
            AuthoringWorkspaceSnapshotResponse result = await transport.MutateAsync(
                WorkspaceSnapshotScope(context), request, cancellationToken).ConfigureAwait(false);
            return WorkspaceSnapshotFrame(aeds, result);
        })
        .WithName("binary_author_workspace_snapshot_mutate")
        .WithMetadata(new FsusOpenApiAedsContractMetadata(
            AedsFrameType.AuthoringWorkspaceSnapshotRequest, AedsFrameType.AuthoringWorkspaceSnapshotResponse))
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();
    }

    private static AuthoringWorkspaceSnapshotScope WorkspaceSnapshotScope(HttpContext context)
        // The current Server is a single-site authority. This is the same stable site
        // namespace used by its private Canvas/property owners, rather than a request URL.
        => new(ResolveRequiredAdminPrincipalId(context), "primary-site");

    private static BinaryFrameResult WorkspaceSnapshotFrame(IAedsEncoder aeds,
        AuthoringWorkspaceSnapshotResponse result)
        => BinaryResults.Frame(aeds, AedsFrameType.AuthoringWorkspaceSnapshotResponse,
            destination => PodBinaryCodec.WriteAuthoringWorkspaceSnapshotResponse(result, destination));

    private sealed class WorkspaceSnapshotBoundaryFilter(IAedsEncoder aeds) : IEndpointFilter
    {
        public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context,
            EndpointFilterDelegate next)
        {
            HttpContext http = context.HttpContext;
            http.Response.Headers.CacheControl = "private, no-store";
            if (!http.User.IsAdminPrincipal() || !http.User.TryGetAdminPrincipalId(out long actorId)
                || actorId <= 0 || string.IsNullOrWhiteSpace(http.User.GetAdminSessionId()))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized,
                    "admin_session_required"), aeds);
            }
            try
            {
                return await next(context).ConfigureAwait(false);
            }
            catch (AuthoringWorkspaceSnapshotException error)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, error.Reason), aeds);
            }
        }
    }
}
