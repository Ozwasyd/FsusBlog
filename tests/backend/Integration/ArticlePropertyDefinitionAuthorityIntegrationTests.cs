using System.Globalization;

using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed partial class ArticlePropertyDefinitionAuthorityIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    private const string TamperKey = "article-property-definition-integration-tamper-key";
    private static readonly ArticlePropertyDefinitionActor s_actor = new(
        42,
        [AdminPermissions.ArticleWrite, AdminPermissions.SystemConfig]);

    [Fact]
    public async Task Store_Persists_Typed_Definition_Receipt_Audit_And_Idempotency_Atomically()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "integration-site");
        CreateArticlePropertyDefinitionCommand command = CreateCommand(
            owner,
            ArticlePropertyValueType.SingleSelect,
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            0,
            [new ArticlePropertyOption(
                Guid.CreateVersion7(),
                "Initial",
                0,
                ArticlePropertyOptionStatus.Active)]);

        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(command);
        Assert.Equal(1, created.SchemaRevision);
        Assert.Equal(1, created.OwnerRevision);
        Assert.False(created.IsIdempotentReplay);

        ArticlePropertyDefinition? definition = await store.GetAsync(s_actor, owner, created.DefinitionId);
        Assert.NotNull(definition);
        Assert.Equal(ArticlePropertyValueType.SingleSelect, definition.ValueType);
        Assert.Equal("field-integration", definition.MachineKey);
        Assert.Equal(created.AfterDefinitionDigest, definition.ContentDigest);
        Assert.Equal(1L, await ScalarAsync<long>(db,
            "SELECT COUNT(*) FROM article_property_definition_receipt WHERE definition_id = @DefinitionId;",
            new SugarParameter("@DefinitionId", created.DefinitionId)));
        Assert.Equal(1L, await ScalarAsync<long>(db,
            "SELECT COUNT(*) FROM article_property_definition_idempotency WHERE receipt_id = @ReceiptId;",
            new SugarParameter("@ReceiptId", created.ReceiptId)));
        Assert.Equal(1L, await ScalarAsync<long>(db,
            "SELECT COUNT(*) FROM sys_audit_log WHERE target_type = 'article-property-definition-receipt' AND target_id = @TargetId;",
            new SugarParameter("@TargetId", created.AuditReference.ToString("N"))));

        ArticlePropertyDefinitionWriteReceipt replay = await store.CreateAsync(command);
        Assert.True(replay.IsIdempotentReplay);
        Assert.Equal(created.ReceiptId, replay.ReceiptId);
        Assert.Equal(1L, await ScalarAsync<long>(db,
            "SELECT COUNT(*) FROM article_property_definition_receipt WHERE definition_id = @DefinitionId;",
            new SugarParameter("@DefinitionId", created.DefinitionId)));

        ArticlePropertyDefinitionVerificationResult verified = await store.VerifyAsync(s_actor, owner, created.DefinitionId);
        Assert.True(verified.Valid, string.Join(',', verified.Violations.Select(static violation => violation.Code)));

        await fixture.ExecuteAsync(
            db.CurrentConnectionConfig.ConnectionString,
            "UPDATE sys_audit_log SET event_info = 'tampered' WHERE target_type = 'article-property-definition-receipt';");
        ArticlePropertyDefinitionVerificationResult tampered = await store.VerifyAsync(s_actor, owner, created.DefinitionId);
        Assert.False(tampered.Valid);
        Assert.Contains(tampered.Violations, static violation => violation.Code == "audit_link_tamper");
    }

    [Fact]
    public async Task Store_Uses_Postgres_Owner_Cas_And_Keyset_Pagination()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore first = CreateStore(db);
        using SqlSugarClient secondDb = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        ArticlePropertyDefinitionStore second = CreateStore(secondDb);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "integration-cas");
        CreateArticlePropertyDefinitionCommand command = CreateCommand(
            owner,
            ArticlePropertyValueType.Text,
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            0,
            []);

        ArticlePropertyDefinitionWriteReceipt[] raced = await Task.WhenAll(
            first.CreateAsync(command),
            second.CreateAsync(command));
        Assert.Equal(raced[0].ReceiptId, raced[1].ReceiptId);
        Assert.Single(raced, static receipt => receipt.IsIdempotentReplay);

        ArticlePropertyDefinitionPage page = await first.ListAsync(s_actor, owner, null, 1);
        Assert.Single(page.Items);
        Assert.Null(page.NextCursor);
        Assert.Equal(1, page.OwnerRevision);

        await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(() => first.CreateAsync(
            command with
            {
                MachineKey = "conflict"
            }));
    }

    [Fact]
    public async Task Store_Persists_Unknown_Value_Impact_As_Reconciliation_Obligation()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "integration-obligation");
        ArticlePropertyDefinitionStore createStore = CreateStore(db);
        ArticlePropertyDefinitionWriteReceipt created = await createStore.CreateAsync(CreateCommand(
            owner,
            ArticlePropertyValueType.Text,
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            0,
            []));
        ArticlePropertyDefinition current = await createStore.GetAsync(s_actor, owner, created.DefinitionId)
            ?? throw new InvalidOperationException("integration definition was not persisted");

        ArticlePropertyDefinitionStore unavailableStore = CreateStore(
            db,
            new UnavailableArticlePropertyDefinitionImpactAuthority());
        ArticlePropertyDefinitionWriteReceipt changed = await unavailableStore.UpdateAsync(new(
            s_actor,
            owner,
            current.DefinitionId,
            Guid.CreateVersion7(),
            ExpectedOwnerRevision: 1,
            ExpectedSchemaRevision: 1,
            current.ValueType,
            current.Cardinality,
            current.Required,
            current.Presence,
            current.DefaultValue,
            current.Constraints,
            current.Options,
            current.ReferencePolicy,
            current.UrlPolicy,
            SearchEligible: true,
            current.Filterable,
            current.Sortable,
            current.DisplayPlacement,
            current.VisibilityScope));

        ArticlePropertyDefinitionObligation obligation = Assert.Single(changed.Obligations);
        Assert.True(obligation.RequiresReconciliation);
        Assert.Null(obligation.AffectedValueCount);
        Assert.Equal("article_property_value_authority_not_available", obligation.ReasonCode);
        Assert.True((await unavailableStore.VerifyAsync(s_actor, owner, current.DefinitionId)).Valid);
    }

    [Fact]
    public async Task Store_Replays_All_Five_Commands_And_Preserves_Interleaved_Tombstone_Identity()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "integration-replay");
        CreateArticlePropertyDefinitionCommand first = CreateCommand(
            owner, ArticlePropertyValueType.Text, Guid.CreateVersion7(), Guid.CreateVersion7(), 0, []);
        _ = await store.CreateAsync(first);
        CreateArticlePropertyDefinitionCommand second = CreateCommand(
            owner, ArticlePropertyValueType.Text, Guid.CreateVersion7(), Guid.CreateVersion7(), 1, [])
            with
        {
            MachineKey = "field-interleaved"
        };
        _ = await store.CreateAsync(second);
        ArticlePropertyDefinition current = await store.GetAsync(s_actor, owner, first.DefinitionId)
            ?? throw new InvalidOperationException("integration definition was not persisted");
        _ = await store.UpdateAsync(new(
            s_actor, owner, current.DefinitionId, Guid.CreateVersion7(), 2, 1,
            current.ValueType, current.Cardinality, current.Required, current.Presence,
            current.DefaultValue, current.Constraints, current.Options, current.ReferencePolicy,
            current.UrlPolicy, SearchEligible: false, current.Filterable, current.Sortable,
            current.DisplayPlacement, current.VisibilityScope));
        _ = await store.RenameAsync(new(
            s_actor, owner, current.DefinitionId, Guid.CreateVersion7(), 3, 2,
            [new ArticlePropertyLocalizedName("en", "Renamed integration property")]));
        _ = await store.DeprecateAsync(new(
            s_actor, owner, current.DefinitionId, Guid.CreateVersion7(), 4, 3));
        ArticlePropertyDefinitionWriteReceipt deleted = await store.DeleteAsync(new(
            s_actor, owner, current.DefinitionId, Guid.CreateVersion7(), 5, 4));

        Assert.Equal(6, deleted.OwnerRevision);
        Assert.Equal(5, deleted.SchemaRevision);
        Assert.Null(await store.GetAsync(s_actor, owner, first.DefinitionId));
        ArticlePropertyDefinitionVerificationSnapshot snapshot = await new PostgresArticlePropertyDefinitionPersistence(
            db, CreateConfiguration()).ReadVerificationSnapshotAsync(owner, first.DefinitionId, 10)
            ?? throw new InvalidOperationException("integration tombstone snapshot was not persisted");
        Assert.Equal(ArticlePropertyDefinitionStatus.Deleted, snapshot.Definition.Status);
        Assert.Equal(first.MachineKey, snapshot.Definition.MachineKey);
        Assert.Equal("Renamed integration property", Assert.Single(snapshot.Definition.DisplayNames).Value);
        Assert.NotNull(snapshot.Replay);
        Assert.Equal(2, snapshot.Replay.Definitions.Count);
        Assert.Equal(6, snapshot.Replay.Entries.Count);
        Assert.Equal(new[] { "create", "create", "change-settings", "rename", "deprecate", "delete" },
            snapshot.Replay.Entries.Select(static entry => entry.Command.CommandKind));
        Assert.Equal(Enumerable.Range(1, 6).Select(static sequence => (long)sequence),
            snapshot.Replay.Entries.Select(static entry => entry.Sequence));
        Assert.Equal(6, snapshot.Replay.IdempotencyRecords.Count);
        Assert.Equal(6L, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_property_definition_command;"));
        Assert.Equal(6L, await ScalarAsync<long>(db, "SELECT revision FROM article_property_definition_history;"));
        Assert.True((await store.VerifyAsync(s_actor, owner, first.DefinitionId)).Valid);
        Assert.True((await store.VerifyAsync(s_actor, owner, second.DefinitionId)).Valid);
        await Assert.ThrowsAsync<ArticlePropertyDefinitionConflictException>(() => store.CreateAsync(
            first with
            {
                RequestId = Guid.CreateVersion7(),
                ExpectedOwnerRevision = 6
            }));
        Assert.Equal(6L, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_property_definition_command;"));
    }

    [Fact]
    public async Task Store_Refuses_Legacy_Facts_Without_History_And_Does_Not_Reconstruct_Or_Resign_Them()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "integration-missing-history");
        CreateArticlePropertyDefinitionCommand command = CreateCommand(
            owner, ArticlePropertyValueType.Text, Guid.CreateVersion7(), Guid.CreateVersion7(), 0, []);
        _ = await store.CreateAsync(command);
        string auditMac = await ScalarAsync<string>(db, "SELECT record_mac FROM sys_audit_log;");
        // This fresh, fixture-owned database models legacy persisted facts, not a
        // production migration/recovery. Keep the original receipt and Audit MAC.
        await db.Ado.ExecuteCommandAsync("DELETE FROM article_property_definition_command;");
        await db.Ado.ExecuteCommandAsync("DELETE FROM article_property_definition_history;");

        ArticlePropertyDefinitionVerificationResult verified = await store.VerifyAsync(s_actor, owner, command.DefinitionId);
        Assert.False(verified.Valid);
        Assert.Contains(verified.Violations, static violation => violation.Code == "history_unavailable");
        ArticlePropertyDefinitionIntegrityException refused = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(
            () => store.RenameAsync(new(s_actor, owner, command.DefinitionId, Guid.CreateVersion7(), 1, 1,
                [new ArticlePropertyLocalizedName("en", "Not accepted")])));
        Assert.Equal("article_property_history_unavailable", refused.Code);
        Assert.Equal(1L, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_property_definition;"));
        Assert.Equal(1L, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_property_definition_receipt;"));
        Assert.Equal(1L, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_property_definition_idempotency;"));
        Assert.Equal(1L, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM sys_audit_log;"));
        Assert.Equal(auditMac, await ScalarAsync<string>(db, "SELECT record_mac FROM sys_audit_log;"));
        Assert.Equal(0L, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_property_definition_history;"));
        Assert.Equal(0L, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_property_definition_command;"));
    }

    [Fact]
    public async Task Verification_Uses_One_Snapshot_When_An_Uncooperative_Audit_Writer_Commits_After_Admission()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        using SqlSugarClient writer = PostgresSqlSugarTestClient.Create(db.CurrentConnectionConfig.ConnectionString);
        ArticlePropertyDefinitionStore store = CreateStore(db);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "integration-snapshot");
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(
            owner, ArticlePropertyValueType.Text, Guid.CreateVersion7(), Guid.CreateVersion7(), 0, []));
        string originalEvent = await ScalarAsync<string>(db, "SELECT event_info FROM sys_audit_log;");
        var beforeHydration = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var writerCommitted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var readingCancellation = new CancellationTokenSource();
        TimeSpan timeout = TimeSpan.FromSeconds(30);
        int paused = 0;
        db.Aop.OnLogExecuting = (sql, _) =>
        {
            if (sql.Contains("FROM article_property_definition", StringComparison.Ordinal)
                && sql.Contains("AND definition_id =", StringComparison.Ordinal)
                && Interlocked.Exchange(ref paused, 1) == 0)
            {
                beforeHydration.TrySetResult(true);
                writerCommitted.Task.WaitAsync(timeout).GetAwaiter().GetResult();
            }
        };
        Task<ArticlePropertyDefinitionVerificationSnapshot?> reading = Task.Run(() =>
            new PostgresArticlePropertyDefinitionPersistence(db, CreateConfiguration())
                .ReadVerificationSnapshotAsync(owner, created.DefinitionId, 10, readingCancellation.Token));
        try
        {
            // AOP pauses the first definition hydration only after SQL admission.
            // The second real connection does not take the cooperative owner lock.
            await beforeHydration.Task.WaitAsync(timeout);
            Assert.Equal(1, await writer.Ado.ExecuteCommandAsync(
                "UPDATE sys_audit_log SET event_info = repeat('x', 9 * 1024 * 1024);"));
            Assert.Equal(9L * 1024 * 1024, await ScalarAsync<long>(writer,
                "SELECT octet_length(event_info) FROM sys_audit_log;"));
            writerCommitted.TrySetResult(true);
            ArticlePropertyDefinitionVerificationSnapshot snapshot = await reading.WaitAsync(timeout)
                ?? throw new InvalidOperationException("integration snapshot was not persisted");
            Assert.Equal(originalEvent, Assert.Single(snapshot.AuditLinks).EventInfo);
            Assert.NotNull(snapshot.Replay);
            Assert.Equal(originalEvent, Assert.Single(snapshot.Replay.AuditRecords).EventInfo);
            Assert.True(new ArticlePropertyDefinitionVerifier(CreateConfiguration()).Verify(snapshot).Valid);
        }
        finally
        {
            writerCommitted.TrySetResult(true);
            db.Aop.OnLogExecuting = null;
            try
            {
                if (!reading.IsCompleted)
                {
                    readingCancellation.Cancel();
                }
            }
            finally
            {
                try
                {
                    // WaitAsync bounds observations, not native/SQL task lifetime.
                    // Even a cancellation callback failure cannot skip this drain.
                    // Only actual completion permits the owned resources to dispose.
                    await reading;
                }
                catch (OperationCanceledException exception)
                    when (readingCancellation.IsCancellationRequested
                        && exception.CancellationToken == readingCancellation.Token)
                {
                    // Preserve the original assertion/observation failure, not the
                    // cooperative cancellation requested solely for this task's drain.
                }
            }
        }

        bool hydrated = false;
        db.Aop.OnLogExecuting = (sql, _) =>
        {
            if (sql.Contains("AND definition_id =", StringComparison.Ordinal))
            {
                hydrated = true;
            }
        };
        try
        {
            ArticlePropertyDefinitionVerificationResult later = await store.VerifyAsync(s_actor, owner, created.DefinitionId);
            Assert.False(later.Valid);
            Assert.Contains(later.Violations, static violation => violation.Code == "verification_resource_budget_exceeded");
            Assert.False(hydrated);
        }
        finally
        {
            db.Aop.OnLogExecuting = null;
        }
    }

    [Theory]
    [InlineData("null-audit-chain")]
    [InlineData("foreign-receipt-owner")]
    public async Task Verification_Refuses_Malformed_Actual_Readsets_Before_Hydration(string fault)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "integration-readset");
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(
            owner, ArticlePropertyValueType.Text, Guid.CreateVersion7(), Guid.CreateVersion7(), 0, []));
        if (fault == "null-audit-chain")
        {
            Assert.Equal(1, await db.Ado.ExecuteCommandAsync("UPDATE sys_audit_log SET chain_id = NULL;"));
        }
        else
        {
            Assert.Equal("foreign-receipt-owner", fault);
            Assert.Equal(1, await db.Ado.ExecuteCommandAsync(
                "UPDATE article_property_definition_receipt SET owner_user_id = 43;"));
        }
        bool hydrated = false;
        db.Aop.OnLogExecuting = (sql, _) =>
        {
            if (sql.Contains("AND definition_id =", StringComparison.Ordinal))
            {
                hydrated = true;
            }
        };
        try
        {
            ArticlePropertyDefinitionVerificationResult refused = await store.VerifyAsync(s_actor, owner, created.DefinitionId);
            Assert.False(refused.Valid);
            Assert.Contains(refused.Violations, static violation => violation.Code == "verification_resource_budget_exceeded");
            Assert.False(hydrated);
        }
        finally
        {
            db.Aop.OnLogExecuting = null;
        }
    }

    [Fact]
    public async Task Verification_Refuses_An_Ambient_Transaction_Without_Changing_Its_Isolation()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "integration-ambient");
        ArticlePropertyDefinitionWriteReceipt created = await CreateStore(db).CreateAsync(CreateCommand(
            owner, ArticlePropertyValueType.Text, Guid.CreateVersion7(), Guid.CreateVersion7(), 0, []));
        await db.Ado.BeginTranAsync();
        try
        {
            string isolation = await ScalarAsync<string>(db, "SHOW transaction_isolation;");
            ArticlePropertyDefinitionIntegrityException refused = await Assert.ThrowsAsync<ArticlePropertyDefinitionIntegrityException>(
                () => new PostgresArticlePropertyDefinitionPersistence(db, CreateConfiguration())
                    .ReadVerificationSnapshotAsync(owner, created.DefinitionId, 10));
            Assert.Equal("article_property_verification_requires_fresh_transaction", refused.Code);
            Assert.Equal(isolation, await ScalarAsync<string>(db, "SHOW transaction_isolation;"));
        }
        finally
        {
            await db.Ado.RollbackTranAsync();
        }
        Assert.True((await CreateStore(db).VerifyAsync(s_actor, owner, created.DefinitionId)).Valid);
    }

    [Theory]
    [InlineData("number", "0.0000000000000000001")]
    [InlineData("number", "0.1234567890123456789012345670")]
    [InlineData("number", "79228162514264337593543950335")]
    [InlineData("number", "-79228162514264337593543950335")]
    [InlineData("date", "0")]
    [InlineData("date", "638962848000000001")]
    [InlineData("date", "3155378975999999999")]
    public async Task Store_roundtrips_legal_constraints_through_typed_postgres_and_authenticated_replay(
        string type,
        string value)
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "integration-constraint-domain");
        bool number = type == "number";
        decimal? expectedNumber = number ? decimal.Parse(value, CultureInfo.InvariantCulture) : null;
        DateTime? expectedDate = number
            ? null
            : new DateTime(long.Parse(value, CultureInfo.InvariantCulture), DateTimeKind.Utc);
        var constraints = new ArticlePropertyConstraints(
            MinNumber: expectedNumber,
            MaxNumber: expectedNumber,
            MinDateUtc: expectedDate,
            MaxDateUtc: expectedDate);
        CreateArticlePropertyDefinitionCommand command = CreateCommand(
            owner, number ? ArticlePropertyValueType.Number : ArticlePropertyValueType.Date,
            Guid.CreateVersion7(), Guid.CreateVersion7(), 0, [])
            with
        {
            Constraints = constraints
        };
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(command);
        string column = number ? "min_number" : "min_date_utc_ticks";
        object raw = await db.Ado.GetScalarAsync(
            $"SELECT {column} FROM article_property_definition WHERE definition_id = @DefinitionId;",
            new SugarParameter("@DefinitionId", created.DefinitionId));
        if (number)
        {
            decimal rawNumber = Assert.IsType<decimal>(raw);
            Assert.Equal(expectedNumber!.Value, rawNumber);
            Assert.Equal(decimal.GetBits(expectedNumber!.Value), decimal.GetBits(rawNumber));
        }
        else
        {
            Assert.Equal(expectedDate!.Value.Ticks, Assert.IsType<long>(raw));
        }
        ArticlePropertyDefinition actual = await store.GetAsync(s_actor, owner, created.DefinitionId)
            ?? throw new InvalidOperationException("constraint definition was not persisted");
        Assert.Equal(constraints, actual.Constraints);
        if (number)
        {
            Assert.Equal(decimal.GetBits(expectedNumber!.Value), decimal.GetBits(actual.Constraints.MinNumber!.Value));
            Assert.Equal(decimal.GetBits(expectedNumber!.Value), decimal.GetBits(actual.Constraints.MaxNumber!.Value));
        }
        else
        {
            Assert.Equal(DateTimeKind.Utc, actual.Constraints.MinDateUtc!.Value.Kind);
            Assert.Equal(DateTimeKind.Utc, actual.Constraints.MaxDateUtc!.Value.Kind);
        }
        Assert.Equal(ArticlePropertyDefinitionContract.ComputeConstraintDigest(constraints), created.ConstraintDigest);
        Assert.Equal(created.AfterDefinitionDigest, actual.ContentDigest);
        ArticlePropertyDefinitionPage page = await store.ListAsync(s_actor, owner, null, 100);
        Assert.Equal(actual.ContentDigest, Assert.Single(page.Items).ContentDigest);
        ArticlePropertyDefinitionWriteReceipt replay = await store.CreateAsync(command);
        Assert.True(replay.IsIdempotentReplay);
        Assert.Equal(created.ReceiptId, replay.ReceiptId);
        ArticlePropertyDefinitionWriteReceipt updated = await store.UpdateAsync(new(
            s_actor, owner, actual.DefinitionId, Guid.CreateVersion7(),
            ExpectedOwnerRevision: 1,
            ExpectedSchemaRevision: 1,
            actual.ValueType, actual.Cardinality, actual.Required, actual.Presence,
            actual.DefaultValue, actual.Constraints, actual.Options, actual.ReferencePolicy,
            actual.UrlPolicy, actual.SearchEligible, actual.Filterable, actual.Sortable,
            actual.DisplayPlacement, actual.VisibilityScope));
        ArticlePropertyDefinition afterUpdate = await store.GetAsync(s_actor, owner, created.DefinitionId)
            ?? throw new InvalidOperationException("updated constraint definition was not persisted");
        Assert.Equal(2, updated.OwnerRevision);
        Assert.Equal(2, updated.SchemaRevision);
        Assert.Equal(constraints, afterUpdate.Constraints);
        Assert.Equal(created.ConstraintDigest, updated.ConstraintDigest);
        Assert.Equal(updated.AfterDefinitionDigest, afterUpdate.ContentDigest);
        if (number)
        {
            Assert.Equal(decimal.GetBits(expectedNumber!.Value), decimal.GetBits(afterUpdate.Constraints.MinNumber!.Value));
            Assert.Equal(decimal.GetBits(expectedNumber!.Value), decimal.GetBits(afterUpdate.Constraints.MaxNumber!.Value));
        }
        else
        {
            Assert.Equal(expectedDate!.Value.Ticks, afterUpdate.Constraints.MinDateUtc!.Value.Ticks);
            Assert.Equal(expectedDate!.Value.Ticks, afterUpdate.Constraints.MaxDateUtc!.Value.Ticks);
            Assert.Equal(DateTimeKind.Utc, afterUpdate.Constraints.MinDateUtc!.Value.Kind);
            Assert.Equal(DateTimeKind.Utc, afterUpdate.Constraints.MaxDateUtc!.Value.Kind);
        }
        ArticlePropertyDefinitionVerificationResult verified = await store.VerifyAsync(s_actor, owner, created.DefinitionId);
        Assert.True(verified.Valid, string.Join(',', verified.Violations.Select(static violation => violation.Code)));
    }

    [Fact]
    public async Task Verification_Refuses_Large_Native_Numeric_Digits_Before_Hydration()
    {
        using SqlSugarClient db = await CreateDatabaseAsync();
        ArticlePropertyDefinitionStore store = CreateStore(db);
        ArticlePropertyDefinitionOwner owner = ArticlePropertyDefinitionOwner.User(42, "integration-numeric-budget");
        ArticlePropertyDefinitionWriteReceipt created = await store.CreateAsync(CreateCommand(
            owner, ArticlePropertyValueType.Number, Guid.CreateVersion7(), Guid.CreateVersion7(), 0, []));
        Assert.True((await store.VerifyAsync(s_actor, owner, created.DefinitionId)).Valid);
        // Corrupt only this fresh fixture-owned readset. Counts stay below the
        // original admission limit; large numeric digits must cause the refusal.
        Assert.Equal(50, await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_property_definition (
                schema_version, definition_id, owner_user_id, site_scope,
                machine_key, value_type, cardinality, required,
                missing_behavior, null_behavior, empty_behavior, default_kind,
                default_scalar, default_option_ids, default_article_ids, min_length,
                max_length, min_number, max_number, min_date_utc_ticks,
                max_date_utc_ticks, min_items, max_items, reference_cardinality,
                reference_permission, allow_cross_site, allow_deleted, allow_archived,
                allow_self_reference, allow_cycles, url_allowed_schemes, url_allow_relative,
                url_allow_absolute, url_max_length, url_normalization, search_eligible,
                filterable, sortable, display_placement, visibility_scope,
                status, schema_revision, created_at_utc, updated_at_utc,
                content_digest
            )
            SELECT
                d.schema_version, gen_random_uuid(), d.owner_user_id, d.site_scope,
                'numeric-budget-' || n.value::text, d.value_type, d.cardinality, d.required,
                d.missing_behavior, d.null_behavior, d.empty_behavior, d.default_kind,
                d.default_scalar, d.default_option_ids, d.default_article_ids, d.min_length,
                d.max_length, repeat('9', 100000)::numeric, repeat('9', 100000)::numeric, d.min_date_utc_ticks,
                d.max_date_utc_ticks, d.min_items, d.max_items, d.reference_cardinality,
                d.reference_permission, d.allow_cross_site, d.allow_deleted, d.allow_archived,
                d.allow_self_reference, d.allow_cycles, d.url_allowed_schemes, d.url_allow_relative,
                d.url_allow_absolute, d.url_max_length, d.url_normalization, d.search_eligible,
                d.filterable, d.sortable, d.display_placement, d.visibility_scope,
                d.status, d.schema_revision, d.created_at_utc, d.updated_at_utc,
                d.content_digest
            FROM article_property_definition d
            CROSS JOIN generate_series(1, 50) AS n(value)
            WHERE d.definition_id = @DefinitionId;
            """,
            new SugarParameter("@DefinitionId", created.DefinitionId)));
        Assert.Equal(51L, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_property_definition;"));
        Assert.Equal(1L, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_property_definition_command;"));
        Assert.Equal(1L, await ScalarAsync<long>(db, "SELECT COUNT(*) FROM article_property_definition_receipt;"));
        decimal numericCost = await ScalarAsync<decimal>(db,
            """
            SELECT COALESCE(SUM(4::bigint * (
                octet_length(CAST(min_number AS text)) + octet_length(CAST(max_number AS text)))), 0)
            FROM article_property_definition;
            """);
        Assert.True(numericCost > ArticlePropertyDefinitionContract.MaxVerificationResourceBytes);
        bool hydrated = false;
        db.Aop.OnLogExecuting = (sql, _) =>
        {
            if (sql.Contains("AND definition_id =", StringComparison.Ordinal))
            {
                hydrated = true;
            }
        };
        try
        {
            ArticlePropertyDefinitionBudgetExceededException refused =
                await Assert.ThrowsAsync<ArticlePropertyDefinitionBudgetExceededException>(
                    () => new PostgresArticlePropertyDefinitionPersistence(db, CreateConfiguration())
                        .ReadVerificationSnapshotAsync(owner, created.DefinitionId, 1000));
            Assert.Equal("article_property_verification_resource_budget_exceeded", refused.Code);
            Assert.False(hydrated);
            ArticlePropertyDefinitionVerificationResult result =
                await store.VerifyAsync(s_actor, owner, created.DefinitionId);
            Assert.False(result.Valid);
            Assert.Contains(result.Violations, static violation => violation.Code == "verification_resource_budget_exceeded");
            Assert.False(hydrated);
        }
        finally
        {
            db.Aop.OnLogExecuting = null;
        }
    }

    private async Task<SqlSugarClient> CreateDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AuditLog));
        ISchemaMigrationDescriptor migration = ArticlePropertyDefinitionAuthorityMigrationDefinitions.BuildMigration();
        foreach (SchemaMigrationStep step in migration.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        ISchemaMigrationDescriptor history = ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.BuildMigration();
        foreach (SchemaMigrationStep step in history.Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        foreach (SchemaMigrationStep step in ArticleSourceGenerationMigrationDefinitions.BuildMigration().Steps)
        {
            await step.ExecuteAsync(db, CancellationToken.None);
        }
        return db;
    }

    private static ArticlePropertyDefinitionStore CreateStore(
        SqlSugarClient db,
        IArticlePropertyDefinitionImpactAuthority? impactAuthority = null)
        => new(
            new PostgresArticlePropertyDefinitionPersistence(db, CreateConfiguration()),
            new ArticlePropertyDefinitionPermissionAuthority(),
            impactAuthority ?? new TestImpactAuthority(),
            new ArticlePropertyDefinitionVerifier(CreateConfiguration()),
            TimeProvider.System);

    private static IConfiguration CreateConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Audit:TamperEvidenceKey"] = TamperKey
            })
            .Build();

    private static CreateArticlePropertyDefinitionCommand CreateCommand(
        ArticlePropertyDefinitionOwner owner,
        ArticlePropertyValueType valueType,
        Guid definitionId,
        Guid requestId,
        long expectedOwnerRevision,
        IReadOnlyList<ArticlePropertyOption> options)
    {
        ArticlePropertyDefaultValue? defaultValue = valueType == ArticlePropertyValueType.SingleSelect
            ? new(ArticlePropertyDefaultKind.OptionIds, OptionIds: [options[0].OptionId])
            : null;
        return new(
            s_actor,
            owner,
            definitionId,
            requestId,
            expectedOwnerRevision,
            "field-integration",
            [new ArticlePropertyLocalizedName("en", "Integration property")],
            valueType,
            ArticlePropertyCardinality.Single,
            Required: false,
            new(ArticlePropertyMissingBehavior.PreserveMissing, ArticlePropertyNullBehavior.AllowNull, ArticlePropertyEmptyBehavior.PreserveEmpty),
            defaultValue,
            new(),
            options,
            null,
            null,
            SearchEligible: true,
            Filterable: true,
            Sortable: true,
            ArticlePropertyDisplayPlacement.Metadata,
            ArticlePropertyVisibilityScope.SiteEditors);
    }

    private sealed class TestImpactAuthority : IArticlePropertyDefinitionImpactAuthority
    {
        public Task<ArticlePropertyDefinitionImpact> GetImpactAsync(
            ArticlePropertyDefinitionOwner owner,
            ArticlePropertyDefinition? before,
            ArticlePropertyDefinition after,
            string commandKind,
            CancellationToken cancellationToken = default)
            => Task.FromResult(new ArticlePropertyDefinitionImpact(0, []));
    }

    private static async Task<T> ScalarAsync<T>(SqlSugarClient db, string sql, params SugarParameter[] parameters)
        => (T)Convert.ChangeType(
            await db.Ado.GetScalarAsync(sql, parameters).ConfigureAwait(false),
            typeof(T))!;
}
