using System.Text;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Storage-only limits, canonical names, and mutation-history digests. Query-shape
/// ownership remains in <see cref="AuthorSavedViewContract"/>.
/// </summary>
public static class AuthorSavedViewStorageContract
{
    public const int MaxViewsPerOwner = 1_000;
    public const int MaxNameCharacters = 128;
    public const int MaxNameUtf8Bytes = 512;
    public const int MaxNameKeyCharacters = 256;

    public static string NormalizeName(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            throw new AuthorSavedViewValidationException("saved_view_name_invalid");
        }

        string normalized = name.Trim().Normalize(NormalizationForm.FormC);
        if (normalized.Length > MaxNameCharacters
            || Encoding.UTF8.GetByteCount(normalized) > MaxNameUtf8Bytes
            || normalized.Any(char.IsControl))
        {
            throw new AuthorSavedViewValidationException("saved_view_name_invalid");
        }

        return normalized;
    }

    public static string NormalizeNameKey(string name)
    {
        string key = NormalizeName(name).ToUpperInvariant();
        if (key.Length > MaxNameKeyCharacters)
        {
            throw new AuthorSavedViewValidationException("saved_view_name_invalid");
        }

        return key;
    }

    public static string ComputeViewDigest(
        AuthorSavedViewOwner owner,
        Guid viewId,
        long revision,
        string name,
        string queryDigest,
        string dependencyDigest,
        bool pinned,
        long orderKey,
        AuthorSavedViewLifecycleState lifecycleState)
        => ComputeCommandDigest(
            AuthorSavedViewContract.SchemaVersion,
            owner.AdminPrincipalId,
            owner.SiteScope,
            viewId,
            revision,
            name,
            queryDigest,
            dependencyDigest,
            pinned,
            orderKey,
            (int)lifecycleState);

    public static string ComputeCommandDigest(params object?[] values)
    {
        var canonical = new AuthorSavedViewContract.CanonicalDigestBuilder();
        foreach (object? value in values)
        {
            canonical.Append(value);
        }

        return canonical.Finish();
    }

    public static string ComputeCollectionDigest(
        AuthorSavedViewOwner owner,
        long revision,
        Guid? defaultViewId,
        int activeViewCount,
        string commandDigest)
        => ComputeCommandDigest(
            AuthorSavedViewContract.SchemaVersion,
            owner.AdminPrincipalId,
            owner.SiteScope,
            revision,
            defaultViewId,
            activeViewCount,
            commandDigest);

    public static string ComputeHistoryChangeDigest(
        Guid receiptId,
        int changeIndex,
        Guid viewId,
        AuthorSavedViewHistoryChangeKind kind,
        AuthorSavedViewHistoryViewState? before,
        AuthorSavedViewHistoryViewState? after)
        => ComputeCommandDigest(
            receiptId,
            changeIndex,
            viewId,
            (int)kind,
            before?.Revision,
            before?.Name,
            before?.QueryDigest,
            before?.DependencyDigest,
            before?.Pinned,
            before?.OrderKey,
            before is null ? null : (int)before.LifecycleState,
            before?.ContentDigest,
            after?.Revision,
            after?.Name,
            after?.QueryDigest,
            after?.DependencyDigest,
            after?.Pinned,
            after?.OrderKey,
            after is null ? null : (int)after.LifecycleState,
            after?.ContentDigest);

    public static string ComputeHistoryChangesDigest(IReadOnlyList<AuthorSavedViewHistoryChange> changes)
        => ComputeCommandDigest(
            changes.Count,
            string.Join('|', changes.OrderBy(static change => change.ChangeIndex)
                .Select(static change => change.ContentDigest)));

    public static string ComputeReceiptDigest(AuthorSavedViewWriteReceipt receipt)
        => ComputeCommandDigest(
            receipt.ReceiptId,
            receipt.RequestId,
            receipt.Owner.AdminPrincipalId,
            receipt.Owner.SiteScope,
            receipt.CommandKind,
            receipt.CommandDigest,
            receipt.ViewId,
            receipt.ViewRevision,
            receipt.PreviousCollectionRevision,
            receipt.CollectionRevision,
            receipt.QueryDigest,
            receipt.DependencyDigest,
            receipt.Pinned,
            receipt.PreviousDefaultViewId,
            receipt.DefaultViewId,
            receipt.PreviousActiveViewCount,
            receipt.ActiveViewCount,
            receipt.OrderKey,
            (int)receipt.LifecycleState,
            (int)receipt.DefaultTransition,
            receipt.ChangeCount,
            receipt.ChangesDigest,
            receipt.ReasonCode,
            receipt.OccurredAtUtc.Ticks);
}

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

    Task<AuthorSavedViewWriteReceipt> MovePinnedAsync(
        MoveAuthorSavedViewsCommand command,
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
    private const string MoveCommand = "move-pinned";
    private const string DefaultCommand = "set-default";
    private const string RetireCommand = "retire";
    private const string DeleteCommand = "delete";

    public async Task<AuthorSavedViewWriteReceipt> CreateAsync(
        CreateAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateIdentity(command.Owner, command.ViewId, command.RequestId);
        string name = AuthorSavedViewStorageContract.NormalizeName(command.Name);
        string inputQueryDigest = AuthorSavedViewContract.ComputeQueryDigest(command.Query);
        string commandDigest = AuthorSavedViewStorageContract.ComputeCommandDigest(
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
                if (Active(transaction.Views).Count() >= AuthorSavedViewStorageContract.MaxViewsPerOwner)
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
        return await persistence.ReadViewAsync(owner, viewId, cancellationToken).ConfigureAwait(false);
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

        return await persistence.ReadPageAsync(owner, cursor, limit, cancellationToken).ConfigureAwait(false);
    }

    public async Task<AuthorSavedViewWriteReceipt> UpdateAsync(
        UpdateAuthorSavedViewCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateMutation(command.Owner, command.ViewId, command.RequestId, command.ExpectedViewRevision);
        string inputQueryDigest = AuthorSavedViewContract.ComputeQueryDigest(command.Query);
        string commandDigest = AuthorSavedViewStorageContract.ComputeCommandDigest(
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
        string name = AuthorSavedViewStorageContract.NormalizeName(command.Name);
        string commandDigest = AuthorSavedViewStorageContract.ComputeCommandDigest(
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
                ContentDigest = AuthorSavedViewStorageContract.ComputeViewDigest(
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
        string commandDigest = AuthorSavedViewStorageContract.ComputeCommandDigest(
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
                    ContentDigest = AuthorSavedViewStorageContract.ComputeViewDigest(
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
        if (command.OrderedViewIds.Count > AuthorSavedViewStorageContract.MaxViewsPerOwner
            || command.OrderedViewIds.Any(static id => id == Guid.Empty)
            || command.OrderedViewIds.Distinct().Count() != command.OrderedViewIds.Count
            || command.ExpectedViewRevisions.Count != command.OrderedViewIds.Count)
        {
            throw new AuthorSavedViewValidationException("saved_view_reorder_invalid");
        }
        string commandDigest = AuthorSavedViewStorageContract.ComputeCommandDigest(
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
                        ContentDigest = AuthorSavedViewStorageContract.ComputeViewDigest(
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

    public Task<AuthorSavedViewWriteReceipt> MovePinnedAsync(
        MoveAuthorSavedViewsCommand command,
        CancellationToken cancellationToken = default)
    {
        AuthorSavedViewContract.ValidateOwner(command.Owner);
        ValidateGuid(command.RequestId, "saved_view_request_identity_invalid");
        if (command.MovedViewIds.Count is < 1 or > AuthorSavedViewStorageContract.MaxViewsPerOwner
            || command.MovedViewIds.Any(static id => id == Guid.Empty)
            || command.MovedViewIds.Distinct().Count() != command.MovedViewIds.Count
            || command.BeforeViewId == Guid.Empty
            || command.BeforeViewId is Guid before && command.MovedViewIds.Contains(before)
            || command.ExpectedViewRevisions.Count != command.MovedViewIds.Count
            || command.ExpectedViewRevisions.Keys.Any(id => !command.MovedViewIds.Contains(id)))
        {
            throw new AuthorSavedViewValidationException("saved_view_move_invalid");
        }
        string commandDigest = AuthorSavedViewStorageContract.ComputeCommandDigest(
            MoveCommand,
            command.ExpectedCollectionRevision,
            string.Join(',', command.MovedViewIds),
            command.BeforeViewId,
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
                    .. Active(transaction.Views)
                        .Where(static view => view.Pinned)
                        .OrderBy(static view => view.OrderKey)
                        .ThenBy(static view => view.Id)
                ];
                Dictionary<Guid, AuthorSavedView> byId = pinned.ToDictionary(static view => view.Id);
                foreach (Guid movedId in command.MovedViewIds)
                {
                    if (!byId.TryGetValue(movedId, out AuthorSavedView? moved))
                    {
                        throw new AuthorSavedViewValidationException("saved_view_move_set_mismatch");
                    }
                    EnsureViewRevision(moved, command.ExpectedViewRevisions[movedId]);
                }
                if (command.BeforeViewId is Guid anchorId && !byId.ContainsKey(anchorId))
                {
                    throw new AuthorSavedViewValidationException("saved_view_move_anchor_invalid");
                }

                HashSet<Guid> movedIds = command.MovedViewIds.ToHashSet();
                var reordered = pinned.Where(view => !movedIds.Contains(view.Id)).ToList();
                int insertionIndex = command.BeforeViewId is Guid anchor
                    ? reordered.FindIndex(view => view.Id == anchor)
                    : reordered.Count;
                reordered.InsertRange(
                    insertionIndex,
                    command.MovedViewIds.Select(id => byId[id]));

                DateTime now = UtcNow;
                var changed = new List<AuthorSavedView>();
                for (int index = 0; index < reordered.Count; index++)
                {
                    AuthorSavedView view = reordered[index];
                    long orderKey = index + 1;
                    if (view.OrderKey == orderKey)
                    {
                        continue;
                    }
                    changed.Add(view with
                    {
                        Revision = view.Revision + 1,
                        OrderKey = orderKey,
                        UpdatedAtUtc = now,
                        ContentDigest = AuthorSavedViewStorageContract.ComputeViewDigest(
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
                if (changed.Count == 0)
                {
                    throw new AuthorSavedViewValidationException("saved_view_move_noop");
                }

                AuthorSavedViewCollection collection = BuildCollection(
                    command.Owner,
                    transaction.Collection.Revision + 1,
                    transaction.Collection.DefaultViewId,
                    transaction.Collection.ActiveViewCount,
                    commandDigest);
                return Mutation(
                    collection,
                    changed,
                    [],
                    command.MovedViewIds[0],
                    MoveCommand,
                    commandDigest,
                    now);
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
        string commandDigest = AuthorSavedViewStorageContract.ComputeCommandDigest(
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
        AuthorSavedViewVerificationHistory history = await persistence.ReadVerificationHistoryAsync(
            owner,
            cancellationToken).ConfigureAwait(false);
        AuthorSavedViewPersistenceSnapshot snapshot = history.Current;
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
        string collectionDigest = AuthorSavedViewStorageContract.ComputeCollectionDigest(
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
                    static view => AuthorSavedViewStorageContract.NormalizeNameKey(view.Name),
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

            string digest = AuthorSavedViewStorageContract.ComputeViewDigest(
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
        VerifyHistoryReplay(owner, history, reasons);
        return new AuthorSavedViewVerificationResult(
            reasons.Count == 0,
            Array.AsReadOnly(reasons.ToArray()));
    }

    private static void VerifyHistoryReplay(
        AuthorSavedViewOwner owner,
        AuthorSavedViewVerificationHistory history,
        List<string> reasons)
    {
        AuthorSavedViewWriteReceipt[] receipts =
        [
            .. history.Receipts
                .OrderBy(static receipt => receipt.CollectionRevision)
                .ThenBy(static receipt => receipt.ReceiptId)
        ];
        Dictionary<Guid, AuthorSavedViewWriteReceipt> receiptById = receipts
            .GroupBy(static receipt => receipt.ReceiptId)
            .Where(static group => group.Count() == 1)
            .ToDictionary(static group => group.Key, static group => group.Single());
        if (receiptById.Count != receipts.Length)
        {
            reasons.Add("saved_view_history_duplicate_receipt");
        }

        VerifyIdempotencyHistory(receipts, history.IdempotencyRecords, reasons);
        var replay = new Dictionary<Guid, AuthorSavedViewHistoryViewState>();
        long collectionRevision = 0;
        Guid? defaultViewId = null;
        int activeViewCount = 0;

        foreach (AuthorSavedViewWriteReceipt receipt in receipts)
        {
            if (receipt.Owner != owner)
            {
                reasons.Add($"saved_view_history_owner_mismatch:{receipt.ReceiptId:D}");
            }
            if (receipt.PreviousCollectionRevision != collectionRevision
                || receipt.CollectionRevision != collectionRevision + 1)
            {
                reasons.Add($"saved_view_history_collection_revision_gap:{receipt.ReceiptId:D}");
            }
            if (receipt.PreviousDefaultViewId != defaultViewId
                || receipt.PreviousActiveViewCount != activeViewCount)
            {
                reasons.Add($"saved_view_history_collection_before_mismatch:{receipt.ReceiptId:D}");
            }
            if (!string.Equals(
                AuthorSavedViewStorageContract.ComputeReceiptDigest(receipt),
                receipt.ContentDigest,
                StringComparison.Ordinal))
            {
                reasons.Add($"saved_view_history_receipt_digest_mismatch:{receipt.ReceiptId:D}");
            }

            AuthorSavedViewHistoryChange[] changes =
            [
                .. history.Changes
                    .Where(change => change.ReceiptId == receipt.ReceiptId)
                    .OrderBy(static change => change.ChangeIndex)
            ];
            if (changes.Length != receipt.ChangeCount
                || changes.Select(static change => change.ChangeIndex)
                    .Where((index, position) => index != position)
                    .Any()
                || changes.Select(static change => change.ViewId).Distinct().Count() != changes.Length)
            {
                reasons.Add($"saved_view_history_change_cardinality_mismatch:{receipt.ReceiptId:D}");
            }
            if (!string.Equals(ComputeChangesDigest(changes), receipt.ChangesDigest, StringComparison.Ordinal))
            {
                reasons.Add($"saved_view_history_changes_digest_mismatch:{receipt.ReceiptId:D}");
            }

            Dictionary<Guid, AuthorSavedViewHistoryViewState> beforeReplay = new(replay);
            foreach (AuthorSavedViewHistoryChange change in changes)
            {
                VerifyAndApplyHistoryChange(owner, receipt, change, replay, reasons);
            }
            VerifyCommandReplay(receipt, changes, beforeReplay, replay, reasons);

            int replayActiveCount = replay.Values.Count(
                static state => state.LifecycleState == AuthorSavedViewLifecycleState.Active);
            if (receipt.ActiveViewCount != replayActiveCount)
            {
                reasons.Add($"saved_view_history_active_count_mismatch:{receipt.ReceiptId:D}");
            }
            if (receipt.DefaultViewId is Guid replayDefault
                && (!replay.TryGetValue(replayDefault, out AuthorSavedViewHistoryViewState? defaultState)
                    || defaultState.LifecycleState != AuthorSavedViewLifecycleState.Active))
            {
                reasons.Add($"saved_view_history_default_invalid:{receipt.ReceiptId:D}");
            }
            VerifyDefaultTransition(receipt, beforeReplay, replay, reasons);
            VerifyReplayOrdering(
                receipt,
                replay,
                requireContiguous: receipt.CommandKind is ReorderCommand or MoveCommand,
                reasons);

            collectionRevision = receipt.CollectionRevision;
            defaultViewId = receipt.DefaultViewId;
            activeViewCount = receipt.ActiveViewCount;
        }

        if (history.Changes.Any(change => !receiptById.ContainsKey(change.ReceiptId)))
        {
            reasons.Add("saved_view_history_orphan_change");
        }
        string replayLastCommandDigest = receipts.Length == 0
            ? AuthorSavedViewStorageContract.ComputeCommandDigest()
            : receipts[^1].CommandDigest;
        if (collectionRevision != history.Current.Collection.Revision
            || defaultViewId != history.Current.Collection.DefaultViewId
            || activeViewCount != history.Current.Collection.ActiveViewCount
            || replayLastCommandDigest != history.Current.Collection.LastCommandDigest)
        {
            reasons.Add("saved_view_history_final_collection_mismatch");
        }

        Dictionary<Guid, AuthorSavedViewHistoryViewState> current = history.Current.Views
            .GroupBy(static view => view.Id)
            .Where(static group => group.Count() == 1)
            .ToDictionary(static group => group.Key, static group => HistoryState(group.Single()));
        if (current.Count != history.Current.Views.Count
            || replay.Count != current.Count
            || replay.Any(item => !current.TryGetValue(item.Key, out AuthorSavedViewHistoryViewState? state)
                || state != item.Value))
        {
            reasons.Add("saved_view_history_final_view_state_mismatch");
        }
    }

    private static void VerifyIdempotencyHistory(
        IReadOnlyList<AuthorSavedViewWriteReceipt> receipts,
        IReadOnlyList<AuthorSavedViewIdempotencyRecord> records,
        List<string> reasons)
    {
        if (records.Count != receipts.Count
            || records.Select(static record => record.RequestId).Distinct().Count() != records.Count
            || records.Select(static record => record.ReceiptId).Distinct().Count() != records.Count)
        {
            reasons.Add("saved_view_history_idempotency_cardinality_mismatch");
        }
        foreach (AuthorSavedViewWriteReceipt receipt in receipts)
        {
            AuthorSavedViewIdempotencyRecord[] matches =
            [
                .. records.Where(record => record.ReceiptId == receipt.ReceiptId
                    || record.RequestId == receipt.RequestId)
            ];
            if (matches.Length != 1
                || matches[0].ReceiptId != receipt.ReceiptId
                || matches[0].RequestId != receipt.RequestId
                || !string.Equals(matches[0].CommandDigest, receipt.CommandDigest, StringComparison.Ordinal)
                || matches[0].CreatedAtUtc != receipt.OccurredAtUtc)
            {
                reasons.Add($"saved_view_history_idempotency_mismatch:{receipt.ReceiptId:D}");
            }
        }
    }

    private static void VerifyAndApplyHistoryChange(
        AuthorSavedViewOwner owner,
        AuthorSavedViewWriteReceipt receipt,
        AuthorSavedViewHistoryChange change,
        Dictionary<Guid, AuthorSavedViewHistoryViewState> replay,
        List<string> reasons)
    {
        if (!string.Equals(
            AuthorSavedViewStorageContract.ComputeHistoryChangeDigest(
                change.ReceiptId,
                change.ChangeIndex,
                change.ViewId,
                change.ChangeKind,
                change.Before,
                change.After),
            change.ContentDigest,
            StringComparison.Ordinal))
        {
            reasons.Add($"saved_view_history_change_digest_mismatch:{receipt.ReceiptId:D}:{change.ChangeIndex}");
        }
        if (change.After is null || !VerifyHistoryViewDigest(owner, change.ViewId, change.After))
        {
            reasons.Add($"saved_view_history_change_after_invalid:{receipt.ReceiptId:D}:{change.ChangeIndex}");
            return;
        }

        bool existed = replay.TryGetValue(change.ViewId, out AuthorSavedViewHistoryViewState? current);
        if (change.ChangeKind == AuthorSavedViewHistoryChangeKind.Create)
        {
            if (existed || change.Before is not null || change.After.Revision != 1)
            {
                reasons.Add($"saved_view_history_create_before_invalid:{receipt.ReceiptId:D}:{change.ChangeIndex}");
            }
            replay[change.ViewId] = change.After;
            return;
        }
        if (!existed || change.Before is null || current != change.Before
            || !VerifyHistoryViewDigest(owner, change.ViewId, change.Before)
            || change.After.Revision != change.Before.Revision + 1)
        {
            reasons.Add($"saved_view_history_change_before_invalid:{receipt.ReceiptId:D}:{change.ChangeIndex}");
        }
        if (change.ChangeKind == AuthorSavedViewHistoryChangeKind.Delete)
        {
            replay.Remove(change.ViewId);
        }
        else
        {
            replay[change.ViewId] = change.After;
        }
    }

    private static bool VerifyHistoryViewDigest(
        AuthorSavedViewOwner owner,
        Guid viewId,
        AuthorSavedViewHistoryViewState state)
        => string.Equals(
            AuthorSavedViewStorageContract.ComputeViewDigest(
                owner,
                viewId,
                state.Revision,
                state.Name,
                state.QueryDigest,
                state.DependencyDigest,
                state.Pinned,
                state.OrderKey,
                state.LifecycleState),
            state.ContentDigest,
            StringComparison.Ordinal);

    private static void VerifyCommandReplay(
        AuthorSavedViewWriteReceipt receipt,
        IReadOnlyList<AuthorSavedViewHistoryChange> changes,
        IReadOnlyDictionary<Guid, AuthorSavedViewHistoryViewState> before,
        IReadOnlyDictionary<Guid, AuthorSavedViewHistoryViewState> after,
        List<string> reasons)
    {
        bool exactSet = receipt.CommandKind switch
        {
            CreateCommand => changes.Count == 1
                && changes[0].ViewId == receipt.ViewId
                && changes[0].ChangeKind == AuthorSavedViewHistoryChangeKind.Create,
            UpdateCommand or RenameCommand or PinCommand or RetireCommand => changes.Count == 1
                && changes[0].ViewId == receipt.ViewId
                && changes[0].ChangeKind == AuthorSavedViewHistoryChangeKind.Upsert,
            DeleteCommand => changes.Count == 1
                && changes[0].ViewId == receipt.ViewId
                && changes[0].ChangeKind == AuthorSavedViewHistoryChangeKind.Delete,
            DefaultCommand => changes.Count == 0,
            ReorderCommand => changes.All(static change => change.ChangeKind == AuthorSavedViewHistoryChangeKind.Upsert)
                && changes.Select(static change => change.ViewId).ToHashSet()
                    .SetEquals(before.Where(static item => item.Value.Pinned
                        && item.Value.LifecycleState == AuthorSavedViewLifecycleState.Active)
                        .Select(static item => item.Key)),
            MoveCommand => changes.Count > 0
                && changes.All(static change => change.ChangeKind == AuthorSavedViewHistoryChangeKind.Upsert),
            _ => false
        };
        if (!exactSet)
        {
            reasons.Add($"saved_view_history_command_change_set_invalid:{receipt.ReceiptId:D}");
            return;
        }

        foreach (AuthorSavedViewHistoryChange change in changes)
        {
            if (change.Before is null || change.After is null)
            {
                continue;
            }
            AuthorSavedViewHistoryViewState previous = change.Before;
            AuthorSavedViewHistoryViewState next = change.After;
            bool semantics = receipt.CommandKind switch
            {
                UpdateCommand => previous.Name == next.Name
                    && previous.Pinned == next.Pinned
                    && previous.OrderKey == next.OrderKey
                    && previous.LifecycleState == next.LifecycleState,
                RenameCommand => previous.QueryDigest == next.QueryDigest
                    && previous.DependencyDigest == next.DependencyDigest
                    && previous.Pinned == next.Pinned
                    && previous.OrderKey == next.OrderKey
                    && previous.LifecycleState == next.LifecycleState,
                PinCommand => previous.Name == next.Name
                    && previous.QueryDigest == next.QueryDigest
                    && previous.DependencyDigest == next.DependencyDigest
                    && previous.LifecycleState == next.LifecycleState
                    && (next.Pinned ? next.OrderKey > 0 : next.OrderKey == 0),
                ReorderCommand or MoveCommand => previous.Name == next.Name
                    && previous.QueryDigest == next.QueryDigest
                    && previous.DependencyDigest == next.DependencyDigest
                    && previous.Pinned && next.Pinned
                    && previous.LifecycleState == next.LifecycleState,
                RetireCommand => previous.Name == next.Name
                    && previous.QueryDigest == next.QueryDigest
                    && previous.DependencyDigest == next.DependencyDigest
                    && previous.LifecycleState == AuthorSavedViewLifecycleState.Active
                    && next.LifecycleState == AuthorSavedViewLifecycleState.Retired
                    && !next.Pinned
                    && next.OrderKey == 0,
                DeleteCommand => previous.Name == next.Name
                    && previous.QueryDigest == next.QueryDigest
                    && previous.DependencyDigest == next.DependencyDigest
                    && previous.LifecycleState == AuthorSavedViewLifecycleState.Active
                    && next.LifecycleState == AuthorSavedViewLifecycleState.Retired
                    && !next.Pinned
                    && next.OrderKey == 0,
                _ => true
            };
            if (!semantics)
            {
                reasons.Add($"saved_view_history_command_semantics_invalid:{receipt.ReceiptId:D}:{change.ChangeIndex}");
            }
        }

        AuthorSavedViewHistoryViewState? subject = changes.FirstOrDefault(
                change => change.ViewId == receipt.ViewId)?.After
            ?? after.GetValueOrDefault(receipt.ViewId);
        if (subject is not null
            && (subject.Revision != receipt.ViewRevision
                || subject.QueryDigest != receipt.QueryDigest
                || subject.DependencyDigest != receipt.DependencyDigest
                || subject.Pinned != receipt.Pinned
                || subject.OrderKey != receipt.OrderKey
                || subject.LifecycleState != receipt.LifecycleState))
        {
            reasons.Add($"saved_view_history_receipt_subject_mismatch:{receipt.ReceiptId:D}");
        }
    }

    private static void VerifyDefaultTransition(
        AuthorSavedViewWriteReceipt receipt,
        IReadOnlyDictionary<Guid, AuthorSavedViewHistoryViewState> before,
        IReadOnlyDictionary<Guid, AuthorSavedViewHistoryViewState> after,
        List<string> reasons)
    {
        AuthorSavedViewDefaultTransition expected = receipt.CommandKind switch
        {
            DefaultCommand when receipt.DefaultViewId is null => AuthorSavedViewDefaultTransition.ClearToSystem,
            DefaultCommand => AuthorSavedViewDefaultTransition.SetView,
            RetireCommand or DeleteCommand when receipt.PreviousDefaultViewId == receipt.ViewId
                && receipt.DefaultViewId is null => AuthorSavedViewDefaultTransition.ClearToSystem,
            RetireCommand or DeleteCommand when receipt.PreviousDefaultViewId == receipt.ViewId
                => AuthorSavedViewDefaultTransition.ReplaceView,
            _ => AuthorSavedViewDefaultTransition.Unchanged
        };
        bool valid = receipt.DefaultTransition == expected;
        if (expected == AuthorSavedViewDefaultTransition.Unchanged)
        {
            valid &= receipt.PreviousDefaultViewId == receipt.DefaultViewId;
        }
        if (expected is AuthorSavedViewDefaultTransition.SetView or AuthorSavedViewDefaultTransition.ReplaceView)
        {
            valid &= receipt.DefaultViewId is Guid id
                && after.TryGetValue(id, out AuthorSavedViewHistoryViewState? state)
                && state.LifecycleState == AuthorSavedViewLifecycleState.Active;
        }
        if (receipt.CommandKind is RetireCommand or DeleteCommand
            && receipt.PreviousDefaultViewId != receipt.ViewId)
        {
            valid &= before.ContainsKey(receipt.ViewId);
        }
        if (!valid)
        {
            reasons.Add($"saved_view_history_default_transition_invalid:{receipt.ReceiptId:D}");
        }
    }

    private static void VerifyReplayOrdering(
        AuthorSavedViewWriteReceipt receipt,
        IReadOnlyDictionary<Guid, AuthorSavedViewHistoryViewState> replay,
        bool requireContiguous,
        List<string> reasons)
    {
        long[] orders =
        [
            .. replay.Values
                .Where(static state => state.Pinned
                    && state.LifecycleState == AuthorSavedViewLifecycleState.Active)
                .Select(static state => state.OrderKey)
                .Order()
        ];
        bool valid = orders.All(static order => order > 0)
            && orders.Distinct().Count() == orders.Length;
        if (requireContiguous)
        {
            valid &= orders.SequenceEqual(Enumerable.Range(1, orders.Length).Select(static value => (long)value));
        }
        if (!valid)
        {
            reasons.Add($"saved_view_history_order_invalid:{receipt.ReceiptId:D}");
        }
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
        string commandDigest = AuthorSavedViewStorageContract.ComputeCommandDigest(
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
                        ContentDigest = AuthorSavedViewStorageContract.ComputeViewDigest(
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
                        ContentDigest = AuthorSavedViewStorageContract.ComputeViewDigest(
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
                Guid receiptId = Guid.CreateVersion7();
                mutation = mutation with
                {
                    HistoryChanges = BuildHistoryChanges(receiptId, transaction.Views, mutation)
                };
                AuthorSavedViewWriteReceipt receipt = BuildReceipt(
                    receiptId,
                    owner,
                    requestId,
                    mutation,
                    transaction.Collection,
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
            AuthorSavedViewStorageContract.ComputeViewDigest(
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
            AuthorSavedViewStorageContract.ComputeCollectionDigest(
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
        => new(collection, upserts, deletes, subjectViewId, commandKind, commandDigest, reasonCode, now, []);

    private static AuthorSavedViewWriteReceipt BuildReceipt(
        Guid receiptId,
        AuthorSavedViewOwner owner,
        Guid requestId,
        AuthorSavedViewPersistenceMutation mutation,
        AuthorSavedViewCollection previousCollection,
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
        AuthorSavedViewDefaultTransition defaultTransition = ResolveDefaultTransition(
            mutation.CommandKind,
            mutation.SubjectViewId,
            previousCollection.DefaultViewId,
            mutation.Collection.DefaultViewId);
        string changesDigest = ComputeChangesDigest(mutation.HistoryChanges);
        var receipt = new AuthorSavedViewWriteReceipt(
            receiptId,
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
            string.Empty,
            mutation.OccurredAtUtc,
            false,
            previousCollection.Revision,
            previousCollection.DefaultViewId,
            previousCollection.ActiveViewCount,
            mutation.Collection.ActiveViewCount,
            defaultTransition,
            mutation.HistoryChanges.Count,
            changesDigest);
        return receipt with
        {
            ContentDigest = AuthorSavedViewStorageContract.ComputeReceiptDigest(receipt)
        };
    }

    private static IReadOnlyList<AuthorSavedViewHistoryChange> BuildHistoryChanges(
        Guid receiptId,
        IReadOnlyList<AuthorSavedView> currentViews,
        AuthorSavedViewPersistenceMutation mutation)
    {
        var changes = new List<AuthorSavedViewHistoryChange>(
            mutation.Upserts.Count + mutation.Deletes.Count);
        foreach (AuthorSavedView afterView in mutation.Upserts)
        {
            AuthorSavedView? beforeView = currentViews.FirstOrDefault(view => view.Id == afterView.Id);
            AuthorSavedViewHistoryChangeKind kind = beforeView is null
                ? AuthorSavedViewHistoryChangeKind.Create
                : AuthorSavedViewHistoryChangeKind.Upsert;
            changes.Add(BuildHistoryChange(
                receiptId,
                changes.Count,
                afterView.Id,
                kind,
                beforeView is null ? null : HistoryState(beforeView),
                HistoryState(afterView)));
        }
        foreach (Guid deletedId in mutation.Deletes)
        {
            AuthorSavedView beforeView = currentViews.Single(view => view.Id == deletedId);
            AuthorSavedViewHistoryViewState before = HistoryState(beforeView);
            AuthorSavedViewHistoryViewState after = before with
            {
                Revision = before.Revision + 1,
                Pinned = false,
                OrderKey = 0,
                LifecycleState = AuthorSavedViewLifecycleState.Retired,
                ContentDigest = AuthorSavedViewStorageContract.ComputeViewDigest(
                    beforeView.Owner,
                    beforeView.Id,
                    before.Revision + 1,
                    before.Name,
                    before.QueryDigest,
                    before.DependencyDigest,
                    false,
                    0,
                    AuthorSavedViewLifecycleState.Retired)
            };
            changes.Add(BuildHistoryChange(
                receiptId,
                changes.Count,
                deletedId,
                AuthorSavedViewHistoryChangeKind.Delete,
                before,
                after));
        }
        return Array.AsReadOnly(changes.ToArray());
    }

    private static AuthorSavedViewHistoryChange BuildHistoryChange(
        Guid receiptId,
        int changeIndex,
        Guid viewId,
        AuthorSavedViewHistoryChangeKind kind,
        AuthorSavedViewHistoryViewState? before,
        AuthorSavedViewHistoryViewState? after)
    {
        string digest = AuthorSavedViewStorageContract.ComputeHistoryChangeDigest(
            receiptId,
            changeIndex,
            viewId,
            kind,
            before,
            after);
        return new(receiptId, changeIndex, viewId, kind, before, after, digest);
    }

    private static AuthorSavedViewHistoryViewState HistoryState(AuthorSavedView view)
        => new(
            view.Revision,
            view.Name,
            view.QueryDigest,
            view.DependencyDigest,
            view.Pinned,
            view.OrderKey,
            view.LifecycleState,
            view.ContentDigest);

    private static string ComputeChangesDigest(IReadOnlyList<AuthorSavedViewHistoryChange> changes)
        => AuthorSavedViewStorageContract.ComputeHistoryChangesDigest(changes);

    private static AuthorSavedViewDefaultTransition ResolveDefaultTransition(
        string commandKind,
        Guid subjectViewId,
        Guid? previousDefaultViewId,
        Guid? defaultViewId)
    {
        if (commandKind == DefaultCommand)
        {
            return defaultViewId is null
                ? AuthorSavedViewDefaultTransition.ClearToSystem
                : AuthorSavedViewDefaultTransition.SetView;
        }
        if (commandKind is RetireCommand or DeleteCommand
            && previousDefaultViewId == subjectViewId)
        {
            return defaultViewId is null
                ? AuthorSavedViewDefaultTransition.ClearToSystem
                : AuthorSavedViewDefaultTransition.ReplaceView;
        }
        return AuthorSavedViewDefaultTransition.Unchanged;
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
        string nameKey = AuthorSavedViewStorageContract.NormalizeNameKey(name);
        if (Active(views).Any(view => view.Id != exceptViewId
                && string.Equals(
                    AuthorSavedViewStorageContract.NormalizeNameKey(view.Name),
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

    private DateTime UtcNow
    {
        get
        {
            DateTime now = timeProvider.GetUtcNow().UtcDateTime;
            return new DateTime(now.Ticks - now.Ticks % TimeSpan.TicksPerMicrosecond, DateTimeKind.Utc);
        }
    }
}

/// <summary>
/// Production persistence boundary. ExecuteAsync must provide an owner/site-exclusive,
/// serializable transaction. The authority above is shared by PostgreSQL and local
/// production-boundary simulations; persistence never owns business transitions.
/// </summary>
public interface IAuthorSavedViewPersistence
{
    Task<AuthorSavedView?> ReadViewAsync(
        AuthorSavedViewOwner owner,
        Guid viewId,
        CancellationToken cancellationToken = default);

    Task<AuthorSavedViewPage> ReadPageAsync(
        AuthorSavedViewOwner owner,
        AuthorSavedViewPageCursor? cursor,
        int limit,
        CancellationToken cancellationToken = default);

    Task<T> ExecuteAsync<T>(
        AuthorSavedViewOwner owner,
        Func<IAuthorSavedViewPersistenceTransaction, CancellationToken, Task<T>> operation,
        CancellationToken cancellationToken = default);

    Task<AuthorSavedViewVerificationHistory> ReadVerificationHistoryAsync(
        AuthorSavedViewOwner owner,
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
    DateTime OccurredAtUtc,
    IReadOnlyList<AuthorSavedViewHistoryChange> HistoryChanges);

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
        string emptyDigest = AuthorSavedViewStorageContract.ComputeCommandDigest();
        return new(
            owner,
            0,
            null,
            0,
            emptyDigest,
            AuthorSavedViewStorageContract.ComputeCollectionDigest(owner, 0, null, 0, emptyDigest));
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
    bool IdempotentReplay,
    long PreviousCollectionRevision,
    Guid? PreviousDefaultViewId,
    int PreviousActiveViewCount,
    int ActiveViewCount,
    AuthorSavedViewDefaultTransition DefaultTransition,
    int ChangeCount,
    string ChangesDigest);

public enum AuthorSavedViewHistoryChangeKind
{
    Create = 0,
    Upsert = 1,
    Delete = 2
}

public enum AuthorSavedViewDefaultTransition
{
    Unchanged = 0,
    SetView = 1,
    ClearToSystem = 2,
    ReplaceView = 3
}

public sealed record AuthorSavedViewHistoryViewState(
    long Revision,
    string Name,
    string QueryDigest,
    string DependencyDigest,
    bool Pinned,
    long OrderKey,
    AuthorSavedViewLifecycleState LifecycleState,
    string ContentDigest);

public sealed record AuthorSavedViewHistoryChange(
    Guid ReceiptId,
    int ChangeIndex,
    Guid ViewId,
    AuthorSavedViewHistoryChangeKind ChangeKind,
    AuthorSavedViewHistoryViewState? Before,
    AuthorSavedViewHistoryViewState? After,
    string ContentDigest);

public sealed record AuthorSavedViewIdempotencyRecord(
    Guid RequestId,
    Guid ReceiptId,
    string CommandDigest,
    DateTime CreatedAtUtc);

public sealed record AuthorSavedViewVerificationHistory(
    AuthorSavedViewPersistenceSnapshot Current,
    IReadOnlyList<AuthorSavedViewWriteReceipt> Receipts,
    IReadOnlyList<AuthorSavedViewHistoryChange> Changes,
    IReadOnlyList<AuthorSavedViewIdempotencyRecord> IdempotencyRecords);

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

public sealed record MoveAuthorSavedViewsCommand(
    AuthorSavedViewOwner Owner,
    long ExpectedCollectionRevision,
    Guid RequestId,
    IReadOnlyList<Guid> MovedViewIds,
    Guid? BeforeViewId,
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

public enum AuthorSavedViewLifecycleState
{
    Active = 0,
    Retired = 1
}

public enum AuthorSavedViewDefaultDisposition
{
    NotApplicable = 0,
    ClearToSystem = 1,
    ReplaceWithView = 2
}

public sealed class AuthorSavedViewDependencyException(IReadOnlyList<string> reasons)
    : Exception("saved_view_dependency_invalid")
{
    public IReadOnlyList<string> Reasons { get; } = reasons;
}

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
