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
        CurrentSchemaCanonicalAuthority.VerifyIdentity(input.EntityProjection.Schema, input.EntityProjection.Identity);
        if (input.RequiredRecipes.Count == 0 || input.RequiredRecipes.Any(static reference =>
            reference.SemanticDescription is null || reference.TableName != reference.SemanticDescription.Table.Name
            || reference.RecipeDigest.Length != 64
            || reference.RecipeDigest.Any(static value => value is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
            || input.RequiredRecipes.Select(static reference => reference.TableName).Distinct(StringComparer.Ordinal).Count() != input.RequiredRecipes.Count)
        {
            throw new InvalidOperationException("current_schema_owned_target_recipe_closure_invalid");
        }
        string source = Hash(JsonSerializer.Serialize(new
        {
            Entity = input.EntityProjection.Identity.SourceDigest,
            Recipes = input.RequiredRecipes.Select(static reference => new { reference.TableName, reference.RecipeDigest }).ToArray()
        }));
        string content = Hash(JsonSerializer.Serialize(new
        {
            Entity = input.EntityProjection.Identity.ContentDigest,
            Recipes = input.RequiredRecipes.Select(static reference => reference.SemanticDescription).ToArray()
        }));
        return input.EntityProjection.Identity with { SourceDigest = source, ContentDigest = content };
    }

    private static string Hash(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}
