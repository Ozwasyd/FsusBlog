using System.Reflection;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Migration.Catalogs;

using Xunit;

namespace FsusBlog.Migration.Tests;

public sealed class MigrationAssemblyBoundaryTests
{
    [Fact]
    public void AssemblyReferences_ExcludeServerAndWebHost()
    {
        Assembly migration = typeof(SchemaMigrationRegistry).Assembly;
        string[] references = migration.GetReferencedAssemblies()
            .Select(static reference => reference.Name ?? string.Empty)
            .ToArray();

        Assert.Equal("FsusBlog.Migration", migration.GetName().Name);
        Assert.DoesNotContain("FsusBlog.Server", references);
        Assert.DoesNotContain("FsusBlog.Core", references);
        Assert.DoesNotContain(references, static reference =>
            reference.StartsWith("Microsoft.AspNetCore", StringComparison.Ordinal));
    }

    [Fact]
    public void Manifest_PreservesDescriptorIdsAndDigest()
    {
        SchemaMigrationManifest manifest = SchemaMigrationManifest.Current;

        Assert.Equal(137, manifest.Descriptors.Count);
        Assert.Equal(
            "7A94BDE5396AC231BD65B179F06B7D6233ACB983D98FF3B4280A9E05378CEDA2",
            ComputePlanFingerprint(manifest.Descriptors));
        Assert.Equal(
            manifest.Descriptors.Count,
            manifest.Descriptors.Select(static descriptor => descriptor.MigrationId)
                .Distinct(StringComparer.Ordinal).Count());
    }

    [Theory]
    [InlineData(SchemaDdlDialect.PostgreSql, "\"example\"")]
    [InlineData(SchemaDdlDialect.MySql, "`example`")]
    [InlineData(SchemaDdlDialect.Sqlite, "\"example\"")]
    public void Provider_ProducesDialectOwnedDdl(
        SchemaDdlDialect dialect,
        string quotedTable)
    {
        ISchemaDdlProvider provider = SchemaDdlProviders.For(dialect);
        string sql = provider.EnsureColumn(
            SchemaIdentifier.Parse("example", "table"),
            SchemaIdentifier.Parse("legacy_value", "column"),
            SchemaColumnDefinition.Parse("integer NOT NULL DEFAULT 0", "definition"));

        Assert.Equal(dialect, provider.Dialect);
        Assert.Contains(quotedTable, sql, StringComparison.Ordinal);
        Assert.Contains("legacy_value", sql, StringComparison.Ordinal);
        Assert.Contains("integer", sql, StringComparison.OrdinalIgnoreCase);
    }

    private static string ComputePlanFingerprint(IReadOnlyList<ISchemaMigrationDescriptor> descriptors)
    {
        string payload = string.Join(
            '\n',
            descriptors.Select(static descriptor =>
                $"{descriptor.Phase}|{descriptor.MigrationId}|{descriptor.Checksum}"));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(payload)));
    }
}
