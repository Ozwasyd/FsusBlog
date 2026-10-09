using System.Collections.Immutable;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.DocumentExport;
using FsusBlog.Server.Services.DocumentExport.Jobs;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

/// <summary>
/// Existing compiled-input/frozen-source owner implements this admission port.
/// It must recheck the exact source permission and produce canonical sealed task
/// and input through the original builder. No implementation or fallback is
/// supplied here; this transport never parses Markdown or allocates job storage.
/// </summary>
public interface IDocumentExportRequestFreezer
{
    Task<(DocumentExportTask Task, DocumentExportFrozenInput Input)> FreezeAsync(
        HttpContext context,
        DocumentExportJobActor actor,
        DocumentExportRequestCoreModel request,
        CancellationToken cancellationToken);
}

/// <summary>
/// Production transport consumer of authenticated context, closed POD payloads,
/// the original frozen-input builder and the sole durable jobs. Shared registers
/// the named AEDS frames before this binding can read/write a request or reply.
/// </summary>
internal sealed class DocumentExportEndpointBinding(
    IDocumentExportRequestFreezer freezer,
    IBinaryEndpointRequestContext requestContext) : IDocumentExportEndpointBinding
{
    internal static AedsFrameType RequireRegisteredFrame(string name)
    {
        if (name is not ("DocumentExportRequest" or "DocumentExportTaskRequest"
                or "DocumentExportJobResponse" or "DocumentExportPageResponse")
            || !Enum.TryParse(name, false, out AedsFrameType frame) || !Enum.IsDefined(frame)
            || !string.Equals(frame.ToString(), name, StringComparison.Ordinal))
        {
            throw new InvalidDataException("document_export_shared_frame_unregistered");
        }
        return frame;
    }

    public Task<DocumentExportJobActor> ResolveActorAsync(HttpContext context, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        EndpointUserContext principal = EndpointUserContext.From(context);
        string? sessionId = context.User.GetAdminSessionId();
        IConfiguration? configuration = context.RequestServices.GetService<IConfiguration>();
        if (!principal.IsAuthenticated || !principal.IsAdminPrincipal || principal.AdminPrincipalId <= 0
            || string.IsNullOrWhiteSpace(sessionId) || configuration is null)
        {
            throw new DocumentExportJobDeniedException();
        }
        string siteScope = SqlAuthorRecentArticleHistoryPermissionAuthority.ResolveSiteScope(configuration);
        DocumentExportContractValidator.RequireOwnerScope(principal.AdminPrincipalId, siteScope);
        return Task.FromResult(new DocumentExportJobActor(principal.AdminPrincipalId, siteScope, sessionId));
    }

    public async Task<(DocumentExportTask Task, DocumentExportFrozenInput Input)> FreezeRequestAsync(
        HttpContext context, DocumentExportJobActor actor, CancellationToken cancellationToken)
    {
        using BinaryRequestPayload payload = await requestContext.ReadFrameAsync(context,
            context.RequestServices.GetRequiredService<IAedsEncoder>(),
            RequireRegisteredFrame("DocumentExportRequest"), cancellationToken, PodBinaryCodec.MaximumDocumentExportRequestFrameBytes);
        if (!payload.IsSuccess || !PodBinaryCodec.TryDecodeDocumentExportRequest(payload.Payload, out var request))
        {
            throw new DocumentExportJobDeniedException();
        }
        cancellationToken.ThrowIfCancellationRequested();
        (DocumentExportTask task, DocumentExportFrozenInput input) =
            await freezer.FreezeAsync(context, actor, request, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        RequireFrozenRequestMatch(request, actor, task, input);
        return (task, input);
    }

    public async Task<string> ReadTaskIdAsync(HttpContext context, CancellationToken cancellationToken)
    {
        using BinaryRequestPayload payload = await requestContext.ReadFrameAsync(context,
            context.RequestServices.GetRequiredService<IAedsEncoder>(),
            RequireRegisteredFrame("DocumentExportTaskRequest"), cancellationToken, PodBinaryCodec.MaximumDocumentExportTaskRequestFrameBytes);
        if (!payload.IsSuccess || !PodBinaryCodec.TryDecodeDocumentExportTaskRequest(payload.Payload, out var request))
        {
            throw new DocumentExportJobDeniedException();
        }
        cancellationToken.ThrowIfCancellationRequested();
        return request.TaskId;
    }

    public BinaryFrameResult WriteSnapshot(DocumentExportJobSnapshot snapshot, IAedsEncoder encoder)
    {
        DocumentExportJobResponseCoreModel view = Project(snapshot);
        return BinaryResults.Frame(encoder, RequireRegisteredFrame("DocumentExportJobResponse"),
            writer => PodBinaryCodec.WriteDocumentExportJobResponse(view, writer));
    }

    public BinaryFrameResult WritePage(ImmutableArray<DocumentExportJobSnapshot> snapshots,
        int offset, int pageSize, bool hasMore, IAedsEncoder encoder)
    {
        var page = new DocumentExportPageResponseCoreModel(offset, pageSize,
            hasMore, snapshots.Select(Project).ToImmutableArray());
        return BinaryResults.Frame(encoder, RequireRegisteredFrame("DocumentExportPageResponse"),
            writer => PodBinaryCodec.WriteDocumentExportPageResponse(page, writer));
    }

    internal static void RequireFrozenRequestMatch(DocumentExportRequestCoreModel request,
        DocumentExportJobActor actor, DocumentExportTask task, DocumentExportFrozenInput input)
    {
        DocumentExportContractValidator.Validate(input);
        DocumentExportContractValidator.Validate(task, input);
        var source = new DocumentExportArticleCoordinate((DocumentExportCoordinateKind)request.Source.Kind,
            request.Source.ArticleId, request.Source.DraftKey, request.Source.RevisionId,
            request.Source.PublicationId, request.Source.SourceVersion);
        if (task.UserId != actor.UserId || input.UserId != actor.UserId
            || !string.Equals(task.SiteScope, actor.SiteScope, StringComparison.Ordinal)
            || !string.Equals(input.SiteScope, actor.SiteScope, StringComparison.Ordinal)
            || task.Coordinate != source || input.Coordinate != source
            || task.Status != DocumentExportTaskStatus.Queued
            || !string.Equals(task.RequestId, request.RequestId, StringComparison.Ordinal)
            || !string.Equals(task.IdempotencyKey, request.IdempotencyKey, StringComparison.Ordinal)
            || !string.Equals(task.FormatId, request.FormatId, StringComparison.Ordinal)
            || !string.Equals(task.LayoutProfile, request.LayoutProfile, StringComparison.Ordinal)
            || !string.Equals(task.ThemeProfile, request.ThemeProfile, StringComparison.Ordinal)
            || !string.Equals(task.Locale, request.Locale, StringComparison.Ordinal))
        {
            throw new DocumentExportJobDeniedException();
        }
    }

    internal static DocumentExportJobResponseCoreModel Project(DocumentExportJobSnapshot snapshot)
    {
        if (!string.Equals(snapshot.Schema, DocumentExportJobPolicy.SnapshotSchema, StringComparison.Ordinal))
        {
            throw new InvalidDataException("document_export_snapshot_schema_invalid");
        }
        DocumentExportTask task = snapshot.Task;
        DocumentExportArticleCoordinate source = task.Coordinate;
        DocumentExportOutputRecord? output = snapshot.Output;
        return new DocumentExportJobResponseCoreModel(task.TaskId, task.RequestId,
            new DocumentExportSourceCoreModel((int)source.Kind, source.ArticleId, source.DraftKey,
                source.RevisionId, source.PublicationId, source.SourceVersion),
            task.InputDigest, task.ContentDigest, task.FormatId, task.ProviderId, task.ProviderVersion,
            task.LayoutProfile, task.ThemeProfile, task.Locale, (int)task.Status, snapshot.Version,
            snapshot.CreatedAt.ToUnixTimeMilliseconds(), snapshot.ExpiresAt.ToUnixTimeMilliseconds(), snapshot.Reason,
            snapshot.Attempts.Select(attempt => new DocumentExportAttemptCoreModel(attempt.Number, attempt.Diagnostic,
                attempt.StartedAt.ToUnixTimeMilliseconds(), attempt.FinishedAt?.ToUnixTimeMilliseconds(),
                (int)attempt.Status, attempt.Reason)).ToImmutableArray(),
            output is null ? null : new DocumentExportOutputCoreModel(output.OutputId, output.MediaType,
                output.Extension, output.OutputDigest, output.ResultReceiptDigest, output.Length,
                output.CreatedAt.ToUnixTimeMilliseconds(), output.ExpiresAt.ToUnixTimeMilliseconds(),
                output.DeletedAt?.ToUnixTimeMilliseconds()));
    }
}
