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
    public async Task MissingCanonicalScopeOwner_OriginalIssuerRefusesBeforeIssuingClaim(bool migration)
    {
        bool observed = false;
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
        {
            await using Harness host = await CreateAsync(migration, async refused =>
            {
                Assert.Equal(0, await refused.Db.Ado.GetIntAsync("SELECT count(*) FROM authoring_extension_approval_decision;"));
                Assert.Equal(0, await refused.Db.Ado.GetIntAsync("SELECT count(*) FROM authoring_extension_approval_event;"));
                AuthoringStateSnapshot state = await refused.ReadTargetAsync();
                Assert.Equal(migration ? 0 : 1, state.Revision);
                AuthoringLifecycleReceipt? current = await refused.Receipts.GetLatestAsync(refused.Target.Package.Contract.Manifest.Id, default);
                Assert.Equal(migration ? AuthoringLifecycleState.Enabled : AuthoringLifecycleState.RetainedData, current!.State);
                observed = true;
            }, issueOriginalScope: false);
        });
        Assert.Equal("approval_exact_scope_authority_unavailable", error.Message);
        Assert.True(observed);
    }

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
    [InlineData("unchanged", "production_approval_qualification_pending")]
    [InlineData("digest", "production_applied_snapshot_tampered")]
    [InlineData("revision", "production_applied_snapshot_binding_drift")]
    [InlineData("scope", "production_applied_snapshot_binding_drift")]
    [InlineData("receipt", "production_starting_generation_not_current")]
    public async Task OriginalV1_ConsumesRealFencedApply_AndRefusesUnqualifiedEffects(string mutation, string code)
    {
        await using Harness host = await CreateAsync(true);
        if (host.Target.Scope.DocumentId is not null)
        {
            await host.Target.StoreGrantAsync();
        }
        AuthoringExtensionProductionComposition composition = host.Compose();
        IAuthoringFencedLifecycleResourceAuthorityV1 resources = composition.Resources;
        Assert.Same(composition, resources);
        AuthoringStateSnapshot applied = await host.ApplyAsync();
        try
        {
            // The only snapshot input is the original Apply return. An ordinary
            // Read remains fenced, and no test opens that fence to make Prepare pass.
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await host.ReadTargetAsync());
            AuthoringLifecycleReceipt starting = await host.AppendStartingAsync(
                mutation == "receipt" ? host.Target.Package.PackageIdentity : host.Target.Package.Contract.Manifest.PackageSha256);
            AuthoringStateSnapshot supplied = mutation switch
            {
                "digest" => applied with { ContentSha256 = new string('f', 64) },
                "revision" => AuthoringExtensionStateContract.Snapshot(applied.Scope, applied.PackageIdentity,
                    applied.Revision + 1, applied.Entries),
                "scope" => AuthoringExtensionStateContract.Snapshot(applied.Scope with
                {
                    DocumentId = "other-document"
                },
                    applied.PackageIdentity, applied.Revision, applied.Entries),
                _ => applied
            };
            var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await resources.PrepareAsync(host.Target.Package, host.Target.Targets, supplied, starting.Generation + 1, default));
            Assert.Equal(code, error.Message);
            Assert.Equal(0, composition.HostResources.PublishedGenerations);
            Assert.Equal(starting, await host.Receipts.GetLatestAsync(starting.ExtensionId, default));
            using IAuthoringInstalledPackageReadScope held = await host.Target.Packages.ExecutionResolver
                .AcquireReadScopeAsync(host.Target.Package, default);
            Assert.Equal(host.Target.Package.PackageIdentity, held.ActivePackage.PackageIdentity);
            Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.Authority.ReadAsync(host.Claim.DecisionId)).Status);
        }
        finally
        {
            await host.RollbackAsync();
        }
    }

    [Theory]
    [InlineData("version")]
    [InlineData("schema")]
    public async Task OriginalIssuer_MustRejectMismatchedTerminalReceipt(string field)
    {
        await using Harness host = await CreateAsync(false);
        AuthoringExtensionApprovalExecutionResult execution = await host.DeleteAsync(host.Claim.ExpectedLifecycleReceipt.Generation + 1);
        AuthoringLifecycleReceipt result = Next(host.Claim.ExpectedLifecycleReceipt, AuthoringLifecycleState.Removed) with
        {
            ScopeDigest = execution.ContentSha256
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
        Exception? error = await Record.ExceptionAsync(async () => await host.Authority.CompleteAsync(host.Claim, execution, result));
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
        AuthoringStateSnapshot applied = await host.ApplyAsync();
        AuthoringLifecycleReceipt receipt = await host.AppendStartingAsync(host.Target.Package.Contract.Manifest.PackageSha256);
        AuthoringExtensionApprovalExecutionResult execution = AuthoringExtensionApprovalContract.MigrationResult(
            host.Claim, applied, host.Claim.OrderedOldTargets, host.Target.Targets, receipt.Generation + 1);
        await host.CompleteStateAsync();
        AuthoringLifecycleReceipt running = Sign(Next(receipt, AuthoringLifecycleState.Running) with
        {
            ScopeDigest = execution.ContentSha256
        });
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
        Task completion = host.Authority.CompleteAsync(host.Claim, execution, running, deadline.Token).AsTask();
        Task? advance = null;
        bool transactionCommitted = false;
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
            transactionCommitted = true;
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
            if (!transactionCommitted)
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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OriginalServerIssuance_CreatesRealExactClaim_WithoutDocumentGrantOrRuntimeAdmission(bool migration)
    {
        await using Harness host = await CreateAsync(migration);
        AuthoringExtensionProductionComposition composition = host.Compose();
        Assert.Null(host.Target.Scope.DocumentId);
        Assert.Matches("^[0-9a-f]{64}$", host.Target.Scope.UserId);
        Assert.NotEqual("1", host.Target.Scope.UserId);
        Assert.NotEqual("7", host.Target.Scope.UserId);
        Assert.Equal(host.Target.Scope.UserId, host.Claim.OperationContext.StateUserId);
        Assert.Equal(host.Target.Scope.DocumentId, host.Claim.OperationContext.DocumentId);
        Assert.Equal(migration ? 2 : 1, await host.Db.Ado.GetIntAsync(
            "SELECT count(*) FROM authoring_extension_scope_provenance WHERE status=1 AND creation_seen;"));
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.Authority.ReadAsync(host.Claim.DecisionId)).Status);
        Assert.Equal(new(0, 1), await composition.HostResources.InspectRegistrationsAsync(host.Target.Package, host.Target.Targets));
        AuthoringProductionPreflightObservation observation = await composition.Preflight.InspectAsync(host.Target.Package, host.Target.Targets);
        Assert.DoesNotContain("production_approval_claim_missing", observation.Blockers);
        Assert.Contains("production_document_grant_scope_unavailable", observation.Blockers);
        Assert.Contains("production_required_grant_missing", observation.Blockers);
        Assert.False(await composition.Preflight.HasRequiredPermissionsAsync(host.Target.Package, host.Target.Targets, default));
        Assert.False(await composition.Preflight.VerifyAsync(host.Target.Package, host.Target.Targets, default));
        Assert.Equal(0, composition.HostResources.PublishedGenerations);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task OriginalActorPinnedRecovery_BorrowsTheSameStateCustody_AndRefusesMissingRecordedHistory(bool recorded)
    {
        await using Harness host = await CreateAsync(true);
        AuthoringExtensionProductionComposition composition = host.Compose();
        AuthoringStateSnapshot actualApply = await host.ApplyAsync();
        await host.CompleteStateAsync();
        AuthoringStateSnapshot settled = await host.ReadTargetAsync();
        if (!recorded)
        {
            await host.Db.Ado.ExecuteCommandAsync("DELETE FROM authoring_extension_state_settlement;");
        }
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        await using (var actor = await host.ApprovalStore.BeginAsync(1, "production-approval-session",
            host.Target.Scope.SiteId, deadline.Token))
        {
            if (!recorded)
            {
                var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                    await composition.AcquireSettledStateCustodyAsync(actor.Connection, actor.Transaction, deadline.Token));
                Assert.Equal("state_settled_observation_not_recorded", error.Message);
            }
            else
            {
                await using IAuthoringExtensionStateObservation custody = await composition.AcquireSettledStateCustodyAsync(
                    actor.Connection, actor.Transaction, deadline.Token);
                Assert.Equal(AuthoringStateMigrationPhase.Completed, custody.State.Phase);
                Assert.Equal(settled.ContentSha256, custody.State.To!.Snapshot.ContentSha256);
                Assert.NotEqual(actualApply.Revision, custody.State.To.Snapshot.Revision);
                Assert.Equal(actualApply.Entries.Select(static entry => entry.Key),
                    custody.State.To.Snapshot.Entries.Select(static entry => entry.Key));
                foreach (AuthoringStateEntry entry in actualApply.Entries)
                {
                    Assert.Equal(entry.Value.ToArray(), custody.State.To.Snapshot.Entries.Single(item => item.Key == entry.Key).Value.ToArray());
                }
                using var writerCancellation = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
                await using NpgsqlConnection writer = await host.Source.OpenConnectionAsync(deadline.Token);
                await using var truncate = new NpgsqlCommand("TRUNCATE authoring_extension_state_scope CASCADE;", writer);
                Task<int> queued = truncate.ExecuteNonQueryAsync(writerCancellation.Token);
                try
                {
                    await host.WaitForLockAsync("query LIKE 'TRUNCATE authoring_extension_state_scope%' AND wait_event_type='Lock'", deadline.Token);
                    Assert.False(queued.IsCompleted);
                    // This exact original object is borrowed. A second state
                    // connection/SELECT would queue behind the real TRUNCATE.
                    await using IAuthoringExtensionApprovalScope access = await host.ScopeAuthority.AcquireWithStateCustodyAsync(
                        host.Context, AuthoringApprovalOperation.Migration, host.Claim.Scope, host.Claim.FrozenPlan!.To,
                        custody, deadline.Token);
                    await access.VerifyCurrentAsync(deadline.Token);
                    await custody.VerifyCurrentAsync(deadline.Token);
                }
                finally
                {
                    writerCancellation.Cancel();
                    _ = await Record.ExceptionAsync(async () => await queued);
                }
                // Borrower disposal does not dispose/reacquire the original scope.
                await custody.VerifyCurrentAsync(deadline.Token);
                Assert.Equal(settled.ContentSha256, custody.State.To!.Snapshot.ContentSha256);
            }
        }
        Assert.Equal(settled.ContentSha256, (await host.ReadTargetAsync()).ContentSha256);
        Assert.Equal(recorded ? 1 : 0, await host.Db.Ado.GetIntAsync("SELECT count(*) FROM authoring_extension_state_settlement;"));
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.Authority.ReadAsync(host.Claim.DecisionId)).Status);
        Assert.Equal(0, composition.HostResources.PublishedGenerations);
    }

    [Theory]
    [InlineData("document", "scope_document_authority_unavailable")]
    [InlineData("legacy-user", "scope_provenance_missing")]
    public async Task OriginalProvenance_RefusesUnissuedDocumentAndLegacyUser(string mutation, string code)
    {
        await using Harness host = await CreateAsync(false);
        AuthoringStateScope unissued = mutation == "document"
            ? host.Target.Scope with
            {
                DocumentId = "document-1"
            }
            : host.Target.Scope with
            {
                UserId = "7"
            };
        await host.State.InitializeAsync(host.Target.Package, unissued, default);
        AuthoringStateMeasurement measurement = await host.State.MeasureAsync(host.Target.Package, unissued, default);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        await using (var actor = await host.ApprovalStore.BeginAsync(1, "production-approval-session",
            host.Target.Scope.SiteId, deadline.Token))
        {
            await using IAuthoringExtensionStateObservation custody = await host.State.ObserveDeletionAsync(
                host.Target.Package, measurement, deadline.Token);
            var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await host.ScopeAuthority.AcquireWithStateCustodyAsync(host.Context, AuthoringApprovalOperation.Deletion,
                    unissued, null, custody, deadline.Token));
            Assert.Equal(code, error.Message);
            await custody.VerifyCurrentAsync(deadline.Token);
        }
        Assert.Equal(measurement, await host.State.MeasureAsync(host.Target.Package, unissued, default));
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.Authority.ReadAsync(host.Claim.DecisionId)).Status);
    }

    [Fact]
    public async Task OriginalCompletingIssuer_RejectsRealSettledStateAndRunningReceiptWithoutNativeGenerationCustody()
    {
        await using Harness host = await CreateAsync(true);
        AuthoringExtensionProductionComposition composition = host.Compose();
        AuthoringStateSnapshot actualApply = await host.ApplyAsync();
        await host.CompleteStateAsync();
        AuthoringLifecycleReceipt starting = await host.AppendStartingAsync(host.Target.Package.Contract.Manifest.PackageSha256);
        AuthoringExtensionApprovalExecutionResult data = AuthoringExtensionApprovalContract.MigrationResult(
            host.Claim, actualApply, host.Claim.OrderedOldTargets, host.Target.Targets, starting.Generation + 1);
        AuthoringLifecycleReceipt running = Sign(Next(starting, AuthoringLifecycleState.Running) with
        {
            ScopeDigest = data.ContentSha256
        });
        await host.Receipts.AppendAsync(running, default);
        // Actual state effects and a real durable receipt still cannot issue
        // missing process-bound/native and old-generation settlement lifetimes.
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await host.CompletingAuthority(composition).CompleteAsync(host.Claim, data, running));
        Assert.Equal("production_execution_generation_custody_unavailable", error.Message);
        Assert.Equal(running, await host.Receipts.GetLatestAsync(running.ExtensionId, default));
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.Authority.ReadAsync(host.Claim.DecisionId)).Status);
        Assert.Equal(0, composition.HostResources.PublishedGenerations);
    }

    private async Task<Harness> CreateAsync(bool migration, Func<Harness, Task>? verifyRefusal = null,
        bool issueOriginalScope = true)
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
        // Legacy controls retain the absent-scope refusal. Genuine controls use
        // only the original server issuer, insertion witness and scope authority;
        // no test scope or execution-result adapter manufactures approval.
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
        var approvalStore = new PostgresAuthoringExtensionApprovalStore(source, new EphemeralDataProtectionProvider());
        PostgresAuthoringExtensionScopeProvenanceStore? provenance = null;
        AuthoringExtensionScopeProvenanceAuthority? scopeAuthority = null;
        if (issueOriginalScope)
        {
            await db.Ado.ExecuteCommandAsync(AuthoringExtensionScopeProvenanceStorageSchema.CreateTablesSql);
            provenance = new(source, configuration);
            scopeAuthority = new(provenance);
        }
        var authority = new AuthoringExtensionApprovalAuthority(context, configuration,
            approvalStore, state, receipts, administrators, scopeAuthority);
        var host = new Harness(db, source, connection, cache, oldPackage, target, authority, state, receipts,
            approvalStore, scopeAuthority, context, configuration, administrators);
        try
        {
            if (issueOriginalScope)
            {
                var issuer = new AuthoringExtensionStateScopeIssuer(source, configuration, provenance!);
                AuthoringExtensionScopeRegistration first = await issuer.BeginAsync(context.HttpContext!, oldPackage.Package);
                oldPackage.UseIssuedStateScope(await issuer.CompleteAsync(context.HttpContext!, oldPackage.Package, first.RegistrationId));
                if (migration)
                {
                    AuthoringExtensionScopeRegistration next = await issuer.BeginAsync(context.HttpContext!, target.Package, oldPackage.Scope);
                    target.UseIssuedStateScope(await issuer.CompleteAsync(context.HttpContext!, target.Package, next.RegistrationId));
                }
            }
            else
            {
                await state.InitializeAsync(oldPackage.Package, oldPackage.Scope, default);
            }
            await state.WriteAsync(oldPackage.Package, oldPackage.Scope, 0, new("old", [1, 2]), default);
            AuthoringLifecycleReceipt receipt = Sign(new(1, 1, oldPackage.Package.Contract.Manifest.Id,
                oldPackage.Package.Contract.Manifest.PackageSha256, "1.0.0", 1, 1, AuthoringLifecycleState.Installed,
                AuthoringLifecycleState.Enabled, 1, new string('c', 64), null, new string('0', 64), ""));
            await receipts.AppendAsync(receipt, default);
            if (migration)
            {
                if (!issueOriginalScope)
                {
                    await state.InitializeAsync(target.Package, target.Scope, default);
                }
                AuthoringStateSnapshot snapshot = await state.ReadAsync(oldPackage.Package, oldPackage.Scope, default);
                AuthoringFencedStateMigration plan = AuthoringStateProcessWorker.Plan(snapshot, target.Scope) with
                {
                    MaximumDuration = TimeSpan.FromSeconds(1)
                };
                plan = plan with
                {
                    ContentSha256 = AuthoringExtensionStateContract.ComputeContentSha256(plan)
                };
                AuthoringExtensionApprovalPreview preview = await authority.PrepareMigrationAsync(oldPackage.Package, target.Package,
                    plan, oldPackage.Targets, target.Targets, receipt);
                string proof = await administrators.CreateAdminStepUpProofTokenAsync(1, "production-approval-session", "admin-sensitive", TimeSpan.FromMinutes(5));
                await authority.ConfirmMigrationAsync(preview.DecisionId, oldPackage.Package, target.Package,
                    plan, oldPackage.Targets, target.Targets, receipt, preview.Digest, proof);
                host.Claim = await authority.ClaimMigrationAsync(preview.DecisionId, oldPackage.Package, target.Package,
                    plan, oldPackage.Targets, target.Targets, receipt);
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
            try
            {
                if (verifyRefusal is not null)
                {
                    await verifyRefusal(host);
                }
            }
            finally
            {
                await host.DisposeAsync();
            }
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
        PostgresAuthoringLifecycleReceiptStore receipts, PostgresAuthoringExtensionApprovalStore approvalStore,
        AuthoringExtensionScopeProvenanceAuthority? scopeAuthority, ContextAccessor contexts,
        IConfigurationRoot configuration, AdminPrincipalService administrators) : IAsyncDisposable
    {
        private bool _settled;
        public SqlSugarClient Db => db;
        public NpgsqlDataSource Source => source;
        public PostgresAuthoringLifecycleReceiptStore Receipts => receipts;
        public AuthoringProductionPreflightFixture Target => target;
        public AuthoringProductionPreflightFixture OldPackage => oldPackage;
        public AuthoringExtensionApprovalAuthority Authority => authority;
        public PostgresAuthoringExtensionApprovalStore ApprovalStore => approvalStore;
        public AuthoringExtensionScopeProvenanceAuthority ScopeAuthority => scopeAuthority!;
        public HttpContext Context => contexts.HttpContext!;
        public PostgresAuthoringExtensionStateStore State => state;
        public AuthoringExtensionApprovalAuthority.ApprovedClaim Claim { get; set; } = null!;

        public AuthoringExtensionApprovalAuthority CompletingAuthority(AuthoringExtensionProductionComposition composition) =>
            new(contexts, configuration, approvalStore, state, receipts, administrators, scopeAuthority, composition.ExecutionResults);

        public async ValueTask<AuthoringStateSnapshot> ApplyAsync()
        {
            await state.BackupAsync(oldPackage.Package, target.Package, Claim.FrozenPlan!, default);
            return await state.ApplyAsync(oldPackage.Package, target.Package, Claim.FrozenPlan!, default);
        }

        public ValueTask<AuthoringStateSnapshot> ReadTargetAsync() => state.ReadAsync(target.Package, target.Scope, default);

        public ValueTask RollbackAsync() => state.RollbackAsync(oldPackage.Package, target.Package, Claim.FrozenPlan!, default);

        public ValueTask CompleteStateAsync() => state.CompleteAsync(oldPackage.Package, target.Package, Claim.FrozenPlan!, default);

        public async ValueTask<AuthoringExtensionApprovalExecutionResult> DeleteAsync(long generation)
        {
            await state.DeleteAsync(target.Package, Claim.FencedDeletion!, default);
            AuthoringStateMeasurement deleted = await state.MeasureAsync(target.Package, target.Scope, default);
            return AuthoringExtensionApprovalContract.DeletionResult(Claim, deleted, generation);
        }

        public async ValueTask<AuthoringLifecycleReceipt> AppendStartingAsync(string packageSha256)
        {
            AuthoringLifecycleReceipt receipt = Next(Claim.ExpectedLifecycleReceipt, AuthoringLifecycleState.Disabled);
            await receipts.AppendAsync(receipt, default);
            receipt = Next(receipt, AuthoringLifecycleState.Updating);
            await receipts.AppendAsync(receipt, default);
            receipt = Sign(Next(receipt, AuthoringLifecycleState.Migrating) with
            {
                PackageSha256 = packageSha256,
                Version = target.Package.Contract.Manifest.Version,
                StateSchemaVersion = target.Package.Contract.Manifest.StateSchemaVersion,
                DataSchemaVersion = target.Package.Contract.Manifest.DataSchemaVersion,
                ScopeDigest = Claim.Digest
            });
            await receipts.AppendAsync(receipt, default);
            receipt = Next(receipt, AuthoringLifecycleState.Starting);
            await receipts.AppendAsync(receipt, default);
            return receipt;
        }

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
