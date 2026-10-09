using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Unique server persistence authority for private authoring canvas documents.
/// Reads are bounded and owner/site scoped; writes use document revision CAS and request idempotency.
/// </summary>
public interface IAuthoringCanvasDocumentStore
{
    Task<AuthoringCanvasWriteReceipt> CreateAsync(
        CreateAuthoringCanvasCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasDocumentHeader?> GetAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasPage<AuthoringCanvasDocumentHeader>> ListAsync(
        AuthoringCanvasOwner owner,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasPage<AuthoringCanvasNode>> ReadNodesAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasPage<AuthoringCanvasEdge>> ReadEdgesAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        AuthoringCanvasPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasWriteReceipt> PutNodeAsync(
        PutAuthoringCanvasNodeCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasWriteReceipt> DeleteNodeAsync(
        DeleteAuthoringCanvasNodeCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasWriteReceipt> PutEdgeAsync(
        PutAuthoringCanvasEdgeCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasWriteReceipt> DeleteEdgeAsync(
        DeleteAuthoringCanvasEdgeCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasWriteReceipt> UpdateMetadataAsync(
        UpdateAuthoringCanvasMetadataCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasWriteReceipt> DeleteAsync(
        DeleteAuthoringCanvasCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthoringCanvasVerificationResult> VerifyAsync(
        AuthoringCanvasOwner owner,
        Guid canvasId,
        CancellationToken cancellationToken = default);
}
