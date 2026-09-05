using System.Collections.Concurrent;

using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorSavedViewStoreTests
{
    private static readonly AuthorSavedViewOwner s_owner = new(11, "primary-site");
    private static readonly AuthorSavedViewOwner s_otherOwner = new(12, "primary-site");

    [Fact]
    public async Task Authority_ReplaysCrudCasPinDefaultOrderRetireDeleteAndPrivacy()
    {
        var persistence = new LocalProductionBoundaryPersistence();
        var store = Store(persistence);
        Guid firstId = Guid.CreateVersion7();
        Guid secondId = Guid.CreateVersion7();
        Guid createRequest = Guid.CreateVersion7();
        var createFirst = new CreateAuthorSavedViewCommand(
            firstId,
            s_owner,
            0,
            createRequest,
            "Personal",
            Query(pageSize: 25));

        AuthorSavedViewWriteReceipt created = await store.CreateAsync(createFirst);
        AuthorSavedViewWriteReceipt replay = await store.CreateAsync(createFirst);
        Assert.Equal(1, created.CollectionRevision);
        Assert.True(replay.IdempotentReplay);
        Assert.Equal(created.ReceiptId, replay.ReceiptId);
        await Assert.ThrowsAsync<AuthorSavedViewIdempotencyConflictException>(() => store.CreateAsync(
            createFirst with
            {
                Name = "Different"
            }));
        Assert.Null(await store.GetAsync(s_otherOwner, firstId));
        Assert.Null(await store.GetAsync(new AuthorSavedViewOwner(11, "other-site"), firstId));

        AuthorSavedViewWriteReceipt second = await store.CreateAsync(new(
            secondId,
            s_owner,
            1,
            Guid.CreateVersion7(),
            "Second",
            Query(pageSize: 25)));
        Assert.Equal(2, second.CollectionRevision);
        await Assert.ThrowsAsync<AuthorSavedViewNameConflictException>(() => store.RenameAsync(new(
            secondId,
            s_owner,
            2,
            1,
            Guid.CreateVersion7(),
            "PERSONAL")));

        AuthorSavedViewWriteReceipt updated = await store.UpdateAsync(new(
            firstId,
            s_owner,
            2,
            1,
            Guid.CreateVersion7(),
            Query(pageSize: 50)));
        Assert.Equal(2, updated.ViewRevision);
        Assert.NotEqual(created.QueryDigest, updated.QueryDigest);
        AuthorSavedViewWriteReceipt renamed = await store.RenameAsync(new(
            firstId,
            s_owner,
            3,
            2,
            Guid.CreateVersion7(),
            "Renamed"));
        Assert.Equal(firstId, renamed.ViewId);
        await Assert.ThrowsAsync<AuthorSavedViewCollectionRevisionConflictException>(() => store.RenameAsync(new(
            firstId,
            s_owner,
            3,
            3,
            Guid.CreateVersion7(),
            "Stale device")));

        AuthorSavedViewWriteReceipt firstPinned = await store.SetPinnedAsync(new(
            firstId, s_owner, 4, 3, Guid.CreateVersion7(), true));
        AuthorSavedViewWriteReceipt secondPinned = await store.SetPinnedAsync(new(
            secondId, s_owner, 5, 1, Guid.CreateVersion7(), true));
        Assert.Equal(1, firstPinned.OrderKey);
        Assert.Equal(2, secondPinned.OrderKey);
        AuthorSavedViewWriteReceipt reordered = await store.ReorderPinnedAsync(new(
            s_owner,
            6,
            Guid.CreateVersion7(),
            [secondId, firstId],
            new Dictionary<Guid, long>
            {
                [firstId] = 4,
                [secondId] = 2
            }));
        Assert.Equal(7, reordered.CollectionRevision);
        Assert.Equal([secondId, firstId], (await store.ListAsync(s_owner, null, 10)).Items.Select(view => view.Id));

        AuthorSavedViewWriteReceipt madeDefault = await store.SetDefaultAsync(new(
            s_owner, 7, Guid.CreateVersion7(), firstId, 5));
        Assert.Equal(firstId, madeDefault.DefaultViewId);
        await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() => store.RetireAsync(new(
            firstId,
            s_owner,
            8,
            5,
            Guid.CreateVersion7(),
            AuthorSavedViewDefaultDisposition.NotApplicable,
            null,
            null,
            "user-retired")));
        AuthorSavedViewWriteReceipt retired = await store.RetireAsync(new(
            firstId,
            s_owner,
            8,
            5,
            Guid.CreateVersion7(),
            AuthorSavedViewDefaultDisposition.ReplaceWithView,
            secondId,
            3,
            "user-retired"));
        Assert.Equal(AuthorSavedViewLifecycleState.Retired, retired.LifecycleState);
        Assert.Equal(secondId, retired.DefaultViewId);
        Assert.Single((await store.ListAsync(s_owner, null, 10)).Items);

        AuthorSavedViewWriteReceipt deleted = await store.DeleteAsync(new(
            secondId,
            s_owner,
            9,
            3,
            Guid.CreateVersion7(),
            AuthorSavedViewDefaultDisposition.ClearToSystem,
            null,
            null,
            "user-deleted"));
        Assert.Equal(AuthorSavedViewLifecycleState.Retired, deleted.LifecycleState);
        Assert.Null(deleted.DefaultViewId);
        Assert.Null(await store.GetAsync(s_owner, secondId));
        Assert.Empty((await store.ListAsync(s_owner, null, 10)).Items);
        Assert.True((await store.VerifyAsync(s_owner)).Valid);
        Assert.Equal(10, persistence.ReceiptCount(s_owner));
        Assert.DoesNotContain("published", deleted.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Authority_TwoDevicesUseCollectionAndViewCasWithoutSilentLastWriteWins()
    {
        var persistence = new LocalProductionBoundaryPersistence();
        var store = Store(persistence);
        Guid viewId = Guid.CreateVersion7();
        await store.CreateAsync(new(
            viewId, s_owner, 0, Guid.CreateVersion7(), "Concurrent", Query(25)));
        Guid requestId = Guid.CreateVersion7();
        var command = new RenameAuthorSavedViewCommand(viewId, s_owner, 1, 1, requestId, "Winner");

        AuthorSavedViewWriteReceipt[] sameRequest = await Task.WhenAll(
            store.RenameAsync(command),
            store.RenameAsync(command));

        Assert.Equal(sameRequest[0].ReceiptId, sameRequest[1].ReceiptId);
        Assert.Single(sameRequest, static receipt => receipt.IdempotentReplay);
        Task<AuthorSavedViewWriteReceipt> first = store.RenameAsync(new(
            viewId, s_owner, 2, 2, Guid.CreateVersion7(), "Device A"));
        Task<AuthorSavedViewWriteReceipt> second = store.RenameAsync(new(
            viewId, s_owner, 2, 2, Guid.CreateVersion7(), "Device B"));
        try
        {
            await Task.WhenAll(first, second);
        }
        catch (AuthorSavedViewCollectionRevisionConflictException)
        {
        }
        Assert.Equal(1, new[] { first, second }.Count(task => task.Status == TaskStatus.RanToCompletion));
        Assert.Equal(1, new[] { first, second }.Count(task => task.IsFaulted));
    }

    [Fact]
    public async Task Authority_RejectsInvalidDependencyAndFutureAstBeforePersistence()
    {
        var persistence = new LocalProductionBoundaryPersistence();
        var invalidProvider = new ExternalDependencyProvider(AuthorSavedViewDependencyStatus.Deleted);
        var store = new AuthorSavedViewStore(
            persistence,
            new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([invalidProvider])),
            TimeProvider.System);
        AuthorSavedViewQuery external = Query(25) with
        {
            Conditions =
            [
                new(new(AuthorSavedViewFieldKind.Tag, "tag:deleted"), "identity.equals", ["tag:deleted"])
            ]
        };

        await Assert.ThrowsAsync<AuthorSavedViewDependencyException>(() => store.CreateAsync(new(
            Guid.CreateVersion7(), s_owner, 0, Guid.CreateVersion7(), "Invalid dependency", external)));
        await Assert.ThrowsAsync<AuthorSavedViewValidationException>(() => store.CreateAsync(new(
            Guid.CreateVersion7(),
            s_owner,
            0,
            Guid.CreateVersion7(),
            "Future AST",
            Query(25) with
            {
                SchemaVersion = AuthorSavedViewContract.SchemaVersion + 1
            })));
        Assert.Equal(0, persistence.CommitCount);
    }

    [Fact]
    public async Task Authority_IdempotentReplaySurvivesLaterDependencyRetirement()
    {
        var persistence = new LocalProductionBoundaryPersistence();
        var provider = new ExternalDependencyProvider(AuthorSavedViewDependencyStatus.Current);
        var store = new AuthorSavedViewStore(
            persistence,
            new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([provider])),
            TimeProvider.System);
        Guid viewId = Guid.CreateVersion7();
        Guid requestId = Guid.CreateVersion7();
        AuthorSavedViewQuery query = Query(25) with
        {
            Conditions =
            [
                new(new(AuthorSavedViewFieldKind.Tag, "tag:stable"), "identity.equals", ["tag:stable"])
            ]
        };
        var command = new CreateAuthorSavedViewCommand(
            viewId,
            s_owner,
            0,
            requestId,
            "Dependency replay",
            query);

        AuthorSavedViewWriteReceipt created = await store.CreateAsync(command);
        provider.Status = AuthorSavedViewDependencyStatus.Deleted;
        AuthorSavedViewWriteReceipt replay = await store.CreateAsync(command);

        Assert.True(replay.IdempotentReplay);
        Assert.Equal(created.ReceiptId, replay.ReceiptId);
        Assert.Equal(1, persistence.CommitCount);
    }

    [Fact]
    public async Task Authority_PagesZeroOneAndOneThousandAndBatchReordersInOneCommit()
    {
        var persistence = new LocalProductionBoundaryPersistence();
        var store = Store(persistence);
        Assert.Empty((await store.ListAsync(s_owner, null, 100)).Items);

        AuthorSavedViewQueryValidationResult validation = await Validator().ValidateAsync(s_owner, Query(25));
        DateTime now = DateTime.UnixEpoch;
        AuthorSavedView[] views = Enumerable.Range(1, AuthorSavedViewContract.MaxViewsPerOwner)
            .Select(index => View(index, validation, now, pinned: true))
            .ToArray();
        persistence.Seed(s_owner, views, revision: 7);

        int count = 0;
        AuthorSavedViewPageCursor? cursor = null;
        do
        {
            AuthorSavedViewPage page = await store.ListAsync(s_owner, cursor, 100);
            count += page.Items.Count;
            cursor = page.NextCursor;
        }
        while (cursor is not null);
        Assert.Equal(1_000, count);

        Guid[] reversed = [.. views.Select(static view => view.Id).Reverse()];
        await store.ReorderPinnedAsync(new(
            s_owner,
            7,
            Guid.CreateVersion7(),
            reversed,
            views.ToDictionary(static view => view.Id, static view => view.Revision)));
        Assert.Equal(1, persistence.CommitCount);
        Assert.Equal(1_000, persistence.LastMutation!.Upserts.Count);
        Assert.Equal(
            reversed.Take(AuthorSavedViewContract.MaxPageSize),
            (await store.ListAsync(s_owner, null, AuthorSavedViewContract.MaxPageSize)).Items.Select(view => view.Id));
        await Assert.ThrowsAsync<AuthorSavedViewBudgetExceededException>(() => store.CreateAsync(new(
            Guid.CreateVersion7(), s_owner, 8, Guid.CreateVersion7(), "Overflow", Query(25))));
    }

    [Fact]
    public async Task Verifier_DetectsContentAndCollectionTamper()
    {
        var persistence = new LocalProductionBoundaryPersistence();
        var store = Store(persistence);
        Guid id = Guid.CreateVersion7();
        await store.CreateAsync(new(id, s_owner, 0, Guid.CreateVersion7(), "Verify", Query(25)));
        persistence.Tamper(s_owner, snapshot => snapshot with
        {
            Collection = snapshot.Collection with
            {
                ActiveViewCount = 99
            },
            Views = [snapshot.Views[0] with { ContentDigest = new string('f', 64) }]
        });

        AuthorSavedViewVerificationResult result = await store.VerifyAsync(s_owner);

        Assert.False(result.Valid);
        Assert.Contains("saved_view_active_count_mismatch", result.Reasons);
        Assert.Contains("saved_view_collection_digest_mismatch", result.Reasons);
        Assert.Contains($"saved_view_content_digest_mismatch:{id:D}", result.Reasons);
    }

    [Fact]
    public async Task Verifier_RecomputesPersistedQueryDigestInsteadOfTrustingStoredDigest()
    {
        var persistence = new LocalProductionBoundaryPersistence();
        var store = Store(persistence);
        Guid id = Guid.CreateVersion7();
        await store.CreateAsync(new(id, s_owner, 0, Guid.CreateVersion7(), "Query verify", Query(25)));
        persistence.Tamper(s_owner, snapshot => snapshot with
        {
            Views =
            [
                snapshot.Views[0] with
                {
                    Query = snapshot.Views[0].Query with { PageSize = 50 }
                }
            ]
        });

        AuthorSavedViewVerificationResult result = await store.VerifyAsync(s_owner);

        Assert.False(result.Valid);
        Assert.Contains($"saved_view_query_digest_mismatch:{id:D}", result.Reasons);
    }

    [Fact]
    public void StaticGovernance_HasOneAuthorityAndClosedRelationalMigration()
    {
        Type[] authorities = typeof(AuthorSavedViewStore).Assembly.GetTypes()
            .Where(type => typeof(IAuthorSavedViewStore).IsAssignableFrom(type) && !type.IsInterface)
            .ToArray();
        Assert.Equal([typeof(AuthorSavedViewStore)], authorities);
        Assert.DoesNotContain(
            typeof(AuthorSavedViewStore).Assembly.GetTypes(),
            type => type.Name.Contains("SavedViewDefinition", StringComparison.Ordinal)
                || type.Name.Contains("LocalStorage", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(
            typeof(AuthorSavedView).GetProperties(),
            property => property.Name.Contains("Result", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Permission", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Sql", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Function", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Facet", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("Snippet", StringComparison.OrdinalIgnoreCase));

        ISchemaMigrationDescriptor descriptor = AuthorSavedViewMigrationDefinitions.BuildMigration();
        string sql = Assert.IsType<RawSqlStep>(Assert.Single(descriptor.Steps)).Sql;
        Assert.True(descriptor.Transactional);
        Assert.Contains("author_saved_view_condition", sql, StringComparison.Ordinal);
        Assert.Contains("author_saved_view_condition_value", sql, StringComparison.Ordinal);
        Assert.Contains("author_saved_view_projection", sql, StringComparison.Ordinal);
        Assert.Contains("author_saved_view_receipt", sql, StringComparison.Ordinal);
        Assert.Contains("author_saved_view_idempotency", sql, StringComparison.Ordinal);
        Assert.Contains("name_key", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("json", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("article_ids", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("permission_snapshot", sql, StringComparison.OrdinalIgnoreCase);
    }

    private static AuthorSavedViewStore Store(LocalProductionBoundaryPersistence persistence)
        => new(persistence, Validator(), TimeProvider.System);

    private static AuthorSavedViewQueryValidator Validator()
        => new(new AuthorSavedViewDependencyCatalog([]));

    private static AuthorSavedViewQuery Query(int pageSize)
        => new(
            AuthorSavedViewContract.SchemaVersion,
            [
                new(
                    new(AuthorSavedViewFieldKind.LifecycleStatus,
                        AuthorSavedViewContract.LifecycleStatusField),
                    "identity.equals",
                    ["published"])
            ],
            new(
                new(AuthorSavedViewFieldKind.LifecycleStatus,
                    AuthorSavedViewContract.LifecycleStatusField),
                AuthorSavedViewSortDirection.Ascending,
                AuthorSavedViewNullPlacement.Last,
                "ordinal"),
            [new(AuthorSavedViewFieldKind.LifecycleStatus, AuthorSavedViewContract.LifecycleStatusField)],
            pageSize);

    private static AuthorSavedView View(
        int index,
        AuthorSavedViewQueryValidationResult validation,
        DateTime now,
        bool pinned)
    {
        Guid id = Guid.Parse($"00000000-0000-0000-0000-{index:D12}");
        long orderKey = pinned ? index : 0;
        string name = $"view-{index:D4}";
        return new(
            id,
            s_owner,
            AuthorSavedViewContract.SchemaVersion,
            1,
            name,
            validation.Query,
            validation.QueryDigest,
            validation.DependencyDigest,
            pinned,
            orderKey,
            AuthorSavedViewLifecycleState.Active,
            now,
            now,
            AuthorSavedViewContract.ComputeViewDigest(
                s_owner,
                id,
                1,
                name,
                validation.QueryDigest,
                validation.DependencyDigest,
                pinned,
                orderKey,
                AuthorSavedViewLifecycleState.Active));
    }

    private sealed class ExternalDependencyProvider : IAuthorSavedViewDependencyProvider
    {
        public ExternalDependencyProvider(AuthorSavedViewDependencyStatus status)
        {
            Status = status;
        }

        public AuthorSavedViewDependencyStatus Status
        {
            get; set;
        }

        public ValueTask<AuthorSavedViewDependencyResolution?> ResolveConditionAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewCondition condition,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyResolution?>(new(
                condition.Field,
                condition.OperatorId,
                Status,
                "taxonomy-v1",
                AuthorSavedViewContract.FindBuiltInOperator(condition.OperatorId)!,
                condition.Values));

        public ValueTask<AuthorSavedViewDependencyResolution?> ResolveSortAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewSort sort,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyResolution?>(null);

        public ValueTask<AuthorSavedViewDependencyResolution?> ResolveProjectionAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewFieldReference field,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyResolution?>(null);
    }

    private sealed class LocalProductionBoundaryPersistence : IAuthorSavedViewPersistence
    {
        private readonly ConcurrentDictionary<AuthorSavedViewOwner, OwnerState> _states = new();
        private readonly ConcurrentDictionary<AuthorSavedViewOwner, SemaphoreSlim> _locks = new();

        public int CommitCount
        {
            get; private set;
        }
        public AuthorSavedViewPersistenceMutation? LastMutation
        {
            get; private set;
        }

        public async Task<T> ReadAsync<T>(
            AuthorSavedViewOwner owner,
            Func<AuthorSavedViewPersistenceSnapshot, T> read,
            CancellationToken cancellationToken = default)
        {
            SemaphoreSlim gate = _locks.GetOrAdd(owner, static _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(cancellationToken);
            try
            {
                OwnerState state = State(owner);
                return read(new AuthorSavedViewPersistenceSnapshot(state.Collection, [.. state.Views]));
            }
            finally
            {
                gate.Release();
            }
        }

        public async Task<T> ExecuteAsync<T>(
            AuthorSavedViewOwner owner,
            Func<IAuthorSavedViewPersistenceTransaction, CancellationToken, Task<T>> operation,
            CancellationToken cancellationToken = default)
        {
            SemaphoreSlim gate = _locks.GetOrAdd(owner, static _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(cancellationToken);
            try
            {
                OwnerState state = State(owner);
                return await operation(new Transaction(this, state), cancellationToken);
            }
            finally
            {
                gate.Release();
            }
        }

        public void Seed(
            AuthorSavedViewOwner owner,
            IReadOnlyList<AuthorSavedView> views,
            long revision)
        {
            string commandDigest = AuthorSavedViewContract.ComputeCommandDigest("seed", revision);
            var collection = new AuthorSavedViewCollection(
                owner,
                revision,
                null,
                views.Count(view => view.LifecycleState == AuthorSavedViewLifecycleState.Active),
                commandDigest,
                AuthorSavedViewContract.ComputeCollectionDigest(
                    owner,
                    revision,
                    null,
                    views.Count(view => view.LifecycleState == AuthorSavedViewLifecycleState.Active),
                    commandDigest));
            _states[owner] = new OwnerState(collection, [.. views], []);
            CommitCount = 0;
            LastMutation = null;
        }

        public void Tamper(
            AuthorSavedViewOwner owner,
            Func<AuthorSavedViewPersistenceSnapshot, AuthorSavedViewPersistenceSnapshot> tamper)
        {
            OwnerState state = State(owner);
            AuthorSavedViewPersistenceSnapshot changed = tamper(
                new AuthorSavedViewPersistenceSnapshot(state.Collection, [.. state.Views]));
            state.Collection = changed.Collection;
            state.Views = [.. changed.Views];
        }

        public int ReceiptCount(AuthorSavedViewOwner owner)
            => State(owner).Receipts.Count;

        private OwnerState State(AuthorSavedViewOwner owner)
            => _states.GetOrAdd(owner, static key => new OwnerState(
                AuthorSavedViewCollection.Empty(key),
                [],
                []));

        private sealed class Transaction(
            LocalProductionBoundaryPersistence persistence,
            OwnerState state) : IAuthorSavedViewPersistenceTransaction
        {
            private long? _proposedOrderKey;

            public AuthorSavedViewCollection Collection => state.Collection;
            public IReadOnlyList<AuthorSavedView> Views => state.Views;

            public Task<AuthorSavedViewWriteReceipt?> ReadReceiptAsync(
                Guid requestId,
                CancellationToken cancellationToken = default)
            {
                cancellationToken.ThrowIfCancellationRequested();
                state.Receipts.TryGetValue(requestId, out AuthorSavedViewWriteReceipt? receipt);
                return Task.FromResult(receipt);
            }

            public Task CommitAsync(
                AuthorSavedViewPersistenceMutation mutation,
                AuthorSavedViewWriteReceipt receipt,
                CancellationToken cancellationToken = default)
            {
                cancellationToken.ThrowIfCancellationRequested();
                state.Views.RemoveAll(view => mutation.Deletes.Contains(view.Id));
                foreach (AuthorSavedView upsert in mutation.Upserts)
                {
                    state.Views.RemoveAll(view => view.Id == upsert.Id);
                    state.Views.Add(upsert);
                }
                state.Collection = mutation.Collection;
                state.Receipts.Add(receipt.RequestId, receipt);
                persistence.CommitCount++;
                persistence.LastMutation = mutation;
                return Task.CompletedTask;
            }

            public void SetProposedOrderKey(long value)
                => _proposedOrderKey = value;

            public bool TryTakeProposedOrderKey(out long value)
            {
                value = _proposedOrderKey ?? 0;
                bool present = _proposedOrderKey is not null;
                _proposedOrderKey = null;
                return present;
            }
        }

        private sealed class OwnerState(
            AuthorSavedViewCollection collection,
            List<AuthorSavedView> views,
            Dictionary<Guid, AuthorSavedViewWriteReceipt> receipts)
        {
            public AuthorSavedViewCollection Collection { get; set; } = collection;
            public List<AuthorSavedView> Views { get; set; } = views;
            public Dictionary<Guid, AuthorSavedViewWriteReceipt> Receipts { get; } = receipts;
        }
    }
}
