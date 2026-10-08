using System.Globalization;

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
using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>Private AEDS-only routes backed by the single document and operation authorities.</summary>
public static class AuthoringCanvasEndpoints
{
    /// <summary>Registers typed routes inside the existing authenticated authoring group.</summary>
    public static void MapAuthoringCanvasRoutes(IEndpointRouteBuilder group)
    {
        group.MapGet("/canvases", async (HttpContext context, IAedsEncoder aeds, AuthoringCanvasTransport service, CancellationToken cancellationToken) =>
        {
            AuthoringCanvasListResponse value = await service.ListAsync(Owner(context), Cursor(context), Limit(context, 100), cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthoringCanvasListResponse, writer => PodBinaryCodec.WriteAuthoringCanvasListResponse(value, writer));
        })
        .WithName("binary_author_canvas_list")
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("limit", "query://int32", Required: false, Nullable: false))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("cursorOrder", "query://int64", Required: false, Nullable: true))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("cursorId", "query://string", Required: false, Nullable: true))
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .WithMetadata(new FsusOpenApiAedsContractMetadata(null, AedsFrameType.AuthoringCanvasListResponse))
        .AddEndpointFilterWithMetadata<AuthoringCanvasBoundaryFilter>();

        group.MapGet("/canvases/{canvasId:guid}", async (Guid canvasId, HttpContext context, IAedsEncoder aeds, AuthoringCanvasTransport service, CancellationToken cancellationToken) =>
        {
            AuthoringCanvasDocumentHeader value = await service.GetAsync(Owner(context), canvasId, cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthoringCanvasDocumentHeader, writer => PodBinaryCodec.WriteAuthoringCanvasDocumentHeader(value, writer));
        })
        .WithName("binary_author_canvas_header")
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .WithMetadata(new FsusOpenApiAedsContractMetadata(null, AedsFrameType.AuthoringCanvasDocumentHeader))
        .AddEndpointFilterWithMetadata<AuthoringCanvasBoundaryFilter>();

        group.MapGet("/canvases/{canvasId:guid}/nodes", async (Guid canvasId, HttpContext context, IAedsEncoder aeds, AuthoringCanvasTransport service, CancellationToken cancellationToken) =>
        {
            AuthoringCanvasNodesResponse value = await service.ReadNodesAsync(Owner(context), canvasId, Cursor(context), Limit(context, 256), cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthoringCanvasNodesResponse, writer => PodBinaryCodec.WriteAuthoringCanvasNodesResponse(value, writer));
        })
        .WithName("binary_author_canvas_nodes")
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("limit", "query://int32", Required: false, Nullable: false))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("cursorOrder", "query://int64", Required: false, Nullable: true))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("cursorId", "query://string", Required: false, Nullable: true))
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .WithMetadata(new FsusOpenApiAedsContractMetadata(null, AedsFrameType.AuthoringCanvasNodesResponse))
        .AddEndpointFilterWithMetadata<AuthoringCanvasBoundaryFilter>();

        group.MapGet("/canvases/{canvasId:guid}/edges", async (Guid canvasId, HttpContext context, IAedsEncoder aeds, AuthoringCanvasTransport service, CancellationToken cancellationToken) =>
        {
            AuthoringCanvasEdgesResponse value = await service.ReadEdgesAsync(Owner(context), canvasId, Cursor(context), Limit(context, 256), cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthoringCanvasEdgesResponse, writer => PodBinaryCodec.WriteAuthoringCanvasEdgesResponse(value, writer));
        })
        .WithName("binary_author_canvas_edges")
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("limit", "query://int32", Required: false, Nullable: false))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("cursorOrder", "query://int64", Required: false, Nullable: true))
        .WithMetadata(new FsusOpenApiQueryParameterMetadata("cursorId", "query://string", Required: false, Nullable: true))
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .WithMetadata(new FsusOpenApiAedsContractMetadata(null, AedsFrameType.AuthoringCanvasEdgesResponse))
        .AddEndpointFilterWithMetadata<AuthoringCanvasBoundaryFilter>();

        group.MapGet("/canvases/{canvasId:guid}/history", async (Guid canvasId, HttpContext context, IAedsEncoder aeds, AuthoringCanvasTransport service, CancellationToken cancellationToken) =>
        {
            AuthoringCanvasHistoryResponse value = await service.ReadHistoryAsync(Owner(context), canvasId, cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthoringCanvasHistoryResponse, writer => PodBinaryCodec.WriteAuthoringCanvasHistoryResponse(value, writer));
        })
        .WithName("binary_author_canvas_history")
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .WithMetadata(new FsusOpenApiAedsContractMetadata(null, AedsFrameType.AuthoringCanvasHistoryResponse))
        .AddEndpointFilterWithMetadata<AuthoringCanvasBoundaryFilter>();

        group.MapPost("/canvases", async (HttpContext context, IAedsEncoder aeds, IBinaryEndpointRequestContext binder, AuthoringCanvasTransport service, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await binder.ReadFrameAsync(context, aeds,
                AedsFrameType.AuthoringCanvasCreateRequest, cancellationToken, maxFrameBytes: 8 * 1024 * 1024);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeAuthoringCanvasCreateRequest(payload.Payload, out AuthoringCanvasCreateRequest request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "canvas_binary_request_invalid"), aeds);
            }
            AuthoringCanvasDocumentHeader value = await service.CreateAsync(Owner(context), request, cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthoringCanvasDocumentHeader, writer => PodBinaryCodec.WriteAuthoringCanvasDocumentHeader(value, writer));
        })
        .WithName("binary_author_canvas_create")
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.AuthoringCanvasCreateRequest, AedsFrameType.AuthoringCanvasDocumentHeader))
        .AddEndpointFilterWithMetadata<AuthoringCanvasBoundaryFilter>()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapPost("/canvases/{canvasId:guid}/prepare", async Task<IResult> (Guid canvasId, HttpContext context, IAedsEncoder aeds, IBinaryEndpointRequestContext binder, AuthoringCanvasTransport service, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await binder.ReadFrameAsync(context, aeds,
                AedsFrameType.AuthoringCanvasApplyRequest, cancellationToken, maxFrameBytes: 8 * 1024 * 1024);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeAuthoringCanvasApplyRequest(payload.Payload, out AuthoringCanvasApplyRequest request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "canvas_binary_request_invalid"), aeds);
            }
            AuthoringCanvasApplyRequest value = await service.PrepareAsync(Owner(context), canvasId, request, cancellationToken);
            byte[] prepared;
            try
            {
                prepared = PodBinaryCodec.EncodeAuthoringCanvasApplyRequest(value);
            }
            catch (ArgumentException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "canvas_preparation_payload_budget_exceeded"), aeds);
            }
            if (prepared.Length > 8 * 1024 * 1024 - FsusBlog.Shared.AedsFrameHeader.Size)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "canvas_preparation_payload_budget_exceeded"), aeds);
            }
            return BinaryResults.FrameRaw(aeds, AedsFrameType.AuthoringCanvasApplyRequest, prepared);
        })
        .WithName("binary_author_canvas_prepare")
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.AuthoringCanvasApplyRequest, AedsFrameType.AuthoringCanvasApplyRequest))
        .AddEndpointFilterWithMetadata<AuthoringCanvasBoundaryFilter>()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapPost("/canvases/{canvasId:guid}/operations", async (Guid canvasId, HttpContext context, IAedsEncoder aeds, IBinaryEndpointRequestContext binder, AuthoringCanvasTransport service, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await binder.ReadFrameAsync(context, aeds,
                AedsFrameType.AuthoringCanvasApplyRequest, cancellationToken, maxFrameBytes: 8 * 1024 * 1024);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeAuthoringCanvasApplyRequest(payload.Payload, out AuthoringCanvasApplyRequest request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "canvas_binary_request_invalid"), aeds);
            }
            AuthoringCanvasOperationReceipt value = await service.ApplyAsync(Owner(context), canvasId, request, cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthoringCanvasOperationReceipt, writer => PodBinaryCodec.WriteAuthoringCanvasOperationReceipt(value, writer));
        })
        .WithName("binary_author_canvas_apply")
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.AuthoringCanvasApplyRequest, AedsFrameType.AuthoringCanvasOperationReceipt))
        .AddEndpointFilterWithMetadata<AuthoringCanvasBoundaryFilter>()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapPost("/canvases/{canvasId:guid}/history", async (Guid canvasId, HttpContext context, IAedsEncoder aeds, IBinaryEndpointRequestContext binder, AuthoringCanvasTransport service, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await binder.ReadFrameAsync(context, aeds,
                AedsFrameType.AuthoringCanvasUndoRedoRequest, cancellationToken, maxFrameBytes: 8 * 1024 * 1024);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeAuthoringCanvasUndoRedoRequest(payload.Payload, out AuthoringCanvasUndoRedoRequest request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "canvas_binary_request_invalid"), aeds);
            }
            AuthoringCanvasOperationReceipt value = await service.ApplyHistoryAsync(Owner(context), canvasId, request, cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthoringCanvasOperationReceipt, writer => PodBinaryCodec.WriteAuthoringCanvasOperationReceipt(value, writer));
        })
        .WithName("binary_author_canvas_history_apply")
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.AuthoringCanvasUndoRedoRequest, AedsFrameType.AuthoringCanvasOperationReceipt))
        .AddEndpointFilterWithMetadata<AuthoringCanvasBoundaryFilter>()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapDelete("/canvases/{canvasId:guid}", async (Guid canvasId, HttpContext context, IAedsEncoder aeds, IBinaryEndpointRequestContext binder, AuthoringCanvasTransport service, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await binder.ReadFrameAsync(context, aeds,
                AedsFrameType.AuthoringCanvasDeleteRequest, cancellationToken, maxFrameBytes: 8 * 1024 * 1024);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeAuthoringCanvasDeleteRequest(payload.Payload, out AuthoringCanvasDeleteRequest request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "canvas_binary_request_invalid"), aeds);
            }
            AuthoringCanvasWriteReceipt value = await service.DeleteAsync(Owner(context), canvasId, request, cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthoringCanvasWriteReceipt, writer => PodBinaryCodec.WriteAuthoringCanvasWriteReceipt(value, writer));
        })
        .WithName("binary_author_canvas_delete")
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.AuthoringCanvasDeleteRequest, AedsFrameType.AuthoringCanvasWriteReceipt))
        .AddEndpointFilterWithMetadata<AuthoringCanvasBoundaryFilter>()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapPost("/canvases/{canvasId:guid}/resolve", async (Guid canvasId, HttpContext context, IAedsEncoder aeds, IBinaryEndpointRequestContext binder, AuthoringCanvasTransport service, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await binder.ReadFrameAsync(context, aeds,
                AedsFrameType.AuthoringCanvasResolveRequest, cancellationToken, maxFrameBytes: 8 * 1024 * 1024);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeAuthoringCanvasResolveRequest(payload.Payload, out AuthoringCanvasResolveRequest request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "canvas_binary_request_invalid"), aeds);
            }
            AuthoringCanvasReferenceResolutionBatch value = await service.ResolveAsync(Owner(context), canvasId, request, cancellationToken);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthoringCanvasReferenceResolutionBatch, writer => PodBinaryCodec.WriteAuthoringCanvasReferenceResolutionBatch(value, writer));
        })
        .WithName("binary_author_canvas_resolve")
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.AuthoringCanvasResolveRequest, AedsFrameType.AuthoringCanvasReferenceResolutionBatch))
        .AddEndpointFilterWithMetadata<AuthoringCanvasBoundaryFilter>()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

    }

    internal static AuthoringCanvasOwner Owner(HttpContext context)
    {
        if (!context.User.IsAdminPrincipal() || !context.User.TryGetAdminPrincipalId(out long principalId)
            || string.IsNullOrWhiteSpace(context.User.GetAdminSessionId()))
        {
            throw new AuthoringCanvasAccessDeniedException();
        }
        return new AuthoringCanvasOwner(principalId, "primary-site");
    }

    private static int Limit(HttpContext context, int maximum)
    {
        if (!context.Request.Query.TryGetValue("limit", out var raw))
        {
            return maximum;
        }
        if (!int.TryParse(raw.ToString(), NumberStyles.None, CultureInfo.InvariantCulture, out int limit)
            || limit < 1 || limit > maximum)
        {
            throw new AuthoringCanvasValidationException("canvas_page_limit_invalid");
        }
        return limit;
    }

    private static AuthoringCanvasPageCursor? Cursor(HttpContext context)
    {
        bool hasOrder = context.Request.Query.TryGetValue("cursorOrder", out var orderText);
        bool hasId = context.Request.Query.TryGetValue("cursorId", out var idText);
        if (!hasOrder && !hasId)
        {
            return null;
        }
        if (!hasOrder || !hasId
            || !long.TryParse(orderText.ToString(), NumberStyles.None, CultureInfo.InvariantCulture, out long order)
            || order < 0 || !Guid.TryParseExact(idText.ToString(), "D", out Guid id) || id == Guid.Empty)
        {
            throw new AuthoringCanvasValidationException("canvas_page_cursor_invalid");
        }
        return new AuthoringCanvasPageCursor(order, id);
    }

    private sealed class AuthoringCanvasBoundaryFilter(IAedsEncoder aeds) : IEndpointFilter
    {
        public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
        {
            HttpContext http = context.HttpContext;
            http.Response.Headers.CacheControl = "private, no-store";
            if (!http.User.IsAdminPrincipal() || !http.User.TryGetAdminPrincipalId(out _)
                || string.IsNullOrWhiteSpace(http.User.GetAdminSessionId()))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "admin_session_required"), aeds);
            }
            try
            {
                return await next(context);
            }
            catch (AuthoringCanvasAccessDeniedException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "authoring_canvas_unavailable"), aeds);
            }
            catch (AuthoringCanvasValidationException error)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, error.Code), aeds);
            }
            catch (AuthoringCanvasBudgetExceededException error)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, error.Code), aeds);
            }
            catch (AuthoringCanvasRevisionConflictException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Conflict, "authoring_canvas_revision_conflict"), aeds);
            }
            catch (AuthoringCanvasIdempotencyConflictException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Conflict, "authoring_canvas_idempotency_conflict"), aeds);
            }
            catch (AuthoringCanvasHistoryConflictException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Conflict, "authoring_canvas_history_conflict"), aeds);
            }
        }
    }
}
