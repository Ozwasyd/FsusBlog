using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringLifecycleSettlementReviewRegressionTests
{
    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, true, false)]
    [InlineData(false, false, true)]
    [InlineData(true, false, true)]
    [InlineData(false, true, true)]
    [InlineData(true, true, true)]
    public async Task LateTrackInvalidatesEmptySettlementUntilItsActualCustodyIsKnown(
        bool service, bool cancelled, bool cleanupFails)
    {
        Fixture fixture = await CreateAsync(trackInstances: false);
        var scope = await fixture.HoldAsync();
        await scope.SettleAsync();
        Assert.True(scope.CleanupReport!.IsEmpty);
        var late = new ControlledResource
        {
            BlockTermination = true,
            FailTermination = cleanupFails,
            DisposalFailures = cleanupFails ? 1 : 0
        };
        using var cancellation = new CancellationTokenSource();
        if (cancelled)
        {
            cancellation.Cancel();
        }
        Task track = TrackAsync(fixture, service, 1, late, cancellation.Token);
        await late.TerminationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Task settle = scope.SettleAsync().AsTask();
        try
        {
            Assert.Null(scope.CleanupReport);
            Assert.False(scope.NativeCustodySettled);
            Assert.False(settle.IsCompletedSuccessfully);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.ActivateAsync(2).AsTask());
        }
        finally
        {
            late.AllowTermination.TrySetResult();
            Assert.NotNull(await Record.ExceptionAsync(() => track));
            await Record.ExceptionAsync(() => settle);
        }
        Assert.Null(scope.CleanupReport);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.ActivateAsync(2).AsTask());
        Assert.InRange(late.SuccessfulDisposals, 0, 1);
        scope.Dispose();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task HostReleasePhaseRefusesNewActivationUntilReleaseOutcomeIsKnown(bool failRelease)
    {
        Fixture fixture = await CreateAsync(trackInstances: false);
        var scope = await fixture.HoldAsync();
        await scope.SettleAsync();
        fixture.Host.BlockRelease = true;
        fixture.Host.FailNextRelease = failRelease;
        Task release = Task.Run(scope.Dispose);
        await fixture.Host.ReleaseStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.ActivateAsync(2).AsTask());
        }
        finally
        {
            fixture.Host.AllowRelease.TrySetResult();
            Exception? failure = await Record.ExceptionAsync(() => release);
            if (failRelease)
            {
                Assert.Same(fixture.Host.ReleaseError, failure);
            }
            else
            {
                Assert.Null(failure);
            }
        }
        if (failRelease)
        {
            Assert.Null(scope.CleanupReport);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.ActivateAsync(2).AsTask());
            scope.Dispose();
        }
        else
        {
            await fixture.ActivateAsync(2);
        }
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task AlreadyPreparedGenerationRefusesTrackDuringAndAfterAncestorReleaseFailure(bool service, bool cancelled)
    {
        Fixture fixture = await CreateAsync(trackInstances: false);
        var scope = await fixture.HoldAsync();
        await scope.SettleAsync();
        await fixture.ActivateAsync(2);
        fixture.Host.BlockRelease = true;
        fixture.Host.FailNextRelease = true;
        Task release = Task.Run(scope.Dispose);
        await fixture.Host.ReleaseStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var cancellation = new CancellationTokenSource();
        if (cancelled)
        {
            cancellation.Cancel();
        }
        var during = new ControlledResource();
        try
        {
            Assert.NotNull(await Record.ExceptionAsync(() => TrackAsync(fixture, service, 2, during, cancellation.Token)));
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
                fixture.Resources.RebindGenerationAsync(fixture.Id, 2, 3, default).AsTask());
        }
        finally
        {
            fixture.Host.AllowRelease.TrySetResult();
            Assert.Same(fixture.Host.ReleaseError, await Record.ExceptionAsync(() => release));
        }
        var after = new ControlledResource();
        Assert.NotNull(await Record.ExceptionAsync(() => TrackAsync(fixture, service, 2, after, cancellation.Token)));
        scope.Dispose();
        var afterAbandon = new ControlledResource();
        Assert.NotNull(await Record.ExceptionAsync(() => TrackAsync(fixture, service, 2, afterAbandon, default)));
        Assert.InRange(during.SuccessfulDisposals, 0, 1);
        Assert.InRange(after.SuccessfulDisposals, 0, 1);
        Assert.InRange(afterAbandon.SuccessfulDisposals, 0, 1);
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, true, false)]
    [InlineData(false, false, true)]
    [InlineData(true, false, true)]
    [InlineData(false, true, true)]
    [InlineData(true, true, true)]
    public async Task DuplicateTrackOfHeldOwnerCannotCreateAnotherCleanupOwner(bool service, bool cancelled, bool alreadySettled)
    {
        Fixture fixture = await CreateAsync();
        var scope = await fixture.HoldAsync();
        if (alreadySettled)
        {
            await fixture.SettleUnknownAsync(scope);
        }
        using var cancellation = new CancellationTokenSource();
        if (cancelled)
        {
            cancellation.Cancel();
        }
        ControlledResource instance = service ? fixture.Service : fixture.Worker;
        Exception? failure = await Record.ExceptionAsync(() => TrackAsync(fixture, service, 1, instance, cancellation.Token));
        if (cancelled)
        {
            Assert.IsAssignableFrom<OperationCanceledException>(failure);
        }
        else
        {
            Assert.IsType<AuthoringExtensionContractException>(failure);
        }
        await fixture.SettleUnknownAsync(scope);
        Assert.Equal(1, instance.TerminationCount);
        Assert.Equal(1, instance.DisposeCount);
        Assert.Equal(1, instance.SuccessfulDisposals);
        Assert.True(service ? scope.GetServiceCleanupFacts(instance).DisposalSucceeded : scope.GetWorkerCleanupFacts(instance).DisposalSucceeded);
        scope.Dispose();
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task LateDisposalPendingKeepsOriginalScopeUnknown(bool service, bool cancelled)
    {
        Fixture fixture = await CreateAsync(trackInstances: false);
        var scope = await fixture.HoldAsync();
        await scope.SettleAsync();
        var late = new ControlledResource { FailTermination = true, BlockDisposal = true, DisposalFailures = 1 };
        using var cancellation = new CancellationTokenSource();
        if (cancelled)
        {
            cancellation.Cancel();
        }
        Task track = TrackAsync(fixture, service, 1, late, cancellation.Token);
        await late.DisposalStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Task settle = scope.SettleAsync().AsTask();
        try
        {
            Assert.Null(scope.CleanupReport);
            Assert.False(scope.NativeCustodySettled);
            Assert.False(settle.IsCompletedSuccessfully);
            Assert.Empty(scope.Workers);
            Assert.Empty(scope.Services);
            Assert.False(service ? scope.GetServiceCleanupFacts(late).DisposalSucceeded : scope.GetWorkerCleanupFacts(late).DisposalSucceeded);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.ActivateAsync(2).AsTask());
        }
        finally
        {
            late.AllowDisposal.TrySetResult();
            Assert.Same(late.DisposalFailure, await Record.ExceptionAsync(() => track));
            await Record.ExceptionAsync(() => settle);
        }
        await fixture.SettleUnknownAsync(scope);
        await fixture.SettleUnknownAsync(scope);
        Assert.Equal(2, late.DisposeCount);
        Assert.Equal(1, late.SuccessfulDisposals);
        var facts = service ? scope.GetServiceCleanupFacts(late) : scope.GetWorkerCleanupFacts(late);
        Assert.True(facts.DisposalSucceeded);
        Assert.False(facts.TerminationSucceeded);
        Assert.Same(late.TerminationFailure, facts.Failure);
        Assert.Null(facts.NativeCustodyRetained);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.ActivateAsync(2).AsTask());
        scope.Dispose();
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task CompletedLateCleanupFailureRemainsOwnedAndCanRetryWithoutRepeatingSuccessfulDisposal(bool service, bool cancelled)
    {
        Fixture fixture = await CreateAsync(trackInstances: false);
        var scope = await fixture.HoldAsync();
        await scope.SettleAsync();
        var late = new ControlledResource { FailTermination = true, DisposalFailures = 1 };
        using var cancellation = new CancellationTokenSource();
        if (cancelled)
        {
            cancellation.Cancel();
        }
        Assert.Same(late.DisposalFailure, await Record.ExceptionAsync(() => TrackAsync(fixture, service, 1, late, cancellation.Token)));
        Assert.Null(scope.CleanupReport);
        var failed = service ? scope.GetServiceCleanupFacts(late) : scope.GetWorkerCleanupFacts(late);
        Assert.False(failed.DisposalSucceeded);
        Assert.Same(late.DisposalFailure, failed.Failure);
        await fixture.SettleUnknownAsync(scope);
        await fixture.SettleUnknownAsync(scope);
        Assert.Equal(2, late.DisposeCount);
        Assert.Equal(1, late.SuccessfulDisposals);
        var retried = service ? scope.GetServiceCleanupFacts(late) : scope.GetWorkerCleanupFacts(late);
        Assert.True(retried.DisposalSucceeded);
        Assert.False(retried.TerminationSucceeded);
        Assert.Same(late.TerminationFailure, retried.Failure);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.ActivateAsync(2).AsTask());
        scope.Dispose();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActivationAlreadyInsideHostRetainsBlockedGenerationAfterAncestorReleaseFailure(bool service)
    {
        Fixture fixture = await CreateAsync(trackInstances: false);
        var scope = await fixture.HoldAsync();
        await scope.SettleAsync();
        fixture.Host.BlockActivation = true;
        Task activate = fixture.ActivateAsync(2).AsTask();
        await fixture.Host.ActivationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            fixture.Host.FailNextRelease = true;
            Assert.Same(fixture.Host.ReleaseError, Record.Exception(scope.Dispose));
        }
        finally
        {
            fixture.Host.AllowActivation.TrySetResult();
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => activate);
        var late = new ControlledResource();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => TrackAsync(fixture, service, 2, late, default));
        var blocked = await fixture.Resources.AcquireSettlementScopeAsync(fixture.Id, 2);
        await fixture.SettleUnknownAsync(blocked);
        Assert.Equal(1, late.SuccessfulDisposals);
        Assert.True(service ? blocked.GetServiceCleanupFacts(late).DisposalSucceeded : blocked.GetWorkerCleanupFacts(late).DisposalSucceeded);
        blocked.Dispose();
        scope.Dispose();
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task DuplicateDuringOriginalCleanupCannotStartCompetingCleanup(bool service, bool cancelled)
    {
        Fixture fixture = await CreateAsync();
        ControlledResource instance = service ? fixture.Service : fixture.Worker;
        instance.BlockTermination = true;
        var scope = await fixture.HoldAsync();
        Task settle = scope.SettleAsync().AsTask();
        await instance.TerminationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        using var cancellation = new CancellationTokenSource();
        if (cancelled)
        {
            cancellation.Cancel();
        }
        Task duplicate = TrackAsync(fixture, service, 1, instance, cancellation.Token);
        try
        {
            Assert.True(duplicate.IsCompleted, "A duplicate must be rejected without starting or awaiting another cleanup.");
            Exception? rejected = await Record.ExceptionAsync(() => duplicate);
            if (cancelled)
            {
                Assert.IsAssignableFrom<OperationCanceledException>(rejected);
            }
            else
            {
                Assert.IsType<AuthoringExtensionContractException>(rejected);
            }
            Assert.Equal(1, instance.TerminationCount);
            Assert.Equal(0, instance.DisposeCount);
        }
        finally
        {
            instance.AllowTermination.TrySetResult();
            await Record.ExceptionAsync(() => duplicate);
            await Record.ExceptionAsync(() => settle);
        }
        Assert.Equal(1, instance.TerminationCount);
        Assert.Equal(1, instance.DisposeCount);
        Assert.Equal(1, instance.SuccessfulDisposals);
        scope.Dispose();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DuplicateInAdmittedGenerationRemainsIdempotent(bool service)
    {
        Fixture fixture = await CreateAsync();
        ControlledResource instance = service ? fixture.Service : fixture.Worker;
        await TrackAsync(fixture, service, 1, instance, default);
        Assert.Equal(0, instance.TerminationCount);
        Assert.Equal(0, instance.DisposeCount);
        var report = await fixture.Resources.RevokeAllAsync(fixture.Id, 1, default);
        Assert.True(report.IsEmpty);
        Assert.Equal(1, instance.TerminationCount);
        Assert.Equal(1, instance.SuccessfulDisposals);
    }

    private static Task TrackAsync(Fixture fixture, bool service, long generation,
        ControlledResource resource, CancellationToken cancellationToken) =>
        service
            ? fixture.Resources.TrackServiceAsync(fixture.Id, generation, resource, cancellationToken).AsTask()
            : fixture.Resources.TrackWorkerAsync(fixture.Id, generation, resource, cancellationToken).AsTask();

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
        public bool BlockActivation
        {
            get; set;
        }
        public TaskCompletionSource ActivationStarted { get; } = Signal();
        public TaskCompletionSource AllowActivation { get; } = Signal();
        public IOException ReleaseError { get; } = new("host release failed");
        public TaskCompletionSource AcquisitionStarted { get; } = Signal();
        public TaskCompletionSource AllowAcquisition { get; } = Signal();
        public TaskCompletionSource ReleaseStarted { get; } = Signal();
        public TaskCompletionSource AllowRelease { get; } = Signal();

        public ValueTask ActivateAtomicallyAsync(VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets, CancellationToken cancellationToken) =>
            ActivateGenerationAtomicallyAsync(package, targets, _generation + 1, cancellationToken);

        public async ValueTask ActivateGenerationAtomicallyAsync(VerifiedAuthoringPackage package,
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
            if (BlockActivation)
            {
                ActivationStarted.TrySetResult();
                await AllowActivation.Task;
            }
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
