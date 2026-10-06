namespace FsusBlog.Shared.Contracts.AuthoringCanvas;

/// <summary>Creates one private canvas. The authenticated server supplies its owner.</summary>
public sealed record AuthoringCanvasCreateRequest(
    Guid CanvasId,
    Guid RequestId,
    string Title,
    AuthoringCanvasViewport Viewport);

/// <summary>Lists the authenticated owner’s bounded documents, including an empty owner context.</summary>
public sealed record AuthoringCanvasListResponse(
    AuthoringCanvasOwner Owner,
    IReadOnlyList<AuthoringCanvasDocumentHeader> Items,
    AuthoringCanvasPageCursor? NextCursor);

/// <summary>One bounded node page bound to the observed document coordinate.</summary>
public sealed record AuthoringCanvasNodesResponse(
    Guid CanvasId,
    long Revision,
    string ContentDigest,
    IReadOnlyList<AuthoringCanvasNode> Items,
    AuthoringCanvasPageCursor? NextCursor);

/// <summary>One bounded edge page bound to the observed document coordinate.</summary>
public sealed record AuthoringCanvasEdgesResponse(
    Guid CanvasId,
    long Revision,
    string ContentDigest,
    IReadOnlyList<AuthoringCanvasEdge> Items,
    AuthoringCanvasPageCursor? NextCursor);

/// <summary>Unsealed client facts; the unique domain contract validates and seals them at ingress.</summary>
public sealed record AuthoringCanvasWireCommand(
    Guid CommandId,
    AuthoringCanvasOperationKind Kind,
    IReadOnlyList<AuthoringCanvasOperationFact> Before,
    IReadOnlyList<AuthoringCanvasOperationFact> After);

/// <summary>A closed operation transaction without client-supplied owner or actor authority.</summary>
public sealed record AuthoringCanvasApplyRequest(
    Guid RequestId,
    long ExpectedRevision,
    string ExpectedContentDigest,
    string ExpectedHistoryDigest,
    IReadOnlyList<AuthoringCanvasWireCommand> Commands);

/// <summary>Applies undo or redo to an exact journal and document/history CAS coordinate.</summary>
public sealed record AuthoringCanvasUndoRedoRequest(
    Guid RequestId,
    long ExpectedRevision,
    string ExpectedContentDigest,
    string ExpectedHistoryDigest,
    Guid TargetJournalId,
    AuthoringCanvasJournalMode Mode);

/// <summary>Content-free journal identity needed to select the server’s bounded history.</summary>
public sealed record AuthoringCanvasJournalSummary(
    Guid JournalId,
    long Revision,
    AuthoringCanvasJournalMode Mode,
    Guid RequestId,
    Guid? TargetJournalId);

/// <summary>The authoritative operation coordinate and bounded undo/redo journal identities.</summary>
public sealed record AuthoringCanvasHistoryResponse(
    Guid CanvasId,
    long Revision,
    string CanvasContentDigest,
    string HistoryDigest,
    IReadOnlyList<AuthoringCanvasJournalSummary> UndoEntries,
    IReadOnlyList<AuthoringCanvasJournalSummary> RedoEntries);

/// <summary>Deletes only the authenticated owner’s document using revision CAS and idempotency.</summary>
public sealed record AuthoringCanvasDeleteRequest(Guid RequestId, long ExpectedRevision);

/// <summary>Resolves persisted node identities rather than accepting substituted target facts.</summary>
public sealed record AuthoringCanvasResolveRequest(
    Guid RequestId,
    long CanvasRevision,
    string CanvasContentDigest,
    IReadOnlyList<Guid> NodeIds,
    string? TargetWorkspaceGroupId);
