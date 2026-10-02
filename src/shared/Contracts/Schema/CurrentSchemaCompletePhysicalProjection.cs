namespace FsusBlog.Contracts.Schema;

/// <summary>Original owned relational facts plus schema effects and apply-time bootstrap data effects.</summary>
/// <remarks>
/// Relational comparison alone does not verify sequence/function/trigger effects.
/// Consumers must observe them separately. Mutable bootstrap rows are checked by
/// apply postconditions, not treated as permanent runtime schema facts.
/// </remarks>
/// <param name="Tables">Every original owned relational table and its final added columns, constraints and indexes.</param>
/// <param name="SchemaEffects">Original ordered sequence, immutable-function and trigger operations requiring separate native observation.</param>
/// <param name="BootstrapDataEffects">Original ordered seed operations requiring apply-time data postconditions.</param>
public sealed record CurrentSchemaCompletePhysicalProjection(
    SchemaModelSnapshot Tables,
    IReadOnlyList<CurrentSchemaRecipeOperation> SchemaEffects,
    IReadOnlyList<CurrentSchemaRecipeOperation> BootstrapDataEffects);
