using System.Security.Cryptography;
using System.Text;

using SqlSugar;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Contracts.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests;

public sealed class CurrentSchemaReceiptTests
{
    [Fact]
    public void ReceiptCodec_RequiresExplicitStatusEvenWhenTheDefaultWouldMatchItsSeal()
    {
        byte[] bytes = CurrentSchemaReceiptCodec.Serialize(CreateReceipt());
        CurrentSchemaReceipt valid = CurrentSchemaReceiptCodec.Deserialize(bytes);
        Assert.Equal(CurrentSchemaReceiptStatus.VerifiedCurrent, valid.Status);
        string original = Encoding.UTF8.GetString(bytes);
        const string Status = "\"status\":\"verified-current\",";
        Assert.Contains(Status, original, StringComparison.Ordinal);
        string missing = original.Replace(Status, string.Empty, StringComparison.Ordinal);
        Assert.Contains(valid.ContentDigest, missing, StringComparison.Ordinal);

        Assert.Throws<InvalidOperationException>(() => CurrentSchemaReceiptCodec.Deserialize(Encoding.UTF8.GetBytes(missing)));
    }

    [Theory]
    [InlineData("")]
    [InlineData("relative/receipt.json")]
    public async Task ReadOnlyAdmission_RequiresExplicitAbsoluteReceiptBeforeDatabaseAccess(string path)
    {
        await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchemaReceiptAdmission.VerifyAsync(
            path, new string('a', 64), new string('a', 40), null!, null!, CancellationToken.None));
    }

    [Fact]
    public async Task ReadOnlyAdmission_CancellationDoesNotAccessReceiptOrDatabase()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => CurrentSchemaReceiptAdmission.VerifyAsync(
            string.Empty, string.Empty, string.Empty, null!, null!, cancellation.Token));
    }

    [Fact]
    public void AdmissionState_HasNoDefaultSuccess()
    {
        Assert.Null(new CurrentSchemaAdmissionState().Current);
    }

    [Fact]
    public void CurrentOnlyAdmission_RejectsChangedOriginalArtifactBytes()
    {
        CurrentSchemaReceipt receipt = CreateReceipt();
        byte[] original = CurrentSchemaReceiptCodec.Serialize(receipt);
        string artifactDigest = Convert.ToHexStringLower(SHA256.HashData(original));
        var actual = new CurrentSchemaAdmissionObservation(receipt.Target, receipt.Database, receipt.ActualSchemaDigest);
        _ = CurrentSchemaReceiptAdmission.Validate(original, artifactDigest, actual);
        byte[] changed = [.. original, (byte)' '];

        Assert.Throws<InvalidOperationException>(() => CurrentSchemaReceiptAdmission.Validate(changed, artifactDigest, actual));
    }

    [Fact]
    public void CurrentOnlyAdmission_RejectsResealedRejectedReceipt()
    {
        CurrentSchemaReceipt valid = CreateReceipt();
        var actual = new CurrentSchemaAdmissionObservation(valid.Target, valid.Database, valid.ActualSchemaDigest);
        byte[] original = CurrentSchemaReceiptCodec.Serialize(valid);
        _ = CurrentSchemaReceiptAdmission.Validate(original, Convert.ToHexStringLower(SHA256.HashData(original)), actual);
        CurrentSchemaReceipt rejected = valid with
        {
            Status = CurrentSchemaReceiptStatus.Rejected,
            Reasons = ["semantic_postcondition_failed"]
        };
        rejected = rejected with { ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(rejected) };
        byte[] bytes = CurrentSchemaReceiptCodec.Serialize(rejected);

        Assert.Throws<InvalidOperationException>(() => CurrentSchemaReceiptAdmission.Validate(
            bytes, Convert.ToHexStringLower(SHA256.HashData(bytes)), actual));
    }

    [Theory]
    [InlineData("target-source")]
    [InlineData("target-content")]
    [InlineData("instance")]
    [InlineData("database")]
    [InlineData("provider")]
    [InlineData("actual-schema")]
    [InlineData("artifact")]
    public void CurrentOnlyAdmission_RequiresExactFreshIdentityAndArtifact(string invalid)
    {
        CurrentSchemaReceipt receipt = CreateReceipt();
        byte[] bytes = CurrentSchemaReceiptCodec.Serialize(receipt);
        string artifactDigest = Convert.ToHexStringLower(SHA256.HashData(bytes));
        var actual = new CurrentSchemaAdmissionObservation(receipt.Target, receipt.Database, receipt.ActualSchemaDigest);
        Assert.Equal(receipt.ContentDigest, CurrentSchemaReceiptAdmission.Validate(bytes, artifactDigest, actual).ContentDigest);
        string different = new('b', 64);
        switch (invalid)
        {
            case "target-source":
                actual = actual with { Target = actual.Target with { SourceDigest = different } };
                break;
            case "target-content":
                actual = actual with { Target = actual.Target with { ContentDigest = different } };
                break;
            case "instance":
                actual = actual with { Database = actual.Database with { InstanceId = "other-instance" } };
                break;
            case "database":
                actual = actual with { Database = actual.Database with { DatabaseId = "other-database" } };
                break;
            case "provider":
                actual = actual with { Database = actual.Database with { Provider = CurrentSchemaProviderKind.MySql } };
                break;
            case "actual-schema":
                actual = actual with { ActualSchemaDigest = different };
                break;
            case "artifact":
                artifactDigest = different;
                break;
            default:
                throw new InvalidOperationException("Unknown admission mismatch.");
        }

        Assert.Throws<InvalidOperationException>(() => CurrentSchemaReceiptAdmission.Validate(bytes, artifactDigest, actual));
    }

    [Fact]
    public void ReceiptCodec_CanonicalRoundtripPreservesExactProofBytes()
    {
        CurrentSchemaReceipt receipt = CreateReceipt();
        byte[] bytes = CurrentSchemaReceiptCodec.Serialize(receipt);

        CurrentSchemaReceipt decoded = CurrentSchemaReceiptCodec.Deserialize(bytes);

        Assert.Equal(receipt.ContentDigest, decoded.ContentDigest);
        Assert.Equal(bytes, CurrentSchemaReceiptCodec.Serialize(decoded));
        Assert.Equal(receipt.Target, decoded.Target);
        Assert.Equal(receipt.Database, decoded.Database);
    }

    [Theory]
    [InlineData("unknown-provider")]
    [InlineData("duplicate-checkpoint")]
    [InlineData("latest-reference")]
    [InlineData("unobserved-postcondition")]
    [InlineData("success-with-warning")]
    public void ReceiptCodec_ResealedInvalidShapeIsRejected(string invalid)
    {
        CurrentSchemaReceipt valid = CreateReceipt();
        _ = CurrentSchemaReceiptCodec.Deserialize(CurrentSchemaReceiptCodec.Serialize(valid));
        CurrentSchemaReceipt mutated = invalid switch
        {
            "unknown-provider" => valid with
            {
                Database = valid.Database with { Provider = (CurrentSchemaProviderKind)999 }
            },
            "duplicate-checkpoint" => valid with
            {
                Checkpoints = [valid.Checkpoints[0], valid.Checkpoints[0]]
            },
            "latest-reference" => valid with
            {
                Plan = valid.Plan with { Reference = "offline-plan/latest" }
            },
            "unobserved-postcondition" => valid with
            {
                SemanticPostconditions =
                [
                    valid.SemanticPostconditions[0] with
                    {
                        ActualDigest = string.Empty
                    }
                ]
            },
            "success-with-warning" => valid with { Reasons = ["warning"] },
            _ => throw new InvalidOperationException("Unknown receipt mutation.")
        };
        mutated = mutated with { ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(mutated) };

        Assert.Throws<InvalidOperationException>(() => CurrentSchemaReceiptCodec.Serialize(mutated));
    }

    [Theory]
    [InlineData("unknown-field")]
    [InlineData("duplicate-member")]
    [InlineData("warning-status")]
    public void ReceiptCodec_ClosedJsonRejectsUnknownOrDuplicateMembers(string invalid)
    {
        byte[] canonical = CurrentSchemaReceiptCodec.Serialize(CreateReceipt());
        _ = CurrentSchemaReceiptCodec.Deserialize(canonical);
        string json = Encoding.UTF8.GetString(canonical);
        string changed = invalid switch
        {
            "unknown-field" => "{\"unknown\":true," + json[1..],
            "duplicate-member" => "{\"format\":\"" + CurrentSchemaReceiptCodec.Format + "\"," + json[1..],
            "warning-status" => json.Replace("\"verified-current\"", "\"warning\"", StringComparison.Ordinal),
            _ => throw new InvalidOperationException("Unknown JSON mutation.")
        };

        Assert.Throws<InvalidOperationException>(() => CurrentSchemaReceiptCodec.Deserialize(Encoding.UTF8.GetBytes(changed)));
    }

    [Fact]
    public async Task ReadObserver_ValidSchemaReturnsCanonicalAndActualIdentities()
    {
        var inspector = new ReceiptSchemaInspector();
        var observer = new CurrentSchemaReadObserver(null!, inspector);

        CurrentSchemaReadObservation observation = await observer.ReadAsync(CancellationToken.None);

        Assert.Equal(inspector.Canonical.Identity, observation.CanonicalIdentity);
        Assert.Equal(
            CurrentSchemaCanonicalAuthority.ComputeObservationDigest(inspector.Actual.Tables),
            observation.ActualDigest);
        Assert.Same(inspector.Actual, observation.ActualSchema);
        Assert.Equal(1, inspector.ReadCount);
    }

    [Theory]
    [InlineData("missing-column")]
    [InlineData("extra-column")]
    [InlineData("extra-table")]
    [InlineData("wrong-provider")]
    public async Task ReadObserver_ActualSchemaDriftFailsClosed(string drift)
    {
        var inspector = new ReceiptSchemaInspector();
        var observer = new CurrentSchemaReadObserver(null!, inspector);
        _ = await observer.ReadAsync(CancellationToken.None);
        var tables = inspector.Actual.Tables.ToDictionary(
            static table => table.Key,
            static table => new SchemaTableModel(
                table.Value.Name,
                new Dictionary<string, SchemaColumnModel>(table.Value.Columns, StringComparer.Ordinal),
                table.Value.Indexes,
                table.Value.IndexDefinitions,
                table.Value.Constraints,
                table.Value.Owner),
            StringComparer.Ordinal);
        SchemaProviderKind provider = SchemaProviderKind.PostgreSql;
        switch (drift)
        {
            case "missing-column":
                tables["receipt_schema_entity"].Columns.Remove("id");
                break;
            case "extra-column":
                tables["receipt_schema_entity"].Columns.Add(
                    "unknown",
                    tables["receipt_schema_entity"].Columns["id"] with { Name = "unknown" });
                break;
            case "extra-table":
                tables.Add("unknown", new SchemaTableModel("unknown", [], []));
                break;
            case "wrong-provider":
                provider = SchemaProviderKind.MySql;
                break;
            default:
                throw new InvalidOperationException("Unknown test drift.");
        }
        inspector.Actual = new SchemaModelSnapshot(tables, provider: provider);

        CurrentSchemaMismatchException exception = await Assert.ThrowsAsync<CurrentSchemaMismatchException>(
            () => observer.ReadAsync(CancellationToken.None));

        Assert.Equal("fsusblog.current-schema.mismatch", exception.MismatchRef);
        Assert.NotEmpty(exception.Errors);
        Assert.Equal(inspector.Canonical.Identity.ContentDigest, exception.ExpectedDigest);
    }

    [Fact]
    public async Task ReadObserver_UnreadableSchemaDoesNotBecomeAnObservation()
    {
        var inspector = new ReceiptSchemaInspector { ReadFailure = new InvalidOperationException("unavailable") };
        var observer = new CurrentSchemaReadObserver(null!, inspector);

        CurrentSchemaMismatchException exception = await Assert.ThrowsAsync<CurrentSchemaMismatchException>(
            () => observer.ReadAsync(CancellationToken.None));

        Assert.Equal("fsusblog.current-schema.mismatch.unreadable", exception.MismatchRef);
        Assert.Equal("unavailable", exception.ActualDigest);
    }

    [Fact]
    public async Task ReadObserver_CancellationBeforeReadDoesNotRead()
    {
        var inspector = new ReceiptSchemaInspector();
        var observer = new CurrentSchemaReadObserver(null!, inspector);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => observer.ReadAsync(cancellation.Token));

        Assert.Equal(0, inspector.ReadCount);
    }

    [Fact]
    public async Task ReadObserver_CancellationDuringReadDoesNotPublishObservation()
    {
        var inspector = new ReceiptSchemaInspector();
        var observer = new CurrentSchemaReadObserver(null!, inspector);
        using var cancellation = new CancellationTokenSource();
        inspector.OnRead = cancellation.Cancel;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => observer.ReadAsync(cancellation.Token));

        Assert.Equal(1, inspector.ReadCount);
    }

    private static CurrentSchemaReceipt CreateReceipt()
    {
        string digest = new('a', 64);
        var target = new CurrentSchemaTargetIdentity("model.v1", "extractor.v1", "generator.v1", digest, digest);
        var database = new CurrentSchemaDatabaseIdentity(CurrentSchemaProviderKind.PostgreSql, "instance-1", "database-1");
        var receipt = new CurrentSchemaReceipt(
            CurrentSchemaReceiptCodec.Format,
            CurrentSchemaReceiptStatus.VerifiedCurrent,
            target,
            "empty.v1",
            "fingerprint.v1",
            digest,
            digest,
            new("offline-plan/v1/plan", digest),
            new("offline-apply/v1/apply", digest),
            [new("offline-checkpoint/v1/checkpoint", digest)],
            database,
            digest,
            [new("bootstrap", "predicate/current/v1", digest, digest, digest)],
            new("backup/package", digest),
            new("backup/manifest", digest),
            new("backup/restore-drill", digest),
            [],
            new(new string('b', 40), digest, digest, digest),
            [],
            string.Empty);
        return receipt with { ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(receipt) };
    }

    [SugarTable("receipt_schema_entity")]
    private sealed class ReceiptSchemaEntity
    {
        [SugarColumn(IsPrimaryKey = true)]
        public int Id { get; set; }
    }

    private sealed class ReceiptSchemaInspector : ISchemaModelInspector
    {
        public ReceiptSchemaInspector()
        {
            Canonical = CurrentSchemaEntityExtractor.Extract([typeof(ReceiptSchemaEntity)]);
            SchemaModelSnapshot current = CurrentSchemaCanonicalAuthority.ProjectProvider(
                Canonical,
                SchemaProviderKind.PostgreSql);
            var tables = current.Tables.ToDictionary(static table => table.Key, static table => table.Value);
            foreach (string required in CurrentSchemaRuntimeRollupTables.TableNames)
            {
                tables.TryAdd(required, new SchemaTableModel(required, [], []));
            }
            Actual = new SchemaModelSnapshot(tables, provider: SchemaProviderKind.PostgreSql);
        }

        public CurrentSchemaCanonicalModel Canonical { get; }
        public SchemaModelSnapshot Actual { get; set; }
        public Exception? ReadFailure { get; init; }
        public Action? OnRead { get; set; }
        public int ReadCount { get; private set; }

        public IReadOnlyList<Type> GetManagedEntityTypes() => [typeof(ReceiptSchemaEntity)];

        public CurrentSchemaCanonicalModel BuildCanonicalModel(IReadOnlyList<Type> entityTypes) => Canonical;

        public SchemaModelSnapshot BuildExpectedModel(IReadOnlyList<Type> entityTypes)
            => CurrentSchemaCanonicalAuthority.ProjectProvider(Canonical, SchemaProviderKind.PostgreSql);

        public Task<SchemaModelSnapshot> ReadActualModelAsync(ISqlSugarClient db, CancellationToken cancellationToken)
        {
            ReadCount++;
            OnRead?.Invoke();
            return ReadFailure is null
                ? Task.FromResult(Actual)
                : Task.FromException<SchemaModelSnapshot>(ReadFailure);
        }

        public Task ValidateAsync(
            ISqlSugarClient db,
            IReadOnlyList<Type> entityTypes,
            IReadOnlyCollection<string> allowedExtraTables,
            CancellationToken cancellationToken)
            => throw new InvalidOperationException("Observer must not enter the legacy validation path.");
    }
}
