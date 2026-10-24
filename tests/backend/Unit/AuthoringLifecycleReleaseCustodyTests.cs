using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringLifecycleReleaseCustodyTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReleaseFailureRetainsCustodyForRevoke(bool service)
    {
        var instance = new ControlledResource { DisposalFailures = 1 };
        Fixture fixture = await CreateAsync(service, instance);

        IOException failure = await Assert.ThrowsAsync<IOException>(() => fixture.ReleaseAsync().AsTask());

        Assert.Same(instance.DisposalFailure, failure);
        Assert.True((await fixture.RevokeAsync()).IsEmpty);
        Assert.Equal(1, instance.TerminationCount);
        Assert.Equal(2, instance.DisposeCount);
        Assert.Equal(1, instance.SuccessfulDisposals);
        await fixture.ReleaseAsync();
        Assert.True((await fixture.RevokeAsync()).IsEmpty);
        Assert.Equal(2, instance.DisposeCount);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ReleaseRacingRevokeDisposesExactlyOnce(bool service, bool failRelease)
    {
        var instance = new ControlledResource
        {
            BlockDisposal = true,
            DisposalFailures = failRelease ? 1 : 0
        };
        Fixture fixture = await CreateAsync(service, instance);
        Task release = fixture.ReleaseAsync().AsTask();
        await instance.DisposalStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Task<AuthoringLifecycleResourceReport> revoke = fixture.RevokeAsync().AsTask();
        try
        {
            Assert.False(revoke.IsCompleted);
        }
        finally
        {
            instance.AllowDisposal.TrySetResult();
            await AssertReleaseAsync(release, instance, failRelease);
            await revoke;
        }

        Assert.True((await revoke).IsEmpty);
        Assert.Equal(failRelease ? 1 : 0, instance.TerminationCount);
        Assert.Equal(failRelease ? 2 : 1, instance.DisposeCount);
        Assert.Equal(1, instance.SuccessfulDisposals);
        Assert.True((await fixture.RevokeAsync()).IsEmpty);
        Assert.Equal(failRelease ? 2 : 1, instance.DisposeCount);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ConcurrentReleasesShareDisposalAndFailure(bool service, bool failRelease)
    {
        var instance = new ControlledResource
        {
            BlockDisposal = true,
            DisposalFailures = failRelease ? 1 : 0
        };
        Fixture fixture = await CreateAsync(service, instance);
        Task first = fixture.ReleaseAsync().AsTask();
        await instance.DisposalStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Task second = fixture.ReleaseAsync().AsTask();
        try
        {
            Assert.False(second.IsCompleted);
        }
        finally
        {
            instance.AllowDisposal.TrySetResult();
            await AssertReleaseAsync(first, instance, failRelease);
            await AssertReleaseAsync(second, instance, failRelease);
        }

        Assert.Equal(1, instance.DisposeCount);
        Assert.True((await fixture.RevokeAsync()).IsEmpty);
        Assert.Equal(1, instance.SuccessfulDisposals);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RevokeRacingReleaseDisposesExactlyOnce(bool service)
    {
        var instance = new ControlledResource { BlockTermination = true };
        Fixture fixture = await CreateAsync(service, instance);
        Task<AuthoringLifecycleResourceReport> revoke = fixture.RevokeAsync().AsTask();
        await instance.TerminationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            await fixture.ReleaseAsync().AsTask().WaitAsync(TimeSpan.FromSeconds(5));
        }
        finally
        {
            instance.AllowTermination.TrySetResult();
            await revoke;
        }

        Assert.True((await revoke).IsEmpty);
        Assert.Equal(1, instance.TerminationCount);
        Assert.Equal(1, instance.DisposeCount);
        Assert.Equal(1, instance.SuccessfulDisposals);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task TerminationFailureRemainsReportedAfterDisposal(bool service)
    {
        var instance = new ControlledResource { FailTermination = true };
        Fixture fixture = await CreateAsync(service, instance);

        Assert.Equal(1, fixture.Remaining(await fixture.RevokeAsync()));
        Assert.Equal(1, instance.SuccessfulDisposals);
        await fixture.ReleaseAsync();

        Assert.Equal(1, fixture.Remaining(await fixture.RevokeAsync()));
        Assert.Equal(1, instance.TerminationCount);
        Assert.Equal(1, instance.DisposeCount);
        Assert.Equal(1, instance.SuccessfulDisposals);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RepeatedRevokeNeverRepeatsSuccessfulDisposalAfterTerminationFailure(bool service)
    {
        var instance = new ControlledResource { FailTermination = true };
        Fixture fixture = await CreateAsync(service, instance);

        Assert.Equal(1, fixture.Remaining(await fixture.RevokeAsync()));
        Assert.Equal(1, fixture.Remaining(await fixture.RevokeAsync()));
        Assert.Equal(1, instance.TerminationCount);
        Assert.Equal(1, instance.DisposeCount);
        Assert.Equal(1, instance.SuccessfulDisposals);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RevokeDisposalFailureCanRetry(bool service)
    {
        var instance = new ControlledResource { DisposalFailures = 1 };
        Fixture fixture = await CreateAsync(service, instance);

        Assert.Equal(1, fixture.Remaining(await fixture.RevokeAsync()));
        Assert.Equal(0, instance.SuccessfulDisposals);
        Assert.True((await fixture.RevokeAsync()).IsEmpty);
        Assert.Equal(2, instance.DisposeCount);
        Assert.Equal(1, instance.SuccessfulDisposals);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RepeatedTrackingKeepsOneDisposalOwner(bool service)
    {
        var instance = new ControlledResource();
        Fixture fixture = await CreateAsync(service, instance);
        if (service)
        {
            await fixture.Resources.TrackServiceAsync(fixture.ExtensionId, 1, instance);
        }
        else
        {
            await fixture.Resources.TrackWorkerAsync(fixture.ExtensionId, 1, instance);
        }

        await fixture.ReleaseAsync();

        Assert.True((await fixture.RevokeAsync()).IsEmpty);
        Assert.Equal(0, instance.TerminationCount);
        Assert.Equal(1, instance.DisposeCount);
        Assert.Equal(1, instance.SuccessfulDisposals);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailedReleaseAndFailedRevokeKeepReportingCustody(bool service)
    {
        var instance = new ControlledResource { DisposalFailures = 3 };
        Fixture fixture = await CreateAsync(service, instance);
        await Assert.ThrowsAsync<IOException>(() => fixture.ReleaseAsync().AsTask());

        Assert.Equal(1, fixture.Remaining(await fixture.RevokeAsync()));
        Assert.Equal(1, fixture.Remaining(await fixture.RevokeAsync()));
        Assert.Equal(0, instance.SuccessfulDisposals);
        Assert.True((await fixture.RevokeAsync()).IsEmpty);
        Assert.Equal(4, instance.DisposeCount);
        Assert.Equal(1, instance.SuccessfulDisposals);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReleasePreservesIdentityAndReboundGenerationChecks(bool service)
    {
        var instance = new ControlledResource();
        Fixture fixture = await CreateAsync(service, instance);
        await fixture.ReleaseAsync(extensionId: "other.extension");
        await fixture.ReleaseAsync(generation: 2);
        var untracked = new ControlledResource();
        await fixture.ReleaseAsync(instance: untracked);
        Assert.Equal(0, instance.DisposeCount);
        Assert.Equal(0, untracked.DisposeCount);
        Assert.True(await fixture.Resources.RebindGenerationAsync(fixture.ExtensionId, 1, 2, default));

        await fixture.ReleaseAsync();
        Assert.True((await fixture.RevokeAsync(generation: 2)).IsEmpty);
        Assert.Equal(0, instance.TerminationCount);
        Assert.Equal(1, instance.DisposeCount);
        Assert.Equal(1, instance.SuccessfulDisposals);
    }

    private static async Task AssertReleaseAsync(Task release, ControlledResource instance, bool fails)
    {
        if (fails)
        {
            Assert.Same(instance.DisposalFailure, await Assert.ThrowsAsync<IOException>(() => release));
        }
        else
        {
            await release;
        }
    }

    private static async Task<Fixture> CreateAsync(bool service, ControlledResource instance)
    {
        VerifiedAuthoringExtensionContract contract = AuthoringExtensionContractValidator.Verify(
            AuthoringExtensionContractsTests.CreateManifest());
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var package = new VerifiedAuthoringPackage(
            contract,
            new AuthoringPackageArtifact([], [], "acme", "key-1", "source/1", "provenance/1"),
            new AuthoringPackageArchiveContents([], []),
            new AuthoringPackageTrustDecision(AuthoringPackageTrustStatus.Trusted, "acme", "key-1", now, now.AddMinutes(5)),
            new string('a', 64));
        AuthoringContributionDeclaration contribution = contract.Manifest.Contributions[0];
        ImmutableArray<AuthoringExecutionTarget> targets =
        [
            new(AuthoringExecutionResolutionStatus.Ready, contribution.ExecutionClass,
                contract.Manifest.Id, contract.Manifest.Version, contract.Manifest.PackageSha256,
                contribution.Id, contribution.Kind, contribution.Entrypoint.PathOrAdapterId,
                null, new string('c', 64), null)
        ];
        var resources = new AuthoringExtensionLifecycleResources(new HostResources());
        await resources.ActivateAtomicallyAsync(package, targets, 1, default);
        if (service)
        {
            await resources.TrackServiceAsync(contract.Manifest.Id, 1, instance);
        }
        else
        {
            await resources.TrackWorkerAsync(contract.Manifest.Id, 1, instance);
        }
        return new Fixture(resources, contract.Manifest.Id, service, instance);
    }

    private sealed record Fixture(
        AuthoringExtensionLifecycleResources Resources,
        string ExtensionId,
        bool Service,
        ControlledResource Instance)
    {
        public ValueTask ReleaseAsync(string? extensionId = null, long generation = 1, ControlledResource? instance = null) =>
            Service
                ? Resources.ReleaseServiceAsync(extensionId ?? ExtensionId, generation, instance ?? Instance)
                : Resources.ReleaseWorkerAsync(extensionId ?? ExtensionId, generation, instance ?? Instance);

        public ValueTask<AuthoringLifecycleResourceReport> RevokeAsync(long generation = 1) =>
            Resources.RevokeAllAsync(ExtensionId, generation, default);

        public int Remaining(AuthoringLifecycleResourceReport report)
        {
            Assert.Equal(0, Service ? report.WorkerInstances : report.ServiceProcesses);
            return Service ? report.ServiceProcesses : report.WorkerInstances;
        }
    }

    private sealed class HostResources : IAuthoringLifecycleHostResourceAuthority
    {
        public ValueTask ActivateAtomicallyAsync(VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets, CancellationToken cancellationToken) =>
            ValueTask.CompletedTask;

        public ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(string extensionId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringLifecycleHostResourceReport(0, 0, 0, 0, 0));
    }

    private sealed class ControlledResource : IAuthoringWorkerSandboxInstance, IAuthoringServiceProcess
    {
        public bool BlockDisposal
        {
            get; init;
        }
        public bool BlockTermination
        {
            get; init;
        }
        public bool FailTermination
        {
            get; init;
        }
        public int DisposalFailures
        {
            get; init;
        }
        public int DisposeCount
        {
            get; private set;
        }
        public int SuccessfulDisposals
        {
            get; private set;
        }
        public int TerminationCount
        {
            get; private set;
        }
        public IOException DisposalFailure { get; } = new("disposal failed");
        public TaskCompletionSource DisposalStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource AllowDisposal { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource TerminationStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource AllowTermination { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public AuthoringWorkerCapabilityReport CapabilityReport => throw new NotSupportedException();
        public AuthoringProcessOwnershipReport Ownership => throw new NotSupportedException();

        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(AuthoringWorkerRequest request, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<AuthoringServiceResponse> ExecuteAsync(AuthoringServiceRequest request, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask<AuthoringServiceHealthReport> GetHealthAsync(CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask TerminateTreeAsync(string reason, CancellationToken cancellationToken) =>
            TerminateAsync(reason, cancellationToken);

        public async ValueTask TerminateAsync(string reason, CancellationToken cancellationToken)
        {
            TerminationCount++;
            TerminationStarted.TrySetResult();
            if (BlockTermination)
            {
                await AllowTermination.Task;
            }
            if (FailTermination)
            {
                throw new IOException("termination failed");
            }
        }

        public async ValueTask DisposeAsync()
        {
            DisposeCount++;
            DisposalStarted.TrySetResult();
            if (BlockDisposal)
            {
                await AllowDisposal.Task;
            }
            if (DisposeCount <= DisposalFailures)
            {
                throw DisposalFailure;
            }
            SuccessfulDisposals++;
        }
    }
}
