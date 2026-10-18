using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringWorkerTerminalDeadlineTests
{
    [Theory]
    [InlineData(false, -1, AuthoringWorkerResultStatus.Completed)]
    [InlineData(false, 0, AuthoringWorkerResultStatus.TimedOut)]
    [InlineData(false, 1, AuthoringWorkerResultStatus.TimedOut)]
    [InlineData(true, -1, AuthoringWorkerResultStatus.Completed)]
    [InlineData(true, 0, AuthoringWorkerResultStatus.TimedOut)]
    [InlineData(true, 1, AuthoringWorkerResultStatus.TimedOut)]
    public async Task ExecuteAsync_ReturnBoundaryDeadline_IsExclusive(
        bool advanceAtRevisionGate,
        long deadlineOffsetTicks,
        AuthoringWorkerResultStatus expectedStatus)
    {
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        DateTimeOffset boundary = default;
        async ValueTask AdvanceAsync(CancellationToken token)
        {
            await Task.Yield();
            clock.UtcNow = boundary.AddTicks(deadlineOffsetTicks);
        }

        var instance = new TestInstance { ResponseBoundary = advanceAtRevisionGate ? null : AdvanceAsync };
        var gate = new CallbackRevisionGate(async token =>
        {
            if (advanceAtRevisionGate)
            {
                await AdvanceAsync(token);
            }
            return true;
        });
        WorkerFixture fixture = await CreateFixtureAsync(instance, clock, gate);
        boundary = fixture.Request.Deadline;

        AuthoringWorkerExecutionResult result = await fixture.Sandbox.ExecuteAsync(
            fixture.Package, fixture.Target, fixture.Request, 1);

        if (expectedStatus == AuthoringWorkerResultStatus.Completed)
        {
            Assert.Equal(expectedStatus, result.Status);
            Assert.Equal([4, 5, 6], result.Response?.Payload);
            Assert.Equal(expectedStatus, Assert.IsType<AuthoringWorkerExecutionReceipt>(result.Receipt).Status);
            Assert.Equal(0, instance.TerminationCount);
            Assert.Equal(1, instance.DisposeCount);
        }
        else
        {
            AssertTerminal(result, instance, expectedStatus);
        }
        Assert.Equal(!advanceAtRevisionGate && deadlineOffsetTicks >= 0 ? 0 : 1, gate.CallCount);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task ExecuteAsync_NonCooperativeReturnAfterCallerCancellation_CannotComplete(
        bool cancelAtRevisionGate,
        bool alsoExpire)
    {
        using var cancellation = new CancellationTokenSource();
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        DateTimeOffset boundary = default;
        async ValueTask CancelAsync(CancellationToken token)
        {
            await Task.Yield();
            if (alsoExpire)
            {
                clock.UtcNow = boundary;
            }
            cancellation.Cancel();
        }

        var instance = new TestInstance { ResponseBoundary = cancelAtRevisionGate ? null : CancelAsync };
        var gate = new CallbackRevisionGate(async token =>
        {
            if (cancelAtRevisionGate)
            {
                await CancelAsync(token);
            }
            return true;
        });
        WorkerFixture fixture = await CreateFixtureAsync(instance, clock, gate);
        boundary = fixture.Request.Deadline;

        AuthoringWorkerExecutionResult result = await fixture.Sandbox.ExecuteAsync(
            fixture.Package, fixture.Target, fixture.Request, 1, cancellation.Token);

        AssertTerminal(result, instance, AuthoringWorkerResultStatus.Cancelled);
        Assert.Equal(cancelAtRevisionGate ? 1 : 0, gate.CallCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecuteAsync_ExpiredOrCancelledStaleRevision_UsesTerminalStatus(bool cancelCaller)
    {
        using var cancellation = new CancellationTokenSource();
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        DateTimeOffset boundary = default;
        var instance = new TestInstance();
        var gate = new CallbackRevisionGate(async _ =>
        {
            await Task.Yield();
            clock.UtcNow = boundary;
            if (cancelCaller)
            {
                cancellation.Cancel();
            }
            return false;
        });
        WorkerFixture fixture = await CreateFixtureAsync(instance, clock, gate);
        boundary = fixture.Request.Deadline;

        AuthoringWorkerExecutionResult result = await fixture.Sandbox.ExecuteAsync(
            fixture.Package, fixture.Target, fixture.Request, 1, cancellation.Token);

        AssertTerminal(result, instance,
            cancelCaller ? AuthoringWorkerResultStatus.Cancelled : AuthoringWorkerResultStatus.TimedOut);
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(true, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, true, false)]
    [InlineData(false, true, true)]
    [InlineData(true, true, true)]
    public async Task ExecuteAsync_TerminalBoundary_AwaitsOwnedTermination(
        bool atRevisionGate,
        bool cancelCaller,
        bool throwCancellation)
    {
        using var cancellation = new CancellationTokenSource();
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        DateTimeOffset boundary = default;
        var terminationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var allowTermination = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async ValueTask ReachBoundaryAsync(CancellationToken token)
        {
            await Task.Yield();
            clock.UtcNow = boundary;
            if (cancelCaller)
            {
                cancellation.Cancel();
            }
            if (throwCancellation)
            {
                token.ThrowIfCancellationRequested();
            }
        }

        var instance = new TestInstance
        {
            ResponseBoundary = atRevisionGate ? null : ReachBoundaryAsync,
            Termination = async () =>
            {
                terminationStarted.SetResult();
                await allowTermination.Task;
            }
        };
        var gate = new CallbackRevisionGate(async token =>
        {
            if (atRevisionGate)
            {
                await ReachBoundaryAsync(token);
            }
            return true;
        });
        WorkerFixture fixture = await CreateFixtureAsync(instance, clock, gate);
        boundary = fixture.Request.Deadline;

        Task<AuthoringWorkerExecutionResult> execution = fixture.Sandbox.ExecuteAsync(
            fixture.Package, fixture.Target, fixture.Request, 1, cancellation.Token).AsTask();
        try
        {
            await terminationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(execution.IsCompleted);
            Assert.Equal(0, instance.DisposeCount);
        }
        finally
        {
            allowTermination.TrySetResult();
        }

        AssertTerminal(await execution, instance,
            cancelCaller ? AuthoringWorkerResultStatus.Cancelled : AuthoringWorkerResultStatus.TimedOut);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecuteAsync_DeadlineTokenCancellation_RejectsNonCooperativeReturn(bool atRevisionGate)
    {
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        var instance = new TestInstance
        {
            ResponseBoundary = atRevisionGate ? null : WaitForCancellationAsync
        };
        var gate = new CallbackRevisionGate(async token =>
        {
            if (atRevisionGate)
            {
                await WaitForCancellationAsync(token);
            }
            return true;
        });
        WorkerFixture fixture = await CreateFixtureAsync(instance, clock, gate);

        AuthoringWorkerExecutionResult result = await fixture.Sandbox.ExecuteAsync(
            fixture.Package, fixture.Target,
            fixture.Request with
            {
                Deadline = clock.UtcNow.AddMilliseconds(20)
            }, 1);

        // The injected clock has not expired; the owned deadline token must still reject the result.
        AssertTerminal(result, instance, AuthoringWorkerResultStatus.TimedOut);
    }

    [Fact]
    public async Task ExecuteAsync_RevisionGateDeadlineCancellation_AwaitsOwnedTermination()
    {
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        var terminationStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var allowTermination = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var instance = new TestInstance
        {
            Termination = async () =>
            {
                terminationStarted.SetResult();
                await allowTermination.Task;
            }
        };
        var gate = new CallbackRevisionGate(async token =>
        {
            await WaitForCancellationAsync(token);
            token.ThrowIfCancellationRequested();
            return true;
        });
        WorkerFixture fixture = await CreateFixtureAsync(instance, clock, gate);

        Task<AuthoringWorkerExecutionResult> execution = fixture.Sandbox.ExecuteAsync(
            fixture.Package, fixture.Target,
            fixture.Request with
            {
                Deadline = clock.UtcNow.AddMilliseconds(20)
            }, 1).AsTask();
        try
        {
            await terminationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(execution.IsCompleted);
            Assert.Equal(0, instance.DisposeCount);
        }
        finally
        {
            allowTermination.TrySetResult();
        }

        AssertTerminal(await execution, instance, AuthoringWorkerResultStatus.TimedOut);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task ExecuteAsync_TerminationFailure_PropagatesWithoutSuccessReceipt(
        bool atRevisionGate,
        bool cancelCaller)
    {
        using var cancellation = new CancellationTokenSource();
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        DateTimeOffset boundary = default;
        var failure = new InvalidOperationException("termination-failed");
        async ValueTask ReachBoundaryAsync(CancellationToken token)
        {
            await Task.Yield();
            clock.UtcNow = boundary;
            if (cancelCaller)
            {
                cancellation.Cancel();
            }
        }

        var instance = new TestInstance
        {
            ResponseBoundary = atRevisionGate ? null : ReachBoundaryAsync,
            Termination = () => ValueTask.FromException(failure)
        };
        var gate = new CallbackRevisionGate(async token =>
        {
            if (atRevisionGate)
            {
                await ReachBoundaryAsync(token);
            }
            return true;
        });
        WorkerFixture fixture = await CreateFixtureAsync(instance, clock, gate);
        boundary = fixture.Request.Deadline;

        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
            await fixture.Sandbox.ExecuteAsync(
                fixture.Package, fixture.Target, fixture.Request, 1, cancellation.Token));

        Assert.Same(failure, actual);
        Assert.Equal("cancelled-or-timeout", instance.TerminationReason);
        Assert.False(instance.TerminationTokenWasCancelable);
        Assert.Equal(1, instance.TerminationCount);
        Assert.Equal(1, instance.DisposeCount);
    }

    private static async ValueTask WaitForCancellationAsync(CancellationToken token)
    {
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using CancellationTokenRegistration registration = token.Register(() => cancelled.TrySetResult());
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private static void AssertTerminal(
        AuthoringWorkerExecutionResult result,
        TestInstance instance,
        AuthoringWorkerResultStatus expectedStatus)
    {
        Assert.Equal(expectedStatus, result.Status);
        Assert.Null(result.Response);
        Assert.Equal("cancelled-or-timeout", result.StableReason);
        Assert.Equal(3, result.RequestBytes);
        Assert.Equal(0, result.ResponseBytes);
        AuthoringWorkerExecutionReceipt receipt = Assert.IsType<AuthoringWorkerExecutionReceipt>(result.Receipt);
        Assert.Equal(expectedStatus, receipt.Status);
        Assert.Equal(result.StableReason, receipt.StableReason);
        Assert.Equal(result.RequestBytes, receipt.RequestBytes);
        Assert.Equal(0, receipt.ResponseBytes);
        Assert.Equal("cancelled-or-timeout", instance.TerminationReason);
        Assert.False(instance.TerminationTokenWasCancelable);
        Assert.Equal(1, instance.TerminationCount);
        Assert.Equal(1, instance.DisposeCount);
    }

    private static async ValueTask<WorkerFixture> CreateFixtureAsync(
        TestInstance instance,
        MutableTimeProvider clock,
        CallbackRevisionGate revisionGate)
    {
        byte[] archive = "archive"u8.ToArray();
        byte[] module = "wasm-module"u8.ToArray();
        string moduleDigest = Convert.ToHexStringLower(SHA256.HashData(module));
        ImmutableArray<AuthoringPackageEntry> entries =
        [
            new AuthoringPackageEntry("worker/main.wasm", ImmutableArray.Create(module), moduleDigest)
        ];
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest() with
        {
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Contributions =
            [
                AuthoringExtensionContractsTests.CreateManifest().Contributions[0] with
                {
                    Entrypoint = new AuthoringEntrypointIdentity(
                        AuthoringEntrypointFormat.WasmModule,
                        "worker/main.wasm",
                        moduleDigest)
                }
            ]
        };
        ImmutableArray<byte> manifestBytes = ImmutableArray.Create(JsonSerializer.SerializeToUtf8Bytes(manifest));
        DateTimeOffset now = clock.GetUtcNow();
        var verifier = new AuthoringPackageVerifier(
            new TrustVerifier(now),
            new ArchiveReader(new AuthoringPackageArchiveContents(manifestBytes, entries)),
            clock);
        var artifact = new AuthoringPackageArtifact(
            ImmutableArray.Create(archive),
            [1],
            "acme",
            "key-1",
            "approved-source/catalog-1",
            "provenance/build-1",
            Convert.ToHexStringLower(SHA256.HashData(archive)));
        VerifiedAuthoringPackage package = await verifier.VerifyAsync(artifact, AuthoringHostPlatform.ServerLinux);
        AuthoringContributionDeclaration contribution = package.Contract.Manifest.Contributions[0];
        var target = new AuthoringExecutionTarget(
            AuthoringExecutionResolutionStatus.Ready,
            AuthoringExecutionClass.IsolatedWorkerWasm,
            manifest.Id,
            manifest.Version,
            manifest.PackageSha256,
            contribution.Id,
            contribution.Kind,
            contribution.Entrypoint.PathOrAdapterId,
            null,
            new string('d', 64),
            null);
        var request = new AuthoringWorkerRequest(
            1,
            target.RuntimeIdentity,
            target.ExtensionId,
            target.ExtensionVersion,
            target.PackageSha256,
            target.ContributionId,
            "document-1",
            1,
            2,
            "request-1",
            "schema/request-v1",
            "schema/result-v1",
            new string('e', 64),
            now.AddSeconds(5),
            [1, 2, 3]);
        var lifecycleResources = new AuthoringExtensionLifecycleResources(new LifecycleHostResources());
        await lifecycleResources.ActivateAtomicallyAsync(package, [target], 1, CancellationToken.None);
        var sandbox = new AuthoringExtensionWorkerSandbox(
            new TestRuntime(instance),
            revisionGate,
            lifecycleResources,
            clock);
        return new WorkerFixture(package, target, request, sandbox);
    }

    private static AuthoringWorkerCapabilityReport ClosedReport() => new(
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
        new string('f', 64));

    private sealed record WorkerFixture(
        VerifiedAuthoringPackage Package,
        AuthoringExecutionTarget Target,
        AuthoringWorkerRequest Request,
        AuthoringExtensionWorkerSandbox Sandbox);

    private sealed class TestRuntime(TestInstance instance) : IAuthoringWorkerSandboxRuntime
    {
        public ValueTask<IAuthoringWorkerSandboxInstance> StartAsync(
            AuthoringWorkerLaunchDescriptor descriptor,
            CancellationToken cancellationToken) => ValueTask.FromResult<IAuthoringWorkerSandboxInstance>(instance);
    }

    private sealed class LifecycleHostResources : IAuthoringLifecycleHostResourceAuthority
    {
        public ValueTask ActivateAtomicallyAsync(
            VerifiedAuthoringPackage package,
            ImmutableArray<AuthoringExecutionTarget> targets,
            CancellationToken cancellationToken) => ValueTask.CompletedTask;

        public ValueTask<AuthoringLifecycleHostResourceReport> RevokeAllAsync(
            string extensionId,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringLifecycleHostResourceReport(0, 0, 0, 0, 0));
    }

    private sealed class TestInstance : IAuthoringWorkerSandboxInstance
    {
        public AuthoringWorkerCapabilityReport CapabilityReport => ClosedReport();
        public Func<CancellationToken, ValueTask>? ResponseBoundary
        {
            get; init;
        }
        public Func<ValueTask>? Termination
        {
            get; init;
        }
        public string? TerminationReason
        {
            get; private set;
        }
        public bool TerminationTokenWasCancelable
        {
            get; private set;
        }
        public int TerminationCount
        {
            get; private set;
        }
        public int DisposeCount
        {
            get; private set;
        }

        public async ValueTask<AuthoringWorkerResponse> ExecuteAsync(
            AuthoringWorkerRequest request,
            CancellationToken cancellationToken)
        {
            if (ResponseBoundary is not null)
            {
                await ResponseBoundary(cancellationToken);
            }

            return new AuthoringWorkerResponse(
                request.SchemaVersion,
                request.RuntimeIdentity,
                request.RequestId,
                request.ResultSchemaReference,
                [4, 5, 6]);
        }

        public async ValueTask TerminateAsync(string reason, CancellationToken cancellationToken)
        {
            TerminationCount++;
            TerminationReason = reason;
            TerminationTokenWasCancelable = cancellationToken.CanBeCanceled;
            if (Termination is not null)
            {
                await Termination();
            }
        }

        public ValueTask DisposeAsync()
        {
            DisposeCount++;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class CallbackRevisionGate(Func<CancellationToken, ValueTask<bool>> callback)
        : IAuthoringDocumentRevisionGate
    {
        public int CallCount
        {
            get; private set;
        }

        public ValueTask<bool> IsCurrentAsync(
            string documentId,
            long documentEpoch,
            long sourceRevision,
            CancellationToken cancellationToken)
        {
            CallCount++;
            return callback(cancellationToken);
        }
    }

    private sealed class TrustVerifier(DateTimeOffset now) : IAuthoringPackageTrustVerifier
    {
        public ValueTask<AuthoringPackageTrustDecision> VerifyAsync(
            string publisher,
            string keyId,
            ReadOnlyMemory<byte> archive,
            ReadOnlyMemory<byte> signature,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringPackageTrustDecision(
                AuthoringPackageTrustStatus.Trusted,
                publisher,
                keyId,
                now,
                now.AddMinutes(5),
                new string('d', 64)));
    }

    private sealed class ArchiveReader(AuthoringPackageArchiveContents contents) : IAuthoringPackageArchiveReader
    {
        public ValueTask<AuthoringPackageArchiveContents> ReadAsync(
            ReadOnlyMemory<byte> canonicalArchive,
            CancellationToken cancellationToken) => ValueTask.FromResult(contents);
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = now;

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }
}
