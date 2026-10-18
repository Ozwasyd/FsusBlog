using System.Collections.Immutable;
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
            pending.DecisionId, host.OldPackage, host.NewPackage, host.Plan, host.OldTargets, host.NewTargets, host.Receipt, new string('0', 64), proof).AsTask());
        await host.ConfirmMigrationAsync(pending, proof);
        // An independently constructed issuer uses independent SQL connections and the same real key ring.
        AuthoringExtensionApprovalAuthority second = host.NewAuthority();
        Task<AuthoringExtensionApprovalAuthority.ApprovedClaim>[] attempts =
        [host.ClaimMigrationAsync(pending).AsTask(), second.ClaimMigrationAsync(
            pending.DecisionId, host.OldPackage, host.NewPackage, host.Plan, host.OldTargets, host.NewTargets, host.Receipt).AsTask()];
        foreach (Task attempt in attempts)
        {
            _ = await Record.ExceptionAsync(async () => await attempt);
        }
        Assert.Equal(1, attempts.Count(attempt => attempt.IsCompletedSuccessfully));
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim = attempts.Single(attempt => attempt.IsCompletedSuccessfully).Result;
        Assert.Equal(pending.Digest, claim.Digest);
        Assert.Equal(pending.OperationContext, claim.OperationContext);
        Assert.Equal(2, claim.OperationContext.ContractVersion);
        Assert.Equal(host.From.UserId, claim.OperationContext.StateUserId);
        Assert.Equal("canonical-state-scope-authority-required-v1", claim.OperationContext.AuthorizationPolicy);
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
        await host.GrantFixtureScopeAsync(AuthoringApprovalOperation.Migration, secondFrom);
        await host.GrantFixtureScopeAsync(AuthoringApprovalOperation.Migration, secondTo);
        await host.State.InitializeAsync(host.OldPackage, secondFrom, default);
        await host.State.InitializeAsync(host.NewPackage, secondTo, default);
        AuthoringFencedStateMigration secondPlan = AuthoringStateProcessWorker.Plan(await host.State.ReadAsync(host.OldPackage, secondFrom, default), secondTo, []);
        AuthoringExtensionApprovalPreview second = await host.Authority.PrepareMigrationAsync(host.OldPackage, host.NewPackage, secondPlan, host.OldTargets, host.NewTargets, host.Receipt);
        string proof = await host.ProofAsync();
        await host.ConfirmMigrationAsync(first, proof);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.ConfirmMigrationAsync(second.DecisionId,
            host.OldPackage, host.NewPackage, secondPlan, host.OldTargets, host.NewTargets, host.Receipt, second.Digest, proof).AsTask());
        Assert.Equal(AuthoringApprovalStatus.Pending, (await host.Authority.ReadAsync(second.DecisionId)).Status);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(second).AsTask());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SameEffect_CannotObtainAnotherDecisionAfterLostClaimResponse(bool advanceLifecycle)
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalPreview pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        _ = await host.ClaimMigrationAsync(pending);
        if (advanceLifecycle)
        {
            await host.AdvanceReceiptAsync(AuthoringLifecycleState.Disabled);
        }
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
    public async Task CompletedClaim_RequiresCanonicalExecutionOwnerAndCannotUseReceiptOnlyBinding()
    {
        await using Harness host = await CreateAsync();
        var pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        var claim = await host.ClaimMigrationAsync(pending);
        (AuthoringExtensionApprovalExecutionResult execution, AuthoringLifecycleReceipt result) = await host.RunningResultAsync(claim);
        await host.Receipts.AppendAsync(result, default);
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.CompleteAsync(claim, execution, result).AsTask());
        Assert.Equal("approval_execution_result_authority_unavailable", error.Message);
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.Authority.ReadAsync(pending.DecisionId)).Status);
        Assert.NotEqual(claim.Digest, result.ScopeDigest);
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

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReviewScope_OtherUserDocumentMustNotBeAuthorized(bool deletion)
    {
        await using Harness host = await CreateAsync();
        AuthoringStateScope foreignFrom = host.From with
        {
            UserId = "foreign-user",
            DocumentId = "foreign-document"
        };
        AuthoringStateScope foreignTo = host.To with
        {
            UserId = "foreign-user",
            DocumentId = "foreign-document"
        };
        await host.State.InitializeAsync(host.OldPackage, foreignFrom, default);
        await host.State.InitializeAsync(host.NewPackage, foreignTo, default);
        await host.State.WriteAsync(host.OldPackage, foreignFrom, 0, new("old", [5, 6]), default);
        if (deletion)
        {
            await host.RetainAsync();
        }
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
        {
            if (deletion)
            {
                var pending = await host.Authority.PrepareDeletionAsync(host.OldPackage, foreignFrom, host.Receipt);
                await host.ConfirmDeletionAsync(pending);
                var claim = await host.ClaimDeletionAsync(pending);
                await host.State.DeleteAsync(host.OldPackage, claim.FencedDeletion!, default);
            }
            else
            {
                host.Plan = AuthoringStateProcessWorker.Plan(await host.State.ReadAsync(host.OldPackage, foreignFrom, default), foreignTo);
                var pending = await host.PrepareMigrationAsync();
                await host.ConfirmMigrationAsync(pending);
                _ = await host.ClaimMigrationAsync(pending);
            }
        });
        Assert.Equal("fixture_exact_scope_denied", error.Message);
        Assert.Single((await host.State.ReadAsync(host.OldPackage, foreignFrom, default)).Entries);
        Assert.Equal(0, await host.ScalarAsync("SELECT count(*) FROM authoring_extension_approval_decision;"));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReviewComplete_WrongVersionAndSchemasMustRefuse(bool deletion)
    {
        await using Harness host = await CreateAsync();
        AuthoringExtensionApprovalAuthority.ApprovedClaim claim;
        AuthoringExtensionApprovalExecutionResult execution;
        AuthoringLifecycleReceipt result;
        if (deletion)
        {
            (claim, execution, result) = await host.DeletedResultAsync();
        }
        else
        {
            var pending = await host.PrepareMigrationAsync();
            await host.ConfirmMigrationAsync(pending);
            claim = await host.ClaimMigrationAsync(pending);
            (execution, result) = await host.RunningResultAsync(claim);
        }
        result = result with
        {
            Version = "99.0.0",
            StateSchemaVersion = 99,
            DataSchemaVersion = 98
        };
        result = result with
        {
            ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(result)
        };
        await host.Receipts.AppendAsync(result, default);
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.CompleteAsync(claim, execution, result).AsTask());
        Assert.Equal("approval_result_package_metadata_mismatch", error.Message);
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.Authority.ReadAsync(claim.DecisionId)).Status);
    }

    [Fact]
    public async Task ReviewComplete_ConcurrentNewHeadMustRefuseFinalCAS()
    {
        await using Harness host = await CreateAsync();
        var pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        var claim = await host.ClaimMigrationAsync(pending);
        var (execution, result) = await host.RunningResultAsync(claim);
        await host.Receipts.AppendAsync(result, default);
        await using var access = await host.ScopeAuthority.AcquireAsync(host.Context.HttpContext!, claim.Operation, claim.Scope, claim.FrozenPlan!.To, default);
        await using var blocker = await host.OpenConnectionAsync();
        await using var transaction = await blocker.BeginTransactionAsync();
        await using (var command = new NpgsqlCommand("SELECT decision_id FROM authoring_extension_approval_decision WHERE decision_id=$1 FOR UPDATE;", blocker))
        {
            command.Parameters.AddWithValue(claim.DecisionId);
            await command.ExecuteScalarAsync();
        }
        // Exercise the exact SQL terminal-CAS component without pretending that this fixture
        // supplies a native result owner. Public migration Complete already refuses that absence.
        Task complete = host.ApprovalStore.SettleAsync(claim, AuthoringApprovalStatus.Completed, result,
            execution.ContentSha256, access.VerifyCurrentAsync, default).AsTask();
        await host.WaitForDatabaseLockAsync("query LIKE '%authoring_extension_approval_decision%FOR UPDATE%' AND wait_event_type='Lock'");
        await host.Receipts.AppendAsync(NextReceipt(result, AuthoringLifecycleState.Disabled), default);
        await transaction.CommitAsync();
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await complete);
        Assert.Equal("approval_lifecycle_drift", error.Message);
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.Authority.ReadAsync(claim.DecisionId)).Status);
    }

    [Fact]
    public async Task MissingCanonicalScopeOwner_RejectsEvenSystemConfigAdminBeforeCreatingDecision()
    {
        await using Harness host = await CreateAsync();
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.WithoutScopeAuthority().PrepareMigrationAsync(
            host.OldPackage, host.NewPackage, host.Plan, host.OldTargets, host.NewTargets, host.Receipt).AsTask());
        Assert.Equal("approval_exact_scope_authority_unavailable", error.Message);
        Assert.Equal(0, await host.ScalarAsync("SELECT count(*) FROM authoring_extension_approval_decision;"));
    }

    [Theory]
    [InlineData("revoked")]
    [InlineData("version")]
    public async Task ExactScopeGrantDrift_RefusesAnOtherwiseCurrentApprovedDecision(string drift)
    {
        await using Harness host = await CreateAsync();
        var pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        await host.ExecuteAsync(drift == "revoked" ? "UPDATE approval_fixture_scope_acl SET status='revoked';" :
            "UPDATE approval_fixture_scope_acl SET status=status;");
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.ClaimMigrationAsync(pending).AsTask());
        Assert.Equal((long)AuthoringApprovalStatus.Approved, await host.ScalarAsync("SELECT status FROM authoring_extension_approval_decision;"));
    }

    [Fact]
    public async Task OrderedTargets_AreFrozenBeforeApprovalAndCannotBeReorderedAtClaim()
    {
        await using Harness host = await CreateAsync();
        var pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        var changed = host.NewTargets.Reverse().ToImmutableArray();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.ClaimMigrationAsync(pending.DecisionId,
            host.OldPackage, host.NewPackage, host.Plan, host.OldTargets, changed, host.Receipt).AsTask());
        _ = await host.ClaimMigrationAsync(pending);
    }

    [Theory]
    [InlineData("snapshot")]
    [InlineData("roster")]
    [InlineData("runtime")]
    [InlineData("package-field")]
    [InlineData("receipt-only")]
    public async Task ActualAppliedResult_RejectsTamperEvenWhenCallerRehashes(string field)
    {
        await using Harness host = await CreateAsync();
        var pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        var claim = await host.ClaimMigrationAsync(pending);
        var (execution, result) = await host.RunningResultAsync(claim);
        if (field == "snapshot")
        {
            // Canonical hash protects bytes; state-owner completion is a separate actual observation.
            execution = execution with
            {
                AppliedSnapshot = execution.AppliedSnapshot! with
                {
                    ContentSha256 = new string('f', 64)
                }
            };
        }
        else if (field == "roster")
        {
            execution = execution with
            {
                OrderedNewTargets = execution.OrderedNewTargets.Reverse().ToImmutableArray()
            };
        }
        else if (field == "runtime")
        {
            execution = execution with
            {
                OrderedNewTargets = execution.OrderedNewTargets.SetItem(0, execution.OrderedNewTargets[0] with
                {
                    RuntimeIdentity = new string('f', 64)
                })
            };
        }
        else if (field == "package-field")
        {
            execution = execution with
            {
                PackageSha256 = host.NewPackage.PackageIdentity
            };
        }
        else
        {
            result = result with
            {
                ScopeDigest = claim.Digest
            };
        }
        if (field != "receipt-only")
        {
            execution = execution with
            {
                ContentSha256 = AuthoringExtensionApprovalContract.ComputeContentSha256(execution)
            };
            result = result with
            {
                ScopeDigest = execution.ContentSha256
            };
        }
        result = result with
        {
            ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(result)
        };
        await host.Receipts.AppendAsync(result, default);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.CompleteAsync(claim, execution, result).AsTask());
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.Authority.ReadAsync(claim.DecisionId)).Status);
    }

    [Fact]
    public async Task RealApplySnapshot_RequiresExactSettledStateAndNeverPredictsFutureSnapshot()
    {
        await using Harness host = await CreateAsync();
        var pending = await host.PrepareMigrationAsync();
        await host.ConfirmMigrationAsync(pending);
        var claim = await host.ClaimMigrationAsync(pending);
        await host.State.BackupAsync(host.OldPackage, host.NewPackage, host.Plan, default);
        AuthoringStateSnapshot actual = await host.State.ApplyAsync(host.OldPackage, host.NewPackage, host.Plan, default);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.State.ReadAsync(host.NewPackage, host.To, default).AsTask());
        var data = AuthoringExtensionApprovalContract.MigrationResult(claim, actual, host.OldTargets, host.NewTargets, 6);
        Assert.Equal(actual.ContentSha256, data.AppliedSnapshot!.ContentSha256);
        await host.State.CompleteAsync(host.OldPackage, host.NewPackage, host.Plan, default);
        var source = await host.State.ReadAsync(host.OldPackage, host.From, default);
        var settled = await host.State.ReadAsync(host.NewPackage, host.To, default);
        AuthoringExtensionApprovalContract.ValidateSettledMigration(claim, actual, source, settled, default);
        await host.State.WriteAsync(host.NewPackage, host.To, settled.Revision, new("new", [9, 9]), default);
        var changed = await host.State.ReadAsync(host.NewPackage, host.To, default);
        Assert.Throws<AuthoringExtensionContractException>(() => AuthoringExtensionApprovalContract.ValidateSettledMigration(claim, actual, source, changed, default));
        // The successful metadata validation above is not native or cross-store admission.
    }

    [Fact]
    public async Task ActualDeletionResult_RequiresCanonicalStateCustodyThroughFinalCAS()
    {
        await using Harness host = await CreateAsync();
        var (claim, execution, result) = await host.DeletedResultAsync();
        await host.Receipts.AppendAsync(result, default);
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => host.Authority.CompleteAsync(claim, execution, result).AsTask());
        Assert.Equal("approval_execution_result_authority_unavailable", error.Message);
        Assert.Equal(AuthoringApprovalStatus.Claimed, (await host.Authority.ReadAsync(claim.DecisionId)).Status);
        Assert.Equal(3, await host.ScalarAsync("SELECT count(*) FROM authoring_extension_approval_event;"));
    }

    [Fact]
    public async Task ActualVerifierAndCoordinatorBuilders_PreservePayloadVersusCompositePackageIdentity()
    {
        await using Harness host = await CreateAsync();
        VerifiedAuthoringPackage oldPackage = await VerifyOriginalFixtureAsync("1.0.0", 1);
        VerifiedAuthoringPackage newPackage = await VerifyOriginalFixtureAsync("2.0.0", 2);
        Assert.NotEqual(oldPackage.PackageIdentity, oldPackage.Contract.Manifest.PackageSha256);
        Assert.NotEqual(newPackage.PackageIdentity, newPackage.Contract.Manifest.PackageSha256);
        AuthoringStateScope from = AuthoringStateProcessWorker.Scope(oldPackage) with
        {
            UserId = "verifier-user",
            DocumentId = "verifier-document"
        };
        AuthoringStateScope to = AuthoringStateProcessWorker.Scope(newPackage) with
        {
            UserId = "verifier-user",
            DocumentId = "verifier-document"
        };
        await host.State.InitializeAsync(oldPackage, from, default);
        await host.State.InitializeAsync(newPackage, to, default);
        await host.State.WriteAsync(oldPackage, from, 0, new("old", [1, 2]), default);
        await host.GrantFixtureScopeAsync(AuthoringApprovalOperation.Migration, from);
        await host.GrantFixtureScopeAsync(AuthoringApprovalOperation.Migration, to);
        await host.GrantFixtureScopeAsync(AuthoringApprovalOperation.Deletion, from);
        // Original verifier + builder field interop only. These diagnostic revocation ports
        // do not qualify native startup/cleanup or a real user confirmation.
        var resources = Substitute.For<IAuthoringLifecycleResourceAuthority>();
        resources.RevokeAllAsync(Arg.Any<string>(), Arg.Any<long>(), Arg.Any<CancellationToken>())
            .Returns(ValueTask.FromResult(new AuthoringLifecycleResourceReport(0, 0, 0, 0, 0, 0, 0)));
        var coordinator = new AuthoringExtensionLifecycleCoordinator(resources, Substitute.For<IAuthoringLifecyclePreflight>(),
            host.State, host.Receipts, Substitute.For<IAuthoringCapabilityGrantCatalog>());
        var disabled = await coordinator.DisableAsync(oldPackage);
        Assert.Equal(oldPackage.Contract.Manifest.PackageSha256, disabled.PackageSha256);
        Assert.Equal(oldPackage.PackageIdentity, disabled.ScopeDigest);
        var plan = AuthoringStateProcessWorker.Plan(await host.State.ReadAsync(oldPackage, from, default), to);
        var migration = await host.Authority.PrepareMigrationAsync(oldPackage, newPackage, plan,
            Harness.Targets(oldPackage), Harness.Targets(newPackage), disabled);
        Assert.Equal(AuthoringApprovalStatus.Pending, migration.Status);
        var retained = await coordinator.UninstallAsync(oldPackage, from);
        Assert.Equal(oldPackage.Contract.Manifest.PackageSha256, retained.PackageSha256);
        Assert.Equal(oldPackage.PackageIdentity, retained.ScopeDigest);
        var deletion = await host.Authority.PrepareDeletionAsync(oldPackage, from, retained);
        Assert.Equal(AuthoringApprovalStatus.Pending, deletion.Status);
    }

    private static async Task<VerifiedAuthoringPackage> VerifyOriginalFixtureAsync(string version, int schema)
    {
        // Reuse the original PackageTests synthetic trust/archive fixture unchanged. The actual
        // verifier computes its canonical composite identity; this is not signature admission.
        var factory = typeof(AuthoringExtensionPackageTests).GetMethod("CreatePackage",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
        object?[] args = factory.GetParameters().Select(parameter => parameter.DefaultValue).ToArray();
        args[0] = version;
        args[1] = "approval-owner-interop-" + version;
        int schemaIndex = Array.FindIndex(factory.GetParameters(), parameter => parameter.Name == "stateSchemaVersion");
        args[schemaIndex] = schema;
        object fixture = factory.Invoke(null, args)!;
        var verifier = (AuthoringPackageVerifier)fixture.GetType().GetProperty("Verifier")!.GetValue(fixture)!;
        var artifact = (AuthoringPackageArtifact)fixture.GetType().GetProperty("Artifact")!.GetValue(fixture)!;
        return await verifier.VerifyAsync(artifact, AuthoringHostPlatform.ServerLinux);
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

    // This is an explicitly configured fixture owner over synthetic SQL ACL rows, not a
    // production authorization adapter and not an adminId -> opaque user mapping.
    private sealed class FixtureScopeAuthority(NpgsqlDataSource source) : IAuthoringExtensionApprovalScopeAuthority
    {
        public async ValueTask<IAuthoringExtensionApprovalScope> AcquireAsync(HttpContext context,
            AuthoringApprovalOperation operation, AuthoringStateScope scope, AuthoringStateScope? destination, CancellationToken token)
        {
            if (!context.User.TryGetAdminPrincipalId(out long principalId) || context.User.GetAdminSessionId() is not { } sessionId)
            {
                throw new AuthoringExtensionContractException("fixture_scope_actor_missing");
            }
            NpgsqlConnection connection = await source.OpenConnectionAsync(token);
            NpgsqlTransaction transaction = await connection.BeginTransactionAsync(token);
            try
            {
                string[] scopes = destination is null ? [AuthoringExtensionStateContract.ScopeId(scope)] :
                    [AuthoringExtensionStateContract.ScopeId(scope), AuthoringExtensionStateContract.ScopeId(destination)];
                var versions = new List<string>();
                foreach (string id in scopes)
                {
                    await using var command = new NpgsqlCommand("""
                        SELECT xmin::text FROM approval_fixture_scope_acl
                        WHERE principal_id=$1 AND session_id=$2 AND operation=$3 AND scope_id=$4 AND status='active' FOR SHARE;
                        """, connection);
                    command.Parameters.AddWithValue(principalId);
                    command.Parameters.AddWithValue(sessionId);
                    command.Parameters.AddWithValue((int)operation);
                    command.Parameters.AddWithValue(id);
                    string? version = (string?)await command.ExecuteScalarAsync(token);
                    if (version is null)
                    {
                        throw new AuthoringExtensionContractException("fixture_exact_scope_denied");
                    }
                    versions.Add(version);
                }
                return new FixtureScopeLease(connection, transaction, AuthoringExtensionStateContract.Digest(new
                {
                    principalId,
                    sessionId,
                    operation,
                    Scopes = scopes,
                    Versions = versions
                }));
            }
            catch
            {
                await transaction.DisposeAsync();
                await connection.DisposeAsync();
                throw;
            }
        }
    }

    private sealed class FixtureScopeLease(NpgsqlConnection connection, NpgsqlTransaction transaction, string binding) : IAuthoringExtensionApprovalScope
    {
        public string AuthorizationSha256 => binding;
        public async ValueTask VerifyCurrentAsync(CancellationToken token)
        {
            await using var command = new NpgsqlCommand("SELECT 1;", connection);
            if (Convert.ToInt32(await command.ExecuteScalarAsync(token)) != 1)
            {
                throw new AuthoringExtensionContractException("fixture_scope_connection_lost");
            }
            // Exact ACL rows stay locked FOR SHARE by this transaction until disposal.
        }
        public async ValueTask DisposeAsync()
        {
            await transaction.DisposeAsync();
            await connection.DisposeAsync();
        }
    }

    private sealed class Harness(SqlSugarClient db, NpgsqlDataSource source, ConnectionMultiplexer redisConnection,
        UnifiedCache cache, IConfigurationRoot configuration, AdminPrincipalService admins, IDataProtectionProvider protection) : IAsyncDisposable
    {
        public VerifiedAuthoringPackage OldPackage { get; } = Package("1.0.0", 1);
        public VerifiedAuthoringPackage NewPackage { get; } = Package("2.0.0", 2);
        // Deliberately distinguish all three original package identity fields. Synthetic static
        // targets describe approved data only; they do not attest actual native readiness.
        private static VerifiedAuthoringPackage Package(string version, int schema)
        {
            VerifiedAuthoringPackage basis = AuthoringStateProcessWorker.Package(version, schema);
            AuthoringContributionDeclaration first = basis.Contract.Manifest.Contributions[0];
            AuthoringExtensionManifest manifest = basis.Contract.Manifest with
            {
                Contributions = [first, first with { Id = "acme.command.secondary" }]
            };
            return basis with
            {
                Contract = AuthoringExtensionContractValidator.Verify(manifest),
                PackageIdentity = new string(schema == 1 ? '1' : '2', 64)
            };
        }

        public static ImmutableArray<AuthoringExecutionTarget> Targets(VerifiedAuthoringPackage package) =>
            [.. package.Contract.Manifest.Contributions.Select(item => new AuthoringExecutionTarget(
                AuthoringExecutionResolutionStatus.Ready,item.ExecutionClass,package.Contract.Manifest.Id,
                package.Contract.Manifest.Version,package.Contract.Manifest.PackageSha256,item.Id,item.Kind,
                item.Entrypoint.PathOrAdapterId,null,
                AuthoringExtensionStateContract.Digest(new { package.PackageIdentity,item.Id }),null))];

        public ImmutableArray<AuthoringExecutionTarget> OldTargets => Targets(OldPackage);
        public ImmutableArray<AuthoringExecutionTarget> NewTargets => Targets(NewPackage);
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
            new PostgresAuthoringExtensionApprovalStore(source, protection), State, Receipts, admins, new FixtureScopeAuthority(source));

        public async Task InitializeAsync()
        {
            await State.InitializeAsync(OldPackage, From, default);
            await State.InitializeAsync(NewPackage, To, default);
            await State.WriteAsync(OldPackage, From, 0, new("old", [1, 2]), default);
            Plan = AuthoringStateProcessWorker.Plan(await State.ReadAsync(OldPackage, From, default), To);
            Receipt = new(1, 1, OldPackage.Contract.Manifest.Id, OldPackage.Contract.Manifest.PackageSha256, "1.0.0", 1,
                OldPackage.Contract.Manifest.DataSchemaVersion, AuthoringLifecycleState.Installed, AuthoringLifecycleState.Enabled,
                1, OldPackage.PackageIdentity, null, new string('0', 64), string.Empty);
            Receipt = Receipt with
            {
                ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(Receipt)
            };
            await Receipts.AppendAsync(Receipt, default);
            await ExecuteAsync("""
                CREATE TABLE approval_fixture_scope_acl (
                    principal_id bigint NOT NULL, session_id text NOT NULL, operation integer NOT NULL,
                    scope_id text COLLATE "C" NOT NULL, status text NOT NULL DEFAULT 'active',
                    PRIMARY KEY(principal_id,session_id,operation,scope_id));
                """);
            foreach ((AuthoringApprovalOperation operation, AuthoringStateScope scope) in new[]
            {
                (AuthoringApprovalOperation.Migration, From), (AuthoringApprovalOperation.Migration, To),
                (AuthoringApprovalOperation.Deletion, From)
            })
            {
                await db.Ado.ExecuteCommandAsync("INSERT INTO approval_fixture_scope_acl(principal_id,session_id,operation,scope_id) VALUES(1,'first-session',@Operation,@Scope);",
                    new SugarParameter("@Operation", (int)operation), new SugarParameter("@Scope", AuthoringExtensionStateContract.ScopeId(scope)));
            }
            Authority = NewAuthority();
        }

        public async Task<(AuthoringExtensionApprovalExecutionResult Execution, AuthoringLifecycleReceipt Receipt)> RunningResultAsync(
            AuthoringExtensionApprovalAuthority.ApprovedClaim claim)
        {
            var disabled = NextReceipt(Receipt, AuthoringLifecycleState.Disabled);
            await Receipts.AppendAsync(disabled, default);
            var updating = NextReceipt(disabled, AuthoringLifecycleState.Updating);
            await Receipts.AppendAsync(updating, default);
            var migrating = NextReceipt(updating, AuthoringLifecycleState.Migrating) with
            {
                PackageSha256 = NewPackage.Contract.Manifest.PackageSha256,
                Version = NewPackage.Contract.Manifest.Version,
                StateSchemaVersion = NewPackage.Contract.Manifest.StateSchemaVersion,
                ScopeDigest = NewPackage.PackageIdentity
            };
            migrating = migrating with
            {
                ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(migrating)
            };
            await State.BackupAsync(OldPackage, NewPackage, Plan, default);
            AuthoringStateSnapshot actual = await State.ApplyAsync(OldPackage, NewPackage, Plan, default);
            await Receipts.AppendAsync(migrating, default);
            var starting = NextReceipt(migrating, AuthoringLifecycleState.Starting);
            await Receipts.AppendAsync(starting, default);
            var running = NextReceipt(starting, AuthoringLifecycleState.Running);
            var execution = AuthoringExtensionApprovalContract.MigrationResult(claim, actual, OldTargets, NewTargets, running.Generation);
            running = running with
            {
                ScopeDigest = execution.ContentSha256
            };
            running = running with
            {
                ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(running)
            };
            await State.CompleteAsync(OldPackage, NewPackage, Plan, default);
            return (execution, running);
        }

        public async Task<(AuthoringExtensionApprovalAuthority.ApprovedClaim Claim, AuthoringExtensionApprovalExecutionResult Execution, AuthoringLifecycleReceipt Receipt)> DeletedResultAsync()
        {
            await RetainAsync();
            var pending = await Authority.PrepareDeletionAsync(OldPackage, From, Receipt);
            await ConfirmDeletionAsync(pending);
            var claim = await ClaimDeletionAsync(pending);
            await State.DeleteAsync(OldPackage, claim.FencedDeletion!, default);
            var actual = await State.MeasureAsync(OldPackage, From, default);
            var removed = NextReceipt(Receipt, AuthoringLifecycleState.Removed);
            var execution = AuthoringExtensionApprovalContract.DeletionResult(claim, actual, removed.Generation);
            removed = removed with
            {
                ScopeDigest = execution.ContentSha256
            };
            removed = removed with
            {
                ReceiptSha256 = AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(removed)
            };
            return (claim, execution, removed);
        }

        public async Task GrantFixtureScopeAsync(AuthoringApprovalOperation operation, AuthoringStateScope scope) =>
            _ = await db.Ado.ExecuteCommandAsync("INSERT INTO approval_fixture_scope_acl(principal_id,session_id,operation,scope_id) VALUES(1,'first-session',@Operation,@Scope);",
                new SugarParameter("@Operation", (int)operation), new SugarParameter("@Scope", AuthoringExtensionStateContract.ScopeId(scope)));

        public AuthoringExtensionApprovalAuthority WithoutScopeAuthority() => new(Context, configuration,
            new PostgresAuthoringExtensionApprovalStore(source, protection), State, Receipts, admins);

        public PostgresAuthoringExtensionApprovalStore ApprovalStore => new(source, protection);
        public IAuthoringExtensionApprovalScopeAuthority ScopeAuthority => new FixtureScopeAuthority(source);

        public async Task RetainAsync()
        {
            Receipt = NextReceipt(Receipt, AuthoringLifecycleState.Uninstalling);
            await Receipts.AppendAsync(Receipt, default);
            Receipt = NextReceipt(Receipt, AuthoringLifecycleState.RetainedData);
            await Receipts.AppendAsync(Receipt, default);
        }

        public async Task AdvanceReceiptAsync(AuthoringLifecycleState next)
        {
            Receipt = NextReceipt(Receipt, next);
            await Receipts.AppendAsync(Receipt, default);
        }

        public ValueTask<AuthoringExtensionApprovalPreview> PrepareMigrationAsync() => Authority.PrepareMigrationAsync(OldPackage, NewPackage, Plan, OldTargets, NewTargets, Receipt);
        public Task<string> ProofAsync() => admins.CreateAdminStepUpProofTokenAsync(1, "first-session", "admin-sensitive", TimeSpan.FromMinutes(5));
        public async ValueTask<AuthoringExtensionApprovalPreview> ConfirmMigrationAsync(AuthoringExtensionApprovalPreview preview, string? proof = null) =>
            await Authority.ConfirmMigrationAsync(preview.DecisionId, OldPackage, NewPackage, Plan, OldTargets, NewTargets, Receipt, preview.Digest, proof ?? await ProofAsync());
        public async ValueTask ConfirmDeletionAsync(AuthoringExtensionApprovalPreview preview) =>
            _ = await Authority.ConfirmDeletionAsync(preview.DecisionId, OldPackage, preview.Measurement!, Receipt, preview.Digest, await ProofAsync());
        public ValueTask<AuthoringExtensionApprovalAuthority.ApprovedClaim> ClaimMigrationAsync(AuthoringExtensionApprovalPreview preview) =>
            Authority.ClaimMigrationAsync(preview.DecisionId, OldPackage, NewPackage, Plan, OldTargets, NewTargets, Receipt);
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
            IDataProtector protector = protection.CreateProtector("FsusBlog.AuthoringExtensionApproval.v2");
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
