using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Schema;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

/// <summary>
/// Read-only export from the original current entity and provider-recipe owners.
/// Migration consumes its neutral payload; it never loads this Server assembly.
/// </summary>
public static class CurrentSchemaOwnedProjectionExporter
{
    public const string ProducerId = "fsusblog.current-schema-owned-projection.v1";

    /// <summary>
    /// Observes current mappings and binds the actual producer/contract bytes and
    /// compiled source identity. Does not connect to a database or authorize apply.
    /// </summary>
    /// <returns>
    /// The canonical entity projection and every original required recipe reference.
    /// Recipe semantics that have not been neutralized remain explicitly absent.
    /// </returns>
    public static async Task<CurrentSchemaBootstrapInput> ExportAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Assembly producer = typeof(CurrentSchemaOwnedProjectionExporter).Assembly;
        string? sourceCommit = producer.GetCustomAttributes<AssemblyMetadataAttribute>()
            .SingleOrDefault(static attribute => attribute.Key == "FsusBlog.SourceCommit")?.Value;
        if (sourceCommit is null || sourceCommit.Length != 40 || sourceCommit.All(static character => character == '0')
            || sourceCommit.Any(static character => character is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
        {
            throw new InvalidOperationException("current_schema_exporter_source_identity_missing");
        }
        var inspector = new SchemaModelInspector();
        CurrentSchemaCanonicalModel canonical = inspector.BuildCanonicalModel(inspector.GetManagedEntityTypes());
        CurrentSchemaProjection projection = CurrentSchemaCanonicalAuthority.Generate(canonical);
        string producerDigest = await HashAssemblyAsync(producer, cancellationToken).ConfigureAwait(false);
        string contractDigest = await HashAssemblyAsync(typeof(CurrentSchemaCanonicalAuthority).Assembly, cancellationToken).ConfigureAwait(false);
        return new CurrentSchemaBootstrapInput(
            projection,
            new CurrentSchemaProducerIdentity(sourceCommit, ProducerId, producerDigest, contractDigest),
            DescribeRequiredRecipes());
    }

    internal static IReadOnlyList<CurrentSchemaRequiredRecipeReference> DescribeRequiredRecipes()
        => CurrentSchemaRuntimeRollupTables.Tables.Select(static table =>
            new CurrentSchemaRequiredRecipeReference(
                table.TableName,
                SchemaProviderKind.PostgreSql,
                Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
                {
                    table.TableName,
                    table.CreateSql,
                    table.AdditionalSql
                })))).ToLowerInvariant(),
                SemanticDescription: null)).ToArray();

    private static async Task<string> HashAssemblyAsync(Assembly assembly, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(assembly.Location))
        {
            throw new InvalidOperationException("current_schema_exporter_compiled_input_unavailable");
        }
        byte[] bytes = await File.ReadAllBytesAsync(assembly.Location, cancellationToken).ConfigureAwait(false);
        return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    }
}
