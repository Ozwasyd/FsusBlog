using System.Collections.Concurrent;

using FsusBlog.Core.Common;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests;

// Keeps pre-existing storage-behavior tests on the production access boundary while
// their callers are migrated independently of the authorization-specific coverage.
internal static class UploadSessionTestAccessExtensions
{
    private const long TestOwnerAdminPrincipalId = 1;
    private static readonly ConcurrentDictionary<string, string> s_tokens = new(StringComparer.Ordinal);

    public static async Task<Result<UploadInitDto>> InitUploadSessionAsync(
        this FileService service,
        UploadInitRequestDto dto,
        CancellationToken cancellationToken = default)
    {
        Result<UploadInitDto> result = await service.InitUploadSessionAsync(TestOwnerAdminPrincipalId, dto, cancellationToken);
        if (result.IsSuccess && result.Value is not null)
        {
            s_tokens[result.Value.UploadId] = result.Value.UploadToken;
        }

        return result;
    }

    public static Task<Result<UploadStatusDto>> GetUploadStatusAsync(this FileService service, string uploadId, CancellationToken cancellationToken = default)
        => service.GetUploadStatusAsync(Access(uploadId), cancellationToken);

    public static Task<Result<UploadPartMapDto>> GetUploadPartMapAsync(this FileService service, string uploadId, CancellationToken cancellationToken = default)
        => service.GetUploadPartMapAsync(Access(uploadId), cancellationToken);

    public static Task<Result<UploadPartAckDto>> UploadPartAsync(this FileService service, string uploadId, int partNumber, long offset, IFormFile part, string? payloadHash, CancellationToken cancellationToken = default)
        => service.UploadPartAsync(Access(uploadId), partNumber, offset, part, payloadHash, cancellationToken);

    public static Task<Result<UploadCompleteDto>> CompleteUploadAsync(this FileService service, string uploadId, string? sha256, CancellationToken cancellationToken = default)
        => service.CompleteUploadAsync(Access(uploadId), sha256, cancellationToken);

    public static Task<Result<bool>> AbortUploadAsync(this FileService service, string uploadId, CancellationToken cancellationToken = default)
        => service.AbortUploadAsync(Access(uploadId), cancellationToken);

    private static UploadSessionAccess Access(string uploadId)
        => new(uploadId, TestOwnerAdminPrincipalId, s_tokens.TryGetValue(uploadId, out string? token) ? token : null);
}
