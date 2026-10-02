namespace FsusBlog.Contracts.Schema;

/// <summary>
/// Source-bound current input, not an execution grant. The entity projection alone
/// is not the complete bootstrap target when required provider recipes remain unmodelled.
/// </summary>
public sealed record CurrentSchemaBootstrapInput(
    CurrentSchemaProjection EntityProjection,
    CurrentSchemaProducerIdentity Producer,
    IReadOnlyList<CurrentSchemaRequiredRecipeReference> RequiredRecipes);

/// <summary>Observed compiled-file identities; the evidence owner independently verifies source/build binding.</summary>
public sealed record CurrentSchemaProducerIdentity(
    string SourceCommit,
    string ProducerId,
    string ProducerAssemblySha256,
    string ContractAssemblySha256);

/// <summary>
/// Identity of an existing current-owned provider recipe, not SQL or a second field mapping.
/// A missing semantic description must refuse bootstrap before any database write.
/// </summary>
public sealed record CurrentSchemaRequiredRecipeReference(
    string TableName,
    SchemaProviderKind Provider,
    string RecipeDigest,
    SchemaModelSnapshot? SemanticDescription);
