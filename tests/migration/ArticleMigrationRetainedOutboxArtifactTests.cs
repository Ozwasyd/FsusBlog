using System.Collections.Immutable;
using System.Data;
using System.Globalization;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;

using Npgsql;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Synthetic issued data exercises integrity only, never authentic canonical issuance.
// Real PostgreSQL controls use only this task's database, native rows and original journal.
public sealed class ArticleMigrationRetainedOutboxArtifactTests
{
    private static readonly ArticlePreservationOutboxArtifactLimits s_limits = new(4_000_000, 500, 2_000_000);
    private static readonly ArticlePreservationWriteLimits s_writeLimits = new(500, 20, 200, 4_000_000, TimeSpan.FromSeconds(10));
    private static readonly DateTime s_occurred = new(2026, 10, 18, 0, 0, 0, DateTimeKind.Utc);

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(126)]
    [InlineData(127)]
    [InlineData(300)]
    public void Exact_Retained_Data_Preserves_All_Issued_Fields_Including_Empty_And_Large_Batches(int count)
    {
        var data = Data(count);
        var actual = Parse(data);
        Assert.Equal(data.Binding, actual.Binding);
        Assert.Equal(data.Batch.Events.ToArray(), actual.Batch.Events.ToArray());
        // No raw DTO or parsed artifact constitutes an issuance capability.
        Assert.Equal(typeof(ArticlePreservationRetainedOutboxData), actual.GetType());
    }

    [Theory]
    [InlineData("plan-file")]
    [InlineData("plan-digest")]
    [InlineData("article-plan")]
    [InlineData("source-export")]
    [InlineData("current-export")]
    [InlineData("full-source")]
    [InlineData("tool")]
    [InlineData("operation")]
    [InlineData("invocation")]
    [InlineData("database")]
    [InlineData("issuer")]
    public void Exact_Original_Binding_Rejects_Foreign_Plan_Source_Tool_Invocation_And_Issuer(string changed)
    {
        var data = Data(1);
        var binding = data.Binding;
        var foreign = changed switch
        {
            "plan-file" => data with { Binding = binding with { PlanArtifact = Ref("other-plan") } },
            "plan-digest" => data with { Binding = binding with { PlanDigest = Digest('b') } },
            "article-plan" => data with { Binding = binding with { ArticlePlanDigest = Digest('b') } },
            "source-export" => data with { Binding = binding with { SourceExport = Ref("other-source") } },
            "current-export" => data with { Binding = binding with { CurrentExport = Ref("other-current") } },
            "full-source" => data with { Binding = binding with { FullSourceContentDigest = Digest('b') } },
            "tool" => data with { Binding = binding with { Tool = binding.Tool with { WorktreeDigest = Digest('b') } } },
            "operation" => data with { Binding = binding with { Operation = binding.Operation with { SemanticDigest = Digest('b') } } },
            "invocation" => data with { Binding = binding with { InvocationId = "foreign-invocation" } },
            "database" => data with { Binding = binding with { Database = binding.Database with { DatabaseId = "foreign-database" } } },
            "issuer" => data with { Issuer = data.Issuer with { ProducerAssemblySha256 = Digest('b') } },
            _ => throw new ArgumentOutOfRangeException(nameof(changed))
        };
        Assert.Throws<InvalidOperationException>(() => Parse(foreign, data));
    }

    [Theory]
    [InlineData("duplicate")]
    [InlineData("unknown")]
    [InlineData("whitespace")]
    [InlineData("truncated")]
    [InlineData("event-count")]
    [InlineData("event-id")]
    [InlineData("event-time")]
    [InlineData("article-roster")]
    [InlineData("payload-budget")]
    [InlineData("byte-budget")]
    public void Malformed_Noncanonical_Or_Unbounded_Retained_Data_Fails_Closed(string changed)
    {
        var original = Data(1);
        var data = original;
        var limits = s_limits;
        byte[] bytes = ArticlePreservationRetainedOutboxArtifact.SerializeCandidate(data);
        string text = Encoding.UTF8.GetString(bytes);
        switch (changed)
        {
            case "duplicate":
                bytes = Encoding.UTF8.GetBytes(text.Insert(1, "\"Format\":\"private-payload-sentinel\","));
                break;
            case "unknown":
                bytes = Encoding.UTF8.GetBytes(text.Insert(1, "\"Unknown\":\"private-payload-sentinel\","));
                break;
            case "whitespace":
                bytes = Encoding.UTF8.GetBytes(" " + text);
                break;
            case "truncated":
                bytes = bytes[..^3];
                break;
            case "event-count":
                data = data with
                {
                    Batch = data.Batch with
                    {
                        Events = []
                    }
                };
                break;
            case "event-id":
                data = data with
                {
                    Batch = data.Batch with
                    {
                        Events = [data.Batch.Events[0] with { EventId = "invalid" }]
                    }
                };
                break;
            case "event-time":
                data = data with
                {
                    Batch = data.Batch with
                    {
                        Events = [data.Batch.Events[0] with { OccurredAt = s_occurred.AddTicks(1) }]
                    }
                };
                break;
            case "article-roster":
                data = data with
                {
                    Batch = data.Batch with
                    {
                        Events = [data.Batch.Events[0] with { ArticleId = 2 }]
                    }
                };
                break;
            case "payload-budget":
                limits = limits with
                {
                    MaximumPayloadBytes = 1
                };
                break;
            case "byte-budget":
                limits = limits with
                {
                    MaximumBytes = 1
                };
                break;
        }
        if (data != original)
            bytes = ArticlePreservationRetainedOutboxArtifact.SerializeCandidate(data);
        var failure = Assert.Throws<InvalidOperationException>(() => ArticlePreservationRetainedOutboxArtifact.ParseCandidate(
            bytes, original.Binding, original.Issuer, [1], limits));
        Assert.DoesNotContain("private-payload-sentinel", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Original_Regular_File_Reader_Rejects_Wrong_Digest_Symlink_And_Size_Before_Candidate_Binding()
    {
        using var directory = new ArtifactDirectory();
        var data = Data(1);
        var reference = await directory.PublishAsync(data);
        var actual = await ReadAsync(reference, data);
        Assert.Equal(data.Batch.Events[0], actual.Data.Batch.Events[0]);
        await Assert.ThrowsAsync<InvalidOperationException>(() => ReadAsync(reference with { Sha256 = Digest('b') }, data));
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationRetainedOutboxArtifact.ReadCandidateAsync(
            reference, data.Binding, data.Issuer, [1], s_limits with
            {
                MaximumBytes = 1
            }, default));
        string link = Path.Combine(directory.Path, "link.json");
        File.CreateSymbolicLink(link, reference.Reference);
        await Assert.ThrowsAnyAsync<Exception>(() => ReadAsync(reference with { Reference = link }, data));
    }

    [Fact]
    public void Original_256_Fact_And_126_Inline_Event_Limits_Are_Preserved()
    {
        var inline = Stage(Data(126));
        Assert.Equal(252, ArticlePreservationStorageWriter.OutboxJournalFacts(inline).Length);
        Assert.Equal(256, ArticlePreservationStorageWriter.OutboxJournalFacts(inline).Length + 4);
        Assert.Empty(ArticlePreservationStorageWriter.OutboxJournalFacts(Stage(Data(0))));
        var large = Stage(Data(127));
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationStorageWriter.OutboxJournalFacts(large));
        Assert.Equal(2, ArticlePreservationStorageWriter.OutboxJournalFacts(large, Ref("retained-receipt")).Length);
        Assert.Throws<InvalidOperationException>(() => ArticlePreservationStorageWriter.OutboxJournalFacts(inline, Ref("retained-receipt")));
    }

    [Fact]
    public async Task Large_Receipt_Is_Immutable_Bounded_Exact_And_Never_A_Commit_Acknowledgement()
    {
        using var directory = new ArtifactDirectory();
        var data = Data(127);
        var issued = await ReadAsync(await directory.PublishAsync(data), data);
        var receipts = Stage(data).Outbox;
        var reference = await ArticlePreservationRetainedOutboxArtifact.PublishReceiptAsync(directory.Path, issued, receipts, s_limits, default);
        Assert.Equal(reference, await ArticlePreservationRetainedOutboxArtifact.PublishReceiptAsync(directory.Path, issued, receipts, s_limits, default));
        var actual = await ArticlePreservationRetainedOutboxArtifact.ReadReceiptAsync(reference, issued, receipts, s_limits, default);
        Assert.Equal(receipts.ToArray(), actual.Receipts.ToArray());
        Assert.Equal(issued.Artifact, actual.IssuedBatch);
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationRetainedOutboxArtifact.ReadReceiptAsync(
            reference, issued, receipts.SetItem(0, receipts[0] with
            {
                OutboxId = 10000
            }), s_limits, default));
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationRetainedOutboxArtifact.ReadReceiptAsync(
            reference, issued with
            {
                Artifact = Ref("foreign-issued")
            }, receipts, s_limits, default));
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationRetainedOutboxArtifact.ReadReceiptAsync(
            reference, issued with
            {
                Data = data with
                {
                    Binding = data.Binding with
                    {
                        InvocationId = "foreign"
                    }
                }
            }, receipts, s_limits, default));
        await File.AppendAllTextAsync(reference.Reference, " ");
        await Assert.ThrowsAsync<InvalidOperationException>(() => ArticlePreservationRetainedOutboxArtifact.ReadReceiptAsync(
            reference, issued, receipts, s_limits, default));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Real_PG_Large_Receipt_Uses_Actual_Native_IDs_And_Original_Journal_Atomicity(bool commit)
    {
        await using var fixture = await NativeFixture.CreateAsync();
        using var directory = new ArtifactDirectory();
        await using var connection = new NpgsqlConnection(fixture.ConnectionString);
        await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        var data = Data(127, fixture.Database);
        var issued = await ReadAsync(await directory.PublishAsync(data), data);
        var actual = await fixture.InsertEventsAsync(data, connection, transaction);
        var receipt = await ArticlePreservationRetainedOutboxArtifact.PublishReceiptAsync(directory.Path, issued, actual, s_limits, default);
        var chain = Chain(data, issued.Artifact, receipt);
        foreach (var entry in chain)
            await OfflineMigrationStateStore.AppendApplyJournalAsync(connection, transaction, entry, default);
        Assert.Equal(actual.ToArray(), (await ArticlePreservationRetainedOutboxArtifact.ReadReceiptAsync(receipt, issued, actual, s_limits, default)).Receipts.ToArray());
        if (commit)
            await transaction.CommitAsync();
        else
            await transaction.RollbackAsync();
        Assert.True(File.Exists(receipt.Reference)); // Artifact presence cannot claim commit.
        await using var check = new NpgsqlCommand($"SELECT (SELECT count(*) FROM native_retained_events), (SELECT count(*) FROM public.\"{OfflineMigrationStateStore.ApplyJournalTableName}\");", connection);
        await using var reader = await check.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        Assert.Equal(commit ? 127 : 0, reader.GetInt64(0));
        Assert.Equal(commit ? chain.Length : 0, reader.GetInt64(1));
    }

    [Theory]
    [InlineData("valid")]
    [InlineData("missing")]
    [InlineData("payload")]
    [InlineData("physical-parent")]
    [InlineData("oversized")]
    [InlineData("budget")]
    public async Task Real_PG_Recovery_Follows_Exact_Original_Verified_Parent_Chain_Through_Resume(string control)
    {
        await using var fixture = await NativeFixture.CreateAsync();
        await using var connection = new NpgsqlConnection(fixture.ConnectionString);
        await connection.OpenAsync();
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        var data = Data(1, fixture.Database);
        var issued = Ref("original-issued-batch");
        var chain = Chain(data, issued, Ref("original-receipt"));
        var verifier = new OfflineMigrationApplyJournalVerifier(Plan(fixture.Database), chain[0].Plan, data.Binding.InvocationId);
        foreach (var entry in chain)
        {
            verifier.Accept(entry);
            await OfflineMigrationStateStore.AppendApplyJournalAsync(connection, transaction, entry, default);
        }
        verifier.Complete(new(OfflineMigrationApplyJournalVerifier.Reference(chain[^1]), data.Binding.InvocationId, chain.Length));
        Assert.Null(ArticlePreservationRetainedOutboxArtifact.ReadRecordedReference(verifier.StepProofs.Single().Before!,
            ArticlePreservationRetainedOutboxArtifact.IssuedReferenceFact, ArticlePreservationRetainedOutboxArtifact.IssuedDigestFact));
        string? mutation = control switch
        {
            "missing" => $"DELETE FROM public.\"{OfflineMigrationStateStore.ApplyJournalTableName}\" WHERE sequence=2",
            "payload" => $"UPDATE public.\"{OfflineMigrationStateStore.ApplyJournalTableName}\" SET entry_payload='{{}}' WHERE sequence=2",
            "physical-parent" => $"UPDATE public.\"{OfflineMigrationStateStore.ApplyJournalTableName}\" SET parent_digest=repeat('b',64) WHERE sequence=2",
            "oversized" => $"UPDATE public.\"{OfflineMigrationStateStore.ApplyJournalTableName}\" SET entry_payload=repeat('x',1048577) WHERE sequence=2",
            _ => null
        };
        if (mutation is not null)
        {
            await using var tamper = new NpgsqlCommand(mutation, connection, transaction);
            await tamper.ExecuteNonQueryAsync();
        }
        Task<OfflineMigrationApplyJournalEntry> Read() => ArticlePreservationStorageWriter.ReadOriginalOutboxUnitAsync(
            verifier.StepProofs.Single(), "retained-contract", data.Binding.Operation, control == "budget" ? 1 : 4,
            connection, transaction, s_writeLimits, default);
        if (control != "valid")
            await Assert.ThrowsAsync<InvalidOperationException>(Read);
        else
        {
            var recovered = await Read();
            Assert.Equal(JsonSerializer.Serialize(chain[1]), JsonSerializer.Serialize(recovered));
            Assert.Equal(issued, ArticlePreservationRetainedOutboxArtifact.ReadRecordedReference(recovered.Before!,
                ArticlePreservationRetainedOutboxArtifact.IssuedReferenceFact, ArticlePreservationRetainedOutboxArtifact.IssuedDigestFact));
        }
        await transaction.RollbackAsync();
    }

    private static string Digest(char value = 'a') => new(value, 64);
    private static CurrentSchemaArtifactReference Ref(string name) => new("fixture://" + name, Digest());

    private static ArticlePreservationRetainedOutboxData Data(int count, CurrentSchemaDatabaseIdentity? database = null)
    {
        database ??= new(CurrentSchemaProviderKind.PostgreSql, "fixture-instance", "fixture-database");
        var plan = Plan(database);
        var binding = new ArticlePreservationOutboxArtifactBinding(Ref("plan"), plan.ContentDigest, Digest(),
            Ref("source-export"), Ref("current-export"), Digest(), plan.Tool, plan.OrderedSteps[0].Operations[0], "retained-contract", database);
        var issuer = new CurrentSchemaProducerIdentity(plan.Tool.SourceRevision, ArticlePreservationRetainedOutboxArtifact.CanonicalFactoryId, Digest(), Digest());
        // Deterministic TEST fixtures; production never derives event IDs or times.
        var batch = new ArticlePreservationOutboxBatch(binding.ArticlePlanDigest, Enumerable.Range(1, count).Select(id =>
            new ArticlePreservationOutboxEnvelope(id, id.ToString("x32", CultureInfo.InvariantCulture),
                "{\"fixtureExactPayload\":\"" + id.ToString(CultureInfo.InvariantCulture) + "\\n  \"}", s_occurred)).ToImmutableArray());
        return new(ArticlePreservationRetainedOutboxArtifact.Format, binding, issuer, batch);
    }

    private static ArticlePreservationRetainedOutboxData Parse(ArticlePreservationRetainedOutboxData data,
        ArticlePreservationRetainedOutboxData? expected = null)
    {
        expected ??= data;
        return ArticlePreservationRetainedOutboxArtifact.ParseCandidate(ArticlePreservationRetainedOutboxArtifact.SerializeCandidate(data),
            expected.Binding, expected.Issuer, expected.Batch.Events.Select(item => item.ArticleId).ToImmutableArray(), s_limits);
    }

    private static Task<ArticlePreservationRetainedOutboxCandidate> ReadAsync(CurrentSchemaArtifactReference reference, ArticlePreservationRetainedOutboxData data)
        => ArticlePreservationRetainedOutboxArtifact.ReadCandidateAsync(reference, data.Binding, data.Issuer,
            data.Batch.Events.Select(item => item.ArticleId).ToImmutableArray(), s_limits, default);

    private static ArticlePreservationStorageStage Stage(ArticlePreservationRetainedOutboxData data)
        => new(data.Binding.ArticlePlanDigest, data.Batch.Events.Length, false)
        {
            Outbox = data.Batch.Events.Select(item => new ArticlePreservationOutboxReceipt(item.ArticleId, item.ArticleId, item.EventId)).ToImmutableArray()
        };

    private static OfflineMigrationPlan Plan(CurrentSchemaDatabaseIdentity database)
    {
        string digest = Digest();
        DateTimeOffset recorded = new(s_occurred);
        var source = new OfflineMigrationSourceObservation(database, "fixture-extractor", "v1", [], [], [], digest);
        var artifact = Ref("backup");
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
        var step = new OfflineMigrationStep("retained-contract", "retained-before", "retained-after", [], "retained-idempotency", false,
            new("v1", 0, "no-watermark", "retained-replay"),
            Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationProviderOperation(
                provider, "retained-contract-owner", digest, digest, OfflineMigrationExecutionMode.Transaction)).ToImmutableArray());
        var registry = new OfflineMigrationSourceRegistry("v1", [new("fixture-profile", "v1", "fixture-owner", [step.StepId], step.StepId,
            Enum.GetValues<CurrentSchemaProviderKind>().Select(provider => new OfflineMigrationSourceShape(provider,
                source.ExtractorId, source.ExtractorVersion, [], [], [])).ToImmutableArray())]);
        return OfflineMigrationPlanBuilder.Create(source, backup, new("v1", "v1", "v1", digest, digest),
            new(new string('a', 40), digest, digest, digest), registry, new("fixture-dag", "v1", [step]), recorded, TimeSpan.FromHours(1));
    }

    private static ImmutableArray<OfflineMigrationApplyJournalEntry> Chain(ArticlePreservationRetainedOutboxData data,
        CurrentSchemaArtifactReference issued, CurrentSchemaArtifactReference receipt)
    {
        var plan = Plan(data.Binding.Database);
        var identity = data.Binding.Operation;
        var artifact = Ref("journal-plan") with
        {
            Sha256 = OfflineMigrationApplyJournalVerifier.ComputePlanArtifactDigest(plan)
        };
        OfflineMigrationPredicateObservation Observe(string predicate, ImmutableArray<OfflineMigrationFact> facts)
        {
            facts = facts.OrderBy(fact => fact.Name, StringComparer.Ordinal).ToImmutableArray();
            var value = new OfflineMigrationPredicateObservation(predicate, identity.OperationReference,
                identity.OperationSourceDigest, identity.SemanticDigest, facts, facts, "");
            return value with
            {
                ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeObservationDigest(value)
            };
        }
        var first = new OfflineMigrationApplyJournalEntry(OfflineMigrationApplyJournalVerifier.Format, artifact, plan.ContentDigest,
            data.Binding.Database, data.Binding.InvocationId, 1, 1, null, null, null, OfflineMigrationApplyJournalState.AttemptStarted,
            null, null, null, null, 0, 0, false, null, null, OfflineMigrationApplyJournalVerifier.GenesisDigest, "", null, new(s_occurred));
        first = Seal(first);
        var unit = Seal(first with
        {
            Sequence = 2,
            StepId = "retained-contract",
            OperationReference = identity.OperationReference,
            Mode = identity.Mode,
            State = OfflineMigrationApplyJournalState.TransactionCommitted,
            IdempotencyKey = "retained-idempotency",
            UnitComplete = true,
            Before = Observe("retained-before", ArticlePreservationRetainedOutboxArtifact.IssuedFacts(issued)),
            After = Observe("retained-after", ArticlePreservationRetainedOutboxArtifact.ReceiptFacts(receipt)),
            PreviousDigest = first.ContentDigest
        });
        var interrupted = Seal(first with
        {
            Sequence = 3,
            State = OfflineMigrationApplyJournalState.RecoveryRequired,
            FailureCode = "offline_apply_prior_attempt_interrupted",
            PreviousDigest = unit.ContentDigest
        });
        var resumed = Seal(first with
        {
            Sequence = 4,
            Attempt = 2,
            PreviousDigest = interrupted.ContentDigest
        });
        var verified = Seal(unit with
        {
            Sequence = 5,
            Attempt = 2,
            State = OfflineMigrationApplyJournalState.StepVerified,
            Before = unit.After,
            PreviousDigest = resumed.ContentDigest
        });
        return [first, unit, interrupted, resumed, verified];
    }

    private static OfflineMigrationApplyJournalEntry Seal(OfflineMigrationApplyJournalEntry value)
        => value with
        {
            ContentDigest = OfflineMigrationApplyJournalVerifier.ComputeEntryDigest(value)
        };

    private sealed class ArtifactDirectory : IDisposable
    {
        internal string Path { get; } = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "native-retained-" + Guid.NewGuid().ToString("N"));
        internal ArtifactDirectory() => Directory.CreateDirectory(Path);
        internal Task<CurrentSchemaArtifactReference> PublishAsync(ArticlePreservationRetainedOutboxData data)
            => OfflineMigrationArtifactPublisher.PublishAsync(System.IO.Path.Combine(Path, "issued.json"),
                ArticlePreservationRetainedOutboxArtifact.SerializeCandidate(data), default);
        public void Dispose() => Directory.Delete(Path, recursive: true);
    }

    private sealed class NativeFixture : IAsyncDisposable
    {
        private const string Admin = "Host=127.0.0.1;Port=5432;Username=fsusblog;Password=fsusblog_dev;Database=postgres;Pooling=false;SSL Mode=Disable";
        private readonly string _database = "native_source_contract_" + Guid.NewGuid().ToString("N");
        internal string ConnectionString => new NpgsqlConnectionStringBuilder(Admin) { Database = _database }.ConnectionString;
        internal CurrentSchemaDatabaseIdentity Database { get; private set; } = null!;
        internal static async Task<NativeFixture> CreateAsync()
        {
            var fixture = new NativeFixture();
            try
            {
                await using var admin = new NpgsqlConnection(Admin);
                await admin.OpenAsync();
                await using var create = new NpgsqlCommand($"CREATE DATABASE \"{fixture._database}\"", admin);
                await create.ExecuteNonQueryAsync();
                await using var connection = new NpgsqlConnection(fixture.ConnectionString);
                await connection.OpenAsync();
                await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
                await OfflineMigrationStateStore.EnsureApplyJournalAsync(connection, transaction, default);
                fixture.Database = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(connection, transaction, default);
                await using var table = new NpgsqlCommand("CREATE TABLE native_retained_events(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, article_id int NOT NULL, event_id text UNIQUE NOT NULL, payload text NOT NULL, occurred_at timestamptz NOT NULL)", connection, transaction);
                await table.ExecuteNonQueryAsync();
                await transaction.CommitAsync();
                return fixture;
            }
            catch
            {
                await fixture.DisposeAsync();
                throw;
            }
        }
        internal async Task<ImmutableArray<ArticlePreservationOutboxReceipt>> InsertEventsAsync(ArticlePreservationRetainedOutboxData data,
            NpgsqlConnection connection, NpgsqlTransaction transaction)
        {
            var receipts = ImmutableArray.CreateBuilder<ArticlePreservationOutboxReceipt>();
            foreach (var item in data.Batch.Events)
            {
                await using var insert = new NpgsqlCommand("INSERT INTO native_retained_events(article_id,event_id,payload,occurred_at) VALUES(@article,@event,@payload,@occurred) RETURNING id, event_id, payload, occurred_at", connection, transaction);
                insert.Parameters.AddWithValue("article", item.ArticleId);
                insert.Parameters.AddWithValue("event", item.EventId);
                insert.Parameters.AddWithValue("payload", item.PayloadJson);
                insert.Parameters.AddWithValue("occurred", item.OccurredAt);
                await using var reader = await insert.ExecuteReaderAsync();
                Assert.True(await reader.ReadAsync());
                Assert.Equal(item.EventId, reader.GetString(1));
                Assert.Equal(item.PayloadJson, reader.GetString(2));
                Assert.Equal(item.OccurredAt, reader.GetDateTime(3));
                receipts.Add(new(item.ArticleId, reader.GetInt64(0), reader.GetString(1)));
            }
            return receipts.ToImmutable();
        }
        public async ValueTask DisposeAsync()
        {
            await using var admin = new NpgsqlConnection(Admin);
            await admin.OpenAsync();
            await using var drop = new NpgsqlCommand($"DROP DATABASE IF EXISTS \"{_database}\" WITH (FORCE)", admin);
            await drop.ExecuteNonQueryAsync();
        }
    }
}
