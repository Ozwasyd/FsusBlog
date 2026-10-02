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
