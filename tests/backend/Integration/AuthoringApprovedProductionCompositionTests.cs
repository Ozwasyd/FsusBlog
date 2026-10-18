using System.Collections.Immutable;
using System.Security.Claims;

using Fido2NetLib;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using Npgsql;

using SqlSugar;

using StackExchange.Redis;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringApprovedProductionCompositionTests(
    PostgresSchemaMigrationFixture postgres,
    PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task GenuineClaim_BindsOriginalContextAndScope_WithoutRuntimeAdmission(bool migration)
    {
        await using Harness host = await CreateAsync(migration);
        AuthoringExtensionProductionComposition composition = host.Compose();
        Assert.Same(host.Claim, composition.ApprovalClaim);
        Assert.Same(host.Authority, composition.Approvals);
        Assert.Equal(host.Claim.OperationContext, composition.OperationContext);
        Assert.Equal("7", composition.OperationContext!.StateUserId);
        Assert.NotEqual("1", composition.OperationContext.StateUserId);
        Assert.Equal(host.Target.Scope.SiteId, composition.OperationContext.SiteId);
        Assert.Equal(host.Target.Scope.DocumentId, composition.OperationContext.DocumentId);
        await host.Target.StoreGrantAsync();

        AuthoringProductionPreflightObservation observed = await composition.Preflight.InspectAsync(
            host.Target.Package, host.Target.Targets);
        Assert.Equal(host.Target.Package.PackageIdentity, observed.PackageIdentity);
        Assert.DoesNotContain("production_approval_claim_missing", observed.Blockers);
        Assert.Contains("production_grant_operation_binding_unavailable", observed.Blockers);
        Assert.Contains("production_approval_qualification_pending", observed.Blockers);
        Assert.Contains("production_starting_publication_ports_unavailable", observed.Blockers);
        Assert.Equal(host.Claim.ExpectedLifecycleReceipt.ReceiptSha256, observed.LifecycleReceiptSha256);
        Assert.True(await composition.Preflight.HasRequiredPermissionsAsync(host.Target.Package, host.Target.Targets, default));
        Assert.False(await composition.Preflight.VerifyAsync(host.Target.Package, host.Target.Targets, default));
        Assert.Equal(new(0, 1), await composition.HostResources.InspectRegistrationsAsync(host.Target.Package, host.Target.Targets));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await composition.HostResources.ActivateAtomicallyAsync(host.Target.Package, host.Target.Targets, default));
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.Authority.ReadAsync(host.Claim.DecisionId)).Status);
    }

    [Theory]
    [InlineData("session")]
    [InlineData("permission")]
    [InlineData("xmin")]
    [InlineData("settled")]
    public async Task BoundClaim_RevalidatesRealActorAndDurableStatus(string mutation)
    {
        await using Harness host = await CreateAsync(false);
        AuthoringExtensionProductionComposition composition = host.Compose();
        switch (mutation)
        {
            case "session":
                await host.Db.Ado.ExecuteCommandAsync("UPDATE admin_session SET revokedatutc=clock_timestamp();");
                break;
            case "permission":
                await host.Db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET permissions='';");
                break;
            case "xmin":
                await host.Db.Ado.ExecuteCommandAsync("UPDATE admin_principal SET validationversion=validationversion+1;");
                break;
            case "settled":
                await host.SettleAsync();
                break;
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await composition.HostResources.InspectRegistrationsAsync(host.Target.Package, host.Target.Targets));
    }

    [Fact]
    public async Task BoundClaim_RefusesExpiredCapabilityWithoutReissuingOrCompletingIt()
    {
        await using Harness host = await CreateAsync(false);
        host.Target.Clock.Now = host.Claim.ExpiresAt.AddTicks(1);
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await host.Compose().Preflight.InspectAsync(host.Target.Package, host.Target.Targets));
        Assert.Equal("production_approval_claim_expired", error.Message);
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.Authority.ReadAsync(host.Claim.DecisionId)).Status);
    }

    [Fact]
    public async Task BoundClaim_RefusesDifferentResultPackageIdentity()
    {
        await using Harness host = await CreateAsync(false);
        VerifiedAuthoringPackage wrong = host.Target.Package with
        {
            PackageIdentity = new string('e', 64)
        };
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await host.Compose().Preflight.InspectAsync(wrong, host.Target.Targets));
        Assert.Equal("production_approval_result_package_drift", error.Message);
    }

    [Theory]
    [InlineData("user")]
    [InlineData("document")]
    public async Task IssuedClaim_CannotBeReboundToWiderConsumerScope(string field)
    {
        await using Harness host = await CreateAsync(false);
        AuthoringStateScope wider = field == "user"
            ? host.Target.Scope with
            {
                UserId = "other-user"
            }
            : host.Target.Scope with
            {
                DocumentId = "other-document"
            };
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await host.Compose(wider).Preflight.InspectAsync(host.Target.Package, host.Target.Targets));
        Assert.Equal("production_approval_scope_drift", error.Message);
    }

    [Theory]
    [InlineData("version")]
    [InlineData("schema")]
    public async Task OriginalIssuer_MustRejectMismatchedTerminalReceipt(string field)
    {
        await using Harness host = await CreateAsync(false);
        AuthoringLifecycleReceipt result = Next(host.Claim.ExpectedLifecycleReceipt, AuthoringLifecycleState.Removed) with
        {
            ScopeDigest = host.Claim.Digest
        };
        result = Sign(field == "version" ? result with
        {
            Version = "9.0.0"
        }
            : result with
            {
                StateSchemaVersion = 77,
                DataSchemaVersion = 88
            });
        await host.Receipts.AppendAsync(result, default);
        Exception? error = await Record.ExceptionAsync(async () => await host.Authority.CompleteAsync(host.Claim, result));
        if (error is null)
        {
            host.MarkSettledForCleanup();
        }
        // An actual issuer false acceptance is a failing cross-owner control,
        // never an expectation weakened to qualify an unsafe dependency head.
        Assert.IsType<AuthoringExtensionContractException>(error);
    }

    [Fact]
    public async Task OriginalIssuer_MustFenceRunningReceiptAcrossSettlement()
    {
        await using Harness host = await CreateAsync(true);
        AuthoringLifecycleReceipt receipt = Next(host.Claim.ExpectedLifecycleReceipt, AuthoringLifecycleState.Disabled);
        await host.Receipts.AppendAsync(receipt, default);
        receipt = Next(receipt, AuthoringLifecycleState.Updating);
        await host.Receipts.AppendAsync(receipt, default);
        receipt = Sign(Next(receipt, AuthoringLifecycleState.Migrating) with
        {
            PackageSha256 = host.Target.Package.PackageIdentity,
            Version = host.Target.Package.Contract.Manifest.Version,
            ScopeDigest = host.Claim.Digest
        });
        await host.Receipts.AppendAsync(receipt, default);
        receipt = Next(receipt, AuthoringLifecycleState.Starting);
        await host.Receipts.AppendAsync(receipt, default);
        AuthoringLifecycleReceipt running = Next(receipt, AuthoringLifecycleState.Running);
        await host.Receipts.AppendAsync(running, default);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        await using NpgsqlConnection blocker = await host.Source.OpenConnectionAsync(deadline.Token);
        await using NpgsqlTransaction transaction = await blocker.BeginTransactionAsync(deadline.Token);
        await using (var command = new NpgsqlCommand(
            "SELECT decision_id FROM authoring_extension_approval_decision WHERE decision_id=$1 FOR UPDATE;", blocker))
        {
            command.Parameters.AddWithValue(host.Claim.DecisionId);
            await command.ExecuteScalarAsync(deadline.Token);
        }
        Task completion = host.Authority.CompleteAsync(host.Claim, running, deadline.Token).AsTask();
        Task? advance = null;
        try
        {
            while (!completion.IsCompleted && !await host.HasLockAsync(
                "query LIKE '%FROM authoring_extension_approval_decision%FOR UPDATE%' AND wait_event_type='Lock'", deadline.Token))
            {
                await Task.Delay(20, deadline.Token);
            }
            if (completion.IsCompleted)
            {
                Exception? early = await Record.ExceptionAsync(async () => await completion);
                if (early is null)
                {
                    host.MarkSettledForCleanup();
                }
                Assert.IsType<AuthoringExtensionContractException>(early);
                return;
            }
            advance = host.Receipts.AppendAsync(Next(running, AuthoringLifecycleState.Degraded), deadline.Token).AsTask();
            bool serialized = false;
            while (!advance.IsCompleted)
            {
                if (await host.HasLockAsync("query LIKE '%pg_advisory_xact_lock%' AND wait_event='advisory'", deadline.Token))
                {
                    serialized = true;
                    break;
                }
                await Task.Delay(20, deadline.Token);
            }
            if (!serialized)
            {
                await advance;
            }
            await transaction.CommitAsync(deadline.Token);
            Exception? error = await Record.ExceptionAsync(async () => await completion);
            if (error is null)
            {
                host.MarkSettledForCleanup();
            }
            if (serialized)
            {
                Assert.Null(error);
                await advance;
            }
            else
            {
                Assert.IsType<AuthoringExtensionContractException>(error);
            }
        }
        finally
        {
            if (transaction.Connection is not null)
            {
                await transaction.RollbackAsync();
            }
            _ = await Record.ExceptionAsync(async () => await completion);
            if (completion.IsCompletedSuccessfully)
            {
                host.MarkSettledForCleanup();
            }
            if (advance is not null)
            {
                _ = await Record.ExceptionAsync(async () => await advance);
            }
        }
    }

    private async Task<Harness> CreateAsync(bool migration)
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres);
        SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        AuthoringProductionPreflightFixture oldPackage = await AuthoringProductionPreflightFixture.CreateAsync(now: DateTimeOffset.UtcNow);
        AuthoringProductionPreflightFixture target = migration
            ? await AuthoringProductionPreflightFixture.CreateAsync(now: DateTimeOffset.UtcNow, version: "2.0.0")
            : oldPackage;
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminPrincipal), typeof(AdminSession));
        await db.Ado.ExecuteCommandAsync(AuthoringExtensionStateStorageSchema.CreateTablesSql);
        await db.Ado.ExecuteCommandAsync(AuthoringExtensionApprovalStorageSchema.CreateTablesSql);
        await db.Ado.ExecuteCommandAsync("""
            CREATE TABLE authoring_lifecycle_receipt (
                schema_version integer NOT NULL, sequence bigint NOT NULL, extension_id text NOT NULL,
                package_sha256 text NOT NULL, version text NOT NULL, state_schema_version integer NOT NULL,
                data_schema_version integer NOT NULL, previous_state integer NOT NULL, state integer NOT NULL,
                generation bigint NOT NULL, scope_digest text NOT NULL, failure_code text NULL,
                previous_receipt_sha256 text NOT NULL, receipt_sha256 text NOT NULL,
                PRIMARY KEY(extension_id,sequence)
            );
            """);
        db.Insertable(new AdminPrincipal { Handle = "production-approval", Permissions = AdminPermissions.SystemConfig }).ExecuteCommand();
        db.Insertable(new AdminSession
        {
            SessionId = "production-approval-session",
            AdminPrincipalId = 1,
            IdleExpiresAtUtc = DateTime.UtcNow.AddMinutes(30),
            AbsoluteExpiresAtUtc = DateTime.UtcNow.AddHours(1)
        }).ExecuteCommand();
        ConnectionMultiplexer connection = await redis.ConnectAsync();
        var cache = new UnifiedCache(connection, new CachePolicyRegistry(), new RuntimeScope(), NullLogger<UnifiedCache>.Instance);
        IConfigurationRoot configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AuthoringExtensions:SiteId"] = oldPackage.Scope.SiteId
        }).Build();
        // Only off-path FIDO/JWT/audit collaborators are substituted. The exercised
        // step-up proof issuer/one-time consumer, Redis, SQL actor checks, durable
        // approval issuer, package verification, state and receipts are real.
        var administrators = new AdminPrincipalService(Substitute.For<IFido2>(), db, cache, cache,
            Substitute.For<IJwtHelper>(), configuration, NullLogger<AdminPrincipalService>.Instance,
            Substitute.For<IAdminAuditLogChannel>());
        var context = new ContextAccessor
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[]
                {
                    new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
                    new Claim("admin_id", "1"), new Claim("admin_sid", "production-approval-session")
                }, "production-approval-fixture"))
            }
        };
        var source = NpgsqlDataSource.Create(connectionString);
        var state = new PostgresAuthoringExtensionStateStore(db);
        var receipts = new PostgresAuthoringLifecycleReceiptStore(db);
        var authority = new AuthoringExtensionApprovalAuthority(context, configuration,
            new PostgresAuthoringExtensionApprovalStore(source, new EphemeralDataProtectionProvider()), state, receipts, administrators);
        var host = new Harness(db, source, connection, cache, oldPackage, target, authority, state, receipts);
        try
        {
            await state.InitializeAsync(oldPackage.Package, oldPackage.Scope, default);
            await state.WriteAsync(oldPackage.Package, oldPackage.Scope, 0, new("old", [1, 2]), default);
            AuthoringLifecycleReceipt receipt = Sign(new(1, 1, oldPackage.Package.Contract.Manifest.Id,
                oldPackage.Package.PackageIdentity, "1.0.0", 1, 1, AuthoringLifecycleState.Installed,
                AuthoringLifecycleState.Enabled, 1, new string('c', 64), null, new string('0', 64), ""));
            await receipts.AppendAsync(receipt, default);
            if (migration)
            {
                await state.InitializeAsync(target.Package, target.Scope, default);
                AuthoringStateSnapshot snapshot = await state.ReadAsync(oldPackage.Package, oldPackage.Scope, default);
                AuthoringFencedStateMigration plan = AuthoringStateProcessWorker.Plan(snapshot, target.Scope) with
                {
                    MaximumDuration = TimeSpan.FromSeconds(1)
                };
                plan = plan with
                {
                    ContentSha256 = AuthoringExtensionStateContract.ComputeContentSha256(plan)
                };
                AuthoringExtensionApprovalPreview preview = await authority.PrepareMigrationAsync(oldPackage.Package, target.Package, plan, receipt);
                string proof = await administrators.CreateAdminStepUpProofTokenAsync(1, "production-approval-session", "admin-sensitive", TimeSpan.FromMinutes(5));
                await authority.ConfirmMigrationAsync(preview.DecisionId, oldPackage.Package, target.Package, plan, receipt, preview.Digest, proof);
                host.Claim = await authority.ClaimMigrationAsync(preview.DecisionId, oldPackage.Package, target.Package, plan, receipt);
            }
            else
            {
                receipt = Next(receipt, AuthoringLifecycleState.Uninstalling);
                await receipts.AppendAsync(receipt, default);
                receipt = Next(receipt, AuthoringLifecycleState.RetainedData);
                await receipts.AppendAsync(receipt, default);
                AuthoringExtensionApprovalPreview preview = await authority.PrepareDeletionAsync(oldPackage.Package, oldPackage.Scope, receipt);
                string proof = await administrators.CreateAdminStepUpProofTokenAsync(1, "production-approval-session", "admin-sensitive", TimeSpan.FromMinutes(5));
                await authority.ConfirmDeletionAsync(preview.DecisionId, oldPackage.Package, preview.Measurement!, receipt, preview.Digest, proof);
                host.Claim = await authority.ClaimDeletionAsync(preview.DecisionId, oldPackage.Package, preview.Measurement!, receipt);
            }
            return host;
        }
        catch
        {
            await host.DisposeAsync();
            throw;
        }
    }

    private static AuthoringLifecycleReceipt Next(AuthoringLifecycleReceipt previous, AuthoringLifecycleState next) => Sign(previous with
    {
        Sequence = previous.Sequence + 1,
        Generation = previous.Generation + 1,
        PreviousState = previous.State,
        State = next,
        PreviousReceiptSha256 = previous.ReceiptSha256
    });

    private static AuthoringLifecycleReceipt Sign(AuthoringLifecycleReceipt receipt) => receipt with
    {
        ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(receipt)
    };

    private sealed class ContextAccessor : IHttpContextAccessor
    {
        public HttpContext? HttpContext
        {
            get; set;
        }
    }

    private sealed class RuntimeScope : IRuntimeKeyScope
    {
        public string ScopeToken { get; } = "fsus-preflight-approval-" + Guid.NewGuid().ToString("N") + ":";
        public string PrefixKey(string key) => ScopeToken + key;
    }

    private sealed class Harness(SqlSugarClient db, NpgsqlDataSource source, ConnectionMultiplexer connection,
        UnifiedCache cache, AuthoringProductionPreflightFixture oldPackage, AuthoringProductionPreflightFixture target,
        AuthoringExtensionApprovalAuthority authority, PostgresAuthoringExtensionStateStore state,
        PostgresAuthoringLifecycleReceiptStore receipts) : IAsyncDisposable
    {
        private bool _settled;
        public SqlSugarClient Db => db;
        public NpgsqlDataSource Source => source;
        public PostgresAuthoringLifecycleReceiptStore Receipts => receipts;
        public AuthoringProductionPreflightFixture Target => target;
        public AuthoringExtensionApprovalAuthority Authority => authority;
        public AuthoringExtensionApprovalAuthority.ApprovedClaim Claim { get; set; } = null!;

        public AuthoringExtensionProductionComposition Compose(AuthoringStateScope? suppliedScope = null)
        {
            if (suppliedScope is not null)
            {
                return new(target.Packages, target.Grants, state, receipts, target.Clock, AuthoringHostPlatform.ServerLinux,
                    suppliedScope, AuthoringProductionPreflightFixture.Purpose, new([], [], [], [], []),
                    ImmutableHashSet<string>.Empty, new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([])),
                    approvalAuthority: authority, approvedClaim: Claim);
            }
            return AuthoringExtensionProductionComposition.ForApprovedOperation(
                target.Packages, target.Grants, state, receipts, target.Clock, AuthoringHostPlatform.ServerLinux,
                authority, Claim, AuthoringProductionPreflightFixture.Purpose, new([], [], [], [], []),
                ImmutableHashSet<string>.Empty, new AuthorSavedViewQueryValidator(new AuthorSavedViewDependencyCatalog([])));
        }

        public void MarkSettledForCleanup() => _settled = true;

        public async Task<bool> HasLockAsync(string predicate, CancellationToken token)
        {
            await using NpgsqlConnection connection = await source.OpenConnectionAsync(token);
            await using var command = new NpgsqlCommand(
                $"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND {predicate};", connection);
            return Convert.ToInt64(await command.ExecuteScalarAsync(token)) > 0;
        }

        public async Task WaitForLockAsync(string predicate, CancellationToken token)
        {
            while (!await HasLockAsync(predicate, token))
            {
                await Task.Delay(20, token);
            }
        }

        public async ValueTask SettleAsync()
        {
            await authority.SettleFailureAsync(Claim, AuthoringApprovalStatus.RecoveryRequired);
            _settled = true;
        }

        public async ValueTask DisposeAsync()
        {
            if (Claim is not null && !_settled)
            {
                await SettleAsync();
            }
            cache.Dispose();
            await connection.DisposeAsync();
            await source.DisposeAsync();
            db.Dispose();
            target.Dispose();
            if (!ReferenceEquals(target, oldPackage))
            {
                oldPackage.Dispose();
            }
        }
    }
}
