using System.Collections.Immutable;
using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionServiceBrokerTests
{
    [Fact]
    public async Task ExecuteAsync_OwnedReadyProcess_Completes()
    {
        ServiceFixture fixture = await CreateFixtureAsync();

        AuthoringServiceExecutionResult result = await fixture.Broker.ExecuteAsync(
            fixture.Package,
            fixture.Target,
            fixture.Request,
            1);

        Assert.Equal(AuthoringServiceResultStatus.Completed, result.Status);
        Assert.Equal([4, 5], result.Response?.Payload);
    }

    [Fact]
    public async Task ExecuteAsync_DetachedOrUncontainedProcess_FailsAndTerminatesTree()
    {
        var process = new TestProcess
        {
            OwnershipValue = new AuthoringProcessOwnershipReport(
                AuthoringProcessOwnershipMechanism.PosixProcessGroup,
                false,
                false,
                "group-1")
        };
        ServiceFixture fixture = await CreateFixtureAsync(process);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Broker.ExecuteAsync(fixture.Package, fixture.Target, fixture.Request, 1));
        Assert.Equal("process-ownership-rejected", process.TerminationReason);
    }

    [Fact]
    public async Task ExecuteAsync_ProcessAliveWithoutProtocolReadiness_IsRejected()
    {
        var process = new TestProcess { Ready = false };
        ServiceFixture fixture = await CreateFixtureAsync(process);

        AuthoringServiceExecutionResult result = await fixture.Broker.ExecuteAsync(
            fixture.Package,
            fixture.Target,
            fixture.Request,
            1);

        Assert.Equal(AuthoringServiceResultStatus.Rejected, result.Status);
        Assert.Equal("readiness-rejected", process.TerminationReason);
    }

    [Fact]
    public async Task ExecuteAsync_TimeoutTerminatesWholeTree()
    {
        var process = new TestProcess { NeverComplete = true };
        ServiceFixture fixture = await CreateFixtureAsync(process);

        AuthoringServiceExecutionResult result = await fixture.Broker.ExecuteAsync(
            fixture.Package,
            fixture.Target,
            fixture.Request with
            {
                Deadline = DateTimeOffset.UtcNow.AddMilliseconds(10)
            },
            1);

        Assert.Equal(AuthoringServiceResultStatus.TimedOut, result.Status);
        Assert.Equal("cancelled-or-timeout", process.TerminationReason);
    }

    [Fact]
    public async Task ExecuteAsync_StaleResultTerminatesAndCannotCommit()
    {
        var process = new TestProcess();
        ServiceFixture fixture = await CreateFixtureAsync(process, currentRevision: false);

        AuthoringServiceExecutionResult result = await fixture.Broker.ExecuteAsync(
            fixture.Package,
            fixture.Target,
            fixture.Request,
            1);

        Assert.Equal(AuthoringServiceResultStatus.Stale, result.Status);
        Assert.Null(result.Response);
        Assert.Equal("stale-document", process.TerminationReason);
    }

    [Theory]
    [InlineData(false, -1, AuthoringServiceResultStatus.Completed)]
    [InlineData(false, 0, AuthoringServiceResultStatus.TimedOut)]
    [InlineData(false, 1, AuthoringServiceResultStatus.TimedOut)]
    [InlineData(true, -1, AuthoringServiceResultStatus.Completed)]
    [InlineData(true, 0, AuthoringServiceResultStatus.TimedOut)]
    [InlineData(true, 1, AuthoringServiceResultStatus.TimedOut)]
    public async Task ExecuteAsync_ReturnBoundaryDeadline_IsExclusive(
        bool advanceAtRevisionGate,
        long deadlineOffsetTicks,
        AuthoringServiceResultStatus expectedStatus)
    {
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        DateTimeOffset boundary = default;
        Action advance = () => clock.UtcNow = boundary.AddTicks(deadlineOffsetTicks);
        var process = new TestProcess { ResponseBoundary = advanceAtRevisionGate ? null : advance };
        var gate = new CallbackRevisionGate(_ =>
        {
            if (advanceAtRevisionGate)
            {
                advance();
            }
        });
        ServiceFixture fixture = await CreateFixtureAsync(process, brokerTimeProvider: clock, revisionGate: gate);
        boundary = fixture.Request.Deadline;
        clock.UtcNow = boundary.AddSeconds(-1);

        AuthoringServiceExecutionResult result = await fixture.Broker.ExecuteAsync(
            fixture.Package, fixture.Target, fixture.Request, 1);

        Assert.Equal(expectedStatus, result.Status);
        if (expectedStatus == AuthoringServiceResultStatus.Completed)
        {
            Assert.Equal([4, 5], result.Response?.Payload);
            Assert.Null(process.TerminationReason);
        }
        else
        {
            Assert.Null(result.Response);
            Assert.Equal("cancelled-or-timeout", process.TerminationReason);
            Assert.False(process.TerminationTokenWasCancelable);
        }

        Assert.Equal(!advanceAtRevisionGate && deadlineOffsetTicks >= 0 ? 0 : 1, gate.CallCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecuteAsync_NonCooperativeReturnAfterCallerCancellation_CannotComplete(bool cancelAtRevisionGate)
    {
        using var cancellation = new CancellationTokenSource();
        var process = new TestProcess { ResponseBoundary = cancelAtRevisionGate ? null : cancellation.Cancel };
        var gate = new CallbackRevisionGate(_ =>
        {
            if (cancelAtRevisionGate)
            {
                cancellation.Cancel();
            }
        });
        ServiceFixture fixture = await CreateFixtureAsync(process, revisionGate: gate);

        AuthoringServiceExecutionResult result = await fixture.Broker.ExecuteAsync(
            fixture.Package, fixture.Target, fixture.Request, 1, cancellation.Token);

        Assert.Equal(AuthoringServiceResultStatus.Cancelled, result.Status);
        Assert.Null(result.Response);
        Assert.Equal("cancelled-or-timeout", process.TerminationReason);
        Assert.False(process.TerminationTokenWasCancelable);
        Assert.Equal(cancelAtRevisionGate ? 1 : 0, gate.CallCount);
    }

    [Fact]
    public async Task ExecuteAsync_RevisionGateCancellation_AwaitsOwnedTermination()
    {
        using var cancellation = new CancellationTokenSource();
        var terminationStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var allowTermination = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var process = new TestProcess
        {
            Termination = async () =>
            {
                terminationStarted.SetResult(true);
                await allowTermination.Task;
            }
        };
        var gate = new CallbackRevisionGate(token =>
        {
            cancellation.Cancel();
            token.ThrowIfCancellationRequested();
        });
        ServiceFixture fixture = await CreateFixtureAsync(process, revisionGate: gate);

        Task<AuthoringServiceExecutionResult> execution = fixture.Broker.ExecuteAsync(
            fixture.Package, fixture.Target, fixture.Request, 1, cancellation.Token).AsTask();
        try
        {
            await terminationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(execution.IsCompleted);
            Assert.Equal(0, process.DisposeCount);
        }
        finally
        {
            allowTermination.TrySetResult(true);
        }

        AuthoringServiceExecutionResult result = await execution;

        Assert.Equal(AuthoringServiceResultStatus.Cancelled, result.Status);
        Assert.Null(result.Response);
        Assert.Equal("cancelled-or-timeout", process.TerminationReason);
        Assert.False(process.TerminationTokenWasCancelable);
        Assert.Equal(1, process.DisposeCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecuteAsync_ExpiredReturnBoundary_AwaitsOwnedTermination(bool expireAtRevisionGate)
    {
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        DateTimeOffset boundary = default;
        Action expire = () => clock.UtcNow = boundary;
        var terminationStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var allowTermination = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var process = new TestProcess
        {
            ResponseBoundary = expireAtRevisionGate ? null : expire,
            Termination = async () =>
            {
                terminationStarted.SetResult(true);
                await allowTermination.Task;
            }
        };
        var gate = new CallbackRevisionGate(_ =>
        {
            if (expireAtRevisionGate)
            {
                expire();
            }
        });
        ServiceFixture fixture = await CreateFixtureAsync(process, brokerTimeProvider: clock, revisionGate: gate);
        boundary = fixture.Request.Deadline;
        clock.UtcNow = boundary.AddSeconds(-1);

        Task<AuthoringServiceExecutionResult> execution = fixture.Broker.ExecuteAsync(
            fixture.Package, fixture.Target, fixture.Request, 1).AsTask();
        try
        {
            await terminationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(execution.IsCompleted);
            Assert.Equal(0, process.DisposeCount);
        }
        finally
        {
            allowTermination.TrySetResult(true);
        }

        AuthoringServiceExecutionResult result = await execution;
        Assert.Equal(AuthoringServiceResultStatus.TimedOut, result.Status);
        Assert.Null(result.Response);
        Assert.Equal("cancelled-or-timeout", process.TerminationReason);
        Assert.False(process.TerminationTokenWasCancelable);
        Assert.Equal(1, process.DisposeCount);
    }

    [Fact]
    public async Task ExecuteAsync_TargetOrClosedRequestDrift_FailsBeforeProcessStart()
    {
        ServiceFixture fixture = await CreateFixtureAsync();

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Broker.ExecuteAsync(
                fixture.Package,
                fixture.Target with
                {
                    ExtensionVersion = "9.9.9"
                },
                fixture.Request,
                1));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Broker.ExecuteAsync(
                fixture.Package,
                fixture.Target,
                fixture.Request with
                {
                    DocumentId = "document\n2"
                },
                1));
    }

    [Theory]
    [InlineData("localhost")]
    [InlineData("127.0.0.1")]
    [InlineData("https://example.com/path")]
    [InlineData("169.254.169.254")]
    public async Task ValidateNetworkAsync_GenericOrPrivateDestination_FailsClosed(string host)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var validator = new AuthoringServiceGrantValidator(
            new AddressResolver([IPAddress.Loopback]),
            new PathVerifier(false),
            new FixedTimeProvider(now),
            ImmutableHashSet<string>.Empty);
        var grant = new AuthoringNetworkGrant(
            new string('a', 64),
            new string('b', 64),
            host,
            443,
            "import",
            true,
            1024,
            now.AddMinutes(1));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await validator.ValidateNetworkAsync(grant, grant.RuntimeIdentity));
    }

    [Fact]
    public async Task ValidateNetworkAsync_DnsRebinding_FailsClosed()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var validator = new AuthoringServiceGrantValidator(
            new RebindingResolver(),
            new PathVerifier(false),
            new FixedTimeProvider(now),
            ImmutableHashSet<string>.Empty);
        var grant = new AuthoringNetworkGrant(
            new string('a', 64),
            new string('b', 64),
            "example.com",
            443,
            "export",
            true,
            1024,
            now.AddMinutes(1));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await validator.ValidateNetworkAsync(grant, grant.RuntimeIdentity));
    }

    [Theory]
    [InlineData("/home/user", "../secret")]
    [InlineData("/", "etc/passwd")]
    [InlineData("/owned", "/absolute/path")]
    public async Task ValidateFileAsync_ArbitraryOrEscapingPath_FailsClosed(string root, string relative)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var validator = new AuthoringServiceGrantValidator(
            new AddressResolver([IPAddress.Parse("93.184.216.34")]),
            new PathVerifier(false),
            new FixedTimeProvider(now),
            ImmutableHashSet<string>.Empty);
        var grant = new AuthoringFileGrant(
            new string('a', 64),
            new string('b', 64),
            root,
            relative,
            AuthoringFileGrantOperation.Read,
            "import",
            1024,
            now.AddMinutes(1));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await validator.ValidateFileAsync(grant, grant.RuntimeIdentity));
    }

    [Fact]
    public async Task ValidateFileAsync_UserProfileRootFailsClosedEvenWhenAllowlisted()
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        Assert.False(string.IsNullOrWhiteSpace(home));
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var validator = new AuthoringServiceGrantValidator(
            new AddressResolver([]),
            new PathVerifier(false),
            new FixedTimeProvider(now),
            ImmutableHashSet.Create(StringComparer.Ordinal, Path.TrimEndingDirectorySeparator(home)));
        var grant = new AuthoringFileGrant(
            new string('a', 64),
            new string('b', 64),
            home,
            "document.bin",
            AuthoringFileGrantOperation.Read,
            "import",
            1024,
            now.AddMinutes(1));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await validator.ValidateFileAsync(grant, grant.RuntimeIdentity));
    }

    [Fact]
    public async Task ValidateFileAsync_ReparseBoundary_FailsClosed()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var validator = new AuthoringServiceGrantValidator(
            new AddressResolver([IPAddress.Parse("93.184.216.34")]),
            new PathVerifier(true),
            new FixedTimeProvider(now),
            ImmutableHashSet.Create(StringComparer.Ordinal, "/owned"));
        var grant = new AuthoringFileGrant(
            new string('a', 64),
            new string('b', 64),
            "/owned",
            "file.txt",
            AuthoringFileGrantOperation.Read,
            "import",
            1024,
            now.AddMinutes(1));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await validator.ValidateFileAsync(grant, grant.RuntimeIdentity));
    }

    [Fact]
    public async Task IoBroker_NetworkGrantPinsValidatedAddressPurposeAndByteBound()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var validator = new AuthoringServiceGrantValidator(
            new AddressResolver([IPAddress.Parse("93.184.216.34")]),
            new PathVerifier(false),
            new FixedTimeProvider(now),
            ImmutableHashSet<string>.Empty);
        var transport = new NetworkTransport([7, 8, 9]);
        string staging = Path.Combine(Path.GetTempPath(), $"fsusblog-service-io-{Guid.NewGuid():N}");
        try
        {
            var broker = new AuthoringExtensionServiceIoBroker(validator, transport, staging);
            var grant = new AuthoringNetworkGrant(
                new string('a', 64),
                new string('b', 64),
                "example.com",
                443,
                "import",
                true,
                1024,
                now.AddMinutes(1));

            AuthoringServiceIoResult result = await broker.FetchAsync(
                grant,
                grant.RuntimeIdentity,
                "import",
                "/articles?page=1");

            Assert.Equal([7, 8, 9], result.Payload.ToArray());
            Assert.Equal("network-read", result.Receipt.Outcome);
            Assert.Equal([IPAddress.Parse("93.184.216.34")], transport.LastRequest?.Addresses.ToArray());
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await broker.FetchAsync(grant, grant.RuntimeIdentity, "export", "/articles"));
            Assert.Equal(1, transport.CallCount);
        }
        finally
        {
            if (Directory.Exists(staging))
            {
                Directory.Delete(staging, true);
            }
        }
    }

    [Fact]
    [SupportedOSPlatform("linux")]
    public async Task IoBroker_FileReadAndProposedWriteStayInsideExactOwnedRoots()
    {
        Assert.True(OperatingSystem.IsLinux(), "The production file path verifier is Linux-only.");
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string owned = Path.Combine(Path.GetTempPath(), $"fsusblog-service-owned-{Guid.NewGuid():N}");
        string staging = Path.Combine(Path.GetTempPath(), $"fsusblog-service-staging-{Guid.NewGuid():N}");
        Directory.CreateDirectory(owned);
        await File.WriteAllBytesAsync(Path.Combine(owned, "input.bin"), [1, 2, 3]);
        try
        {
            var validator = new AuthoringServiceGrantValidator(
                new AddressResolver([IPAddress.Parse("93.184.216.34")]),
                new LinuxAuthoringFilePathVerifier(),
                new FixedTimeProvider(now),
                ImmutableHashSet.Create(StringComparer.Ordinal, owned));
            var broker = new AuthoringExtensionServiceIoBroker(validator, new NetworkTransport([]), staging);
            string runtimeIdentity = new string('b', 64);
            var read = new AuthoringFileGrant(
                new string('a', 64),
                runtimeIdentity,
                owned,
                "input.bin",
                AuthoringFileGrantOperation.Read,
                "import",
                1024,
                now.AddMinutes(1));
            AuthoringServiceIoResult readResult = await broker.ReadFileAsync(read, runtimeIdentity, "import");
            Assert.Equal([1, 2, 3], readResult.Payload.ToArray());

            var write = read with
            {
                GrantId = new string('c', 64),
                RelativePath = "output.bin",
                Operation = AuthoringFileGrantOperation.ProposeWrite,
                Purpose = "export"
            };
            AuthoringServiceIoReceipt receipt = await broker.StageProposedWriteAsync(
                write,
                runtimeIdentity,
                "export",
                [4, 5, 6]);
            Assert.Equal("write-staged-for-host-approval", receipt.Outcome);
            Assert.False(File.Exists(Path.Combine(owned, "output.bin")));
            Assert.Single(Directory.EnumerateFiles(staging));
            await broker.RevokeStagedWriteAsync(receipt);
            Assert.Empty(Directory.EnumerateFiles(staging));
        }
        finally
        {
            if (Directory.Exists(owned))
            {
                Directory.Delete(owned, true);
            }

            if (Directory.Exists(staging))
            {
                Directory.Delete(staging, true);
            }
        }
    }

    [Fact]
    [SupportedOSPlatform("linux")]
    public async Task IoBroker_ExistingProposalCollisionPreservesOriginalArtifactAndReceipt()
    {
        Assert.True(OperatingSystem.IsLinux(), "The production file path verifier is Linux-only.");
        using var directory = new IoStageDirectory();
        DateTimeOffset now = DateTimeOffset.UtcNow;
        AuthoringFileGrant grant = directory.CreateGrant(now);
        var validator = new AuthoringServiceGrantValidator(
            new AddressResolver([]),
            new LinuxAuthoringFilePathVerifier(),
            new FixedTimeProvider(now),
            ImmutableHashSet.Create(StringComparer.Ordinal, directory.Owned));
        var broker = new AuthoringExtensionServiceIoBroker(validator, new NetworkTransport([]), directory.Staging);
        ImmutableArray<byte> payload = [4, 5, 6];
        AuthoringServiceIoReceipt original = await broker.StageProposedWriteAsync(
            grant, grant.RuntimeIdentity, grant.Purpose, payload);
        string artifactPath = Path.Combine(directory.Staging, original.ArtifactReference!);
        Assert.Equal(payload.ToArray(), await File.ReadAllBytesAsync(artifactPath));

        await Assert.ThrowsAsync<IOException>(async () =>
            await broker.StageProposedWriteAsync(grant, grant.RuntimeIdentity, grant.Purpose, payload));

        Assert.Equal(payload.ToArray(), await File.ReadAllBytesAsync(artifactPath));
        Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(payload.AsSpan())), original.ContentSha256);
        Assert.Equal("write-staged-for-host-approval", original.Outcome);
        Assert.Single(Directory.EnumerateFiles(directory.Staging));
        Assert.False(File.Exists(Path.Combine(directory.Owned, grant.RelativePath)));
        await broker.RevokeStagedWriteAsync(original);
        Assert.Empty(Directory.EnumerateFiles(directory.Staging));
    }

    [Fact]
    [SupportedOSPlatform("linux")]
    public async Task IoBroker_CancelledOwnedWriteIsReleasedAndRemovedWithoutTargetWrite()
    {
        Assert.True(OperatingSystem.IsLinux(), "The production file path verifier is Linux-only.");
        using var directory = new IoStageDirectory();
        using var cancellation = new CancellationTokenSource();
        DateTimeOffset now = DateTimeOffset.UtcNow;
        AuthoringFileGrant grant = directory.CreateGrant(now);
        var validator = new AuthoringServiceGrantValidator(
            new AddressResolver([]),
            new CancelAfterPathResolutionVerifier(cancellation),
            new FixedTimeProvider(now),
            ImmutableHashSet.Create(StringComparer.Ordinal, directory.Owned));
        var broker = new AuthoringExtensionServiceIoBroker(validator, new NetworkTransport([]), directory.Staging);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await broker.StageProposedWriteAsync(
                grant, grant.RuntimeIdentity, grant.Purpose, [4, 5, 6], cancellation.Token));

        Assert.True(cancellation.IsCancellationRequested);
        Assert.Empty(Directory.EnumerateFiles(directory.Staging));
        Assert.False(File.Exists(Path.Combine(directory.Owned, grant.RelativePath)));
    }

    [Fact]
    public async Task IoStage_PermissionFailureCleansOnlySuccessfullyCreatedFileAndKeepsFirstCause()
    {
        using var directory = new IoStageDirectory();
        string path = Path.Combine(directory.Staging, "permission-failure");
        var first = new IOException("injected stage permission failure");

        IOException observed = await Assert.ThrowsAsync<IOException>(async () =>
            await AuthoringExtensionServiceIoBroker.WriteOwnedProposalAsync(
                path,
                new byte[] { 4, 5, 6 },
                created =>
                {
                    Assert.Equal(new byte[] { 4, 5, 6 }, File.ReadAllBytes(created));
                    throw first;
                },
                File.Delete,
                default));

        Assert.Same(first, observed);
        Assert.False(File.Exists(path));
        Assert.False(observed.Data.Contains(AuthoringExtensionServiceIoBroker.StagedWriteCleanupFailuresKey));
    }

    [Fact]
    public async Task IoStage_CreateNewFailureNeverInvokesPermissionsOrDeletesPreexistingFile()
    {
        using var directory = new IoStageDirectory();
        string path = Path.Combine(directory.Staging, "existing-proposal");
        byte[] original = [7, 8, 9];
        await File.WriteAllBytesAsync(path, original);
        int permissionCalls = 0;
        int deleteCalls = 0;

        await Assert.ThrowsAsync<IOException>(async () =>
            await AuthoringExtensionServiceIoBroker.WriteOwnedProposalAsync(
                path,
                new byte[] { 4, 5, 6 },
                _ => permissionCalls++,
                _ => deleteCalls++,
                default));

        Assert.Equal(0, permissionCalls);
        Assert.Equal(0, deleteCalls);
        Assert.Equal(original, await File.ReadAllBytesAsync(path));
    }

    [Fact]
    public async Task IoStage_CancelledWriteKeepsPrimaryFailureAndRecordsCleanupFailureAfterRelease()
    {
        using var directory = new IoStageDirectory();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        string path = Path.Combine(directory.Staging, "cancelled-owned-proposal");
        var cleanupFailure = new IOException("injected stage delete failure");
        int permissionCalls = 0;
        OperationCanceledException observed = await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await AuthoringExtensionServiceIoBroker.WriteOwnedProposalAsync(
                path,
                new byte[] { 4, 5, 6 },
                _ => permissionCalls++,
                created =>
                {
                    using var released = new FileStream(created, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    throw cleanupFailure;
                },
                cancellation.Token));

        Assert.Equal(cancellation.Token, observed.CancellationToken);
        Assert.Equal(0, permissionCalls);
        Assert.True(File.Exists(path));
        ImmutableArray<Exception> secondary = Assert.IsType<ImmutableArray<Exception>>(
            observed.Data[AuthoringExtensionServiceIoBroker.StagedWriteCleanupFailuresKey]);
        Assert.Same(cleanupFailure, Assert.Single(secondary));
    }

    [Fact]
    [SupportedOSPlatform("linux")]
    public async Task LinuxPathVerifier_RejectsBenignSymlinkBoundary()
    {
        Assert.True(OperatingSystem.IsLinux(), "The production file path verifier is Linux-only.");
        DateTimeOffset now = DateTimeOffset.UtcNow;
        string owned = Path.Combine(Path.GetTempPath(), $"fsusblog-service-root-{Guid.NewGuid():N}");
        string outside = Path.Combine(Path.GetTempPath(), $"fsusblog-service-outside-{Guid.NewGuid():N}");
        Directory.CreateDirectory(owned);
        Directory.CreateDirectory(outside);
        Directory.CreateSymbolicLink(Path.Combine(owned, "linked"), outside);
        try
        {
            var validator = new AuthoringServiceGrantValidator(
                new AddressResolver([IPAddress.Parse("93.184.216.34")]),
                new LinuxAuthoringFilePathVerifier(),
                new FixedTimeProvider(now),
                ImmutableHashSet.Create(StringComparer.Ordinal, owned));
            var grant = new AuthoringFileGrant(
                new string('a', 64),
                new string('b', 64),
                owned,
                "linked/file.bin",
                AuthoringFileGrantOperation.Read,
                "import",
                1024,
                now.AddMinutes(1));

            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await validator.ValidateFileAsync(grant, grant.RuntimeIdentity));
        }
        finally
        {
            Directory.Delete(owned, true);
            Directory.Delete(outside, true);
        }
    }

    [Fact]
    public void BrokerSource_DoesNotExposeShellDirectIoOrSecretArguments()
    {
        Type[] brokerTypes =
        [
            typeof(AuthoringProcessOwnershipMechanism),
            typeof(AuthoringServiceResultStatus),
            typeof(AuthoringFileGrantOperation),
            typeof(AuthoringProcessOwnershipReport),
            typeof(AuthoringServiceHealthReport),
            typeof(AuthoringNetworkGrant),
            typeof(AuthoringFileGrant),
            typeof(AuthoringServiceLaunchDescriptor),
            typeof(AuthoringServiceRequest),
            typeof(AuthoringServiceResponse),
            typeof(AuthoringServiceExecutionResult),
            typeof(IAuthoringServiceProcess),
            typeof(IAuthoringOwnedServiceProcessObservation),
            typeof(IAuthoringServiceProcessRuntime),
            typeof(IAuthoringNetworkAddressResolver),
            typeof(IAuthoringFilePathVerifier),
            typeof(AuthoringServiceGrantValidator),
            typeof(AuthoringExtensionServiceBroker)
        ];
        Assert.All(brokerTypes, AssertNoBrokerSurface);
    }

    private static void AssertNoBrokerSurface(Type rootType)
    {
        foreach (Type type in EnumerateBrokerTypeTree(rootType))
        {
            AssertNoCompiledBrokerSurface(type);
        }
    }

    private static void AssertNoCompiledBrokerSurface(Type type)
    {
        string compiled = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(type),
            RuntimeMetadataInspection.DescribeConstructors(type));
        Assert.DoesNotContain("Process.Start", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("HttpClient", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("File.Open", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("IServiceProvider", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("EnvironmentVariables", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Arguments", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Password", compiled, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("AccessToken", compiled, StringComparison.OrdinalIgnoreCase);
    }

    private static IEnumerable<Type> EnumerateBrokerTypeTree(Type type)
    {
        yield return type;
        foreach (Type nested in type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
        {
            foreach (Type descendant in EnumerateBrokerTypeTree(nested))
            {
                yield return descendant;
            }
        }
    }

    [Theory]
    [InlineData(typeof(ProcessBoundaryFixture), "Process.Start", StringComparison.Ordinal)]
    [InlineData(typeof(NetworkBoundaryFixture), "HttpClient", StringComparison.Ordinal)]
    [InlineData(typeof(FileBoundaryFixture), "File.Open", StringComparison.Ordinal)]
    [InlineData(typeof(ServiceBoundaryFixture), "IServiceProvider", StringComparison.Ordinal)]
    [InlineData(typeof(EnvironmentBoundaryFixture), "EnvironmentVariables", StringComparison.Ordinal)]
    [InlineData(typeof(CommandBoundaryFixture), "Arguments", StringComparison.Ordinal)]
    [InlineData(typeof(CredentialBoundaryFixture), "Password", StringComparison.OrdinalIgnoreCase)]
    [InlineData(typeof(SessionBoundaryFixture), "AccessToken", StringComparison.OrdinalIgnoreCase)]
    public void BrokerBoundary_RejectsUncalledNestedMemberReferences(
        Type rootType,
        string forbiddenFact,
        StringComparison comparison)
    {
        Type nested = rootType.GetNestedType("Node", BindingFlags.NonPublic)!;
        Assert.NotNull(nested);
        Assert.Contains(nested, EnumerateBrokerTypeTree(rootType));
        MethodInfo method = nested.GetMethod("Read")!;
        Assert.Equal(nested, method.DeclaringType);
        Assert.NotNull(method.GetMethodBody());
        string oldRoots = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(rootType),
            RuntimeMetadataInspection.DescribeConstructors(rootType));
        Assert.DoesNotContain(forbiddenFact, oldRoots, comparison);
        AssertNoCompiledBrokerSurface(rootType);
        string nestedBody = RuntimeMetadataInspection.DescribeMethods(nested, "Read");
        Assert.Contains(forbiddenFact, nestedBody, comparison);

        Xunit.Sdk.XunitException rejection = Assert.ThrowsAny<Xunit.Sdk.XunitException>(
            () => AssertNoBrokerSurface(rootType));

        Assert.Contains(forbiddenFact, rejection.Message, comparison);
    }

    [Fact]
    public void BrokerBoundary_AcceptsBenignNestedMethodsAndConstructors()
    {
        Type rootType = typeof(BenignBrokerFixture);
        Type nested = rootType.GetNestedType("Node", BindingFlags.NonPublic)!;
        Assert.NotNull(nested);
        Type descendant = nested.GetNestedType("Leaf", BindingFlags.NonPublic)!;
        Assert.NotNull(descendant);
        Assert.Equal(3, EnumerateBrokerTypeTree(rootType).Count());
        Assert.Contains(descendant, EnumerateBrokerTypeTree(rootType));
        string oldRoots = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(rootType),
            RuntimeMetadataInspection.DescribeConstructors(rootType));
        Assert.Contains("closed-instance-body", oldRoots, StringComparison.Ordinal);
        Assert.Contains("closed-static-body", oldRoots, StringComparison.Ordinal);
        Assert.DoesNotContain("closed-nested-body", oldRoots, StringComparison.Ordinal);
        Assert.DoesNotContain("closed-descendant-body", oldRoots, StringComparison.Ordinal);
        Assert.Contains("closed-nested-body",
            RuntimeMetadataInspection.DescribeMethods(nested, "Read"), StringComparison.Ordinal);
        Assert.Contains("closed-descendant-body",
            RuntimeMetadataInspection.DescribeMethods(descendant, "Read"), StringComparison.Ordinal);

        AssertNoBrokerSurface(rootType);
    }

    private sealed class ProcessBoundaryFixture
    {
        private static class Node
        {
            public static object? Read() => Process.Start("fixture");
        }
    }

    private sealed class NetworkBoundaryFixture
    {
        private static class Node
        {
            public static object Read() => new System.Net.Http.HttpClient();
        }
    }

    private sealed class FileBoundaryFixture
    {
        private static class Node
        {
            public static object Read() => File.Open("fixture", FileMode.Open);
        }
    }

    private sealed class ServiceBoundaryFixture
    {
        private static class Node
        {
            public static object Read(IServiceProvider value) => value;
        }
    }

    private sealed class EnvironmentBoundaryFixture
    {
        private static class Node
        {
            public static object Read() => new ProcessStartInfo().EnvironmentVariables;
        }
    }

    private sealed class CommandBoundaryFixture
    {
        private static class Node
        {
            public static string Read() => new ProcessStartInfo().Arguments;
        }
    }

    private sealed class CredentialBoundaryFixture
    {
        private static class Node
        {
            public static string Read() => BrokerFixtureActions.ReadPassword();
        }
    }

    private sealed class SessionBoundaryFixture
    {
        private static class Node
        {
            public static string Read() => BrokerFixtureActions.ReadAccessToken();
        }
    }

    private static class BrokerFixtureActions
    {
        public static string ReadPassword() => "closed-credential";

        public static string ReadAccessToken() => "closed-session";
    }

    private sealed class BenignBrokerFixture
    {
        static BenignBrokerFixture() => GC.KeepAlive("closed-static-body");

        private BenignBrokerFixture() => GC.KeepAlive("closed-instance-body");

        private static class Node
        {
            public static string Read() => "closed-nested-body";

            private static class Leaf
            {
                public static string Read() => "closed-descendant-body";
            }
        }
    }

    [Fact]
    [SupportedOSPlatform("linux")]
    public async Task LinuxRuntime_OwnsObservedNamespaceSessionAndClosedTransport()
    {
        Assert.True(OperatingSystem.IsLinux(), "The production authoring service profile is Linux-only.");
        (byte[] executable, string compilationRoot) = await CompileStaticServiceFixtureAsync();
        string runtimeRoot = Path.Combine(Path.GetTempPath(), $"fsusblog-authoring-service-{Guid.NewGuid():N}");
        try
        {
            string executableDigest = Convert.ToHexStringLower(SHA256.HashData(executable));
            string grantId = new string('c', 64);
            string grantSetDigest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(grantId)));
            var descriptor = new AuthoringServiceLaunchDescriptor(
                new string('a', 64),
                "acme.author-tools",
                "1.0.0",
                new string('b', 64),
                new string('d', 64),
                "acme.import.run",
                executableDigest,
                [.. executable],
                [grantId],
                grantSetDigest,
                "authoring-service-transport/v1",
                67_108_864,
                32_768,
                32_768,
                TimeSpan.FromSeconds(5));
            var runtime = new LinuxBubblewrapAuthoringServiceRuntime(new LinuxBubblewrapServiceOptions(
                "/usr/bin/prlimit",
                "/usr/bin/bwrap",
                runtimeRoot,
                TimeSpan.FromSeconds(5)));

            await using IAuthoringServiceProcess process = await runtime.StartAsync(descriptor, CancellationToken.None);
            Assert.Equal(AuthoringProcessOwnershipMechanism.PosixProcessGroup, process.Ownership.Mechanism);
            Assert.True(process.Ownership.DescendantsContained);
            Assert.True(process.Ownership.DetachedChildrenPrevented);
            Assert.Equal(64, process.Ownership.IsolationIdentity.Length);
            AuthoringServiceHealthReport health = await process.GetHealthAsync(CancellationToken.None);
            Assert.True(health.ProtocolHandshakeComplete);
            Assert.Equal(descriptor.RuntimeIdentity, health.RuntimeIdentity);
            Assert.Equal(executableDigest, health.ExecutableSha256);

            var request = new AuthoringServiceRequest(
                1,
                descriptor.RuntimeIdentity,
                descriptor.ExtensionId,
                descriptor.Version,
                descriptor.PackageSha256,
                descriptor.ContributionId,
                "document-1",
                1,
                1,
                "request-1",
                DateTimeOffset.UtcNow.AddSeconds(5),
                descriptor.OpaqueGrantIds,
                [1, 2, 3, 4]);
            AuthoringServiceResponse response = await process.ExecuteAsync(request, CancellationToken.None);
            Assert.Equal(request.Payload.ToArray(), response.Payload.ToArray());
            Assert.Equal(request.RuntimeIdentity, response.RuntimeIdentity);

            var observed = Assert.IsAssignableFrom<IAuthoringOwnedServiceProcessObservation>(process);
            AuthoringServiceRequest detachedChildRequest = request with
            {
                RequestId = "request-detached-child",
                Payload = [.. Encoding.ASCII.GetBytes("DETACH_CHILD")]
            };
            await process.ExecuteAsync(detachedChildRequest, CancellationToken.None);
            int detachedChildProcessId = await WaitForSingleChildProcessAsync(observed.ProcessId);
            Assert.True(Directory.Exists($"/proc/{detachedChildProcessId}"));

            await process.TerminateTreeAsync("test-complete", CancellationToken.None);
            await WaitForProcessExitAsync(detachedChildProcessId);
            Assert.False(Directory.Exists($"/proc/{detachedChildProcessId}"));
            Assert.False((await process.GetHealthAsync(CancellationToken.None)).ProtocolHandshakeComplete);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await process.ExecuteAsync(request, CancellationToken.None));
        }
        finally
        {
            if (Directory.Exists(compilationRoot))
            {
                Directory.Delete(compilationRoot, true);
            }

            if (Directory.Exists(runtimeRoot))
            {
                Directory.Delete(runtimeRoot, true);
            }
        }
    }

    private static async ValueTask<(byte[] Executable, string Root)> CompileStaticServiceFixtureAsync()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-authoring-service-compile-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        string output = Path.Combine(root, "echo-service");
        string source = Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "tests/backend/Fixtures/AuthoringExtensions/echo-service.c");
        var start = new ProcessStartInfo("/usr/bin/cc")
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (string argument in new[] { "-static", "-O2", "-o", output, source })
        {
            start.ArgumentList.Add(argument);
        }

        using Process compiler = Process.Start(start) ?? throw new InvalidOperationException("C fixture compiler did not start.");
        await compiler.WaitForExitAsync();
        if (compiler.ExitCode != 0)
        {
            throw new InvalidOperationException($"C fixture compiler failed: {await compiler.StandardError.ReadToEndAsync()}");
        }

        return (await File.ReadAllBytesAsync(output), root);
    }

    private static async ValueTask<int> WaitForSingleChildProcessAsync(int parentProcessId)
    {
        for (int attempt = 0; attempt < 100; attempt++)
        {
            int[] children = Directory.EnumerateDirectories("/proc")
                .Select(static path => Path.GetFileName(path))
                .Where(static name => int.TryParse(name, out _))
                .Select(static name => int.Parse(name, System.Globalization.CultureInfo.InvariantCulture))
                .Where(processId => HasParentProcess(processId, parentProcessId))
                .ToArray();
            if (children.Length == 1)
            {
                return children[0];
            }
            await Task.Delay(10);
        }
        throw new Xunit.Sdk.XunitException("Detached child process was not observable through the real /proc tree.");
    }

    private static bool HasParentProcess(int processId, int expectedParentProcessId)
    {
        try
        {
            string? parentLine = File.ReadLines($"/proc/{processId}/status")
                .FirstOrDefault(static line => line.StartsWith("PPid:", StringComparison.Ordinal));
            return parentLine is not null &&
                int.TryParse(parentLine.AsSpan(5).Trim(), out int parentProcessId) &&
                parentProcessId == expectedParentProcessId;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static async ValueTask WaitForProcessExitAsync(int processId)
    {
        for (int attempt = 0; attempt < 100 && Directory.Exists($"/proc/{processId}"); attempt++)
        {
            await Task.Delay(10);
        }
    }

    private static async ValueTask<ServiceFixture> CreateFixtureAsync(
        TestProcess? process = null,
        bool currentRevision = true,
        TimeProvider? brokerTimeProvider = null,
        IAuthoringDocumentRevisionGate? revisionGate = null)
    {
        byte[] archive = "archive"u8.ToArray();
        byte[] executable = "service"u8.ToArray();
        string executableDigest = Convert.ToHexStringLower(SHA256.HashData(executable));
        ImmutableArray<AuthoringPackageEntry> entries =
        [
            new AuthoringPackageEntry("service/main", ImmutableArray.Create(executable), executableDigest)
        ];
        AuthoringContributionDeclaration contribution = AuthoringExtensionContractsTests.CreateManifest().Contributions[0] with
        {
            ExecutionClass = AuthoringExecutionClass.OutOfProcessService,
            Entrypoint = new AuthoringEntrypointIdentity(
                AuthoringEntrypointFormat.ServiceExecutable,
                "service/main",
                executableDigest)
        };
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest() with
        {
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Contributions = [contribution]
        };
        ImmutableArray<byte> manifestBytes = ImmutableArray.Create(JsonSerializer.SerializeToUtf8Bytes(manifest));
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var verifier = new AuthoringPackageVerifier(
            new TrustVerifier(now),
            new ArchiveReader(new AuthoringPackageArchiveContents(manifestBytes, entries)),
            new FixedTimeProvider(now));
        var artifact = new AuthoringPackageArtifact(
            ImmutableArray.Create(archive),
            [1],
            "acme",
            "key-1",
            "approved-source/catalog-1",
            "provenance/build-1",
            Convert.ToHexStringLower(SHA256.HashData(archive)));
        VerifiedAuthoringPackage package = await verifier.VerifyAsync(artifact, AuthoringHostPlatform.ServerLinux);
        var target = new AuthoringExecutionTarget(
            AuthoringExecutionResolutionStatus.Ready,
            AuthoringExecutionClass.OutOfProcessService,
            manifest.Id,
            manifest.Version,
            manifest.PackageSha256,
            contribution.Id,
            contribution.Kind,
            contribution.Entrypoint.PathOrAdapterId,
            null,
            new string('d', 64),
            null);
        var request = new AuthoringServiceRequest(
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
            now.AddSeconds(5),
            [new string('a', 64)],
            [1, 2, 3]);
        process ??= new TestProcess();
        process.RuntimeIdentity = target.RuntimeIdentity;
        process.ExecutableSha256 = executableDigest;
        var lifecycleResources = new AuthoringExtensionLifecycleResources(new LifecycleHostResources());
        await lifecycleResources.ActivateAtomicallyAsync(package, [target], 1, CancellationToken.None);
        var broker = new AuthoringExtensionServiceBroker(
            new TestRuntime(process),
            revisionGate ?? new RevisionGate(currentRevision),
            lifecycleResources,
            brokerTimeProvider ?? new FixedTimeProvider(now));
        return new ServiceFixture(package, target, request, broker);
    }

    private sealed record ServiceFixture(
        VerifiedAuthoringPackage Package,
        AuthoringExecutionTarget Target,
        AuthoringServiceRequest Request,
        AuthoringExtensionServiceBroker Broker);

    private sealed class TestRuntime(TestProcess process) : IAuthoringServiceProcessRuntime
    {
        public ValueTask<IAuthoringServiceProcess> StartAsync(
            AuthoringServiceLaunchDescriptor descriptor,
            CancellationToken cancellationToken) => ValueTask.FromResult<IAuthoringServiceProcess>(process);
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

    private sealed class TestProcess : IAuthoringServiceProcess
    {
        public AuthoringProcessOwnershipReport OwnershipValue
        {
            get; init;
        } = new(
            AuthoringProcessOwnershipMechanism.PosixProcessGroup,
            true,
            true,
            "group-1");

        public AuthoringProcessOwnershipReport Ownership => OwnershipValue;

        public bool Ready { get; init; } = true;

        public bool NeverComplete
        {
            get; init;
        }

        public string RuntimeIdentity { get; set; } = string.Empty;

        public string ExecutableSha256 { get; set; } = string.Empty;

        public Action? ResponseBoundary
        {
            get; init;
        }

        public Func<ValueTask>? Termination
        {
            get; init;
        }

        public bool TerminationTokenWasCancelable
        {
            get; private set;
        }

        public int DisposeCount
        {
            get; private set;
        }

        public string? TerminationReason
        {
            get; private set;
        }

        public ValueTask<AuthoringServiceHealthReport> GetHealthAsync(CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringServiceHealthReport(
                Ready,
                RuntimeIdentity,
                ExecutableSha256,
                "authoring-service-transport/v1"));

        public async ValueTask<AuthoringServiceResponse> ExecuteAsync(
            AuthoringServiceRequest request,
            CancellationToken cancellationToken)
        {
            if (NeverComplete)
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }

            ResponseBoundary?.Invoke();
            return new AuthoringServiceResponse(request.SchemaVersion, request.RuntimeIdentity, request.RequestId, [4, 5]);
        }

        public ValueTask TerminateTreeAsync(string reason, CancellationToken cancellationToken)
        {
            TerminationReason = reason;
            TerminationTokenWasCancelable = cancellationToken.CanBeCanceled;
            return Termination?.Invoke() ?? ValueTask.CompletedTask;
        }

        public ValueTask DisposeAsync()
        {
            DisposeCount++;
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

    private sealed class CallbackRevisionGate(Action<CancellationToken> callback) : IAuthoringDocumentRevisionGate
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
            callback(cancellationToken);
            return ValueTask.FromResult(true);
        }
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = now;

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }

    private sealed class AddressResolver(ImmutableArray<IPAddress> addresses) : IAuthoringNetworkAddressResolver
    {
        public ValueTask<ImmutableArray<IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken) =>
            ValueTask.FromResult(addresses);
    }

    private sealed class RebindingResolver : IAuthoringNetworkAddressResolver
    {
        private int _calls;

        public ValueTask<ImmutableArray<IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken) =>
            ValueTask.FromResult(++_calls == 1
                ? ImmutableArray.Create(IPAddress.Parse("93.184.216.34"))
                : ImmutableArray.Create(IPAddress.Loopback));
    }

    private sealed class NetworkTransport(ImmutableArray<byte> response) : IAuthoringPinnedNetworkTransport
    {
        public int CallCount
        {
            get; private set;
        }

        public AuthoringPinnedNetworkRequest? LastRequest
        {
            get; private set;
        }

        public ValueTask<AuthoringPinnedNetworkResponse> GetAsync(
            AuthoringPinnedNetworkRequest request,
            CancellationToken cancellationToken)
        {
            CallCount++;
            LastRequest = request;
            return ValueTask.FromResult(new AuthoringPinnedNetworkResponse(200, "application/octet-stream", response));
        }
    }

    private sealed class IoStageDirectory : IDisposable
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), $"fsusblog-io-stage-{Guid.NewGuid():N}");

        public IoStageDirectory()
        {
            Owned = Path.Combine(_root, "owned");
            Staging = Path.Combine(_root, "stage");
            Directory.CreateDirectory(Owned);
            Directory.CreateDirectory(Staging);
        }

        public string Owned
        {
            get;
        }

        public string Staging
        {
            get;
        }

        public AuthoringFileGrant CreateGrant(DateTimeOffset now) => new(
            new string('a', 64),
            new string('b', 64),
            Owned,
            "output.bin",
            AuthoringFileGrantOperation.ProposeWrite,
            "export",
            1024,
            now.AddMinutes(1));

        public void Dispose() => Directory.Delete(_root, true);
    }

    [SupportedOSPlatform("linux")]
    private sealed class CancelAfterPathResolutionVerifier(CancellationTokenSource cancellation) : IAuthoringFilePathVerifier
    {
        public async ValueTask<(string CanonicalPath, bool HasReparseBoundary)> ResolveAsync(
            string canonicalRoot,
            string relativePath,
            CancellationToken cancellationToken)
        {
            (string path, bool reparse) = await new LinuxAuthoringFilePathVerifier().ResolveAsync(
                canonicalRoot, relativePath, cancellationToken);
            cancellation.Cancel();
            return (path, reparse);
        }
    }

    private sealed class PathVerifier(bool reparse) : IAuthoringFilePathVerifier
    {
        public ValueTask<(string CanonicalPath, bool HasReparseBoundary)> ResolveAsync(
            string canonicalRoot,
            string relativePath,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult((Path.Combine(canonicalRoot, relativePath), reparse));
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

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
