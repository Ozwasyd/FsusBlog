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
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Shared.Contracts.AuthoringPreferences;

namespace FsusBlog.Server.Modules.Endpoints;

public static partial class AuthoringEndpoints
{
    // The existing POD is 80 bytes. The original binder also checks exact frame length and CRC.
    private const int WritingAidPreferenceRequestFrameBytes = 80 + AedsFrameHeader.Size;

    internal static void MapWritingAidPreferenceRoutes(IEndpointRouteBuilder group)
    {
        RouteGroupBuilder preferences = group.MapGroup("/preferences/writing-aids")
            .RequireAdminPermission(AdminPermissions.ArticleWrite)
            .RequireNoStoreResponse()
            .AddEndpointFilterWithMetadata<WritingAidPreferenceBoundaryFilter>();

        preferences.MapGet("", ReadWritingAidPreferenceAsync)
            .WithName("binary_author_writing_aid_preference_read")
            .WithMetadata(new FsusOpenApiAedsContractMetadata(
                null, AedsFrameType.WritingAidPreferenceSnapshotResponse));

        preferences.MapPut("", static (
            HttpContext context, IAedsEncoder aeds, IBinaryEndpointRequestContext binder,
            CancellationToken cancellationToken) =>
                RefuseWritingAidPreferenceMutationAsync(context, aeds, binder, false, cancellationToken))
            .WithName("binary_author_writing_aid_preference_update")
            .WithMetadata(new FsusOpenApiAedsContractMetadata(
                AedsFrameType.WritingAidPreferenceUpdateRequest, AedsFrameType.WritingAidPreferenceReceiptResponse))
            .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        preferences.MapPost("/initialize", static (
            HttpContext context, IAedsEncoder aeds, IBinaryEndpointRequestContext binder,
            CancellationToken cancellationToken) =>
                RefuseWritingAidPreferenceMutationAsync(context, aeds, binder, true, cancellationToken))
            .WithName("binary_author_writing_aid_preference_initialize")
            .WithMetadata(new FsusOpenApiAedsContractMetadata(
                AedsFrameType.WritingAidPreferenceUpdateRequest, AedsFrameType.WritingAidPreferenceReceiptResponse))
            .AddEndpointFilterWithMetadata<RequiresPowFilter>();
    }

    private static async Task<BinaryFrameResult> ReadWritingAidPreferenceAsync(
        HttpContext context, IAedsEncoder aeds, IWritingAidPreferenceReader preferences,
        CancellationToken cancellationToken)
    {
        WritingAidPreferenceOwner owner = WritingAidPreferenceRequestOwner(context);
        WritingAidPreferenceResult result = await preferences.GetWritingAidPreferenceAsync(
            owner, cancellationToken).ConfigureAwait(false);
        return WritingAidPreferenceResultFrame(aeds, owner, result, false);
    }

    private static async Task<BinaryFrameResult> RefuseWritingAidPreferenceMutationAsync(
        HttpContext context, IAedsEncoder aeds, IBinaryEndpointRequestContext binder,
        bool initialize, CancellationToken cancellationToken)
    {
        _ = WritingAidPreferenceRequestOwner(context);
        using BinaryRequestPayload payload = await binder.ReadFrameAsync(context, aeds,
            AedsFrameType.WritingAidPreferenceUpdateRequest, cancellationToken,
            maxFrameBytes: WritingAidPreferenceRequestFrameBytes).ConfigureAwait(false);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }
        if (!PodBinaryCodec.TryDecodeWritingAidPreferenceUpdateRequest(payload.Payload, out var update)
            || initialize && (update!.ExpectedRevision != 0 || update.Values != WritingAidPreferenceContract.Defaults))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                "writing_aid_preference_request_invalid"), aeds);
        }

        cancellationToken.ThrowIfCancellationRequested();
        // Neither session metadata nor GetDeviceFingerprint verifies the current device.
        // UpdateWritingAidPreferenceAsync / InitializeWritingAidPreferenceAsync require
        // an owner/site/session-bound, server-verified device:<64 lowercase hex> scope.
        // Until that authority is available, do not call either command or issue a receipt.
        return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure,
            "writing_aid_preference_device_authority_unavailable"), aeds,
            ApiErrorTransportMappingId.Generic503InfraFailure);
    }

    private static WritingAidPreferenceOwner WritingAidPreferenceRequestOwner(HttpContext context)
    {
        // Reuse the current Server's verified author/session and site helper. An admin
        // is a distinct preference owner even if an account has the same numeric ID.
        var author = AuthoringCanvasEndpoints.Owner(context);
        return new("admin:" + author.AdminPrincipalId.ToString(CultureInfo.InvariantCulture), author.SiteScope);
    }

    internal static BinaryFrameResult WritingAidPreferenceResultFrame(
        IAedsEncoder aeds, WritingAidPreferenceOwner owner, WritingAidPreferenceResult result, bool mutation)
    {
        if (!result.Success)
        {
            return result.Outcome switch
            {
                WritingAidPreferenceOutcome.Invalid => BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Validation, "writing_aid_preference_request_invalid"), aeds),
                WritingAidPreferenceOutcome.RevisionConflict => BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Conflict, "writing_aid_preference_revision_conflict"), aeds),
                WritingAidPreferenceOutcome.IdempotencyConflict => BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Conflict, "writing_aid_preference_operation_conflict"), aeds),
                WritingAidPreferenceOutcome.Corrupt => BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "writing_aid_preference_integrity_failed"), aeds),
                _ => BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "writing_aid_preference_unavailable"), aeds,
                    ApiErrorTransportMappingId.Generic503InfraFailure)
            };
        }

        if (WritingAidPreferenceValidator.ValidateSnapshot(result.Snapshot, owner) != WritingAidPreferenceValidation.Valid
            || mutation && (!WritingAidPreferenceReceiptValidator.Validate(result.Receipt, owner)
                || result.Receipt!.Committed != result.Snapshot))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure,
                "writing_aid_preference_integrity_failed"), aeds);
        }

        return mutation
            ? BinaryResults.Frame(aeds, AedsFrameType.WritingAidPreferenceReceiptResponse,
                destination => PodBinaryCodec.WriteWritingAidPreferenceReceipt(result.Receipt!, destination))
            : BinaryResults.Frame(aeds, AedsFrameType.WritingAidPreferenceSnapshotResponse,
                destination => PodBinaryCodec.WriteWritingAidPreferenceSnapshot(result.Snapshot!, destination));
    }

    private sealed class WritingAidPreferenceBoundaryFilter(IAedsEncoder aeds) : IEndpointFilter
    {
        public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
        {
            HttpContext http = context.HttpContext;
            http.Response.Headers.CacheControl = "private, no-store";
            if (http.User.Identity?.IsAuthenticated != true || !http.User.IsAdminPrincipal()
                || !http.User.TryGetAdminPrincipalId(out long principalId)
                || principalId > WritingAidPreferenceContract.MaximumExactRevision
                || string.IsNullOrWhiteSpace(http.User.GetAdminSessionId()))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized,
                    "admin_session_required"), aeds);
            }
            return await next(context).ConfigureAwait(false);
        }
    }
}
