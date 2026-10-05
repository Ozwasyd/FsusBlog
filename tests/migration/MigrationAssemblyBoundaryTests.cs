using System.Reflection;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Migration.Catalogs;
using FsusBlog.Migration.Definitions;

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

        Assert.Equal(148, manifest.Descriptors.Count);
        ISchemaMigrationDescriptor[] addedDescriptors =
        [
            ArticlePropertyDefinitionAuthorityMigrationDefinitions.BuildMigration(),
            ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.BuildMigration()
        ];
        string[] addedIds = addedDescriptors.Select(static descriptor => descriptor.MigrationId).ToArray();
        Assert.Equal(
            [
                "20260915-post-article-property-definition-authority",
                "20261002-post-article-property-definition-command-history"
            ],
            addedIds);
        Assert.Equal(2, manifest.Descriptors.Count(descriptor =>
            addedIds.Contains(descriptor.MigrationId, StringComparer.Ordinal)));
        foreach (ISchemaMigrationDescriptor expected in addedDescriptors)
        {
            ISchemaMigrationDescriptor actual = Assert.Single(
                manifest.Descriptors,
                descriptor => descriptor.MigrationId == expected.MigrationId);
            Assert.Equal(expected.MigrationId, actual.MigrationId);
            Assert.Equal(expected.Description, actual.Description);
            Assert.Equal(SchemaMigrationPhase.PostCodeFirst, actual.Phase);
            Assert.Equal(expected.Phase, actual.Phase);
            Assert.True(actual.Transactional);
            Assert.Equal(expected.Transactional, actual.Transactional);
            Assert.Equal(expected.Checksum, actual.Checksum);
            Assert.Equal(
                expected.AcceptedChecksums.Order(StringComparer.Ordinal),
                actual.AcceptedChecksums.Order(StringComparer.Ordinal));
            Assert.Equal(expected.Steps.Count, actual.Steps.Count);
            for (int index = 0; index < expected.Steps.Count; index++)
            {
                Assert.Equal(expected.Steps[index].GetType(), actual.Steps[index].GetType());
                Assert.Equal(expected.Steps[index], actual.Steps[index]);
                Assert.Equal(expected.Steps[index].Kind, actual.Steps[index].Kind);
                Assert.Equal(expected.Steps[index].Fingerprint, actual.Steps[index].Fingerprint);
            }
        }

        ISchemaMigrationDescriptor[] historicalDescriptors = manifest.Descriptors
            .Where(descriptor => !addedIds.Contains(descriptor.MigrationId, StringComparer.Ordinal))
            .ToArray();
        Assert.Equal(146, historicalDescriptors.Length);
        Assert.Equal(
            "DB1EA11A52744CA7F95082059B4A50C1D44EB2A239034D0D834AA4658E590725",
            ComputePlanFingerprint(historicalDescriptors));
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
        Assert.Contains("legacy_value", sql, StringComparison.Ordinal);
        if (dialect == SchemaDdlDialect.MySql)
        {
            string ddl = $"ALTER TABLE {quotedTable} ADD COLUMN `legacy_value` integer NOT NULL DEFAULT 0;";
            Assert.Contains($"CONVERT(X'{Convert.ToHexString(Encoding.UTF8.GetBytes(ddl))}' USING utf8mb4)", sql, StringComparison.Ordinal);
            Assert.Contains("table_name = 'example'", sql, StringComparison.Ordinal);
        }
        else
        {
            Assert.Contains(quotedTable, sql, StringComparison.Ordinal);
            Assert.Contains("integer", sql, StringComparison.OrdinalIgnoreCase);
        }
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
