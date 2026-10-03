using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionLifecycleTests
{
    [Fact]
    public async Task EnableAsync_CompletePreflight_ActivatesAllContributionsAtomically()
    {
        LifecycleFixture fixture = CreateFixture();

        AuthoringLifecycleReceipt receipt = await fixture.Coordinator.EnableAsync(
            fixture.Package,
            fixture.Targets);

        Assert.Equal(AuthoringLifecycleState.Running, receipt.State);
        Assert.Equal(1, fixture.Resources.ActivationCount);
        Assert.Equal(fixture.Targets.Length, fixture.Resources.LastTargetCount);
    }

    [Fact]
    public async Task EnableAsync_PartialTargetSet_FailsBeforeRegistration()
    {
        LifecycleFixture fixture = CreateFixture();

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.EnableAsync(fixture.Package, []));

        Assert.Equal(0, fixture.Resources.ActivationCount);
    }

    [Fact]
    public async Task DisableAsync_RemainingRuntimeGrantJobOrSurface_FailsClosed()
    {
        var resources = new ResourceAuthority
        {
            RevokeReport = new AuthoringLifecycleResourceReport(0, 1, 0, 0, 1, 1, 1)
        };
        LifecycleFixture fixture = CreateFixture(resources: resources);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.DisableAsync(fixture.Package));
    }

    [Fact]
    public async Task DisableAsync_RevokesEverythingAndInvalidatesLateGeneration()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringLifecycleReceipt enabled = await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets);
        AuthoringLifecycleReceipt disabled = await fixture.Coordinator.DisableAsync(fixture.Package);

        Assert.Equal(AuthoringLifecycleState.Disabled, disabled.State);
        Assert.False(await fixture.Coordinator.AcceptResultAsync(fixture.Package.Contract.Manifest.Id, enabled.Generation));
        Assert.True(fixture.Resources.RevocationCount > 0);
    }

    [Fact]
    public async Task UpdateAsync_MigrationFailure_RollsBackStateAndOldPackage()
    {
        var state = new StateStore { FailMigration = true };
        LifecycleFixture fixture = CreateFixture(stateStore: state);
        await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets);
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", stateSchemaVersion: 2);
        ImmutableArray<AuthoringExecutionTarget> nextTargets = CreateTargets(next);
        AuthoringStateMigrationPlan plan = CreatePlan(fixture.Package, next);

        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, nextTargets, plan));

        Assert.True(state.BackupCalled);
        Assert.True(state.RollbackCalled);
        Assert.Equal(fixture.Package, fixture.Resources.LastActivatedPackage);
        Assert.Contains(
            fixture.Receipts.All,
            receipt => receipt.State == AuthoringLifecycleState.RollbackRequired);
        Assert.Equal(AuthoringLifecycleState.Running, fixture.Receipts.Latest?.State);
    }

    [Fact]
    public async Task UpdateAsync_CrossPluginOrUnboundedMigration_FailsBeforeBackup()
    {
        LifecycleFixture fixture = CreateFixture();
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", stateSchemaVersion: 2);
        AuthoringStateMigrationPlan plan = CreatePlan(fixture.Package, next) with
        {
            To = CreatePlan(fixture.Package, next).To with
            {
                ExtensionId = "other.plugin"
            }
        };

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), plan));

        Assert.False(fixture.State.BackupCalled);
    }

    [Fact]
    public async Task UninstallAsync_RetainsDataAndRevokesAuthority()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringStateScope scope = CreateScope(fixture.Package);

        AuthoringLifecycleReceipt receipt = await fixture.Coordinator.UninstallAsync(fixture.Package, scope);

        Assert.Equal(AuthoringLifecycleState.RetainedData, receipt.State);
        Assert.False(fixture.State.DeleteCalled);
        Assert.Equal(1, fixture.Resources.RevocationCount);
    }

    [Theory]
    [InlineData("site")]
    [InlineData("user")]
    [InlineData("document")]
    public async Task UpdateAsync_SymmetricEmptyScope_FailsBeforeBackup(string field)
    {
        LifecycleFixture fixture = CreateFixture();
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan original = CreatePlan(fixture.Package, next);
        AuthoringStateScope EmptyField(AuthoringStateScope scope) => field switch
        {
            "site" => scope with { SiteId = string.Empty },
            "user" => scope with { UserId = string.Empty },
            "document" => scope with { DocumentId = string.Empty },
            _ => throw new ArgumentOutOfRangeException(nameof(field))
        };
        AuthoringStateMigrationPlan plan = original with
        {
            From = EmptyField(original.From),
            To = EmptyField(original.To)
        };
        plan = SealPlan(plan);
        Assert.Equal(plan.From.SiteId, plan.To.SiteId);
        Assert.Equal(plan.From.UserId, plan.To.UserId);
        Assert.Equal(plan.From.DocumentId, plan.To.DocumentId);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), plan));

        Assert.False(fixture.State.BackupCalled);
        Assert.Equal(0, fixture.Resources.ActivationCount);
        Assert.Empty(fixture.Receipts.All);
    }

    [Fact]
    public async Task UpdateAsync_ExactOwnedScopeWithOptionalDocument_UsesTheMigration()
    {
        LifecycleFixture fixture = CreateFixture();
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan original = CreatePlan(fixture.Package, next);
        AuthoringStateMigrationPlan plan = original with
        {
            From = original.From with { DocumentId = null },
            To = original.To with { DocumentId = null }
        };
        plan = SealPlan(plan);

        AuthoringLifecycleReceipt receipt = await fixture.Coordinator.UpdateAsync(
            fixture.Package, next, CreateTargets(next), plan);

        Assert.True(fixture.State.BackupCalled);
        Assert.Equal(AuthoringLifecycleState.Running, receipt.State);
        Assert.Equal(next, fixture.Resources.LastActivatedPackage);
    }

    [Fact]
    public async Task DeleteOwnedDataAsync_RequiresSeparateExactApprovalAndMeasuredScope()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringStateScope scope = CreateScope(fixture.Package);
        await fixture.Coordinator.UninstallAsync(fixture.Package, scope);
        fixture.State.Measurement = (3, 128);
        var approval = new AuthoringDeleteDataApproval(
            fixture.Package.Contract.Manifest.Id,
            fixture.Package.Contract.Manifest.PackageSha256,
            scope,
            3,
            128,
            "delete-approval-1");

        await fixture.Coordinator.DeleteOwnedDataAsync(fixture.Package, approval);

        Assert.True(fixture.State.DeleteCalled);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.DeleteOwnedDataAsync(
                fixture.Package,
                approval with
                {
                    ExpectedRecords = 4
                }));
    }

    [Theory]
    [InlineData("plan-id")]
    [InlineData("site")]
    [InlineData("user")]
    [InlineData("document")]
    [InlineData("records")]
    [InlineData("bytes")]
    [InlineData("duration")]
    [InlineData("transform-source")]
    [InlineData("transform-target")]
    [InlineData("default-bytes")]
    [InlineData("backup")]
    [InlineData("rollback")]
    public async Task UpdateAsync_ChangedPayloadWithOriginalDigest_FailsBeforeAnySideEffect(string field)
    {
        LifecycleFixture fixture = CreateFixture();
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan original = CreatePlan(fixture.Package, next);
        if (field == "default-bytes")
        {
            original = SealPlan(original with
            {
                Transforms = [new(AuthoringStateTransformKind.SetDefault, "new", null, [])]
            });
        }
        AuthoringStateMigrationPlan changed = ChangeAcceptedPlanField(original, field);
        Assert.Equal(original.ContentSha256, changed.ContentSha256);
        Assert.NotEqual(original.ContentSha256,
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(changed));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), changed));

        Assert.False(fixture.State.BackupCalled);
        Assert.False(fixture.State.RollbackCalled);
        Assert.Equal(0, fixture.Resources.ActivationCount);
        Assert.Equal(0, fixture.Resources.RevocationCount);
        Assert.Empty(fixture.Receipts.All);
    }

    [Theory]
    [InlineData("plan-id")]
    [InlineData("site")]
    [InlineData("user")]
    [InlineData("document")]
    [InlineData("records")]
    [InlineData("bytes")]
    [InlineData("duration")]
    [InlineData("transform-source")]
    [InlineData("transform-target")]
    [InlineData("default-bytes")]
    [InlineData("backup")]
    [InlineData("rollback")]
    public async Task UpdateAsync_RecomputedLegalPayload_StillUsesTheMigration(string field)
    {
        LifecycleFixture fixture = CreateFixture();
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan original = CreatePlan(fixture.Package, next);
        if (field == "default-bytes")
        {
            original = SealPlan(original with
            {
                Transforms = [new(AuthoringStateTransformKind.SetDefault, "new", null, [])]
            });
        }
        AuthoringStateMigrationPlan changed = SealPlan(ChangeAcceptedPlanField(original, field));
        Assert.NotEqual(original.ContentSha256, changed.ContentSha256);

        AuthoringLifecycleReceipt receipt = await fixture.Coordinator.UpdateAsync(
            fixture.Package, next, CreateTargets(next), changed);

        Assert.True(fixture.State.BackupCalled);
        Assert.Equal(AuthoringLifecycleState.Running, receipt.State);
        Assert.Equal(next, fixture.Resources.LastActivatedPackage);
    }

    [Theory]
    [InlineData("from-extension")]
    [InlineData("to-extension")]
    [InlineData("from-version")]
    [InlineData("to-version")]
    [InlineData("from-site")]
    [InlineData("to-site")]
    [InlineData("from-user")]
    [InlineData("to-user")]
    [InlineData("from-document")]
    [InlineData("to-document")]
    [InlineData("from-schema")]
    [InlineData("to-schema")]
    [InlineData("transform-kind")]
    [InlineData("null-destination")]
    [InlineData("default-array")]
    [InlineData("transform-count")]
    public void MigrationDigest_CoversEveryRemainingScopeAndTransformField(string field)
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringStateMigrationPlan plan = CreatePlan(fixture.Package, CreatePackage("2.0.0", 2));
        AuthoringStateTransform transform = plan.Transforms[0];
        AuthoringStateMigrationPlan changed = field switch
        {
            "from-extension" => plan with { From = plan.From with { ExtensionId = "another.plugin" } },
            "to-extension" => plan with { To = plan.To with { ExtensionId = "another.plugin" } },
            "from-version" => plan with { From = plan.From with { ExtensionVersion = "1.0.1" } },
            "to-version" => plan with { To = plan.To with { ExtensionVersion = "2.0.1" } },
            "from-site" => plan with { From = plan.From with { SiteId = "other-site" } },
            "to-site" => plan with { To = plan.To with { SiteId = "other-site" } },
            "from-user" => plan with { From = plan.From with { UserId = "other-user" } },
            "to-user" => plan with { To = plan.To with { UserId = "other-user" } },
            "from-document" => plan with { From = plan.From with { DocumentId = null } },
            "to-document" => plan with { To = plan.To with { DocumentId = null } },
            "from-schema" => plan with { From = plan.From with { SchemaVersion = 2 } },
            "to-schema" => plan with { To = plan.To with { SchemaVersion = 3 } },
            "transform-kind" => plan with { Transforms = [transform with { Kind = AuthoringStateTransformKind.SetDefault }] },
            "null-destination" => plan with { Transforms = [transform with { DestinationKey = null }] },
            "default-array" => plan with { Transforms = [transform with { DefaultValue = default }] },
            "transform-count" => plan with { Transforms = [transform, transform] },
            _ => throw new ArgumentOutOfRangeException(nameof(field))
        };

        Assert.NotEqual(plan.ContentSha256,
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(changed));
    }

    [Fact]
    public async Task MigrationDigest_OrderedTransformsCannotBeReorderedUnderTheOriginalDigest()
    {
        LifecycleFixture fixture = CreateFixture();
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan original = CreatePlan(fixture.Package, next);
        original = SealPlan(original with
        {
            Transforms = [original.Transforms[0], new(AuthoringStateTransformKind.DeleteExtensionKey, "obsolete", null, [])]
        });
        AuthoringStateMigrationPlan changed = original with
        {
            Transforms = [original.Transforms[1], original.Transforms[0]]
        };
        Assert.NotEqual(original.ContentSha256,
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(changed));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), changed));
        Assert.False(fixture.State.BackupCalled);
        Assert.Empty(fixture.Receipts.All);

        AuthoringLifecycleReceipt receipt = await fixture.Coordinator.UpdateAsync(
            fixture.Package, next, CreateTargets(next), SealPlan(changed));
        Assert.Equal(AuthoringLifecycleState.Running, receipt.State);
    }

    private static AuthoringStateMigrationPlan ChangeAcceptedPlanField(AuthoringStateMigrationPlan plan, string field) => field switch
    {
        "plan-id" => plan with { PlanId = "migration-2" },
        "site" => plan with { From = plan.From with { SiteId = "site-2" }, To = plan.To with { SiteId = "site-2" } },
        "user" => plan with { From = plan.From with { UserId = "user-2" }, To = plan.To with { UserId = "user-2" } },
        "document" => plan with { From = plan.From with { DocumentId = null }, To = plan.To with { DocumentId = null } },
        "records" => plan with { MaximumRecords = 101 },
        "bytes" => plan with { MaximumBytes = 1025 },
        "duration" => plan with { MaximumDuration = plan.MaximumDuration + TimeSpan.FromTicks(1) },
        "transform-source" => plan with { Transforms = [plan.Transforms[0] with { SourceKey = "other" }] },
        "transform-target" => plan with { Transforms = [plan.Transforms[0] with { DestinationKey = "other" }] },
        "default-bytes" => plan with { Transforms = [plan.Transforms[0] with { DefaultValue = [0, 255] }] },
        "backup" => plan with { BackupReference = "backup/2" },
        "rollback" => plan with { RollbackReference = "rollback/2" },
        _ => throw new ArgumentOutOfRangeException(nameof(field))
    };

    [Theory]
    [InlineData("records-negative")]
    [InlineData("records-over-limit")]
    [InlineData("bytes-negative")]
    [InlineData("bytes-over-limit")]
    [InlineData("duration-zero")]
    [InlineData("duration-over-limit")]
    public async Task UpdateAsync_RecomputedDigestDoesNotAuthorizeOutOfBudgetPlans(string field)
    {
        LifecycleFixture fixture = CreateFixture();
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan original = CreatePlan(fixture.Package, next);
        AuthoringStateMigrationPlan changed = field switch
        {
            "records-negative" => original with { MaximumRecords = -1 },
            "records-over-limit" => original with { MaximumRecords = 1_000_001 },
            "bytes-negative" => original with { MaximumBytes = -1 },
            "bytes-over-limit" => original with { MaximumBytes = 536_870_913 },
            "duration-zero" => original with { MaximumDuration = TimeSpan.Zero },
            "duration-over-limit" => original with { MaximumDuration = TimeSpan.FromMinutes(5) + TimeSpan.FromTicks(1) },
            _ => throw new ArgumentOutOfRangeException(nameof(field))
        };
        changed = SealPlan(changed);
        Assert.Equal(changed.ContentSha256,
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(changed));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), changed));
        Assert.False(fixture.State.BackupCalled);
        Assert.Empty(fixture.Receipts.All);
    }

    [Fact]
    public void MigrationDigest_UsesTheIndependentVersionedBinaryProtocolVector()
    {
        var plan = new AuthoringStateMigrationPlan(
            "vector-1",
            new("acme.example", "1.0.0", "site-1", "user-1", null, 1),
            new("acme.example", "2.0.0", "site-1", "user-1", null, 2),
            1, 2, TimeSpan.FromTicks(3),
            [new(AuthoringStateTransformKind.SetDefault, "a", null, [0, 255])],
            "backup/1", "rollback/1", string.Empty);

        Assert.Equal("0b93ab929e9040b4346f6a88a9e4b1df6983159f8a7267c8b1037618ff9f54bf",
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(plan));
        Assert.Equal(AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(plan),
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(plan with { ContentSha256 = new string('f', 64) }));
    }

    [Fact]
    public void MigrationDigest_PreservesNullEmptyAndFramedStringBoundaries()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringStateMigrationPlan original = CreatePlan(fixture.Package, CreatePackage("2.0.0", 2));
        AuthoringStateMigrationPlan nullDocument = original with { From = original.From with { DocumentId = null } };
        AuthoringStateMigrationPlan emptyDocument = original with { From = original.From with { DocumentId = string.Empty } };
        Assert.NotEqual(AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(nullDocument),
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(emptyDocument));
        AuthoringStateMigrationPlan left = original with { From = original.From with { SiteId = "ab", UserId = "c" } };
        AuthoringStateMigrationPlan right = original with { From = original.From with { SiteId = "a", UserId = "bc" } };
        Assert.Equal(left.From.SiteId + left.From.UserId, right.From.SiteId + right.From.UserId);
        Assert.NotEqual(AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(left),
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(right));
    }

    [Fact]
    public void MigrationDigest_DoesNotReplaceInvalidUtf16WithCollidingUtf8Bytes()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringStateMigrationPlan plan = CreatePlan(fixture.Package, CreatePackage("2.0.0", 2));

        Assert.Throws<System.Text.EncoderFallbackException>(() =>
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(plan with { PlanId = "\ud800" }));
    }

    [Theory]
    [InlineData("receipt", false)]
    [InlineData("backup", false)]
    [InlineData("receipt", true)]
    [InlineData("backup", true)]
    public async Task UpdateAsync_CallerBackingMutationCannotChangeTheAdmittedSnapshot(string stage, bool failApply)
    {
        byte[] callerBytes = [1, 2];
        AuthoringStateTransform[] callerTransforms =
        [new(AuthoringStateTransformKind.SetDefault, "new", null,
            System.Runtime.InteropServices.ImmutableCollectionsMarshal.AsImmutableArray(callerBytes))];
        bool mutated = false;
        void MutateCaller()
        {
            callerBytes[0] = 9;
            callerTransforms[0] = callerTransforms[0] with { SourceKey = "changed-after-admission" };
            mutated = true;
        }
        var state = new StateStore
        {
            FailMigration = failApply,
            BeforeBackup = stage == "backup" ? _ => MutateCaller() : null
        };
        var receipts = new ReceiptStore
        {
            BeforeAppend = stage == "receipt" ? _ => MutateCaller() : null
        };
        LifecycleFixture fixture = CreateFixture(stateStore: state, receiptStore: receipts);
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan callerPlan = SealPlan(CreatePlan(fixture.Package, next) with
        {
            Transforms = System.Runtime.InteropServices.ImmutableCollectionsMarshal.AsImmutableArray(callerTransforms)
        });

        if (failApply)
        {
            await Assert.ThrowsAsync<InvalidOperationException>(async () =>
                await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), callerPlan));
        }
        else
        {
            AuthoringLifecycleReceipt receipt = await fixture.Coordinator.UpdateAsync(
                fixture.Package, next, CreateTargets(next), callerPlan);
            Assert.Equal(AuthoringLifecycleState.Running, receipt.State);
        }

        Assert.True(mutated);
        Assert.Equal(9, callerBytes[0]);
        Assert.Equal("changed-after-admission", callerTransforms[0].SourceKey);
        AuthoringStateMigrationPlan snapshot = Assert.IsType<AuthoringStateMigrationPlan>(state.BackupPlan);
        Assert.NotSame(callerPlan, snapshot);
        AuthoringStateMigrationPlan applied = Assert.IsType<AuthoringStateMigrationPlan>(state.AppliedPlan);
        Assert.NotSame(snapshot, applied);
        Assert.Equal("new", snapshot.Transforms[0].SourceKey);
        Assert.Equal(new byte[] { 1, 2 }, snapshot.Transforms[0].DefaultValue.ToArray());
        Assert.NotSame(callerBytes,
            System.Runtime.InteropServices.ImmutableCollectionsMarshal.AsArray(snapshot.Transforms[0].DefaultValue));
        Assert.Equal(callerPlan.ContentSha256,
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(snapshot));
        Assert.Equal(callerPlan.ContentSha256,
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(applied));
        if (failApply)
        {
            Assert.Equal(callerPlan.ContentSha256,
                AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(state.RolledBackPlan!));
            Assert.False(state.RollbackToken.CanBeCanceled);
        }
        else
        {
            Assert.Null(state.RolledBackPlan);
        }
    }

    [Theory]
    [InlineData("source-key")]
    [InlineData("destination-key")]
    [InlineData("default-entry")]
    [InlineData("default-total")]
    [InlineData("zero-byte-budget")]
    [InlineData("transform-count")]
    public async Task MigrationPayload_PreflightRejectsUnboundedWorkBeforeHashCopyOrState(string field)
    {
        LifecycleFixture fixture = CreateFixture();
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan original = CreatePlan(fixture.Package, next);
        var defaults = new AuthoringStateTransform(AuthoringStateTransformKind.SetDefault, "new", null, [1, 2]);
        AuthoringStateMigrationPlan oversized = field switch
        {
            "source-key" => original with { Transforms = [original.Transforms[0] with { SourceKey = new string('x', 257) }] },
            "destination-key" => original with { Transforms = [original.Transforms[0] with { DestinationKey = new string('x', 257) }] },
            "default-entry" => original with { MaximumBytes = 1, Transforms = [defaults] },
            "default-total" => original with { MaximumBytes = 2, Transforms = [defaults, defaults] },
            "zero-byte-budget" => original with { MaximumBytes = 0, Transforms = [defaults] },
            "transform-count" => original with { Transforms = Enumerable.Repeat(original.Transforms[0], 1001).ToImmutableArray() },
            _ => throw new ArgumentOutOfRangeException(nameof(field))
        };

        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(oversized));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), oversized));
        Assert.False(fixture.State.BackupCalled);
        Assert.Empty(fixture.Receipts.All);
        Assert.Equal(0, fixture.Resources.ActivationCount);
    }

    [Fact]
    public async Task MigrationPayload_ExactFieldAndDefaultBudgetBoundaryRemainsLegal()
    {
        LifecycleFixture fixture = CreateFixture();
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan plan = SealPlan(CreatePlan(fixture.Package, next) with
        {
            MaximumBytes = 2,
            Transforms = [new(AuthoringStateTransformKind.SetDefault, new string('k', 256), null, [1, 2])]
        });

        AuthoringLifecycleReceipt receipt = await fixture.Coordinator.UpdateAsync(
            fixture.Package, next, CreateTargets(next), plan);
        Assert.Equal(AuthoringLifecycleState.Running, receipt.State);
        Assert.Equal(new byte[] { 1, 2 }, fixture.State.AppliedPlan!.Transforms[0].DefaultValue.ToArray());
    }

    [Theory]
    [InlineData("caller")]
    [InlineData("duration")]
    public async Task UpdateAsync_OneCallerAndDurationBudgetStopsForwardStateAfterBackup(string cause)
    {
        using var caller = new CancellationTokenSource();
        var clock = new MigrationDeadlineTimeProvider();
        var state = new StateStore
        {
            BeforeBackup = _ =>
            {
                if (cause == "caller")
                {
                    caller.Cancel();
                }
                else
                {
                    clock.Expire();
                }
            }
        };
        LifecycleFixture fixture = CreateFixture(stateStore: state, timeProvider: clock);
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan plan = CreatePlan(fixture.Package, next);

        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), plan, caller.Token));
        Assert.Equal(plan.MaximumDuration, clock.Duration);
        Assert.True(clock.TimerDisposed);
        Assert.True(state.BackupCalled);
        Assert.Null(state.AppliedPlan);
        Assert.Equal(0, fixture.Resources.ActivationCount);
        Assert.DoesNotContain(fixture.Receipts.All, receipt => receipt.State == AuthoringLifecycleState.Running);
    }

    [Fact]
    public void MigrationDigest_CancelledCallerCannotStartThePayloadScan()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringStateMigrationPlan plan = CreatePlan(fixture.Package, CreatePackage("2.0.0", 2));
        using var caller = new CancellationTokenSource();
        caller.Cancel();

        Assert.Throws<OperationCanceledException>(() =>
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(plan, caller.Token));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task UpdateAsync_FrozenDefaultBytesPreserveDefaultAndEmpty(bool useDefault)
    {
        LifecycleFixture fixture = CreateFixture();
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan original = CreatePlan(fixture.Package, next);
        AuthoringStateMigrationPlan plan = SealPlan(original with
        {
            Transforms = [original.Transforms[0] with
            {
                DefaultValue = useDefault ? default : ImmutableArray<byte>.Empty
            }]
        });

        AuthoringLifecycleReceipt receipt = await fixture.Coordinator.UpdateAsync(
            fixture.Package, next, CreateTargets(next), plan);
        Assert.Equal(AuthoringLifecycleState.Running, receipt.State);
        Assert.Equal(useDefault, fixture.State.AppliedPlan!.Transforms[0].DefaultValue.IsDefault);
        Assert.Equal(plan.ContentSha256,
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(fixture.State.AppliedPlan));
    }

    [Theory]
    [InlineData("source")]
    [InlineData("destination")]
    public async Task UpdateAsync_DigestDoesNotAuthorizeEmptyTransformKeys(string field)
    {
        LifecycleFixture fixture = CreateFixture();
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan original = CreatePlan(fixture.Package, next);
        AuthoringStateTransform transform = field == "source"
            ? original.Transforms[0] with { SourceKey = string.Empty }
            : original.Transforms[0] with { DestinationKey = string.Empty };
        AuthoringStateMigrationPlan plan = SealPlan(original with { Transforms = [transform] });

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), plan));
        Assert.False(fixture.State.BackupCalled);
        Assert.Empty(fixture.Receipts.All);
    }

    private sealed class MigrationDeadlineTimeProvider : TimeProvider
    {
        private OwnedTimer? _timer;

        public TimeSpan Duration { get; private set; }

        public bool TimerDisposed => _timer?.Disposed == true;

        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
        {
            Duration = dueTime;
            _timer = new OwnedTimer(callback, state);
            return _timer;
        }

        public void Expire() => _timer!.Fire();

        private sealed class OwnedTimer(TimerCallback callback, object? state) : ITimer
        {
            public bool Disposed { get; private set; }

            public bool Change(TimeSpan dueTime, TimeSpan period) => !Disposed;

            public void Fire()
            {
                if (!Disposed)
                {
                    callback(state);
                }
            }

            public void Dispose() => Disposed = true;

            public ValueTask DisposeAsync()
            {
                Dispose();
                return ValueTask.CompletedTask;
            }
        }
    }

    [Theory]
    [InlineData("backup")]
    [InlineData("apply")]
    public async Task UpdateAsync_StateCallbackCannotChangeTheRetainedRecoveryPayload(string stage)
    {
        void ChangeCarrier(AuthoringStateMigrationPlan carrier)
        {
            byte[] bytes = System.Runtime.InteropServices.ImmutableCollectionsMarshal.AsArray(carrier.Transforms[0].DefaultValue)!;
            bytes[0] = 9;
        }
        var state = new StateStore
        {
            BeforeBackup = stage == "backup" ? ChangeCarrier : null,
            BeforeApply = stage == "apply" ? ChangeCarrier : null
        };
        LifecycleFixture fixture = CreateFixture(stateStore: state);
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan plan = SealPlan(CreatePlan(fixture.Package, next) with
        {
            Transforms = [new(AuthoringStateTransformKind.SetDefault, "new", null, [1, 2])]
        });

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), plan));
        Assert.Equal(0, fixture.Resources.ActivationCount);
        Assert.Equal(new byte[] { 1, 2 }, plan.Transforms[0].DefaultValue.ToArray());
        if (stage == "backup")
        {
            Assert.Null(state.AppliedPlan);
        }
        else
        {
            Assert.Equal(new byte[] { 1, 2 }, state.RolledBackPlan!.Transforms[0].DefaultValue.ToArray());
            Assert.Equal(plan.ContentSha256,
                AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(state.RolledBackPlan));
            Assert.False(state.RollbackToken.CanBeCanceled);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UpdateAsync_RetainedPriorCarrierCannotChangeApplyOrRollback(bool failApply)
    {
        StateStore? state = null;
        state = new StateStore
        {
            FailMigration = failApply,
            BeforeApply = _ =>
                System.Runtime.InteropServices.ImmutableCollectionsMarshal.AsArray(state!.BackupPlan!.Transforms[0].DefaultValue)![0] = 9
        };
        LifecycleFixture fixture = CreateFixture(stateStore: state);
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan plan = SealPlan(CreatePlan(fixture.Package, next) with
        {
            Transforms = [new(AuthoringStateTransformKind.SetDefault, "new", null, [1, 2])]
        });

        if (failApply)
        {
            await Assert.ThrowsAsync<InvalidOperationException>(async () =>
                await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), plan));
            Assert.Equal(new byte[] { 1, 2 }, state.RolledBackPlan!.Transforms[0].DefaultValue.ToArray());
        }
        else
        {
            AuthoringLifecycleReceipt receipt = await fixture.Coordinator.UpdateAsync(
                fixture.Package, next, CreateTargets(next), plan);
            Assert.Equal(AuthoringLifecycleState.Running, receipt.State);
        }
        Assert.Equal(9, state.BackupPlan!.Transforms[0].DefaultValue[0]);
        Assert.Equal(new byte[] { 1, 2 }, state.AppliedPlan!.Transforms[0].DefaultValue.ToArray());
        Assert.Equal(plan.ContentSha256,
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(state.AppliedPlan));
    }

    [Theory]
    [InlineData("caller")]
    [InlineData("duration")]
    public async Task UpdateAsync_FinalRunningAppendCancellationRetainsCommitAndRecordsClosedFailure(string cause)
    {
        using var caller = new CancellationTokenSource();
        var clock = new MigrationDeadlineTimeProvider();
        var receipts = new ReceiptStore
        {
            BeforeAppend = receipt =>
            {
                if (receipt.State == AuthoringLifecycleState.Running)
                {
                    if (cause == "caller")
                    {
                        caller.Cancel();
                    }
                    else
                    {
                        clock.Expire();
                    }
                }
            }
        };
        LifecycleFixture fixture = CreateFixture(receiptStore: receipts, timeProvider: clock);
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);
        AuthoringStateMigrationPlan plan = CreatePlan(fixture.Package, next);

        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await fixture.Coordinator.UpdateAsync(fixture.Package, next, CreateTargets(next), plan, caller.Token));

        AuthoringLifecycleReceipt committed = Assert.Single(receipts.All,
            receipt => receipt.State == AuthoringLifecycleState.Running);
        AuthoringLifecycleReceipt failed = Assert.IsType<AuthoringLifecycleReceipt>(receipts.Latest);
        Assert.Equal(AuthoringLifecycleState.Failed, failed.State);
        Assert.Equal(committed.Sequence + 1, failed.Sequence);
        Assert.Equal(committed.Generation + 1, failed.Generation);
        Assert.Equal(committed.ReceiptSha256, failed.PreviousReceiptSha256);
        Assert.Equal(AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(failed), failed.ReceiptSha256);
        Assert.Equal(fixture.Package.Contract.Manifest.Version, failed.Version);
        Assert.Equal("migration-completion-rejected", failed.FailureCode);
        Assert.True(fixture.State.RollbackCalled);
        Assert.False(fixture.State.RollbackToken.CanBeCanceled);
        Assert.Equal(plan.ContentSha256,
            AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(fixture.State.RolledBackPlan!));
        Assert.Equal(2, fixture.Resources.RevocationCount);
        Assert.Equal(committed.Generation, fixture.Resources.LastRevocationGeneration);
        Assert.Equal(1, fixture.Resources.ActivationCount);
        Assert.False(await fixture.Coordinator.AcceptResultAsync(next.Contract.Manifest.Id, committed.Generation));
        Assert.True(clock.TimerDisposed);
        Assert.DoesNotContain(receipts.All, receipt => receipt.State == AuthoringLifecycleState.RollbackRequired);
    }

    [Fact]
    public async Task UpdateAsync_PostCommitRecoveryFailureKeepsPrimaryAndSecondaryErrors()
    {
        using var caller = new CancellationTokenSource();
        var rollbackFailure = new IOException("owned rollback failure");
        var state = new StateStore { RollbackFailure = rollbackFailure };
        var receipts = new ReceiptStore
        {
            BeforeAppend = receipt =>
            {
                if (receipt.State == AuthoringLifecycleState.Running)
                {
                    caller.Cancel();
                }
            },
            FailAppend = static receipt => receipt.State == AuthoringLifecycleState.Failed
        };
        LifecycleFixture fixture = CreateFixture(stateStore: state, receiptStore: receipts);
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);

        AggregateException failure = await Assert.ThrowsAsync<AggregateException>(async () =>
            await fixture.Coordinator.UpdateAsync(
                fixture.Package, next, CreateTargets(next), CreatePlan(fixture.Package, next), caller.Token));

        Assert.Equal(3, failure.InnerExceptions.Count);
        Assert.IsType<OperationCanceledException>(failure.InnerExceptions[0]);
        Assert.Same(rollbackFailure, failure.InnerExceptions[1]);
        Assert.IsType<IOException>(failure.InnerExceptions[2]);
        Assert.True(state.RollbackCalled);
        Assert.False(state.RollbackToken.CanBeCanceled);
        Assert.Equal(2, fixture.Resources.RevocationCount);
        Assert.Single(receipts.All, receipt => receipt.State == AuthoringLifecycleState.Running);
        Assert.DoesNotContain(receipts.All, receipt => receipt.State == AuthoringLifecycleState.Failed);
    }

    [Fact]
    public async Task DeleteOwnedDataAsync_CannotDeleteCoreOrOtherPluginScope()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringStateScope other = CreateScope(fixture.Package) with
        {
            ExtensionId = "other.plugin"
        };
        var approval = new AuthoringDeleteDataApproval(
            fixture.Package.Contract.Manifest.Id,
            fixture.Package.Contract.Manifest.PackageSha256,
            other,
            0,
            0,
            "delete-approval-1");

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.DeleteOwnedDataAsync(fixture.Package, approval));
        Assert.False(fixture.State.DeleteCalled);
    }

    [Fact]
    public async Task RestoreFromReceiptAsync_UsesReceiptAuthorityOnly()
    {
        LifecycleFixture fixture = CreateFixture();
        AuthoringLifecycleReceipt enabled = await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets);

        AuthoringLifecycleReceipt? restored = await fixture.Coordinator.RestoreFromReceiptAsync(
            fixture.Package.Contract.Manifest.Id);

        Assert.Equal(enabled, restored);
        Assert.Equal(0, fixture.State.DirectoryScanCount);
    }

    [Fact]
    public async Task RuntimeResources_RevokeTrackedWorkerServiceAndEveryHostAuthority()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        ImmutableArray<AuthoringExecutionTarget> targets = CreateTargets(package);
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        await resources.ActivateAtomicallyAsync(package, targets, 1, CancellationToken.None);
        var worker = new TrackedWorker();
        var service = new TrackedService();
        await resources.TrackWorkerAsync(package.Contract.Manifest.Id, 1, worker);
        await resources.TrackServiceAsync(package.Contract.Manifest.Id, 1, service);

        AuthoringLifecycleResourceReport report = await resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            2,
            CancellationToken.None);

        Assert.True(report.IsEmpty);
        Assert.True(worker.Terminated);
        Assert.True(worker.Disposed);
        Assert.True(service.Terminated);
        Assert.True(service.Disposed);
        Assert.Equal(1, host.RevocationCount);
    }

    [Fact]
    public async Task RuntimeResources_RollbackUsesOnlyExactRecordedTargetMapping()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        ImmutableArray<AuthoringExecutionTarget> targets = CreateTargets(package);
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        await resources.ActivateAtomicallyAsync(package, targets, 1, CancellationToken.None);
        Assert.True((await resources.RevokeAllAsync(package.Contract.Manifest.Id, 2, CancellationToken.None)).IsEmpty);

        await resources.ActivateAtomicallyAsync(package, [], 3, CancellationToken.None);

        Assert.Equal(2, host.ActivationCount);
        Assert.Equal(targets.Length, host.LastTargetCount);
        VerifiedAuthoringPackage unknown = CreatePackage("1.1.0", 1);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await new AuthoringExtensionLifecycleResources(new HostResources()).ActivateAtomicallyAsync(
                unknown,
                [],
                1,
                CancellationToken.None));
    }

    [Fact]
    public async Task RuntimeResources_OlderGenerationCannotRevokeNewGeneration()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        ImmutableArray<AuthoringExecutionTarget> targets = CreateTargets(package);
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        await resources.ActivateAtomicallyAsync(package, targets, 5, CancellationToken.None);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await resources.RevokeAllAsync(package.Contract.Manifest.Id, 4, CancellationToken.None));

        Assert.Equal(0, host.RevocationCount);
        Assert.True((await resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            5,
            CancellationToken.None)).IsEmpty);
        Assert.Equal(1, host.RevocationCount);
    }

    [Fact]
    public async Task RuntimeResources_StaleGenerationCannotTrackWorker()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        var resources = new AuthoringExtensionLifecycleResources(new HostResources());
        await resources.ActivateAtomicallyAsync(package, CreateTargets(package), 2, CancellationToken.None);
        var worker = new TrackedWorker();

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await resources.TrackWorkerAsync(package.Contract.Manifest.Id, 1, worker));

        Assert.True(worker.Terminated);
        Assert.True(worker.Disposed);
        Assert.True((await resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            2,
            CancellationToken.None)).IsEmpty);
    }

    [Fact]
    public async Task RuntimeResources_ReleaseRacingRevokeDisposesExactlyOnce()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        ImmutableArray<AuthoringExecutionTarget> targets = CreateTargets(package);
        var resources = new AuthoringExtensionLifecycleResources(new HostResources());
        await resources.ActivateAtomicallyAsync(package, targets, 1, CancellationToken.None);
        var worker = new BlockingTrackedWorker();
        await resources.TrackWorkerAsync(package.Contract.Manifest.Id, 1, worker);

        Task<AuthoringLifecycleResourceReport> revoke = resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            1,
            CancellationToken.None).AsTask();
        await worker.TerminationStarted.Task;
        await resources.ReleaseWorkerAsync(package.Contract.Manifest.Id, 1, worker);
        worker.AllowTermination.SetResult();

        Assert.True((await revoke).IsEmpty);
        Assert.Equal(1, worker.DisposeCount);
    }

    [Fact]
    public async Task RuntimeResources_TerminationFailureRemainsReportedAfterDisposal()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        var resources = new AuthoringExtensionLifecycleResources(new HostResources());
        await resources.ActivateAtomicallyAsync(package, CreateTargets(package), 1, CancellationToken.None);
        var worker = new FailingTerminationWorker();
        await resources.TrackWorkerAsync(package.Contract.Manifest.Id, 1, worker);

        AuthoringLifecycleResourceReport report = await resources.RevokeAllAsync(
            package.Contract.Manifest.Id,
            1,
            CancellationToken.None);

        Assert.Equal(1, report.WorkerInstances);
        Assert.True(worker.Disposed);
    }

    [Fact]
    public async Task EnableAsync_RunningReceiptFailureRevokesActivatedGeneration()
    {
        var receipts = new ReceiptStore
        {
            FailAppend = static receipt => receipt.State == AuthoringLifecycleState.Running
        };
        LifecycleFixture fixture = CreateFixture(receiptStore: receipts);

        await Assert.ThrowsAsync<IOException>(async () =>
            await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets));

        Assert.Equal(1, fixture.Resources.RevocationCount);
        Assert.Equal(fixture.Resources.LastActivationGeneration, fixture.Resources.LastRevocationGeneration);
        Assert.Equal(AuthoringLifecycleState.Crashed, fixture.Receipts.Latest?.State);
    }

    [Fact]
    public async Task UpdateAsync_RunningReceiptFailureCleansNewResourcesBeforeStateRollback()
    {
        List<string> trace = [];
        var resources = new ResourceAuthority { Trace = trace };
        var state = new StateStore { Trace = trace };
        var receipts = new ReceiptStore();
        LifecycleFixture fixture = CreateFixture(resources, state, receipts);
        await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets);
        trace.Clear();
        receipts.FailAppend = static receipt =>
            receipt.State == AuthoringLifecycleState.Running && receipt.Version == "2.0.0";
        VerifiedAuthoringPackage next = CreatePackage("2.0.0", 2);

        await Assert.ThrowsAsync<IOException>(async () =>
            await fixture.Coordinator.UpdateAsync(
                fixture.Package,
                next,
                CreateTargets(next),
                CreatePlan(fixture.Package, next)));

        int newActivation = trace.FindIndex(static item => item.StartsWith("activate:2.0.0:", StringComparison.Ordinal));
        int newRevocation = trace.FindIndex(newActivation + 1, static item => item.StartsWith("revoke:", StringComparison.Ordinal));
        int rollback = trace.IndexOf("rollback");
        int oldReactivation = trace.FindIndex(static item => item.StartsWith("activate:1.0.0:", StringComparison.Ordinal));
        Assert.True(newActivation >= 0);
        Assert.True(newRevocation > newActivation);
        Assert.True(rollback > newRevocation);
        Assert.True(oldReactivation > rollback);
        Assert.Equal(AuthoringLifecycleState.Running, receipts.Latest?.State);
    }

    [Fact]
    public async Task RuntimeHealth_ReceiptFailureRestoresPriorResourceGeneration()
    {
        var resources = new ResourceAuthority();
        var receipts = new ReceiptStore();
        LifecycleFixture fixture = CreateFixture(resources: resources, receiptStore: receipts);
        AuthoringLifecycleReceipt running = await fixture.Coordinator.EnableAsync(fixture.Package, fixture.Targets);
        receipts.FailAppend = static receipt => receipt.State == AuthoringLifecycleState.Degraded;

        await Assert.ThrowsAsync<IOException>(async () =>
            await fixture.Coordinator.MarkDegradedAsync(
                fixture.Package,
                running.Generation,
                "health-probe-failed"));

        Assert.Equal(running.Generation, resources.ActiveGeneration);
        Assert.Equal(running, receipts.Latest);
    }

    [Fact]
    public async Task RuntimeHealth_RebindsTrackingReleaseAndDisableToCurrentGeneration()
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        ImmutableArray<AuthoringExecutionTarget> targets = CreateTargets(package);
        var host = new HostResources();
        var resources = new AuthoringExtensionLifecycleResources(host);
        var receipts = new ReceiptStore();
        var coordinator = new AuthoringExtensionLifecycleCoordinator(
            resources,
            new Preflight(true),
            new StateStore(),
            receipts,
            new AuthoringCapabilityGrantCatalogStub());
        AuthoringLifecycleReceipt running = await coordinator.EnableAsync(package, targets);
        AuthoringLifecycleReceipt degraded = await coordinator.MarkDegradedAsync(
            package,
            running.Generation,
            "health-probe-failed");
        var worker = new TrackedWorker();
        await resources.TrackWorkerAsync(package.Contract.Manifest.Id, degraded.Generation, worker);

        AuthoringLifecycleReceipt recovered = await coordinator.MarkRecoveredAsync(
            package,
            degraded.Generation);
        await resources.ReleaseWorkerAsync(package.Contract.Manifest.Id, degraded.Generation, worker);
        var service = new TrackedService();
        await resources.TrackServiceAsync(package.Contract.Manifest.Id, recovered.Generation, service);
        AuthoringLifecycleReceipt disabled = await coordinator.DisableAsync(package);

        Assert.Equal(degraded.Generation + 1, recovered.Generation);
        Assert.True(worker.Disposed);
        Assert.True(service.Terminated);
        Assert.True(service.Disposed);
        Assert.Equal(AuthoringLifecycleState.Disabled, disabled.State);
        Assert.Equal(1, host.RevocationCount);
    }

    private static LifecycleFixture CreateFixture(
        ResourceAuthority? resources = null,
        StateStore? stateStore = null,
        ReceiptStore? receiptStore = null,
        TimeProvider? timeProvider = null)
    {
        VerifiedAuthoringPackage package = CreatePackage("1.0.0", 1);
        resources ??= new ResourceAuthority();
        stateStore ??= new StateStore();
        ReceiptStore receipts = receiptStore ?? new ReceiptStore();
        var coordinator = new AuthoringExtensionLifecycleCoordinator(
            resources,
            new Preflight(true),
            stateStore,
            receipts,
            new AuthoringCapabilityGrantCatalogStub(),
            timeProvider);
        return new LifecycleFixture(
            package,
            CreateTargets(package),
            coordinator,
            resources,
            stateStore,
            receipts);
    }

    private static VerifiedAuthoringPackage CreatePackage(string version, int stateSchemaVersion)
    {
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest() with
        {
            Version = version,
            StateSchemaVersion = stateSchemaVersion
        };
        VerifiedAuthoringExtensionContract contract = AuthoringExtensionContractValidator.Verify(manifest);
        DateTimeOffset now = DateTimeOffset.UtcNow;
        return new VerifiedAuthoringPackage(
            contract,
            new AuthoringPackageArtifact([], [], "acme", "key-1", "source/1", "provenance/1"),
            new AuthoringPackageArchiveContents([], []),
            new AuthoringPackageTrustDecision(
                AuthoringPackageTrustStatus.Trusted,
                "acme",
                "key-1",
                now,
                now.AddMinutes(5)),
            new string(version.StartsWith('1') ? 'a' : 'b', 64));
    }

    private static ImmutableArray<AuthoringExecutionTarget> CreateTargets(VerifiedAuthoringPackage package)
    {
        AuthoringContributionDeclaration contribution = package.Contract.Manifest.Contributions[0];
        return
        [
            new AuthoringExecutionTarget(
                AuthoringExecutionResolutionStatus.Ready,
                contribution.ExecutionClass,
                package.Contract.Manifest.Id,
                package.Contract.Manifest.Version,
                package.Contract.Manifest.PackageSha256,
                contribution.Id,
                contribution.Kind,
                contribution.Entrypoint.PathOrAdapterId,
                null,
                new string('c', 64),
                null)
        ];
    }

    private static AuthoringStateMigrationPlan CreatePlan(
        VerifiedAuthoringPackage oldPackage,
        VerifiedAuthoringPackage newPackage) => SealPlan(new(
            "migration-1",
            CreateScope(oldPackage),
            CreateScope(newPackage),
            100,
            1024,
            TimeSpan.FromSeconds(5),
            [new AuthoringStateTransform(AuthoringStateTransformKind.RenameKey, "old", "new", [])],
            "backup/1",
            "rollback/1",
            string.Empty));

    private static AuthoringStateMigrationPlan SealPlan(AuthoringStateMigrationPlan plan) => plan with
    {
        ContentSha256 = AuthoringExtensionLifecycleCoordinator.ComputeMigrationPlanSha256(plan)
    };

    private static AuthoringStateScope CreateScope(VerifiedAuthoringPackage package) => new(
        package.Contract.Manifest.Id,
        package.Contract.Manifest.Version,
        "site-1",
        "user-1",
        "document-1",
        package.Contract.Manifest.StateSchemaVersion);

    private sealed record LifecycleFixture(
        VerifiedAuthoringPackage Package,
        ImmutableArray<AuthoringExecutionTarget> Targets,
        AuthoringExtensionLifecycleCoordinator Coordinator,
        ResourceAuthority Resources,
        StateStore State,
        ReceiptStore Receipts);

    private sealed class ResourceAuthority : IAuthoringLifecycleResourceAuthority
    {
        public AuthoringLifecycleResourceReport RevokeReport { get; init; } = new(0, 0, 0, 0, 0, 0, 0);

        public int ActivationCount
        {
            get; private set;
        }

        public int LastTargetCount
        {
            get; private set;
        }

        public int RevocationCount
        {
            get; private set;
        }

        public long ActiveGeneration
        {
            get; private set;
        }

        public long LastActivationGeneration
        {
            get; private set;
        }

        public long LastRevocationGeneration
        {
            get; private set;
        }

        public List<string>? Trace
        {
            get; init;
        }

        public VerifiedAuthoringPackage? LastActivatedPackage
        {
            get; private set;
        }

        public ValueTask ActivateAtomicallyAsync(
            VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets,
            long generation,
            CancellationToken cancellationToken)
        {
            ActivationCount++;
            LastTargetCount = targets.Length;
            LastActivatedPackage = package;
            ActiveGeneration = generation;
            LastActivationGeneration = generation;
            Trace?.Add($"activate:{package.Contract.Manifest.Version}:{generation}");
            return ValueTask.CompletedTask;
        }

        public ValueTask<AuthoringLifecycleResourceReport> RevokeAllAsync(
            string extensionId,
            long generation,
            CancellationToken cancellationToken)
        {
            RevocationCount++;
            LastRevocationGeneration = generation;
            Trace?.Add($"revoke:{generation}");
            if (RevokeReport.IsEmpty)
            {
                ActiveGeneration = 0;
            }
            return ValueTask.FromResult(RevokeReport);
        }

        public ValueTask<bool> RebindGenerationAsync(
            string extensionId,
            long expectedGeneration,
            long replacementGeneration,
            CancellationToken cancellationToken)
        {
            if (ActiveGeneration == 0)
            {
                return ValueTask.FromResult(false);
            }

            if (ActiveGeneration != expectedGeneration)
            {
                throw new AuthoringExtensionContractException("test generation is stale");
            }

            ActiveGeneration = replacementGeneration;
            Trace?.Add($"rebind:{expectedGeneration}:{replacementGeneration}");
            return ValueTask.FromResult(true);
        }
    }

    private sealed class HostResources : IAuthoringLifecycleHostResourceAuthority
    {
        public int ActivationCount
        {
            get; private set;
        }

        public int LastTargetCount
        {
            get; private set;
        }

        public int RevocationCount
        {
            get; private set;
        }

        public ValueTask ActivateAtomicallyAsync(
            VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets,
            CancellationToken cancellationToken)
        {
            ActivationCount++;
            LastTargetCount = targets.Length;
            return ValueTask.CompletedTask;
        }

        public ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(
            string extensionId,
            CancellationToken cancellationToken)
        {
            RevocationCount++;
            return ValueTask.FromResult(new AuthoringLifecycleHostResourceReport(0, 0, 0, 0, 0));
        }
    }

    private sealed class TrackedWorker : IAuthoringWorkerSandboxInstance
    {
        public AuthoringWorkerCapabilityReport CapabilityReport => new(
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            false,
            [],
            [],
            true,
            new string('a', 64));

        public bool Terminated
        {
            get; private set;
        }

        public bool Disposed
        {
            get; private set;
        }

        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(
            AuthoringWorkerRequest request,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask TerminateAsync(string reason, CancellationToken cancellationToken)
        {
            Terminated = true;
            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class BlockingTrackedWorker : IAuthoringWorkerSandboxInstance
    {
        public TaskCompletionSource TerminationStarted
        {
            get;
        } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource AllowTermination
        {
            get;
        } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int DisposeCount
        {
            get; private set;
        }

        public AuthoringWorkerCapabilityReport CapabilityReport => throw new NotSupportedException();

        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(
            AuthoringWorkerRequest request,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public async ValueTask TerminateAsync(string reason, CancellationToken cancellationToken)
        {
            TerminationStarted.TrySetResult();
            await AllowTermination.Task;
        }

        public ValueTask DisposeAsync()
        {
            DisposeCount++;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class FailingTerminationWorker : IAuthoringWorkerSandboxInstance
    {
        public AuthoringWorkerCapabilityReport CapabilityReport => throw new NotSupportedException();

        public bool Disposed
        {
            get; private set;
        }

        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(
            AuthoringWorkerRequest request,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask TerminateAsync(string reason, CancellationToken cancellationToken) =>
            ValueTask.FromException(new IOException("termination failed"));

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class TrackedService : IAuthoringServiceProcess
    {
        public AuthoringProcessOwnershipReport Ownership => new(
            AuthoringProcessOwnershipMechanism.PosixProcessGroup,
            true,
            true,
            new string('b', 64));

        public bool Terminated
        {
            get; private set;
        }

        public bool Disposed
        {
            get; private set;
        }

        public ValueTask<AuthoringServiceHealthReport> GetHealthAsync(CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<AuthoringServiceResponse> ExecuteAsync(
            AuthoringServiceRequest request,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask TerminateTreeAsync(string reason, CancellationToken cancellationToken)
        {
            Terminated = true;
            return ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            Disposed = true;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class Preflight(bool accepted) : IAuthoringLifecyclePreflight
    {
        public ValueTask<bool> VerifyAsync(
            VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets,
            CancellationToken cancellationToken) => ValueTask.FromResult(accepted);
    }

    private sealed class StateStore : IAuthoringExtensionStateStore
    {
        public Exception? RollbackFailure { get; init; }

        public Action<AuthoringStateMigrationPlan>? BeforeBackup { get; init; }

        public Action<AuthoringStateMigrationPlan>? BeforeApply { get; init; }

        public AuthoringStateMigrationPlan? BackupPlan { get; private set; }

        public AuthoringStateMigrationPlan? AppliedPlan { get; private set; }

        public AuthoringStateMigrationPlan? RolledBackPlan { get; private set; }

        public CancellationToken RollbackToken { get; private set; }

        public bool FailMigration
        {
            get; init;
        }

        public bool BackupCalled
        {
            get; private set;
        }

        public bool RollbackCalled
        {
            get; private set;
        }

        public bool DeleteCalled
        {
            get; private set;
        }

        public int DirectoryScanCount
        {
            get; private set;
        }

        public (long Records, long Bytes) Measurement
        {
            get; set;
        }

        public List<string>? Trace
        {
            get; init;
        }

        public ValueTask BackupAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken)
        {
            BackupCalled = true;
            BackupPlan = plan;
            BeforeBackup?.Invoke(plan);
            Trace?.Add("backup");
            return ValueTask.CompletedTask;
        }

        public ValueTask ApplyAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken)
        {
            AppliedPlan = plan;
            BeforeApply?.Invoke(plan);
            Trace?.Add("apply");
            if (FailMigration)
            {
                throw new InvalidOperationException("migration failed");
            }

            return ValueTask.CompletedTask;
        }

        public ValueTask RollbackAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken)
        {
            RollbackCalled = true;
            RolledBackPlan = plan;
            RollbackToken = cancellationToken;
            if (RollbackFailure is not null)
            {
                return ValueTask.FromException(RollbackFailure);
            }
            Trace?.Add("rollback");
            return ValueTask.CompletedTask;
        }

        public ValueTask<(long Records, long Bytes)> MeasureAsync(
            AuthoringStateScope scope,
            CancellationToken cancellationToken) => ValueTask.FromResult(Measurement);

        public ValueTask DeleteAsync(AuthoringStateScope scope, CancellationToken cancellationToken)
        {
            DeleteCalled = true;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class ReceiptStore : IAuthoringLifecycleReceiptStore
    {
        public Action<AuthoringLifecycleReceipt>? BeforeAppend { get; init; }

        public List<AuthoringLifecycleReceipt> All { get; } = [];

        public AuthoringLifecycleReceipt? Latest
        {
            get; private set;
        }

        public Func<AuthoringLifecycleReceipt, bool>? FailAppend
        {
            get; set;
        }

        public ValueTask<AuthoringLifecycleReceipt?> GetLatestAsync(
            string extensionId,
            CancellationToken cancellationToken) => ValueTask.FromResult(Latest);

        public ValueTask AppendAsync(AuthoringLifecycleReceipt receipt, CancellationToken cancellationToken)
        {
            BeforeAppend?.Invoke(receipt);
            if (FailAppend?.Invoke(receipt) == true)
            {
                throw new IOException("receipt persistence failed");
            }

            if (Latest is not null && receipt.Sequence != Latest.Sequence + 1)
            {
                throw new AuthoringExtensionContractException("Lifecycle receipt sequence is not append-only.");
            }

            Latest = receipt;
            All.Add(receipt);
            return ValueTask.CompletedTask;
        }
    }
}
