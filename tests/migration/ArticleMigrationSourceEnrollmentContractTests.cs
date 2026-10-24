using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;

using Npgsql;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Real PostgreSQL transport/transaction controls over synthetic closed owner metadata.
// These do not qualify the still Server-only canonical producer/allocator, an owned
// current-schema artifact, media publication, backup admission or whole CLI migration.
public sealed class ArticleMigrationSourceEnrollmentContractTests
{
    private static readonly OfflineMigrationPostgreSqlWriteLock s_family = new(1179866444, 1); // #4616 owner's namespace, test only.
    private static readonly ArticlePreservationWriteLimits s_limits = new(500, 20, 200, 1_000_000, TimeSpan.FromSeconds(10));

    [Fact]
    public async Task Rollback_Removes_Actual_Graph_Outbox_And_Original_Journal_Receipt_Together()
    {
        await using var fixture = await NativeFixture.CreateAsync();
        await fixture.WithWriteAsync(async (context, transaction, token) =>
        {
            var stage = await fixture.StageAsync(context, token);
            Assert.False(stage.AlreadyPresent);
            var receipt = Assert.Single(stage.Outbox);
            Assert.Equal(fixture.Batch.Events[0].EventId, receipt.EventId);
            Assert.True(receipt.OutboxId > 0);
            await fixture.AppendOriginalJournalAsync(stage, context, token);
            Assert.Equal(2, await fixture.CountAsync(OfflineMigrationStateStore.ApplyJournalTableName, transaction));
        }); // The original owner rolls back after the borrowed scope has drained.
        Assert.Equal(0, await fixture.CountAsync(fixture.Graph[0].Table));
        Assert.Equal(0, await fixture.CountAsync(fixture.Outbox[0].Table));
        Assert.Equal(0, await fixture.CountAsync(OfflineMigrationStateStore.ApplyJournalTableName));
    }

    [Fact]
    public async Task Commit_And_Exact_Replay_Keep_Actual_EventId_Row_Identity_And_Original_Journal_Binding()
    {
        await using var fixture = await NativeFixture.CreateAsync();
        ArticlePreservationStorageStage first = null!;
        await fixture.WithWriteAsync(async (context, transaction, token) =>
        {
            first = await fixture.StageAsync(context, token);
            await fixture.AppendOriginalJournalAsync(first, context, token);
        }, commit: true);
        await fixture.WithWriteAsync(async (context, transaction, token) =>
        {
            var replay = await fixture.StageAsync(context, token);
            Assert.True(replay.AlreadyPresent);
            Assert.Equal(first.Outbox.ToArray(), replay.Outbox.ToArray());
            await fixture.RequireOriginalJournalAsync(replay, context, token);
            Assert.Equal(1, await fixture.CountAsync(fixture.Outbox[0].Table, transaction));
        });
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Real_Wire_Commit_Loss_Recovers_By_Actual_Journal_And_Event_Readback(bool serverCommitted)
    {
        await using var fixture = await NativeFixture.CreateAsync();
        await using var proxy = new CommitLossProxy(serverCommitted);
        await using var connection = new NpgsqlConnection(fixture.ConnectionStringForPort(proxy.Port));
        await connection.OpenAsync(fixture.Token);
        var native = fixture.Native(connection);
        Assert.True(await native.AcquireAsync(fixture.Token));
        ArticlePreservationStorageStage staged = null!;
        await using (var transaction = await native.BeginOwnedReadAsync(fixture.Token))
        {
            await native.WithOwnedReadScopeAsync(transaction, async (context, token) =>
            {
                staged = await fixture.StageAsync(context, token);
                await fixture.AppendOriginalJournalAsync(staged, context, token);
            }, fixture.Token);
            proxy.DropNextCommit = true;
            await Assert.ThrowsAnyAsync<Exception>(() => transaction.CommitAsync(fixture.Token));
            await proxy.CommitBoundaryObserved.Task.WaitAsync(fixture.Token);
        }
        // This dead original session must not unlock or borrow a replacement backend.
        await Assert.ThrowsAsync<InvalidOperationException>(() => native.ReleaseAsync(fixture.Token));
        await connection.DisposeAsync();
        await proxy.DisposeAsync();
        await fixture.WithWriteAsync(async (context, transaction, token) =>
        {
            long journalRows = await fixture.CountAsync(OfflineMigrationStateStore.ApplyJournalTableName, transaction);
            Assert.Equal(serverCommitted ? 2 : 0, journalRows);
            var recovered = await fixture.StageAsync(context, token);
            Assert.Equal(serverCommitted, recovered.AlreadyPresent);
            Assert.Equal(staged.Outbox[0].EventId, recovered.Outbox[0].EventId);
            if (serverCommitted)
            {
                Assert.Equal(staged.Outbox.ToArray(), recovered.Outbox.ToArray());
                await fixture.RequireOriginalJournalAsync(recovered, context, token);
            }
            else
                Assert.Empty(await fixture.ReadOriginalJournalAsync(context, token));
            Assert.Equal(1, await fixture.CountAsync(fixture.Outbox[0].Table, transaction));
        });
    }

    [Fact]
    public async Task Family_Contention_Precedes_Offline_Lock_And_RR_Snapshot_Sees_Previous_Writer_Commit()
    {
        await using var fixture = await NativeFixture.CreateAsync();
        await using var holder = new NpgsqlConnection(fixture.ConnectionString);
        await holder.OpenAsync(fixture.Token);
        await fixture.SqlAsync(holder, null, "CREATE TABLE marker(value integer); INSERT INTO marker VALUES(1);");
        await fixture.SqlAsync(holder, null, $"SELECT pg_advisory_lock({s_family.Namespace},{s_family.Key});");
        await using var connection = new NpgsqlConnection(fixture.ConnectionString);
        await connection.OpenAsync(fixture.Token);
        var native = fixture.Native(connection);
        Assert.False(await native.AcquireAsync(fixture.Token));
        Assert.False(native.CleanupRequired);
        // The inner lock is still available while the outer family is contended.
        await using (var command = new NpgsqlCommand("SELECT pg_try_advisory_lock(hashtext(@name));", holder))
        {
            command.Parameters.AddWithValue("name", OfflineMigrationHost.StateLockConstant);
            Assert.Equal(true, await command.ExecuteScalarAsync(fixture.Token));
        }
        await fixture.SqlAsync(holder, null, "UPDATE marker SET value=2;");
        await using (var command = new NpgsqlCommand("SELECT pg_advisory_unlock(hashtext(@name));", holder))
        {
            command.Parameters.AddWithValue("name", OfflineMigrationHost.StateLockConstant);
            Assert.Equal(true, await command.ExecuteScalarAsync(fixture.Token));
        }
        await fixture.SqlAsync(holder, null, $"SELECT pg_advisory_unlock({s_family.Namespace},{s_family.Key});");
        Assert.True(await native.AcquireAsync(fixture.Token));
        await using (var transaction = await native.BeginOwnedReadAsync(fixture.Token))
        {
            await native.WithOwnedReadScopeAsync(transaction, async (context, token) =>
            {
                Assert.Equal(s_family, context.RequirePostgreSqlWriteLock());
                Assert.Equal(IsolationLevel.RepeatableRead, context.OriginalTransaction.IsolationLevel);
                Assert.Equal(2, await OfflineMigrationPostgreSqlNativeSession.WithOriginalWriteAsync(context, async (actual, tx, ct) =>
                {
                    Assert.Same(connection, actual);
                    Assert.Same(transaction, tx);
                    await using var command = new NpgsqlCommand("SELECT value FROM marker;", actual, tx);
                    return (int)(await command.ExecuteScalarAsync(ct))!;
                }, token));
            }, fixture.Token);
            await transaction.RollbackAsync(fixture.Token);
        }
        Assert.True(await native.ReleaseAsync(fixture.Token));
        Assert.Equal(ConnectionState.Open, connection.State);
    }

    [Fact]
    public async Task Busy_Offline_Lock_Releases_Only_Our_Outer_Increment_And_Preserves_Caller_Custody()
    {
        await using var fixture = await NativeFixture.CreateAsync();
        await using var holder = new NpgsqlConnection(fixture.ConnectionString);
        await holder.OpenAsync(fixture.Token);
        await using var inner = new NpgsqlCommand("SELECT pg_advisory_lock(hashtext(@name));", holder);
        inner.Parameters.AddWithValue("name", OfflineMigrationHost.StateLockConstant);
        await inner.ExecuteNonQueryAsync(fixture.Token);
        await using var candidate = new NpgsqlConnection(fixture.ConnectionString);
        await candidate.OpenAsync(fixture.Token);
        var native = fixture.Native(candidate);
        Assert.False(await native.AcquireAsync(fixture.Token));
        Assert.True(native.CleanupRequired);
        Assert.True(await native.ReleaseAsync(fixture.Token));
        Assert.False(native.CleanupRequired);
        await using var outer = new NpgsqlCommand($"SELECT pg_try_advisory_lock({s_family.Namespace},{s_family.Key});", holder);
        Assert.Equal(true, await outer.ExecuteScalarAsync(fixture.Token));
        inner.CommandText = "SELECT pg_advisory_unlock(hashtext(@name));";
        Assert.Equal(true, await inner.ExecuteScalarAsync(fixture.Token));
        outer.CommandText = $"SELECT pg_advisory_unlock({s_family.Namespace},{s_family.Key});";
        Assert.Equal(true, await outer.ExecuteScalarAsync(fixture.Token));
    }

    [Theory]
    [InlineData(IsolationLevel.RepeatableRead, true)]
    [InlineData(IsolationLevel.Serializable, true)]
    [InlineData(IsolationLevel.ReadCommitted, false)]
    public async Task Real_Media_Journal_Retains_Original_RR_Or_Serializable_Isolation(IsolationLevel isolation, bool supported)
    {
        await using var fixture = await NativeFixture.CreateAsync();
        await using var connection = new NpgsqlConnection(fixture.ConnectionString);
        await connection.OpenAsync(fixture.Token);
        await using var transaction = await connection.BeginTransactionAsync(isolation, fixture.Token);
        var database = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(connection, transaction, fixture.Token);
        var plan = JournalPlan(database);
        var artifact = new CurrentSchemaArtifactReference("fixture://media-plan", OfflineMigrationApplyJournalVerifier.ComputePlanArtifactDigest(plan));
        var committed = new OfflineMigrationApplyJournalVerifier(plan, artifact, "native-contract");
        committed.BindOperationOwners(new MediaClassification());
        var first = new OfflineMigrationApplyJournalEntry(OfflineMigrationApplyJournalVerifier.Format,
            artifact, plan.ContentDigest, database, "native-contract", 1, 1, null, null, null,
            OfflineMigrationApplyJournalState.AttemptStarted, null, null, null, null, 0, 0, false,
            null, null, OfflineMigrationApplyJournalVerifier.GenesisDigest, "", null, new DateTimeOffset(2026, 10, 18, 0, 0, 0, TimeSpan.Zero));
        first = first with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(first)
        };
        committed.Accept(first);
        var step = plan.OrderedSteps[0];
        var identity = step.Operations[0];
        var before = new OfflineMigrationPredicateObservation(step.SourcePrecondition, identity.OperationReference,
            identity.OperationSourceDigest, identity.SemanticDigest, [], [], "");
        before = before with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(before)
        };
        var binding = new ArticleMediaBinding(Guid.Parse("22222222-2222-2222-2222-222222222222"), artifact.Sha256,
            plan.ContentDigest, plan.Source.ContentDigest, new string('b', 64), "fixture-source", "fixture-target", "fixture-directory");
        var prepared = first with
        {
            Format = OfflineMigrationApplyJournalVerifier.MediaFormat,
            Sequence = 2,
            StepId = step.StepId,
            OperationReference = identity.OperationReference,
            Mode = identity.Mode,
            IdempotencyKey = step.IdempotencyDefinition,
            State = OfflineMigrationApplyJournalState.MediaPrepared,
            Before = before,
            Media = new("native-contract", binding, null),
            PreviousDigest = first.ContentDigest,
            ContentDigest = ""
        };
        prepared = prepared with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(prepared)
        };
        committed.Accept(prepared);
        if (supported)
        {
            var journal = new OfflineMigrationArticleMediaJournal(committed, committed.Fork(), connection, transaction, 1);
            Assert.Equal(ArticleMediaJournalState.Prepared, await journal.RequirePreparedAsync(binding, fixture.Token));
            await Assert.ThrowsAsync<InvalidOperationException>(() => journal.RequireOriginalWriteAsync(fixture.Token));
        }
        else
        {
            var failure = Assert.Throws<InvalidOperationException>(() =>
                new OfflineMigrationArticleMediaJournal(committed, committed.Fork(), connection, transaction, 1));
            Assert.Equal("offline_apply_media_original_transaction_required", failure.Message);
        }
        await transaction.RollbackAsync(fixture.Token);
    }

    [Fact]
    public async Task Lost_Family_Lock_Expired_Scope_And_Transaction_Replacement_Are_Refused()
    {
        await using var fixture = await NativeFixture.CreateAsync();
        OfflineMigrationApplyNativeSession.OwnedReadContext retained = null!;
        await fixture.WithWriteAsync((context, _, _) =>
        {
            retained = context;
            return Task.CompletedTask;
        });
        Assert.Throws<InvalidOperationException>(() => retained.RequirePostgreSqlWriteLock());
        await fixture.WithWriteAsync(async (context, transaction, token) =>
        {
            await fixture.SqlAsync((NpgsqlConnection)context.OriginalConnection, (NpgsqlTransaction)transaction,
                $"SELECT pg_advisory_unlock({s_family.Namespace},{s_family.Key});");
            var failure = await Assert.ThrowsAsync<InvalidOperationException>(() => context.RequireBoundaryAsync(token));
            Assert.Equal("offline_apply_write_lock_lost", failure.Message);
            // Reacquire only to discharge fixture custody; this never repairs a failed scope.
            await fixture.SqlAsync((NpgsqlConnection)context.OriginalConnection, (NpgsqlTransaction)transaction,
                $"SELECT pg_advisory_lock({s_family.Namespace},{s_family.Key});");
        });
        await fixture.WithWriteAsync(async (context, transaction, token) =>
        {
            await transaction.CommitAsync(token);
            await using var replacement = await ((NpgsqlConnection)fixture.ActiveConnection!).BeginTransactionAsync(IsolationLevel.RepeatableRead, token);
            await Assert.ThrowsAsync<InvalidOperationException>(() => context.RequireBoundaryAsync(token));
            await replacement.RollbackAsync(token);
        }, expectTerminalInsideCallback: true);
    }

    [Fact]
    public async Task Ordinary_Owned_Read_Context_And_ReadCommitted_Do_Not_Become_Write_Adapters()
    {
        await using var fixture = await NativeFixture.CreateAsync();
        await using var connection = new NpgsqlConnection(fixture.ConnectionString);
        await connection.OpenAsync(fixture.Token);
        var native = new OfflineMigrationApplyNativeSession(connection, CurrentSchemaProviderKind.PostgreSql,
            fixture.Token, () => fixture.Token);
        Assert.True(await native.AcquireAsync(fixture.Token));
        await using (var transaction = await native.BeginOwnedReadAsync(fixture.Token))
        {
            await native.WithOwnedReadScopeAsync(transaction, async (context, token) =>
            {
                var failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                    OfflineMigrationPostgreSqlNativeSession.WithOriginalWriteAsync(context, (_, _, _) => Task.FromResult(1), token));
                Assert.Equal("offline_apply_write_lock_required", failure.Message);
            }, fixture.Token);
            await transaction.RollbackAsync(fixture.Token);
        }
        Assert.True(await native.ReleaseAsync(fixture.Token));
        await using var rc = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, fixture.Token);
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationStorageWriter.RequireSession(connection, rc));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationSourceObserver.RequirePostgreSqlStageSession(connection, rc));
        await rc.RollbackAsync(fixture.Token);
    }

    [Fact]
    public async Task Native_Read_Only_Mode_Cannot_Mint_An_Original_Write_Context()
    {
        await using var fixture = await NativeFixture.CreateAsync();
        await using var connection = new NpgsqlConnection(fixture.ConnectionString);
        await connection.OpenAsync(fixture.Token);
        await fixture.SqlAsync(connection, null, "SET default_transaction_read_only=on;");
        var native = fixture.Native(connection);
        Assert.True(await native.AcquireAsync(fixture.Token));
        var failure = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using var unexpected = await native.BeginOwnedReadAsync(fixture.Token);
        });
        Assert.Equal("offline_apply_postgresql_owned_transaction_unobserved", failure.Message);
        Assert.True(await native.ReleaseAsync(fixture.Token));
        Assert.Equal(0, await fixture.CountAsync(fixture.Outbox[0].Table));
    }

    [Fact]
    public async Task Already_Present_Graph_Without_Original_Event_Is_Never_Enrolled_After_Commit()
    {
        await using var fixture = await NativeFixture.CreateAsync();
        await fixture.WithWriteAsync(async (context, transaction, token) =>
        {
            Assert.False(await ArticlePreservationStorageWriter.StageRowsAsync(fixture.Graph,
                context.OriginalConnection, transaction, s_limits, token, originalWrite: context));
        }, commit: true);
        await fixture.WithWriteAsync(async (context, transaction, token) =>
        {
            var failure = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.StageAsync(context, token));
            Assert.Equal("article_preservation_outbox_committed_binding_missing", failure.Message);
            Assert.Equal(0, await fixture.CountAsync(fixture.Outbox[0].Table, transaction));
        });
    }

    [Fact]
    public async Task Existing_Row_And_Event_Tampering_Remain_Fail_Closed_Under_Original_Readback_Oracles()
    {
        await using var fixture = await NativeFixture.CreateAsync();
        await fixture.WithWriteAsync(async (context, transaction, token) => { await fixture.StageAsync(context, token); }, commit: true);
        await fixture.WithWriteAsync(async (context, transaction, token) =>
        {
            var payload = fixture.Outbox[0].Columns.Single(column => column.PropertyOwner.EndsWith(".PayloadJson", StringComparison.Ordinal));
            await fixture.SqlAsync((NpgsqlConnection)context.OriginalConnection, (NpgsqlTransaction)transaction,
                $"UPDATE \"{fixture.Outbox[0].Table}\" SET \"{payload.Name}\"='{{}}';");
            var failure = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.StageAsync(context, token));
            Assert.Equal("article_preservation_outbox_immutable_facts_changed", failure.Message);
        });
        await fixture.WithWriteAsync(async (context, transaction, token) =>
        {
            var article = fixture.Graph.Single(row => row.EntityOwner.EndsWith(".Article", StringComparison.Ordinal));
            var title = article.Columns.Single(column => column.PropertyOwner.EndsWith(".Title", StringComparison.Ordinal));
            await fixture.SqlAsync((NpgsqlConnection)context.OriginalConnection, (NpgsqlTransaction)transaction,
                $"UPDATE \"{article.Table}\" SET \"{title.Name}\"='changed';");
            await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.StageAsync(context, token));
        });
    }

    [Fact]
    public async Task Empty_Article_Batch_Keeps_Taxonomy_Oracles_And_Emits_No_Event_Or_Source_Counter()
    {
        await using var fixture = await NativeFixture.CreateAsync(emptyArticles: true);
        await fixture.WithWriteAsync(async (context, transaction, token) =>
        {
            var first = await fixture.StageAsync(context, token);
            Assert.False(first.AlreadyPresent);
            Assert.Empty(first.Outbox);
            Assert.Empty(ArticlePreservationStorageWriter.OutboxJournalFacts(first));
            var replay = await fixture.StageAsync(context, token);
            Assert.True(replay.AlreadyPresent);
            Assert.Empty(replay.Outbox);
            await using var command = new NpgsqlCommand("SELECT count(*) FROM pg_tables WHERE tablename LIKE 'article_source_%';",
                (NpgsqlConnection)context.OriginalConnection, (NpgsqlTransaction)transaction);
            Assert.Equal(0L, await command.ExecuteScalarAsync(token));
        });
    }

    [Theory]
    [InlineData("event-id")]
    [InlineData("time")]
    [InlineData("payload-coordinate")]
    [InlineData("scope")]
    [InlineData("duplicate-json")]
    [InlineData("missing-event")]
    [InlineData("plan")]
    public void Closed_Envelope_Binding_Refuses_Fabricated_Or_Incomplete_Input(string changed)
    {
        var (plan, batch) = Inputs(false);
        var item = batch.Events[0];
        batch = changed switch
        {
            "event-id" => batch with { Events = [item with { EventId = new string('0', 32) }] },
            "time" => batch with { Events = [item with { OccurredAt = item.OccurredAt.AddSeconds(1) }] },
            "payload-coordinate" => batch with { Events = [item with { PayloadJson = item.PayloadJson.Replace("\"revisionNo\":1", "\"revisionNo\":2", StringComparison.Ordinal) }] },
            "scope" => batch with { Events = [item with { PayloadJson = item.PayloadJson.Replace("published", "draft", StringComparison.Ordinal) }] },
            "duplicate-json" => batch with { Events = [item with { PayloadJson = item.PayloadJson.Insert(1, "\"articleId\":1,") }] },
            "missing-event" => batch with { Events = [] },
            "plan" => batch with { PlanDigest = new string('f', 64) },
            _ => throw new ArgumentOutOfRangeException(nameof(changed))
        };
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationStorageProgram.BindOutboxRows(OutboxTable(), plan, batch, default));
    }

    private static (ArticlePreservationWritePlan Plan, ArticlePreservationOutboxBatch Batch) Inputs(bool empty)
    {
        DateTime created = new(2026, 5, 17, 10, 0, 0, DateTimeKind.Unspecified);
        var source = new LegacyArticlePreservationRow(1, "raw title\n", "# raw body\n", "summary", 1, [1], 37, created, false);
        var article = new ArticleCanonicalInput(1, 101, 1, "article:1", source.Title, source.Summary, null, 1, [1],
            ArticleStatusValues.Published, created, null, source.Markdown!);
        var rights = ArticleProductionNormalizers.NormalizeArticleRights(null);
        var responsibility = new ArticleResponsibilityDraft(false, [new("Fixture author", null)], null, [],
            "Initial import", "offline preservation", created, "none", null, null, null, true, false, false, false, 1);
        var current = new ArticlePreservationCurrentData(1, article, rights, responsibility, null,
            new(201, 301, 401, 501, 1, 601, 1, 701, "Initial import", "article-created", created));
        var artifact = new CurrentSchemaArtifactReference("fixture://artifact", new string('a', 64));
        var graph = new ArticlePreservationArticleWritePlan(source, current, artifact,
            ArticleRightsCanonicalBinding.Build(article, rights), ArticlePreservationSemanticReceipt.HashMarkdown(source.Markdown!),
            new string('b', 64), new string('c', 64), ArticleRevisionContentAddress.Compute(source.Markdown!));
        var media = new ArticleMediaInventory("fixture-root", new string('d', 64), [], 0, new string('e', 64));
        var plan = new ArticlePreservationWritePlan(artifact, new string('a', 64), artifact,
            [new(1, "category", 1, "category")], [new(1, "tag", 1, "tag")], empty ? [] : [graph], media, "");
        plan = plan with
        {
            ContentDigest = ArticlePreservationSemanticReceipt.ComputePlanDigest(plan)
        };
        DateTime occurred = DateTime.SpecifyKind(created, DateTimeKind.Utc);
        // Canonical v2 envelope fixture, NOT a replacement for the Server producer.
        string payload = JsonSerializer.Serialize(new
        {
            schemaVersion = 2,
            articleId = 1,
            eventType = "created",
            articleRevisionId = 101L,
            revisionNo = 1,
            rightsSnapshotId = 401L,
            responsibilitySnapshotId = 501L,
            responsibilityVersion = 1,
            releaseId = 601L,
            releaseNo = 1,
            publicUpdatedAt = occurred,
            occurredAt = occurred,
            before = (object?)null,
            after = new
            {
                categoryId = 1,
                tagIds = new[] { 1 },
                visibility = "published"
            }
        });
        var batch = new ArticlePreservationOutboxBatch(plan.ContentDigest,
            empty ? [] : [new(1, "efcf9a1200174a799165496c977ef998", payload, occurred)]);
        return (plan, batch);
    }

    private static SchemaTableModel OutboxTable()
    {
        const string Owner = "FsusBlog.Server.Entities.ArticleMutationOutboxEvent";
        string[] strings = ["EventId", "AggregateType", "EventType", "PayloadJson", "Status", "LastError", "ClaimToken", "ClaimedBy"];
        string[] integers = ["AggregateId", "SchemaVersion", "RevisionNo", "ResponsibilityVersion", "PublicationNo", "RetryCount"];
        string[] longs = ["Id", "ArticleRevisionId", "RightsSnapshotId", "ResponsibilitySnapshotId", "ArticlePublicationId"];
        string[] times = ["NextRetryAt", "CreatedAt", "ProcessedAt", "ClaimedAt", "HeartbeatAt", "ClaimExpiresAt"];
        string[] nullable = ["ArticleRevisionId", "RevisionNo", "RightsSnapshotId", "ResponsibilitySnapshotId", "ResponsibilityVersion",
            "ArticlePublicationId", "PublicationNo", "LastError", "ClaimToken", "ClaimedBy", "ProcessedAt", "ClaimedAt", "HeartbeatAt", "ClaimExpiresAt"];
        var columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal);
        foreach (string property in strings.Concat(integers).Concat(longs).Concat(times))
        {
            string name = "f_" + property.ToLowerInvariant();
            columns.Add(name, new(name, nullable.Contains(property), property == "Id", property == "Id", null,
                strings.Contains(property) ? "string" : integers.Contains(property) ? "int32" : longs.Contains(property) ? "int64" : "timestamp",
                Conversion: "none", Owner: new(Owner + "." + property, "fixture")));
        }
        return new("native_outbox", columns, [], owner: new(Owner, "fixture"));
    }

    private static ImmutableArray<ArticlePreservationStorageRow> GraphRows(ArticlePreservationWritePlan plan)
        => ArticlePreservationStorageProgram.BuildLogicalRows(plan, default).Select(row =>
        {
            string entity = row.EntityOwner.Split('.').Last();
            var columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal);
            foreach (var field in row.Fields)
            {
                string name = "f_" + field.Property.ToLowerInvariant();
                bool key = field.Property == "Id" || entity == "ArticleBody" && field.Property == "ArticleId"
                    || entity == "ArticleTag";
                bool pointer = entity == "Article" && field.Property is "CurrentRevisionId" or "CurrentPublicationId";
                string type = field.Value switch
                {
                    int => "int32",
                    long => "int64",
                    bool => "boolean",
                    DateTime => "timestamp",
                    _ => "string"
                };
                columns.Add(name, new(name, field.Value is null || pointer, key, false, null, type,
                    Conversion: "none", Owner: new(row.EntityOwner + "." + field.Property, "fixture")));
            }
            var table = new SchemaTableModel("native_" + entity.ToLowerInvariant(), columns, [], owner: new(row.EntityOwner, "fixture"));
            return ArticlePreservationStorageProgram.BindRow(table, row);
        }).ToImmutableArray();

    private sealed class NativeFixture : IAsyncDisposable
    {
        private const string Admin = "Host=127.0.0.1;Port=5432;Username=fsusblog;Password=fsusblog_dev;Database=postgres;Pooling=false;SSL Mode=Disable";
        private readonly CancellationTokenSource _deadline = new(TimeSpan.FromSeconds(40));
        private readonly string _database = "native_source_contract_" + Guid.NewGuid().ToString("N");
        private OfflineMigrationPlan _journalPlan = null!;
        private OfflineMigrationApplyJournalEntry? _last;
        internal string ConnectionString => new NpgsqlConnectionStringBuilder(Admin) { Database = _database }.ConnectionString;
        internal string ConnectionStringForPort(int port) => new NpgsqlConnectionStringBuilder(ConnectionString) { Port = port }.ConnectionString;
        internal CancellationToken Token => _deadline.Token;
        internal DbConnection? ActiveConnection
        {
            get; private set;
        }
        internal ArticlePreservationWritePlan Plan { get; private init; } = null!;
        internal ArticlePreservationOutboxBatch Batch { get; private init; } = null!;
        internal ImmutableArray<ArticlePreservationStorageRow> Graph
        {
            get; private init;
        }
        internal ImmutableArray<ArticlePreservationStorageRow> Outbox
        {
            get; private init;
        }

        internal static async Task<NativeFixture> CreateAsync(bool emptyArticles = false)
        {
            var (plan, batch) = Inputs(emptyArticles);
            var fixture = new NativeFixture
            {
                Plan = plan,
                Batch = batch,
                Graph = GraphRows(plan),
                Outbox = ArticlePreservationStorageProgram.BindOutboxRows(OutboxTable(), plan, batch, default)
            };
            try
            {
                await using (var admin = new NpgsqlConnection(Admin))
                {
                    await admin.OpenAsync(fixture.Token);
                    await fixture.SqlAsync(admin, null, $"CREATE DATABASE \"{fixture._database}\";");
                }
                await using var connection = new NpgsqlConnection(fixture.ConnectionString);
                await connection.OpenAsync(fixture.Token);
                foreach (var row in fixture.Graph.GroupBy(row => row.Table).Select(group => group.First()))
                    await fixture.CreateTableAsync(connection, row);
                // Empty article control still gets a real empty outbox table.
                var schema = OutboxTable();
                var fields = schema.Columns.Values.OrderBy(column => column.Name, StringComparer.Ordinal).Select(column =>
                    new ArticlePreservationStorageColumn(column.Name, column.Owner!.Owner, null, column.IsPrimaryKey,
                        column.IsIdentity, column.DataType, column.IsNullable)).ToImmutableArray();
                await fixture.CreateTableAsync(connection, new(schema.Name, schema.Owner!.Owner, fields));
                await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, fixture.Token);
                await OfflineMigrationStateStore.EnsureApplyJournalAsync(connection, transaction, fixture.Token);
                var database = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(connection, transaction, fixture.Token);
                fixture._journalPlan = JournalPlan(database);
                await transaction.CommitAsync(fixture.Token);
                return fixture;
            }
            catch
            {
                await fixture.DisposeAsync();
                throw;
            }
        }

        private Task CreateTableAsync(NpgsqlConnection connection, ArticlePreservationStorageRow row)
        {
            string fields = string.Join(',', row.Columns.Select(column => $"\"{column.Name}\" "
                + (column.DataType switch
                {
                    "int32" => "integer",
                    "int64" => "bigint",
                    "boolean" => "boolean",
                    "timestamp" => "timestamp without time zone",
                    _ => "text"
                })
                + (column.IsIdentity ? " GENERATED BY DEFAULT AS IDENTITY" : "")
                + (column.IsNullable ? "" : " NOT NULL")));
            string key = string.Join(',', row.Columns.Where(column => column.IsPrimaryKey).Select(column => $"\"{column.Name}\""));
            return SqlAsync(connection, null, $"CREATE TABLE \"{row.Table}\" ({fields}, PRIMARY KEY ({key}));"
                + (row.EntityOwner.EndsWith(".ArticleMutationOutboxEvent", StringComparison.Ordinal)
                    ? $" CREATE UNIQUE INDEX ON \"{row.Table}\" (f_eventid);" : ""));
        }

        internal OfflineMigrationApplyNativeSession Native(NpgsqlConnection connection)
            => new(connection, CurrentSchemaProviderKind.PostgreSql, Token, () => Token, s_family);

        internal async Task WithWriteAsync(
            Func<OfflineMigrationApplyNativeSession.OwnedReadContext, DbTransaction, CancellationToken, Task> body,
            bool commit = false, bool expectTerminalInsideCallback = false)
        {
            await using var connection = new NpgsqlConnection(ConnectionString);
            await connection.OpenAsync(Token);
            ActiveConnection = connection;
            var native = Native(connection);
            // A dead proxy session can take a short server round trip to release its locks.
            while (!await native.AcquireAsync(Token))
                await Task.Delay(10, Token);
            try
            {
                await using var transaction = await native.BeginOwnedReadAsync(Token);
                Task Run() => native.WithOwnedReadScopeAsync(transaction, (context, token) => body(context, transaction, token), Token);
                if (expectTerminalInsideCallback)
                {
                    var failure = await Assert.ThrowsAsync<InvalidOperationException>(Run);
                    Assert.Equal("offline_apply_original_transaction_required", failure.Message);
                }
                else
                {
                    await Run();
                    if (commit)
                        await transaction.CommitAsync(Token);
                    else
                        await transaction.RollbackAsync(Token);
                }
            }
            finally
            {
                Assert.True(await native.ReleaseAsync(Token));
                ActiveConnection = null;
            }
        }

        internal Task<ArticlePreservationStorageStage> StageAsync(OfflineMigrationApplyNativeSession.OwnedReadContext context, CancellationToken token)
            => ArticlePreservationStorageWriter.StageRowsWithOutboxAsync(Plan.ContentDigest, Graph, Outbox, context, s_limits, token);

        internal async Task SqlAsync(NpgsqlConnection connection, NpgsqlTransaction? transaction, string sql)
        {
            await using var command = new NpgsqlCommand(sql, connection, transaction);
            await command.ExecuteNonQueryAsync(Token);
        }

        internal async Task<long> CountAsync(string table, DbTransaction? transaction = null)
        {
            if (transaction is not null)
            {
                await using var command = new NpgsqlCommand($"SELECT count(*) FROM \"{table}\";", (NpgsqlConnection)transaction.Connection!, (NpgsqlTransaction)transaction);
                return (long)(await command.ExecuteScalarAsync(Token))!;
            }
            await using var connection = new NpgsqlConnection(ConnectionString);
            await connection.OpenAsync(Token);
            await using var read = new NpgsqlCommand($"SELECT count(*) FROM \"{table}\";", connection);
            return (long)(await read.ExecuteScalarAsync(Token))!;
        }

        private CurrentSchemaArtifactReference JournalArtifact => new("fixture://native-journal-plan", OfflineMigrationApplyJournalVerifier.ComputePlanArtifactDigest(_journalPlan));

        internal async Task AppendOriginalJournalAsync(ArticlePreservationStorageStage stage,
            OfflineMigrationApplyNativeSession.OwnedReadContext context, CancellationToken token)
        {
            var verifier = new OfflineMigrationApplyJournalVerifier(_journalPlan, JournalArtifact, "native-contract");
            var step = _journalPlan.OrderedSteps[0];
            var identity = step.Operations[0];
            var facts = ArticlePreservationStorageWriter.OutboxJournalFacts(stage)
                .Add(new("article.plan_digest", stage.PlanDigest)).OrderBy(fact => fact.Name, StringComparer.Ordinal).ToImmutableArray();
            OfflineMigrationPredicateObservation Observe(string predicate)
            {
                var observation = new OfflineMigrationPredicateObservation(predicate, identity.OperationReference,
                    identity.OperationSourceDigest, identity.SemanticDigest, facts, facts, "");
                return observation with
                {
                    ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(observation)
                };
            }
            var first = new OfflineMigrationApplyJournalEntry(OfflineMigrationApplyJournalVerifier.Format,
                JournalArtifact, _journalPlan.ContentDigest, context.Database, "native-contract", 1, 1,
                null, null, null, OfflineMigrationApplyJournalState.AttemptStarted, null, null, null, null,
                0, 0, false, null, null, OfflineMigrationApplyJournalVerifier.GenesisDigest, "", null,
                new DateTimeOffset(2026, 10, 18, 0, 0, 0, TimeSpan.Zero));
            first = first with
            {
                ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(first)
            };
            verifier.Accept(first);
            await OfflineMigrationStateStore.AppendApplyJournalAsync(context.OriginalConnection, context.OriginalTransaction, first, token);
            var unit = first with
            {
                Sequence = 2,
                StepId = step.StepId,
                OperationReference = identity.OperationReference,
                Mode = identity.Mode,
                State = OfflineMigrationApplyJournalState.TransactionCommitted,
                IdempotencyKey = step.IdempotencyDefinition,
                RowsProcessed = stage.VerifiedRows,
                ExpectedRows = stage.VerifiedRows,
                UnitComplete = true,
                Before = Observe(step.SourcePrecondition),
                After = Observe(step.TargetPostcondition),
                PreviousDigest = first.ContentDigest,
                ContentDigest = ""
            };
            unit = unit with
            {
                ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(unit)
            };
            verifier.Accept(unit);
            await OfflineMigrationStateStore.AppendApplyJournalAsync(context.OriginalConnection, context.OriginalTransaction, unit, token);
            _last = unit; // Retained expected candidate; not a commit acknowledgement.
        }

        internal async Task<ImmutableArray<OfflineMigrationApplyJournalEntry>> ReadOriginalJournalAsync(
            OfflineMigrationApplyNativeSession.OwnedReadContext context, CancellationToken token)
        {
            var verifier = new OfflineMigrationApplyJournalVerifier(_journalPlan, JournalArtifact, "native-contract");
            long count = await CountAsync(OfflineMigrationStateStore.ApplyJournalTableName, context.OriginalTransaction);
            var checkpoint = count == 0 ? null : new OfflineMigrationApplyCheckpoint(
                OfflineMigrationApplyJournalVerifier.Reference(_last!), "native-contract", 2);
            await OfflineMigrationStateStore.ReadApplyJournalAsync(context.OriginalConnection, context.OriginalTransaction,
                _journalPlan.ContentDigest, context.Database, new("native-contract", 1, false, checkpoint), verifier, token);
            return verifier.Last is null ? [] : [verifier.First!, verifier.Last];
        }

        internal async Task RequireOriginalJournalAsync(ArticlePreservationStorageStage stage,
            OfflineMigrationApplyNativeSession.OwnedReadContext context, CancellationToken token)
        {
            var entries = await ReadOriginalJournalAsync(context, token);
            Assert.Equal(2, entries.Length);
            var actual = entries[1].After!.ActualFacts.Where(fact => fact.Name.StartsWith("outbox.", StringComparison.Ordinal)).ToArray();
            Assert.Equal(ArticlePreservationStorageWriter.OutboxJournalFacts(stage).ToArray(), actual);
            Assert.Equal(stage.PlanDigest, entries[1].After!.ActualFacts.Single(fact => fact.Name == "article.plan_digest").Value);
        }

        public async ValueTask DisposeAsync()
        {
            // Only this exact task-created database is removed. Never touch the saved app database.
            await using var admin = new NpgsqlConnection(Admin);
            await admin.OpenAsync();
            await using var drop = new NpgsqlCommand($"DROP DATABASE IF EXISTS \"{_database}\" WITH (FORCE);", admin);
            await drop.ExecuteNonQueryAsync();
            _deadline.Dispose();
        }
    }

    // Classification only: no source/materialization or generation implementation.
    private sealed class MediaClassification : IOfflineMigrationApplyOperationRegistry
    {
        public OfflineMigrationApplyOperation Resolve(OfflineMigrationStep step, OfflineMigrationProviderOperation operation)
            => new ClassifiedMedia(operation);
    }

    private sealed class ClassifiedMedia(OfflineMigrationProviderOperation identity) : OfflineMigrationArticleMediaOperation
    {
        internal override OfflineMigrationProviderOperation Identity => identity;
        internal override Task<OfflineMigrationPredicateObservation> ObserveAsync(string predicateReference,
            DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken) => throw new NotSupportedException();
        internal override Task<OfflineMigrationMediaJournalEvidence> GetMediaBindingAsync(VerifiedOfflineMigrationPlan plan,
            CurrentSchemaArtifactReference artifact, string invocationId, DbConnection connection, DbTransaction transaction,
            CancellationToken cancellationToken) => throw new NotSupportedException();
        internal override Task<OfflineMigrationApplyUnit> ExecuteMediaAsync(OfflineMigrationStep step,
            OfflineMigrationApplyJournalEntry? previousUnit, DbConnection connection, DbTransaction transaction,
            IArticleMediaPreservationJournal journal, CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    private static OfflineMigrationPlan JournalPlan(CurrentSchemaDatabaseIdentity database)
    {
        string digest = new('a', 64);
        DateTimeOffset recorded = new(2026, 10, 18, 0, 0, 0, TimeSpan.Zero);
        var source = new OfflineMigrationSourceObservation(database, "fixture-extractor", "v1", [], [], [], digest);
        var artifact = new CurrentSchemaArtifactReference("fixture://backup", digest);
        var backup = new OfflineMigrationBackupObservation(artifact, artifact, artifact, "fixture-owner", "v1", recorded, recorded,
            "fixture-snapshot", digest, digest, source, source with
            {
                Database = database with
                {
                    DatabaseId = "fixture-restored"
                }
            },
            new[] { "aotCache", "configRedacted", "dataProtectionKeyRing", "database", "searchIndex", "uploads" }
                .Select(name => new OfflineMigrationFact(name, digest)).ToImmutableArray());
        var step = new OfflineMigrationStep("native-contract", "native-before", "native-after", [], "native-idempotency", false,
            new("v1", 0, "no-watermark", "native-replay"),
            Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationProviderOperation(
                provider, "native-contract-owner", digest, digest, OfflineMigrationExecutionMode.Transaction)).ToImmutableArray());
        var registry = new OfflineMigrationSourceRegistry("v1", [new("fixture-profile", "v1", "fixture-owner", ["native-contract"], step.StepId,
            Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationSourceShape(provider,
                source.ExtractorId, source.ExtractorVersion, [], [], [])).ToImmutableArray())]);
        return OfflineMigrationPlanBuilder.Create(source, backup, new("v1", "v1", "v1", digest, digest),
            new(new string('a', 40), digest, digest, digest), registry, new("fixture-dag", "v1", [step]), recorded, TimeSpan.FromHours(1));
    }

    // Real unencrypted loopback PG wire control. One case drops COMMIT before the
    // server receives it; the other drops its CommandComplete after durable commit.
    // Neither case replaces Npgsql CommitAsync or throws a fabricated driver result.
    private sealed class CommitLossProxy : IAsyncDisposable
    {
        private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
        private readonly CancellationTokenSource _stop = new();
        private readonly bool _serverCommitted;
        private readonly Task _run;
        private int _disposed;
        internal bool DropNextCommit
        {
            get; set;
        }
        internal TaskCompletionSource CommitBoundaryObserved { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

        internal CommitLossProxy(bool serverCommitted)
        {
            _serverCommitted = serverCommitted;
            _listener.Start();
            _run = RunAsync();
        }

        private async Task RunAsync()
        {
            using var client = await _listener.AcceptTcpClientAsync(_stop.Token);
            client.NoDelay = true;
            using var server = new TcpClient { NoDelay = true };
            await server.ConnectAsync(IPAddress.Loopback, 5432, _stop.Token);
            using NetworkStream downstream = client.GetStream();
            using NetworkStream upstream = server.GetStream();
            async Task RelayAsync(NetworkStream input, NetworkStream output, bool fromServer)
            {
                if (!fromServer)
                {
                    byte[] startupHeader = new byte[4];
                    await input.ReadExactlyAsync(startupHeader, _stop.Token);
                    int startupLength = System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(startupHeader);
                    byte[] startup = new byte[startupLength - 4];
                    await input.ReadExactlyAsync(startup, _stop.Token);
                    await output.WriteAsync(startupHeader, _stop.Token);
                    await output.WriteAsync(startup, _stop.Token);
                }
                byte[] header = new byte[5];
                while (!_stop.IsCancellationRequested)
                {
                    await input.ReadExactlyAsync(header, _stop.Token);
                    int length = System.Buffers.Binary.BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(1));
                    if (length < 4 || length > 4_000_000)
                        throw new InvalidDataException("Invalid native PG test frame.");
                    byte[] body = new byte[length - 4];
                    await input.ReadExactlyAsync(body, _stop.Token);
                    bool commit = DropNextCommit && ((_serverCommitted && fromServer && header[0] == 'C')
                        || (!_serverCommitted && !fromServer && header[0] == 'Q'))
                        && Encoding.UTF8.GetString(body).TrimEnd('\0', ';', ' ', '\n', '\r').Equals("COMMIT", StringComparison.OrdinalIgnoreCase);
                    if (commit)
                    {
                        CommitBoundaryObserved.TrySetResult();
                        client.Close();
                        server.Close();
                        return;
                    }
                    await output.WriteAsync(header, _stop.Token);
                    await output.WriteAsync(body, _stop.Token);
                }
            }
            Task down = RelayAsync(upstream, downstream, true);
            Task up = RelayAsync(downstream, upstream, false);
            try
            {
                await Task.WhenAll(down, up);
            }
            catch (Exception failure) when (failure is IOException or OperationCanceledException or ObjectDisposedException or SocketException) { }
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
                return;
            await _stop.CancelAsync();
            _listener.Stop();
            try
            {
                await _run;
            }
            catch (Exception failure) when (failure is OperationCanceledException or ObjectDisposedException or SocketException) { }
            _stop.Dispose();
        }
    }
}
