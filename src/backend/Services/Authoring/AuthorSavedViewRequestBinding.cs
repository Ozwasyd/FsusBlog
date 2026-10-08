using System.Collections.ObjectModel;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Binds domain inputs to the unique store inside the existing authenticated-request
/// guard. Response projection precedes the guard's final identity/cancellation check.
/// </summary>
public sealed partial class AuthorSavedViewApplicationFacade
{
    public Task<AuthorSavedViewMutationResponse> ApplyRequestAsync(
        AuthorSavedViewCommandRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        return ExecuteAsync(null, async (owner, token) =>
        {
            AuthorSavedViewWriteReceipt receipt = request switch
            {
                AuthorSavedViewCreateRequest input => await store.CreateAsync(new(
                    input.ViewId, owner, input.ExpectedCollectionRevision, input.RequestId,
                    input.Name, DetachQuery(input.Query)), token).ConfigureAwait(false),
                AuthorSavedViewUpdateRequest input => await store.UpdateAsync(new(
                    input.ViewId, owner, input.ExpectedCollectionRevision, input.ExpectedViewRevision,
                    input.RequestId, DetachQuery(input.Query)), token).ConfigureAwait(false),
                AuthorSavedViewRenameRequest input => await store.RenameAsync(new(
                    input.ViewId, owner, input.ExpectedCollectionRevision, input.ExpectedViewRevision,
                    input.RequestId, input.Name), token).ConfigureAwait(false),
                AuthorSavedViewPinRequest input => await store.SetPinnedAsync(new(
                    input.ViewId, owner, input.ExpectedCollectionRevision, input.ExpectedViewRevision,
                    input.RequestId, input.Pinned), token).ConfigureAwait(false),
                AuthorSavedViewReorderRequest input => await store.ReorderPinnedAsync(new(
                    owner, input.ExpectedCollectionRevision, input.RequestId,
                    DetachIds(input.OrderedViewIds), DetachRevisions(input.ExpectedViewRevisions)), token)
                    .ConfigureAwait(false),
                AuthorSavedViewMoveRequest input => await store.MovePinnedAsync(new(
                    owner, input.ExpectedCollectionRevision, input.RequestId,
                    DetachIds(input.MovedViewIds), input.BeforeViewId,
                    DetachRevisions(input.ExpectedViewRevisions)), token).ConfigureAwait(false),
                AuthorSavedViewDefaultRequest input => await store.SetDefaultAsync(new(
                    owner, input.ExpectedCollectionRevision, input.RequestId,
                    input.ViewId, input.ExpectedViewRevision), token).ConfigureAwait(false),
                AuthorSavedViewRetireRequest input => await store.RetireAsync(new(
                    input.ViewId, owner, input.ExpectedCollectionRevision, input.ExpectedViewRevision,
                    input.RequestId, input.DefaultDisposition, input.ReplacementViewId,
                    input.ExpectedReplacementViewRevision, input.ReasonCode), token).ConfigureAwait(false),
                AuthorSavedViewDeleteRequest input => await store.DeleteAsync(new(
                    input.ViewId, owner, input.ExpectedCollectionRevision, input.ExpectedViewRevision,
                    input.RequestId, input.DefaultDisposition, input.ReplacementViewId,
                    input.ExpectedReplacementViewRevision, input.ReasonCode), token).ConfigureAwait(false),
                _ => throw new AuthorSavedViewValidationException("saved_view_request_invalid")
            };
            return new AuthorSavedViewMutationResponse(
                receipt.RequestId, receipt.ViewId, receipt.ViewRevision, receipt.CollectionRevision,
                receipt.Pinned, receipt.DefaultViewId, receipt.OrderKey,
                receipt.LifecycleState, receipt.IdempotentReplay);
        }, cancellationToken);
    }

    public Task<AuthorSavedViewResponse?> GetResponseAsync(
        Guid viewId, CancellationToken cancellationToken = default)
        => ExecuteAsync(null, async (owner, token) =>
        {
            AuthorSavedView? view = await store.GetAsync(owner, viewId, token).ConfigureAwait(false);
            return view is null ? null : Project(view);
        }, cancellationToken);

    public Task<AuthorSavedViewPageResponse> ListResponseAsync(
        AuthorSavedViewPageCursor? cursor, int limit, CancellationToken cancellationToken = default)
        => ExecuteAsync(null, async (owner, token) =>
        {
            AuthorSavedViewPage page = await store.ListAsync(owner, cursor, limit, token).ConfigureAwait(false);
            return new AuthorSavedViewPageResponse(
                Array.AsReadOnly(page.Items.Select(Project).ToArray()), page.NextCursor,
                page.CollectionRevision, page.DefaultViewId);
        }, cancellationToken);

    private static AuthorSavedViewResponse Project(AuthorSavedView view)
        => new(new(view.Id, view.Revision, DetachQuery(view.Query)),
            view.Name, view.Pinned, view.OrderKey, view.LifecycleState);

    // Detachment preserves the exact query belonging to this revision; normalization
    // and dependency validation remain exclusively with the existing query contract/store.
    private static AuthorSavedViewQuery DetachQuery(AuthorSavedViewQuery query)
    {
        if (query?.Conditions is null || query.Sort is null || query.Projection is null
            || query.Conditions.Count > AuthorSavedViewContract.MaxConditions
            || query.Projection.Count > AuthorSavedViewContract.MaxProjectionFields
            || query.Conditions.Any(static condition => condition?.Field is null || condition.Values is null
                || condition.Values.Count > AuthorSavedViewContract.MaxValuesPerCondition)
            || query.Projection.Any(static field => field is null))
        {
            throw new AuthorSavedViewValidationException("saved_view_request_invalid");
        }
        return query with
        {
            Conditions = Array.AsReadOnly(query.Conditions.Select(static condition => condition with
            {
                Values = Array.AsReadOnly(condition.Values.ToArray())
            }).ToArray()),
            Projection = Array.AsReadOnly(query.Projection.ToArray())
        };
    }

    private static IReadOnlyList<Guid> DetachIds(IReadOnlyList<Guid> ids)
    {
        if (ids is null || ids.Count > AuthorSavedViewStorageContract.MaxViewsPerOwner)
        {
            throw new AuthorSavedViewValidationException("saved_view_request_invalid");
        }
        return Array.AsReadOnly(ids.ToArray());
    }

    private static IReadOnlyDictionary<Guid, long> DetachRevisions(IReadOnlyDictionary<Guid, long> revisions)
    {
        if (revisions is null || revisions.Count > AuthorSavedViewStorageContract.MaxViewsPerOwner)
        {
            throw new AuthorSavedViewValidationException("saved_view_request_invalid");
        }
        return new ReadOnlyDictionary<Guid, long>(new Dictionary<Guid, long>(revisions));
    }
}
