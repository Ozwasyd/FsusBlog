using SqlSugar;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AuthoringProductionPreflightPostgresTests(PostgresSchemaMigrationFixture postgres)
{
    [Fact]
    public async Task RealOwners_InspectExactStateGrantReceipt_WithoutEnableOrLiveIncarnation()
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient db = await DatabaseAsync();
        var state = new PostgresAuthoringExtensionStateStore(db);
        await state.InitializeAsync(fixture.Package, fixture.Scope, default);
        await state.WriteAsync(fixture.Package, fixture.Scope, 0, new("cursor", [1, 2, 3]), default);
        var receipts = new PostgresAuthoringLifecycleReceiptStore(db);
        AuthoringLifecycleReceipt receipt = Receipt(fixture.Package);
        await receipts.AppendAsync(receipt, default);
        await fixture.StoreGrantAsync();
        AuthoringExtensionProductionComposition composition = fixture.Compose(db);

        AuthoringProductionPreflightObservation observed = await composition.Preflight.InspectAsync(fixture.Package, fixture.Targets);
        Assert.Equal(1, observed.StateRevision);
        Assert.Equal(receipt.ReceiptSha256, observed.LifecycleReceiptSha256);
        Assert.DoesNotContain("production_required_grant_missing", observed.Blockers);
        Assert.Contains("production_approval_claim_missing", observed.Blockers);
        Assert.Contains("production_worker_launch_provider_missing", observed.Blockers);
        Assert.True(await composition.Preflight.HasRequiredPermissionsAsync(fixture.Package, fixture.Targets, default));
        Assert.False(await composition.Preflight.VerifyAsync(fixture.Package, fixture.Targets, default));
        Assert.Equal(new(0, 1), await composition.HostResources.InspectRegistrationsAsync(fixture.Package, fixture.Targets));
        var failure = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await composition.HostResources.ActivateAtomicallyAsync(fixture.Package, fixture.Targets, default));
        Assert.Equal("production_starting_publication_ports_unavailable", failure.Message);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await composition.Coordinator.EnableAsync(fixture.Package, fixture.Targets));
        Assert.Equal(receipt, await receipts.GetLatestAsync(fixture.Package.Contract.Manifest.Id, default));
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_lifecycle_receipt;"));
    }

    [Fact]
    public async Task MissingGrants_OriginalCoordinatorRecordsOnlyPermissionPending()
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient db = await DatabaseAsync();
        AuthoringExtensionProductionComposition composition = fixture.Compose(db);
        AuthoringLifecycleReceipt receipt = await composition.Coordinator.EnableAsync(fixture.Package, fixture.Targets);
        Assert.Equal(AuthoringLifecycleState.PermissionPending, receipt.State);
        Assert.Equal(1, receipt.Generation);
        Assert.Equal(new(0, 1), await composition.HostResources.InspectRegistrationsAsync(fixture.Package, fixture.Targets));
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_lifecycle_receipt;"));
    }

    [Theory]
    [InlineData("site")]
    [InlineData("user")]
    [InlineData("document")]
    public async Task StateIsNotBorrowedAcrossHostObservationScopes(string field)
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient db = await DatabaseAsync();
        await new PostgresAuthoringExtensionStateStore(db).InitializeAsync(fixture.Package, fixture.Scope, default);
        AuthoringStateScope other = field switch
        {
            "site" => fixture.Scope with { SiteId = "other-site" },
            "user" => fixture.Scope with { UserId = "8" },
            _ => fixture.Scope with { DocumentId = "other-document" }
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Compose(db, scope: other).Preflight.InspectAsync(fixture.Package, fixture.Targets));
        Assert.Equal(1, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_extension_state_scope;"));
    }

    [Fact]
    public async Task FencedState_IsRejectedByOriginalPersistentOwner()
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient db = await DatabaseAsync();
        await new PostgresAuthoringExtensionStateStore(db).InitializeAsync(fixture.Package, fixture.Scope, default);
        await db.Ado.ExecuteCommandAsync("UPDATE authoring_extension_state_scope SET fence = @Fence;",
            new SugarParameter("@Fence", new string('a', 64)));
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Compose(db).Preflight.InspectAsync(fixture.Package, fixture.Targets));
        Assert.Equal("state_scope_fenced", error.Message);
    }

    [Fact]
    public async Task StateAboveManifestBudget_IsRejectedWithoutChangingState()
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync(manifest => manifest with
        {
            Limits = manifest.Limits with
            {
                MaximumStateBytes = 1
            }
        });
        using SqlSugarClient db = await DatabaseAsync();
        var state = new PostgresAuthoringExtensionStateStore(db);
        await state.InitializeAsync(fixture.Package, fixture.Scope, default);
        await state.WriteAsync(fixture.Package, fixture.Scope, 0, new("value", [1, 2]), default);
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Compose(db).Preflight.InspectAsync(fixture.Package, fixture.Targets));
        Assert.Equal("production_state_budget_or_revision_drift", error.Message);
        Assert.Equal(1, (await state.ReadAsync(fixture.Package, fixture.Scope, default)).Revision);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WrongOrTamperedReceipt_IsRejectedByDurableChain(bool tampered)
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient db = await DatabaseAsync();
        await new PostgresAuthoringExtensionStateStore(db).InitializeAsync(fixture.Package, fixture.Scope, default);
        AuthoringLifecycleReceipt receipt = Receipt(fixture.Package);
        if (!tampered)
        {
            receipt = Sign(receipt with
            {
                PackageSha256 = new string('e', 64)
            });
        }
        await new PostgresAuthoringLifecycleReceiptStore(db).AppendAsync(receipt, default);
        if (tampered)
        {
            await db.Ado.ExecuteCommandAsync("UPDATE authoring_lifecycle_receipt SET receipt_sha256 = @Digest;",
                new SugarParameter("@Digest", new string('e', 64)));
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Compose(db).Preflight.InspectAsync(fixture.Package, fixture.Targets));
    }

    [Fact]
    public async Task RevocationSettlesRealGrants_ThenRefusesUnknownRemainingResources()
    {
        using var fixture = await AuthoringProductionPreflightFixture.CreateAsync();
        using SqlSugarClient db = await DatabaseAsync();
        AuthoringCapabilityGrant grant = await fixture.StoreGrantAsync();
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Compose(db).HostResources.RevokeAllAsync(fixture.Package.Contract.Manifest.Id, default));
        Assert.Equal("production_remaining_resource_ports_unavailable", error.Message);
        Assert.Null(await fixture.Grants.FindAsync(grant.GrantId, default));
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(*) FROM authoring_lifecycle_receipt;"));
    }

    private async Task<SqlSugarClient> DatabaseAsync()
    {
        SqlSugarClient db = PostgresSqlSugarTestClient.Create(
            await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres));
        try
        {
            await db.Ado.ExecuteCommandAsync(AuthoringExtensionStateStorageSchema.CreateTablesSql);
            // Same test-only leaf table as the receipt producer tests. Production
            // migrations and schema admission are not installed by this test.
            await db.Ado.ExecuteCommandAsync("""
                CREATE TABLE authoring_lifecycle_receipt (
                    schema_version INTEGER NOT NULL, sequence BIGINT NOT NULL,
                    extension_id VARCHAR(256) COLLATE "C" NOT NULL,
                    package_sha256 VARCHAR(64) NOT NULL, version VARCHAR(256) NOT NULL,
                    state_schema_version INTEGER NOT NULL, data_schema_version INTEGER NOT NULL,
                    previous_state INTEGER NOT NULL, state INTEGER NOT NULL, generation BIGINT NOT NULL,
                    scope_digest VARCHAR(64) NOT NULL, failure_code VARCHAR(128),
                    previous_receipt_sha256 VARCHAR(64) NOT NULL, receipt_sha256 VARCHAR(64) NOT NULL,
                    PRIMARY KEY (extension_id, sequence)
                );
                """);
            return db;
        }
        catch
        {
            db.Dispose();
            throw;
        }
    }

    private static AuthoringLifecycleReceipt Receipt(VerifiedAuthoringPackage package) => Sign(new(
        1, 1, package.Contract.Manifest.Id, package.Contract.Manifest.PackageSha256, package.Contract.Manifest.Version,
        1, 1, AuthoringLifecycleState.Installed, AuthoringLifecycleState.Enabled, 1, package.PackageIdentity,
        null, new string('0', 64), ""));

    private static AuthoringLifecycleReceipt Sign(AuthoringLifecycleReceipt receipt) => receipt with
    {
        ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(receipt)
    };
}
