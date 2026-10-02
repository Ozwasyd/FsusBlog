namespace FsusBlog.Contracts.Schema;

/// <summary>Current-owned recipe facts. These describe effects, not SQL templates or an execution grant.</summary>
public sealed record CurrentSchemaRecipeFacts(
    SchemaTableModel Table,
    IReadOnlyList<CurrentSchemaRecipeOperation> AdditionalOperations);

/// <summary>Closed effects supported by the current recipe exporter.</summary>
public enum CurrentSchemaRecipeOperationKind
{
    CreateIndex,
    CreateSequence,
    DefineImmutableGuard,
    RemoveTrigger,
    CreateImmutableTrigger,
    InsertIfAbsent,
    AddColumnIfAbsent,
    AddConstraintIfAbsent
}

/// <summary>
/// A provider-independent effect and its current-owned arguments. Expressions in
/// defaults, predicates and seed values retain the owner's expression semantics;
/// the provider compiler validates its supported dialect before execution.
/// </summary>
public sealed record CurrentSchemaRecipeOperation(
    CurrentSchemaRecipeOperationKind Kind,
    string Name,
    string? Table = null,
    SchemaIndexModel? Index = null,
    SchemaColumnModel? Column = null,
    SchemaConstraintModel? Constraint = null,
    string? ErrorCode = null,
    string? Function = null,
    IReadOnlyList<string>? Columns = null,
    IReadOnlyList<string>? Values = null,
    string? ConflictColumn = null);

/// <summary>Current control relation facts, not SQL, journal payload or an execution grant.</summary>
/// <param name="Version">The explicitly versioned current control contract.</param>
/// <param name="Table">The single complete neutral column and constraint description.</param>
/// <param name="Persistence">The provider's persistent-relation classification.</param>
/// <param name="RelationKind">The provider's regular-table classification.</param>
/// <param name="IsPartition">Whether partition membership is part of this shape.</param>
/// <param name="RowSecurity">Whether row security is part of this shape.</param>
/// <param name="ForceRowSecurity">Whether forced row security is part of this shape.</param>
/// <param name="HasInheritance">Whether inheritance is part of this shape.</param>
/// <param name="HasRules">Whether rewrite rules are part of this shape.</param>
/// <param name="HasTriggers">Whether any attached triggers are part of this shape.</param>
public sealed record CurrentSchemaControlTableFacts(string Version, SchemaTableModel Table, string Persistence,
    string RelationKind, bool IsPartition, bool RowSecurity, bool ForceRowSecurity, bool HasInheritance, bool HasRules, bool HasTriggers);

/// <summary>The single current control shape; journal payload and historical validation remain offline-only.</summary>
public static class CurrentSchemaControlShape
{
    /// <summary>The current control shape version, independently of historical journal payload formats.</summary>
    public const string Version = "fsusblog.current-control.apply-journal.v1";
    /// <summary>The original sole native apply journal's exact table identity.</summary>
    public const string ApplyJournalTableName = "__fsus_schema_offline_apply_journal";

    /// <summary>Describes the complete standalone persistent relation, not merely an allowed table name.</summary>
    /// <returns>Fresh complete control facts with no history or execution permission.</returns>
    public static CurrentSchemaControlTableFacts DescribeApplyJournalFacts()
        => new(Version, DescribeApplyJournal(), "p", "r", false, false, false, false, false, false);

    /// <summary>Returns fresh immutable-value descriptions of the original seven columns and four constraints.</summary>
    /// <returns>The sole current semantic control shape.</returns>
    public static SchemaTableModel DescribeApplyJournal()
    {
        const string table = ApplyJournalTableName;
        var columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal)
        {
            ["plan_digest"] = new("plan_digest", false, true, false, 64, "string", Conversion: "none"),
            ["database_digest"] = new("database_digest", false, true, false, 64, "string", Conversion: "none"),
            ["invocation_id"] = new("invocation_id", false, true, false, 160, "string", Conversion: "none"),
            ["sequence"] = new("sequence", false, true, false, null, "int64", Conversion: "none"),
            ["entry_digest"] = new("entry_digest", false, false, false, 64, "string", Conversion: "none"),
            ["parent_digest"] = new("parent_digest", false, false, false, 64, "string", Conversion: "none"),
            ["entry_payload"] = new("entry_payload", false, false, false, null, "string", Conversion: "none")
        };
        // Explicit names are the original PostgreSQL 63-byte implicit names in
        // an unoccupied namespace. Collisions are not accepted as another shape.
        SchemaConstraintModel[] definitions =
        [
            new(table + "_pkey", "primary-key", ["plan_digest", "database_digest", "invocation_id", "sequence"]),
            new("__fsus_schema_offline_apply_j_plan_digest_database_digest_i_key", "unique",
                ["plan_digest", "database_digest", "invocation_id", "parent_digest"]),
            new(table + "_entry_digest_key", "unique", ["entry_digest"]),
            new(table + "_sequence_check", "check", ["sequence"], Expression: "sequence > 0")
        ];
        return new(table, columns, [], constraints: definitions.ToDictionary(static value => value.Name,
            StringComparer.Ordinal), owner: new SchemaOwnerModel("current-control", Version));
    }

    /// <summary>Projects the same facts, including unique backing indexes, without admitting another provider.</summary>
    /// <param name="provider">The explicitly supported native provider.</param>
    /// <returns>The complete native column, constraint and backing-index descriptions.</returns>
    public static SchemaTableModel ProjectApplyJournal(SchemaProviderKind provider)
    {
        if (provider != SchemaProviderKind.PostgreSql)
            throw new InvalidOperationException("current_schema_control_provider_unavailable");
        SchemaTableModel semantic = DescribeApplyJournal();
        var columns = semantic.Columns.ToDictionary(static entry => entry.Key, entry => entry.Value with
        {
            PhysicalType = SchemaPhysicalTypeProjection.ToPhysical(provider, entry.Value.DataType, entry.Value.MaxLength),
            Collation = SchemaPhysicalTypeProjection.ToCollation(provider, entry.Value.DataType),
            Owner = new SchemaOwnerModel("postgresql", "public." + semantic.Name + "." + entry.Key)
        }, StringComparer.Ordinal);
        var constraints = semantic.Constraints.Values.Select(value => value.Kind == "primary-key"
            ? value with { Name = "pk_" + semantic.Name } : value).ToDictionary(static value => value.Name, StringComparer.Ordinal);
        var indexes = constraints.Values.Where(static value => value.Kind == "unique").ToDictionary(static value => value.Name,
            static value => new SchemaIndexModel(value.Name, true,
                value.Columns.Select(static name => new SchemaIndexKeyModel(name, "asc", "last", "default", "default")).ToArray(),
                [], "btree", null, false), StringComparer.Ordinal);
        SchemaConstraintModel primary = semantic.Constraints.Values.Single(static value => value.Kind == "primary-key");
        indexes.Add(primary.Name, new(primary.Name, true,
            primary.Columns.Select(static name => new SchemaIndexKeyModel(name, "asc", "last", "default", "default")).ToArray(),
            [], "btree", null, false));
        return new(semantic.Name, columns, indexes.Keys, indexes, constraints,
            new SchemaOwnerModel("postgresql", "public." + semantic.Name));
    }
}
