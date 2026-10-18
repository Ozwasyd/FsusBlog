using System.Security.Claims;

using Fido2NetLib;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using Npgsql;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AuthoringExtensionApprovalPostgresTests(
    PostgresSchemaMigrationFixture postgres,
    PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    [Fact]
    public async Task Migration_RequiresExplicitExactConfirmationAndClaimsOnceAcrossConnections()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        Assert.Equal(AuthoringApprovalStatus.Pending, pending.Status);
        Assert.NotNull(pending.FrozenPlan);
        Assert.Equal(host.To, pending.DestinationScope);
        Assert.Equal(1, pending.Records);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(pending).AsTask());
        string proof = await host.ProofAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.ConfirmMigrationAsync(
            pending.DecisionId, host.OldPackage, host.NewPackage, host.Plan, host.Receipt, new string('0', 64), proof).AsTask());
        await host.ConfirmMigrationAsync(pending, proof);
        // An independently constructed issuer uses independent SQL connections and the same real key ring.
        AuthoringExtensionApprovalAuthority second = host.NewAuthority();
        Task<AuthoringExtensionApprovalAuthority.ApprovedClaim>[] attempts =
        [host.ClaimMigrationAsync(pending).AsTask(), second.ClaimMigrationAsync(
            pending.DecisionId, host.OldPackage, host.NewPackage, host.Plan, host.Receipt).AsTask()];
        foreach (Task attempt in attempts)
        {
            _ = await Record.ExceptionAsync(async () => await attempt);
        }
        Assert.Equal(1, attempts.Count(attempt => attempt.IsCompletedSuccessfully));
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim = attempts.Single(attempt => attempt.IsCompletedSuccessfully).Result;
        Assert.Equal(pending.Digest, claim.Digest);
        Assert.Equal(pending.OperationContext, claim.OperationContext);
        Assert.Equal(1, claim.OperationContext.ContractVersion);
        Assert.Equal(host.From.UserId, claim.OperationContext.StateUserId);
        Assert.Equal("system-config-site-state-admin-v1", claim.OperationContext.AuthorizationPolicy);
        Assert.Equal(host.Plan.ContentSha256, claim.FrozenPlan!.ContentSha256);
        Assert.Null(claim.FencedDeletion);
        Assert.Equal(3, await host.ScalarAsync("SELECT count(*) FROM authoring_extension_approval_event;"));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(pending).AsTask());
    }

    [Fact]
    public async Task ConcurrentSessionRevocation_WaitsForClaimTransactionAndThenBlocksFurtherUse()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        await using NpgsqlConnection blocker = await host.OpenConnectionAsync();
        await using NpgsqlTransaction transaction = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("SELECT pg_advisory_xact_lock(hashtextextended($1,0));", blocker))
        {
            command.Parameters.AddWithValue($"authoring-lifecycle-receipt:{host.Receipt.ExtensionId}");
            await command.ExecuteNonQueryAsync();
        }
        Task<AuthoringExtensionApprovalAuthority.ApprovedClaim> claim = host.ClaimMigrationAsync(pending).AsTask();
        await host.WaitForDatabaseLockAsync("query LIKE '%pg_advisory_xact_lock%' AND wait_event='advisory'");
        Task revoke = host.ExecuteIndependentAsync("UPDATE admin_session SET revokedatutc=clock_timestamp() WHERE sessionid='first-session';");
        await host.WaitForDatabaseLockAsync("query LIKE 'UPDATE admin_session SET revokedatutc%' AND wait_event_type='Lock'");
        Assert.False(revoke.IsCompleted);
        await transaction.CommitAsync();
        Assert.Equal(pending.DecisionId, (await claim).DecisionId);
        await revoke;
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(pending).AsTask());
    }

    [Fact]
    public async Task Deletion_UsesExactRetainedBackupMeasurementAndOriginalFencedDeletion()
    {
        await using Harness host = await CreateAsync();
        await host.State.BackupAsync(host.OldPackage, host.NewPackage, host.Plan, default);
        await host.State.RollbackAsync(host.OldPackage, host.NewPackage, host.Plan, default);
        await host.RetainAsync();
        AuthoringExtensionApprovalPreview pending = await host.Authority.PrepareDeletionAsync(host.OldPackage, host.From, host.Receipt);
        Assert.Equal(2, pending.Measurement!.Records);
        Assert.Equal(4, pending.Measurement.Bytes);
        Assert.Equal("purge-current-and-retained-backups", pending.Retention);
        await host.ConfirmDeletionAsync(pending);
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim = await host.ClaimDeletionAsync(pending);
        Assert.Equal(pending.Measurement, claim.FencedDeletion!.Expected);
        await host.State.DeleteAsync(host.OldPackage, claim.FencedDeletion, default);
        Assert.Equal(0, (await host.State.MeasureAsync(host.OldPackage, host.From, default)).Records);
        await host.Authority.SettleFailureAsync(claim, AuthoringApprovalStatus.RecoveryRequired);
        Assert.Equal(AuthoringApprovalStatus.RecoveryRequired, (await host.Authority.ReadAsync(pending.DecisionId)).Status);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimDeletionAsync(pending).AsTask());
    }

    [Theory]
    [InlineData("actor")]
    [InlineData("session")]
    [InlineData("site")]
    [InlineData("permission")]
    [InlineData("principal-version")]
    [InlineData("session-version")]
    [InlineData("principal-disabled")]
    [InlineData("revoked")]
    [InlineData("expired-session")]
    public async Task Claim_RejectsRealActorPermissionSessionAndXminDrift(string drift)
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        switch (drift)
        {
            case "actor":
                host.Context.HttpContext = Context(2, "second-session");
                break;
            case "session":
                host.Context.HttpContext = Context(1, "second-session");
                break;
            case "site":
                host.Configuration["AuthoringExtensions:SiteId"] = "other-site";
                break;
            case "permission":
                await host.ExecuteAsync("UPDATE admin_principal SET permissions='' WHERE id=1;");
                break;
            case "principal-version":
                await host.ExecuteAsync("UPDATE admin_principal SET validationversion=validationversion+1 WHERE id=1;");
                break;
            case "session-version":
                await host.ExecuteAsync("UPDATE admin_session SET validationversion=validationversion+1 WHERE sessionid='first-session';");
                break;
            case "principal-disabled":
                await host.ExecuteAsync("UPDATE admin_principal SET status='disabled' WHERE id=1;");
                break;
            case "revoked":
                await host.ExecuteAsync("UPDATE admin_session SET revokedatutc=clock_timestamp() WHERE sessionid='first-session';");
                break;
            case "expired-session":
                await host.ExecuteAsync("UPDATE admin_session SET idleexpiresatutc=clock_timestamp()-interval '1 minute' WHERE sessionid='first-session';");
                break;
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(pending).AsTask());
        Assert.Equal((long)AuthoringApprovalStatus.Approved, await host.ScalarAsync("SELECT status FROM authoring_extension_approval_decision;"));
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("state")]
    [InlineData("lifecycle")]
    [InlineData("operation")]
    public async Task Claim_RejectsWrongFrozenPlanStateGenerationAndOperation(string drift)
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        if (drift == "plan")
        {
            host.Plan = host.Plan with
            {
                PlanId = "other-exact-plan"
            };
            host.Plan = host.Plan with
            {
                ContentSha256 = AuthoringExtensionStateContract.ComputeContentSha256(host.Plan)
            };
        }
        if (drift == "state")
        {
            await host.State.WriteAsync(host.OldPackage, host.From, 1, new("old", [3, 4]), default);
        }
        if (drift == "lifecycle")
        {
            await host.Receipts.AppendAsync(NextReceipt(host.Receipt, AuthoringLifecycleState.Disabled), default);
        }
        if (drift == "operation")
        {
            AuthoringStateMeasurement measurement = await host.State.MeasureAsync(host.OldPackage, host.From, default);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.ClaimDeletionAsync(
                pending.DecisionId, host.OldPackage, measurement, host.Receipt).AsTask());
        }
        else
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(pending).AsTask());
        }
    }

    [Fact]
    public async Task Deletion_RejectsSameCountsWithDifferentStateBytes()
    {
        await using Harness host = await CreateAsync();
        await host.RetainAsync();
        AuthoringExtensionApprovalPreview pending = await host.Authority.PrepareDeletionAsync(host.OldPackage, host.From, host.Receipt);
        await host.ConfirmDeletionAsync(pending);
        await host.State.WriteAsync(host.OldPackage, host.From, 1, new("old", [8, 9]), default);
        AuthoringStateMeasurement changed = await host.State.MeasureAsync(host.OldPackage, host.From, default);
        Assert.Equal(pending.Measurement!.Records, changed.Records);
        Assert.Equal(pending.Measurement.Bytes, changed.Bytes);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimDeletionAsync(pending).AsTask());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DeniedOrRevoked_StaysDurableAndCannotClaim(bool revoke)
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        if (revoke)
        {
            await host.ConfirmMigrationAsync(pending);
            await host.Authority.RevokeAsync(pending.DecisionId);
        }
        else
        {
            await host.Authority.DenyAsync(pending.DecisionId);
        }
        Assert.Equal(revoke ? AuthoringApprovalStatus.Revoked : AuthoringApprovalStatus.Denied,
            (await host.NewAuthority().ReadAsync(pending.DecisionId)).Status);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(pending).AsTask());
    }

    [Fact]
    public async Task ExistingRealAdminOneTimeProof_IsIdentityOnlyAndCannotApproveTwoPlans()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview first = await host.PrepareMigrationAsync();
        AuthoringStateScope secondFrom = host.From with
        {
            UserId = "another-state-user"
        };
        AuthoringStateScope secondTo = host.To with
        {
            UserId = "another-state-user"
        };
        await host.State.InitializeAsync(host.OldPackage, secondFrom, default);
        await host.State.InitializeAsync(host.NewPackage, secondTo, default);
        AuthoringFencedStateMigration secondPlan = AuthoringStateProcessWorker.Plan(await host.State.ReadAsync(host.OldPackage, secondFrom, default), secondTo, []);
        AuthoringExtensionApprovalPreview second = await host.Authority.PrepareMigrationAsync(host.OldPackage, host.NewPackage, secondPlan, host.Receipt);
        string proof = await host.ProofAsync();
        await host.ConfirmMigrationAsync(first, proof);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.ConfirmMigrationAsync(second.DecisionId,
            host.OldPackage, host.NewPackage, secondPlan, host.Receipt, second.Digest, proof).AsTask());
        Assert.Equal(AuthoringApprovalStatus.Pending, (await host.Authority.ReadAsync(second.DecisionId)).Status);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(second).AsTask());
    }

    [Fact]
    public async Task SameEffect_CannotObtainAnotherDecisionEvenWithAnotherPlanIdAfterLostClaimResponse()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        _ = await host.ClaimMigrationAsync(pending);
        host.Plan = host.Plan with
        {
            PlanId = "replacement-after-lost-response"
        };
        host.Plan = host.Plan with
        {
            ContentSha256 = AuthoringExtensionStateContract.ComputeContentSha256(host.Plan)
        };
        PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => host.PrepareMigrationAsync().AsTask());
        Assert.Equal(PostgresErrorCodes.UniqueViolation, error.SqlState);
        Assert.Equal(1, await host.ScalarAsync("SELECT count(*) FROM authoring_extension_approval_decision;"));
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.NewAuthority().ReadAsync(pending.DecisionId)).Status);
    }

    [Fact]
    public async Task ConfirmationFailure_RollsBackDecisionAndAuditWithoutInventingApproval()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        await host.ExecuteAsync("ALTER TABLE authoring_extension_approval_event ADD CONSTRAINT injected_failure CHECK (revision=0);");
        string consumedProof = await host.ProofAsync();
        Assert.NotNull(await Record.ExceptionAsync(async () => await host.ConfirmMigrationAsync(pending, consumedProof)));
        Assert.Equal(AuthoringApprovalStatus.Pending, (await host.NewAuthority().ReadAsync(pending.DecisionId)).Status);
        Assert.Equal(1, await host.ScalarAsync("SELECT count(*) FROM authoring_extension_approval_event;"));
        await host.ExecuteAsync("ALTER TABLE authoring_extension_approval_event DROP CONSTRAINT injected_failure;");
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ConfirmMigrationAsync(pending, consumedProof).AsTask());
        await host.ConfirmMigrationAsync(pending);
        _ = await host.ClaimMigrationAsync(pending);
    }

    [Fact]
    public async Task RestartAfterClaim_MarksRecoveryAndNeverReissuesCapability()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        _ = await host.ClaimMigrationAsync(pending);
        await host.Receipts.AppendAsync(NextReceipt(host.Receipt, AuthoringLifecycleState.Disabled), default);
        AuthoringExtensionApprovalAuthority restarted = host.NewAuthority();
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await restarted.ReadAsync(pending.DecisionId)).Status);
        Assert.Equal(AuthoringApprovalStatus.RecoveryRequired, (await restarted.MarkInterruptedAsync(pending.DecisionId)).Status);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(pending).AsTask());
    }

    [Fact]
    public async Task CompletedClaim_RequiresDurableExactOperationReceiptAndSettlesIdempotently()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim = await host.ClaimMigrationAsync(pending);
        AuthoringLifecycleReceipt unrelated = NextReceipt(host.Receipt, AuthoringLifecycleState.Disabled);
        await host.Receipts.AppendAsync(unrelated, default);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.CompleteAsync(claim, unrelated).AsTask());
        AuthoringLifecycleReceipt updating = NextReceipt(unrelated, AuthoringLifecycleState.Updating);
        await host.Receipts.AppendAsync(updating, default);
        AuthoringLifecycleReceipt migrating = NextReceipt(updating, AuthoringLifecycleState.Migrating) with
        {
            PackageSha256 = host.NewPackage.PackageIdentity,
            Version = host.NewPackage.Contract.Manifest.Version,
            StateSchemaVersion = host.NewPackage.Contract.Manifest.StateSchemaVersion,
            ScopeDigest = claim.Digest
        };
        result = result with
        {
            ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(result)
        };
        await host.Receipts.AppendAsync(result, default);
        await host.NewAuthority().CompleteAsync(claim, result);
        await host.NewAuthority().CompleteAsync(claim, result);
        Assert.Equal(AuthoringApprovalStatus.Completed, (await host.Authority.ReadAsync(pending.DecisionId)).Status);
    }

    [Fact]
    public async Task ProtectedPayloadAndJournal_RejectTamperAndRestoredApprovedHead()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        _ = await host.ClaimMigrationAsync(pending);
        await host.ExecuteAsync("""
            UPDATE authoring_extension_approval_decision SET status=e.status, revision=e.revision, protected_payload=e.protected_payload
            FROM authoring_extension_approval_event e WHERE e.revision=1;
            """);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(pending).AsTask());
        await host.ExecuteAsync("UPDATE authoring_extension_approval_decision SET protected_payload=set_byte(protected_payload,0,0);");
        Assert.NotNull(await Record.ExceptionAsync(async () => await host.Authority.ReadAsync(pending.DecisionId)));
    }

    [Fact]
    public async Task ExpiredDecision_PersistsTerminalExpiryAndCannotBeConfirmed()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        await host.ExpirePendingAsync(pending.DecisionId);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ConfirmMigrationAsync(pending).AsTask());
        Assert.Equal(AuthoringApprovalStatus.Expired, (await host.NewAuthority().ReadAsync(pending.DecisionId)).Status);
        Assert.Equal(2, await host.ScalarAsync("SELECT count(*) FROM authoring_extension_approval_event;"));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(pending).AsTask());
    }

    [Fact]
    public async Task ClaimFailure_RollsBackClaimEventAndAllowsOneLaterClaim()
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        await host.ExecuteAsync("ALTER TABLE authoring_extension_approval_event ADD CONSTRAINT injected_claim_failure CHECK (revision<2);");
        Assert.NotNull(await Record.ExceptionAsync(async () => await host.ClaimMigrationAsync(pending)));
        Assert.Equal(AuthoringApprovalStatus.Approved, (await host.NewAuthority().ReadAsync(pending.DecisionId)).Status);
        await host.ExecuteAsync("ALTER TABLE authoring_extension_approval_event DROP CONSTRAINT injected_claim_failure;");
        _ = await host.ClaimMigrationAsync(pending);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(pending).AsTask());
    }

    [Fact]
    public async Task MissingApprovalSchema_FailsClosedAndDoesNotCreateTables()
    {
        await using Harness host = await CreateAsync();
        await host.ExecuteAsync("DROP TABLE authoring_extension_approval_event; DROP TABLE authoring_extension_approval_decision;");
        await Assert.ThrowsAsync<PostgresException>(() => host.PrepareMigrationAsync().AsTask());
        Assert.Equal(0, await host.ScalarAsync("SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'authoring_extension_approval%';"));
    }

    private async Task<Harness> CreateAsync()
    {
        string connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(postgres);
        SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString);
        PostgresSqlSugarTestClient.InitTables(db, typeof(AdminPrincipal), typeof(AdminSession));
        await db.Ado.ExecuteCommandAsync(AuthoringExtensionStateStorageSchema.CreateTablesSql);
        await db.Ado.ExecuteCommandAsync(AuthoringExtensionApprovalStorageSchema.CreateTablesSql);
        // Existing receipt schema is materialized only in this isolated fixture database.
        await db.Ado.ExecuteCommandAsync("""
            CREATE TABLE authoring_lifecycle_receipt (
                schema_version integer NOT NULL, sequence bigint NOT NULL, extension_id text NOT NULL,
                package_sha256 text NOT NULL, version text NOT NULL, state_schema_version integer NOT NULL,
                data_schema_version integer NOT NULL, previous_state integer NOT NULL, state integer NOT NULL,
                generation bigint NOT NULL, scope_digest text NOT NULL, failure_code text NULL,
                previous_receipt_sha256 text NOT NULL, receipt_sha256 text NOT NULL,
                PRIMARY KEY(extension_id,sequence), UNIQUE(extension_id,generation), UNIQUE(receipt_sha256)
            );
            """);
        db.Insertable(new[]
        {
            new AdminPrincipal { Handle = "approval-first", Permissions = AdminPermissions.SystemConfig },
            new AdminPrincipal { Handle = "approval-second", Permissions = AdminPermissions.SystemConfig }
        }).ExecuteCommand();
        db.Insertable(new[]
        {
            new AdminSession { SessionId = "first-session", AdminPrincipalId = 1,
                IdleExpiresAtUtc = DateTime.UtcNow.AddMinutes(30), AbsoluteExpiresAtUtc = DateTime.UtcNow.AddHours(1) },
            new AdminSession { SessionId = "second-session", AdminPrincipalId = 2,
                IdleExpiresAtUtc = DateTime.UtcNow.AddMinutes(30), AbsoluteExpiresAtUtc = DateTime.UtcNow.AddHours(1) }
        }).ExecuteCommand();
        ConnectionMultiplexer connection = await redis.ConnectAsync();
        var cache = new UnifiedCache(connection, new CachePolicyRegistry(), new ApprovalRuntimeScope(), NullLogger<UnifiedCache>.Instance);
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["AuthoringExtensions:SiteId"] = "synthetic-site"
        }).Build();
        // These collaborators are outside the exercised proof mint/consume path. The actual
        // AdminPrincipalService, Redis one-time store, SQL identity, state and receipts are real.
        var admins = new AdminPrincipalService(Substitute.For<IFido2>(), db, cache, cache,
            Substitute.For<IJwtHelper>(), configuration, NullLogger<AdminPrincipalService>.Instance,
            Substitute.For<IAdminAuditLogChannel>());
        var host = new Harness(db, NpgsqlDataSource.Create(connectionString), connection, cache,
            configuration, admins, new EphemeralDataProtectionProvider());
        await host.InitializeAsync();
        return host;
    }

    private static DefaultHttpContext Context(long id, string sessionId) => new()
    {
        User = new ClaimsPrincipal(new ClaimsIdentity(new[]
        {
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind), new Claim("admin_id", id.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new Claim("admin_sid", sessionId)
        }, "approval-fixture"))
    };

    private static AuthoringLifecycleReceipt NextReceipt(AuthoringLifecycleReceipt previous, AuthoringLifecycleState next)
    {
        var receipt = previous with
        {
            Sequence = previous.Sequence + 1,
            Generation = previous.Generation + 1,
            PreviousState = previous.State,
            State = next,
            PreviousReceiptSha256 = previous.ReceiptSha256
        };
        return receipt with
        {
            ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(receipt)
        };
    }

    // A request-lifetime context, assigned explicitly rather than across AsyncLocal async setup.
    private sealed class FixtureContextAccessor : IHttpContextAccessor
    {
        public HttpContext? HttpContext
        {
            get; set;
        }
    }

    private sealed class ApprovalRuntimeScope : IRuntimeKeyScope
    {
        public string ScopeToken { get; } = $"fsus-approval-{Guid.NewGuid():N}:";
        public string PrefixKey(string key) => ScopeToken + key;
    }

    private sealed class Harness(SqlSugarClient db, NpgsqlDataSource source, ConnectionMultiplexer redisConnection,
        UnifiedCache cache, IConfigurationRoot configuration, AdminPrincipalService admins, IDataProtectionProvider protection) : IAsyncDisposable
    {
        public VerifiedAuthoringPackage OldPackage { get; } = AuthoringStateProcessWorker.Package("1.0.0", 1);
        public VerifiedAuthoringPackage NewPackage { get; } = AuthoringStateProcessWorker.Package("2.0.0", 2);
        public AuthoringStateScope From => AuthoringStateProcessWorker.Scope(OldPackage);
        public AuthoringStateScope To => AuthoringStateProcessWorker.Scope(NewPackage);
        public AuthoringFencedStateMigration Plan { get; set; } = null!;
        public AuthoringLifecycleReceipt Receipt { get; private set; } = null!;
        public PostgresAuthoringExtensionStateStore State { get; } = new(db);
        public PostgresAuthoringLifecycleReceiptStore Receipts { get; } = new(db);
        public FixtureContextAccessor Context { get; } = new() { HttpContext = AuthoringExtensionApprovalPostgresTests.Context(1, "first-session") };
        public IConfigurationRoot Configuration => configuration;
        public AuthoringExtensionApprovalAuthority Authority { get; private set; } = null!;

        public AuthoringExtensionApprovalAuthority NewAuthority() => new(Context, configuration,
            new PostgresAuthoringExtensionApprovalStore(source, protection), State, Receipts, admins);

        public async Task InitializeAsync()
        {
            await State.InitializeAsync(OldPackage, From, default);
            await State.InitializeAsync(NewPackage, To, default);
            await State.WriteAsync(OldPackage, From, 0, new("old", [1, 2]), default);
            Plan = AuthoringStateProcessWorker.Plan(await State.ReadAsync(OldPackage, From, default), To);
            Receipt = new(1, 1, OldPackage.Contract.Manifest.Id, OldPackage.PackageIdentity, "1.0.0", 1,
                OldPackage.Contract.Manifest.DataSchemaVersion, AuthoringLifecycleState.Installed, AuthoringLifecycleState.Enabled,
                1, new string('c', 64), null, new string('0', 64), string.Empty);
            Receipt = Receipt with
            {
                ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(Receipt)
            };
            await Receipts.AppendAsync(Receipt, default);
            Authority = NewAuthority();
        }

        public async Task RetainAsync()
        {
            Receipt = NextReceipt(Receipt, AuthoringLifecycleState.Uninstalling);
            await Receipts.AppendAsync(Receipt, default);
            Receipt = NextReceipt(Receipt, AuthoringLifecycleState.RetainedData);
            await Receipts.AppendAsync(Receipt, default);
        }

        public ValueTask<AuthoringExtensionApprovalPreview> PrepareMigrationAsync() => Authority.PrepareMigrationAsync(OldPackage, NewPackage, Plan, Receipt);
        public Task<string> ProofAsync() => admins.CreateAdminStepUpProofTokenAsync(1, "first-session", "admin-sensitive", TimeSpan.FromMinutes(5));
        public async ValueTask<AuthoringExtensionApprovalPreview> ConfirmMigrationAsync(AuthoringExtensionApprovalPreview preview, string? proof = null) =>
            await Authority.ConfirmMigrationAsync(preview.DecisionId, OldPackage, NewPackage, Plan, Receipt, preview.Digest, proof ?? await ProofAsync());
        public async ValueTask ConfirmDeletionAsync(AuthoringExtensionApprovalPreview preview) =>
            _ = await Authority.ConfirmDeletionAsync(preview.DecisionId, OldPackage, preview.Measurement!, Receipt, preview.Digest, await ProofAsync());
        public ValueTask<AuthoringExtensionApprovalAuthority.ApprovedClaim> ClaimMigrationAsync(AuthoringExtensionApprovalPreview preview) =>
            Authority.ClaimMigrationAsync(preview.DecisionId, OldPackage, NewPackage, Plan, Receipt);
        public ValueTask<AuthoringExtensionApprovalAuthority.ApprovedClaim> ClaimDeletionAsync(AuthoringExtensionApprovalPreview preview) =>
            Authority.ClaimDeletionAsync(preview.DecisionId, OldPackage, preview.Measurement!, Receipt);
        public ValueTask<NpgsqlConnection> OpenConnectionAsync() => source.OpenConnectionAsync();

        public async Task ExecuteIndependentAsync(string sql)
        {
            await using NpgsqlConnection connection = await source.OpenConnectionAsync();
            await using var command = new NpgsqlCommand(sql, connection);
            await command.ExecuteNonQueryAsync();
        }

        public async Task WaitForDatabaseLockAsync(string predicate)
        {
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await using NpgsqlConnection connection = await source.OpenConnectionAsync(deadline.Token);
            while (true)
            {
                await using var command = new NpgsqlCommand($"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND {predicate};", connection);
                if (Convert.ToInt64(await command.ExecuteScalarAsync(deadline.Token)) > 0)
                {
                    return;
                }
                await Task.Delay(20, deadline.Token);
            }
        }

        public async Task ExpirePendingAsync(string decisionId)
        {
            // Test-only shortening of a genuine pending decision; never fabricates approval.
            IDataProtector protector = protection.CreateProtector("FsusBlog.AuthoringExtensionApproval.v1");
            byte[] payload = (byte[])(await db.Ado.GetScalarAsync(
                "SELECT protected_payload FROM authoring_extension_approval_decision WHERE decision_id=@Id;",
                new SugarParameter("@Id", decisionId)))!;
            AuthoringApprovalDecision decision = System.Text.Json.JsonSerializer.Deserialize<AuthoringApprovalDecision>(protector.Unprotect(payload))!;
            Assert.Equal(AuthoringApprovalStatus.Pending, decision.Status);
            payload = protector.Protect(System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(decision with
            {
                ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-1)
            }));
            await db.Ado.ExecuteCommandAsync("UPDATE authoring_extension_approval_decision SET protected_payload=@Payload WHERE decision_id=@Id;",
                new SugarParameter("@Payload", payload), new SugarParameter("@Id", decisionId));
            await db.Ado.ExecuteCommandAsync("UPDATE authoring_extension_approval_event SET protected_payload=@Payload WHERE decision_id=@Id;",
                new SugarParameter("@Payload", payload), new SugarParameter("@Id", decisionId));
        }

        public async Task<long> ScalarAsync(string sql) => Convert.ToInt64(await db.Ado.GetScalarAsync(sql));
        public async Task ExecuteAsync(string sql) => _ = await db.Ado.ExecuteCommandAsync(sql);
        public async ValueTask DisposeAsync()
        {
            cache.Dispose();
            await redisConnection.DisposeAsync();
            await source.DisposeAsync();
            db.Dispose();
        }
    }
}
