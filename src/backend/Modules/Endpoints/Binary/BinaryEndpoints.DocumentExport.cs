using System.Collections.Immutable;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

/// <summary>
/// Integration seam for the existing session/site, frozen-input and Shared AEDS
/// authorities. Implementations resolve identity from authenticated context,
/// freeze through the canonical input builder and encode registered frames only.
/// There is deliberately no JSON, browser-provided input or permissive default.
/// </summary>
public interface IDocumentExportEndpointBinding
{
    Task<DocumentExportJobActor> ResolveActorAsync(HttpContext context, CancellationToken cancellationToken);
    Task<(DocumentExportTask Task, DocumentExportFrozenInput Input)> FreezeRequestAsync(
        HttpContext context, DocumentExportJobActor actor, CancellationToken cancellationToken);
    Task<string> ReadTaskIdAsync(HttpContext context, CancellationToken cancellationToken);
    BinaryFrameResult WriteSnapshot(DocumentExportJobSnapshot snapshot, IAedsEncoder encoder);
    BinaryFrameResult WritePage(ImmutableArray<DocumentExportJobSnapshot> snapshots,
        int offset, int pageSize, IAedsEncoder encoder);
}

public static partial class BinaryEndpoints
{
    /// <summary>
    /// The generic endpoint-registration owner activates this domain only after
    /// its Shared frame codecs, binding and durable job authority are registered.
    /// </summary>
    private static void MapBinaryDocumentExportEndpoints(IEndpointRouteBuilder group)
    {
        group.MapPost("/document-export/request", HandleDocumentExportRequestAsync)
            .RequireAdminPermission(AdminPermissions.ArticleWrite)
            .AddEndpointFilterWithMetadata<RequiresPowFilter>();
        group.MapGet("/document-export/tasks", HandleDocumentExportListAsync)
            .RequireAdminPermission(AdminPermissions.ArticleWrite);
        group.MapPost("/document-export/status", HandleDocumentExportStatusAsync)
            .RequireAdminPermission(AdminPermissions.ArticleWrite);
        group.MapPost("/document-export/cancel", HandleDocumentExportCancelAsync)
            .RequireAdminPermission(AdminPermissions.ArticleWrite)
            .AddEndpointFilterWithMetadata<RequiresPowFilter>();
        group.MapPost("/document-export/retry", HandleDocumentExportRetryAsync)
            .RequireAdminPermission(AdminPermissions.ArticleWrite)
            .AddEndpointFilterWithMetadata<RequiresPowFilter>();
        group.MapPost("/document-export/delete", HandleDocumentExportDeleteAsync)
            .RequireAdminPermission(AdminPermissions.ArticleWrite)
            .AddEndpointFilterWithMetadata<RequiresPowFilter>();
        group.MapPost("/document-export/download", HandleDocumentExportDownloadAsync)
            .RequireAdminPermission(AdminPermissions.ArticleWrite)
            .AddEndpointFilterWithMetadata<RequiresPowFilter>();
    }

    internal static Task<IResult> HandleDocumentExportRequestAsync(HttpContext context,
        IDocumentExportJobs jobs, IDocumentExportEndpointBinding binding, IAedsEncoder encoder,
        CancellationToken cancellationToken)
        => ExecuteDocumentExportAsync(context, binding, encoder, async actor =>
        {
            (DocumentExportTask task, DocumentExportFrozenInput input) =
                await binding.FreezeRequestAsync(context, actor, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            if (task.UserId != actor.UserId || task.SiteId != actor.SiteId
                || input.UserId != actor.UserId || input.SiteId != actor.SiteId
                || task.Status != DocumentExportTaskStatus.Queued)
            {
                throw new DocumentExportJobDeniedException();
            }
            DocumentExportContractValidator.Validate(input);
            DocumentExportContractValidator.Validate(task, input);
            DocumentExportJobSnapshot snapshot = await jobs.CreateAsync(actor, task, input, cancellationToken);
            return binding.WriteSnapshot(snapshot, encoder);
        }, cancellationToken);

    internal static Task<IResult> HandleDocumentExportListAsync(HttpContext context,
        IDocumentExportJobs jobs, IDocumentExportEndpointBinding binding, IAedsEncoder encoder,
        CancellationToken cancellationToken)
        => ExecuteDocumentExportAsync(context, binding, encoder, async actor =>
        {
            if (!int.TryParse(context.Request.Query["offset"], out int offset) || offset < 0
                || !int.TryParse(context.Request.Query["limit"], out int limit) || limit is < 1 or > 50)
            {
                throw new DocumentExportJobDeniedException();
            }
            ImmutableArray<DocumentExportJobSnapshot> snapshots = await jobs.ListAsync(actor, cancellationToken);
            // The current job contract owns the list and its authorization. The
            // binding receives only this page; the browser never receives all jobs.
            return binding.WritePage(snapshots.Skip(offset).Take(limit).ToImmutableArray(), offset, limit, encoder);
        }, cancellationToken);

    internal static Task<IResult> HandleDocumentExportStatusAsync(HttpContext context,
        IDocumentExportJobs jobs, IDocumentExportEndpointBinding binding, IAedsEncoder encoder,
        CancellationToken cancellationToken)
        => ExecuteDocumentExportTaskAsync(context, binding, encoder,
            (actor, taskId) => jobs.GetAsync(actor, taskId, cancellationToken), cancellationToken);

    internal static Task<IResult> HandleDocumentExportCancelAsync(HttpContext context,
        IDocumentExportJobs jobs, IDocumentExportEndpointBinding binding, IAedsEncoder encoder,
        CancellationToken cancellationToken)
        => ExecuteDocumentExportTaskAsync(context, binding, encoder,
            (actor, taskId) => jobs.CancelAsync(actor, taskId, cancellationToken), cancellationToken);

    internal static Task<IResult> HandleDocumentExportRetryAsync(HttpContext context,
        IDocumentExportJobs jobs, IDocumentExportEndpointBinding binding, IAedsEncoder encoder,
        CancellationToken cancellationToken)
        => ExecuteDocumentExportTaskAsync(context, binding, encoder,
            (actor, taskId) => jobs.RetryAsync(actor, taskId, cancellationToken), cancellationToken);

    internal static Task<IResult> HandleDocumentExportDeleteAsync(HttpContext context,
        IDocumentExportJobs jobs, IDocumentExportEndpointBinding binding, IAedsEncoder encoder,
        CancellationToken cancellationToken)
        => ExecuteDocumentExportTaskAsync(context, binding, encoder, async (actor, taskId) =>
        {
            await jobs.DeleteAsync(actor, taskId, cancellationToken);
            // Deletion/revocation is not inferred from an HTTP response. Return
            // the authority's actual post-delete state, including cleanup failure.
            return await jobs.GetAsync(actor, taskId, cancellationToken);
        }, cancellationToken);

    internal static Task<IResult> HandleDocumentExportDownloadAsync(HttpContext context,
        IDocumentExportJobs jobs, IDocumentExportEndpointBinding binding, IAedsEncoder encoder,
        CancellationToken cancellationToken)
        => ExecuteDocumentExportAsync(context, binding, encoder, async actor =>
        {
            if (context.Request.Headers.ContainsKey("Range"))
            {
                throw new DocumentExportJobDeniedException();
            }
            string taskId = await binding.ReadTaskIdAsync(context, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            DocumentExportDownloadGrant grant = await jobs.GrantAsync(actor, taskId, cancellationToken);
            DocumentExportDownload download = await jobs.DownloadAsync(actor, grant.Token, false, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            if (download.ContentLength != download.Bytes.LongLength)
            {
                throw new DocumentExportJobDeniedException();
            }
            foreach (KeyValuePair<string, string> header in download.Headers)
            {
                context.Response.Headers[header.Key] = header.Value;
            }
            context.Response.Headers.CacheControl = "no-store";
            context.Response.Headers["X-Content-Type-Options"] = "nosniff";
            context.Response.Headers["Accept-Ranges"] = "none";
            if (!download.Headers.TryGetValue("Content-Type", out string? mediaType))
            {
                throw new DocumentExportJobDeniedException();
            }
            return Results.Bytes(download.Bytes, contentType: mediaType, enableRangeProcessing: false);
        }, cancellationToken);

    private static Task<IResult> ExecuteDocumentExportTaskAsync(HttpContext context,
        IDocumentExportEndpointBinding binding, IAedsEncoder encoder,
        Func<DocumentExportJobActor, string, Task<DocumentExportJobSnapshot>> execute,
        CancellationToken cancellationToken)
        => ExecuteDocumentExportAsync(context, binding, encoder, async actor =>
        {
            string taskId = await binding.ReadTaskIdAsync(context, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            DocumentExportJobSnapshot snapshot = await execute(actor, taskId);
            return binding.WriteSnapshot(snapshot, encoder);
        }, cancellationToken);

    private static async Task<IResult> ExecuteDocumentExportAsync(HttpContext context,
        IDocumentExportEndpointBinding binding, IAedsEncoder encoder,
        Func<DocumentExportJobActor, Task<IResult>> execute, CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            EndpointUserContext principal = EndpointUserContext.From(context);
            string? sessionId = context.User.GetAdminSessionId();
            if (!principal.IsAuthenticated || !principal.IsAdminPrincipal || principal.AdminPrincipalId <= 0
                || string.IsNullOrWhiteSpace(sessionId))
            {
                throw new DocumentExportJobDeniedException();
            }
            DocumentExportJobActor actor = await binding.ResolveActorAsync(context, cancellationToken);
            if (actor.UserId != principal.AdminPrincipalId || actor.SiteId <= 0
                || !string.Equals(actor.SessionId, sessionId, StringComparison.Ordinal))
            {
                throw new DocumentExportJobDeniedException();
            }
            cancellationToken.ThrowIfCancellationRequested();
            return await execute(actor);
        }
        catch (DocumentExportJobDeniedException)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "导出不可用"), encoder);
        }
    }
}
