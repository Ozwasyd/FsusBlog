using SqlSugar;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringProductionPreflightTests
{
    [Fact]
    public async Task CallerReadyFlagsAndScalarIdentity_CannotSupplyNativeLease()
    {
        var caller = new CallerReadyOwner();
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionProductionComposition.ObserveWorker(caller));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await AuthoringExtensionProductionComposition.ObserveServiceAsync(caller));
        Assert.Equal(0, caller.HealthReads);
    }

    [Fact]
    public async Task RealPackageReadScope_ValidatesSignedMetadataAndIsolatedRegistryOwner()
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient unavailable = UnavailableDatabase();
        AuthoringExtensionProductionComposition composition = fixture.Compose(unavailable);
        AuthoringProductionRegistryObservation result = await composition.HostResources.InspectRegistrationsAsync(
            fixture.Package, fixture.Targets);
        Assert.Equal(new(0, 1), result);
        // Repetition proves preparation published no registration and released the store lifetime.
        Assert.Equal(result, await composition.HostResources.InspectRegistrationsAsync(fixture.Package, fixture.Targets));
        using IAuthoringInstalledPackageReadScope held = await fixture.Packages.ExecutionResolver.AcquireReadScopeAsync(fixture.Package, default);
        Assert.Equal(fixture.Package.PackageIdentity, held.ActivePackage.PackageIdentity);
        // Independent original-owner positive control. This private test registry
        // publishes metadata only; it is not the production composition or enable.
        var registry = new AuthoringFilterRegistryAuthority(new VerifiedPackageAuthoringFilterSource(),
            new([], [], [], [], []), new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([])));
        registry.ActivateAtomically(held.ActivePackage, fixture.Targets);
        AuthoringRegisteredFilter registered = Assert.Single(registry.Snapshot());
        Assert.Equal(held.ActivePackage.PackageIdentity, registered.PackageIdentity);
        Assert.Equal(fixture.Targets[0], registered.Target);
        registry.Remove(fixture.Package.Contract.Manifest.Id);
        Assert.Empty(registry.Snapshot());
    }

    [Theory]
    [InlineData("runtime")]
    [InlineData("entrypoint")]
    [InlineData("kind")]
    [InlineData("class")]
    [InlineData("adapter")]
    [InlineData("version")]
    [InlineData("blocked")]
    public async Task ReadyTarget_WithDriftCannotAuthorizeRegistry(string mutation)
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient unavailable = UnavailableDatabase();
        AuthoringExecutionTarget target = fixture.Targets[0];
        target = mutation switch
        {
            "runtime" => target with { RuntimeIdentity = new string('d', 64) },
            "entrypoint" => target with { EntrypointIdentity = "worker/other.wasm" },
            "kind" => target with { ContributionKind = AuthoringContributionKind.Command },
            "class" => target with { ExecutionClass = AuthoringExecutionClass.OutOfProcessService },
            "adapter" => target with { TrustedAdapterIdentity = new string('d', 64) },
            "version" => target with { ExtensionVersion = "2.0.0" },
            _ => target with { Status = AuthoringExecutionResolutionStatus.BlockedIdentityDrift }
        };
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Compose(unavailable).HostResources.InspectRegistrationsAsync(fixture.Package, [target]));
        Assert.Equal("production_target_exact_mapping_required", error.Message);
    }

    [Theory]
    [InlineData(AuthoringHostPlatform.Browser)]
    [InlineData(AuthoringHostPlatform.AvaloniaDesktop)]
    [InlineData((AuthoringHostPlatform)99)]
    public async Task UnsupportedPhysicalPlatform_IsRefused(AuthoringHostPlatform platform)
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient unavailable = UnavailableDatabase();
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Compose(unavailable, platform).HostResources.InspectRegistrationsAsync(fixture.Package, fixture.Targets));
        Assert.Equal("production_platform_unsupported", error.Message);
    }

    [Fact]
    public async Task BusyOriginalPackageScope_IsRefusedWithoutReentryDeadlock()
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient unavailable = UnavailableDatabase();
        // The resolver waits on the original held store gate; caller cancellation
        // must settle that wait without attempting nested package acquisition.
        using IAuthoringInstalledPackageReadScope held = await fixture.Packages.ExecutionResolver.AcquireReadScopeAsync(fixture.Package, default);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(1));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await fixture.Compose(unavailable).HostResources.InspectRegistrationsAsync(
                fixture.Package, fixture.Targets, cancellation.Token));
    }

    [Fact]
    public async Task MissingSignedMetadata_IsRefusedByOriginalFilterSource()
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync(omitMetadata: true);
        using SqlSugarClient unavailable = UnavailableDatabase();
        var error = await Assert.ThrowsAsync<AuthoringFilterContractException>(async () =>
            await fixture.Compose(unavailable).HostResources.InspectRegistrationsAsync(fixture.Package, fixture.Targets));
        Assert.Equal("filter_package_entry_missing", error.Code);
    }

    [Fact]
    public async Task ExpiredRealPublisherKey_IsRefusedAndScopeIsReleased()
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient unavailable = UnavailableDatabase();
        fixture.Clock.Now += TimeSpan.FromHours(2);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Compose(unavailable).HostResources.InspectRegistrationsAsync(fixture.Package, fixture.Targets));
        fixture.Clock.Now -= TimeSpan.FromHours(2);
        Assert.Equal(1, (await fixture.Compose(unavailable).HostResources.InspectRegistrationsAsync(fixture.Package, fixture.Targets)).Filters);
    }

    [Theory]
    [InlineData("host-api")]
    [InlineData("budget")]
    [InlineData("schema")]
    public async Task ForgedVerifiedRecord_CannotChangeContract(string mutation)
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient unavailable = UnavailableDatabase();
        AuthoringExtensionManifest manifest = fixture.Package.Contract.Manifest;
        manifest = mutation switch
        {
            "host-api" => manifest with { HostApi = new(2, 2) },
            "budget" => manifest with { Limits = manifest.Limits with { MaximumQueueDepth = int.MaxValue } },
            _ => manifest with { DataSchemaVersion = 2 }
        };
        VerifiedAuthoringPackage forged = fixture.Package with
        {
            Contract = fixture.Package.Contract with
            {
                Manifest = manifest
            }
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Compose(unavailable).HostResources.InspectRegistrationsAsync(forged, fixture.Targets));
    }

    [Theory]
    [InlineData("site")]
    [InlineData("document")]
    [InlineData("expired")]
    [InlineData("revoked")]
    public async Task RealGrantCatalog_RefusesWrongOrEndedScope(string mutation)
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient unavailable = UnavailableDatabase();
        AuthoringCapabilityGrant grant = await fixture.StoreGrantAsync(
            site: mutation == "site" ? "other-site" : null, document: mutation == "document" ? "other-document" : null);
        if (mutation == "expired")
        {
            fixture.Clock.Now += TimeSpan.FromMinutes(6);
        }
        if (mutation == "revoked")
        {
            await fixture.Grants.RevokeAsync(grant.GrantId, default);
        }
        Assert.False(await fixture.Compose(unavailable).Preflight.HasRequiredPermissionsAsync(fixture.Package, fixture.Targets, default));
    }

    internal static SqlSugarClient UnavailableDatabase() => new(new ConnectionConfig
    {
        DbType = SqlSugar.DbType.PostgreSQL,
        ConnectionString = "Host=127.0.0.1;Port=1;Database=unconfigured;Username=unconfigured;Timeout=1",
        IsAutoCloseConnection = true
    });

    // Deliberately untrusted negative control. This is neither a runtime provider
    // nor evidence of a successful native launch or production admission.
    private sealed class CallerReadyOwner : IAuthoringWorkerSandboxInstance, IAuthoringServiceProcess
    {
        public int HealthReads
        {
            get; private set;
        }
        public AuthoringWorkerCapabilityReport CapabilityReport => new(false, false, false, false, false,
            false, false, false, [], [], true, new string('a', 64));
        public AuthoringProcessOwnershipReport Ownership => new(AuthoringProcessOwnershipMechanism.LinuxCgroup,
            true, true, new string('a', 64));
        public ValueTask<AuthoringServiceHealthReport> GetHealthAsync(CancellationToken cancellationToken)
        {
            HealthReads++;
            return ValueTask.FromResult(new AuthoringServiceHealthReport(true, new string('a', 64),
                new string('b', 64), "schema/service-v1"));
        }
        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(AuthoringWorkerRequest request, CancellationToken cancellationToken)
            => throw new InvalidOperationException("Negative control cannot execute.");
        public ValueTask<AuthoringServiceResponse> ExecuteAsync(AuthoringServiceRequest request, CancellationToken cancellationToken)
            => throw new InvalidOperationException("Negative control cannot execute.");
        public ValueTask TerminateAsync(string reason, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask TerminateTreeAsync(string reason, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
