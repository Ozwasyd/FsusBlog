using System.Collections.Immutable;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.Unit;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

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
    public void PackageSourceAndAuthority_UseOneSignedClosedRegistry()
    {
        AuthoringCommandContribution command = CreateCommand();
        (VerifiedAuthoringPackage package, ImmutableArray<AuthoringExecutionTarget> targets) =
            CreateCommandPackage(command);
        var source = new VerifiedPackageAuthoringCommandSource();
        var authority = new AuthoringCommandRegistryAuthority(
            source,
            ImmutableHashSet<string>.Empty,
            ImmutableHashSet<string>.Empty);

        AuthoringCommandAuthorityReport report = authority.Activate(package, targets);

        Assert.Equal(1, report.Commands);
        Assert.Equal(4, report.Surfaces);
        Assert.Equivalent(command, authority.Snapshot().Get(command.CommandId), strict: true);
        Assert.Throws<AuthoringExtensionContractException>(() => authority.Activate(package, targets));
        Assert.Equal(1, authority.Revoke(command.ExtensionId).Commands);
        Assert.Throws<AuthoringExtensionContractException>(() => authority.Snapshot().Get(command.CommandId));
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
            fixture.Lifecycle,
            fixture.Grants));
        Assert.Throws<AuthoringExtensionContractException>(() => new AuthoringCommandExecutionCoordinator(
            [new TrustedExecutionPort()],
            new RevisionGate(true),
            fixture.Lifecycle,
            fixture.Grants));
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
    public async Task ExecuteAsync_GrantRevocationMakesPendingResultStale()
    {
        var port = new ExecutionPort();
        CommandRuntimeFixture fixture = await CreateRuntimeFixtureAsync(port);
        port.AfterExecute = async () =>
            await fixture.Grants.RevokeExtensionAsync(fixture.Command.ExtensionId, CancellationToken.None);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.ExecuteAsync(fixture.Command, fixture.Context));
    }

    [Theory]
    [InlineData("admission-revision", -1, false)]
    [InlineData("admission-revision", 0, false)]
    [InlineData("admission-revision", 1, false)]
    [InlineData("admission-revision", 0, true)]
    [InlineData("admission-lifecycle", -1, false)]
    [InlineData("admission-lifecycle", 0, false)]
    [InlineData("admission-lifecycle", 1, false)]
    [InlineData("admission-lifecycle", 0, true)]
    [InlineData("result-revision", -1, false)]
    [InlineData("result-revision", 0, false)]
    [InlineData("result-revision", 1, false)]
    [InlineData("result-revision", 0, true)]
    [InlineData("result-lifecycle", -1, false)]
    [InlineData("result-lifecycle", 0, false)]
    [InlineData("result-lifecycle", 1, false)]
    [InlineData("result-lifecycle", 0, true)]
    public async Task ExecuteAsync_RechecksDeadlineAndCancellationAfterAdmissionAndResultCallbacks(
        string boundary,
        int deadlineOffsetTicks,
        bool cancel)
    {
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        using var cancellation = new CancellationTokenSource();
        var receipts = new LifecycleReceiptStore();
        int callbackCount = 0;
        int lifecycleReadCount = 0;
        Action? changeBoundary = null;
        int targetCall = boundary.StartsWith("admission-", StringComparison.Ordinal) ? 1 : 2;
        var revisionGate = new CallbackRevisionGate(callCount =>
        {
            if (boundary.EndsWith("-revision", StringComparison.Ordinal) && callCount == targetCall)
            {
                changeBoundary!();
            }
        });
        CommandRuntimeFixture fixture = await CreateRuntimeFixtureAsync(
            revisionGate: revisionGate,
            timeProvider: clock,
            receipts: receipts);
        AuthoringLifecycleReceipt enabled = (await fixture.Lifecycle.RestoreFromReceiptAsync(
            fixture.Command.ExtensionId))!;
        Assert.Equal(AuthoringLifecycleState.Running, enabled.State);
        Assert.Equal(fixture.Context.LifecycleGeneration, enabled.Generation);
        Assert.True(clock.GetUtcNow() < fixture.Context.Deadline);

        changeBoundary = () =>
        {
            callbackCount++;
            if (cancel)
            {
                cancellation.Cancel();
            }
            else
            {
                clock.SetUtcNow(fixture.Context.Deadline.AddTicks(deadlineOffsetTicks));
            }
        };
        receipts.BeforeRead = async () =>
        {
            await Task.Yield();
            lifecycleReadCount++;
            if (boundary.EndsWith("-lifecycle", StringComparison.Ordinal) && lifecycleReadCount == targetCall)
            {
                changeBoundary();
            }
        };

        if (cancel)
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
                await fixture.Coordinator.ExecuteAsync(fixture.Command, fixture.Context, cancellation.Token));
        }
        else if (deadlineOffsetTicks >= 0)
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await fixture.Coordinator.ExecuteAsync(fixture.Command, fixture.Context, cancellation.Token));
        }
        else
        {
            AuthoringCommandExecutionResponse response = await fixture.Coordinator.ExecuteAsync(
                fixture.Command,
                fixture.Context,
                cancellation.Token);
            Assert.Equal(fixture.Context.RuntimeIdentity, response.RuntimeIdentity);
            Assert.Equal(fixture.Context.RequestId, response.RequestId);
            Assert.Equal(fixture.Context.LifecycleGeneration, response.LifecycleGeneration);
            Assert.Equal(fixture.Command.ResultSchemaReference, response.ResultSchemaReference);
            Assert.Equal(new byte[] { 4, 5 }, response.Result);
            Assert.NotNull(response.MutationPlan);
        }

        Assert.Equal(1, callbackCount);
        bool rejectedAtAdmission = targetCall == 1 && (cancel || deadlineOffsetTicks >= 0);
        Assert.Equal(rejectedAtAdmission ? 0 : 1, fixture.Port.CallCount);
        Assert.Equal(rejectedAtAdmission ? 1 : 2, revisionGate.CallCount);
        Assert.Equal(rejectedAtAdmission ? 1 : 2, lifecycleReadCount);
    }

    [Theory]
    [InlineData("document", "bad\ndocument")]
    [InlineData("selection", "bad\tselection")]
    [InlineData("request", " bad-request")]
    public async Task ExecuteAsync_UnboundedContextIdentityNeverReachesExecutionPort(string field, string invalid)
    {
        CommandRuntimeFixture fixture = await CreateRuntimeFixtureAsync();
        AuthoringCommandExecutionContext context = field switch
        {
            "document" => fixture.Context with { DocumentId = invalid },
            "selection" => fixture.Context with { SelectionIdentity = invalid },
            "request" => fixture.Context with { RequestId = invalid },
            _ => throw new InvalidOperationException()
        };

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Coordinator.ExecuteAsync(fixture.Command, context));
        Assert.Equal(0, fixture.Port.CallCount);
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
        Type[] commandTypes =
        [
            typeof(AuthoringCommandCategory),
            typeof(AuthoringCommandSurface),
            typeof(AuthoringCommandContextFact),
            typeof(AuthoringCommandContextOperator),
            typeof(AuthoringShortcutModifier),
            typeof(AuthoringCommandLocalization),
            typeof(AuthoringCommandContextCondition),
            typeof(AuthoringShortcutRequest),
            typeof(AuthoringCommandContribution),
            typeof(AuthoringShortcutDecision),
            typeof(AuthoringCommandState),
            typeof(AuthoringCommandContextSnapshot),
            typeof(AuthoringCommandAvailability),
            typeof(AuthoringCommandProjection),
            typeof(AuthoringCommandExecutionContext),
            typeof(AuthoringCommandExecutionResponse),
            typeof(IAuthoringCommandExecutionPort),
            typeof(AuthoringCommandRegistry),
            typeof(AuthoringCommandExecutionCoordinator),
            typeof(AuthoringCommandTransactionAdapter)
        ];
        Assert.All(commandTypes, AssertClosedCommandType);

        Assert.False(ContainsIdentifierToken("const message = \"bound to another document.\";", "document"));
        Assert.True(ContainsIdentifierToken("var body = document.body;", "document"));
    }

    [Theory]
    [InlineData(typeof(SpliceMethodFixture), ".splice ")]
    [InlineData(typeof(SpliceConstructorFixture), ".splice ")]
    [InlineData(typeof(SpliceInitializerFixture), ".splice ")]
    [InlineData(typeof(NestedSpliceFixture), ".splice ")]
    [InlineData(typeof(SpliceLiteralFixture), ".splice(")]
    public void CompiledCommandBoundary_RejectsSpliceReferencesAndLiterals(Type type, string forbidden)
    {
        Xunit.Sdk.XunitException exception = Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertClosedCommandType(type));

        Assert.Contains(forbidden, exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CompiledCommandBoundary_RejectsNestedDocumentParameter()
    {
        Xunit.Sdk.XunitException exception = Assert.ThrowsAny<Xunit.Sdk.XunitException>(() =>
            AssertClosedCommandType(typeof(NestedDocumentFixture)));

        Assert.Contains("document", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CompiledCommandBoundary_RejectsNestedDynamicReturnMetadata()
    {
        Type nested = Assert.Single(typeof(NestedDynamicFixture).GetNestedTypes(BindingFlags.NonPublic));
        MethodInfo method = Assert.Single(nested.GetMethods(BindingFlags.DeclaredOnly | BindingFlags.Public | BindingFlags.Static));
        Assert.Contains(method.ReturnParameter.CustomAttributes, attribute => attribute.AttributeType == typeof(DynamicAttribute));

        Assert.ThrowsAny<Xunit.Sdk.XunitException>(() => AssertClosedCommandType(typeof(NestedDynamicFixture)));
    }

    [Fact]
    public void CompiledCommandBoundary_AcceptsOrdinaryNestedMetadata()
    {
        AssertClosedCommandType(typeof(OrdinaryNestedFixture));
    }

    private static void AssertClosedCommandType(Type rootType)
    {
        const BindingFlags Declared = BindingFlags.DeclaredOnly | BindingFlags.Public | BindingFlags.NonPublic |
            BindingFlags.Instance | BindingFlags.Static;
        foreach (Type type in EnumerateCommandTypeTree(rootType))
        {
            string compiled = string.Join('\n',
                RuntimeMetadataInspection.DescribeType(type),
                RuntimeMetadataInspection.DescribeConstructors(type));
            foreach (string forbidden in new[]
                     {
                         "addEventListener",
                         "keydown",
                         "innerHTML",
                         ".splice(",
                         ".splice ",
                         "IServiceProvider",
                         "Delegate",
                         "Microsoft.CSharp.RuntimeBinder",
                         "System.Runtime.CompilerServices.CallSite"
                     })
            {
                // Decoded members use Type.Member followed by a space and signature;
                // retained JavaScript literals still use the original .splice( form.
                Assert.DoesNotContain(forbidden, compiled, StringComparison.OrdinalIgnoreCase);
            }

            MemberInfo[] members = type.GetMembers(Declared);
            Assert.DoesNotContain(members, member => member.Name.Equals("document", StringComparison.OrdinalIgnoreCase));
            foreach (MethodBase method in members.OfType<MethodBase>())
            {
                Assert.DoesNotContain(method.GetParameters(), parameter =>
                    string.Equals(parameter.Name, "document", StringComparison.OrdinalIgnoreCase));
            }

            Assert.DoesNotContain(type.CustomAttributes, attribute => attribute.AttributeType == typeof(DynamicAttribute));
            Assert.DoesNotContain(members, member =>
                member.CustomAttributes.Any(attribute => attribute.AttributeType == typeof(DynamicAttribute)) ||
                member is MethodBase method && method.GetParameters().Any(parameter =>
                    parameter.CustomAttributes.Any(attribute => attribute.AttributeType == typeof(DynamicAttribute))) ||
                member is MethodInfo methodInfo && methodInfo.ReturnParameter.CustomAttributes.Any(attribute =>
                    attribute.AttributeType == typeof(DynamicAttribute)));
        }
    }

    private static IEnumerable<Type> EnumerateCommandTypeTree(Type type)
    {
        yield return type;
        foreach (Type nested in type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
        {
            foreach (Type descendant in EnumerateCommandTypeTree(nested))
            {
                yield return descendant;
            }
        }
    }

    private static bool ContainsIdentifierToken(string source, string identifier) =>
        CSharpSyntaxTree.ParseText(source)
            .GetRoot()
            .DescendantTokens()
            .Any(token =>
                token.IsKind(SyntaxKind.IdentifierToken) &&
                string.Equals(token.ValueText, identifier, StringComparison.OrdinalIgnoreCase));

    private static class SpliceTarget
    {
        public static int Splice() => 1;
    }

    private sealed class SpliceMethodFixture
    {
        public static int Read() => SpliceTarget.Splice();
    }

    private sealed class SpliceConstructorFixture
    {
        private readonly int _value;

        public SpliceConstructorFixture() => _value = SpliceTarget.Splice();

        public int Read() => _value;
    }

    private sealed class SpliceInitializerFixture
    {
        private static readonly int s_value;

        static SpliceInitializerFixture() => s_value = SpliceTarget.Splice();

        public static int Read() => s_value;
    }

    private sealed class NestedSpliceFixture
    {
        public static int Read() => 1;

        private sealed class UncalledOwner
        {
            public static int Read() => SpliceTarget.Splice();
        }
    }

    private sealed class SpliceLiteralFixture
    {
        public static string Read() => "selection.splice(0, 1)";
    }

    private sealed class NestedDocumentFixture
    {
        private sealed class UncalledOwner
        {
            public static object Read(object document) => document;
        }
    }

    private sealed class NestedDynamicFixture
    {
        private sealed class UncalledOwner
        {
            public static dynamic Read() => new object();
        }
    }

    private sealed class OrdinaryNestedFixture
    {
        public static int Read() => 1;

        private sealed class UncalledOwner
        {
            public static object Read(object value) => value;
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

    private static async ValueTask<CommandRuntimeFixture> CreateRuntimeFixtureAsync(
        ExecutionPort? port = null,
        IAuthoringDocumentRevisionGate? revisionGate = null,
        TimeProvider? timeProvider = null,
        LifecycleReceiptStore? receipts = null)
    {
        VerifiedAuthoringPackage package = CreatePackage();
        AuthoringCommandContribution command = CreateCommand();
        var grantCatalog = new AuthoringCapabilityGrantCatalogStub(CreateActiveGrants(command, "document-1"));
        receipts ??= new LifecycleReceiptStore();
        var lifecycle = new AuthoringExtensionLifecycleCoordinator(
            new LifecycleResources(),
            new LifecyclePreflight(),
            new ExtensionStateStore(),
            receipts,
            grantCatalog);
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
            revisionGate ?? new RevisionGate(true),
            lifecycle,
            grantCatalog,
            timeProvider);
        var context = new AuthoringCommandExecutionContext(
            new string('e', 64),
            "document-1",
            1,
            2,
            "selection-1",
            "request-1",
            enabled.Generation,
            (timeProvider?.GetUtcNow() ?? DateTimeOffset.UtcNow).AddMinutes(1),
            command.RequiredCapabilities.ToImmutableHashSet(),
            [1, 2, 3]);
        return new CommandRuntimeFixture(
            command,
            package,
            lifecycle,
            coordinator,
            port,
            context,
            grantCatalog);
    }

    private static ImmutableArray<AuthoringCapabilityGrant> CreateActiveGrants(
        AuthoringCommandContribution command,
        string documentId)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        return
        [
            .. command.RequiredCapabilities.Select((capability, index) => new AuthoringCapabilityGrant(
                new string(index == 0 ? '1' : '2', 64),
                command.RuntimeIdentity,
                command.ExtensionId,
                command.ExtensionVersion,
                command.ContributionId,
                command.ExecutionClass,
                capability,
                documentId,
                "site-1",
                "execute-command",
                null,
                null,
                now,
                now.AddMinutes(5),
                $"approval-{index}",
                $"request-{index}",
                new string(index == 0 ? '1' : '2', 64)))
        ];
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

    private static (VerifiedAuthoringPackage Package, ImmutableArray<AuthoringExecutionTarget> Targets)
        CreateCommandPackage(AuthoringCommandContribution command)
    {
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest() with
        {
            Contributions =
            [
                AuthoringExtensionContractsTests.CreateManifest().Contributions[0] with
                {
                    Capabilities = command.RequiredCapabilities
                }
            ]
        };
        byte[] metadata = JsonSerializer.SerializeToUtf8Bytes(
            new[] { command },
            new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        VerifiedAuthoringPackage baseline = CreatePackage();
        var package = baseline with
        {
            Contract = AuthoringExtensionContractValidator.Verify(manifest),
            Contents = new AuthoringPackageArchiveContents(
                [],
                [new AuthoringPackageEntry(
                    VerifiedPackageAuthoringCommandSource.EntryPath,
                    [.. metadata],
                    new string('d', 64))])
        };
        AuthoringContributionDeclaration declaration = manifest.Contributions[0];
        ImmutableArray<AuthoringExecutionTarget> targets =
        [
            new AuthoringExecutionTarget(
                AuthoringExecutionResolutionStatus.Ready,
                declaration.ExecutionClass,
                manifest.Id,
                manifest.Version,
                manifest.PackageSha256,
                declaration.Id,
                declaration.Kind,
                declaration.Entrypoint.PathOrAdapterId,
                null,
                command.RuntimeIdentity,
                null)
        ];
        return (package, targets);
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
            new AuthoringRpcPayload(MutationPlan: plan))
        {
            SiteIdentity = "site-1",
            Purpose = "format-selection"
        };
        var approval = new AuthoringMutationApproval(
            plan.PlanId,
            true,
            "approval-1",
            AuthoringExtensionRpcAuthority.ComputeMutationPreviewDigest(envelope));
        return new TransactionFixture(rpc, envelope, approval, port);
    }

    private sealed record CommandRuntimeFixture(
        AuthoringCommandContribution Command,
        VerifiedAuthoringPackage Package,
        AuthoringExtensionLifecycleCoordinator Lifecycle,
        AuthoringCommandExecutionCoordinator Coordinator,
        ExecutionPort Port,
        AuthoringCommandExecutionContext Context,
        AuthoringCapabilityGrantCatalogStub Grants);

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
            long generation,
            CancellationToken cancellationToken) => ValueTask.CompletedTask;

        public ValueTask<AuthoringLifecycleResourceReport> RevokeAllAsync(
            string extensionId,
            long generation,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringLifecycleResourceReport(0, 0, 0, 0, 0, 0, 0));

        public ValueTask<bool> RebindGenerationAsync(
            string extensionId,
            long expectedGeneration,
            long replacementGeneration,
            CancellationToken cancellationToken) => ValueTask.FromResult(false);
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

        public Func<Task>? BeforeRead
        {
            get; set;
        }

        public async ValueTask<AuthoringLifecycleReceipt?> GetLatestAsync(string extensionId, CancellationToken cancellationToken)
        {
            if (BeforeRead is not null)
            {
                await BeforeRead();
            }

            return _latest;
        }

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

    private sealed class CallbackRevisionGate(Action<int> beforeReturn) : IAuthoringDocumentRevisionGate
    {
        public int CallCount
        {
            get; private set;
        }

        public async ValueTask<bool> IsCurrentAsync(
            string documentId,
            long documentEpoch,
            long sourceRevision,
            CancellationToken cancellationToken)
        {
            await Task.Yield();
            beforeReturn(++CallCount);
            return true;
        }
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        public void SetUtcNow(DateTimeOffset value) => _now = value;
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
            var receipt = new AuthoringTransactionReceipt(
                "transaction-1",
                plan.PlanId,
                plan.DocumentId,
                plan.ExpectedSourceRevision,
                plan.ExpectedSourceRevision + 1,
                "history-1",
                plan.SelectionIdentity,
                true,
                string.Empty);
            return ValueTask.FromResult(receipt with
            {
                ReceiptDigest = AuthoringExtensionRpcAuthority.ComputeTransactionReceiptDigest(receipt)
            });
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
