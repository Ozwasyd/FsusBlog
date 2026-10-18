using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringLifecycleSettlementScopeTests
{
    [Fact]
    public async Task CallerSuppliedZeroReportsCannotBecomeOriginalSettlementFacts()
    {
        Fixture fixture = await CreateAsync(trackInstances: false);
        var scope = await fixture.HoldAsync();
        object foreign = new();
        Assert.Throws<AuthoringExtensionContractException>(() =>
            scope.RecordCleanupReport(foreign, new AuthoringLifecycleResourceReport(0, 0, 0, 0, 0, 0, 0)));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            scope.RecordHostReport(foreign, new AuthoringLifecycleHostResourceReport(0, 0, 0, 0, 0)));
        Assert.Throws<AuthoringExtensionContractException>(() => scope.MarkAcquisitionFailed(foreign, true));
        Assert.Throws<AuthoringExtensionContractException>(() => scope.AttachHostScope(foreign, null));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            new AuthoringExtensionLifecycleResources.SettlementScope(fixture.Resources, fixture.Id, 1, foreign));
        Assert.Null(scope.CleanupReport);
        Assert.Null(scope.HostCleanupReport);
        await scope.SettleAsync();
        Assert.True(scope.CleanupReport!.IsEmpty);
        scope.Dispose();
    }

    [Fact]
    public async Task ExactOriginalRosterAndMissingNativeHistoryRemainHeldAndUnqualified()
    {
        Fixture fixture = await CreateAsync();
        var scope = await fixture.HoldAsync();
        Assert.Same(fixture.Package, scope.Package);
        Assert.Equal(fixture.Targets, scope.Targets);
        Assert.Equal(1, scope.Generation);
        Assert.Same(fixture.Worker, Assert.Single(scope.Workers));
        Assert.Same(fixture.Service, Assert.Single(scope.Services));
        Assert.Null(scope.CleanupReport);
        Assert.Null(scope.HostCleanupReport);
        Assert.False(scope.GetWorkerCleanupFacts(fixture.Worker).DisposalSucceeded);
        Assert.Null(scope.GetWorkerCleanupFacts(fixture.Worker).TerminationSucceeded);
        fixture.Host.AssertMutationRefused();

        await fixture.SettleUnknownAsync(scope);

        Assert.Null(scope.CleanupReport);
        Assert.NotNull(scope.HostCleanupReport);
        Assert.True(scope.GetWorkerCleanupFacts(fixture.Worker).DisposalSucceeded);
        Assert.True(scope.GetServiceCleanupFacts(fixture.Service).DisposalSucceeded);
        Assert.True(scope.GetWorkerCleanupFacts(fixture.Worker).TerminationSucceeded);
        await fixture.AssertClosedAsync();
        scope.Dispose();
        scope.Dispose();
        Assert.True(scope.IsReleased);
        Assert.False(fixture.Host.Held);
        Assert.Same(fixture.Worker, Assert.Single(scope.Workers));
        Assert.True(scope.GetWorkerCleanupFacts(fixture.Worker).DisposalSucceeded);
        await Assert.ThrowsAsync<ObjectDisposedException>(() => scope.SettleAsync().AsTask());
        await fixture.AssertClosedAsync();
        Assert.Equal(1, scope.Generation);
        Assert.Equal(fixture.Targets, scope.Targets);
    }

    [Fact]
    public async Task ConcurrentAcquireReturnsExactlyOneOriginalHolder()
    {
        Fixture fixture = await CreateAsync();
        var start = Signal();
        async Task<AuthoringExtensionLifecycleResources.SettlementScope?> AcquireAsync()
        {
            await start.Task;
            try
            {
                return await fixture.HoldAsync();
            }
            catch (AuthoringExtensionContractException) { return null; }
        }
        Task<AuthoringExtensionLifecycleResources.SettlementScope?> first = Task.Run(AcquireAsync);
        Task<AuthoringExtensionLifecycleResources.SettlementScope?> second = Task.Run(AcquireAsync);
        start.SetResult();
        var results = await Task.WhenAll(first, second);
        var scope = Assert.Single(results, scope => scope is not null)!;
        Assert.Single(results, scope => scope is null);
        Assert.Equal(1, fixture.Host.AcquisitionCount);
        await fixture.SettleUnknownAsync(scope);
        scope.Dispose();
    }

    [Fact]
    public async Task KnownOldSettlementAllowsNewGenerationWithoutReleasingOldProof()
    {
        Fixture fixture = await CreateAsync(trackInstances: false);
        var old = await fixture.HoldAsync();
        await old.SettleAsync();
        Assert.True(old.CleanupReport!.IsEmpty);
        ImmutableArray<AuthoringExecutionTarget> next = [fixture.Targets[0] with { RuntimeIdentity = new string('d', 64) }];
        await fixture.Resources.ActivateAtomicallyAsync(fixture.Package, next, 2, default);
        var current = new ControlledResource();
        await fixture.Resources.TrackWorkerAsync(fixture.Id, 2, current);
        Assert.False(old.IsReleased);
        Assert.Equal(1, old.Generation);
        Assert.Equal(fixture.Targets, old.Targets);
        await old.SettleAsync();
        Assert.Equal(0, current.DisposeCount);
        Assert.True(await fixture.Resources.RebindGenerationAsync(fixture.Id, 2, 3, default));
        old.Dispose();
        await fixture.Resources.ReleaseWorkerAsync(fixture.Id, 3, current);
        Assert.Equal(1, current.DisposeCount);
        Assert.True((await fixture.Resources.RevokeAllAsync(fixture.Id, 3, default)).IsEmpty);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.ActivateAsync(1).AsTask());
    }

    [Fact]
    public async Task PendingReleaseKeepsOriginalLeaseAndSharedCleanupDisposesOnce()
    {
        Fixture fixture = await CreateAsync();
        fixture.Worker.BlockDisposal = true;
        Task release = fixture.Resources.ReleaseWorkerAsync(fixture.Id, 1, fixture.Worker).AsTask();
        await fixture.Worker.DisposalStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var scope = await fixture.HoldAsync();
        Task first = scope.SettleAsync().AsTask();
        Task second = scope.SettleAsync().AsTask();
        try
        {
            Assert.Same(fixture.Worker, Assert.Single(scope.Workers));
            Assert.False(first.IsCompleted);
            Assert.False(second.IsCompleted);
            Assert.Throws<AuthoringExtensionContractException>(scope.Dispose);
        }
        finally
        {
            fixture.Worker.AllowDisposal.TrySetResult();
            await release;
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => first);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => second);
        }
        Assert.Null(scope.CleanupReport);
        Assert.Equal(0, fixture.Worker.TerminationCount);
        Assert.Equal(1, fixture.Worker.DisposeCount);
        Assert.Null(scope.GetWorkerCleanupFacts(fixture.Worker).TerminationSucceeded);
        Assert.Equal(1, fixture.Host.RevocationCount);
        scope.Dispose();
    }

    [Fact]
    public async Task ConcurrentSettlementOwnsCleanupAndExternalRevokeCannotRemoveRoster()
    {
        Fixture fixture = await CreateAsync();
        fixture.Worker.BlockTermination = true;
        var scope = await fixture.HoldAsync();
        Task first = scope.SettleAsync().AsTask();
        await fixture.Worker.TerminationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Task second = scope.SettleAsync().AsTask();
        using var cancellation = new CancellationTokenSource();
        Task external = fixture.Resources.RevokeAllAsync(fixture.Id, 1, cancellation.Token).AsTask();
        cancellation.Cancel();
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => external);
            Assert.Throws<AuthoringExtensionContractException>(scope.Dispose);
            Assert.False(scope.GetWorkerCleanupFacts(fixture.Worker).DisposalSucceeded);
        }
        finally
        {
            fixture.Worker.AllowTermination.TrySetResult();
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => first);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => second);
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            fixture.Resources.RevokeAllAsync(fixture.Id, 1, default).AsTask());
        Assert.Equal(1, fixture.Worker.TerminationCount);
        Assert.Equal(1, fixture.Worker.DisposeCount);
        Assert.Equal(1, fixture.Host.RevocationCount);
        scope.Dispose();
    }

    [Fact]
    public async Task LateTrackIsCleanedWithoutChangingHeldOriginalRoster()
    {
        Fixture fixture = await CreateAsync();
        var scope = await fixture.HoldAsync();
        var late = new ControlledResource();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            fixture.Resources.TrackWorkerAsync(fixture.Id, 1, late).AsTask());
        Assert.Equal(1, late.TerminationCount);
        Assert.Equal(1, late.DisposeCount);
        Assert.Same(fixture.Worker, Assert.Single(scope.Workers));
        Assert.Equal(0, fixture.Worker.DisposeCount);
        await fixture.Resources.ReleaseWorkerAsync(fixture.Id, 1, fixture.Worker);
        Assert.Equal(0, fixture.Worker.DisposeCount);
        await fixture.SettleUnknownAsync(scope);
        scope.Dispose();
    }

    [Fact]
    public async Task CompletedReleaseCannotEraseUnknownNativeHistoryAndQualifyAnEmptyRoster()
    {
        Fixture fixture = await CreateAsync();
        await fixture.Resources.ReleaseWorkerAsync(fixture.Id, 1, fixture.Worker);
        await fixture.Resources.ReleaseServiceAsync(fixture.Id, 1, fixture.Service);
        var scope = await fixture.HoldAsync();
        Assert.Same(fixture.Worker, Assert.Single(scope.Workers));
        Assert.Same(fixture.Service, Assert.Single(scope.Services));
        Assert.Null(scope.GetWorkerIncarnation(fixture.Worker));
        Assert.Null(scope.GetWorkerDescriptor(fixture.Worker));
        Assert.Null(scope.GetWorkerCleanupFacts(fixture.Worker).NativeCustodyRetained);
        await fixture.SettleUnknownAsync(scope);
        Assert.Equal(1, fixture.Worker.DisposeCount);
        Assert.Equal(1, fixture.Service.DisposeCount);
        scope.Dispose();
        await fixture.AssertClosedAsync();
    }

    [Fact]
    public async Task LegacyZeroReportRemainsUnknownAndCannotResurrectGeneration()
    {
        var legacy = new LegacyHost();
        Fixture fixture = await CreateAsync(legacy);
        var scope = await fixture.HoldAsync();
        AuthoringExtensionContractException error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            scope.SettleAsync().AsTask());
        Assert.Contains("unknown", error.Message, StringComparison.Ordinal);
        Assert.Same(error, scope.CleanupFailure);
        Assert.Null(scope.HostCleanupReport);
        Assert.Null(scope.CleanupReport);
        Assert.True(scope.GetWorkerCleanupFacts(fixture.Worker).DisposalSucceeded);
        scope.Dispose();
        await fixture.AssertClosedAsync();
        var retry = await fixture.HoldAsync();
        Assert.Same(fixture.Worker, Assert.Single(retry.Workers));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => retry.SettleAsync().AsTask());
        Assert.Equal(1, fixture.Worker.DisposeCount);
        Assert.Equal(1, fixture.Service.DisposeCount);
        retry.Dispose();
    }

    [Fact]
    public async Task UnknownHeldHostObservationIsNeverAnEmptyReportAndCanRetry()
    {
        Fixture fixture = await CreateAsync();
        fixture.Host.ObservationUnavailable = true;
        var scope = await fixture.HoldAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => scope.SettleAsync().AsTask());
        Assert.Null(scope.HostCleanupReport);
        Assert.Null(scope.CleanupReport);
        fixture.Host.ObservationUnavailable = false;
        await fixture.SettleUnknownAsync(scope);
        Assert.Null(scope.CleanupReport);
        Assert.Equal(1, fixture.Worker.DisposeCount);
        scope.Dispose();
        await fixture.AssertClosedAsync();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailedDisposalKeepsExactOriginalLeaseForRetry(bool reacquire)
    {
        Fixture fixture = await CreateAsync();
        fixture.Worker.DisposalFailures = 1;
        var scope = await fixture.HoldAsync();
        await fixture.SettleUnknownAsync(scope);
        Assert.Null(scope.CleanupReport);
        Assert.Same(fixture.Worker.DisposalFailure, scope.GetWorkerCleanupFacts(fixture.Worker).Failure);
        Assert.False(scope.GetWorkerCleanupFacts(fixture.Worker).DisposalSucceeded);
        if (reacquire)
        {
            scope.Dispose();
            await fixture.AssertClosedAsync();
            scope = await fixture.HoldAsync();
            Assert.Same(fixture.Worker, Assert.Single(scope.Workers));
        }
        await fixture.SettleUnknownAsync(scope);
        Assert.Null(scope.CleanupReport);
        Assert.Equal(2, fixture.Worker.DisposeCount);
        Assert.Equal(1, fixture.Worker.SuccessfulDisposals);
        Assert.Equal(1, fixture.Service.DisposeCount);
        scope.Dispose();
    }

    [Fact]
    public async Task TerminationFailureAfterDisposalRemainsReportedWithoutRedisposal()
    {
        Fixture fixture = await CreateAsync();
        fixture.Worker.FailTermination = true;
        var scope = await fixture.HoldAsync();
        await fixture.SettleUnknownAsync(scope);
        await fixture.SettleUnknownAsync(scope);
        Assert.Null(scope.CleanupReport);
        var facts = scope.GetWorkerCleanupFacts(fixture.Worker);
        Assert.True(facts.DisposalSucceeded);
        Assert.False(facts.TerminationSucceeded);
        Assert.Same(fixture.Worker.TerminationFailure, facts.Failure);
        Assert.Equal(1, fixture.Worker.DisposeCount);
        Assert.Equal(1, fixture.Worker.TerminationCount);
        scope.Dispose();
        await fixture.AssertClosedAsync();
        var retry = await fixture.HoldAsync();
        Assert.Same(fixture.Worker, Assert.Single(retry.Workers));
        await fixture.SettleUnknownAsync(retry);
        Assert.Null(retry.CleanupReport);
        Assert.Equal(1, fixture.Worker.DisposeCount);
        retry.Dispose();
    }

    [Fact]
    public async Task CancelledAdmissionLeavesActiveGenerationUntouched()
    {
        Fixture fixture = await CreateAsync();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            fixture.Resources.AcquireSettlementScopeAsync(fixture.Id, 1, cancellation.Token).AsTask());
        var worker = new ControlledResource();
        await fixture.Resources.TrackWorkerAsync(fixture.Id, 1, worker);
        Assert.Equal(0, fixture.Host.AcquisitionCount);
        Assert.True((await fixture.Resources.RevokeAllAsync(fixture.Id, 1, default)).IsEmpty);
        Assert.Equal(1, worker.DisposeCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CancellationAfterHostAcquisitionKeepsCustodyAndFirstCause(bool releaseFails)
    {
        Fixture fixture = await CreateAsync();
        fixture.Host.BlockAcquisition = true;
        fixture.Host.FailNextRelease = releaseFails;
        using var cancellation = new CancellationTokenSource();
        Task acquire = fixture.Resources.AcquireSettlementScopeAsync(fixture.Id, 1, cancellation.Token).AsTask();
        await fixture.Host.AcquisitionStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        fixture.Host.AllowAcquisition.TrySetResult();
        OperationCanceledException failure = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => acquire);
        if (releaseFails)
        {
            Assert.Same(fixture.Host.ReleaseError, failure.Data["LifecycleSettlementReleaseFailure"]);
            Assert.True(fixture.Host.Held);
        }
        else
        {
            Assert.False(fixture.Host.Held);
        }
        await fixture.AssertClosedAsync();
        fixture.Host.BlockAcquisition = false;
        var retry = await fixture.HoldAsync();
        Assert.Same(fixture.Worker, Assert.Single(retry.Workers));
        Assert.Equal(1, retry.Generation);
        Assert.Equal(fixture.Targets, retry.Targets);
        await fixture.SettleUnknownAsync(retry);
        retry.Dispose();
        Assert.False(fixture.Host.Held);
        Assert.Equal(1, fixture.Worker.DisposeCount);
    }

    [Fact]
    public async Task HostReleaseFailureRetainsExclusionAndCanBeRetried()
    {
        Fixture fixture = await CreateAsync(trackInstances: false);
        var scope = await fixture.HoldAsync();
        await scope.SettleAsync();
        fixture.Host.FailNextRelease = true;
        Assert.Same(fixture.Host.ReleaseError, Assert.Throws<IOException>(scope.Dispose));
        Assert.Same(fixture.Host.ReleaseError, scope.ReleaseFailure);
        Assert.Null(scope.CleanupReport);
        Assert.Null(scope.HostCleanupReport);
        Assert.False(scope.IsReleased);
        Assert.True(fixture.Host.Held);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.HoldAsync().AsTask());
        await fixture.AssertClosedAsync();
        await scope.SettleAsync();
        scope.Dispose();
        Assert.True(scope.IsReleased);
        await fixture.ActivateAsync(2);
    }

    [Fact]
    public async Task ReleaseDoesNotCallHostUnderLifecycleLockAndKeepsExclusionUntilComplete()
    {
        Fixture fixture = await CreateAsync(trackInstances: false);
        var scope = await fixture.HoldAsync();
        await scope.SettleAsync();
        fixture.Host.BlockRelease = true;
        Task release = Task.Run(scope.Dispose);
        await fixture.Host.ReleaseStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            Assert.False(scope.IsReleased);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.HoldAsync().AsTask());
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => scope.SettleAsync().AsTask());
        }
        finally
        {
            fixture.Host.AllowRelease.TrySetResult();
            await release.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.True(scope.IsReleased);
        await fixture.ActivateAsync(2);
    }

    [Theory]
    [InlineData("missing", 1)]
    [InlineData("acme.author-tools", 2)]
    [InlineData("acme.author-tools", 0)]
    public async Task AbsentOrWrongGenerationCannotInventOldRoster(string id, long generation)
    {
        Fixture fixture = await CreateAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            fixture.Resources.AcquireSettlementScopeAsync(id, generation, default).AsTask());
        Assert.Equal(0, fixture.Host.AcquisitionCount);
        Assert.True((await fixture.Resources.RevokeAllAsync(fixture.Id, 1, default)).IsEmpty);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.HoldAsync().AsTask());
    }

    private static TaskCompletionSource Signal() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static async Task<Fixture> CreateAsync(IAuthoringLifecycleHostResourceAuthority? host = null, bool trackInstances = true)
    {
        VerifiedAuthoringExtensionContract contract = AuthoringExtensionContractValidator.Verify(
            AuthoringExtensionContractsTests.CreateManifest());
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var package = new VerifiedAuthoringPackage(contract,
            new AuthoringPackageArtifact([], [], "acme", "key-1", "source/1", "provenance/1"),
            new AuthoringPackageArchiveContents([], []),
            new AuthoringPackageTrustDecision(AuthoringPackageTrustStatus.Trusted, "acme", "key-1", now, now.AddMinutes(5)),
            new string('a', 64));
        AuthoringContributionDeclaration contribution = contract.Manifest.Contributions[0];
        ImmutableArray<AuthoringExecutionTarget> targets =
        [
            new(AuthoringExecutionResolutionStatus.Ready, contribution.ExecutionClass, contract.Manifest.Id,
                contract.Manifest.Version, contract.Manifest.PackageSha256, contribution.Id, contribution.Kind,
                contribution.Entrypoint.PathOrAdapterId, null, new string('c', 64), null)
        ];
        var known = host as HeldHost ?? new HeldHost();
        var resources = new AuthoringExtensionLifecycleResources(host ?? known);
        await resources.ActivateAtomicallyAsync(package, targets, 1, default);
        var worker = new ControlledResource();
        var service = new ControlledResource();
        if (trackInstances)
        {
            await resources.TrackWorkerAsync(contract.Manifest.Id, 1, worker);
            await resources.TrackServiceAsync(contract.Manifest.Id, 1, service);
        }
        return new(resources, package, targets, known, worker, service);
    }

    private sealed record Fixture(AuthoringExtensionLifecycleResources Resources, VerifiedAuthoringPackage Package,
        ImmutableArray<AuthoringExecutionTarget> Targets, HeldHost Host, ControlledResource Worker, ControlledResource Service)
    {
        public string Id => Package.Contract.Manifest.Id;
        public ValueTask<AuthoringExtensionLifecycleResources.SettlementScope> HoldAsync() =>
            Resources.AcquireSettlementScopeAsync(Id, 1, default);
        public ValueTask ActivateAsync(long generation) => Resources.ActivateAtomicallyAsync(Package, Targets, generation, default);
        public async Task SettleUnknownAsync(AuthoringExtensionLifecycleResources.SettlementScope scope)
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => scope.SettleAsync().AsTask());
            Assert.Null(scope.CleanupReport);
            Assert.False(scope.NativeCustodySettled);
        }
        public async Task AssertClosedAsync()
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => ActivateAsync(2).AsTask());
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
                Resources.RebindGenerationAsync(Id, 1, 2, default).AsTask());
        }
    }

    private sealed class LegacyHost : IAuthoringLifecycleHostResourceAuthority
    {
        public ValueTask ActivateAtomicallyAsync(VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(string extensionId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringLifecycleHostResourceReport(0, 0, 0, 0, 0));
    }

    private sealed class HeldHost : IAuthoringLifecycleHostSettlementAuthority
    {
        private readonly Lock _lock = new();
        private readonly Dictionary<long, HostGeneration> _generations = [];
        private long _generation;
        public bool Held
        {
            get
            {
                lock (_lock)
                {
                    return _generations.Values.Any(static entry => entry.Held);
                }
            }
        }
        public int AcquisitionCount
        {
            get; private set;
        }
        public int RevocationCount
        {
            get; private set;
        }
        public bool ObservationUnavailable
        {
            get; set;
        }
        public bool BlockAcquisition
        {
            get; set;
        }
        public bool BlockRelease
        {
            get; set;
        }
        public bool FailNextRelease
        {
            get; set;
        }
        public IOException ReleaseError { get; } = new("host release failed");
        public TaskCompletionSource AcquisitionStarted { get; } = Signal();
        public TaskCompletionSource AllowAcquisition { get; } = Signal();
        public TaskCompletionSource ReleaseStarted { get; } = Signal();
        public TaskCompletionSource AllowRelease { get; } = Signal();

        public ValueTask ActivateAtomicallyAsync(VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets, CancellationToken cancellationToken) =>
            ActivateGenerationAtomicallyAsync(package, targets, _generation + 1, cancellationToken);

        public ValueTask ActivateGenerationAtomicallyAsync(VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets, long generation, CancellationToken cancellationToken)
        {
            lock (_lock)
            {
                if (_generation >= generation || (_generations.TryGetValue(_generation, out HostGeneration? previous) &&
                    (previous.Rpc.Count > 0 || previous.Jobs.Count > 0 || previous.Surfaces.Count > 0)))
                {
                    throw new AuthoringExtensionContractException("original host roster is not empty");
                }
                var state = new HostGeneration();
                state.Rpc.Add(package.Contract.Manifest.Id);
                state.Jobs.Add(package.Contract.Manifest.Id);
                state.Surfaces.Add(package.Contract.Manifest.Id);
                _generations.Add(generation, state);
                _generation = generation;
            }
            return ValueTask.CompletedTask;
        }

        public async ValueTask<IAuthoringLifecycleHostSettlementScope?> AcquireSettlementScopeAsync(
            string extensionId, long generation, ImmutableArray<AuthoringExecutionTarget> targets, CancellationToken cancellationToken)
        {
            HostGeneration state;
            lock (_lock)
            {
                if (!_generations.TryGetValue(generation, out state!))
                    return null;
                if (state.Held)
                    throw new AuthoringExtensionContractException("original host roster held");
                state.Held = true;
                AcquisitionCount++;
            }
            AcquisitionStarted.TrySetResult();
            if (BlockAcquisition)
                await AllowAcquisition.Task;
            return new HostScope(this, state);
        }

        public void AssertMutationRefused()
        {
            Assert.Throws<AuthoringExtensionContractException>(() =>
                ActivateAtomicallyAsync(null!, [], default).GetAwaiter().GetResult());
        }

        public ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(string extensionId, CancellationToken cancellationToken)
        {
            lock (_lock)
            {
                HostGeneration state = _generations[_generation];
                if (state.Held)
                    throw new AuthoringExtensionContractException("original host roster held");
                return ValueTask.FromResult(ClearAndObserve(state));
            }
        }

        private AuthoringLifecycleHostResourceReport ClearAndObserve(HostGeneration state)
        {
            state.Rpc.Clear();
            state.Jobs.Clear();
            state.Surfaces.Clear();
            RevocationCount++;
            return new(0, state.Rpc.Count, 0, state.Jobs.Count, state.Surfaces.Count);
        }

        private sealed class HostGeneration
        {
            public HashSet<string> Rpc { get; } = [];
            public HashSet<string> Jobs { get; } = [];
            public HashSet<string> Surfaces { get; } = [];
            public bool Held;
        }

        private sealed class HostScope(HeldHost owner, HostGeneration state) : IAuthoringLifecycleHostSettlementScope
        {
            public ValueTask<AuthoringLifecycleHostResourceReport?> RevokeAllAsync(CancellationToken cancellationToken)
            {
                lock (owner._lock)
                {
                    Assert.True(state.Held);
                    if (owner.ObservationUnavailable)
                        return ValueTask.FromResult<AuthoringLifecycleHostResourceReport?>(null);
                    return ValueTask.FromResult<AuthoringLifecycleHostResourceReport?>(owner.ClearAndObserve(state));
                }
            }

            public void Dispose()
            {
                owner.ReleaseStarted.TrySetResult();
                if (owner.BlockRelease)
                    owner.AllowRelease.Task.GetAwaiter().GetResult();
                lock (owner._lock)
                {
                    if (owner.FailNextRelease)
                    {
                        owner.FailNextRelease = false;
                        throw owner.ReleaseError;
                    }
                    state.Held = false;
                }
            }
        }
    }

    private sealed class ControlledResource : IAuthoringWorkerSandboxInstance, IAuthoringServiceProcess
    {
        public bool BlockDisposal
        {
            get; set;
        }
        public bool BlockTermination
        {
            get; set;
        }
        public bool FailTermination
        {
            get; set;
        }
        public int DisposalFailures
        {
            get; set;
        }
        public int DisposeCount
        {
            get; private set;
        }
        public int TerminationCount
        {
            get; private set;
        }
        public int SuccessfulDisposals
        {
            get; private set;
        }
        public IOException DisposalFailure { get; } = new("dispose failed");
        public IOException TerminationFailure { get; } = new("termination failed");
        public TaskCompletionSource DisposalStarted { get; } = Signal();
        public TaskCompletionSource AllowDisposal { get; } = Signal();
        public TaskCompletionSource TerminationStarted { get; } = Signal();
        public TaskCompletionSource AllowTermination { get; } = Signal();
        public AuthoringWorkerCapabilityReport CapabilityReport => throw new NotSupportedException();
        public AuthoringProcessOwnershipReport Ownership => throw new NotSupportedException();
        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(AuthoringWorkerRequest request, CancellationToken cancellationToken) =>
            throw new NotSupportedException();
        public ValueTask<AuthoringServiceResponse> ExecuteAsync(AuthoringServiceRequest request, CancellationToken cancellationToken) =>
            throw new NotSupportedException();
        public ValueTask<AuthoringServiceHealthReport> GetHealthAsync(CancellationToken cancellationToken) =>
            throw new NotSupportedException();
        public ValueTask TerminateTreeAsync(string reason, CancellationToken cancellationToken) => TerminateAsync(reason, cancellationToken);
        public async ValueTask TerminateAsync(string reason, CancellationToken cancellationToken)
        {
            TerminationCount++;
            TerminationStarted.TrySetResult();
            if (BlockTermination)
                await AllowTermination.Task;
            if (FailTermination)
                throw TerminationFailure;
        }
        public async ValueTask DisposeAsync()
        {
            DisposeCount++;
            DisposalStarted.TrySetResult();
            if (BlockDisposal)
                await AllowDisposal.Task;
            if (DisposeCount <= DisposalFailures)
                throw DisposalFailure;
            SuccessfulDisposals++;
        }
    }
}
