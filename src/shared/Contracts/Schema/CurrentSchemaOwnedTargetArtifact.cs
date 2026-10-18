using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Contracts.Schema;

/// <summary>Owned producer output, not an apply grant or native database observation.</summary>
public sealed record CurrentSchemaOwnedTargetArtifact(
    string SchemaVersion,
    CurrentSchemaBootstrapInput Input,
    string InputSha256,
    CurrentSchemaIdentity Target);

/// <summary>Single neutral identity projection for complete current entity and recipe facts.</summary>
public static class CurrentSchemaOwnedTargetProjection
{
    public const string ArtifactSchemaVersion = "fsusblog.current-schema-owned-target.v1";

    /// <summary>Computes the exact input identity; the consumer independently verifies producer/source ownership.</summary>
    public static string ComputeInputDigest(CurrentSchemaBootstrapInput input)
        => Hash(JsonSerializer.Serialize(input));

    /// <summary>Projects every required recipe into the target identity; missing facts refuse partial projection.</summary>
    public static CurrentSchemaIdentity Observe(CurrentSchemaBootstrapInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        return Observe(input.EntityProjection, input.RequiredRecipes);
    }

    /// <summary>Projects the same original owner facts without inventing an artifact producer identity for a live reader.</summary>
    public static CurrentSchemaIdentity Observe(CurrentSchemaProjection entityProjection,
        IReadOnlyList<CurrentSchemaRequiredRecipeReference> requiredRecipes)
    {
        ArgumentNullException.ThrowIfNull(entityProjection);
        ArgumentNullException.ThrowIfNull(requiredRecipes);
        CurrentSchemaCanonicalAuthority.VerifyIdentity(entityProjection.Schema, entityProjection.Identity);
        if (requiredRecipes.Count == 0 || requiredRecipes.Any(static reference =>
            reference.SemanticDescription is null || reference.TableName != reference.SemanticDescription.Table.Name
            || reference.RecipeDigest.Length != 64
            || reference.RecipeDigest.Any(static value => value is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
            || requiredRecipes.Select(static reference => reference.TableName).Distinct(StringComparer.Ordinal).Count() != requiredRecipes.Count)
        {
            throw new InvalidOperationException("current_schema_owned_target_recipe_closure_invalid");
        }
        string source = Hash(JsonSerializer.Serialize(new
        {
            Entity = entityProjection.Identity.SourceDigest,
            Recipes = requiredRecipes.Select(static reference => new { reference.TableName, reference.RecipeDigest }).ToArray(),
            Control = CurrentSchemaControlShape.DescribeApplyJournalFacts()
        }));
        string content = Hash(JsonSerializer.Serialize(new
        {
            Entity = entityProjection.Identity.ContentDigest,
            Recipes = requiredRecipes.Select(static reference => reference.SemanticDescription).ToArray(),
            Control = CurrentSchemaControlShape.DescribeApplyJournalFacts()
        }));
        return entityProjection.Identity with
        {
            SourceDigest = source,
            ContentDigest = content
        };
    }

    private static string Hash(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}
