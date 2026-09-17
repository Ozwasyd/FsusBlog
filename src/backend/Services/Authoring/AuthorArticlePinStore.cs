using System.Data.Common;
using System.Runtime.ExceptionServices;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Trusted server-only persistence authority for private author article pins.
/// Callers must derive <see cref="AuthorArticlePinOwner"/> from the authenticated admin
/// principal and the configured site scope; neither value may come from request payload.
/// This store verifies persisted principal/article facts, but principal existence is not authorization.
/// </summary>
public interface IAuthorArticlePinStore
{
    Task<AuthorArticlePinWriteReceipt> AddAsync(
        AddAuthorArticlePinCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthorArticlePinWriteReceipt> RemoveAsync(
        RemoveAuthorArticlePinCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthorArticlePinWriteReceipt> ReorderAsync(
        ReorderAuthorArticlePinsCommand command,
        CancellationToken cancellationToken = default);

    Task<AuthorArticlePinCollectionSnapshot> GetAuthoritySnapshotAsync(
        AuthorArticlePinOwner owner,
        CancellationToken cancellationToken = default);

    Task<AuthorArticlePinVerificationResult> VerifyAsync(
        AuthorArticlePinOwner owner,
        CancellationToken cancellationToken = default);
}

public sealed class AuthorArticlePinStore(
    ISqlSugarClient db,
    TimeProvider timeProvider,
    IAuthorArticlePinMutationAuthorizer? mutationAuthorizer = null) : IAuthorArticlePinStore
{
    private const string AddCommand = "add";
    private const string RemoveCommand = "remove";
    private const string ReorderCommand = "reorder";
    private readonly IAuthorArticlePinMutationAuthorizer _mutationAuthorizer =
        mutationAuthorizer ?? UnavailableAuthorArticlePinMutationAuthorizer.Instance;

    public async Task<AuthorArticlePinWriteReceipt> AddAsync(
        AddAuthorArticlePinCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateCommand(command.Owner, command.ArticleId, command.ExpectedRevision, command.RequestId);
        string commandDigest = AuthorArticlePinContract.ComputeCommandDigest(
            AddCommand,
            command.Owner,
            command.ExpectedRevision,
            [command.ArticleId],
            null);

        return await ExecuteTransactionAsync(async () =>
        {
            await AcquireOwnerLockAsync(command.Owner).ConfigureAwait(false);
            await _mutationAuthorizer.AuthorizeAsync(
                command.Owner,
                [command.ArticleId],
                cancellationToken).ConfigureAwait(false);
            AuthorArticlePinWriteReceipt? replay = await TryReadReplayAsync(
                command.Owner,
                command.RequestId,
                commandDigest,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                return replay;
            }

            await RequirePrincipalExistsAsync(command.Owner.AdminPrincipalId).ConfigureAwait(false);
            CollectionRow? collection = await ReadCollectionAsync(
                command.Owner,
                forUpdate: true,
                cancellationToken).ConfigureAwait(false);
            long previousRevision = collection?.Revision ?? 0;
            EnsureExpectedRevision(command.ExpectedRevision, previousRevision);
            await RequirePinnableArticleAsync(command.ArticleId).ConfigureAwait(false);
            List<AuthorArticlePin> pins = await ReadPinsAsync(
                command.Owner,
                forUpdate: true,
                cancellationToken).ConfigureAwait(false);
            EnsureCollectionIntegrity(command.Owner, collection, pins);

            if (pins.Any(pin => pin.ArticleId == command.ArticleId))
            {
                return await PersistReceiptAsync(
                    command.Owner,
                    command.RequestId,
                    previousRevision,
                    previousRevision,
                    AddCommand,
                    "noop",
                    "already-present",
                    [command.ArticleId],
                    null,
                    pins.Count,
                    rebalanced: false,
                    commandDigest,
                    collection?.ContentDigest ?? AuthorArticlePinContract.ComputeCollectionDigest(
                        command.Owner,
                        previousRevision,
                        pins),
                    UtcNow).ConfigureAwait(false);
            }

            if (pins.Count >= AuthorArticlePinContract.MaxPinsPerOwner)
            {
                throw new AuthorArticlePinBudgetExceededException();
            }

            if (collection is null)
            {
                await InsertEmptyCollectionAsync(command.Owner).ConfigureAwait(false);
            }

            long revision = checked(previousRevision + 1);
            long orderKey = pins.Count == 0
                ? AuthorArticlePinContract.OrderKeyGap
                : checked(pins[^1].OrderKey + AuthorArticlePinContract.OrderKeyGap);
            Guid pinId = Guid.CreateVersion7();
            string pinDigest = AuthorArticlePinContract.ComputePinDigest(
                command.Owner,
                pinId,
                command.ArticleId,
                orderKey,
                revision,
                revision);
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO author_article_pin(
                    pin_id, owner_admin_principal_id, site_scope, article_id, order_key,
                    created_revision, updated_revision, content_digest)
                VALUES (
                    @PinId, @OwnerAdminPrincipalId, @SiteScope, @ArticleId, @OrderKey,
                    @Revision, @Revision, @PinDigest);
                """,
                new SugarParameter("@PinId", pinId),
                new SugarParameter("@OwnerAdminPrincipalId", command.Owner.AdminPrincipalId),
                new SugarParameter("@SiteScope", command.Owner.SiteScope),
                new SugarParameter("@ArticleId", command.ArticleId),
                new SugarParameter("@OrderKey", orderKey),
                new SugarParameter("@Revision", revision),
                new SugarParameter("@PinDigest", pinDigest)).ConfigureAwait(false);
            pins.Add(new AuthorArticlePin(
                pinId,
                command.ArticleId,
                orderKey,
                revision,
                revision,
                pinDigest));
            string contentDigest = AuthorArticlePinContract.ComputeCollectionDigest(
                command.Owner,
                revision,
                pins);
            DateTime now = UtcNow;
            await UpdateCollectionAsync(
                command.Owner,
                previousRevision,
                revision,
                pins.Count,
                contentDigest,
                now).ConfigureAwait(false);

            return await PersistReceiptAsync(
                command.Owner,
                command.RequestId,
                previousRevision,
                revision,
                AddCommand,
                "applied",
                null,
                [command.ArticleId],
                null,
                pins.Count,
                rebalanced: false,
                commandDigest,
                contentDigest,
                now).ConfigureAwait(false);
        }, cancellationToken).ConfigureAwait(false);
    }

    public async Task<AuthorArticlePinWriteReceipt> RemoveAsync(
        RemoveAuthorArticlePinCommand command,
        CancellationToken cancellationToken = default)
    {
        ValidateCommand(command.Owner, command.ArticleId, command.ExpectedRevision, command.RequestId);
        string commandDigest = AuthorArticlePinContract.ComputeCommandDigest(
            RemoveCommand,
            command.Owner,
            command.ExpectedRevision,
            [command.ArticleId],
            null);

        return await ExecuteTransactionAsync(async () =>
        {
            await AcquireOwnerLockAsync(command.Owner).ConfigureAwait(false);
            await _mutationAuthorizer.AuthorizeAsync(
                command.Owner,
                [command.ArticleId],
                cancellationToken).ConfigureAwait(false);
            AuthorArticlePinWriteReceipt? replay = await TryReadReplayAsync(
                command.Owner,
                command.RequestId,
                commandDigest,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                return replay;
            }

            await RequirePrincipalExistsAsync(command.Owner.AdminPrincipalId).ConfigureAwait(false);
            CollectionRow? collection = await ReadCollectionAsync(
                command.Owner,
                forUpdate: true,
                cancellationToken).ConfigureAwait(false);
            long previousRevision = collection?.Revision ?? 0;
            EnsureExpectedRevision(command.ExpectedRevision, previousRevision);
            List<AuthorArticlePin> pins = await ReadPinsAsync(
                command.Owner,
                forUpdate: true,
                cancellationToken).ConfigureAwait(false);
            EnsureCollectionIntegrity(command.Owner, collection, pins);
            AuthorArticlePin? removed = pins.SingleOrDefault(pin => pin.ArticleId == command.ArticleId);
            if (removed is null)
            {
                return await PersistReceiptAsync(
                    command.Owner,
                    command.RequestId,
                    previousRevision,
                    previousRevision,
                    RemoveCommand,
                    "noop",
                    "not-present",
                    [command.ArticleId],
                    null,
                    pins.Count,
                    rebalanced: false,
                    commandDigest,
                    collection?.ContentDigest ?? AuthorArticlePinContract.ComputeCollectionDigest(
                        command.Owner,
                        previousRevision,
                        pins),
                    UtcNow).ConfigureAwait(false);
            }

            int deleted = await db.Ado.ExecuteCommandAsync(
                """
                DELETE FROM author_article_pin
                WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
                  AND site_scope = @SiteScope
                  AND article_id = @ArticleId;
                """,
                new SugarParameter("@OwnerAdminPrincipalId", command.Owner.AdminPrincipalId),
                new SugarParameter("@SiteScope", command.Owner.SiteScope),
                new SugarParameter("@ArticleId", command.ArticleId)).ConfigureAwait(false);
            if (deleted != 1)
            {
                throw new AuthorArticlePinAccessDeniedException();
            }

            pins.Remove(removed);
            long revision = checked(previousRevision + 1);
            string contentDigest = AuthorArticlePinContract.ComputeCollectionDigest(
                command.Owner,
                revision,
                pins);
            DateTime now = UtcNow;
            await UpdateCollectionAsync(
                command.Owner,
                previousRevision,
                revision,
                pins.Count,
                contentDigest,
                now).ConfigureAwait(false);
            return await PersistReceiptAsync(
                command.Owner,
                command.RequestId,
                previousRevision,
                revision,
                RemoveCommand,
                "applied",
                null,
                [command.ArticleId],
                null,
                pins.Count,
                rebalanced: false,
                commandDigest,
                contentDigest,
                now).ConfigureAwait(false);
        }, cancellationToken).ConfigureAwait(false);
    }

    public async Task<AuthorArticlePinWriteReceipt> ReorderAsync(
        ReorderAuthorArticlePinsCommand command,
        CancellationToken cancellationToken = default)
    {
        AuthorArticlePinContract.ValidateOwner(command.Owner);
        AuthorArticlePinContract.ValidateExpectedRevision(command.ExpectedRevision);
        AuthorArticlePinContract.ValidateRequestId(command.RequestId);
        AuthorArticlePinContract.ValidateReorder(command.MovedArticleIds, command.AfterArticleId);
        string commandDigest = AuthorArticlePinContract.ComputeCommandDigest(
            ReorderCommand,
            command.Owner,
            command.ExpectedRevision,
            command.MovedArticleIds,
            command.AfterArticleId);
        int[] authorizedArticleIds = command.AfterArticleId.HasValue
            ? [.. command.MovedArticleIds, command.AfterArticleId.Value]
            : [.. command.MovedArticleIds];

        return await ExecuteTransactionAsync(async () =>
        {
            await AcquireOwnerLockAsync(command.Owner).ConfigureAwait(false);
            await _mutationAuthorizer.AuthorizeAsync(
                command.Owner,
                authorizedArticleIds,
                cancellationToken).ConfigureAwait(false);
            AuthorArticlePinWriteReceipt? replay = await TryReadReplayAsync(
                command.Owner,
                command.RequestId,
                commandDigest,
                cancellationToken).ConfigureAwait(false);
            if (replay is not null)
            {
                return replay;
            }

            await RequirePrincipalExistsAsync(command.Owner.AdminPrincipalId).ConfigureAwait(false);
            CollectionRow? collection = await ReadCollectionAsync(
                command.Owner,
                forUpdate: true,
                cancellationToken).ConfigureAwait(false);
            long previousRevision = collection?.Revision ?? 0;
            EnsureExpectedRevision(command.ExpectedRevision, previousRevision);
            if (collection is null)
            {
                throw new AuthorArticlePinAccessDeniedException();
            }

            List<AuthorArticlePin> pins = await ReadPinsAsync(
                command.Owner,
                forUpdate: true,
                cancellationToken).ConfigureAwait(false);
            EnsureCollectionIntegrity(command.Owner, collection, pins);
            var byArticle = pins.ToDictionary(static pin => pin.ArticleId);
            if (command.MovedArticleIds.Any(articleId => !byArticle.ContainsKey(articleId)))
            {
                throw new AuthorArticlePinAccessDeniedException();
            }
            if (command.AfterArticleId.HasValue && !byArticle.ContainsKey(command.AfterArticleId.Value))
            {
                throw new AuthorArticlePinAccessDeniedException();
            }

            List<int> currentOrder = pins.Select(static pin => pin.ArticleId).ToList();
            var movedSet = command.MovedArticleIds.ToHashSet();
            List<int> desiredOrder = currentOrder.Where(articleId => !movedSet.Contains(articleId)).ToList();
            int insertionIndex = command.AfterArticleId.HasValue
                ? desiredOrder.IndexOf(command.AfterArticleId.Value) + 1
                : 0;
            desiredOrder.InsertRange(insertionIndex, command.MovedArticleIds);
            if (currentOrder.SequenceEqual(desiredOrder))
            {
                return await PersistReceiptAsync(
                    command.Owner,
                    command.RequestId,
                    previousRevision,
                    previousRevision,
                    ReorderCommand,
                    "noop",
                    "order-unchanged",
                    command.MovedArticleIds,
                    command.AfterArticleId,
                    pins.Count,
                    rebalanced: false,
                    commandDigest,
                    collection.ContentDigest,
                    UtcNow).ConfigureAwait(false);
            }

            long revision = checked(previousRevision + 1);
            (List<AuthorArticlePin> reordered, bool rebalanced) = AssignOrderKeys(
                command.Owner,
                pins,
                desiredOrder,
                movedSet,
                insertionIndex,
                command.MovedArticleIds.Count,
                revision);
            AuthorArticlePin[] changed = reordered
                .Where(pin => byArticle[pin.ArticleId].OrderKey != pin.OrderKey)
                .ToArray();
            await UpdatePinOrderKeysAsync(command.Owner, changed, revision).ConfigureAwait(false);

            string contentDigest = AuthorArticlePinContract.ComputeCollectionDigest(
                command.Owner,
                revision,
                reordered);
            DateTime now = UtcNow;
            await UpdateCollectionAsync(
                command.Owner,
                previousRevision,
                revision,
                reordered.Count,
                contentDigest,
                now).ConfigureAwait(false);
            return await PersistReceiptAsync(
                command.Owner,
                command.RequestId,
                previousRevision,
                revision,
                ReorderCommand,
                "applied",
                null,
                command.MovedArticleIds,
                command.AfterArticleId,
                reordered.Count,
                rebalanced,
                commandDigest,
                contentDigest,
                now).ConfigureAwait(false);
        }, cancellationToken).ConfigureAwait(false);
    }

    public async Task<AuthorArticlePinCollectionSnapshot> GetAuthoritySnapshotAsync(
        AuthorArticlePinOwner owner,
        CancellationToken cancellationToken = default)
    {
        AuthorArticlePinContract.ValidateOwner(owner);
        return await ExecuteTransactionAsync(async () =>
        {
            await AcquireOwnerLockAsync(owner).ConfigureAwait(false);
            return await ReadSnapshotAsync(owner, validateIntegrity: true, cancellationToken).ConfigureAwait(false);
        }, cancellationToken).ConfigureAwait(false);
    }

    private async Task<AuthorArticlePinCollectionSnapshot> ReadSnapshotAsync(
        AuthorArticlePinOwner owner,
        bool validateIntegrity,
        CancellationToken cancellationToken)
    {
        CollectionRow? collection = await ReadCollectionAsync(owner, forUpdate: false, cancellationToken)
            .ConfigureAwait(false);
        if (collection is null)
        {
            return new AuthorArticlePinCollectionSnapshot(
                owner,
                AuthorArticlePinContract.SchemaVersion,
                0,
                0,
                [],
                DateTime.UnixEpoch,
                AuthorArticlePinContract.ComputeCollectionDigest(owner, 0, []));
        }

        List<AuthorArticlePin> pins = await ReadPinsAsync(
            owner,
            forUpdate: false,
            cancellationToken).ConfigureAwait(false);
        if (validateIntegrity)
        {
            EnsureCollectionIntegrity(owner, collection, pins);
        }
        return new AuthorArticlePinCollectionSnapshot(
            owner,
            collection.SchemaVersion,
            collection.Revision,
            collection.ItemCount,
            pins,
            collection.UpdatedAtUtc,
            collection.ContentDigest);
    }

    public async Task<AuthorArticlePinVerificationResult> VerifyAsync(
        AuthorArticlePinOwner owner,
        CancellationToken cancellationToken = default)
    {
        AuthorArticlePinContract.ValidateOwner(owner);
        return await ExecuteTransactionAsync(async () =>
        {
            await AcquireOwnerLockAsync(owner).ConfigureAwait(false);
            AuthorArticlePinCollectionSnapshot snapshot = await ReadSnapshotAsync(
                owner,
                validateIntegrity: false,
                cancellationToken)
                .ConfigureAwait(false);
            var reasons = new List<string>();
            if (snapshot.SchemaVersion != AuthorArticlePinContract.SchemaVersion)
            {
                reasons.Add("collection_schema_mismatch");
            }
            if (snapshot.Pins.Count > AuthorArticlePinContract.MaxPinsPerOwner)
            {
                reasons.Add("collection_budget_exceeded");
            }
            if (snapshot.ItemCount != snapshot.Pins.Count)
            {
                reasons.Add("collection_count_mismatch");
            }
            if (snapshot.Pins.Select(static pin => pin.PinId).Distinct().Count() != snapshot.Pins.Count)
            {
                reasons.Add("pin_identity_duplicate");
            }
            if (snapshot.Pins.Select(static pin => pin.ArticleId).Distinct().Count() != snapshot.Pins.Count)
            {
                reasons.Add("article_identity_duplicate");
            }
            if (snapshot.Pins.Select(static pin => pin.OrderKey).Distinct().Count() != snapshot.Pins.Count)
            {
                reasons.Add("order_key_duplicate");
            }

            foreach (AuthorArticlePin pin in snapshot.Pins)
            {
                string expected = AuthorArticlePinContract.ComputePinDigest(
                    owner,
                    pin.PinId,
                    pin.ArticleId,
                    pin.OrderKey,
                    pin.CreatedRevision,
                    pin.UpdatedRevision);
                if (!string.Equals(expected, pin.ContentDigest, StringComparison.Ordinal))
                {
                    reasons.Add($"pin_digest_mismatch:{pin.PinId:D}");
                }
            }

            string expectedCollection = AuthorArticlePinContract.ComputeCollectionDigest(
                owner,
                snapshot.Revision,
                snapshot.Pins);
            if (!string.Equals(expectedCollection, snapshot.ContentDigest, StringComparison.Ordinal))
            {
                reasons.Add("collection_digest_mismatch");
            }
            reasons.AddRange(await ReadReceiptIntegrityReasonsAsync(owner, snapshot, cancellationToken).ConfigureAwait(false));
            return new AuthorArticlePinVerificationResult(
                reasons.Count == 0,
                reasons,
                snapshot.Revision,
                snapshot.Pins.Count,
                snapshot.ContentDigest);
        }, cancellationToken).ConfigureAwait(false);
    }

    private static (List<AuthorArticlePin> Pins, bool Rebalanced) AssignOrderKeys(
        AuthorArticlePinOwner owner,
        IReadOnlyList<AuthorArticlePin> pins,
        IReadOnlyList<int> desiredOrder,
        IReadOnlySet<int> movedSet,
        int insertionIndex,
        int movedCount,
        long revision)
    {
        Dictionary<int, AuthorArticlePin> byArticle = pins.ToDictionary(static pin => pin.ArticleId);
        List<int> remaining = desiredOrder.Where(articleId => !movedSet.Contains(articleId)).ToList();
        long lower = insertionIndex == 0
            ? 0
            : byArticle[remaining[insertionIndex - 1]].OrderKey;
        long upper = insertionIndex < remaining.Count
            ? byArticle[remaining[insertionIndex]].OrderKey
            : checked(lower + (AuthorArticlePinContract.OrderKeyGap * (movedCount + 1L)));
        long step = (upper - lower) / (movedCount + 1L);
        bool rebalanced = step <= 0;
        var result = new List<AuthorArticlePin>(pins.Count);
        if (rebalanced)
        {
            for (int index = 0; index < desiredOrder.Count; index++)
            {
                AuthorArticlePin current = byArticle[desiredOrder[index]];
                long orderKey = checked((index + 1L) * AuthorArticlePinContract.OrderKeyGap);
                result.Add(WithOrder(owner, current, orderKey, revision));
            }
            return (result, true);
        }

        int movedIndex = 0;
        foreach (int articleId in desiredOrder)
        {
            AuthorArticlePin current = byArticle[articleId];
            if (movedSet.Contains(articleId))
            {
                long orderKey = checked(lower + (step * (++movedIndex)));
                result.Add(WithOrder(owner, current, orderKey, revision));
            }
            else
            {
                result.Add(current);
            }
        }
        return (result, false);
    }

    private static AuthorArticlePin WithOrder(
        AuthorArticlePinOwner owner,
        AuthorArticlePin pin,
        long orderKey,
        long revision)
    {
        string digest = AuthorArticlePinContract.ComputePinDigest(
            owner,
            pin.PinId,
            pin.ArticleId,
            orderKey,
            pin.CreatedRevision,
            revision);
        return pin with
        {
            OrderKey = orderKey,
            UpdatedRevision = revision,
            ContentDigest = digest
        };
    }

    private async Task UpdatePinOrderKeysAsync(
        AuthorArticlePinOwner owner,
        IReadOnlyList<AuthorArticlePin> changed,
        long revision)
    {
        if (changed.Count == 0)
        {
            throw new InvalidOperationException("article_pin_reorder_changed_set_empty");
        }

        var parameters = new List<SugarParameter>
        {
            new("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new("@SiteScope", owner.SiteScope),
            new("@Revision", revision)
        };
        var articleParameters = new string[changed.Count];
        var orderCases = new string[changed.Count];
        var digestCases = new string[changed.Count];
        for (int index = 0; index < changed.Count; index++)
        {
            string article = $"@ArticleId{index}";
            string order = $"@OrderKey{index}";
            string digest = $"@PinDigest{index}";
            articleParameters[index] = article;
            orderCases[index] = $"WHEN {article} THEN {order}";
            digestCases[index] = $"WHEN {article} THEN {digest}";
            parameters.Add(new SugarParameter(article, changed[index].ArticleId));
            parameters.Add(new SugarParameter(order, changed[index].OrderKey));
            parameters.Add(new SugarParameter(digest, changed[index].ContentDigest));
        }

        int updated = await db.Ado.ExecuteCommandAsync(
            $"""
            UPDATE author_article_pin
            SET order_key = CASE article_id {string.Join(' ', orderCases)} ELSE order_key END,
                updated_revision = @Revision,
                content_digest = CASE article_id {string.Join(' ', digestCases)} ELSE content_digest END
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
              AND article_id IN ({string.Join(',', articleParameters)});
            """,
            parameters.ToArray()).ConfigureAwait(false);
        if (updated != changed.Count)
        {
            throw new AuthorArticlePinAccessDeniedException();
        }
    }

    private async Task InsertEmptyCollectionAsync(AuthorArticlePinOwner owner)
    {
        string digest = AuthorArticlePinContract.ComputeCollectionDigest(owner, 0, []);
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO author_article_pin_collection(
                owner_admin_principal_id, site_scope, schema_version, revision,
                item_count, updated_at_utc, content_digest)
            VALUES (
                @OwnerAdminPrincipalId, @SiteScope, @SchemaVersion, 0,
                0, @UpdatedAtUtc, @ContentDigest);
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@SchemaVersion", AuthorArticlePinContract.SchemaVersion),
            new SugarParameter("@UpdatedAtUtc", UtcNow),
            new SugarParameter("@ContentDigest", digest)).ConfigureAwait(false);
    }

    private async Task UpdateCollectionAsync(
        AuthorArticlePinOwner owner,
        long previousRevision,
        long revision,
        int itemCount,
        string contentDigest,
        DateTime updatedAtUtc)
    {
        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE author_article_pin_collection
            SET revision = @Revision,
                item_count = @ItemCount,
                updated_at_utc = @UpdatedAtUtc,
                content_digest = @ContentDigest
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
              AND revision = @PreviousRevision;
            """,
            new SugarParameter("@Revision", revision),
            new SugarParameter("@ItemCount", itemCount),
            new SugarParameter("@UpdatedAtUtc", updatedAtUtc),
            new SugarParameter("@ContentDigest", contentDigest),
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@PreviousRevision", previousRevision)).ConfigureAwait(false);
        if (updated != 1)
        {
            throw new AuthorArticlePinRevisionConflictException(previousRevision, revision);
        }
    }

    private async Task<CollectionRow?> ReadCollectionAsync(
        AuthorArticlePinOwner owner,
        bool forUpdate,
        CancellationToken cancellationToken)
    {
        string lockClause = forUpdate ? " FOR UPDATE" : string.Empty;
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT schema_version, revision, item_count, updated_at_utc, content_digest
            FROM author_article_pin_collection
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope{lockClause};
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? new CollectionRow(
                reader.GetInt32(reader.GetOrdinal("schema_version")),
                reader.GetInt64(reader.GetOrdinal("revision")),
                reader.GetInt32(reader.GetOrdinal("item_count")),
                reader.GetDateTime(reader.GetOrdinal("updated_at_utc")),
                reader.GetString(reader.GetOrdinal("content_digest")))
            : null;
    }

    private async Task<List<AuthorArticlePin>> ReadPinsAsync(
        AuthorArticlePinOwner owner,
        bool forUpdate,
        CancellationToken cancellationToken)
    {
        string lockClause = forUpdate ? " FOR UPDATE" : string.Empty;
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT pin_id, article_id, order_key, created_revision, updated_revision, content_digest
            FROM author_article_pin
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
            ORDER BY order_key, pin_id{lockClause};
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        var pins = new List<AuthorArticlePin>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            pins.Add(new AuthorArticlePin(
                reader.GetGuid(reader.GetOrdinal("pin_id")),
                reader.GetInt32(reader.GetOrdinal("article_id")),
                reader.GetInt64(reader.GetOrdinal("order_key")),
                reader.GetInt64(reader.GetOrdinal("created_revision")),
                reader.GetInt64(reader.GetOrdinal("updated_revision")),
                reader.GetString(reader.GetOrdinal("content_digest"))));
        }
        return pins;
    }

    private async Task<AuthorArticlePinWriteReceipt?> TryReadReplayAsync(
        AuthorArticlePinOwner owner,
        Guid requestId,
        string commandDigest,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT receipt_id, previous_revision, revision, command_kind, status, reason_code,
                   article_ids, after_article_id, item_count, rebalanced,
                   command_digest, content_digest, created_at_utc
            FROM author_article_pin_idempotency
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
              AND request_id = @RequestId;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@RequestId", requestId)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        string storedDigest = reader.GetString(reader.GetOrdinal("command_digest"));
        if (!string.Equals(storedDigest, commandDigest, StringComparison.Ordinal))
        {
            throw new AuthorArticlePinIdempotencyConflictException();
        }

        return new AuthorArticlePinWriteReceipt(
            reader.GetGuid(reader.GetOrdinal("receipt_id")),
            owner,
            requestId,
            reader.GetInt64(reader.GetOrdinal("previous_revision")),
            reader.GetInt64(reader.GetOrdinal("revision")),
            reader.GetString(reader.GetOrdinal("command_kind")),
            reader.GetString(reader.GetOrdinal("status")),
            ReadNullableString(reader, "reason_code"),
            ParseArticleIds(reader.GetString(reader.GetOrdinal("article_ids"))),
            ReadNullableInt32(reader, "after_article_id"),
            reader.GetInt32(reader.GetOrdinal("item_count")),
            reader.GetBoolean(reader.GetOrdinal("rebalanced")),
            true,
            storedDigest,
            reader.GetString(reader.GetOrdinal("content_digest")),
            reader.GetDateTime(reader.GetOrdinal("created_at_utc")));
    }

    private async Task<AuthorArticlePinWriteReceipt> PersistReceiptAsync(
        AuthorArticlePinOwner owner,
        Guid requestId,
        long previousRevision,
        long revision,
        string commandKind,
        string status,
        string? reasonCode,
        IReadOnlyList<int> articleIds,
        int? afterArticleId,
        int itemCount,
        bool rebalanced,
        string commandDigest,
        string contentDigest,
        DateTime createdAtUtc)
    {
        Guid receiptId = Guid.CreateVersion7();
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO author_article_pin_receipt(
                receipt_id, owner_admin_principal_id, site_scope, request_id,
                previous_revision, revision, command_kind, status, reason_code,
                article_ids, after_article_id, item_count, rebalanced,
                command_digest, content_digest, created_at_utc)
            VALUES (
                @ReceiptId, @OwnerAdminPrincipalId, @SiteScope, @RequestId,
                @PreviousRevision, @Revision, @CommandKind, @Status, @ReasonCode,
                @ArticleIds, @AfterArticleId::integer, @ItemCount, @Rebalanced,
                @CommandDigest, @ContentDigest, @CreatedAtUtc);

            INSERT INTO author_article_pin_idempotency(
                owner_admin_principal_id, site_scope, request_id, receipt_id,
                previous_revision, revision, command_kind, status, reason_code,
                article_ids, after_article_id, item_count, rebalanced,
                command_digest, content_digest, created_at_utc)
            VALUES (
                @OwnerAdminPrincipalId, @SiteScope, @RequestId, @ReceiptId,
                @PreviousRevision, @Revision, @CommandKind, @Status, @ReasonCode,
                @ArticleIds, @AfterArticleId::integer, @ItemCount, @Rebalanced,
                @CommandDigest, @ContentDigest, @CreatedAtUtc);
            """,
            new SugarParameter("@ReceiptId", receiptId),
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@RequestId", requestId),
            new SugarParameter("@PreviousRevision", previousRevision),
            new SugarParameter("@Revision", revision),
            new SugarParameter("@CommandKind", commandKind),
            new SugarParameter("@Status", status),
            new SugarParameter("@ReasonCode", reasonCode is null ? DBNull.Value : reasonCode),
            new SugarParameter("@ArticleIds", string.Join(',', articleIds)),
            new SugarParameter("@AfterArticleId", afterArticleId.HasValue ? afterArticleId.Value : DBNull.Value),
            new SugarParameter("@ItemCount", itemCount),
            new SugarParameter("@Rebalanced", rebalanced),
            new SugarParameter("@CommandDigest", commandDigest),
            new SugarParameter("@ContentDigest", contentDigest),
            new SugarParameter("@CreatedAtUtc", createdAtUtc)).ConfigureAwait(false);
        return new AuthorArticlePinWriteReceipt(
            receiptId,
            owner,
            requestId,
            previousRevision,
            revision,
            commandKind,
            status,
            reasonCode,
            [.. articleIds],
            afterArticleId,
            itemCount,
            rebalanced,
            false,
            commandDigest,
            contentDigest,
            createdAtUtc);
    }

    private async Task RequirePrincipalExistsAsync(long adminPrincipalId)
    {
        int exists = await db.Ado.GetIntAsync(
            "SELECT COUNT(1) FROM admin_principal WHERE id = @AdminPrincipalId;",
            new SugarParameter("@AdminPrincipalId", adminPrincipalId)).ConfigureAwait(false);
        if (exists != 1)
        {
            throw new AuthorArticlePinAccessDeniedException();
        }
    }

    private async Task RequirePinnableArticleAsync(int articleId)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT isdeleted, status
            FROM article
            WHERE id = @ArticleId
            FOR SHARE;
            """,
            new SugarParameter("@ArticleId", articleId)).ConfigureAwait(false);
        if (!await reader.ReadAsync().ConfigureAwait(false)
            || reader.GetBoolean(reader.GetOrdinal("isdeleted"))
            || reader.GetInt32(reader.GetOrdinal("status")) == 4)
        {
            throw new AuthorArticlePinAccessDeniedException();
        }
    }

    private async Task AcquireOwnerLockAsync(AuthorArticlePinOwner owner)
        => _ = await db.Ado.GetScalarAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 0));",
            new SugarParameter(
                "@Identity",
                $"author-article-pins:{owner.AdminPrincipalId}:{owner.SiteScope}")).ConfigureAwait(false);

    private async Task<T> ExecuteTransactionAsync<T>(
        Func<Task<T>> action,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        T? value = default;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            value = await action().ConfigureAwait(false);
            // This is the canonical cancellation boundary. Every write and its receipt
            // are rolled back when cancellation is observed before SqlSugar commits.
            cancellationToken.ThrowIfCancellationRequested();
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is not null)
            {
                ExceptionDispatchInfo.Capture(transaction.ErrorException).Throw();
            }
            throw new InvalidOperationException("author_article_pin_transaction_failed");
        }
        return value!;
    }

    private static void ValidateCommand(
        AuthorArticlePinOwner owner,
        int articleId,
        long expectedRevision,
        Guid requestId)
    {
        AuthorArticlePinContract.ValidateOwner(owner);
        AuthorArticlePinContract.ValidateArticleId(articleId);
        AuthorArticlePinContract.ValidateExpectedRevision(expectedRevision);
        AuthorArticlePinContract.ValidateRequestId(requestId);
    }

    private static void EnsureExpectedRevision(long expectedRevision, long actualRevision)
    {
        if (expectedRevision != actualRevision)
        {
            throw new AuthorArticlePinRevisionConflictException(expectedRevision, actualRevision);
        }
    }

    private static void EnsureCollectionIntegrity(
        AuthorArticlePinOwner owner,
        CollectionRow? collection,
        IReadOnlyList<AuthorArticlePin> pins)
    {
        if (collection is null)
        {
            if (pins.Count != 0)
            {
                throw new AuthorArticlePinTamperDetectedException("collection_missing");
            }
            return;
        }

        string expectedDigest = AuthorArticlePinContract.ComputeCollectionDigest(
            owner,
            collection.Revision,
            pins);
        if (collection.SchemaVersion != AuthorArticlePinContract.SchemaVersion
            || collection.ItemCount != pins.Count
            || !string.Equals(collection.ContentDigest, expectedDigest, StringComparison.Ordinal))
        {
            throw new AuthorArticlePinTamperDetectedException("collection_integrity_mismatch");
        }
    }

    private static string? ReadNullableString(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static int? ReadNullableInt32(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetInt32(ordinal);
    }

    private static int[] ParseArticleIds(string value)
        => value.Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(static articleId => int.Parse(
                articleId,
                System.Globalization.NumberStyles.None,
                System.Globalization.CultureInfo.InvariantCulture))
            .ToArray();

    private async Task<IReadOnlyList<string>> ReadReceiptIntegrityReasonsAsync(
        AuthorArticlePinOwner owner,
        AuthorArticlePinCollectionSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT
                i.receipt_id AS i_receipt_id,
                i.owner_admin_principal_id AS i_owner_admin_principal_id,
                i.site_scope AS i_site_scope,
                i.request_id AS i_request_id,
                i.previous_revision AS i_previous_revision,
                i.revision AS i_revision,
                i.command_kind AS i_command_kind,
                i.status AS i_status,
                i.reason_code AS i_reason_code,
                i.article_ids AS i_article_ids,
                i.after_article_id AS i_after_article_id,
                i.item_count AS i_item_count,
                i.rebalanced AS i_rebalanced,
                i.command_digest AS i_command_digest,
                i.content_digest AS i_content_digest,
                i.created_at_utc AS i_created_at_utc,
                r.receipt_id AS r_receipt_id,
                r.owner_admin_principal_id AS r_owner_admin_principal_id,
                r.site_scope AS r_site_scope,
                r.request_id AS r_request_id,
                r.previous_revision AS r_previous_revision,
                r.revision AS r_revision,
                r.command_kind AS r_command_kind,
                r.status AS r_status,
                r.reason_code AS r_reason_code,
                r.article_ids AS r_article_ids,
                r.after_article_id AS r_after_article_id,
                r.item_count AS r_item_count,
                r.rebalanced AS r_rebalanced,
                r.command_digest AS r_command_digest,
                r.content_digest AS r_content_digest,
                r.created_at_utc AS r_created_at_utc
            FROM author_article_pin_idempotency i
            FULL OUTER JOIN author_article_pin_receipt r ON r.receipt_id = i.receipt_id
            WHERE (i.owner_admin_principal_id = @OwnerAdminPrincipalId AND i.site_scope = @SiteScope)
               OR (r.owner_admin_principal_id = @OwnerAdminPrincipalId AND r.site_scope = @SiteScope)
            ORDER BY COALESCE(r.revision, i.revision),
                     COALESCE(r.previous_revision, i.previous_revision),
                     COALESCE(r.created_at_utc, i.created_at_utc),
                     COALESCE(r.request_id, i.request_id);
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        var reasons = new List<string>();
        var replayRows = new List<ReceiptHistoryRow>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            ReceiptHistoryRow? idempotency = ReadReceiptHistoryRow(reader, "i_", reasons);
            ReceiptHistoryRow? receipt = ReadReceiptHistoryRow(reader, "r_", reasons);
            if (receipt is null)
            {
                reasons.Add($"receipt_missing:{idempotency!.RequestId:D}");
                continue;
            }
            if (idempotency is null)
            {
                reasons.Add($"idempotency_missing:{receipt.RequestId:D}");
                continue;
            }

            string? expectedCommandDigest = null;
            try
            {
                expectedCommandDigest = AuthorArticlePinContract.ComputeCommandDigest(
                    receipt.CommandKind,
                    owner,
                    receipt.PreviousRevision,
                    receipt.ArticleIds,
                    receipt.AfterArticleId);
            }
            catch (AuthorArticlePinValidationException)
            {
                reasons.Add($"history_command_shape_invalid:{receipt.RequestId:D}");
            }
            if (expectedCommandDigest is not null
                && !string.Equals(expectedCommandDigest, receipt.CommandDigest, StringComparison.Ordinal))
            {
                reasons.Add($"command_digest_mismatch:{receipt.RequestId:D}");
            }

            if (!ReceiptHistoryRowsMatch(idempotency, receipt))
            {
                reasons.Add($"receipt_idempotency_mismatch:{receipt.RequestId:D}");
            }
            replayRows.Add(receipt);
        }

        ReplayReceiptHistory(owner, snapshot, replayRows, reasons);
        return reasons;
    }

    private static ReceiptHistoryRow? ReadReceiptHistoryRow(
        DbDataReader reader,
        string prefix,
        List<string> reasons)
    {
        int receiptIdOrdinal = reader.GetOrdinal($"{prefix}receipt_id");
        if (reader.IsDBNull(receiptIdOrdinal))
        {
            return null;
        }
        Guid requestId = reader.GetGuid(reader.GetOrdinal($"{prefix}request_id"));
        string serializedArticleIds = reader.GetString(reader.GetOrdinal($"{prefix}article_ids"));
        if (!TryParseArticleIds(serializedArticleIds, out int[] articleIds))
        {
            reasons.Add($"history_article_ids_invalid:{requestId:D}");
        }
        return new ReceiptHistoryRow(
            reader.GetGuid(receiptIdOrdinal),
            new AuthorArticlePinOwner(
                reader.GetInt64(reader.GetOrdinal($"{prefix}owner_admin_principal_id")),
                reader.GetString(reader.GetOrdinal($"{prefix}site_scope"))),
            requestId,
            reader.GetInt64(reader.GetOrdinal($"{prefix}previous_revision")),
            reader.GetInt64(reader.GetOrdinal($"{prefix}revision")),
            reader.GetString(reader.GetOrdinal($"{prefix}command_kind")),
            reader.GetString(reader.GetOrdinal($"{prefix}status")),
            ReadNullableString(reader, $"{prefix}reason_code"),
            articleIds,
            ReadNullableInt32(reader, $"{prefix}after_article_id"),
            reader.GetInt32(reader.GetOrdinal($"{prefix}item_count")),
            reader.GetBoolean(reader.GetOrdinal($"{prefix}rebalanced")),
            reader.GetString(reader.GetOrdinal($"{prefix}command_digest")),
            reader.GetString(reader.GetOrdinal($"{prefix}content_digest")),
            reader.GetDateTime(reader.GetOrdinal($"{prefix}created_at_utc")));
    }

    private static bool TryParseArticleIds(string value, out int[] articleIds)
    {
        string[] serializedIds = value.Split(',', StringSplitOptions.None);
        articleIds = new int[serializedIds.Length];
        for (int index = 0; index < serializedIds.Length; index++)
        {
            if (!int.TryParse(
                    serializedIds[index],
                    System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out int articleId)
                || articleId <= 0)
            {
                articleIds = [];
                return false;
            }
            articleIds[index] = articleId;
        }
        return articleIds.Length > 0;
    }

    private static bool ReceiptHistoryRowsMatch(ReceiptHistoryRow left, ReceiptHistoryRow right)
        => left.ReceiptId == right.ReceiptId
            && left.Owner == right.Owner
            && left.RequestId == right.RequestId
            && left.PreviousRevision == right.PreviousRevision
            && left.Revision == right.Revision
            && string.Equals(left.CommandKind, right.CommandKind, StringComparison.Ordinal)
            && string.Equals(left.Status, right.Status, StringComparison.Ordinal)
            && string.Equals(left.ReasonCode, right.ReasonCode, StringComparison.Ordinal)
            && left.ArticleIds.SequenceEqual(right.ArticleIds)
            && left.AfterArticleId == right.AfterArticleId
            && left.ItemCount == right.ItemCount
            && left.Rebalanced == right.Rebalanced
            && string.Equals(left.CommandDigest, right.CommandDigest, StringComparison.Ordinal)
            && string.Equals(left.ContentDigest, right.ContentDigest, StringComparison.Ordinal)
            && left.CreatedAtUtc == right.CreatedAtUtc;

    private static void ReplayReceiptHistory(
        AuthorArticlePinOwner owner,
        AuthorArticlePinCollectionSnapshot snapshot,
        IReadOnlyList<ReceiptHistoryRow> rows,
        List<string> reasons)
    {
        var orderedArticles = new List<int>();
        var seenRequests = new HashSet<Guid>();
        var digestByRevision = new Dictionary<long, string>();
        long currentRevision = 0;
        foreach (ReceiptHistoryRow row in rows
            .OrderBy(static row => row.Revision)
            .ThenBy(static row => row.PreviousRevision)
            .ThenBy(static row => row.CreatedAtUtc)
            .ThenBy(static row => row.RequestId))
        {
            if (!seenRequests.Add(row.RequestId))
            {
                reasons.Add($"history_request_duplicate:{row.RequestId:D}");
            }
            if (row.Owner != owner)
            {
                reasons.Add($"history_owner_mismatch:{row.RequestId:D}");
            }
            if (row.PreviousRevision != currentRevision)
            {
                reasons.Add($"history_revision_gap:{row.RequestId:D}");
                continue;
            }
            if (row.Status is not ("applied" or "noop"))
            {
                reasons.Add($"history_status_invalid:{row.RequestId:D}");
                continue;
            }

            bool applied = row.Status == "applied";
            long expectedRevision = applied ? checked(currentRevision + 1) : currentRevision;
            if (row.Revision != expectedRevision)
            {
                reasons.Add($"history_revision_transition_invalid:{row.RequestId:D}");
                continue;
            }

            bool semanticallyValid = row.CommandKind switch
            {
                AddCommand => ReplayAdd(row, orderedArticles, applied, reasons),
                RemoveCommand => ReplayRemove(row, orderedArticles, applied, reasons),
                ReorderCommand => ReplayReorder(row, orderedArticles, applied, reasons),
                _ => false
            };
            if (row.CommandKind is not (AddCommand or RemoveCommand or ReorderCommand))
            {
                reasons.Add($"history_command_invalid:{row.RequestId:D}");
            }
            if (!semanticallyValid)
            {
                continue;
            }

            if (row.ItemCount != orderedArticles.Count)
            {
                reasons.Add($"history_count_mismatch:{row.RequestId:D}");
            }
            if (digestByRevision.TryGetValue(row.Revision, out string? digest)
                && !string.Equals(digest, row.ContentDigest, StringComparison.Ordinal))
            {
                reasons.Add($"history_revision_digest_mismatch:{row.RequestId:D}");
            }
            else
            {
                digestByRevision[row.Revision] = row.ContentDigest;
            }
            currentRevision = row.Revision;
        }

        if (currentRevision != snapshot.Revision)
        {
            reasons.Add("history_terminal_revision_mismatch");
        }
        int[] currentOrder = snapshot.Pins
            .OrderBy(static pin => pin.OrderKey)
            .ThenBy(static pin => pin.PinId)
            .Select(static pin => pin.ArticleId)
            .ToArray();
        if (!orderedArticles.SequenceEqual(currentOrder))
        {
            reasons.Add("history_terminal_order_mismatch");
        }
        if (digestByRevision.TryGetValue(snapshot.Revision, out string? terminalDigest)
            && !string.Equals(terminalDigest, snapshot.ContentDigest, StringComparison.Ordinal))
        {
            reasons.Add("history_terminal_digest_mismatch");
        }
    }

    private static bool ReplayAdd(
        ReceiptHistoryRow row,
        List<int> order,
        bool applied,
        List<string> reasons)
    {
        if (row.ArticleIds.Length != 1 || row.AfterArticleId.HasValue || row.Rebalanced)
        {
            reasons.Add($"history_add_shape_invalid:{row.RequestId:D}");
            return false;
        }
        int articleId = row.ArticleIds[0];
        bool present = order.Contains(articleId);
        bool valid = applied
            ? !present && row.ReasonCode is null
            : present && row.ReasonCode == "already-present";
        if (!valid)
        {
            reasons.Add($"history_add_semantics_invalid:{row.RequestId:D}");
            return false;
        }
        if (applied)
        {
            order.Add(articleId);
        }
        return true;
    }

    private static bool ReplayRemove(
        ReceiptHistoryRow row,
        List<int> order,
        bool applied,
        List<string> reasons)
    {
        if (row.ArticleIds.Length != 1 || row.AfterArticleId.HasValue || row.Rebalanced)
        {
            reasons.Add($"history_remove_shape_invalid:{row.RequestId:D}");
            return false;
        }
        int articleId = row.ArticleIds[0];
        bool present = order.Contains(articleId);
        bool valid = applied
            ? present && row.ReasonCode is null
            : !present && row.ReasonCode == "not-present";
        if (!valid)
        {
            reasons.Add($"history_remove_semantics_invalid:{row.RequestId:D}");
            return false;
        }
        if (applied)
        {
            order.Remove(articleId);
        }
        return true;
    }

    private static bool ReplayReorder(
        ReceiptHistoryRow row,
        List<int> order,
        bool applied,
        List<string> reasons)
    {
        try
        {
            AuthorArticlePinContract.ValidateReorder(row.ArticleIds, row.AfterArticleId);
        }
        catch (AuthorArticlePinValidationException)
        {
            reasons.Add($"history_reorder_shape_invalid:{row.RequestId:D}");
            return false;
        }
        if (row.ArticleIds.Any(articleId => !order.Contains(articleId))
            || (row.AfterArticleId.HasValue && !order.Contains(row.AfterArticleId.Value)))
        {
            reasons.Add($"history_reorder_member_invalid:{row.RequestId:D}");
            return false;
        }

        var desired = order.Where(articleId => !row.ArticleIds.Contains(articleId)).ToList();
        int insertionIndex = row.AfterArticleId.HasValue
            ? desired.IndexOf(row.AfterArticleId.Value) + 1
            : 0;
        desired.InsertRange(insertionIndex, row.ArticleIds);
        bool changed = !desired.SequenceEqual(order);
        bool valid = applied
            ? changed && row.ReasonCode is null
            : !changed && row.ReasonCode == "order-unchanged" && !row.Rebalanced;
        if (!valid)
        {
            reasons.Add($"history_reorder_semantics_invalid:{row.RequestId:D}");
            return false;
        }
        if (applied)
        {
            order.Clear();
            order.AddRange(desired);
        }
        return true;
    }

    private DateTime UtcNow => timeProvider.GetUtcNow().UtcDateTime;

    private sealed record CollectionRow(
        int SchemaVersion,
        long Revision,
        int ItemCount,
        DateTime UpdatedAtUtc,
        string ContentDigest);

    private sealed record ReceiptHistoryRow(
        Guid ReceiptId,
        AuthorArticlePinOwner Owner,
        Guid RequestId,
        long PreviousRevision,
        long Revision,
        string CommandKind,
        string Status,
        string? ReasonCode,
        int[] ArticleIds,
        int? AfterArticleId,
        int ItemCount,
        bool Rebalanced,
        string CommandDigest,
        string ContentDigest,
        DateTime CreatedAtUtc);
}
