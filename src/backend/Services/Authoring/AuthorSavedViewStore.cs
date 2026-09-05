namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// The single server authority for private author saved views. Persistence implementations
/// serialize <see cref="IAuthorSavedViewPersistence.ExecuteAsync{T}"/> per owner/site; this
/// class owns every CRUD, CAS, default, pin, ordering, and idempotency transition.
/// It deliberately never executes an article query.
/// </summary>
public interface IAuthorSavedViewStore
{
    Task<AuthorSavedViewWriteReceipt> CreateAsync(
        CreateAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthorSavedView?> GetAsync(
        AuthorSavedViewOwner owner,
        Guid viewId,
        CancellationToken cancellationToken = default);

    Task<AuthorSavedViewPage> ListAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<AuthorSavedViewWriteReceipt> UpdateAsync(
        UpdateAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthorSavedViewWriteReceipt> RenameAsync(
        RenameAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthorSavedViewWriteReceipt> SetPinnedAsync(
        SetAuthorSavedViewPinnedCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthorSavedViewWriteReceipt> ReorderPinnedAsync(
        ReorderAuthorSavedViewsCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthorSavedViewWriteReceipt> SetDefaultAsync(
        SetDefaultAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthorSavedViewWriteReceipt> RetireAsync(
        RetireAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthorSavedViewWriteReceipt> DeleteAsync(
        DeleteAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthorSavedViewVerificationResult> VerifyAsync(
        AuthorSavedViewOwner owner,
        CancellationToken cancellationToken = default);
}

public sealed class AuthorSavedViewStore(
    IAuthorSavedViewPersistence persistence,
    IAuthorSavedViewQueryValidator queryValidator,
    TimeProvider timeProvider) : IAuthorSavedViewStore
{
    private const string CreateCommand = "create";
    private const string UpdateCommand = "update-query";
    private const string RenameCommand = "rename";
    private const string PinCommand = "set-pinned";
    private const string ReorderCommand = "reorder-pinned";
    private const string DefaultCommand = "set-default";
    private const string RetireCommand = "retire";
    private const string DeleteCommand = "delete";

    public async Task<AuthorSavedViewWriteReceipt> CreateAsync(
        CreateAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentity(command.Owner, command.ViewId, command.RequestId);
        string name = AuthorSavedViewContract.NormalizeName(command.Name);
        string inputQueryDigest = AuthorSavedViewContract.ComputeQueryDigest(command.Query);
        string commandDigest = AuthorSavedViewContract.ComputeCommandDigest(
            CreateCommand,
            command.ViewId,
            command.Owner.AdminPrincipalId,
            command.Owner.SiteScope,
            command.ExpectedCollectionRevision,
            name,
            inputQueryDigest);

        return await MutateAsync(
            command.Owner,
            command.RequestId,
            commandDigest,
            command.ExpectedCollectionRevision,
            cancellationToken,
            async (transaction, token) =>
            {
                AuthorSavedViewQueryValidationResult validation = await ValidateQueryAsync(
                    command.Owner,
                    command.Query,
                    token).ConfigureAwait(false);
                EnsureAbsentOrPrivate(transaction.Views, command.ViewId);
                EnsureNameAvailable(transaction.Views, name, exceptViewId: null);
                if (Active(transaction.Views).Count() >= AuthorSavedViewContract.MaxViewsPerOwner)
                {
                    throw new AuthorSavedViewBudgetExceededException("saved_view_owner_budget_exceeded");
                }

                long collectionRevision = transaction.Collection.Revision + 1;
                DateTime now = UtcNow;
                var view = BuildView(
                    command.ViewId,
                    command.Owner,
                    revision: 1,
                    name,
                    validation,
                    pinned: false,
                    orderKey: 0,
                    AuthorSavedViewLifecycleState.Active,
                    now,
                    now);
                AuthorSavedViewCollection collection = BuildCollection(
                    command.Owner,
                    collectionRevision,
                    transaction.Collection.DefaultViewId,
                    transaction.Collection.ActiveViewCount + 1,
                    commandDigest);
                return Mutation(collection, [view], [], command.ViewId, CreateCommand, commandDigest, now);
            }).ConfigureAwait(false);
    }

    public async Task<AuthorSavedView?> GetAsync(
        AuthorSavedViewOwner owner,
        Guid viewId,
        CancellationToken cancellationToken = default)
    {
        AuthorSavedViewContract.ValidateOwner(owner);
        ValidateGuid(viewId, "saved_view_identity_invalid");
        return await persistence.ReadAsync(
            owner,
            snapshot => snapshot.Views.FirstOrDefault(view => view.Id == viewId),
            cancellationToken).ConfigureAwait(false);
    }

    public async Task<AuthorSavedViewPage> ListAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default)
    {
        AuthorSavedViewContract.ValidateOwner(owner);
        if (limit is < 1 or > AuthorSavedViewContract.MaxPageSize)
        {
            throw new AuthorSavedViewValidationException("saved_view_page_size_invalid");
        }
        if (cursor is not null && (cursor.ViewId == Guid.Empty || cursor.OrderKey < 0))
        {
            throw new AuthorSavedViewValidationException("saved_view_cursor_invalid");
        }

        return await persistence.ReadAsync(
            owner,
            snapshot =>
            {
                AuthorSavedView[] ordered =
                [
                    .. snapshot.Views
                        .Where(static view => view.LifecycleState == AuthorSavedViewLifecycleState.Active)
                        .OrderByDescending(static view => view.Pinned)
                        .ThenBy(static view => view.OrderKey)
                        .ThenBy(static view => view.Id)
                ];
                if (cursor is not null)
                {
                    ordered =
                    [
                        .. ordered.Where(view => ComparePosition(view, cursor) > 0)
                    ];
                }

                AuthorSavedView[] page = [.. ordered.Take(limit + 1)];
                AuthorSavedViewPageCursor? next = page.Length > limit
                    ? Cursor(page[limit - 1])
                    : null;
                return new AuthorSavedViewPage(
                    [.. page.Take(limit)],
                    next,
                    snapshot.Collection.Revision,
                    snapshot.Collection.DefaultViewId);
            },
            cancellationToken).ConfigureAwait(false);
    }

    public async Task<AuthorSavedViewWriteReceipt> UpdateAsync(
        UpdateAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateMutation(command.Owner, command.ViewId, command.RequestId, command.ExpectedViewRevision);
        string inputQueryDigest = AuthorSavedViewContract.ComputeQueryDigest(command.Query);
        string commandDigest = AuthorSavedViewContract.ComputeCommandDigest(
            UpdateCommand,
            command.ViewId,
            command.ExpectedCollectionRevision,
            command.ExpectedViewRevision,
            inputQueryDigest);
        return await MutateAsync(
            command.Owner,
            command.RequestId,
            commandDigest,
            command.ExpectedCollectionRevision,
            cancellationToken,
            async (transaction, token) =>
            {
                AuthorSavedView view = RequireActive(transaction.Views, command.ViewId);
                EnsureViewRevision(view, command.ExpectedViewRevision);
                AuthorSavedViewQueryValidationResult validation = await ValidateQueryAsync(
                    command.Owner,
                    command.Query,
                    token).ConfigureAwait(false);
                DateTime now = UtcNow;
                AuthorSavedView changed = BuildView(
                    view.Id,
                    view.Owner,
                    view.Revision + 1,
                    view.Name,
                    validation,
                    view.Pinned,
                    view.OrderKey,
                    view.LifecycleState,
                    view.CreatedAtUtc,
                    now);
                AuthorSavedViewCollection collection = BuildCollection(
                    command.Owner,
                    transaction.Collection.Revision + 1,
                    transaction.Collection.DefaultViewId,
                    transaction.Collection.ActiveViewCount,
                    commandDigest);
                return Mutation(
                    collection,
                    [changed],
                    [],
                    view.Id,
                    UpdateCommand,
                    commandDigest,
                    now);
            }).ConfigureAwait(false);
    }

    public Task<AuthorSavedViewWriteReceipt> RenameAsync(
        RenameAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateMutation(command.Owner, command.ViewId, command.RequestId, command.ExpectedViewRevision);
        string name = AuthorSavedViewContract.NormalizeName(command.Name);
        string commandDigest = AuthorSavedViewContract.ComputeCommandDigest(
            RenameCommand,
            command.ViewId,
            command.ExpectedCollectionRevision,
            command.ExpectedViewRevision,
            name);
        return MutateViewAsync(
            command.Owner,
            command.ViewId,
            command.RequestId,
            commandDigest,
            command.ExpectedCollectionRevision,
            command.ExpectedViewRevision,
            RenameCommand,
            cancellationToken,
            (view, now) => view with
            {
                Revision = view.Revision + 1,
                Name = name,
                UpdatedAtUtc = now,
                ContentDigest = AuthorSavedViewContract.ComputeViewDigest(
                    view.Owner,
                    view.Id,
                    view.Revision + 1,
                    name,
                    view.QueryDigest,
                    view.DependencyDigest,
                    view.Pinned,
                    view.OrderKey,
                    view.LifecycleState)
            },
            beforeMutation: transaction => EnsureNameAvailable(transaction.Views, name, command.ViewId));
    }

    public Task<AuthorSavedViewWriteReceipt> SetPinnedAsync(
        SetAuthorSavedViewPinnedCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateMutation(command.Owner, command.ViewId, command.RequestId, command.ExpectedViewRevision);
        string commandDigest = AuthorSavedViewContract.ComputeCommandDigest(
            PinCommand,
            command.ViewId,
            command.ExpectedCollectionRevision,
            command.ExpectedViewRevision,
            command.Pinned);
        return MutateViewAsync(
            command.Owner,
            command.ViewId,
            command.RequestId,
            commandDigest,
            command.ExpectedCollectionRevision,
            command.ExpectedViewRevision,
            PinCommand,
            cancellationToken,
            (view, now) =>
            {
                long orderKey = command.Pinned
                    ? 1
                    : 0;
                return view with
                {
                    Revision = view.Revision + 1,
                    Pinned = command.Pinned,
                    OrderKey = orderKey,
                    UpdatedAtUtc = now,
                    ContentDigest = AuthorSavedViewContract.ComputeViewDigest(
                        view.Owner,
                        view.Id,
                        view.Revision + 1,
                        view.Name,
                        view.QueryDigest,
                        view.DependencyDigest,
                        command.Pinned,
                        orderKey,
                        view.LifecycleState)
                };
            },
            beforeMutation: transaction =>
            {
                if (!command.Pinned)
                {
                    return;
                }
                long max = Active(transaction.Views)
                    .Where(static candidate => candidate.Pinned)
                    .Select(static candidate => candidate.OrderKey)
                    .DefaultIfEmpty(0)
                    .Max();
                transaction.SetProposedOrderKey(max + 1);
            });
    }

    public Task<AuthorSavedViewWriteReceipt> ReorderPinnedAsync(
        ReorderAuthorSavedViewsCommand command,
        CancellationToken cancellationToken = default)
    {
        AuthorSavedViewContract.ValidateOwner(command.Owner);
        ValidateGuid(command.RequestId, "saved_view_request_identity_invalid");
        if (command.OrderedViewIds.Count > AuthorSavedViewContract.MaxViewsPerOwner
            || command.OrderedViewIds.Any(static id => id == Guid.Empty)
            || command.OrderedViewIds.Distinct().Count() != command.OrderedViewIds.Count
            || command.ExpectedViewRevisions.Count != command.OrderedViewIds.Count)
        {
            throw new AuthorSavedViewValidationException("saved_view_reorder_invalid");
        }
        string commandDigest = AuthorSavedViewContract.ComputeCommandDigest(
            ReorderCommand,
            command.ExpectedCollectionRevision,
            string.Join(',', command.OrderedViewIds),
            string.Join(',', command.ExpectedViewRevisions.OrderBy(static item => item.Key)
                .Select(static item => $"{item.Key:D}:{item.Value}")));

        return MutateAsync(
            command.Owner,
            command.RequestId,
            commandDigest,
            command.ExpectedCollectionRevision,
            cancellationToken,
            transaction =>
            {
                AuthorSavedView[] pinned =
                [
                    .. Active(transaction.Views).Where(static view => view.Pinned)
                ];
                if (!pinned.Select(static view => view.Id).ToHashSet().SetEquals(command.OrderedViewIds))
                {
                    throw new AuthorSavedViewValidationException("saved_view_reorder_set_mismatch");
                }
                DateTime now = UtcNow;
                var changed = new List<AuthorSavedView>();
                for (int index = 0; index < command.OrderedViewIds.Count; index++)
                {
                    Guid id = command.OrderedViewIds[index];
                    AuthorSavedView view = pinned.Single(candidate => candidate.Id == id);
                    EnsureViewRevision(view, command.ExpectedViewRevisions[id]);
                    long orderKey = index + 1;
                    changed.Add(view with
                    {
                        Revision = view.Revision + 1,
                        OrderKey = orderKey,
                        UpdatedAtUtc = now,
                        ContentDigest = AuthorSavedViewContract.ComputeViewDigest(
                            view.Owner,
                            view.Id,
                            view.Revision + 1,
                            view.Name,
                            view.QueryDigest,
                            view.DependencyDigest,
                            true,
                            orderKey,
                            view.LifecycleState)
                    });
                }
                long collectionRevision = transaction.Collection.Revision + 1;
                AuthorSavedViewCollection collection = BuildCollection(
                    command.Owner,
                    collectionRevision,
                    transaction.Collection.DefaultViewId,
                    transaction.Collection.ActiveViewCount,
                    commandDigest);
                Guid subject = command.OrderedViewIds.FirstOrDefault();
                return Mutation(collection, changed, [], subject, ReorderCommand, commandDigest, now);
            });
    }

    public Task<AuthorSavedViewWriteReceipt> SetDefaultAsync(
        SetDefaultAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
    {
        AuthorSavedViewContract.ValidateOwner(command.Owner);
        ValidateGuid(command.RequestId, "saved_view_request_identity_invalid");
        if (command.ViewId is null && command.ExpectedViewRevision is not null
            || command.ViewId is not null && (command.ViewId == Guid.Empty || command.ExpectedViewRevision is null))
        {
            throw new AuthorSavedViewValidationException("saved_view_default_command_invalid");
        }
        string commandDigest = AuthorSavedViewContract.ComputeCommandDigest(
            DefaultCommand,
            command.ViewId,
            command.ExpectedCollectionRevision,
            command.ExpectedViewRevision);
        return MutateAsync(
            command.Owner,
            command.RequestId,
            commandDigest,
            command.ExpectedCollectionRevision,
            cancellationToken,
            transaction =>
            {
                if (command.ViewId is Guid viewId)
                {
                    AuthorSavedView view = RequireActive(transaction.Views, viewId);
                    EnsureViewRevision(view, command.ExpectedViewRevision!.Value);
                }
                DateTime now = UtcNow;
                long collectionRevision = transaction.Collection.Revision + 1;
                AuthorSavedViewCollection collection = BuildCollection(
                    command.Owner,
                    collectionRevision,
                    command.ViewId,
                    transaction.Collection.ActiveViewCount,
                    commandDigest);
                return Mutation(collection, [], [], command.ViewId ?? Guid.Empty, DefaultCommand, commandDigest, now);
            });
    }

    public Task<AuthorSavedViewWriteReceipt> RetireAsync(
        RetireAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
        => RemoveOrRetireAsync(
            command.Owner,
            command.ViewId,
            command.ExpectedCollectionRevision,
            command.ExpectedViewRevision,
            command.RequestId,
            command.DefaultDisposition,
            command.ReplacementViewId,
            command.ExpectedReplacementViewRevision,
            command.ReasonCode,
            delete: false,
            cancellationToken);

    public Task<AuthorSavedViewWriteReceipt> DeleteAsync(
        DeleteAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
        => RemoveOrRetireAsync(
            command.Owner,
            command.ViewId,
            command.ExpectedCollectionRevision,
            command.ExpectedViewRevision,
            command.RequestId,
            command.DefaultDisposition,
            command.ReplacementViewId,
            command.ExpectedReplacementViewRevision,
            command.ReasonCode,
            delete: true,
            cancellationToken);

    public async Task<AuthorSavedViewVerificationResult> VerifyAsync(
        AuthorSavedViewOwner owner,
        CancellationToken cancellationToken = default)
    {
        AuthorSavedViewContract.ValidateOwner(owner);
        AuthorSavedViewPersistenceSnapshot snapshot = await persistence.ReadAsync(
            owner,
            static value => value,
            cancellationToken).ConfigureAwait(false);
        var reasons = new List<string>();
        AuthorSavedView[] active = [.. Active(snapshot.Views)];
        if (active.Length != snapshot.Collection.ActiveViewCount)
        {
            reasons.Add("saved_view_active_count_mismatch");
        }
        if (snapshot.Collection.DefaultViewId is Guid defaultId
            && active.All(view => view.Id != defaultId))
        {
            reasons.Add("saved_view_default_invalid");
        }
        string collectionDigest = AuthorSavedViewContract.ComputeCollectionDigest(
            owner,
            snapshot.Collection.Revision,
            snapshot.Collection.DefaultViewId,
            snapshot.Collection.ActiveViewCount,
            snapshot.Collection.LastCommandDigest);
        if (!string.Equals(
            collectionDigest,
            snapshot.Collection.ContentDigest,
            StringComparison.Ordinal))
        {
            reasons.Add("saved_view_collection_digest_mismatch");
        }
        try
        {
            if (active.GroupBy(
                    static view => AuthorSavedViewContract.NormalizeNameKey(view.Name),
                    StringComparer.Ordinal)
                .Any(static group => group.Count() > 1))
            {
                reasons.Add("saved_view_name_uniqueness_invalid");
            }
        }
        catch (AuthorSavedViewValidationException exception)
        {
            reasons.Add($"saved_view_name_invalid:{exception.Code}");
        }
        AuthorSavedView[] pinned = [.. active.Where(static view => view.Pinned).OrderBy(static view => view.OrderKey)];
        if (pinned.Any(static view => view.OrderKey <= 0)
            || pinned.Select(static view => view.OrderKey).Distinct().Count() != pinned.Length)
        {
            reasons.Add("saved_view_pinned_order_invalid");
        }
        foreach (AuthorSavedView view in snapshot.Views)
        {
            if (view.Owner != owner)
            {
                reasons.Add($"saved_view_owner_mismatch:{view.Id:D}");
            }
            try
            {
                AuthorSavedViewQueryValidationResult validation = await queryValidator.ValidateAsync(
                    owner,
                    view.Query,
                    cancellationToken).ConfigureAwait(false);
                if (!validation.IsValid)
                {
                    reasons.Add($"saved_view_dependency_invalid:{view.Id:D}");
                }
                if (!string.Equals(validation.QueryDigest, view.QueryDigest, StringComparison.Ordinal))
                {
                    reasons.Add($"saved_view_query_digest_mismatch:{view.Id:D}");
                }
                if (!string.Equals(validation.DependencyDigest, view.DependencyDigest, StringComparison.Ordinal))
                {
                    reasons.Add($"saved_view_dependency_digest_mismatch:{view.Id:D}");
                }
            }
            catch (AuthorSavedViewValidationException exception)
            {
                reasons.Add($"saved_view_query_invalid:{view.Id:D}:{exception.Code}");
            }

            string digest = AuthorSavedViewContract.ComputeViewDigest(
                view.Owner,
                view.Id,
                view.Revision,
                view.Name,
                view.QueryDigest,
                view.DependencyDigest,
                view.Pinned,
                view.OrderKey,
                view.LifecycleState);
            if (!string.Equals(digest, view.ContentDigest, StringComparison.Ordinal))
            {
                reasons.Add($"saved_view_content_digest_mismatch:{view.Id:D}");
            }
        }
        return new AuthorSavedViewVerificationResult(
            reasons.Count == 0,
            Array.AsReadOnly(reasons.ToArray()));
    }

    private async Task<AuthorSavedViewWriteReceipt> RemoveOrRetireAsync(
        AuthorSavedViewOwner owner,
        Guid viewId,
        long expectedCollectionRevision,
        long expectedViewRevision,
        Guid requestId,
        AuthorSavedViewDefaultDisposition defaultDisposition,
        Guid? replacementViewId,
        long? expectedReplacementViewRevision,
        string reasonCode,
        bool delete,
        CancellationToken cancellationToken)
    {
        ValidateMutation(owner, viewId, requestId, expectedViewRevision);
        ValidateReason(reasonCode);
        string commandKind = delete ? DeleteCommand : RetireCommand;
        string commandDigest = AuthorSavedViewContract.ComputeCommandDigest(
            commandKind,
            viewId,
            expectedCollectionRevision,
            expectedViewRevision,
            (int)defaultDisposition,
            replacementViewId,
            expectedReplacementViewRevision,
            reasonCode);
        return await MutateAsync(
            owner,
            requestId,
            commandDigest,
            expectedCollectionRevision,
            cancellationToken,
            transaction =>
            {
                AuthorSavedView view = RequireActive(transaction.Views, viewId);
                EnsureViewRevision(view, expectedViewRevision);
                Guid? defaultViewId = ResolveDefaultDisposition(
                    transaction,
                    view,
                    defaultDisposition,
                    replacementViewId,
                    expectedReplacementViewRevision);
                DateTime now = UtcNow;
                IReadOnlyList<AuthorSavedView> upserts;
                IReadOnlyList<Guid> deletes;
                if (delete)
                {
                    upserts = [];
                    deletes = [view.Id];
                }
                else
                {
                    var retired = view with
                    {
                        Revision = view.Revision + 1,
                        Pinned = false,
                        OrderKey = 0,
                        LifecycleState = AuthorSavedViewLifecycleState.Retired,
                        UpdatedAtUtc = now,
                        ContentDigest = AuthorSavedViewContract.ComputeViewDigest(
                            view.Owner,
                            view.Id,
                            view.Revision + 1,
                            view.Name,
                            view.QueryDigest,
                            view.DependencyDigest,
                            false,
                            0,
                            AuthorSavedViewLifecycleState.Retired)
                    };
                    upserts = [retired];
                    deletes = [];
                }
                long collectionRevision = transaction.Collection.Revision + 1;
                AuthorSavedViewCollection collection = BuildCollection(
                    owner,
                    collectionRevision,
                    defaultViewId,
                    transaction.Collection.ActiveViewCount - 1,
                    commandDigest);
                return Mutation(
                    collection,
                    upserts,
                    deletes,
                    view.Id,
                    commandKind,
                    commandDigest,
                    now,
                    reasonCode);
            }).ConfigureAwait(false);
    }

    private Task<AuthorSavedViewWriteReceipt> MutateViewAsync(
        AuthorSavedViewOwner owner,
        Guid viewId,
        Guid requestId,
        string commandDigest,
        long expectedCollectionRevision,
        long expectedViewRevision,
        string commandKind,
        CancellationToken cancellationToken,
        Func<AuthorSavedView, DateTime, AuthorSavedView> transform,
        Action<IAuthorSavedViewPersistenceTransaction>? beforeMutation = null)
        => MutateAsync(
            owner,
            requestId,
            commandDigest,
            expectedCollectionRevision,
            cancellationToken,
            transaction =>
            {
                beforeMutation?.Invoke(transaction);
                AuthorSavedView view = RequireActive(transaction.Views, viewId);
                EnsureViewRevision(view, expectedViewRevision);
                DateTime now = UtcNow;
                AuthorSavedView changed = transform(view, now);
                if (transaction.TryTakeProposedOrderKey(out long proposedOrderKey))
                {
                    changed = changed with
                    {
                        OrderKey = proposedOrderKey,
                        ContentDigest = AuthorSavedViewContract.ComputeViewDigest(
                            changed.Owner,
                            changed.Id,
                            changed.Revision,
                            changed.Name,
                            changed.QueryDigest,
                            changed.DependencyDigest,
                            changed.Pinned,
                            proposedOrderKey,
                            changed.LifecycleState)
                    };
                }
                long collectionRevision = transaction.Collection.Revision + 1;
                AuthorSavedViewCollection collection = BuildCollection(
                    owner,
                    collectionRevision,
                    transaction.Collection.DefaultViewId,
                    transaction.Collection.ActiveViewCount,
                    commandDigest);
                return Mutation(collection, [changed], [], view.Id, commandKind, commandDigest, now);
            });

    private Task<AuthorSavedViewWriteReceipt> MutateAsync(
        AuthorSavedViewOwner owner,
        Guid requestId,
        string commandDigest,
        long expectedCollectionRevision,
        CancellationToken cancellationToken,
        Func<IAuthorSavedViewPersistenceTransaction, AuthorSavedViewPersistenceMutation> mutate)
        => MutateAsync(
            owner,
            requestId,
            commandDigest,
            expectedCollectionRevision,
            cancellationToken,
            (transaction, _) => Task.FromResult(mutate(transaction)));

    private Task<AuthorSavedViewWriteReceipt> MutateAsync(
        AuthorSavedViewOwner owner,
        Guid requestId,
        string commandDigest,
        long expectedCollectionRevision,
        CancellationToken cancellationToken,
        Func<IAuthorSavedViewPersistenceTransaction, CancellationToken, Task<AuthorSavedViewPersistenceMutation>> mutate)
        => persistence.ExecuteAsync(
            owner,
            async (transaction, token) =>
            {
                AuthorSavedViewWriteReceipt? replay = await transaction.ReadReceiptAsync(
                    requestId,
                    token).ConfigureAwait(false);
                if (replay is not null)
                {
                    if (!string.Equals(replay.CommandDigest, commandDigest, StringComparison.Ordinal))
                    {
                        throw new AuthorSavedViewIdempotencyConflictException();
                    }
                    return replay with
                    {
                        IdempotentReplay = true
                    };
                }
                if (transaction.Collection.Revision != expectedCollectionRevision)
                {
                    throw new AuthorSavedViewCollectionRevisionConflictException(
                        expectedCollectionRevision,
                        transaction.Collection.Revision);
                }
                AuthorSavedViewPersistenceMutation mutation = await mutate(transaction, token).ConfigureAwait(false);
                AuthorSavedViewWriteReceipt receipt = BuildReceipt(
                    owner,
                    requestId,
                    mutation,
                    transaction.Views);
                await transaction.CommitAsync(mutation, receipt, token).ConfigureAwait(false);
                return receipt;
            },
            cancellationToken);

    private async Task<AuthorSavedViewQueryValidationResult> ValidateQueryAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewQuery query,
        CancellationToken cancellationToken)
    {
        AuthorSavedViewQueryValidationResult validation = await queryValidator.ValidateAsync(
            owner,
            query,
            cancellationToken).ConfigureAwait(false);
        if (!validation.IsValid)
        {
            throw new AuthorSavedViewDependencyException(validation.Reasons);
        }
        return validation;
    }

    private static AuthorSavedView BuildView(
        Guid id,
        AuthorSavedViewOwner owner,
        long revision,
        string name,
        AuthorSavedViewQueryValidationResult validation,
        bool pinned,
        long orderKey,
        AuthorSavedViewLifecycleState lifecycleState,
        DateTime createdAtUtc,
        DateTime updatedAtUtc)
        => new(
            id,
            owner,
            AuthorSavedViewContract.SchemaVersion,
            revision,
            name,
            validation.Query,
            validation.QueryDigest,
            validation.DependencyDigest,
            pinned,
            orderKey,
            lifecycleState,
            createdAtUtc,
            updatedAtUtc,
            AuthorSavedViewContract.ComputeViewDigest(
                owner,
                id,
                revision,
                name,
                validation.QueryDigest,
                validation.DependencyDigest,
                pinned,
                orderKey,
                lifecycleState));

    private static AuthorSavedViewCollection BuildCollection(
        AuthorSavedViewOwner owner,
        long revision,
        Guid? defaultViewId,
        int activeCount,
        string commandDigest)
        => new(
            owner,
            revision,
            defaultViewId,
            activeCount,
            commandDigest,
            AuthorSavedViewContract.ComputeCollectionDigest(
                owner,
                revision,
                defaultViewId,
                activeCount,
                commandDigest));

    private static AuthorSavedViewPersistenceMutation Mutation(
        AuthorSavedViewCollection collection,
        IReadOnlyList<AuthorSavedView> upserts,
        IReadOnlyList<Guid> deletes,
        Guid subjectViewId,
        string commandKind,
        string commandDigest,
        DateTime now,
        string reasonCode = "none")
        => new(collection, upserts, deletes, subjectViewId, commandKind, commandDigest, reasonCode, now);

    private static AuthorSavedViewWriteReceipt BuildReceipt(
        AuthorSavedViewOwner owner,
        Guid requestId,
        AuthorSavedViewPersistenceMutation mutation,
        IReadOnlyList<AuthorSavedView> currentViews)
    {
        AuthorSavedView? subject = mutation.Upserts.FirstOrDefault(view => view.Id == mutation.SubjectViewId)
            ?? currentViews.FirstOrDefault(view => view.Id == mutation.SubjectViewId);
        bool deleted = mutation.Deletes.Contains(mutation.SubjectViewId);
        long viewRevision = subject is null ? 0 : subject.Revision + (deleted ? 1 : 0);
        string queryDigest = subject?.QueryDigest ?? string.Empty;
        string dependencyDigest = subject?.DependencyDigest ?? string.Empty;
        bool pinned = !deleted && (subject?.Pinned ?? false);
        long orderKey = deleted ? 0 : subject?.OrderKey ?? 0;
        AuthorSavedViewLifecycleState state = deleted
            ? AuthorSavedViewLifecycleState.Retired
            : subject?.LifecycleState ?? AuthorSavedViewLifecycleState.Retired;
        string contentDigest = AuthorSavedViewContract.ComputeCommandDigest(
            requestId,
            owner.AdminPrincipalId,
            owner.SiteScope,
            mutation.CommandKind,
            mutation.CommandDigest,
            mutation.SubjectViewId,
            viewRevision,
            mutation.Collection.Revision,
            queryDigest,
            dependencyDigest,
            pinned,
            mutation.Collection.DefaultViewId,
            orderKey,
            (int)state,
            mutation.ReasonCode);
        return new AuthorSavedViewWriteReceipt(
            Guid.CreateVersion7(),
            requestId,
            owner,
            mutation.SubjectViewId,
            mutation.CommandKind,
            mutation.CommandDigest,
            viewRevision,
            mutation.Collection.Revision,
            queryDigest,
            dependencyDigest,
            pinned,
            mutation.Collection.DefaultViewId,
            orderKey,
            state,
            mutation.ReasonCode,
            contentDigest,
            mutation.OccurredAtUtc,
            false);
    }

    private static Guid? ResolveDefaultDisposition(
        IAuthorSavedViewPersistenceTransaction transaction,
        AuthorSavedView target,
        AuthorSavedViewDefaultDisposition disposition,
        Guid? replacementViewId,
        long? expectedReplacementRevision)
    {
        bool isDefault = transaction.Collection.DefaultViewId == target.Id;
        if (!isDefault)
        {
            if (disposition != AuthorSavedViewDefaultDisposition.NotApplicable
                || replacementViewId is not null
                || expectedReplacementRevision is not null)
            {
                throw new AuthorSavedViewValidationException("saved_view_default_disposition_not_applicable");
            }
            return transaction.Collection.DefaultViewId;
        }

        return disposition switch
        {
            AuthorSavedViewDefaultDisposition.ClearToSystem
                when replacementViewId is null && expectedReplacementRevision is null => null,
            AuthorSavedViewDefaultDisposition.ReplaceWithView
                when replacementViewId is Guid replacement && expectedReplacementRevision is long revision
                => ValidateReplacement(transaction.Views, target.Id, replacement, revision),
            _ => throw new AuthorSavedViewValidationException("saved_view_default_disposition_required")
        };
    }

    private static Guid ValidateReplacement(
        IReadOnlyList<AuthorSavedView> views,
        Guid targetId,
        Guid replacementId,
        long expectedRevision)
    {
        if (replacementId == targetId)
        {
            throw new AuthorSavedViewValidationException("saved_view_default_replacement_invalid");
        }
        AuthorSavedView replacement = RequireActive(views, replacementId);
        EnsureViewRevision(replacement, expectedRevision);
        return replacement.Id;
    }

    private static void EnsureAbsentOrPrivate(IReadOnlyList<AuthorSavedView> views, Guid id)
    {
        if (views.Any(view => view.Id == id))
        {
            throw new AuthorSavedViewAccessDeniedException();
        }
    }

    private static AuthorSavedView RequireActive(IReadOnlyList<AuthorSavedView> views, Guid id)
        => views.FirstOrDefault(view => view.Id == id
                && view.LifecycleState == AuthorSavedViewLifecycleState.Active)
            ?? throw new AuthorSavedViewAccessDeniedException();

    private static IEnumerable<AuthorSavedView> Active(IReadOnlyList<AuthorSavedView> views)
        => views.Where(static view => view.LifecycleState == AuthorSavedViewLifecycleState.Active);

    private static void EnsureNameAvailable(
        IReadOnlyList<AuthorSavedView> views,
        string name,
        Guid? exceptViewId)
    {
        string nameKey = AuthorSavedViewContract.NormalizeNameKey(name);
        if (Active(views).Any(view => view.Id != exceptViewId
                && string.Equals(
                    AuthorSavedViewContract.NormalizeNameKey(view.Name),
                    nameKey,
                    StringComparison.Ordinal)))
        {
            throw new AuthorSavedViewNameConflictException();
        }
    }

    private static void EnsureViewRevision(AuthorSavedView view, long expectedRevision)
    {
        if (view.Revision != expectedRevision)
        {
            throw new AuthorSavedViewRevisionConflictException(expectedRevision, view.Revision);
        }
    }

    private static int ComparePosition(AuthorSavedView view, AuthorSavedViewPageCursor cursor)
    {
        int pinned = cursor.Pinned.CompareTo(view.Pinned);
        if (pinned != 0)
        {
            return pinned;
        }
        int order = view.OrderKey.CompareTo(cursor.OrderKey);
        return order != 0 ? order : view.Id.CompareTo(cursor.ViewId);
    }

    private static AuthorSavedViewPageCursor Cursor(AuthorSavedView view)
        => new(view.Pinned, view.OrderKey, view.Id);

    private static void ValidateIdentity(AuthorSavedViewOwner owner, Guid viewId, Guid requestId)
    {
        AuthorSavedViewContract.ValidateOwner(owner);
        ValidateGuid(viewId, "saved_view_identity_invalid");
        ValidateGuid(requestId, "saved_view_request_identity_invalid");
    }

    private static void ValidateMutation(
        AuthorSavedViewOwner owner,
        Guid viewId,
        Guid requestId,
        long expectedViewRevision)
    {
        ValidateIdentity(owner, viewId, requestId);
        if (expectedViewRevision <= 0)
        {
            throw new AuthorSavedViewValidationException("saved_view_revision_invalid");
        }
    }

    private static void ValidateGuid(Guid value, string code)
    {
        if (value == Guid.Empty)
        {
            throw new AuthorSavedViewValidationException(code);
        }
    }

    private static void ValidateReason(string reasonCode)
    {
        if (string.IsNullOrWhiteSpace(reasonCode)
            || reasonCode.Length > 64
            || reasonCode.Any(static character => char.IsControl(character) || char.IsWhiteSpace(character)))
        {
            throw new AuthorSavedViewValidationException("saved_view_reason_invalid");
        }
    }

    private DateTime UtcNow => timeProvider.GetUtcNow().UtcDateTime;
}

/// <summary>
/// Production persistence boundary. ExecuteAsync must provide an owner/site-exclusive,
/// serializable transaction. The authority above is shared by PostgreSQL and local
/// production-boundary simulations; persistence never owns business transitions.
/// </summary>
public interface IAuthorSavedViewPersistence
{
    Task<T> ReadAsync<T>(
        AuthorSavedViewOwner owner,
        Func<AuthorSavedViewPersistenceSnapshot, T> read,
        CancellationToken cancellationToken = default);

    Task<T> ExecuteAsync<T>(
        AuthorSavedViewOwner owner,
        Func<IAuthorSavedViewPersistenceTransaction, CancellationToken, Task<T>> operation,
        CancellationToken cancellationToken = default);
}

public interface IAuthorSavedViewPersistenceTransaction
{
    AuthorSavedViewCollection Collection
    {
        get;
    }

    IReadOnlyList<AuthorSavedView> Views
    {
        get;
    }

    Task<AuthorSavedViewWriteReceipt?> ReadReceiptAsync(
        Guid requestId,
        CancellationToken cancellationToken = default);

    Task CommitAsync(
        AuthorSavedViewPersistenceMutation mutation,
        AuthorSavedViewWriteReceipt receipt,
        CancellationToken cancellationToken = default);

    void SetProposedOrderKey(long value);

    bool TryTakeProposedOrderKey(out long value);
}

public sealed record AuthorSavedViewPersistenceSnapshot(
    AuthorSavedViewCollection Collection,
    IReadOnlyList<AuthorSavedView> Views);

public sealed record AuthorSavedViewPersistenceMutation(
    AuthorSavedViewCollection Collection,
    IReadOnlyList<AuthorSavedView> Upserts,
    IReadOnlyList<Guid> Deletes,
    Guid SubjectViewId,
    string CommandKind,
    string CommandDigest,
    string ReasonCode,
    DateTime OccurredAtUtc);

public sealed record AuthorSavedView(
    Guid Id,
    AuthorSavedViewOwner Owner,
    int SchemaVersion,
    long Revision,
    string Name,
    AuthorSavedViewQuery Query,
    string QueryDigest,
    string DependencyDigest,
    bool Pinned,
    long OrderKey,
    AuthorSavedViewLifecycleState LifecycleState,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    string ContentDigest);

public sealed record AuthorSavedViewCollection(
    AuthorSavedViewOwner Owner,
    long Revision,
    Guid? DefaultViewId,
    int ActiveViewCount,
    string LastCommandDigest,
    string ContentDigest)
{
    public static AuthorSavedViewCollection Empty(AuthorSavedViewOwner owner)
    {
        string emptyDigest = AuthorSavedViewContract.ComputeCommandDigest();
        return new(
            owner,
            0,
            null,
            0,
            emptyDigest,
            AuthorSavedViewContract.ComputeCollectionDigest(owner, 0, null, 0, emptyDigest));
    }
}

public sealed record AuthorSavedViewWriteReceipt(
    Guid ReceiptId,
    Guid RequestId,
    AuthorSavedViewOwner Owner,
    Guid ViewId,
    string CommandKind,
    string CommandDigest,
    long ViewRevision,
    long CollectionRevision,
    string QueryDigest,
    string DependencyDigest,
    bool Pinned,
    Guid? DefaultViewId,
    long OrderKey,
    AuthorSavedViewLifecycleState LifecycleState,
    string ReasonCode,
    string ContentDigest,
    DateTime OccurredAtUtc,
    bool IdempotentReplay);

public sealed record CreateAuthorSavedViewCommand(
    Guid ViewId,
    AuthorSavedViewOwner Owner,
    long ExpectedCollectionRevision,
    Guid RequestId,
    string Name,
    AuthorSavedViewQuery Query);

public sealed record UpdateAuthorSavedViewCommand(
    Guid ViewId,
    AuthorSavedViewOwner Owner,
    long ExpectedCollectionRevision,
    long ExpectedViewRevision,
    Guid RequestId,
    AuthorSavedViewQuery Query);

public sealed record RenameAuthorSavedViewCommand(
    Guid ViewId,
    AuthorSavedViewOwner Owner,
    long ExpectedCollectionRevision,
    long ExpectedViewRevision,
    Guid RequestId,
    string Name);

public sealed record SetAuthorSavedViewPinnedCommand(
    Guid ViewId,
    AuthorSavedViewOwner Owner,
    long ExpectedCollectionRevision,
    long ExpectedViewRevision,
    Guid RequestId,
    bool Pinned);

public sealed record ReorderAuthorSavedViewsCommand(
    AuthorSavedViewOwner Owner,
    long ExpectedCollectionRevision,
    Guid RequestId,
    IReadOnlyList<Guid> OrderedViewIds,
    IReadOnlyDictionary<Guid, long> ExpectedViewRevisions);

public sealed record SetDefaultAuthorSavedViewCommand(
    AuthorSavedViewOwner Owner,
    long ExpectedCollectionRevision,
    Guid RequestId,
    Guid? ViewId,
    long? ExpectedViewRevision);

public sealed record RetireAuthorSavedViewCommand(
    Guid ViewId,
    AuthorSavedViewOwner Owner,
    long ExpectedCollectionRevision,
    long ExpectedViewRevision,
    Guid RequestId,
    AuthorSavedViewDefaultDisposition DefaultDisposition,
    Guid? ReplacementViewId,
    long? ExpectedReplacementViewRevision,
    string ReasonCode);

public sealed record DeleteAuthorSavedViewCommand(
    Guid ViewId,
    AuthorSavedViewOwner Owner,
    long ExpectedCollectionRevision,
    long ExpectedViewRevision,
    Guid RequestId,
    AuthorSavedViewDefaultDisposition DefaultDisposition,
    Guid? ReplacementViewId,
    long? ExpectedReplacementViewRevision,
    string ReasonCode);

public sealed record AuthorSavedViewPage(
    IReadOnlyList<AuthorSavedView> Items,
    AuthorSavedViewPageCursor? NextCursor,
    long CollectionRevision,
    Guid? DefaultViewId);

public sealed record AuthorSavedViewPageCursor(bool Pinned, long OrderKey, Guid ViewId);

public sealed record AuthorSavedViewVerificationResult(bool Valid, IReadOnlyList<string> Reasons);

public sealed class AuthorSavedViewAccessDeniedException()
    : Exception("saved_view_not_found_or_forbidden");

public sealed class AuthorSavedViewNameConflictException()
    : Exception("saved_view_name_conflict");

public sealed class AuthorSavedViewRevisionConflictException(long expectedRevision, long actualRevision)
    : Exception("saved_view_revision_conflict")
{
    public long ExpectedRevision { get; } = expectedRevision;
    public long ActualRevision { get; } = actualRevision;
}

public sealed class AuthorSavedViewCollectionRevisionConflictException(
    long expectedRevision,
    long actualRevision) : Exception("saved_view_collection_revision_conflict")
{
    public long ExpectedRevision { get; } = expectedRevision;
    public long ActualRevision { get; } = actualRevision;
}

public sealed class AuthorSavedViewIdempotencyConflictException()
    : Exception("saved_view_idempotency_conflict");

public sealed class AuthorSavedViewBudgetExceededException(string code) : Exception(code)
{
    public string Code { get; } = code;
}
