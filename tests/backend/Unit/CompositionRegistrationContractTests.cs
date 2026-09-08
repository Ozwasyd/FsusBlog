using System.Text.Json;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CompositionRegistrationContractTests
{
    private const string ReplacementTestId =
        "xunit:tests/backend/Unit/CompositionRegistrationContractTests.cs#CompositionRegistrationContractTests.CatalogEntry_MatchesCanonicalCompositionAndResolutionSemantics";

    public static TheoryData<string> CatalogEntryIds
        => new(RegistrationCatalog.Entries.Select(static entry => entry.Id));

    [Theory]
    [MemberData(nameof(CatalogEntryIds))]
    public void CatalogEntry_MatchesCanonicalCompositionAndResolutionSemantics(string catalogEntryId)
    {
        RegistrationExpectation entry = Assert.Single(
            RegistrationCatalog.Entries,
            candidate => candidate.Id == catalogEntryId);
        ServiceCollection services = RegistrationCatalog.Compose(entry.CompositionRoot);

        Assert.Empty(ValidateRegistration(services, entry));
        AssertResolutionSemantics(entry.Lifetime);
    }

    [Fact]
    public void CatalogInventory_MapsEveryRetiredRegistrationTestToTheCanonicalContract()
    {
        string inventoryPath = BackendTestPaths.FromRoot(
            "tests",
            "backend",
            "Fixtures",
            "composition-registration-replacements.json");
        using JsonDocument inventory = JsonDocument.Parse(File.ReadAllText(inventoryPath));
        JsonElement records = inventory.RootElement.GetProperty("records");

        Assert.Equal(RegistrationCatalog.Entries.Count, records.GetArrayLength());
        Assert.Equal(
            RegistrationCatalog.Entries.Select(static entry => entry.Id).Order(StringComparer.Ordinal),
            records.EnumerateArray()
                .Select(static record => record.GetProperty("catalogEntryId").GetString())
                .Order(StringComparer.Ordinal));
        Assert.All(records.EnumerateArray(), static record =>
        {
            Assert.Equal(ReplacementTestId, record.GetProperty("replacementTestId").GetString());
            Assert.StartsWith("xunit:tests/backend/Unit/", record.GetProperty("retiredTestId").GetString(), StringComparison.Ordinal);
        });
    }

    [Fact]
    public void Validator_RejectsMissingRegistration()
    {
        RegistrationExpectation entry = RegistrationCatalog.Entries[0];

        Assert.Contains(
            ValidateRegistration(new ServiceCollection(), entry),
            error => error.Contains("missing registration", StringComparison.Ordinal));
    }

    [Fact]
    public void Validator_RejectsWrongImplementation()
    {
        RegistrationExpectation entry = RegistrationCatalog.Entries[0];
        IServiceCollection services = new ServiceCollection();
        services.Add(ServiceDescriptor.Describe(entry.ServiceType, typeof(object), entry.Lifetime));

        Assert.Contains(
            ValidateRegistration(services, entry),
            error => error.Contains("implementation", StringComparison.Ordinal));
    }

    [Fact]
    public void Validator_RejectsWrongLifetime()
    {
        RegistrationExpectation entry = RegistrationCatalog.Entries[0];
        ServiceLifetime wrongLifetime = entry.Lifetime == ServiceLifetime.Singleton
            ? ServiceLifetime.Scoped
            : ServiceLifetime.Singleton;
        IServiceCollection services = new ServiceCollection();
        services.Add(ServiceDescriptor.Describe(entry.ServiceType, entry.ImplementationType, wrongLifetime));

        Assert.Contains(
            ValidateRegistration(services, entry),
            error => error.Contains("lifetime", StringComparison.Ordinal));
    }

    [Fact]
    public void Validator_RejectsUndeclaredDuplicateRegistration()
    {
        RegistrationExpectation entry = RegistrationCatalog.Entries[0];
        ServiceDescriptor descriptor = ServiceDescriptor.Describe(
            entry.ServiceType,
            entry.ImplementationType,
            entry.Lifetime);
        IServiceCollection services = new ServiceCollection();
        services.Add(descriptor);
        services.Add(descriptor);

        Assert.Contains(
            ValidateRegistration(services, entry),
            error => error.Contains("multiplicity", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("Development", true, false, true)]
    [InlineData("Development", false, true, true)]
    [InlineData("Development", false, false, false)]
    [InlineData("Production", true, true, false)]
    public void CommentFixtureComposition_IsActualHostDevelopmentAndFlagBound(
        string hostEnvironmentName,
        bool allowLocalCommentFixture,
        bool allowLocalAuthFixture,
        bool expectedRegistered)
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                // Deliberately conflicts with the Production host test case.
                ["ASPNETCORE_ENVIRONMENT"] = Environments.Development,
                ["fsus:allowLocalCommentFixture"] = allowLocalCommentFixture.ToString(),
                [LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey] = allowLocalAuthFixture.ToString()
            })
            .Build();
        IHostEnvironment hostEnvironment = Substitute.For<IHostEnvironment>();
        hostEnvironment.EnvironmentName.Returns(hostEnvironmentName);
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices(configuration, hostEnvironment);

        Type[] fixtureServices =
        [
            typeof(ICommentThreadFixturePort),
            typeof(ICommentModerationFixturePort),
            typeof(ICommentAnonymousFixtureCapabilityVault),
            typeof(ICommentAnonymousFixtureOperationLedger),
            typeof(ICommentAnonymousFixtureProvider),
            typeof(ICommentFixtureSeeder)
        ];
        Assert.All(fixtureServices, serviceType => Assert.Equal(
            expectedRegistered,
            services.Any(descriptor => descriptor.ServiceType == serviceType)));
    }

    [Fact]
    public void CommentFixtureComposition_NoConfigurationOverloadFailsClosed()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        Assert.DoesNotContain(services, descriptor =>
            descriptor.ServiceType == typeof(ICommentThreadFixturePort)
            || descriptor.ServiceType == typeof(ICommentModerationFixturePort)
            || descriptor.ServiceType == typeof(ICommentAnonymousFixtureCapabilityVault)
            || descriptor.ServiceType == typeof(ICommentAnonymousFixtureOperationLedger)
            || descriptor.ServiceType == typeof(ICommentAnonymousFixtureProvider)
            || descriptor.ServiceType == typeof(ICommentFixtureSeeder));
    }

    private static IReadOnlyList<string> ValidateRegistration(
        IServiceCollection services,
        RegistrationExpectation entry)
    {
        ServiceDescriptor[] registrations = services
            .Where(candidate => candidate.ServiceType == entry.ServiceType)
            .ToArray();
        var errors = new List<string>();
        if (registrations.Length == 0)
        {
            errors.Add($"{entry.Id}: missing registration");
            return errors;
        }
        if (registrations.Length != entry.ExpectedMultiplicity && !entry.AllowReplace)
        {
            errors.Add($"{entry.Id}: registration multiplicity expected {entry.ExpectedMultiplicity}, received {registrations.Length}");
        }
        foreach (ServiceDescriptor registration in registrations)
        {
            if (registration.ImplementationType != entry.ImplementationType)
            {
                errors.Add($"{entry.Id}: implementation expected {entry.ImplementationType}, received {registration.ImplementationType}");
            }
            if (registration.Lifetime != entry.Lifetime)
            {
                errors.Add($"{entry.Id}: lifetime expected {entry.Lifetime}, received {registration.Lifetime}");
            }
        }
        return errors;
    }

    private static void AssertResolutionSemantics(ServiceLifetime lifetime)
    {
        IServiceCollection services = new ServiceCollection();
        services.Add(ServiceDescriptor.Describe(typeof(ResolutionProbe), typeof(ResolutionProbe), lifetime));
        using ServiceProvider provider = services.BuildServiceProvider(validateScopes: true);
        using IServiceScope firstScope = provider.CreateScope();
        using IServiceScope secondScope = provider.CreateScope();
        ResolutionProbe first = firstScope.ServiceProvider.GetRequiredService<ResolutionProbe>();
        ResolutionProbe sameScope = firstScope.ServiceProvider.GetRequiredService<ResolutionProbe>();
        ResolutionProbe otherScope = secondScope.ServiceProvider.GetRequiredService<ResolutionProbe>();

        if (lifetime == ServiceLifetime.Singleton)
        {
            Assert.Same(first, sameScope);
            Assert.Same(first, otherScope);
        }
        else if (lifetime == ServiceLifetime.Scoped)
        {
            Assert.Same(first, sameScope);
            Assert.NotSame(first, otherScope);
        }
        else
        {
            Assert.NotSame(first, sameScope);
            Assert.NotSame(first, otherScope);
        }
    }

    private sealed class ResolutionProbe;

    private sealed record RegistrationExpectation(
        string Id,
        Type ServiceType,
        Type ImplementationType,
        ServiceLifetime Lifetime,
        CompositionRoot CompositionRoot,
        int ExpectedMultiplicity = 1,
        bool AllowReplace = false);

    private enum CompositionRoot
    {
        RuntimeDomain,
        RuntimeInfrastructure,
        RuntimePublicAot,
    }

    private static class RegistrationCatalog
    {
        public static IReadOnlyList<RegistrationExpectation> Entries
        {
            get;
        } =
        [
            Scoped<ICommentAttributionPrivacyService, CommentAttributionPrivacyService>(
                "comment-attribution-privacy",
                CompositionRoot.RuntimeDomain),
            Scoped<ICommentQueryService, CommentQueryService>("comment-query", CompositionRoot.RuntimeDomain),
            Scoped<ICommentNotificationService, CommentNotificationService>("comment-notification", CompositionRoot.RuntimeDomain),
            Scoped<ICommentModerationService, CommentModerationService>("comment-moderation", CompositionRoot.RuntimeDomain),
            Scoped<IPublicAotArtifactStore, PublicAotArtifactStore>("public-aot-artifact-store", CompositionRoot.RuntimePublicAot),
            Scoped<IPublicAotDocumentComposition, PublicAotDocumentComposition>("public-aot-document-composition", CompositionRoot.RuntimePublicAot),
            Singleton<IPublicAotRuntimeState, PublicAotRuntimeState>("public-aot-runtime-state", CompositionRoot.RuntimePublicAot),
            Scoped<IAdminArtifactOperations, AdminArtifactOperations>("admin-artifact-operations", CompositionRoot.RuntimeInfrastructure),
            Scoped<IAdminIntegrityOperations, AdminIntegrityOperations>("admin-integrity-operations", CompositionRoot.RuntimeInfrastructure),
            Scoped<IAdminOperationsHealthReader, AdminOperationsHealthReader>("admin-operations-health", CompositionRoot.RuntimeInfrastructure),
            Scoped<IAdminCacheDiagnosticsReader, AdminCacheDiagnosticsReader>("admin-cache-diagnostics", CompositionRoot.RuntimeInfrastructure),
            Singleton<IAdminDangerousOperationPolicyReader, AdminDangerousOperationPolicyReader>("admin-dangerous-operation-policy", CompositionRoot.RuntimeInfrastructure),
            Singleton<IAdminBackupStatusReader, AdminBackupStatusReader>("admin-backup-status", CompositionRoot.RuntimeInfrastructure),
        ];

        public static ServiceCollection Compose(CompositionRoot root)
        {
            var services = new ServiceCollection();
            switch (root)
            {
                case CompositionRoot.RuntimeDomain:
                    services.AddFsusRuntimeDomainServices();
                    break;
                case CompositionRoot.RuntimeInfrastructure:
                    services.AddFsusRuntimeInfrastructureServices(new ConfigurationBuilder().Build());
                    break;
                case CompositionRoot.RuntimePublicAot:
                    services.AddFsusRuntimePublicAotServices();
                    break;
                default:
                    throw new ArgumentOutOfRangeException(nameof(root), root, null);
            }
            return services;
        }

        private static RegistrationExpectation Scoped<TService, TImplementation>(
            string id,
            CompositionRoot root)
            where TService : class
            where TImplementation : class, TService
            => new(id, typeof(TService), typeof(TImplementation), ServiceLifetime.Scoped, root);

        private static RegistrationExpectation Singleton<TService, TImplementation>(
            string id,
            CompositionRoot root)
            where TService : class
            where TImplementation : class, TService
            => new(id, typeof(TService), typeof(TImplementation), ServiceLifetime.Singleton, root);
    }
}
