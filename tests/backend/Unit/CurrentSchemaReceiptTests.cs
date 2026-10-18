using System.Security.Cryptography;
using System.Text;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;
using FsusBlog.Contracts.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Shared.Algorithms.Schema;

using SqlSugar;

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
        rejected = rejected with
        {
            ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(rejected)
        };
        byte[] bytes = CurrentSchemaReceiptCodec.Serialize(rejected);

        Assert.Throws<InvalidOperationException>(() => CurrentSchemaReceiptAdmission.Validate(
            bytes, Convert.ToHexStringLower(SHA256.HashData(bytes)), actual));
    }

    [Fact]
    public void CurrentOnlyAdmission_ControlTargetV3RejectsPreviouslyValidV2ReceiptWithoutRewritingIt()
    {
        CurrentSchemaReceipt old = CreateReceipt() with
        {
            Target = CreateReceipt().Target with
            {
                ModelVersion = "fsusblog.current-schema.v2",
                ExtractorVersion = "fsusblog.current-schema-reflection.v2",
                GeneratorVersion = "fsusblog.current-schema-projection.v2"
            }
        };
        old = old with
        {
            ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(old)
        };
        byte[] original = CurrentSchemaReceiptCodec.Serialize(old);
        string originalDigest = Convert.ToHexStringLower(SHA256.HashData(original));
        var oldObservation = new CurrentSchemaAdmissionObservation(old.Target, old.Database, old.ActualSchemaDigest);
        Assert.Equal(old.ContentDigest, CurrentSchemaReceiptAdmission.Validate(original, originalDigest, oldObservation).ContentDigest);
        var inspector = new ReceiptSchemaInspector();
        CurrentSchemaIdentity target = inspector.CompleteIdentity;
        var currentObservation = oldObservation with
        {
            Target = new(target.ModelVersion, target.ExtractorVersion, target.GeneratorVersion, target.SourceDigest, target.ContentDigest)
        };
        Assert.Equal("fsusblog.current-schema.v3", target.ModelVersion);
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaReceiptAdmission.Validate(original, originalDigest, currentObservation));
        Assert.Equal(originalDigest, Convert.ToHexStringLower(SHA256.HashData(original)));
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
                actual = actual with
                {
                    Target = actual.Target with
                    {
                        SourceDigest = different
                    }
                };
                break;
            case "target-content":
                actual = actual with
                {
                    Target = actual.Target with
                    {
                        ContentDigest = different
                    }
                };
                break;
            case "instance":
                actual = actual with
                {
                    Database = actual.Database with
                    {
                        InstanceId = "other-instance"
                    }
                };
                break;
            case "database":
                actual = actual with
                {
                    Database = actual.Database with
                    {
                        DatabaseId = "other-database"
                    }
                };
                break;
            case "provider":
                actual = actual with
                {
                    Database = actual.Database with
                    {
                        Provider = CurrentSchemaProviderKind.MySql
                    }
                };
                break;
            case "actual-schema":
                actual = actual with
                {
                    ActualSchemaDigest = different
                };
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
                Database = valid.Database with
                {
                    Provider = (CurrentSchemaProviderKind)999
                }
            },
            "duplicate-checkpoint" => valid with
            {
                Checkpoints = [valid.Checkpoints[0], valid.Checkpoints[0]]
            },
            "latest-reference" => valid with
            {
                Plan = valid.Plan with
                {
                    Reference = "offline-plan/latest"
                }
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
        mutated = mutated with
        {
            ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(mutated)
        };

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
        var observer = new CurrentSchemaReadObserver(inspector, inspector.ReadNativeAsync);

        CurrentSchemaReadObservation observation = await observer.ReadAsync(CancellationToken.None);

        Assert.Equal(inspector.CompleteIdentity, observation.CanonicalIdentity);
        Assert.NotEqual(inspector.Canonical.Identity, observation.CanonicalIdentity);
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
        var observer = new CurrentSchemaReadObserver(inspector, inspector.ReadNativeAsync);
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
                    tables["receipt_schema_entity"].Columns["id"] with
                    {
                        Name = "unknown"
                    });
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
        Assert.Equal(inspector.CompleteIdentity.ContentDigest, exception.ExpectedDigest);
    }

    [Fact]
    public async Task ReadObserver_UnreadableSchemaDoesNotBecomeAnObservation()
    {
        var inspector = new ReceiptSchemaInspector { ReadFailure = new InvalidOperationException("unavailable") };
        var observer = new CurrentSchemaReadObserver(inspector, inspector.ReadNativeAsync);

        CurrentSchemaMismatchException exception = await Assert.ThrowsAsync<CurrentSchemaMismatchException>(
            () => observer.ReadAsync(CancellationToken.None));

        Assert.Equal("fsusblog.current-schema.mismatch.unreadable", exception.MismatchRef);
        Assert.Equal("unavailable", exception.ActualDigest);
    }

    [Fact]
    public async Task ReadObserver_CancellationBeforeReadDoesNotRead()
    {
        var inspector = new ReceiptSchemaInspector();
        var observer = new CurrentSchemaReadObserver(inspector, inspector.ReadNativeAsync);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => observer.ReadAsync(cancellation.Token));

        Assert.Equal(0, inspector.ReadCount);
    }

    [Fact]
    public async Task ReadObserver_CancellationDuringReadDoesNotPublishObservation()
    {
        var inspector = new ReceiptSchemaInspector();
        var observer = new CurrentSchemaReadObserver(inspector, inspector.ReadNativeAsync);
        using var cancellation = new CancellationTokenSource();
        inspector.OnRead = cancellation.Cancel;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => observer.ReadAsync(cancellation.Token));

        Assert.Equal(1, inspector.ReadCount);
    }

    [Theory]
    [InlineData("missing-recipe-table")]
    [InlineData("missing-recipe-column")]
    [InlineData("unknown-control-table")]
    [InlineData("default")]
    [InlineData("check")]
    [InlineData("predicate")]
    [InlineData("sequence")]
    [InlineData("function")]
    [InlineData("trigger")]
    [InlineData("duplicate-effect")]
    [InlineData("string-context")]
    public async Task ReadObserver_CompleteOriginalRecipeEffectsRejectDriftAfterPositiveControl(string drift)
    {
        var inspector = new ReceiptSchemaInspector();
        var observer = new CurrentSchemaReadObserver(inspector, inspector.ReadNativeAsync);
        CurrentSchemaReadObservation valid = await observer.ReadAsync(CancellationToken.None);
        Assert.Equal(inspector.CompleteIdentity, valid.CanonicalIdentity);
        PgCurrentSchemaEffectObservation original = inspector.Effects;
        string recipe = CurrentSchemaRuntimeRollupTables.TableNames.First();
        var tables = inspector.Actual.Tables.ToDictionary(static entry => entry.Key, static entry => entry.Value,
            StringComparer.Ordinal);
        switch (drift)
        {
            case "missing-recipe-table":
                tables.Remove(recipe);
                break;
            case "missing-recipe-column":
                SchemaTableModel table = tables[recipe];
                var columns = new Dictionary<string, SchemaColumnModel>(table.Columns, StringComparer.Ordinal);
                columns.Remove(columns.Keys.First());
                tables[recipe] = new SchemaTableModel(table.Name, columns, table.Indexes,
                    table.IndexDefinitions, table.Constraints, table.Owner);
                break;
            case "unknown-control-table":
                tables.Add("__fsus_schema_unknown_control", new SchemaTableModel("__fsus_schema_unknown_control", [], []));
                break;
            case "default":
            case "check":
            case "predicate":
                string kind = drift == "predicate" ? "index-predicate" : drift;
                PgCurrentRawExpression expression = original.Expressions.First(value => value.Kind == kind);
                inspector.Effects = original with
                {
                    Expressions = original.Expressions.Select(value =>
                    value == expression ? value with
                    {
                        Expression = drift == "default" ? "987654321" : "TRUE"
                    } : value).ToArray()
                };
                break;
            case "sequence":
                inspector.Effects = original with
                {
                    Sequences = [original.Sequences[0] with { Increment = 2 }, .. original.Sequences.Skip(1)]
                };
                break;
            case "function":
                inspector.Effects = original with
                {
                    Functions = [original.Functions[0] with { SecurityDefiner = true }, .. original.Functions.Skip(1)]
                };
                break;
            case "trigger":
                inspector.Effects = original with
                {
                    Triggers = [original.Triggers[0] with { Enabled = "D" }, .. original.Triggers.Skip(1)]
                };
                break;
            case "duplicate-effect":
                inspector.Effects = original with
                {
                    Functions = [.. original.Functions, original.Functions[0]]
                };
                break;
            case "string-context":
                inspector.Effects = original with
                {
                    StandardConformingStrings = false
                };
                break;
            default:
                throw new InvalidOperationException("Unknown complete native drift.");
        }
        inspector.Actual = new SchemaModelSnapshot(tables, provider: SchemaProviderKind.PostgreSql);

        CurrentSchemaMismatchException rejected = await Assert.ThrowsAsync<CurrentSchemaMismatchException>(
            () => observer.ReadAsync(CancellationToken.None));

        Assert.NotEmpty(rejected.Errors);
        Assert.Equal(inspector.CompleteIdentity.ContentDigest, rejected.ExpectedDigest);
    }

    [Fact]
    public async Task ReadObserver_UnitNativeFactsCannotBecomeDatabaseAdmission()
    {
        var inspector = new ReceiptSchemaInspector();
        var observer = new CurrentSchemaReadObserver(inspector, inspector.ReadNativeAsync);
        _ = await observer.ReadAsync(CancellationToken.None);

        InvalidOperationException rejected = await Assert.ThrowsAsync<InvalidOperationException>(
            () => observer.ReadAdmissionAsync(CancellationToken.None));

        Assert.Equal("current_schema_native_admission_requires_actual_database", rejected.Message);
        Assert.Equal(1, inspector.ReadCount);
    }

    private static PgCurrentSchemaEffectObservation CreateEffects(CurrentSchemaCompletePhysicalProjection complete)
    {
        var expressions = new List<PgCurrentRawExpression>();
        foreach (SchemaTableModel table in complete.Tables.Tables.Values)
        {
            foreach (SchemaColumnModel column in table.Columns.Values)
            {
                if (column.GenerationKind == "owned-sequence-default")
                {
                    SchemaOwnedSequenceModel sequence = column.OwnedSequence!;
                    expressions.Add(new("default", table.Name, column.Name,
                        $"nextval('{sequence.Schema}.{sequence.Name}'::regclass)", [], [$"{sequence.Schema}.{sequence.Name}"]));
                }
                else if (!column.IsIdentity && column.DefaultValue is string value)
                {
                    string raw = column.DataType == "string" && !value.StartsWith('\'')
                        && !value.Equals("NULL", StringComparison.OrdinalIgnoreCase)
                        ? "'" + value.Replace("'", "''", StringComparison.Ordinal) + "'::text" : value;
                    expressions.Add(new("default", table.Name, column.Name, raw, [], []));
                }
            }
            foreach (SchemaConstraintModel constraint in table.Constraints.Values.Where(static value => value.Kind == "check"))
            {
                SchemaExpressionNode node = PgCurrentSchemaExpressionParser.Parse(constraint.Expression!, table.Columns);
                expressions.Add(new("check", table.Name, constraint.Name, constraint.Expression!,
                    BoundColumns(node).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray(), []));
            }
            foreach (SchemaIndexModel index in table.IndexDefinitions.Values.Where(static value => value.Predicate is not null))
            {
                expressions.Add(new("index-predicate", table.Name, index.Name, index.Predicate!, [], []));
            }
        }
        var sequences = new List<PgCurrentSequence>();
        var functions = new List<PgCurrentFunction>();
        var triggers = new Dictionary<string, PgCurrentTrigger>(StringComparer.Ordinal);
        foreach (CurrentSchemaRecipeOperation operation in complete.SchemaEffects)
        {
            switch (operation.Kind)
            {
                case CurrentSchemaRecipeOperationKind.CreateSequence:
                    sequences.Add(new(operation.Name, "bigint", 1, 1, 1, long.MaxValue, 1, false));
                    break;
                case CurrentSchemaRecipeOperationKind.DefineImmutableGuard:
                    functions.Add(new(operation.Name, "plpgsql", "trigger", 0,
                        $"BEGIN RAISE EXCEPTION '{operation.ErrorCode}'; END;", "v", false, false, "u", false, null));
                    break;
                case CurrentSchemaRecipeOperationKind.RemoveTrigger:
                    triggers.Remove(operation.Table + "." + operation.Name);
                    break;
                case CurrentSchemaRecipeOperationKind.CreateImmutableTrigger:
                    triggers.Add(operation.Table + "." + operation.Name,
                        new(operation.Table!, operation.Name, operation.Function!, 27, "O", null, 0, "", false, false, false, null, null));
                    break;
                default:
                    throw new InvalidOperationException("Unknown current fixture effect.");
            }
        }
        return new(true, expressions, sequences, functions, triggers.Values.ToArray());

        static IEnumerable<string> BoundColumns(SchemaExpressionNode node)
            => (node.Kind == "column" ? new[] { node.Value } : Array.Empty<string>())
                .Concat(node.Arguments.SelectMany(BoundColumns));
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
        return receipt with
        {
            ContentDigest = CurrentSchemaReceiptCodec.ComputeContentDigest(receipt)
        };
    }

    [SugarTable("receipt_schema_entity")]
    private sealed class ReceiptSchemaEntity
    {
        [SugarColumn(IsPrimaryKey = true)]
        public int Id
        {
            get; set;
        }
    }

    private sealed class ReceiptSchemaInspector : ISchemaModelInspector
    {
        public ReceiptSchemaInspector()
        {
            Canonical = CurrentSchemaEntityExtractor.Extract([typeof(ReceiptSchemaEntity)]);
            CurrentSchemaProjection entity = CurrentSchemaCanonicalAuthority.Generate(Canonical);
            IReadOnlyList<CurrentSchemaRequiredRecipeReference> recipes = CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes();
            CompleteIdentity = CurrentSchemaOwnedTargetProjection.Observe(entity, recipes);
            CurrentSchemaCompletePhysicalProjection complete = CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(
                entity, recipes, SchemaProviderKind.PostgreSql);
            Actual = complete.Tables;
            Effects = CreateEffects(complete);
        }

        public CurrentSchemaCanonicalModel Canonical
        {
            get;
        }
        public CurrentSchemaIdentity CompleteIdentity
        {
            get;
        }
        public SchemaModelSnapshot Actual
        {
            get; set;
        }
        public PgCurrentSchemaEffectObservation Effects
        {
            get; set;
        }
        public Exception? ReadFailure
        {
            get; init;
        }
        public Action? OnRead
        {
            get; set;
        }
        public int ReadCount
        {
            get; private set;
        }

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

        public Task<PgCurrentSchemaNativeObservation> ReadNativeAsync(CancellationToken cancellationToken)
        {
            ReadCount++;
            OnRead?.Invoke();
            return ReadFailure is null
                ? Task.FromResult(new PgCurrentSchemaNativeObservation(Actual, Effects))
                : Task.FromException<PgCurrentSchemaNativeObservation>(ReadFailure);
        }

        public Task ValidateAsync(
            ISqlSugarClient db,
            IReadOnlyList<Type> entityTypes,
            IReadOnlyCollection<string> allowedExtraTables,
            CancellationToken cancellationToken)
            => throw new InvalidOperationException("Observer must not enter the legacy validation path.");
    }
}
