using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringCommandContributionTests
{
    [Fact]
    public void Registry_ClosedCommandMetadata_IsSearchableWithinBound()
    {
        var registry = CreateRegistry([CreateCommand()]);

        ImmutableArray<AuthoringCommandContribution> result = registry.Search("format", 10);

        Assert.Single(result);
        Assert.Equal("acme.author-tools.format", result[0].CommandId);
    }

    [Fact]
    public void Registry_CoreOrDuplicateCommandId_FailsClosed()
    {
        AuthoringCommandContribution command = CreateCommand();
        Assert.Throws<AuthoringExtensionContractException>(() =>
            new AuthoringCommandRegistry(
                [command],
                ImmutableHashSet.Create(StringComparer.Ordinal, command.CommandId),
                ImmutableHashSet<string>.Empty));
        Assert.Throws<AuthoringExtensionContractException>(() => CreateRegistry([command, command]));
    }

    [Fact]
    public void Registry_UnknownContextOrTrustedHostExecution_FailsClosed()
    {
        AuthoringCommandContribution command = CreateCommand();
        Assert.Throws<AuthoringExtensionContractException>(() => CreateRegistry(
        [
            command with
            {
                When = [new AuthoringCommandContextCondition((AuthoringCommandContextFact)999, AuthoringCommandContextOperator.IsTrue)]
            }
        ]));
        Assert.Throws<AuthoringExtensionContractException>(() => CreateRegistry(
            [command with { ExecutionClass = AuthoringExecutionClass.TrustedHostAdapter }]));
    }

    [Fact]
    public void Registry_ShortcutConflict_DiagnosesWithoutOverridingCoreOrUser()
    {
        AuthoringCommandContribution command = CreateCommand();
        var registry = new AuthoringCommandRegistry(
            [command],
            ImmutableHashSet<string>.Empty,
            ImmutableHashSet.Create(StringComparer.OrdinalIgnoreCase, "Control+K"));

        AuthoringShortcutDecision decision = registry.ResolveShortcut(command);

        Assert.False(decision.Accepted);
        Assert.Null(decision.CanonicalShortcut);
        Assert.Equal("shortcut-conflicts-with-core-or-user", decision.StableReason);
    }

    [Fact]
    public void Registry_AllSurfacesReceiveTheSameStateInstance()
    {
        AuthoringCommandContribution command = CreateCommand();
        var registry = CreateRegistry([command]);
        var state = new AuthoringCommandState(command.CommandId, 3, true, false, null, null);

        ImmutableArray<AuthoringCommandProjection> projections = registry.Project(command.CommandId, state);

        Assert.Equal(4, projections.Length);
        Assert.All(projections, projection => Assert.Same(state, projection.State));
    }

    [Fact]
    public void Registry_ContextAndPermissionEvaluation_IsClosedAndStable()
    {
        AuthoringCommandContribution command = CreateCommand();
        var registry = CreateRegistry([command]);
        var context = new AuthoringCommandContextSnapshot(
            7,
            ImmutableDictionary<AuthoringCommandContextFact, bool>.Empty
                .Add(AuthoringCommandContextFact.IsExtensionEnabled, true)
                .Add(AuthoringCommandContextFact.HasSelection, true),
            ImmutableHashSet.Create(AuthoringCapability.SelectionRead),
            false,
            null);

        AuthoringCommandAvailability availability = registry.Evaluate(command.CommandId, context);
        ImmutableArray<AuthoringCommandProjection> projections = registry.Project(
            command.CommandId,
            availability.State);

        Assert.True(availability.Visible);
        Assert.False(availability.State.Enabled);
        Assert.Equal("command-permission-insufficient", availability.State.DisabledReason);
        Assert.All(projections, projection => Assert.Same(availability.State, projection.State));

        AuthoringCommandAvailability hidden = registry.Evaluate(
            command.CommandId,
            context with
            {
                Facts = context.Facts.SetItem(AuthoringCommandContextFact.HasSelection, false),
                GrantedCapabilities = command.RequiredCapabilities.ToImmutableHashSet()
            });
        Assert.False(hidden.Visible);
        Assert.Equal("command-context-not-satisfied", hidden.State.DisabledReason);
    }

    [Fact]
    public async Task Registry_DisableOrVersionDrift_RemovesContributionFromLifecycleSnapshot()
    {
        CommandRuntimeFixture fixture = await CreateRuntimeFixtureAsync();
        var registry = CreateRegistry([fixture.Command]);
        AuthoringLifecycleReceipt enabled = (await fixture.Lifecycle.RestoreFromReceiptAsync(
            fixture.Command.ExtensionId))!;

        Assert.Single(registry.SelectForLifecycle(enabled));

        AuthoringLifecycleReceipt disabled = await fixture.Lifecycle.DisableAsync(fixture.Package);
        Assert.Empty(registry.SelectForLifecycle(disabled));
        Assert.Empty(registry.SelectForLifecycle(enabled with
        {
            Version = "2.0.0",
            Generation = 3
        }));
    }

    [Fact]
    public void Registry_OneThousandCommands_RemainsBoundedAndDeterministic()
    {
        ImmutableArray<AuthoringCommandContribution> commands =
        [
            .. Enumerable.Range(0, AuthoringCommandRegistry.MaximumCommands)
                .Select(index => CreateCommand() with
                {
                    CommandId = $"acme.author-tools.command-{index:D4}",
                    ContributionId = $"acme.command.command-{index:D4}"
                })
        ];
        var registry = CreateRegistry(commands);

        ImmutableArray<AuthoringCommandContribution> result = registry.Search("command", 100);
        ImmutableDictionary<AuthoringCommandCategory, ImmutableArray<AuthoringCommandContribution>> groups =
            registry.GroupByCategory();

        Assert.Equal(100, result.Length);
        Assert.Equal(result.OrderBy(command => command.CommandId, StringComparer.Ordinal), result);
        Assert.Equal(AuthoringCommandRegistry.MaximumCommands, groups.Values.Sum(static group => group.Length));
        Assert.All(groups.Values, group =>
            Assert.Equal(group.OrderBy(command => command.CommandId, StringComparer.Ordinal), group));
        Assert.Throws<AuthoringExtensionContractException>(() => CreateRegistry([.. commands, CreateCommand()]));
    }

    [Fact]
    public async Task ExecuteAsync_MissingPermissionNeverReachesExecutionPort()
    {
        CommandRuntimeFixture fixture = await CreateRuntimeFixtureAsync();

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.ExecuteAsync(
                fixture.Command,
                fixture.Context with
                {
                    GrantedCapabilities = ImmutableHashSet<AuthoringCapability>.Empty
                }));

        Assert.Equal(0, fixture.Port.CallCount);
    }

    [Fact]
    public async Task ExecuteAsync_DuplicateOrTrustedPortRegistry_FailsClosed()
    {
        CommandRuntimeFixture fixture = await CreateRuntimeFixtureAsync();
        Assert.Throws<AuthoringExtensionContractException>(() => new AuthoringCommandExecutionCoordinator(
            [fixture.Port, fixture.Port],
            new RevisionGate(true),
            fixture.Lifecycle));
        Assert.Throws<AuthoringExtensionContractException>(() => new AuthoringCommandExecutionCoordinator(
            [new TrustedExecutionPort()],
            new RevisionGate(true),
            fixture.Lifecycle));
    }

    [Fact]
    public async Task ExecuteAsync_BindsOnlyDeclaredExecutionClassAndIdentity()
    {
        CommandRuntimeFixture fixture = await CreateRuntimeFixtureAsync();

        AuthoringCommandExecutionResponse response = await fixture.Coordinator.ExecuteAsync(
            fixture.Command,
            fixture.Context);

        Assert.Equal(fixture.Context.RuntimeIdentity, response.RuntimeIdentity);
        Assert.Equal(1, fixture.Port.CallCount);
    }

    [Fact]
    public async Task ExecuteAsync_DisableMakesPendingResultStale()
    {
        var port = new ExecutionPort();
        CommandRuntimeFixture fixture = await CreateRuntimeFixtureAsync(port);
        port.AfterExecute = async () => await fixture.Lifecycle.DisableAsync(fixture.Package);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.ExecuteAsync(fixture.Command, fixture.Context));
    }

    [Fact]
    public async Task TransactionAdapter_AppliesMutationThroughCanonicalRpcOnce()
    {
        CommandRuntimeFixture fixture = await CreateRuntimeFixtureAsync();
        AuthoringCommandExecutionResponse response = await fixture.Coordinator.ExecuteAsync(
            fixture.Command,
            fixture.Context);
        TransactionFixture transaction = await CreateTransactionFixtureAsync(fixture, response.MutationPlan!);
        var adapter = new AuthoringCommandTransactionAdapter(transaction.Rpc);

        AuthoringTransactionReceipt receipt = await adapter.ApplyAsync(
            transaction.Envelope,
            response,
            transaction.Approval);

        Assert.Equal(response.MutationPlan?.PlanId, receipt.PlanId);
        Assert.Equal(1, transaction.Port.CallCount);
    }

    [Fact]
    public async Task TransactionAdapter_RejectsDirectOrDriftedMutationResult()
    {
        CommandRuntimeFixture fixture = await CreateRuntimeFixtureAsync();
        AuthoringCommandExecutionResponse response = await fixture.Coordinator.ExecuteAsync(
            fixture.Command,
            fixture.Context);
        TransactionFixture transaction = await CreateTransactionFixtureAsync(fixture, response.MutationPlan!);
        var adapter = new AuthoringCommandTransactionAdapter(transaction.Rpc);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await adapter.ApplyAsync(
                transaction.Envelope,
                response with
                {
                    RequestId = "other-request"
                },
                transaction.Approval));
        Assert.Equal(0, transaction.Port.CallCount);
    }

    [Fact]
    public void ProductionCommandBoundary_DoesNotExposeUiOrMutationBypasses()
    {
        string source = File.ReadAllText(Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src/backend/Infrastructure/AuthoringExtensions/AuthoringCommandContributions.cs"));

        foreach (string forbidden in new[]
        {
            "addEventListener",
            "keydown",
            "document.",
            "innerHTML",
            ".splice(",
            "IServiceProvider",
            "Delegate",
            "dynamic "
        })
        {
            Assert.DoesNotContain(forbidden, source, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static AuthoringCommandRegistry CreateRegistry(ImmutableArray<AuthoringCommandContribution> commands) =>
        new(commands, ImmutableHashSet<string>.Empty, ImmutableHashSet<string>.Empty);

    private static AuthoringCommandContribution CreateCommand() => new(
        "acme.author-tools.format",
        "acme.author-tools",
        "1.0.0",
        "acme.command.format",
        new string('a', 64),
        new string('b', 64),
        new string('e', 64),
        AuthoringExecutionClass.IsolatedWorkerWasm,
        new AuthoringCommandLocalization(
            "commands.format.label",
            "commands.format.description",
            ["commands.format.keyword"]),
        AuthoringCommandCategory.Format,
        [
            new AuthoringCommandContextCondition(
                AuthoringCommandContextFact.HasSelection,
                AuthoringCommandContextOperator.IsTrue)
        ],
        [AuthoringCapability.SelectionRead, AuthoringCapability.DocumentMutationRequest],
        "schema/command-input-v1",
        "schema/command-result-v1",
        [
            AuthoringCommandSurface.Toolbar,
            AuthoringCommandSurface.CommandPalette,
            AuthoringCommandSurface.SlashMenu,
            AuthoringCommandSurface.SelectionMenu
        ],
        new AuthoringShortcutRequest([AuthoringShortcutModifier.Control], "K"));

    private static async ValueTask<CommandRuntimeFixture> CreateRuntimeFixtureAsync(ExecutionPort? port = null)
    {
        VerifiedAuthoringPackage package = CreatePackage();
        var receipts = new LifecycleReceiptStore();
        var lifecycle = new AuthoringExtensionLifecycleCoordinator(
            new LifecycleResources(),
            new LifecyclePreflight(),
            new ExtensionStateStore(),
            receipts);
        AuthoringContributionDeclaration contribution = package.Contract.Manifest.Contributions[0];
        ImmutableArray<AuthoringExecutionTarget> targets =
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
                new string('d', 64),
                null)
        ];
        AuthoringLifecycleReceipt enabled = await lifecycle.EnableAsync(package, targets);
        port ??= new ExecutionPort();
        var coordinator = new AuthoringCommandExecutionCoordinator(
            [port],
            new RevisionGate(true),
            lifecycle);
        var context = new AuthoringCommandExecutionContext(
            new string('e', 64),
            "document-1",
            1,
            2,
            "selection-1",
            "request-1",
            enabled.Generation,
            DateTimeOffset.UtcNow.AddMinutes(1),
            CreateCommand().RequiredCapabilities.ToImmutableHashSet(),
            [1, 2, 3]);
        return new CommandRuntimeFixture(
            CreateCommand(),
            package,
            lifecycle,
            coordinator,
            port,
            context);
    }

    private static VerifiedAuthoringPackage CreatePackage()
    {
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest();
        DateTimeOffset now = DateTimeOffset.UtcNow;
        return new VerifiedAuthoringPackage(
            AuthoringExtensionContractValidator.Verify(manifest),
            new AuthoringPackageArtifact([], [], "acme", "key-1", "source/1", "provenance/1"),
            new AuthoringPackageArchiveContents([], []),
            new AuthoringPackageTrustDecision(
                AuthoringPackageTrustStatus.Trusted,
                "acme",
                "key-1",
                now,
                now.AddMinutes(5)),
            new string('f', 64));
    }

    private static async ValueTask<TransactionFixture> CreateTransactionFixtureAsync(
        CommandRuntimeFixture runtime,
        AuthoringMutationPlan plan)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var grantStore = new GrantStore();
        var grants = new AuthoringCapabilityGrantAuthority(grantStore, new FixedTimeProvider(now));
        AuthoringCapabilityGrant grant = await grants.IssueAsync(new AuthoringGrantRequest(
            "grant-request-1",
            runtime.Context.RuntimeIdentity,
            runtime.Command.ExtensionId,
            runtime.Command.ExtensionVersion,
            runtime.Command.ContributionId,
            runtime.Command.ExecutionClass,
            AuthoringCapability.DocumentMutationRequest,
            runtime.Context.DocumentId,
            "site-1",
            "format-selection",
            null,
            null,
            TimeSpan.FromMinutes(1),
            "approval-1"));
        var port = new TransactionPort();
        var rpc = new AuthoringExtensionRpcAuthority(
            grants,
            port,
            new RevisionGate(true),
            new FixedTimeProvider(now));
        var envelope = new AuthoringRpcEnvelope(
            1,
            AuthoringRpcMethod.MutationRequest,
            runtime.Context.RuntimeIdentity,
            runtime.Command.ExtensionId,
            runtime.Command.ExtensionVersion,
            runtime.Package.Contract.Manifest.PackageSha256,
            runtime.Package.Contract.Manifest.ContentSha256,
            runtime.Command.ContributionId,
            runtime.Command.ExecutionClass,
            runtime.Context.RequestId,
            runtime.Context.DocumentId,
            runtime.Context.DocumentEpoch,
            runtime.Context.SourceRevision,
            plan.ExpectedSnapshotSha256,
            new string('a', 64),
            new string('b', 64),
            new string('c', 64),
            grant.GrantDigest,
            now.AddMinutes(1),
            new AuthoringRpcPayload(MutationPlan: plan));
        var approval = new AuthoringMutationApproval(
            plan.PlanId,
            true,
            "approval-1",
            new string('d', 64));
        return new TransactionFixture(rpc, envelope, approval, port);
    }

    private sealed record CommandRuntimeFixture(
        AuthoringCommandContribution Command,
        VerifiedAuthoringPackage Package,
        AuthoringExtensionLifecycleCoordinator Lifecycle,
        AuthoringCommandExecutionCoordinator Coordinator,
        ExecutionPort Port,
        AuthoringCommandExecutionContext Context);

    private sealed record TransactionFixture(
        AuthoringExtensionRpcAuthority Rpc,
        AuthoringRpcEnvelope Envelope,
        AuthoringMutationApproval Approval,
        TransactionPort Port);

    private sealed class ExecutionPort : IAuthoringCommandExecutionPort
    {
        public AuthoringExecutionClass ExecutionClass => AuthoringExecutionClass.IsolatedWorkerWasm;

        public int CallCount
        {
            get; private set;
        }

        public Func<Task>? AfterExecute
        {
            get; set;
        }

        public async ValueTask<AuthoringCommandExecutionResponse> ExecuteAsync(
            AuthoringCommandContribution command,
            AuthoringCommandExecutionContext context,
            CancellationToken cancellationToken)
        {
            CallCount++;
            if (AfterExecute is not null)
            {
                await AfterExecute();
            }

            var plan = new AuthoringMutationPlan(
                "plan-1",
                context.DocumentId,
                context.DocumentEpoch,
                context.SourceRevision,
                new string('1', 64),
                [new AuthoringMutation(AuthoringMutationOperation.Replace, new AuthoringTextRange(0, 1), "replacement")],
                context.SelectionIdentity);
            return new AuthoringCommandExecutionResponse(
                context.RuntimeIdentity,
                context.RequestId,
                context.LifecycleGeneration,
                command.ResultSchemaReference,
                [4, 5],
                plan);
        }
    }

    private sealed class TrustedExecutionPort : IAuthoringCommandExecutionPort
    {
        public AuthoringExecutionClass ExecutionClass => AuthoringExecutionClass.TrustedHostAdapter;

        public ValueTask<AuthoringCommandExecutionResponse> ExecuteAsync(
            AuthoringCommandContribution command,
            AuthoringCommandExecutionContext context,
            CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    private sealed class LifecycleResources : IAuthoringLifecycleResourceAuthority
    {
        public ValueTask ActivateAtomicallyAsync(
            VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets,
            CancellationToken cancellationToken) => ValueTask.CompletedTask;

        public ValueTask<AuthoringLifecycleResourceReport> RevokeAllAsync(
            string extensionId,
            long generation,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringLifecycleResourceReport(0, 0, 0, 0, 0, 0, 0));
    }

    private sealed class LifecyclePreflight : IAuthoringLifecyclePreflight
    {
        public ValueTask<bool> VerifyAsync(
            VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets,
            CancellationToken cancellationToken) => ValueTask.FromResult(true);
    }

    private sealed class ExtensionStateStore : IAuthoringExtensionStateStore
    {
        public ValueTask BackupAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask ApplyAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask RollbackAsync(AuthoringStateMigrationPlan plan, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask<(long Records, long Bytes)> MeasureAsync(AuthoringStateScope scope, CancellationToken cancellationToken) => ValueTask.FromResult((0L, 0L));
        public ValueTask DeleteAsync(AuthoringStateScope scope, CancellationToken cancellationToken) => ValueTask.CompletedTask;
    }

    private sealed class LifecycleReceiptStore : IAuthoringLifecycleReceiptStore
    {
        private AuthoringLifecycleReceipt? _latest;

        public ValueTask<AuthoringLifecycleReceipt?> GetLatestAsync(string extensionId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_latest);

        public ValueTask AppendAsync(AuthoringLifecycleReceipt receipt, CancellationToken cancellationToken)
        {
            _latest = receipt;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class RevisionGate(bool current) : IAuthoringDocumentRevisionGate
    {
        public ValueTask<bool> IsCurrentAsync(
            string documentId,
            long documentEpoch,
            long sourceRevision,
            CancellationToken cancellationToken) => ValueTask.FromResult(current);
    }

    private sealed class GrantStore : IAuthoringCapabilityGrantStore
    {
        private readonly Dictionary<string, AuthoringCapabilityGrant> _grants = new(StringComparer.Ordinal);

        public ValueTask<AuthoringCapabilityGrant?> FindAsync(string grantId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_grants.GetValueOrDefault(grantId));

        public ValueTask StoreAsync(AuthoringCapabilityGrant grant, CancellationToken cancellationToken)
        {
            _grants.Add(grant.GrantId, grant);
            return ValueTask.CompletedTask;
        }

        public ValueTask RevokeAsync(string grantId, CancellationToken cancellationToken)
        {
            _grants.Remove(grantId);
            return ValueTask.CompletedTask;
        }
    }

    private sealed class TransactionPort : IAuthoringCanonicalDocumentTransaction
    {
        public int CallCount
        {
            get; private set;
        }

        public ValueTask<AuthoringTransactionReceipt> ApplyAsync(
            AuthoringMutationPlan plan,
            CancellationToken cancellationToken)
        {
            CallCount++;
            return ValueTask.FromResult(new AuthoringTransactionReceipt(
                "transaction-1",
                plan.PlanId,
                plan.DocumentId,
                plan.ExpectedSourceRevision,
                plan.ExpectedSourceRevision + 1,
                "history-1",
                plan.SelectionIdentity,
                true,
                new string('e', 64)));
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
