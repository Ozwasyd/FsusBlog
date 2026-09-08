using System.Data.Common;
using System.Text;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// PostgreSQL persistence adapter for the AuthorSavedView authority. The schema is relational
/// and closed: AST conditions, values, and projections are stored in typed rows, never JSON.
/// </summary>
public sealed class PostgresAuthorSavedViewPersistence(ISqlSugarClient db) : IAuthorSavedViewPersistence
{
    private const string ReceiptColumns =
        "r.receipt_id, r.request_id, r.view_id, r.command_kind, r.command_digest, "
        + "r.view_revision, r.previous_collection_revision, r.collection_revision, "
        + "r.query_digest, r.dependency_digest, r.pinned, r.previous_default_view_id, r.default_view_id, "
        + "r.previous_active_view_count, r.active_view_count, r.order_key, r.lifecycle_state, "
        + "r.default_transition, r.change_count, r.changes_digest, r.reason_code, r.content_digest, "
        + "r.occurred_at_utc";

    public async Task<T> ReadAsync<T>(
        AuthorSavedViewOwner owner,
        Func<AuthorSavedViewPersistenceSnapshot, T> read,
        CancellationToken cancellationToken = default)
    {
        AuthorSavedViewContract.ValidateOwner(owner);
        AuthorSavedViewPersistenceSnapshot snapshot = await ReadSnapshotAsync(owner, cancellationToken)
            .ConfigureAwait(false);
        return read(snapshot);
    }

    public async Task<T> ExecuteAsync<T>(
        AuthorSavedViewOwner owner,
        Func<IAuthorSavedViewPersistenceTransaction, CancellationToken, Task<T>> operation,
        CancellationToken cancellationToken = default)
    {
        AuthorSavedViewContract.ValidateOwner(owner);
        T? result = default;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            _ = await db.Ado.GetScalarAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 0));",
                new SugarParameter("@Identity", $"author-saved-view:{owner.AdminPrincipalId}:{owner.SiteScope}"))
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            await EnsureCollectionAsync(owner).ConfigureAwait(false);
            AuthorSavedViewPersistenceSnapshot snapshot = await ReadSnapshotAsync(owner, cancellationToken)
                .ConfigureAwait(false);
            result = await operation(
                new PersistenceTransaction(db, snapshot),
                cancellationToken).ConfigureAwait(false);
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo
                    .Capture(transaction.ErrorException)
                    .Throw();
            }
            throw new InvalidOperationException("author_saved_view_transaction_failed");
        }
        return result!;
    }

    public async Task<AuthorSavedViewVerificationHistory> ReadVerificationHistoryAsync(
        AuthorSavedViewOwner owner,
        CancellationToken cancellationToken = default)
    {
        AuthorSavedViewContract.ValidateOwner(owner);
        AuthorSavedViewVerificationHistory? result = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            _ = await db.Ado.GetScalarAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(@Identity, 0));",
                new SugarParameter("@Identity", $"author-saved-view:{owner.AdminPrincipalId}:{owner.SiteScope}"))
                .ConfigureAwait(false);
            AuthorSavedViewPersistenceSnapshot current = await ReadSnapshotAsync(owner, cancellationToken)
                .ConfigureAwait(false);
            IReadOnlyList<AuthorSavedViewWriteReceipt> receipts = await ReadReceiptsAsync(owner, cancellationToken)
                .ConfigureAwait(false);
            IReadOnlyList<AuthorSavedViewHistoryChange> changes =
                await ReadHistoryChangesAsync(owner, cancellationToken).ConfigureAwait(false);
            IReadOnlyList<AuthorSavedViewIdempotencyRecord> idempotency =
                await ReadIdempotencyRecordsAsync(owner, cancellationToken).ConfigureAwait(false);
            result = new(current, receipts, changes, idempotency);
        }).ConfigureAwait(false);
        if (!transaction.IsSuccess)
        {
            if (transaction.ErrorException is not null)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo
                    .Capture(transaction.ErrorException)
                    .Throw();
            }
            throw new InvalidOperationException("author_saved_view_verification_read_failed");
        }
        return result!;
    }

    private async Task EnsureCollectionAsync(AuthorSavedViewOwner owner)
    {
        AuthorSavedViewCollection empty = AuthorSavedViewCollection.Empty(owner);
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO author_saved_view_collection(
                owner_admin_principal_id, site_scope, revision, default_view_id,
                active_view_count, last_command_digest, content_digest)
            VALUES (
                @OwnerAdminPrincipalId, @SiteScope, 0, NULL,
                0, @LastCommandDigest, @ContentDigest)
            ON CONFLICT (owner_admin_principal_id, site_scope) DO NOTHING;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope),
            new SugarParameter("@LastCommandDigest", empty.LastCommandDigest),
            new SugarParameter("@ContentDigest", empty.ContentDigest)).ConfigureAwait(false);
    }

    private async Task<AuthorSavedViewPersistenceSnapshot> ReadSnapshotAsync(
        AuthorSavedViewOwner owner,
        CancellationToken cancellationToken)
    {
        AuthorSavedViewCollection collection = await ReadCollectionAsync(owner, cancellationToken)
            .ConfigureAwait(false);
        IReadOnlyList<AuthorSavedView> views = await ReadViewsAsync(owner, cancellationToken)
            .ConfigureAwait(false);
        return new AuthorSavedViewPersistenceSnapshot(collection, views);
    }

    private async Task<AuthorSavedViewCollection> ReadCollectionAsync(
        AuthorSavedViewOwner owner,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT revision, default_view_id, active_view_count, last_command_digest, content_digest
            FROM author_saved_view_collection
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return AuthorSavedViewCollection.Empty(owner);
        }
        return new AuthorSavedViewCollection(
            owner,
            reader.GetInt64(reader.GetOrdinal("revision")),
            ReadNullableGuid(reader, "default_view_id"),
            reader.GetInt32(reader.GetOrdinal("active_view_count")),
            reader.GetString(reader.GetOrdinal("last_command_digest")),
            reader.GetString(reader.GetOrdinal("content_digest")));
    }

    private async Task<IReadOnlyList<AuthorSavedViewWriteReceipt>> ReadReceiptsAsync(
        AuthorSavedViewOwner owner,
        CancellationToken cancellationToken)
    {
        var result = new List<AuthorSavedViewWriteReceipt>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT {ReceiptColumns}
            FROM author_saved_view_receipt r
            WHERE r.owner_admin_principal_id = @OwnerAdminPrincipalId
              AND r.site_scope = @SiteScope
            ORDER BY r.collection_revision, r.receipt_id;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(ReadReceipt(reader, owner, idempotentReplay: false));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private async Task<IReadOnlyList<AuthorSavedViewHistoryChange>> ReadHistoryChangesAsync(
        AuthorSavedViewOwner owner,
        CancellationToken cancellationToken)
    {
        var result = new List<AuthorSavedViewHistoryChange>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT c.receipt_id, c.change_index, c.view_id, c.change_kind,
                   c.before_revision, c.before_name, c.before_query_digest,
                   c.before_dependency_digest, c.before_pinned, c.before_order_key,
                   c.before_lifecycle_state, c.before_content_digest,
                   c.after_revision, c.after_name, c.after_query_digest,
                   c.after_dependency_digest, c.after_pinned, c.after_order_key,
                   c.after_lifecycle_state, c.after_content_digest, c.content_digest
            FROM author_saved_view_receipt_change c
            INNER JOIN author_saved_view_receipt r ON r.receipt_id = c.receipt_id
            WHERE r.owner_admin_principal_id = @OwnerAdminPrincipalId
              AND r.site_scope = @SiteScope
            ORDER BY r.collection_revision, c.change_index;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(new(
                reader.GetGuid(reader.GetOrdinal("receipt_id")),
                reader.GetInt32(reader.GetOrdinal("change_index")),
                reader.GetGuid(reader.GetOrdinal("view_id")),
                (AuthorSavedViewHistoryChangeKind)reader.GetInt16(reader.GetOrdinal("change_kind")),
                ReadHistoryState(reader, "before"),
                ReadHistoryState(reader, "after"),
                reader.GetString(reader.GetOrdinal("content_digest"))));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private async Task<IReadOnlyList<AuthorSavedViewIdempotencyRecord>> ReadIdempotencyRecordsAsync(
        AuthorSavedViewOwner owner,
        CancellationToken cancellationToken)
    {
        var result = new List<AuthorSavedViewIdempotencyRecord>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT request_id, receipt_id, command_digest, created_at_utc
            FROM author_saved_view_idempotency
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
            ORDER BY created_at_utc, request_id;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(new(
                reader.GetGuid(reader.GetOrdinal("request_id")),
                reader.GetGuid(reader.GetOrdinal("receipt_id")),
                reader.GetString(reader.GetOrdinal("command_digest")),
                ReadUtcDateTime(reader, "created_at_utc")));
        }
        return Array.AsReadOnly(result.ToArray());
    }

    private async Task<IReadOnlyList<AuthorSavedView>> ReadViewsAsync(
        AuthorSavedViewOwner owner,
        CancellationToken cancellationToken)
    {
        var headers = new List<ViewHeader>();
        using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, schema_version, revision, name, query_digest, dependency_digest,
                   sort_field_kind, sort_field_identity, sort_direction, sort_null_placement,
                   sort_collation, sort_timezone_id, stable_tie_breaker, page_size,
                   pinned, order_key, lifecycle_state, created_at_utc, updated_at_utc, content_digest
            FROM author_saved_view
            WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
              AND site_scope = @SiteScope
            ORDER BY id;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                headers.Add(new ViewHeader(
                    reader.GetGuid(reader.GetOrdinal("id")),
                    reader.GetInt32(reader.GetOrdinal("schema_version")),
                    reader.GetInt64(reader.GetOrdinal("revision")),
                    reader.GetString(reader.GetOrdinal("name")),
                    reader.GetString(reader.GetOrdinal("query_digest")),
                    reader.GetString(reader.GetOrdinal("dependency_digest")),
                    (AuthorSavedViewFieldKind)reader.GetInt16(reader.GetOrdinal("sort_field_kind")),
                    reader.GetString(reader.GetOrdinal("sort_field_identity")),
                    (AuthorSavedViewSortDirection)reader.GetInt16(reader.GetOrdinal("sort_direction")),
                    (AuthorSavedViewNullPlacement)reader.GetInt16(reader.GetOrdinal("sort_null_placement")),
                    reader.GetString(reader.GetOrdinal("sort_collation")),
                    ReadNullableString(reader, "sort_timezone_id"),
                    reader.GetString(reader.GetOrdinal("stable_tie_breaker")),
                    reader.GetInt32(reader.GetOrdinal("page_size")),
                    reader.GetBoolean(reader.GetOrdinal("pinned")),
                    reader.GetInt64(reader.GetOrdinal("order_key")),
                    (AuthorSavedViewLifecycleState)reader.GetInt16(reader.GetOrdinal("lifecycle_state")),
                    ReadUtcDateTime(reader, "created_at_utc"),
                    ReadUtcDateTime(reader, "updated_at_utc"),
                    reader.GetString(reader.GetOrdinal("content_digest"))));
            }
        }
        if (headers.Count == 0)
        {
            return [];
        }

        Dictionary<(Guid ViewId, short Index), ConditionBuilder> conditions =
            await ReadConditionsAsync(owner, cancellationToken).ConfigureAwait(false);
        await ReadConditionValuesAsync(owner, conditions, cancellationToken).ConfigureAwait(false);
        Dictionary<Guid, List<(short Index, AuthorSavedViewFieldReference Field)>> projections =
            await ReadProjectionsAsync(owner, cancellationToken).ConfigureAwait(false);

        return headers.Select(header =>
        {
            AuthorSavedViewCondition[] viewConditions =
            [
                .. conditions
                    .Where(item => item.Key.ViewId == header.Id)
                    .OrderBy(static item => item.Key.Index)
                    .Select(static item => item.Value.Build())
            ];
            AuthorSavedViewFieldReference[] viewProjection = projections.GetValueOrDefault(header.Id)?
                .OrderBy(static item => item.Index)
                .Select(static item => item.Field)
                .ToArray()
                ?? [];
            var query = new AuthorSavedViewQuery(
                header.SchemaVersion,
                Array.AsReadOnly(viewConditions),
                new AuthorSavedViewSort(
                    new AuthorSavedViewFieldReference(header.SortFieldKind, header.SortFieldIdentity),
                    header.SortDirection,
                    header.SortNullPlacement,
                    header.SortCollation,
                    header.StableTieBreaker,
                    header.SortTimeZoneId),
                Array.AsReadOnly(viewProjection),
                header.PageSize);
            return new AuthorSavedView(
                header.Id,
                owner,
                header.SchemaVersion,
                header.Revision,
                header.Name,
                query,
                header.QueryDigest,
                header.DependencyDigest,
                header.Pinned,
                header.OrderKey,
                header.LifecycleState,
                header.CreatedAtUtc,
                header.UpdatedAtUtc,
                header.ContentDigest);
        }).ToArray();
    }

    private async Task<Dictionary<(Guid ViewId, short Index), ConditionBuilder>> ReadConditionsAsync(
        AuthorSavedViewOwner owner,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<(Guid, short), ConditionBuilder>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT c.view_id, c.condition_index, c.field_kind, c.field_identity, c.operator_id, c.timezone_id
            FROM author_saved_view_condition c
            INNER JOIN author_saved_view v ON v.id = c.view_id
            WHERE v.owner_admin_principal_id = @OwnerAdminPrincipalId
              AND v.site_scope = @SiteScope
            ORDER BY c.view_id, c.condition_index;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            Guid viewId = reader.GetGuid(reader.GetOrdinal("view_id"));
            short index = reader.GetInt16(reader.GetOrdinal("condition_index"));
            result.Add(
                (viewId, index),
                new ConditionBuilder(
                    new AuthorSavedViewFieldReference(
                        (AuthorSavedViewFieldKind)reader.GetInt16(reader.GetOrdinal("field_kind")),
                        reader.GetString(reader.GetOrdinal("field_identity"))),
                    reader.GetString(reader.GetOrdinal("operator_id")),
                    ReadNullableString(reader, "timezone_id")));
        }
        return result;
    }

    private async Task ReadConditionValuesAsync(
        AuthorSavedViewOwner owner,
        Dictionary<(Guid ViewId, short Index), ConditionBuilder> conditions,
        CancellationToken cancellationToken)
    {
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT cv.view_id, cv.condition_index, cv.value
            FROM author_saved_view_condition_value cv
            INNER JOIN author_saved_view v ON v.id = cv.view_id
            WHERE v.owner_admin_principal_id = @OwnerAdminPrincipalId
              AND v.site_scope = @SiteScope
            ORDER BY cv.view_id, cv.condition_index, cv.value_index;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var key = (
                reader.GetGuid(reader.GetOrdinal("view_id")),
                reader.GetInt16(reader.GetOrdinal("condition_index")));
            if (!conditions.TryGetValue(key, out ConditionBuilder? condition))
            {
                throw new AuthorSavedViewPersistenceException("saved_view_condition_value_orphan");
            }
            condition.Values.Add(reader.GetString(reader.GetOrdinal("value")));
        }
    }

    private async Task<Dictionary<Guid, List<(short Index, AuthorSavedViewFieldReference Field)>>> ReadProjectionsAsync(
        AuthorSavedViewOwner owner,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<Guid, List<(short, AuthorSavedViewFieldReference)>>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT p.view_id, p.projection_index, p.field_kind, p.field_identity
            FROM author_saved_view_projection p
            INNER JOIN author_saved_view v ON v.id = p.view_id
            WHERE v.owner_admin_principal_id = @OwnerAdminPrincipalId
              AND v.site_scope = @SiteScope
            ORDER BY p.view_id, p.projection_index;
            """,
            new SugarParameter("@OwnerAdminPrincipalId", owner.AdminPrincipalId),
            new SugarParameter("@SiteScope", owner.SiteScope)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            Guid viewId = reader.GetGuid(reader.GetOrdinal("view_id"));
            if (!result.TryGetValue(viewId, out List<(short, AuthorSavedViewFieldReference)>? fields))
            {
                fields = [];
                result.Add(viewId, fields);
            }
            fields.Add((
                reader.GetInt16(reader.GetOrdinal("projection_index")),
                new AuthorSavedViewFieldReference(
                    (AuthorSavedViewFieldKind)reader.GetInt16(reader.GetOrdinal("field_kind")),
                    reader.GetString(reader.GetOrdinal("field_identity")))));
        }
        return result;
    }

    private static Guid? ReadNullableGuid(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetGuid(ordinal);
    }

    private static string? ReadNullableString(DbDataReader reader, string name)
    {
        int ordinal = reader.GetOrdinal(name);
        return reader.IsDBNull(ordinal) ? null : reader.GetString(ordinal);
    }

    private static DateTime ReadUtcDateTime(DbDataReader reader, string name)
        => DateTime.SpecifyKind(reader.GetDateTime(reader.GetOrdinal(name)), DateTimeKind.Utc);

    private static AuthorSavedViewWriteReceipt ReadReceipt(
        DbDataReader reader,
        AuthorSavedViewOwner owner,
        bool idempotentReplay)
        => new(
            reader.GetGuid(reader.GetOrdinal("receipt_id")),
            reader.GetGuid(reader.GetOrdinal("request_id")),
            owner,
            reader.GetGuid(reader.GetOrdinal("view_id")),
            reader.GetString(reader.GetOrdinal("command_kind")),
            reader.GetString(reader.GetOrdinal("command_digest")),
            reader.GetInt64(reader.GetOrdinal("view_revision")),
            reader.GetInt64(reader.GetOrdinal("collection_revision")),
            reader.GetString(reader.GetOrdinal("query_digest")),
            reader.GetString(reader.GetOrdinal("dependency_digest")),
            reader.GetBoolean(reader.GetOrdinal("pinned")),
            ReadNullableGuid(reader, "default_view_id"),
            reader.GetInt64(reader.GetOrdinal("order_key")),
            (AuthorSavedViewLifecycleState)reader.GetInt16(reader.GetOrdinal("lifecycle_state")),
            reader.GetString(reader.GetOrdinal("reason_code")),
            reader.GetString(reader.GetOrdinal("content_digest")),
            ReadUtcDateTime(reader, "occurred_at_utc"),
            idempotentReplay,
            reader.GetInt64(reader.GetOrdinal("previous_collection_revision")),
            ReadNullableGuid(reader, "previous_default_view_id"),
            reader.GetInt32(reader.GetOrdinal("previous_active_view_count")),
            reader.GetInt32(reader.GetOrdinal("active_view_count")),
            (AuthorSavedViewDefaultTransition)reader.GetInt16(reader.GetOrdinal("default_transition")),
            reader.GetInt32(reader.GetOrdinal("change_count")),
            reader.GetString(reader.GetOrdinal("changes_digest")));

    private static AuthorSavedViewHistoryViewState? ReadHistoryState(DbDataReader reader, string prefix)
    {
        int revisionOrdinal = reader.GetOrdinal($"{prefix}_revision");
        if (reader.IsDBNull(revisionOrdinal))
        {
            return null;
        }
        return new(
            reader.GetInt64(revisionOrdinal),
            reader.GetString(reader.GetOrdinal($"{prefix}_name")),
            reader.GetString(reader.GetOrdinal($"{prefix}_query_digest")),
            reader.GetString(reader.GetOrdinal($"{prefix}_dependency_digest")),
            reader.GetBoolean(reader.GetOrdinal($"{prefix}_pinned")),
            reader.GetInt64(reader.GetOrdinal($"{prefix}_order_key")),
            (AuthorSavedViewLifecycleState)reader.GetInt16(reader.GetOrdinal($"{prefix}_lifecycle_state")),
            reader.GetString(reader.GetOrdinal($"{prefix}_content_digest")));
    }

    private sealed class PersistenceTransaction(
        ISqlSugarClient db,
        AuthorSavedViewPersistenceSnapshot snapshot) : IAuthorSavedViewPersistenceTransaction
    {
        private long? _proposedOrderKey;

        public AuthorSavedViewCollection Collection => snapshot.Collection;
        public IReadOnlyList<AuthorSavedView> Views => snapshot.Views;

        public async Task<AuthorSavedViewWriteReceipt?> ReadReceiptAsync(
            Guid requestId,
            CancellationToken cancellationToken = default)
        {
            using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                $"""
                SELECT {ReceiptColumns}
                FROM author_saved_view_idempotency i
                INNER JOIN author_saved_view_receipt r ON r.receipt_id = i.receipt_id
                WHERE i.owner_admin_principal_id = @OwnerAdminPrincipalId
                  AND i.site_scope = @SiteScope
                  AND i.request_id = @RequestId;
                """,
                new SugarParameter("@OwnerAdminPrincipalId", Collection.Owner.AdminPrincipalId),
                new SugarParameter("@SiteScope", Collection.Owner.SiteScope),
                new SugarParameter("@RequestId", requestId)).ConfigureAwait(false);
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                return null;
            }
            return ReadReceipt(reader, Collection.Owner, idempotentReplay: true);
        }

        public async Task CommitAsync(
            AuthorSavedViewPersistenceMutation mutation,
            AuthorSavedViewWriteReceipt receipt,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await db.Ado.ExecuteCommandAsync(
                """
                UPDATE author_saved_view_collection
                SET revision = @Revision,
                    default_view_id = CAST(@DefaultViewId AS uuid),
                    active_view_count = @ActiveViewCount,
                    last_command_digest = @LastCommandDigest,
                    content_digest = @ContentDigest
                WHERE owner_admin_principal_id = @OwnerAdminPrincipalId
                  AND site_scope = @SiteScope;
                """,
                new SugarParameter("@Revision", mutation.Collection.Revision),
                new SugarParameter("@DefaultViewId", mutation.Collection.DefaultViewId),
                new SugarParameter("@ActiveViewCount", mutation.Collection.ActiveViewCount),
                new SugarParameter("@LastCommandDigest", mutation.Collection.LastCommandDigest),
                new SugarParameter("@ContentDigest", mutation.Collection.ContentDigest),
                new SugarParameter("@OwnerAdminPrincipalId", Collection.Owner.AdminPrincipalId),
                new SugarParameter("@SiteScope", Collection.Owner.SiteScope)).ConfigureAwait(false);

            foreach (Guid deletedId in mutation.Deletes)
            {
                await db.Ado.ExecuteCommandAsync(
                    """
                    DELETE FROM author_saved_view
                    WHERE id = @ViewId
                      AND owner_admin_principal_id = @OwnerAdminPrincipalId
                      AND site_scope = @SiteScope;
                    """,
                    new SugarParameter("@ViewId", deletedId),
                    new SugarParameter("@OwnerAdminPrincipalId", Collection.Owner.AdminPrincipalId),
                    new SugarParameter("@SiteScope", Collection.Owner.SiteScope)).ConfigureAwait(false);
            }

            if (mutation.CommandKind == "reorder-pinned")
            {
                await PersistReorderAsync(mutation.Upserts).ConfigureAwait(false);
            }
            else
            {
                foreach (AuthorSavedView view in mutation.Upserts)
                {
                    await PersistViewAsync(view).ConfigureAwait(false);
                }
            }
            await PersistReceiptAsync(receipt, mutation.HistoryChanges).ConfigureAwait(false);
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

        private async Task PersistViewAsync(AuthorSavedView view)
        {
            int globalOwnerCount = await db.Ado.GetIntAsync(
                """
                SELECT COUNT(1)
                FROM author_saved_view
                WHERE id = @ViewId
                  AND (owner_admin_principal_id <> @OwnerAdminPrincipalId OR site_scope <> @SiteScope);
                """,
                new SugarParameter("@ViewId", view.Id),
                new SugarParameter("@OwnerAdminPrincipalId", view.Owner.AdminPrincipalId),
                new SugarParameter("@SiteScope", view.Owner.SiteScope)).ConfigureAwait(false);
            if (globalOwnerCount != 0)
            {
                throw new AuthorSavedViewAccessDeniedException();
            }

            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO author_saved_view(
                    id, owner_admin_principal_id, site_scope, schema_version, revision, name, name_key,
                    query_digest, dependency_digest, sort_field_kind, sort_field_identity,
                    sort_direction, sort_null_placement, sort_collation, sort_timezone_id,
                    stable_tie_breaker, page_size, pinned, order_key, lifecycle_state,
                    created_at_utc, updated_at_utc, content_digest)
                VALUES (
                    @ViewId, @OwnerAdminPrincipalId, @SiteScope, @SchemaVersion, @Revision, @Name, @NameKey,
                    @QueryDigest, @DependencyDigest, @SortFieldKind, @SortFieldIdentity,
                    @SortDirection, @SortNullPlacement, @SortCollation, @SortTimeZoneId,
                    @StableTieBreaker, @PageSize, @Pinned, @OrderKey, @LifecycleState,
                    @CreatedAtUtc, @UpdatedAtUtc, @ContentDigest)
                ON CONFLICT (id) DO UPDATE SET
                    schema_version = EXCLUDED.schema_version,
                    revision = EXCLUDED.revision,
                    name = EXCLUDED.name,
                    name_key = EXCLUDED.name_key,
                    query_digest = EXCLUDED.query_digest,
                    dependency_digest = EXCLUDED.dependency_digest,
                    sort_field_kind = EXCLUDED.sort_field_kind,
                    sort_field_identity = EXCLUDED.sort_field_identity,
                    sort_direction = EXCLUDED.sort_direction,
                    sort_null_placement = EXCLUDED.sort_null_placement,
                    sort_collation = EXCLUDED.sort_collation,
                    sort_timezone_id = EXCLUDED.sort_timezone_id,
                    stable_tie_breaker = EXCLUDED.stable_tie_breaker,
                    page_size = EXCLUDED.page_size,
                    pinned = EXCLUDED.pinned,
                    order_key = EXCLUDED.order_key,
                    lifecycle_state = EXCLUDED.lifecycle_state,
                    updated_at_utc = EXCLUDED.updated_at_utc,
                    content_digest = EXCLUDED.content_digest;

                DELETE FROM author_saved_view_condition WHERE view_id = @ViewId;
                DELETE FROM author_saved_view_projection WHERE view_id = @ViewId;
                """,
                ViewParameters(view)).ConfigureAwait(false);

            for (int conditionIndex = 0; conditionIndex < view.Query.Conditions.Count; conditionIndex++)
            {
                AuthorSavedViewCondition condition = view.Query.Conditions[conditionIndex];
                await db.Ado.ExecuteCommandAsync(
                    """
                    INSERT INTO author_saved_view_condition(
                        view_id, condition_index, field_kind, field_identity, operator_id, timezone_id)
                    VALUES (@ViewId, @ConditionIndex, @FieldKind, @FieldIdentity, @OperatorId, @TimeZoneId);
                    """,
                    new SugarParameter("@ViewId", view.Id),
                    new SugarParameter("@ConditionIndex", conditionIndex),
                    new SugarParameter("@FieldKind", (short)condition.Field.Kind),
                    new SugarParameter("@FieldIdentity", condition.Field.Identity),
                    new SugarParameter("@OperatorId", condition.OperatorId),
                    new SugarParameter("@TimeZoneId", condition.TimeZoneId)).ConfigureAwait(false);
                for (int valueIndex = 0; valueIndex < condition.Values.Count; valueIndex++)
                {
                    await db.Ado.ExecuteCommandAsync(
                        """
                        INSERT INTO author_saved_view_condition_value(
                            view_id, condition_index, value_index, value)
                        VALUES (@ViewId, @ConditionIndex, @ValueIndex, @Value);
                        """,
                        new SugarParameter("@ViewId", view.Id),
                        new SugarParameter("@ConditionIndex", conditionIndex),
                        new SugarParameter("@ValueIndex", valueIndex),
                        new SugarParameter("@Value", condition.Values[valueIndex])).ConfigureAwait(false);
                }
            }
            for (int index = 0; index < view.Query.Projection.Count; index++)
            {
                AuthorSavedViewFieldReference field = view.Query.Projection[index];
                await db.Ado.ExecuteCommandAsync(
                    """
                    INSERT INTO author_saved_view_projection(
                        view_id, projection_index, field_kind, field_identity)
                    VALUES (@ViewId, @ProjectionIndex, @FieldKind, @FieldIdentity);
                    """,
                    new SugarParameter("@ViewId", view.Id),
                    new SugarParameter("@ProjectionIndex", index),
                    new SugarParameter("@FieldKind", (short)field.Kind),
                    new SugarParameter("@FieldIdentity", field.Identity)).ConfigureAwait(false);
            }
        }

        private async Task PersistReorderAsync(IReadOnlyList<AuthorSavedView> views)
        {
            if (views.Count == 0)
            {
                return;
            }
            var sql = new StringBuilder(
                "UPDATE author_saved_view AS v SET revision = x.revision, order_key = x.order_key, "
                + "updated_at_utc = x.updated_at_utc, content_digest = x.content_digest "
                + "FROM (VALUES ");
            var parameters = new List<SugarParameter>(views.Count * 5 + 2);
            for (int index = 0; index < views.Count; index++)
            {
                if (index > 0)
                {
                    sql.Append(',');
                }
                sql.Append($"(@ViewId{index}, @Revision{index}, @OrderKey{index}, @UpdatedAtUtc{index}, @ContentDigest{index})");
                parameters.Add(new SugarParameter($"@ViewId{index}", views[index].Id));
                parameters.Add(new SugarParameter($"@Revision{index}", views[index].Revision));
                parameters.Add(new SugarParameter($"@OrderKey{index}", views[index].OrderKey));
                parameters.Add(new SugarParameter($"@UpdatedAtUtc{index}", views[index].UpdatedAtUtc));
                parameters.Add(new SugarParameter($"@ContentDigest{index}", views[index].ContentDigest));
            }
            sql.Append(") AS x(id, revision, order_key, updated_at_utc, content_digest) ");
            sql.Append("WHERE v.id = x.id::uuid AND v.owner_admin_principal_id = @OwnerAdminPrincipalId ");
            sql.Append("AND v.site_scope = @SiteScope;");
            parameters.Add(new SugarParameter("@OwnerAdminPrincipalId", Collection.Owner.AdminPrincipalId));
            parameters.Add(new SugarParameter("@SiteScope", Collection.Owner.SiteScope));
            int affected = await db.Ado.ExecuteCommandAsync(sql.ToString(), parameters).ConfigureAwait(false);
            if (affected != views.Count)
            {
                throw new AuthorSavedViewPersistenceException("saved_view_reorder_write_count_mismatch");
            }
        }

        private async Task PersistReceiptAsync(
            AuthorSavedViewWriteReceipt receipt,
            IReadOnlyList<AuthorSavedViewHistoryChange> changes)
        {
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO author_saved_view_receipt(
                    receipt_id, request_id, owner_admin_principal_id, site_scope, view_id,
                    command_kind, command_digest, view_revision,
                    previous_collection_revision, collection_revision,
                    query_digest, dependency_digest, pinned,
                    previous_default_view_id, default_view_id,
                    previous_active_view_count, active_view_count,
                    order_key, lifecycle_state, default_transition,
                    change_count, changes_digest, reason_code, content_digest, occurred_at_utc)
                VALUES (
                    @ReceiptId, @RequestId, @OwnerAdminPrincipalId, @SiteScope, @ViewId,
                    @CommandKind, @CommandDigest, @ViewRevision,
                    @PreviousCollectionRevision, @CollectionRevision,
                    @QueryDigest, @DependencyDigest, @Pinned,
                    CAST(@PreviousDefaultViewId AS uuid), CAST(@DefaultViewId AS uuid),
                    @PreviousActiveViewCount, @ActiveViewCount,
                    @OrderKey, @LifecycleState, @DefaultTransition,
                    @ChangeCount, @ChangesDigest, @ReasonCode, @ContentDigest, @OccurredAtUtc);

                INSERT INTO author_saved_view_idempotency(
                    owner_admin_principal_id, site_scope, request_id, receipt_id,
                    command_digest, created_at_utc)
                VALUES (
                    @OwnerAdminPrincipalId, @SiteScope, @RequestId, @ReceiptId,
                    @CommandDigest, @OccurredAtUtc);
                """,
                new SugarParameter("@ReceiptId", receipt.ReceiptId),
                new SugarParameter("@RequestId", receipt.RequestId),
                new SugarParameter("@OwnerAdminPrincipalId", receipt.Owner.AdminPrincipalId),
                new SugarParameter("@SiteScope", receipt.Owner.SiteScope),
                new SugarParameter("@ViewId", receipt.ViewId),
                new SugarParameter("@CommandKind", receipt.CommandKind),
                new SugarParameter("@CommandDigest", receipt.CommandDigest),
                new SugarParameter("@ViewRevision", receipt.ViewRevision),
                new SugarParameter("@PreviousCollectionRevision", receipt.PreviousCollectionRevision),
                new SugarParameter("@CollectionRevision", receipt.CollectionRevision),
                new SugarParameter("@QueryDigest", receipt.QueryDigest),
                new SugarParameter("@DependencyDigest", receipt.DependencyDigest),
                new SugarParameter("@Pinned", receipt.Pinned),
                new SugarParameter("@PreviousDefaultViewId", receipt.PreviousDefaultViewId),
                new SugarParameter("@DefaultViewId", receipt.DefaultViewId),
                new SugarParameter("@PreviousActiveViewCount", receipt.PreviousActiveViewCount),
                new SugarParameter("@ActiveViewCount", receipt.ActiveViewCount),
                new SugarParameter("@OrderKey", receipt.OrderKey),
                new SugarParameter("@LifecycleState", (short)receipt.LifecycleState),
                new SugarParameter("@DefaultTransition", (short)receipt.DefaultTransition),
                new SugarParameter("@ChangeCount", receipt.ChangeCount),
                new SugarParameter("@ChangesDigest", receipt.ChangesDigest),
                new SugarParameter("@ReasonCode", receipt.ReasonCode),
                new SugarParameter("@ContentDigest", receipt.ContentDigest),
                new SugarParameter("@OccurredAtUtc", receipt.OccurredAtUtc)).ConfigureAwait(false);

            foreach (AuthorSavedViewHistoryChange change in changes)
            {
                await db.Ado.ExecuteCommandAsync(
                    """
                    INSERT INTO author_saved_view_receipt_change(
                        receipt_id, change_index, view_id, change_kind,
                        before_revision, before_name, before_query_digest,
                        before_dependency_digest, before_pinned, before_order_key,
                        before_lifecycle_state, before_content_digest,
                        after_revision, after_name, after_query_digest,
                        after_dependency_digest, after_pinned, after_order_key,
                        after_lifecycle_state, after_content_digest, content_digest)
                    VALUES (
                        @ReceiptId, @ChangeIndex, @ViewId, @ChangeKind,
                        @BeforeRevision, @BeforeName, @BeforeQueryDigest,
                        @BeforeDependencyDigest, @BeforePinned, @BeforeOrderKey,
                        @BeforeLifecycleState, @BeforeContentDigest,
                        @AfterRevision, @AfterName, @AfterQueryDigest,
                        @AfterDependencyDigest, @AfterPinned, @AfterOrderKey,
                        @AfterLifecycleState, @AfterContentDigest, @ContentDigest);
                    """,
                    new SugarParameter("@ReceiptId", receipt.ReceiptId),
                    new SugarParameter("@ChangeIndex", change.ChangeIndex),
                    new SugarParameter("@ViewId", change.ViewId),
                    new SugarParameter("@ChangeKind", (short)change.ChangeKind),
                    new SugarParameter("@BeforeRevision", change.Before?.Revision),
                    new SugarParameter("@BeforeName", change.Before?.Name),
                    new SugarParameter("@BeforeQueryDigest", change.Before?.QueryDigest),
                    new SugarParameter("@BeforeDependencyDigest", change.Before?.DependencyDigest),
                    new SugarParameter("@BeforePinned", change.Before?.Pinned),
                    new SugarParameter("@BeforeOrderKey", change.Before?.OrderKey),
                    new SugarParameter("@BeforeLifecycleState", (short?)change.Before?.LifecycleState),
                    new SugarParameter("@BeforeContentDigest", change.Before?.ContentDigest),
                    new SugarParameter("@AfterRevision", change.After?.Revision),
                    new SugarParameter("@AfterName", change.After?.Name),
                    new SugarParameter("@AfterQueryDigest", change.After?.QueryDigest),
                    new SugarParameter("@AfterDependencyDigest", change.After?.DependencyDigest),
                    new SugarParameter("@AfterPinned", change.After?.Pinned),
                    new SugarParameter("@AfterOrderKey", change.After?.OrderKey),
                    new SugarParameter("@AfterLifecycleState", (short?)change.After?.LifecycleState),
                    new SugarParameter("@AfterContentDigest", change.After?.ContentDigest),
                    new SugarParameter("@ContentDigest", change.ContentDigest)).ConfigureAwait(false);
            }
        }

        private static SugarParameter[] ViewParameters(AuthorSavedView view)
            =>
            [
                new("@ViewId", view.Id),
                new("@OwnerAdminPrincipalId", view.Owner.AdminPrincipalId),
                new("@SiteScope", view.Owner.SiteScope),
                new("@SchemaVersion", view.SchemaVersion),
                new("@Revision", view.Revision),
                new("@Name", view.Name),
                new("@NameKey", AuthorSavedViewStorageContract.NormalizeNameKey(view.Name)),
                new("@QueryDigest", view.QueryDigest),
                new("@DependencyDigest", view.DependencyDigest),
                new("@SortFieldKind", (short)view.Query.Sort.Field.Kind),
                new("@SortFieldIdentity", view.Query.Sort.Field.Identity),
                new("@SortDirection", (short)view.Query.Sort.Direction),
                new("@SortNullPlacement", (short)view.Query.Sort.NullPlacement),
                new("@SortCollation", view.Query.Sort.Collation),
                new("@SortTimeZoneId", view.Query.Sort.TimeZoneId),
                new("@StableTieBreaker", view.Query.Sort.StableTieBreaker),
                new("@PageSize", view.Query.PageSize),
                new("@Pinned", view.Pinned),
                new("@OrderKey", view.OrderKey),
                new("@LifecycleState", (short)view.LifecycleState),
                new("@CreatedAtUtc", view.CreatedAtUtc),
                new("@UpdatedAtUtc", view.UpdatedAtUtc),
                new("@ContentDigest", view.ContentDigest)
            ];
    }

    private sealed record ViewHeader(
        Guid Id,
        int SchemaVersion,
        long Revision,
        string Name,
        string QueryDigest,
        string DependencyDigest,
        AuthorSavedViewFieldKind SortFieldKind,
        string SortFieldIdentity,
        AuthorSavedViewSortDirection SortDirection,
        AuthorSavedViewNullPlacement SortNullPlacement,
        string SortCollation,
        string? SortTimeZoneId,
        string StableTieBreaker,
        int PageSize,
        bool Pinned,
        long OrderKey,
        AuthorSavedViewLifecycleState LifecycleState,
        DateTime CreatedAtUtc,
        DateTime UpdatedAtUtc,
        string ContentDigest);

    private sealed class ConditionBuilder(
        AuthorSavedViewFieldReference field,
        string operatorId,
        string? timeZoneId)
    {
        public List<string> Values { get; } = [];

        public AuthorSavedViewCondition Build()
            => new(field, operatorId, Array.AsReadOnly(Values.ToArray()), timeZoneId);
    }
}

public sealed class AuthorSavedViewPersistenceException(string code) : Exception(code)
{
    public string Code { get; } = code;
}
