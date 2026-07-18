using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Catalogs;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SchemaMigrationCatalogTests
{
    [Fact]
    public void CurrentManifest_UsesVersionedCatalogsAndStableExecutionPlan()
    {
        SchemaMigrationManifest manifest = SchemaMigrationManifest.Current;

        Assert.Collection(
            manifest.Catalogs,
            catalog => Assert.Equal("legacy-bootstrap-20260418-20260518", catalog.CatalogId),
            catalog => Assert.Equal("identity-security-20260602-20260621", catalog.CatalogId),
            catalog => Assert.Equal("projection-integrity-20260625-20260704", catalog.CatalogId),
            catalog => Assert.Equal("current-20260709-20260716", catalog.CatalogId));
        Assert.Equal(91, manifest.Descriptors.Count);
        Assert.Equal(
            "751E83B2B6B03407E4F508B182BB46A25C6400FF6BFD516FABC56779F2D9E042",
            ComputePlanFingerprint(manifest.Descriptors));

        for (int index = 1; index < manifest.Descriptors.Count; index++)
        {
            Assert.True(
                SchemaMigrationExecutionOrder.Instance.Compare(
                    manifest.Descriptors[index - 1],
                    manifest.Descriptors[index]) < 0);
        }
    }

    [Fact]
    public void Create_RecompositionIsIdempotent()
    {
        SchemaMigrationManifest current = SchemaMigrationManifest.Current;

        SchemaMigrationManifest first = SchemaMigrationManifest.Create(
            current.Catalogs,
            current.DeclaredVersionGaps);
        SchemaMigrationManifest second = SchemaMigrationManifest.Create(
            current.Catalogs,
            current.DeclaredVersionGaps);

        Assert.Equal(
            first.Descriptors.Select(DescribeDescriptor),
            second.Descriptors.Select(DescribeDescriptor));
        Assert.Equal(
            ComputePlanFingerprint(current.Descriptors),
            ComputePlanFingerprint(first.Descriptors));
    }

    [Fact]
    public void Create_RejectsDuplicateMigrationIds()
    {
        SchemaMigrationCatalog catalog = CreateCatalog(
            "duplicate",
            new DateOnly(2026, 1, 1),
            [
                CreateDescriptor("20260101-pre-duplicate", SchemaMigrationPhase.PreCodeFirst),
                CreateDescriptor("20260101-pre-duplicate", SchemaMigrationPhase.PreCodeFirst)
            ]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([catalog], []));

        Assert.Contains("Duplicate schema migration ids", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_RejectsUnstableCatalogOrder()
    {
        SchemaMigrationCatalog catalog = CreateCatalog(
            "unstable",
            new DateOnly(2026, 1, 1),
            [
                CreateDescriptor("20260101-pre-b", SchemaMigrationPhase.PreCodeFirst),
                CreateDescriptor("20260101-pre-a", SchemaMigrationPhase.PreCodeFirst)
            ]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([catalog], []));

        Assert.Contains("stable execution order", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_RejectsMissingMigrationDependency()
    {
        SchemaMigrationCatalog first = CreateCatalog(
            "first",
            new DateOnly(2026, 1, 1),
            [CreateDescriptor("20260101-pre-first", SchemaMigrationPhase.PreCodeFirst)]);
        SchemaMigrationCatalog second = CreateCatalog(
            "second",
            new DateOnly(2026, 1, 2),
            [CreateDescriptor("20260102-pre-second", SchemaMigrationPhase.PreCodeFirst)],
            [new SchemaMigrationCatalogDependency("20260101-pre-missing", SchemaMigrationPhase.PreCodeFirst)]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([first, second], []));

        Assert.Contains("depends on missing migration", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_RejectsUndeclaredCatalogGap()
    {
        SchemaMigrationCatalog first = CreateCatalog(
            "first",
            new DateOnly(2026, 1, 1),
            [CreateDescriptor("20260101-pre-first", SchemaMigrationPhase.PreCodeFirst)]);
        SchemaMigrationCatalog second = CreateCatalog(
            "second",
            new DateOnly(2026, 1, 3),
            [CreateDescriptor("20260103-pre-second", SchemaMigrationPhase.PreCodeFirst)],
            [new SchemaMigrationCatalogDependency("20260101-pre-first", SchemaMigrationPhase.PreCodeFirst)]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([first, second], []));

        Assert.Contains("gaps do not match", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_RejectsMissingVersionFromContiguousCatalog()
    {
        var catalog = new SchemaMigrationCatalog(
            "contiguous",
            new DateOnly(2026, 1, 1),
            new DateOnly(2026, 1, 3),
            SchemaMigrationGapPolicy.ContiguousVersions,
            [],
            [
                CreateDescriptor("20260101-pre-first", SchemaMigrationPhase.PreCodeFirst),
                CreateDescriptor("20260103-pre-third", SchemaMigrationPhase.PreCodeFirst)
            ]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([catalog], []));

        Assert.Contains("missing 20260102", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_RejectsDescriptorOutsideCatalogRange()
    {
        var catalog = new SchemaMigrationCatalog(
            "wrong-range",
            new DateOnly(2026, 1, 2),
            new DateOnly(2026, 1, 2),
            SchemaMigrationGapPolicy.AllowSparseVersions,
            [],
            [CreateDescriptor("20260101-pre-first", SchemaMigrationPhase.PreCodeFirst)]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([catalog], []));

        Assert.Contains("falls outside catalog", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_RejectsMigrationIdPhaseMismatch()
    {
        SchemaMigrationCatalog catalog = CreateCatalog(
            "wrong-phase",
            new DateOnly(2026, 1, 1),
            [CreateDescriptor("20260101-pre-first", SchemaMigrationPhase.PostCodeFirst)]);

        InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
            () => SchemaMigrationManifest.Create([catalog], []));

        Assert.Contains("descriptor phase", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SourceLayout_PreventsLegacyRegistryDescriptorAggregation()
    {
        string migrationRoot = BackendTestPaths.FromRoot(
            "src",
            "backend",
            "Infrastructure",
            "SchemaMigration");
        string registrySource = File.ReadAllText(Path.Combine(migrationRoot, "SchemaMigrationRegistry.cs"));
        string[] legacyRegistryPartials = Directory.GetFiles(
            migrationRoot,
            "SchemaMigrationRegistry.*.cs",
            SearchOption.TopDirectoryOnly);
        string[] definitionFiles = Directory.GetFiles(
            Path.Combine(migrationRoot, "Definitions"),
            "*.cs",
            SearchOption.TopDirectoryOnly);
        int descriptorDefinitionCount = definitionFiles
            .Select(File.ReadAllText)
            .Sum(static source => Regex.Matches(source, "new SchemaMigrationDescriptor\\(").Count);

        Assert.Empty(legacyRegistryPartials);
        Assert.DoesNotContain("partial class SchemaMigrationRegistry", registrySource, StringComparison.Ordinal);
        Assert.DoesNotContain("new SchemaMigrationDescriptor(", registrySource, StringComparison.Ordinal);
        Assert.DoesNotContain("Build", registrySource, StringComparison.Ordinal);
        Assert.Equal(91, descriptorDefinitionCount);
        Assert.All(
            definitionFiles.Select(File.ReadAllText),
            static source => Assert.DoesNotContain("partial class", source, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(nameof(User.IdentityKind), "anonymous_account")]
    [InlineData(nameof(User.AnonymousCredentialLevel), "basic")]
    [InlineData(nameof(User.AnonymousCredentialStatus), "active")]
    public void UserStringDefaults_UseUnquotedSqlSugarLiterals(
        string propertyName,
        string expectedDefault)
    {
        object attribute = typeof(User)
            .GetProperty(propertyName)!
            .GetCustomAttributes(inherit: false)
            .Single(static item => item.GetType().Name == "SugarColumn");
        string actualDefault = Assert.IsType<string>(
            attribute.GetType().GetProperty("DefaultValue")?.GetValue(attribute));

        Assert.Equal(expectedDefault, actualDefault);
        Assert.DoesNotContain("'", actualDefault, StringComparison.Ordinal);
    }

    private static SchemaMigrationCatalog CreateCatalog(
        string catalogId,
        DateOnly version,
        IReadOnlyList<ISchemaMigrationDescriptor> descriptors,
        IReadOnlyList<SchemaMigrationCatalogDependency>? dependencies = null)
        => new(
            catalogId,
            version,
            version,
            SchemaMigrationGapPolicy.AllowSparseVersions,
            dependencies ?? [],
            descriptors);

    private static ISchemaMigrationDescriptor CreateDescriptor(
        string migrationId,
        SchemaMigrationPhase phase)
        => new SchemaMigrationDescriptor(
            migrationId,
            $"Fixture for {migrationId}.",
            phase,
            Transactional: true,
            Steps: []);

    private static string ComputePlanFingerprint(IReadOnlyList<ISchemaMigrationDescriptor> descriptors)
    {
        string plan = string.Join('\n', descriptors.Select(DescribeDescriptor));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(plan)));
    }

    private static string DescribeDescriptor(ISchemaMigrationDescriptor descriptor)
        => $"{descriptor.Phase}|{descriptor.MigrationId}|{descriptor.Checksum}";
}
