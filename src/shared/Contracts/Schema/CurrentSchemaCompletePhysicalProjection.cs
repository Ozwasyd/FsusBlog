namespace FsusBlog.Contracts.Schema;

/// <summary>Original owned relational facts plus schema effects and apply-time bootstrap data effects.</summary>
/// <remarks>
/// Relational comparison alone does not verify sequence/function/trigger effects.
/// Consumers must observe them separately. Mutable bootstrap rows are checked by
/// apply postconditions, not treated as permanent runtime schema facts.
/// </remarks>
public sealed record CurrentSchemaCompletePhysicalProjection(
    SchemaModelSnapshot Tables,
    IReadOnlyList<CurrentSchemaRecipeOperation> SchemaEffects,
    IReadOnlyList<CurrentSchemaRecipeOperation> BootstrapDataEffects);
