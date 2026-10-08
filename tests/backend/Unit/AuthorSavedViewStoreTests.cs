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
        AuthorSavedView[] views = Enumerable.Range(1, AuthorSavedViewStorageContract.MaxViewsPerOwner)
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
    public async Task Authority_MovesSingleAndBatchWithOneBoundedMutationAndCas()
    {
        var persistence = new LocalProductionBoundaryPersistence();
        var store = Store(persistence);
        Guid[] viewIds = Enumerable.Range(1, 6)
            .Select(index => Guid.Parse($"00000000-0000-0000-0000-{index:D12}"))
            .ToArray();
        long collectionRevision = 0;
        foreach ((Guid viewId, int index) in viewIds.Select((id, index) => (id, index)))
        {
            await store.CreateAsync(new(
                viewId,
                s_owner,
                collectionRevision++,
                Guid.CreateVersion7(),
                $"Move {index + 1}",
                Query(25)));
            await store.SetPinnedAsync(new(
                viewId,
                s_owner,
                collectionRevision++,
                1,
                Guid.CreateVersion7(),
                true));
        }

        AuthorSavedViewWriteReceipt single = await store.MovePinnedAsync(new(
            s_owner,
            collectionRevision++,
            Guid.CreateVersion7(),
            [viewIds[5]],
            viewIds[0],
            new Dictionary<Guid, long> { [viewIds[5]] = 2 }));

        Assert.Equal(6, single.ChangeCount);
        Assert.Equal(6, persistence.LastMutation!.Upserts.Count);
        Assert.Equal(
            [viewIds[5], viewIds[0], viewIds[1], viewIds[2], viewIds[3], viewIds[4]],
            (await store.ListAsync(s_owner, null, 10)).Items.Select(static view => view.Id));

        AuthorSavedViewWriteReceipt batch = await store.MovePinnedAsync(new(
            s_owner,
            collectionRevision++,
            Guid.CreateVersion7(),
            [viewIds[1], viewIds[2]],
            viewIds[5],
            new Dictionary<Guid, long>
            {
                [viewIds[1]] = 3,
                [viewIds[2]] = 3
            }));

        Assert.Equal(4, batch.ChangeCount);
        Assert.Equal(4, persistence.LastMutation!.Upserts.Count);
        Assert.Equal(
            [viewIds[1], viewIds[2], viewIds[5], viewIds[0], viewIds[3], viewIds[4]],
            (await store.ListAsync(s_owner, null, 10)).Items.Select(static view => view.Id));
        Assert.True((await store.VerifyAsync(s_owner)).Valid);

        await Assert.ThrowsAsync<AuthorSavedViewCollectionRevisionConflictException>(() =>
            store.MovePinnedAsync(new(
                s_owner,
                collectionRevision - 1,
                Guid.CreateVersion7(),
                [viewIds[0]],
                null,
                new Dictionary<Guid, long> { [viewIds[0]] = 4 })));
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
    public async Task Verifier_DetectsBidirectionalReceiptAndIdempotencyTamper()
    {
        var persistence = new LocalProductionBoundaryPersistence();
        var store = Store(persistence);
        await store.CreateAsync(new(
            Guid.CreateVersion7(), s_owner, 0, Guid.CreateVersion7(), "Audit", Query(25)));
        persistence.TamperHistory(s_owner, history =>
        {
            string tampered = new('a', 64);
            AuthorSavedViewWriteReceipt receipt = history.Receipts[0] with
            {
                CommandDigest = tampered
            };
            AuthorSavedViewIdempotencyRecord idempotency = history.IdempotencyRecords[0] with
            {
                CommandDigest = tampered
            };
            return history with
            {
                Receipts = [receipt],
                IdempotencyRecords = [idempotency]
            };
        });

        AuthorSavedViewVerificationResult result = await store.VerifyAsync(s_owner);

        Assert.False(result.Valid);
        Assert.Contains(result.Reasons, static reason =>
            reason.StartsWith("saved_view_history_receipt_digest_mismatch:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Verifier_DetectsMissingReceiptAndBrokenCollectionRevisionChain()
    {
        var missingPersistence = new LocalProductionBoundaryPersistence();
        var missingStore = Store(missingPersistence);
        Guid firstId = Guid.CreateVersion7();
        await missingStore.CreateAsync(new(
            firstId, s_owner, 0, Guid.CreateVersion7(), "First", Query(25)));
        await missingStore.RenameAsync(new(
            firstId, s_owner, 1, 1, Guid.CreateVersion7(), "Renamed"));
        missingPersistence.TamperHistory(s_owner, history => history with
        {
            Receipts = [history.Receipts[1]],
            Changes = [.. history.Changes.Where(change => change.ReceiptId == history.Receipts[1].ReceiptId)],
            IdempotencyRecords = [history.IdempotencyRecords[1]]
        });

        AuthorSavedViewVerificationResult missing = await missingStore.VerifyAsync(s_owner);

        Assert.False(missing.Valid);
        Assert.Contains(missing.Reasons, static reason =>
            reason.StartsWith("saved_view_history_collection_revision_gap:", StringComparison.Ordinal));

        var revisionPersistence = new LocalProductionBoundaryPersistence();
        var revisionStore = Store(revisionPersistence);
        Guid secondId = Guid.CreateVersion7();
        await revisionStore.CreateAsync(new(
            secondId, s_owner, 0, Guid.CreateVersion7(), "Revision", Query(25)));
        await revisionStore.RenameAsync(new(
            secondId, s_owner, 1, 1, Guid.CreateVersion7(), "Revision two"));
        revisionPersistence.TamperHistory(s_owner, history =>
        {
            AuthorSavedViewWriteReceipt changed = history.Receipts[1] with
            {
                PreviousCollectionRevision = 17
            };
            changed = changed with
            {
                ContentDigest = AuthorSavedViewStorageContract.ComputeReceiptDigest(changed)
            };
            return history with
            {
                Receipts = [history.Receipts[0], changed]
            };
        });

        AuthorSavedViewVerificationResult revision = await revisionStore.VerifyAsync(s_owner);

        Assert.False(revision.Valid);
        Assert.Contains(revision.Reasons, static reason =>
            reason.StartsWith("saved_view_history_collection_revision_gap:", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Verifier_RejectsRehashedDefaultAndReorderSemanticTamper()
    {
        var persistence = new LocalProductionBoundaryPersistence();
        var store = Store(persistence);
        Guid firstId = Guid.CreateVersion7();
        Guid secondId = Guid.CreateVersion7();
        await store.CreateAsync(new(firstId, s_owner, 0, Guid.CreateVersion7(), "First", Query(25)));
        await store.CreateAsync(new(secondId, s_owner, 1, Guid.CreateVersion7(), "Second", Query(25)));
        await store.SetPinnedAsync(new(firstId, s_owner, 2, 1, Guid.CreateVersion7(), true));
        await store.SetPinnedAsync(new(secondId, s_owner, 3, 1, Guid.CreateVersion7(), true));
        await store.ReorderPinnedAsync(new(
            s_owner,
            4,
            Guid.CreateVersion7(),
            [secondId, firstId],
            new Dictionary<Guid, long>
            {
                [firstId] = 2,
                [secondId] = 2
            }));
        await store.SetDefaultAsync(new(s_owner, 5, Guid.CreateVersion7(), firstId, 3));
        persistence.TamperHistory(s_owner, history =>
        {
            AuthorSavedViewWriteReceipt defaultReceipt = history.Receipts.Single(
                static receipt => receipt.CommandKind == "set-default") with
            {
                DefaultTransition = AuthorSavedViewDefaultTransition.Unchanged
            };
            defaultReceipt = defaultReceipt with
            {
                ContentDigest = AuthorSavedViewStorageContract.ComputeReceiptDigest(defaultReceipt)
            };

            AuthorSavedViewWriteReceipt reorderReceipt = history.Receipts.Single(
                static receipt => receipt.CommandKind == "reorder-pinned");
            AuthorSavedViewHistoryChange[] reorderChanges =
            [
                .. history.Changes
                    .Where(change => change.ReceiptId == reorderReceipt.ReceiptId)
                    .OrderBy(static change => change.ChangeIndex)
            ];
            AuthorSavedViewHistoryChange second = reorderChanges[1];
            AuthorSavedViewHistoryViewState changedAfter = second.After! with
            {
                OrderKey = reorderChanges[0].After!.OrderKey,
                ContentDigest = AuthorSavedViewStorageContract.ComputeViewDigest(
                    s_owner,
                    second.ViewId,
                    second.After!.Revision,
                    second.After.Name,
                    second.After.QueryDigest,
                    second.After.DependencyDigest,
                    second.After.Pinned,
                    reorderChanges[0].After!.OrderKey,
                    second.After.LifecycleState)
            };
            second = second with
            {
                After = changedAfter
            };
            second = second with
            {
                ContentDigest = AuthorSavedViewStorageContract.ComputeHistoryChangeDigest(
                    second.ReceiptId,
                    second.ChangeIndex,
                    second.ViewId,
                    second.ChangeKind,
                    second.Before,
                    second.After)
            };
            reorderChanges[1] = second;
            reorderReceipt = reorderReceipt with
            {
                ChangesDigest = AuthorSavedViewStorageContract.ComputeHistoryChangesDigest(reorderChanges)
            };
            reorderReceipt = reorderReceipt with
            {
                ContentDigest = AuthorSavedViewStorageContract.ComputeReceiptDigest(reorderReceipt)
            };

            return history with
            {
                Receipts =
                [
                    .. history.Receipts.Select(receipt => receipt.ReceiptId switch
                    {
                        var id when id == defaultReceipt.ReceiptId => defaultReceipt,
                        var id when id == reorderReceipt.ReceiptId => reorderReceipt,
                        _ => receipt
                    })
                ],
                Changes =
                [
                    .. history.Changes.Where(change => change.ReceiptId != reorderReceipt.ReceiptId),
                    .. reorderChanges
                ]
            };
        });

        AuthorSavedViewVerificationResult result = await store.VerifyAsync(s_owner);

        Assert.False(result.Valid);
        Assert.Contains(result.Reasons, static reason =>
            reason.StartsWith("saved_view_history_default_transition_invalid:", StringComparison.Ordinal));
        Assert.Contains(result.Reasons, static reason =>
            reason.StartsWith("saved_view_history_order_invalid:", StringComparison.Ordinal));
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
        Assert.Contains("author_saved_view_receipt_change", sql, StringComparison.Ordinal);
        Assert.Contains("author_saved_view_idempotency", sql, StringComparison.Ordinal);
        Assert.Contains("previous_collection_revision", sql, StringComparison.Ordinal);
        Assert.Contains("default_transition", sql, StringComparison.Ordinal);
        Assert.Contains("before_name", sql, StringComparison.Ordinal);
        Assert.Contains("after_name", sql, StringComparison.Ordinal);
        Assert.Contains("name_key", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("json", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("article_ids", sql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("permission_snapshot", sql, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(7)]
    [InlineData(9)]
    public async Task Authority_NormalizesClockBeforeReceiptDigestAndViewTimestamps(int subMicrosecondTicks)
    {
        DateTime now = new(638962848000000000 + subMicrosecondTicks, DateTimeKind.Utc);
        DateTime expected = new(now.Ticks - now.Ticks % TimeSpan.TicksPerMicrosecond, DateTimeKind.Utc);
        var persistence = new LocalProductionBoundaryPersistence();
        var store = new AuthorSavedViewStore(persistence, Validator(), new FixedUtcTimeProvider(now));
        var command = new CreateAuthorSavedViewCommand(Guid.CreateVersion7(), s_owner,
            0, Guid.CreateVersion7(), "Timestamp", Query(25));
        AuthorSavedViewWriteReceipt created = await store.CreateAsync(command);
        Assert.Equal(expected, created.OccurredAtUtc);
        AuthorSavedViewVerificationHistory history = await persistence.ReadVerificationHistoryAsync(s_owner);
        AuthorSavedViewWriteReceipt persisted = Assert.Single(history.Receipts);
        Assert.Equal(expected, persisted.OccurredAtUtc);
        Assert.Equal(created.ContentDigest, AuthorSavedViewStorageContract.ComputeReceiptDigest(persisted));
        AuthorSavedView stored = Assert.IsType<AuthorSavedView>(await store.GetAsync(s_owner, command.ViewId));
        Assert.Equal(expected, stored.CreatedAtUtc);
        Assert.Equal(expected, stored.UpdatedAtUtc);
        Assert.True((await store.VerifyAsync(s_owner)).Valid);
        AuthorSavedViewWriteReceipt replay = await store.CreateAsync(command);
        Assert.True(replay.IdempotentReplay);
        Assert.Equal(created.ContentDigest, replay.ContentDigest);
    }

    private sealed class FixedUtcTimeProvider(DateTime now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => new(now);
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
            AuthorSavedViewStorageContract.ComputeViewDigest(
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

        public ValueTask<AuthorSavedViewDependencyFact?> ResolveConditionAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewCondition condition,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyFact?>(new(
                condition.Field,
                condition.OperatorId,
                Status,
                "taxonomy-v1",
                condition.Values));

        public ValueTask<AuthorSavedViewDependencyFact?> ResolveSortAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewSort sort,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyFact?>(null);

        public ValueTask<AuthorSavedViewDependencyFact?> ResolveProjectionAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewFieldReference field,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult<AuthorSavedViewDependencyFact?>(null);
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

        public Task<AuthorSavedView?> ReadViewAsync(
            AuthorSavedViewOwner owner,
            Guid viewId,
            CancellationToken cancellationToken = default)
            => ReadStateAsync(
                owner,
                snapshot => snapshot.Views.FirstOrDefault(view => view.Id == viewId),
                cancellationToken);

        public Task<AuthorSavedViewPage> ReadPageAsync(
            AuthorSavedViewOwner owner,
            AuthorSavedViewPageCursor? cursor,
            int limit,
            CancellationToken cancellationToken = default)
            => ReadStateAsync(
                owner,
                snapshot =>
                {
                    IEnumerable<AuthorSavedView> ordered = snapshot.Views
                        .Where(static view => view.LifecycleState == AuthorSavedViewLifecycleState.Active)
                        .OrderByDescending(static view => view.Pinned)
                        .ThenBy(static view => view.OrderKey)
                        .ThenBy(static view => view.Id);
                    if (cursor is not null)
                    {
                        ordered = ordered.Where(view => ComparePagePosition(view, cursor) > 0);
                    }
                    AuthorSavedView[] page = [.. ordered.Take(limit + 1)];
                    AuthorSavedView[] items = [.. page.Take(limit)];
                    AuthorSavedViewPageCursor? next = page.Length > limit
                        ? new(items[^1].Pinned, items[^1].OrderKey, items[^1].Id)
                        : null;
                    return new AuthorSavedViewPage(
                        items,
                        next,
                        snapshot.Collection.Revision,
                        snapshot.Collection.DefaultViewId);
                },
                cancellationToken);

        private static int ComparePagePosition(
            AuthorSavedView view,
            AuthorSavedViewPageCursor cursor)
        {
            int pinned = (view.Pinned ? 0 : 1).CompareTo(cursor.Pinned ? 0 : 1);
            if (pinned != 0)
            {
                return pinned;
            }
            int order = view.OrderKey.CompareTo(cursor.OrderKey);
            return order != 0 ? order : view.Id.CompareTo(cursor.ViewId);
        }

        private async Task<T> ReadStateAsync<T>(
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

        public async Task<AuthorSavedViewVerificationHistory> ReadVerificationHistoryAsync(
            AuthorSavedViewOwner owner,
            CancellationToken cancellationToken = default)
        {
            SemaphoreSlim gate = _locks.GetOrAdd(owner, static _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(cancellationToken);
            try
            {
                OwnerState state = State(owner);
                return new(
                    new(state.Collection, [.. state.Views]),
                    Array.AsReadOnly(state.Receipts.Values.ToArray()),
                    Array.AsReadOnly(state.Changes.ToArray()),
                    Array.AsReadOnly(state.IdempotencyRecords.ToArray()));
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
            string commandDigest = AuthorSavedViewStorageContract.ComputeCommandDigest("seed", revision);
            var collection = new AuthorSavedViewCollection(
                owner,
                revision,
                null,
                views.Count(view => view.LifecycleState == AuthorSavedViewLifecycleState.Active),
                commandDigest,
                AuthorSavedViewStorageContract.ComputeCollectionDigest(
                    owner,
                    revision,
                    null,
                    views.Count(view => view.LifecycleState == AuthorSavedViewLifecycleState.Active),
                    commandDigest));
            _states[owner] = new OwnerState(collection, [.. views], [], [], []);
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

        public void TamperHistory(
            AuthorSavedViewOwner owner,
            Func<AuthorSavedViewVerificationHistory, AuthorSavedViewVerificationHistory> tamper)
        {
            OwnerState state = State(owner);
            AuthorSavedViewVerificationHistory changed = tamper(new(
                new(state.Collection, [.. state.Views]),
                [.. state.Receipts.Values],
                [.. state.Changes],
                [.. state.IdempotencyRecords]));
            state.Collection = changed.Current.Collection;
            state.Views = [.. changed.Current.Views];
            state.Receipts.Clear();
            foreach (AuthorSavedViewWriteReceipt receipt in changed.Receipts)
            {
                state.Receipts[receipt.RequestId] = receipt;
            }
            state.Changes = [.. changed.Changes];
            state.IdempotencyRecords = [.. changed.IdempotencyRecords];
        }

        private OwnerState State(AuthorSavedViewOwner owner)
            => _states.GetOrAdd(owner, static key => new OwnerState(
                AuthorSavedViewCollection.Empty(key),
                [],
                [],
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
                state.Changes.AddRange(mutation.HistoryChanges);
                state.IdempotencyRecords.Add(new(
                    receipt.RequestId,
                    receipt.ReceiptId,
                    receipt.CommandDigest,
                    receipt.OccurredAtUtc));
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
            Dictionary<Guid, AuthorSavedViewWriteReceipt> receipts,
            List<AuthorSavedViewHistoryChange> changes,
            List<AuthorSavedViewIdempotencyRecord> idempotencyRecords)
        {
            public AuthorSavedViewCollection Collection { get; set; } = collection;
            public List<AuthorSavedView> Views { get; set; } = views;
            public Dictionary<Guid, AuthorSavedViewWriteReceipt> Receipts { get; } = receipts;
            public List<AuthorSavedViewHistoryChange> Changes { get; set; } = changes;
            public List<AuthorSavedViewIdempotencyRecord> IdempotencyRecords { get; set; } = idempotencyRecords;
        }
    }
}
