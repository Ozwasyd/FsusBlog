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
            "F2FBD2AF4569856A7435D044AAD13FABD6B32A5F68EF6DEA8C546E8B234E7F04",
            ComputePlanFingerprint(manifest.Descriptors));
        Assert.Equal(
            manifest.Descriptors.Count,
            manifest.Descriptors.Select(static descriptor => descriptor.MigrationId)
                .Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void Manifest_AnchorsFirstPublishedRecentHistoryDescriptor()
    {
        SchemaMigrationManifest manifest = SchemaMigrationManifest.Current;
        ISchemaMigrationDescriptor recent = Assert.Single(manifest.Descriptors, static descriptor =>
            descriptor.MigrationId == "20260915-post-author-recent-history");

        Assert.Same(manifest.Descriptors[^1], recent);
        Assert.Equal(
            "Add the closed owner/site-scoped server recent article history authority, receipts, audit and outbox ledger.",
            recent.Description);
        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, recent.Phase);
        Assert.True(recent.Transactional);
        Assert.Equal(
            "5B1EBAE965D5B05375F0FB345E0C131FBAF7C30F0D484BF83D97BBDEB0BF7D5B",
            recent.Checksum);
        Assert.Equal(recent.Checksum, Assert.Single(recent.AcceptedChecksums));
        Assert.Collection(recent.Steps, step =>
        {
            RawSqlStep sql = Assert.IsType<RawSqlStep>(step);
            Assert.Equal("RawSql", sql.Kind);
            Assert.Equal(6, Encoding.UTF8.GetByteCount(sql.Kind));
            Assert.Equal(8519, Encoding.UTF8.GetByteCount(sql.Sql));
            Assert.Equal(
                "506eaea98ec922430318a12d571fd3aac0b4b70f913707762209c1550dcb5d98",
                Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(sql.Sql))));
        });
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
