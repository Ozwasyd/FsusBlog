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

        const string RecentHistoryMigrationId = "20260915-post-author-recent-history";
        Assert.Single(manifest.Descriptors, static descriptor =>
            descriptor.MigrationId == RecentHistoryMigrationId);
        ISchemaMigrationDescriptor[] historicalDescriptors = manifest.Descriptors
            .Where(static descriptor => descriptor.MigrationId != RecentHistoryMigrationId)
            .ToArray();
        Assert.Equal(145, historicalDescriptors.Length);
        Assert.Equal(
            "D53AB234D57D3C847748434A7A64810A21D8DA44219CFA895360A96B918A4117",
            ComputePlanFingerprint(historicalDescriptors));

        Assert.Equal(146, manifest.Descriptors.Count);
        Assert.Equal(
            "DB1EA11A52744CA7F95082059B4A50C1D44EB2A239034D0D834AA4658E590725",
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
