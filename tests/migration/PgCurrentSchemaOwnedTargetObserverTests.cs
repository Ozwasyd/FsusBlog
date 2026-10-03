using System.Text.Json;

using FsusBlog.Contracts.Schema;
using FsusBlog.Shared.Algorithms.Schema;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class PgCurrentSchemaOwnedTargetObserverTests
{
    [Fact]
    public void CompleteRawExpressions_NormalizeOriginalCastAndBoundCheckDependencies()
    {
        CurrentSchemaCompletePhysicalProjection expected = Expected();
        PgCurrentSchemaEffectObservation effects = Effects("'1'::bigint", "revision BETWEEN 1 AND 10", ["revision"]);
        Assert.Empty(PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables, effects));
    }

    [Theory]
    [InlineData("default")]
    [InlineData("check")]
    public void SameCountRawExpressionDrift_IsNotHiddenByTheOldDecodedSnapshot(string mutation)
    {
        CurrentSchemaCompletePhysicalProjection expected = Expected();
        PgCurrentSchemaEffectObservation original = Effects("'1'::bigint", "revision BETWEEN 1 AND 10", ["revision"]);
        PgCurrentSchemaEffectObservation changed = Effects(mutation == "default" ? "'2'::bigint" : "'1'::bigint",
            mutation == "check" ? "revision BETWEEN 1 AND 11" : "revision BETWEEN 1 AND 10", ["revision"]);
        Assert.Empty(PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables, original));
        Assert.Equal(original.Expressions.Count, changed.Expressions.Count);
        // Deliberately retain the same old decoded snapshot in both calls: the
        // production predicate must read the complete raw observations instead.
        Assert.NotEmpty(PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables, changed));
    }

    [Fact]
    public void MissingRawAndChangedDependencies_RefuseInsteadOfDroppingDefaultOrCheckFacts()
    {
        CurrentSchemaCompletePhysicalProjection expected = Expected();
        PgCurrentSchemaEffectObservation original = Effects("1", "revision BETWEEN 1 AND 10", ["revision"]);
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables,
            original with { Expressions = original.Expressions.Where(static value => value.Kind != "default").ToArray() }));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables,
            Effects("1", "revision BETWEEN 1 AND 10", [])));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, expected.Tables,
            original with { StandardConformingStrings = false }));
    }

    [Fact]
    public void OwnedSequenceDefault_MustUseTheActualCompleteDependencyAndUnmodifiedNextval()
    {
        var sequence = new SchemaOwnedSequenceModel("public", "probe_revision_seq", "probe", "revision", "bigint", 1, 1, 1, long.MaxValue, 1, false);
        SchemaColumnModel column = new("revision", false, false, true, null, "int64", Conversion: "none", PhysicalType: "bigint",
            GenerationKind: "owned-sequence-default", OwnedSequence: sequence);
        var table = new SchemaTableModel("probe", new Dictionary<string, SchemaColumnModel> { [column.Name] = column }, []);
        var snapshot = new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel> { [table.Name] = table }, provider: SchemaProviderKind.PostgreSql);
        var expected = new CurrentSchemaCompletePhysicalProjection(snapshot, [], []);
        PgCurrentSchemaEffectObservation original = new(true,
            [new("default", "probe", "revision", "nextval('public.probe_revision_seq'::regclass)", [], ["public.probe_revision_seq"])], [], [], []);
        Assert.Empty(PgCurrentSchemaOwnedTargetObserver.Compare(expected, snapshot, original));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, snapshot,
            original with { Expressions = [original.Expressions[0] with { SequenceReferences = ["foreign.probe_revision_seq"] }] }));
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaOwnedTargetObserver.Compare(expected, snapshot,
            original with { Expressions = [original.Expressions[0] with { Expression = "nextval('public.probe_revision_seq'::regclass) + 1" }] }));
    }

    [Theory]
    [InlineData("missing-column")]
    [InlineData("extra-column")]
    [InlineData("type")]
    [InlineData("length")]
    [InlineData("nullable")]
    [InlineData("primary-key")]
    [InlineData("identity")]
    [InlineData("owned-sequence")]
    [InlineData("collation")]
    [InlineData("default")]
    [InlineData("default-null")]
    [InlineData("computed")]
    [InlineData("index-direction")]
    [InlineData("primary-index-direction")]
    [InlineData("index-opclass")]
    [InlineData("index-collation")]
    [InlineData("index-include")]
    [InlineData("index-null-distinct")]
    [InlineData("missing-constraint")]
    [InlineData("missing-constraint-same-index")]
    [InlineData("constraint-deferred")]
    [InlineData("constraint-unvalidated")]
    [InlineData("check")]
    [InlineData("trigger")]
    public void CurrentControlShape_RejectsNativeFactDriftAfterCompletePositiveControl(string drift)
    {
        SchemaTableModel control = CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.PostgreSql);
        PgCurrentSchemaEffectObservation effects = ControlEffects(control);
        var actual = new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel> { [control.Name] = control },
            provider: SchemaProviderKind.PostgreSql);
        Assert.Empty(PgCurrentSchemaControlShape.CompareApplyJournal(actual, effects));
        Assert.Equal(7, control.Columns.Count);
        Assert.Equal(4, control.Constraints.Count);
        Assert.Equal(3, control.IndexDefinitions.Count); // Includes the native primary backing index.

        var columns = new Dictionary<string, SchemaColumnModel>(control.Columns, StringComparer.Ordinal);
        var indexes = new Dictionary<string, SchemaIndexModel>(control.IndexDefinitions, StringComparer.Ordinal);
        var constraints = new Dictionary<string, SchemaConstraintModel>(control.Constraints, StringComparer.Ordinal);
        SchemaColumnModel payload = columns["entry_payload"];
        SchemaIndexModel index = indexes[control.Name + "_entry_digest_key"];
        SchemaConstraintModel check = constraints[control.Name + "_sequence_check"];
        switch (drift)
        {
            case "missing-column": columns.Remove("entry_payload"); break;
            case "extra-column": columns.Add("unexpected", payload with { Name = "unexpected" }); break;
            case "type": columns["entry_payload"] = payload with { DataType = "int64", PhysicalType = "bigint" }; break;
            case "length": columns["plan_digest"] = columns["plan_digest"] with { MaxLength = 65 }; break;
            case "nullable": columns["entry_payload"] = payload with { IsNullable = true }; break;
            case "primary-key": columns["sequence"] = columns["sequence"] with { IsPrimaryKey = false }; break;
            case "identity": columns["sequence"] = columns["sequence"] with { IsIdentity = true, GenerationKind = "identity-always" }; break;
            case "owned-sequence":
                columns["sequence"] = columns["sequence"] with
                {
                    OwnedSequence = new("public", "extra_sequence", control.Name, "sequence", "bigint", 1, 1, 1, long.MaxValue, 1, false)
                };
                break;
            case "collation": columns["entry_payload"] = payload with { Collation = "pg_catalog.C" }; break;
            case "default":
                effects = effects with { Expressions = [.. effects.Expressions, new("default", control.Name, "entry_payload", "'changed'::text", [], [])] };
                break;
            case "default-null":
                effects = effects with { Expressions = [.. effects.Expressions, new("default", control.Name, "entry_payload", "NULL::text", [], [])] };
                break;
            case "computed": columns["entry_payload"] = payload with { ComputedExpression = "'changed'" }; break;
            case "index-direction": indexes[index.Name] = index with { Keys = [index.Keys[0] with { Direction = "desc" }] }; break;
            case "primary-index-direction":
                SchemaIndexModel primary = indexes[control.Name + "_pkey"];
                indexes[primary.Name] = primary with { Keys = primary.Keys.Select((key, position) =>
                    position == 0 ? key with { Direction = "desc" } : key).ToArray() };
                break;
            case "index-opclass": indexes[index.Name] = index with { Keys = [index.Keys[0] with { OperatorClass = "pg_catalog.text_pattern_ops" }] }; break;
            case "index-collation": indexes[index.Name] = index with { Keys = [index.Keys[0] with { Collation = "pg_catalog.C" }] }; break;
            case "index-include": indexes[index.Name] = index with { IncludedColumns = ["parent_digest"] }; break;
            case "index-null-distinct": indexes[index.Name] = index with { NullsNotDistinct = true }; break;
            case "missing-constraint": constraints.Remove(check.Name); effects = effects with { Expressions = [] }; break;
            case "missing-constraint-same-index": constraints.Remove(index.Name); break;
            case "constraint-deferred": constraints[index.Name] = constraints[index.Name] with { IsDeferrable = true }; break;
            case "constraint-unvalidated": constraints[check.Name] = check with { IsValidated = false }; break;
            case "check": effects = effects with { Expressions = [effects.Expressions[0] with { Expression = "sequence >= 0" }] }; break;
            case "trigger":
                effects = effects with { Triggers = [new(control.Name, "unexpected", "unexpected", 27, "O", null, 0, "", false, false, false, null, null)] };
                break;
            default: throw new InvalidOperationException("Unknown native control drift.");
        }
        var changed = new SchemaTableModel(control.Name, columns, indexes.Keys, indexes, constraints, control.Owner);
        var snapshot = new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel> { [changed.Name] = changed },
            provider: SchemaProviderKind.PostgreSql);
        Assert.NotEmpty(PgCurrentSchemaControlShape.CompareApplyJournal(snapshot, effects));
    }

    [Theory]
    [InlineData("missing-control")]
    [InlineData("missing-constraint-same-index")]
    [InlineData("missing-sequence")]
    [InlineData("sequence-cache")]
    public void CompleteControlAndIndependentSequence_RejectEitherNativeDomainDriftAfterCombinedPositive(string drift)
    {
        SchemaTableModel control = CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.PostgreSql);
        var tables = new Dictionary<string, SchemaTableModel> { [control.Name] = control };
        var snapshot = new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel>(tables),
            provider: SchemaProviderKind.PostgreSql);
        var operation = new CurrentSchemaRecipeOperation(CurrentSchemaRecipeOperationKind.CreateSequence, "probe_seq",
            Sequence: CurrentSchemaIndependentSequenceFacts.PostgreSqlBigIntDefaults);
        var expected = new CurrentSchemaCompletePhysicalProjection(snapshot, [operation], [])
        {
            IndependentSequences = [CurrentSchemaCanonicalAuthority.ProjectIndependentSequence(operation, SchemaProviderKind.PostgreSql)]
        };
        PgCurrentSequence sequence = new(operation.Name, "bigint", 1, 1, 1, long.MaxValue, 1, false);
        PgCurrentSchemaEffectObservation effects = ControlEffects(control) with { Sequences = [sequence] };
        Assert.Empty(PgCurrentSchemaOwnedTargetObserver.Compare(expected, snapshot, effects));
        switch (drift)
        {
            case "missing-control":
                tables.Clear();
                effects = effects with { Expressions = [] };
                break;
            case "missing-constraint-same-index":
                var constraints = new Dictionary<string, SchemaConstraintModel>(control.Constraints);
                constraints.Remove(control.Name + "_entry_digest_key");
                tables[control.Name] = new(control.Name, control.Columns, control.Indexes,
                    control.IndexDefinitions, constraints, control.Owner);
                break;
            case "missing-sequence": effects = effects with { Sequences = [] }; break;
            case "sequence-cache": effects = effects with { Sequences = [sequence with { Cache = 2 }] }; break;
            default: throw new InvalidOperationException("Unknown combined native drift.");
        }
        var changed = new SchemaModelSnapshot(tables, provider: SchemaProviderKind.PostgreSql);
        Assert.NotEmpty(PgCurrentSchemaOwnedTargetObserver.Compare(expected, changed, effects));
    }

    [Fact]
    public void CurrentControlShape_MissingOrUnknownTablesAndUnsupportedProviderRefuse()
    {
        SchemaTableModel control = CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.PostgreSql);
        PgCurrentSchemaEffectObservation effects = ControlEffects(control);
        Assert.Empty(PgCurrentSchemaControlShape.CompareApplyJournal(
            new(new Dictionary<string, SchemaTableModel> { [control.Name] = control }, provider: SchemaProviderKind.PostgreSql), effects));
        Assert.NotEmpty(PgCurrentSchemaControlShape.CompareApplyJournal(
            new(new Dictionary<string, SchemaTableModel>(), provider: SchemaProviderKind.PostgreSql), effects with { Expressions = [] }));
        Assert.NotEmpty(PgCurrentSchemaControlShape.CompareApplyJournal(new(new Dictionary<string, SchemaTableModel>
        {
            [control.Name] = control,
            ["__fsus_schema_unregistered_control"] = new("__fsus_schema_unregistered_control", [], [])
        }, provider: SchemaProviderKind.PostgreSql), effects));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.MySql));
        Assert.Throws<InvalidOperationException>(() => CurrentSchemaControlShape.ProjectApplyJournal(SchemaProviderKind.Sqlite));
    }

    [Fact]
    public void CurrentControlRendering_IsDerivedFromFreshSoleFactsAndKeepsOriginalConstraintNames()
    {
        SchemaTableModel first = CurrentSchemaControlShape.DescribeApplyJournal();
        first.Columns.Clear();
        Assert.Equal(7, CurrentSchemaControlShape.DescribeApplyJournal().Columns.Count);
        string sql = PgCurrentSchemaControlShape.CreateApplyJournalSql();
        Assert.Contains("CREATE TABLE IF NOT EXISTS public.\"__fsus_schema_offline_apply_journal\"", sql);
        Assert.Contains("\"__fsus_schema_offline_apply_j_plan_digest_database_digest_i_key\"", sql);
        Assert.Contains("CHECK (sequence > 0)", sql);
        Assert.DoesNotContain("DEFAULT", sql);
        Assert.DoesNotContain("DROP", sql);
        Assert.DoesNotContain("DELETE", sql);
    }

    [Fact]
    public void RecentHistoryExpressionIndex_UsesIndependentRecipeAndOrderedNativeKeys()
    {
        Dictionary<string, SchemaColumnModel> columns = RecentHistoryColumns();
        IReadOnlyList<SchemaIndexKeyModel> observed = ReadRecentHistoryKeys(RecentHistoryNativeKeys(), columns);
        SchemaIndexKeyModel[] expected = RecentHistoryExpectedKeys(columns);
        Assert.Equal(4, observed.Count);
        Assert.Equal(SchemaIndexKeyKind.Expression, observed[2].Kind);
        Assert.Empty(observed[2].Column);
        Assert.Equal("desc", observed[2].Direction);
        Assert.Equal("first", observed[2].NullPlacement);
        Assert.Equal(expected[2], observed[2]); // Separate parsed AST lists, not reference equality.
        Assert.Empty(CompareRecentHistory(expected, observed, columns));
    }

    [Theory]
    [InlineData("order")]
    [InlineData("argument-order")]
    [InlineData("direction")]
    [InlineData("null-placement")]
    [InlineData("opclass")]
    [InlineData("collation")]
    public void RecentHistoryExpressionIndex_RejectsSameCountNativeKeyDrift(string drift)
    {
        Dictionary<string, SchemaColumnModel> columns = RecentHistoryColumns();
        Dictionary<string, object?>[] native = RecentHistoryNativeKeys();
        IReadOnlyList<SchemaIndexKeyModel> original = ReadRecentHistoryKeys(native, columns);
        SchemaIndexKeyModel[] expected = RecentHistoryExpectedKeys(columns);
        Assert.Empty(CompareRecentHistory(expected, original, columns));
        switch (drift)
        {
            case "order": (native[2], native[3]) = (native[3], native[2]); break;
            case "argument-order":
                native[2]["expression"] = "GREATEST(last_edited_at_utc, last_opened_at_utc, last_activated_at_utc)";
                break;
            case "direction": native[2]["direction"] = "asc"; break;
            case "null-placement": native[2]["nullPlacement"] = "last"; break;
            case "opclass": native[2]["operatorClass"] = "public.changed_timestamp_ops"; break;
            case "collation": native[2]["collation"] = "pg_catalog.C"; break;
            default: throw new InvalidOperationException("Unknown native expression-key drift.");
        }
        IReadOnlyList<SchemaIndexKeyModel> changed = ReadRecentHistoryKeys(native, columns);
        Assert.Equal(original.Count, changed.Count);
        Assert.NotEmpty(CompareRecentHistory(expected, changed, columns));
    }

    [Theory]
    [InlineData("missing-expression")]
    [InlineData("column-and-expression")]
    [InlineData("column-with-expression")]
    [InlineData("unknown-kind")]
    [InlineData("missing-kind")]
    [InlineData("unknown-call")]
    [InlineData("foreign-column")]
    [InlineData("non-timestamp-column")]
    [InlineData("cast")]
    [InlineData("nested-call")]
    [InlineData("literal")]
    [InlineData("tail")]
    [InlineData("presence")]
    public void RecentHistoryExpressionIndex_RejectsUnclosedNativeExpressionUnion(string drift)
    {
        Dictionary<string, SchemaColumnModel> columns = RecentHistoryColumns();
        Dictionary<string, object?>[] native = RecentHistoryNativeKeys();
        Assert.Empty(CompareRecentHistory(RecentHistoryExpectedKeys(columns), ReadRecentHistoryKeys(native, columns), columns));
        switch (drift)
        {
            case "missing-expression": native[2]["expression"] = null; break;
            case "column-and-expression": native[2]["column"] = "last_opened_at_utc"; break;
            case "column-with-expression": native[0]["expression"] = "owner_admin_principal_id"; break;
            case "unknown-kind": native[2]["kind"] = "unknown"; break;
            case "missing-kind": native[2].Remove("kind"); break;
            case "unknown-call": native[2]["expression"] = "LEAST(last_opened_at_utc, last_edited_at_utc, last_activated_at_utc)"; break;
            case "foreign-column": native[2]["expression"] = "GREATEST(foreign_column, last_edited_at_utc, last_activated_at_utc)"; break;
            case "non-timestamp-column": native[2]["expression"] = "GREATEST(article_id, last_edited_at_utc, last_activated_at_utc)"; break;
            case "cast": native[2]["expression"] = "GREATEST(last_opened_at_utc::timestamp, last_edited_at_utc, last_activated_at_utc)"; break;
            case "nested-call": native[2]["expression"] = "GREATEST(GREATEST(last_opened_at_utc, last_edited_at_utc), last_activated_at_utc)"; break;
            case "literal": native[2]["expression"] = "GREATEST(NULL, last_edited_at_utc, last_activated_at_utc)"; break;
            case "tail": native[2]["expression"] = "GREATEST(last_opened_at_utc, last_edited_at_utc, last_activated_at_utc) DESC"; break;
            case "presence": break;
            default: throw new InvalidOperationException("Unknown native expression union drift.");
        }
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ParsePostgresIndexKeys(
            JsonSerializer.Serialize(native), drift != "presence", columns));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("extra")]
    [InlineData("duplicate")]
    [InlineData("unbound-column")]
    [InlineData("foreign-owner")]
    [InlineData("predicate-missing")]
    public void ExpressionIndexDependencies_BindCompleteNativeIndexReadSet(string drift)
    {
        Dictionary<string, SchemaColumnModel> columns = RecentHistoryColumns();
        IReadOnlyList<SchemaIndexKeyModel> keys = ReadRecentHistoryKeys(RecentHistoryNativeKeys(), columns);
        string[] complete = RecentHistoryDependencies();
        PgCurrentSchemaCatalogObserver.ValidatePostgresExpressionIndexDependencies(keys, [], null, columns,
            JsonSerializer.Serialize(complete), false);
        PgCurrentSchemaCatalogObserver.ValidatePostgresExpressionIndexDependencies(keys, [], null, columns,
            JsonSerializer.Serialize(complete.Reverse()), false); // Dependencies are a set, unlike ordered keys.
        // INCLUDE/predicate columns are part of this whole-index dependency set too.
        columns["revision"] = new("revision", false, false, false, null, "int64", PhysicalType: "bigint");
        string[] withRevision = complete.Append("revision").Order(StringComparer.Ordinal).ToArray();
        PgCurrentSchemaCatalogObserver.ValidatePostgresExpressionIndexDependencies(keys, ["revision"], "revision > 0", columns,
            JsonSerializer.Serialize(withRevision), false);
        string[] changed = drift switch
        {
            "missing" => complete.Where(static name => name != "last_opened_at_utc").ToArray(),
            "extra" => withRevision,
            "duplicate" => [.. complete, complete[^1]],
            "unbound-column" => [.. complete[..^1], "unbound_column"],
            _ => complete
        };
        Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaCatalogObserver.ValidatePostgresExpressionIndexDependencies(
            keys, [], drift == "predicate-missing" ? "revision > 0" : null, columns,
            JsonSerializer.Serialize(changed), drift == "foreign-owner"));
    }

    private static Dictionary<string, SchemaColumnModel> RecentHistoryColumns()
        => new(StringComparer.Ordinal)
        {
            ["owner_admin_principal_id"] = new("owner_admin_principal_id", false, false, false, null, "int64", PhysicalType: "bigint"),
            ["site_scope"] = new("site_scope", false, false, false, 128, "string", PhysicalType: "varchar(128)"),
            ["article_id"] = new("article_id", false, false, false, null, "int32", PhysicalType: "integer"),
            ["last_opened_at_utc"] = new("last_opened_at_utc", true, false, false, null, "timestamp", PhysicalType: "timestamp without time zone"),
            ["last_edited_at_utc"] = new("last_edited_at_utc", true, false, false, null, "timestamp", PhysicalType: "timestamp without time zone"),
            ["last_activated_at_utc"] = new("last_activated_at_utc", true, false, false, null, "timestamp", PhysicalType: "timestamp without time zone")
        };

    private static Dictionary<string, object?>[] RecentHistoryNativeKeys()
    {
        static Dictionary<string, object?> Key(string? column, string? expression, string direction, string nullPlacement)
            => new(StringComparer.Ordinal)
            {
                ["kind"] = expression is null ? "column" : "expression",
                ["column"] = column,
                ["expression"] = expression,
                ["direction"] = direction,
                ["nullPlacement"] = nullPlacement,
                ["operatorClass"] = "default",
                ["collation"] = "default"
            };
        return
        [
            Key("owner_admin_principal_id", null, "asc", "last"),
            Key("site_scope", null, "asc", "last"),
            Key(null, "GREATEST(last_opened_at_utc, last_edited_at_utc, last_activated_at_utc)", "desc", "first"),
            Key("article_id", null, "desc", "first")
        ];
    }

    private static SchemaIndexKeyModel[] RecentHistoryExpectedKeys(IReadOnlyDictionary<string, SchemaColumnModel> columns)
        =>
        [
            new("owner_admin_principal_id", "asc", "last", "default", "default"),
            new("site_scope", "asc", "last", "default", "default"),
            new(string.Empty, "desc", "first", "default", "default")
            {
                Kind = SchemaIndexKeyKind.Expression,
                Expression = PgCurrentSchemaExpressionParser.Parse(
                    "GREATEST(last_opened_at_utc, last_edited_at_utc, last_activated_at_utc)", columns)
            },
            new("article_id", "desc", "first", "default", "default")
        ];

    private static string[] RecentHistoryDependencies()
        => ["article_id", "last_activated_at_utc", "last_edited_at_utc", "last_opened_at_utc", "owner_admin_principal_id", "site_scope"];

    private static IReadOnlyList<SchemaIndexKeyModel> ReadRecentHistoryKeys(Dictionary<string, object?>[] native,
        IReadOnlyDictionary<string, SchemaColumnModel> columns)
    {
        IReadOnlyList<SchemaIndexKeyModel> keys = PgCurrentSchemaCatalogObserver.ParsePostgresIndexKeys(JsonSerializer.Serialize(native), true, columns);
        PgCurrentSchemaCatalogObserver.ValidatePostgresExpressionIndexDependencies(keys, [], null, columns,
            JsonSerializer.Serialize(RecentHistoryDependencies()), false);
        return keys;
    }

    private static IReadOnlyList<string> CompareRecentHistory(IReadOnlyList<SchemaIndexKeyModel> expectedKeys,
        IReadOnlyList<SchemaIndexKeyModel> observedKeys, Dictionary<string, SchemaColumnModel> columns)
    {
        static SchemaModelSnapshot Snapshot(IReadOnlyList<SchemaIndexKeyModel> keys, Dictionary<string, SchemaColumnModel> columns)
        {
            const string tableName = "author_recent_history_entry";
            const string indexName = "ix_author_recent_history_entry_order";
            var index = new SchemaIndexModel(indexName, false, keys, [], "btree", null, false);
            var table = new SchemaTableModel(tableName, columns, [indexName], new Dictionary<string, SchemaIndexModel> { [indexName] = index });
            return new(new Dictionary<string, SchemaTableModel> { [tableName] = table }, provider: SchemaProviderKind.PostgreSql);
        }
        var expected = new CurrentSchemaCompletePhysicalProjection(Snapshot(expectedKeys, columns), [], []);
        return PgCurrentSchemaOwnedTargetObserver.Compare(expected, Snapshot(observedKeys, columns), new(true, [], [], [], []));
    }

    private static PgCurrentSchemaEffectObservation ControlEffects(SchemaTableModel table)
        => new(true, [new("check", table.Name, table.Name + "_sequence_check", "(sequence > 0)", ["sequence"], [])], [], [], []);

    private static CurrentSchemaCompletePhysicalProjection Expected()
    {
        SchemaColumnModel column = new("revision", false, false, false, null, "int64", "1", "none", PhysicalType: "bigint");
        var check = new SchemaConstraintModel("bounded_revision", "check", [], Expression: "revision >= 1 AND revision <= 10");
        var table = new SchemaTableModel("probe", new Dictionary<string, SchemaColumnModel> { [column.Name] = column }, [],
            constraints: new Dictionary<string, SchemaConstraintModel> { [check.Name] = check });
        return new(new SchemaModelSnapshot(new Dictionary<string, SchemaTableModel> { [table.Name] = table }, provider: SchemaProviderKind.PostgreSql), [], []);
    }

    private static PgCurrentSchemaEffectObservation Effects(string value, string check, string[] columns)
        => new(true, [new("default", "probe", "revision", value, [], []), new("check", "probe", "bounded_revision", check, columns, [])], [], [], []);
}
