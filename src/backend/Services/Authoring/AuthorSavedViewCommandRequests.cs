namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Owner-neutral domain inputs. The authenticated request supplies ownership; these
/// records do not allocate AEDS identifiers or constitute registered wire contracts.
/// Only the nine sealed variants are admitted by the request binding.
/// </summary>
public abstract record AuthorSavedViewCommandRequest;

public sealed record AuthorSavedViewCreateRequest(
    Guid ViewId, long ExpectedCollectionRevision, Guid RequestId,
    string Name,
    AuthorSavedViewQuery Query) : AuthorSavedViewCommandRequest;

public sealed record AuthorSavedViewUpdateRequest(
    Guid ViewId, long ExpectedCollectionRevision, long ExpectedViewRevision,
    Guid RequestId,
    AuthorSavedViewQuery Query) : AuthorSavedViewCommandRequest;

public sealed record AuthorSavedViewRenameRequest(
    Guid ViewId, long ExpectedCollectionRevision, long ExpectedViewRevision,
    Guid RequestId,
    string Name) : AuthorSavedViewCommandRequest;

public sealed record AuthorSavedViewPinRequest(
    Guid ViewId, long ExpectedCollectionRevision, long ExpectedViewRevision,
    Guid RequestId,
    bool Pinned) : AuthorSavedViewCommandRequest;

public sealed record AuthorSavedViewReorderRequest(
    long ExpectedCollectionRevision, Guid RequestId, IReadOnlyList<Guid> OrderedViewIds,
    IReadOnlyDictionary<Guid, long> ExpectedViewRevisions) : AuthorSavedViewCommandRequest;

public sealed record AuthorSavedViewMoveRequest(
    long ExpectedCollectionRevision, Guid RequestId, IReadOnlyList<Guid> MovedViewIds,
    Guid? BeforeViewId,
    IReadOnlyDictionary<Guid, long> ExpectedViewRevisions) : AuthorSavedViewCommandRequest;

public sealed record AuthorSavedViewDefaultRequest(
    long ExpectedCollectionRevision, Guid RequestId, Guid? ViewId,
    long? ExpectedViewRevision) : AuthorSavedViewCommandRequest;

public sealed record AuthorSavedViewRetireRequest(
    Guid ViewId, long ExpectedCollectionRevision, long ExpectedViewRevision,
    Guid RequestId, AuthorSavedViewDefaultDisposition DefaultDisposition,
    Guid? ReplacementViewId, long? ExpectedReplacementViewRevision,
    string ReasonCode) : AuthorSavedViewCommandRequest;

public sealed record AuthorSavedViewDeleteRequest(
    Guid ViewId, long ExpectedCollectionRevision, long ExpectedViewRevision,
    Guid RequestId, AuthorSavedViewDefaultDisposition DefaultDisposition,
    Guid? ReplacementViewId, long? ExpectedReplacementViewRevision,
    string ReasonCode) : AuthorSavedViewCommandRequest;

/// <summary>One read's inseparable view identity, revision, and detached query.</summary>
public sealed record AuthorSavedViewQuerySnapshot(Guid ViewId, long Revision, AuthorSavedViewQuery Query);

public sealed record AuthorSavedViewResponse(
    AuthorSavedViewQuerySnapshot Snapshot, string Name, bool Pinned,
    long OrderKey, AuthorSavedViewLifecycleState LifecycleState);

public sealed record AuthorSavedViewPageResponse(
    IReadOnlyList<AuthorSavedViewResponse> Items, AuthorSavedViewPageCursor? NextCursor,
    long CollectionRevision, Guid? DefaultViewId);

/// <summary>Public mutation outcome projected from the real store, without audit internals.</summary>
public sealed record AuthorSavedViewMutationResponse(
    Guid RequestId, Guid ViewId, long ViewRevision, long CollectionRevision,
    bool Pinned, Guid? DefaultViewId, long OrderKey,
    AuthorSavedViewLifecycleState LifecycleState, bool IdempotentReplay);
