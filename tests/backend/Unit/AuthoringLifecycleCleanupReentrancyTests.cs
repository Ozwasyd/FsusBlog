using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringLifecycleCleanupReentrancyTests
{
    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, false, true)]
    [InlineData(false, true, false)]
    [InlineData(false, true, true)]
    [InlineData(true, false, false)]
    [InlineData(true, false, true)]
    [InlineData(true, true, false)]
    [InlineData(true, true, true)]
    public async Task CleanupCallbackCannotWaitForItsOwnAuthority(
        bool service,
        bool outerRevoke,
        bool callbackRevoke)
    {
        var resource = new CallbackResource();
        Fixture fixture = await CreateAsync(service, resource);
        using var cleanupCancellation = new CancellationTokenSource();
        Task? nested = null;
        Exception? refusal = null;
        resource.DuringDisposal = async () =>
        {
            refusal = await Record.ExceptionAsync(async () =>
            {
                Task callback = callbackRevoke ? fixture.RevokeAsync().AsTask() : fixture.ReleaseAsync().AsTask();
                nested = callback;
                await callback.WaitAsync(cleanupCancellation.Token);
            });
        };

        Task operation = outerRevoke ? fixture.RevokeAsync().AsTask() : fixture.ReleaseAsync().AsTask();
        try
        {
            await operation.WaitAsync(TimeSpan.FromSeconds(5));
            if (outerRevoke && !callbackRevoke)
            {
                // A release inside already-started revocation remains the original harmless no-op.
                Assert.Null(refusal);
            }
            else
            {
                AuthoringExtensionContractException failure = Assert.IsType<AuthoringExtensionContractException>(refusal);
                Assert.Equal("Lifecycle cleanup cannot reenter its resource authority.", failure.Message);
            }
            Assert.Equal(1, resource.Disposals);
            Assert.Equal(outerRevoke ? 1 : 0, resource.Terminations);
            Assert.True((await fixture.RevokeAsync()).IsEmpty);
            Assert.Equal(1, resource.Disposals);
        }
        finally
        {
            // Unwind the deliberately blocked original implementation without orphaning either task.
            await cleanupCancellation.CancelAsync();
            await ObserveAsync(operation);
            await ObserveAsync(nested);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CapturedCleanupContextDoesNotRefuseARequestAfterDisposal(bool service)
    {
        var resource = new CallbackResource();
        Fixture fixture = await CreateAsync(service, resource);
        var permit = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<AuthoringLifecycleResourceReport>? later = null;
        resource.DuringDisposal = () =>
        {
            later = Task.Run(async () =>
            {
                await permit.Task;
                return await fixture.RevokeAsync();
            });
            return Task.CompletedTask;
        };

        try
        {
            await fixture.ReleaseAsync();
            Assert.NotNull(later);
            permit.TrySetResult();
            Assert.True((await later!.WaitAsync(TimeSpan.FromSeconds(5))).IsEmpty);
            Assert.Equal(1, resource.Disposals);
        }
        finally
        {
            permit.TrySetResult();
            await ObserveAsync(later);
        }
    }

    private static async Task ObserveAsync(Task? task)
    {
        if (task is null)
        {
            return;
        }
        try
        {
            await task;
        }
        catch
        {
            // Assertions above retain the outcome; cleanup observes every owned terminal task.
        }
    }

    private static async Task<Fixture> CreateAsync(bool service, CallbackResource resource)
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
            await resources.TrackServiceAsync(contract.Manifest.Id, 1, resource);
        }
        else
        {
            await resources.TrackWorkerAsync(contract.Manifest.Id, 1, resource);
        }
        return new Fixture(resources, contract.Manifest.Id, service, resource);
    }

    private sealed record Fixture(
        AuthoringExtensionLifecycleResources Resources,
        string ExtensionId,
        bool Service,
        CallbackResource Resource)
    {
        public ValueTask ReleaseAsync() => Service
            ? Resources.ReleaseServiceAsync(ExtensionId, 1, Resource)
            : Resources.ReleaseWorkerAsync(ExtensionId, 1, Resource);

        public ValueTask<AuthoringLifecycleResourceReport> RevokeAsync() =>
            Resources.RevokeAllAsync(ExtensionId, 1, default);
    }

    private sealed class HostResources : IAuthoringLifecycleHostResourceAuthority
    {
        public ValueTask ActivateAtomicallyAsync(VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets, CancellationToken cancellationToken)
        {
            return ValueTask.CompletedTask;
        }

        public ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(string extensionId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringLifecycleHostResourceReport(0, 0, 0, 0, 0));
    }

    private sealed class CallbackResource : IAuthoringWorkerSandboxInstance, IAuthoringServiceProcess
    {
        public Func<Task>? DuringDisposal
        {
            get; set;
        }

        public int Disposals
        {
            get; private set;
        }

        public int Terminations
        {
            get; private set;
        }

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

        public ValueTask TerminateAsync(string reason, CancellationToken cancellationToken)
        {
            Terminations++;
            return ValueTask.CompletedTask;
        }

        public async ValueTask DisposeAsync()
        {
            Disposals++;
            if (DuringDisposal is not null)
            {
                await DuringDisposal();
            }
        }
    }
}
