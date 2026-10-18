using System.Collections.Immutable;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

using Xunit;

namespace FsusBlog.Server.Tests;

// SOURCE COMPONENT_SIMULATION: the public RPC handler calls the actual IO
// broker and its validator. Package trust, consent store, DNS and transport are
// explicit fixture owners, not production approval or physical qualification.
public sealed class AuthoringExtensionRpcBrokerTests
{
    [Fact]
    public async Task NetworkProposal_DelegatesOnceAndReturnsContentFreeContext()
    {
        using Fixture fixture = await CreateAsync();
        fixture.Network.OnFetch = async () =>
        {
            await Task.Yield();
            Assert.True(fixture.Store.Held);
            Assert.True(fixture.Active.Held);
            Assert.Throws<AuthoringExtensionContractException>(() => fixture.Store.Remove());
            Assert.Throws<AuthoringExtensionContractException>(() => fixture.Active.Active = false);
        };
        AuthoringRpcBrokerResult result = await fixture.ExecuteAsync();
        Assert.Equal("network-read", result.Receipt.IoReceipt.Outcome);
        Assert.Equal(fixture.Envelope.RequestId, result.Receipt.Context.RequestId);
        Assert.Equal(fixture.Envelope.GrantDigest, result.Receipt.IoReceipt.GrantId);
        Assert.Equal(new byte[] { 83, 69, 67, 82, 69, 84 }, result.Payload.ToArray());
        string metadata = JsonSerializer.Serialize(result.Receipt);
        Assert.DoesNotContain("SECRET", metadata);
        Assert.DoesNotContain("/private-query", metadata);
        Assert.Null(result.Receipt.Context.Payload.NetworkBroker);
        Assert.Null(result.Receipt.Context.Payload.FileBroker);
        Assert.Equal(1, fixture.Network.Calls);
        Assert.Equal(2, fixture.Store.Releases);
        Assert.False(fixture.Store.Held);
        Assert.Equal(0, fixture.Transaction.Calls);
        AuthoringExtensionRpcAuthority.ValidateBrokerResult(fixture.Envelope, result);
    }

    [Theory]
    [InlineData("context")]
    [InlineData("proposal")]
    [InlineData("value")]
    [InlineData("io")]
    [InlineData("digest")]
    public async Task BrokerResultTamper_IsRejectedBySameRequestBinding(string change)
    {
        using Fixture fixture = await CreateAsync();
        AuthoringRpcBrokerResult result = await fixture.ExecuteAsync();
        AuthoringRpcBrokerReceipt receipt = result.Receipt;
        result = change switch
        {
            "context" => result with { Receipt = receipt with { Context = receipt.Context with { SourceRevision = 99 } } },
            "proposal" => result with { Receipt = receipt with { ProposalDigest = new string('0', 64) } },
            "value" => result with { Payload = [1] },
            "io" => result with { Receipt = receipt with { IoReceipt = receipt.IoReceipt with { Purpose = "other" } } },
            "digest" => result with { Receipt = receipt with { ReceiptDigest = new string('0', 64) } },
            _ => throw new InvalidOperationException()
        };
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringExtensionRpcAuthority.ValidateBrokerResult(fixture.Envelope, result));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(3)]
    [InlineData(int.MaxValue)]
    public async Task BrokerVersion_IsExplicitAndNeverFallsBack(int version)
    {
        using Fixture fixture = await CreateAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.ExecuteAsync(fixture.Envelope with { SchemaVersion = version }));
        Assert.Equal(0, fixture.Network.Calls);
        _ = await fixture.ExecuteAsync();
        Assert.Equal(1, fixture.Network.Calls);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("mixed")]
    [InlineData("grant")]
    [InlineData("host")]
    [InlineData("port")]
    [InlineData("url")]
    [InlineData("site")]
    [InlineData("purpose")]
    [InlineData("runtime")]
    [InlineData("class")]
    [InlineData("epoch")]
    public async Task CallerProposals_CannotEnlargeOrReuseApprovedScope(string change)
    {
        using Fixture fixture = await CreateAsync();
        AuthoringRpcEnvelope envelope = fixture.Envelope;
        AuthoringNetworkBrokerProposal proposal = envelope.Payload.NetworkBroker!;
        envelope = change switch
        {
            "missing" => envelope with { Payload = envelope.Payload with { NetworkBroker = null } },
            "mixed" => envelope with { Payload = envelope.Payload with { QueryReference = "query" } },
            "grant" => envelope with { Payload = envelope.Payload with { BrokerGrantId = new string('f', 64) } },
            "host" => envelope with { Payload = envelope.Payload with { NetworkBroker = proposal with { Host = "other.example" } } },
            "port" => envelope with { Payload = envelope.Payload with { NetworkBroker = proposal with { Port = 8443 } } },
            "url" => envelope with { Payload = envelope.Payload with { NetworkBroker = proposal with { PathAndQuery = "https://example.org/" } } },
            "site" => envelope with { SiteIdentity = "other-site" },
            "purpose" => envelope with { Purpose = "other-purpose" },
            "runtime" => envelope with { RuntimeIdentity = new string('d', 64) },
            "class" => envelope with { ExecutionClass = AuthoringExecutionClass.TrustedHostAdapter },
            "epoch" => envelope with { DocumentEpoch = 0 },
            _ => throw new InvalidOperationException()
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await fixture.ExecuteAsync(envelope));
        Assert.Equal(0, fixture.Network.Calls);
        Assert.Equal(0, fixture.Transaction.Calls);
    }

    [Theory]
    [InlineData("grant")]
    [InlineData("package")]
    [InlineData("revision")]
    [InlineData("deadline")]
    [InlineData("after-deadline")]
    public async Task PostIoDrift_RefusesPublication(string drift)
    {
        using Fixture fixture = await CreateAsync();
        fixture.Network.OnFetch = async () =>
        {
            await Task.Yield();
            switch (drift)
            {
                case "grant":
                    fixture.Store.OnRelease = () => fixture.Store.Remove();
                    break;
                case "package":
                    fixture.Active.Active = false;
                    break;
                case "revision":
                    fixture.Revision.Current = false;
                    break;
                case "deadline":
                    fixture.Clock.Now = fixture.Envelope.Deadline;
                    break;
                case "after-deadline":
                    fixture.Clock.Now = fixture.Envelope.Deadline.AddTicks(1);
                    break;
            }
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await fixture.ExecuteAsync());
        Assert.Equal(1, fixture.Network.Calls);
        Assert.False(fixture.Store.Held);
        Assert.Equal(0, fixture.Transaction.Calls);
    }

    [Fact]
    public async Task CancellationAfterIo_CannotReturnOrLoseOriginalIoFailure()
    {
        using Fixture fixture = await CreateAsync();
        using var caller = new CancellationTokenSource();
        var primary = new OperationCanceledException(caller.Token);
        fixture.Network.OnFetch = () => throw primary;
        fixture.Store.ReleaseFailure = new IOException("scope release failed");
        OperationCanceledException actual = await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await fixture.ExecuteAsync(token: caller.Token));
        Assert.Same(primary, actual);
        Assert.Equal(caller.Token, actual.CancellationToken);
        Assert.NotNull(actual.Data["AuthoringTerminalReadScopeCleanupFailures"]);
        Assert.False(fixture.Store.Held);
    }

    [Fact]
    public async Task DuplicateRequest_CannotRepeatIo()
    {
        using Fixture fixture = await CreateAsync();
        _ = await fixture.ExecuteAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await fixture.ExecuteAsync());
        Assert.Equal(1, fixture.Network.Calls);
    }

    [Fact]
    public async Task CallerCancelledByIo_CannotPublishCompletedValue()
    {
        using Fixture fixture = await CreateAsync();
        using var caller = new CancellationTokenSource();
        fixture.Network.OnFetch = () =>
        {
            caller.Cancel();
            return ValueTask.CompletedTask;
        };
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await fixture.ExecuteAsync(token: caller.Token));
        Assert.Equal(1, fixture.Network.Calls);
        Assert.False(fixture.Store.Held);
    }

    [Fact]
    public async Task StoreWithoutOriginalBrokerScope_RefusesBeforeIo()
    {
        using Fixture fixture = await CreateAsync();
        var authority = new AuthoringExtensionRpcAuthority(new AuthoringCapabilityGrantAuthority(
            new UnscopedStore(fixture.Store), fixture.Clock), fixture.Transaction, fixture.Revision,
            fixture.Clock, fixture.Resolver, fixture.Broker);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await authority.ExecuteBrokerAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        Assert.Equal(0, fixture.Network.Calls);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task MissingActualResolverOrBroker_RefusesBeforeIo(bool missingResolver)
    {
        using Fixture fixture = await CreateAsync();
        var authority = new AuthoringExtensionRpcAuthority(new AuthoringCapabilityGrantAuthority(fixture.Store, fixture.Clock),
            fixture.Transaction, fixture.Revision, fixture.Clock, missingResolver ? null : fixture.Resolver,
            missingResolver ? fixture.Broker : null);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await authority.ExecuteBrokerAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        Assert.Equal(0, fixture.Network.Calls);
    }

    [Fact]
    public async Task PackageDeactivatedByLastAdmissionAwait_CannotStartIoOrConsumeId()
    {
        using Fixture fixture = await CreateAsync();
        fixture.Revision.OnCheck = () => fixture.Active.Active = false;
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await fixture.ExecuteAsync());
        Assert.Equal(0, fixture.Network.Calls);
        fixture.Active.Active = true;
        fixture.Revision.OnCheck = null;
        _ = await fixture.ExecuteAsync();
        Assert.Equal(1, fixture.Network.Calls);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task EntryReleaseFailure_SettlesActualPromiseAndPreservesIoFirstCause(bool ioFails)
    {
        using Fixture fixture = await CreateAsync();
        var cleanup = new IOException("original package release failed");
        var primary = new IOException("original IO failed");
        fixture.Active.ReleaseFailure = cleanup;
        fixture.Network.OnFetch = async () =>
        {
            await Task.Yield();
            if (ioFails)
            {
                throw primary;
            }
        };
        IOException actual = await Assert.ThrowsAsync<IOException>(async () => await fixture.ExecuteAsync());
        Assert.Same(ioFails ? primary : cleanup, actual);
        Assert.Equal(1, fixture.Network.Calls);
        Assert.False(fixture.Store.Held);
        if (ioFails)
        {
            Assert.Equal(true, actual.Data["AuthoringBrokerEntryScopeCleanupUnverified"]);
        }
        else
        {
            Assert.True(fixture.Network.Completed);
        }
    }

    [Fact]
    public async Task ChangedTypedScopeAfterIo_CannotPublishUnderUnchangedGenericGrant()
    {
        using Fixture fixture = await CreateAsync();
        fixture.Store.OnRelease = () => fixture.Store.Network = fixture.Store.Network! with { MaximumBytes = 128 };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await fixture.ExecuteAsync());
        Assert.Equal(1, fixture.Network.Calls);
    }

    [Fact]
    public async Task FileRead_UsesOriginalApprovedRootAndPath()
    {
        using Fixture fixture = await CreateAsync(AuthoringFileGrantOperation.Read);
        await File.WriteAllBytesAsync(Path.Combine(fixture.Root, "value.bin"), [1, 2, 3]);
        AuthoringRpcBrokerResult result = await fixture.ExecuteAsync();
        Assert.Equal(new byte[] { 1, 2, 3 }, result.Payload.ToArray());
        Assert.Equal("file-read", result.Receipt.IoReceipt.Outcome);
        Assert.Equal(0, fixture.Transaction.Calls);
        Assert.DoesNotContain(fixture.Root, JsonSerializer.Serialize(result.Receipt));
    }

    [Theory]
    [InlineData("path")]
    [InlineData("operation")]
    [InlineData("bytes")]
    public async Task FileProposal_CannotChangeApprovedOperationOrPath(string change)
    {
        using Fixture fixture = await CreateAsync(AuthoringFileGrantOperation.Read);
        AuthoringFileBrokerProposal proposal = fixture.Envelope.Payload.FileBroker!;
        proposal = change switch
        {
            "path" => proposal with { RelativePath = "other.bin" },
            "operation" => proposal with { Operation = (AuthoringFileGrantOperation)999 },
            "bytes" => proposal with { ProposedBytes = [1] },
            _ => throw new InvalidOperationException()
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await fixture.ExecuteAsync(
            fixture.Envelope with { Payload = fixture.Envelope.Payload with { FileBroker = proposal } }));
        Assert.Empty(Directory.EnumerateFiles(fixture.Staging));
        Assert.Equal(0, fixture.Transaction.Calls);
    }

    [Fact]
    public async Task ProposedWrite_CapturesOwnedBytesAndOnlyStages()
    {
        using Fixture fixture = await CreateAsync(AuthoringFileGrantOperation.ProposeWrite);
        byte[] mutable = [1, 2, 3];
        fixture.Store.OnFind = () => mutable[0] = 99;
        AuthoringRpcEnvelope envelope = fixture.Envelope with { Payload = fixture.Envelope.Payload with
        {
            FileBroker = fixture.Envelope.Payload.FileBroker! with
            {
                ProposedBytes = ImmutableCollectionsMarshal.AsImmutableArray(mutable)
            }
        } };
        AuthoringRpcBrokerResult result = await fixture.ExecuteAsync(envelope);
        Assert.Equal("write-staged-for-host-approval", result.Receipt.IoReceipt.Outcome);
        Assert.Empty(result.Payload);
        Assert.False(File.Exists(Path.Combine(fixture.Root, "value.bin")));
        Assert.Equal(new byte[] { 1, 2, 3 }, await File.ReadAllBytesAsync(
            Path.Combine(fixture.Staging, result.Receipt.IoReceipt.ArtifactReference!)));
        Assert.Equal(0, fixture.Transaction.Calls);
    }

    [Fact]
    public async Task StagedWrite_PostIoRefusalRevokesOriginalOwnedStage()
    {
        using Fixture fixture = await CreateAsync(AuthoringFileGrantOperation.ProposeWrite);
        fixture.Store.OnRelease = () => fixture.Active.Active = false;
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await fixture.ExecuteAsync());
        Assert.Empty(Directory.EnumerateFiles(fixture.Staging));
        Assert.False(File.Exists(Path.Combine(fixture.Root, "value.bin")));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task DeclaredRequestOrResponseBudget_IsNotAGrant(bool request)
    {
        using Fixture fixture = await CreateAsync(requestBytes: request ? 1 : 65536, responseBytes: request ? 65536 : 512);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await fixture.ExecuteAsync());
        Assert.Equal(request ? 0 : 1, fixture.Network.Calls);
        Assert.Equal(0, fixture.Transaction.Calls);
    }

    [Fact]
    public async Task DefaultSynchronousPackageScope_CannotCrossIoOrConsumeRequestId()
    {
        using Fixture fixture = await CreateAsync();
        fixture.Active.SynchronousOnly = true;
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await fixture.ExecuteAsync());
        Assert.Equal(0, fixture.Network.Calls);
        Assert.False(fixture.Active.Held);
        Assert.False(fixture.Store.Held);
        fixture.Active.SynchronousOnly = false;
        _ = await fixture.ExecuteAsync();
        Assert.Equal(1, fixture.Network.Calls);
    }

    [Theory]
    [InlineData("deadline")]
    [InlineData("after-deadline")]
    [InlineData("cancel")]
    [InlineData("revision")]
    [InlineData("grant")]
    public async Task IndependentPackagePreparation_RechecksAdmissionBeforeActualIo(string change)
    {
        using Fixture fixture = await CreateAsync();
        using var caller = new CancellationTokenSource();
        AuthoringCapabilityGrant originalGrant = Assert.IsType<AuthoringCapabilityGrant>(
            await fixture.Store.FindAsync(fixture.Envelope.GrantDigest, default));
        fixture.Active.OnPrepared = async () =>
        {
            await Task.Yield();
            Assert.True(fixture.Active.Held);
            Assert.False(fixture.Store.Held);
            switch (change)
            {
                case "deadline":
                    fixture.Clock.Now = fixture.Envelope.Deadline;
                    break;
                case "after-deadline":
                    fixture.Clock.Now = fixture.Envelope.Deadline.AddTicks(1);
                    break;
                case "cancel":
                    caller.Cancel();
                    break;
                case "revision":
                    fixture.Revision.Current = false;
                    break;
                case "grant":
                    fixture.Store.Remove();
                    break;
            }
        };
        if (change == "cancel")
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await fixture.ExecuteAsync(token: caller.Token));
        }
        else
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await fixture.ExecuteAsync());
        }
        Assert.Equal(0, fixture.Network.Calls);
        Assert.False(fixture.Active.Held);
        Assert.False(fixture.Store.Held);
        Assert.Equal(0, fixture.Transaction.Calls);
        fixture.Active.OnPrepared = null;
        fixture.Clock.Now = fixture.Envelope.Deadline.AddSeconds(-30);
        fixture.Revision.Current = true;
        if (change == "grant")
        {
            await fixture.Store.StoreAsync(originalGrant, default);
        }
        _ = await fixture.ExecuteAsync();
        Assert.Equal(1, fixture.Network.Calls);
    }

    [Fact]
    public async Task FinalPreparationDeadline_RefusesAlreadySettledValue()
    {
        using Fixture fixture = await CreateAsync();
        int preparations = 0;
        fixture.Active.OnPrepared = async () =>
        {
            await Task.Yield();
            if (++preparations == 2)
            {
                fixture.Clock.Now = fixture.Envelope.Deadline;
            }
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await fixture.ExecuteAsync());
        Assert.Equal(1, fixture.Network.Calls);
        Assert.True(fixture.Network.Completed);
        Assert.False(fixture.Active.Held);
        Assert.False(fixture.Store.Held);
    }

    private static async ValueTask<Fixture> CreateAsync(AuthoringFileGrantOperation? operation = null,
        int requestBytes = 65536, int responseBytes = 65536)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException("The production file path verifier is Linux-only.");
        }
        string taskRoot = Path.Combine(Path.GetTempPath(), "authoring-rpc-broker-" + Guid.NewGuid().ToString("N"));
        string root = Path.Combine(taskRoot, "approved");
        string staging = Path.Combine(taskRoot, "staging");
        Directory.CreateDirectory(root);
        var clock = new Clock();
        AuthoringCapability capability = operation switch
        {
            AuthoringFileGrantOperation.Read => AuthoringCapability.FileSystemRootRead,
            AuthoringFileGrantOperation.ProposeWrite => AuthoringCapability.FileSystemRootProposeWrite,
            _ => AuthoringCapability.NetworkDestination
        };
        ImmutableArray<byte> module = [1, 2, 3];
        ImmutableArray<AuthoringPackageEntry> entries = [new("worker/main.wasm", module,
            Convert.ToHexStringLower(SHA256.HashData(module.AsSpan())))];
        AuthoringExtensionManifest template = AuthoringExtensionContractsTests.CreateManifest();
        AuthoringExtensionManifest manifest = template with
        {
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Contributions = [template.Contributions[0] with
            {
                Entrypoint = template.Contributions[0].Entrypoint with { ContentSha256 = entries[0].ContentSha256 },
                Capabilities = [capability]
            }],
            Limits = template.Limits with { MaximumRequestBytes = requestBytes, MaximumResponseBytes = responseBytes,
                MaximumNetworkBytes = 65536, MaximumFileBytes = 65536 }
        };
        byte[] archive = "broker-component-archive"u8.ToArray();
        var verifier = new AuthoringPackageVerifier(new Trust(clock), new Archive(new(
            ImmutableArray.Create(JsonSerializer.SerializeToUtf8Bytes(manifest)), entries)), clock);
        VerifiedAuthoringPackage package = await verifier.VerifyAsync(new AuthoringPackageArtifact(
            ImmutableArray.Create(archive), [1], "acme", "key-1", "approved-source/catalog-1", "provenance/build-1",
            Convert.ToHexStringLower(SHA256.HashData(archive))), AuthoringHostPlatform.ServerLinux);
        var active = new ActivePackage(package);
        var absent = new NoAdapter();
        var resolver = new AuthoringExecutionResolver(new ClosedTrustedAuthoringAdapterRegistry([]), absent, absent, active);
        AuthoringExecutionTarget target = await resolver.ResolveAsync(package, manifest.Contributions[0].Id, AuthoringHostPlatform.ServerLinux);
        var store = new Store();
        var grants = new AuthoringCapabilityGrantAuthority(store, clock);
        AuthoringCapabilityGrant approved = await grants.IssueAsync(new AuthoringGrantRequest(
            "approved-request", target.RuntimeIdentity, manifest.Id, manifest.Version, manifest.Contributions[0].Id,
            AuthoringExecutionClass.IsolatedWorkerWasm, capability, "document-1", "site-1", "inspect-external-value",
            operation is null ? "approved-external-destination" : null, operation is null ? null : root,
            TimeSpan.FromMinutes(5), "fixture-explicit-consent"));
        if (operation is null)
        {
            store.Network = new(approved.GrantId, target.RuntimeIdentity, "example.org", 443, approved.Purpose, true, 65536, approved.ExpiresAt);
        }
        else
        {
            store.File = new(approved.GrantId, target.RuntimeIdentity, root, "value.bin", operation.Value, approved.Purpose, 65536, approved.ExpiresAt);
        }
        var network = new Network();
        var broker = new AuthoringExtensionServiceIoBroker(new AuthoringServiceGrantValidator(new Addresses(),
            new LinuxAuthoringFilePathVerifier(), clock, ImmutableHashSet.Create(StringComparer.Ordinal, root)), network, staging);
        var transaction = new NoTransaction();
        var revision = new Revision();
        var envelope = new AuthoringRpcEnvelope(2, operation is null ? AuthoringRpcMethod.NetworkBrokerRequest : AuthoringRpcMethod.FileBrokerRequest,
            target.RuntimeIdentity, manifest.Id, manifest.Version, manifest.PackageSha256, manifest.ContentSha256,
            manifest.Contributions[0].Id, AuthoringExecutionClass.IsolatedWorkerWasm, "rpc-request", "document-1", 1, 2,
            new string('c', 64), new string('d', 64), new string('e', 64), new string('f', 64), approved.GrantDigest,
            clock.Now.AddMinutes(1), new AuthoringRpcPayload(BrokerGrantId: approved.GrantId)
            {
                NetworkBroker = operation is null ? new("example.org", 443, "/private-query") : null,
                FileBroker = operation is null ? null : new("value.bin", operation.Value,
                    operation == AuthoringFileGrantOperation.ProposeWrite ? [1, 2, 3] : default)
            }) { SiteIdentity = approved.SiteIdentity, Purpose = approved.Purpose };
        return new(taskRoot, root, staging, package, envelope, store, active, clock, network, transaction, revision,
            resolver, broker, new(grants, transaction, revision, clock, resolver, broker));
    }

    private sealed record Fixture(string TaskRoot, string Root, string Staging, VerifiedAuthoringPackage Package,
        AuthoringRpcEnvelope Envelope, Store Store, ActivePackage Active, Clock Clock, Network Network,
        NoTransaction Transaction, Revision Revision, AuthoringExecutionResolver Resolver,
        AuthoringExtensionServiceIoBroker Broker, AuthoringExtensionRpcAuthority Authority) : IDisposable
    {
        internal ValueTask<AuthoringRpcBrokerResult> ExecuteAsync(AuthoringRpcEnvelope? envelope = null, CancellationToken token = default) =>
            Authority.ExecuteBrokerAsync(Package, AuthoringHostPlatform.ServerLinux, envelope ?? Envelope, token);
        public void Dispose() => Directory.Delete(TaskRoot, true);
    }

    private sealed class Store : IAuthoringCapabilityBrokerGrantReadScopeStore
    {
        private readonly object _gate = new();
        private AuthoringCapabilityGrant? _grant;
        private AuthoringNetworkGrant? _network;
        private AuthoringFileGrant? _file;
        internal AuthoringNetworkGrant? Network
        {
            get
            {
                lock (_gate)
                {
                    return _network;
                }
            }
            set
            {
                lock (_gate)
                {
                    if (Held)
                    {
                        throw new AuthoringExtensionContractException("Approved network scope is held.");
                    }
                    _network = value;
                }
            }
        }
        internal AuthoringFileGrant? File
        {
            get
            {
                lock (_gate)
                {
                    return _file;
                }
            }
            set
            {
                lock (_gate)
                {
                    if (Held)
                    {
                        throw new AuthoringExtensionContractException("Approved file scope is held.");
                    }
                    _file = value;
                }
            }
        }
        internal bool Held { get; private set; }
        internal int Releases { get; private set; }
        internal Action? OnFind { get; set; }
        internal Action? OnRelease { get; set; }
        internal Exception? ReleaseFailure { get; set; }
        public ValueTask<AuthoringCapabilityGrant?> FindAsync(string id, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            OnFind?.Invoke();
            lock (_gate)
            {
                return ValueTask.FromResult(_grant?.GrantId == id ? _grant : null);
            }
        }
        public ValueTask StoreAsync(AuthoringCapabilityGrant grant, CancellationToken token)
        {
            lock (_gate)
            {
                if (Held || _grant is not null)
                {
                    throw new AuthoringExtensionContractException("Original store is busy.");
                }
                _grant = grant;
            }
            return ValueTask.CompletedTask;
        }
        internal void Remove()
        {
            lock (_gate)
            {
                if (Held)
                {
                    throw new AuthoringExtensionContractException("Revocation conflicts with held original owner.");
                }
                _grant = null;
            }
        }
        public ValueTask RevokeAsync(string id, CancellationToken token)
        {
            Remove();
            return ValueTask.CompletedTask;
        }
        public IAuthoringCapabilityGrantReadScope AcquireReadScope(string id) => AcquireBrokerReadScope(id);
        public IAuthoringCapabilityBrokerGrantReadScope AcquireBrokerReadScope(string id)
        {
            lock (_gate)
            {
                if (Held || _grant is null || _grant.GrantId != id)
                {
                    throw new AuthoringExtensionContractException("No live approved scope.");
                }
                Held = true;
                return new Scope(this, _grant, Network, File);
            }
        }
        private sealed class Scope(Store owner, AuthoringCapabilityGrant grant, AuthoringNetworkGrant? network, AuthoringFileGrant? file)
            : IAuthoringCapabilityBrokerGrantReadScope
        {
            public AuthoringCapabilityGrant Grant => grant;
            public AuthoringNetworkGrant? NetworkGrant => network;
            public AuthoringFileGrant? FileGrant => file;
            private bool _released;
            public void Dispose()
            {
                lock (owner._gate)
                {
                    if (_released)
                    {
                        return;
                    }
                    _released = true;
                    owner.Held = false;
                    owner.Releases++;
                }
                owner.OnRelease?.Invoke();
                if (owner.ReleaseFailure is { } failure)
                {
                    throw failure;
                }
            }
        }
    }

    private sealed class UnscopedStore(Store store) : IAuthoringCapabilityGrantStore
    {
        public ValueTask<AuthoringCapabilityGrant?> FindAsync(string id, CancellationToken token) => store.FindAsync(id, token);
        public ValueTask StoreAsync(AuthoringCapabilityGrant grant, CancellationToken token) => store.StoreAsync(grant, token);
        public ValueTask RevokeAsync(string id, CancellationToken token) => store.RevokeAsync(id, token);
    }

    private sealed class ActivePackage(VerifiedAuthoringPackage package) : IAuthoringInstalledPackageReadScopeAuthority
    {
        private readonly object _gate = new();
        private bool _active = true;
        private bool _held;
        internal Exception? ReleaseFailure { get; set; }
        internal bool SynchronousOnly { get; set; }
        internal Func<ValueTask>? OnPrepared { get; set; }
        internal bool Held
        {
            get
            {
                lock (_gate)
                {
                    return _held;
                }
            }
        }
        internal bool Active
        {
            get
            {
                lock (_gate)
                {
                    return _active;
                }
            }
            set
            {
                lock (_gate)
                {
                    if (_held)
                    {
                        throw new AuthoringExtensionContractException("Package changes conflict with the original held owner.");
                    }
                    _active = value;
                }
            }
        }
        public ValueTask<bool> IsActiveExactAsync(VerifiedAuthoringPackage candidate, CancellationToken token) =>
            ValueTask.FromResult(Active && candidate.PackageIdentity == package.PackageIdentity);
        public IAuthoringInstalledPackageReadScope AcquireActiveReadScope(VerifiedAuthoringPackage candidate)
        {
            lock (_gate)
            {
                if (_held || !_active || candidate.PackageIdentity != package.PackageIdentity)
                {
                    throw new AuthoringExtensionContractException("Inactive or busy package.");
                }
                _held = true;
                var scope = new Scope(this, package);
                return SynchronousOnly ? new SynchronousScope(scope) : scope;
            }
        }
        public async ValueTask<IAuthoringInstalledPackageReadScope> AcquireActiveReadScopeAsync(
            VerifiedAuthoringPackage candidate, CancellationToken token)
        {
            token.ThrowIfCancellationRequested();
            IAuthoringInstalledPackageReadScope scope = AcquireActiveReadScope(candidate);
            try
            {
                if (OnPrepared is not null)
                {
                    await OnPrepared();
                }
                token.ThrowIfCancellationRequested();
                return scope;
            }
            catch (Exception failure)
            {
                AuthoringTerminalReadScopes.Release(failure, scope);
                throw;
            }
        }
        // Intentionally exposes only the old synchronous lifetime contract.
        // Naming an async acquisition cannot upgrade it into an IO capability.
        private sealed class SynchronousScope(Scope original) : IAuthoringInstalledPackageReadScope
        {
            public VerifiedAuthoringPackage ActivePackage => original.ActivePackage;
            public void Dispose() => original.Dispose();
        }
        // COMPONENT_SIMULATION: ownership is state protected by short locks,
        // not a held Monitor. The actual scope may release on another thread.
        private sealed class Scope(ActivePackage owner, VerifiedAuthoringPackage package) : IAuthoringInstalledPackageAsyncReadScope
        {
            public VerifiedAuthoringPackage ActivePackage => package;
            public void Dispose()
            {
                lock (owner._gate)
                {
                    owner._held = false;
                }
                if (owner.ReleaseFailure is { } failure)
                {
                    throw failure;
                }
            }
        }
    }

    private sealed class Network : IAuthoringPinnedNetworkTransport
    {
        internal int Calls { get; private set; }
        internal bool Completed { get; private set; }
        internal Func<ValueTask>? OnFetch { get; set; }
        public async ValueTask<AuthoringPinnedNetworkResponse> GetAsync(AuthoringPinnedNetworkRequest request, CancellationToken token)
        {
            Calls++;
            if (OnFetch is not null)
            {
                await OnFetch();
            }
            Completed = true;
            return new(200, "application/octet-stream", [83, 69, 67, 82, 69, 84]);
        }
    }

    private sealed class Addresses : IAuthoringNetworkAddressResolver
    {
        public ValueTask<ImmutableArray<IPAddress>> ResolveAsync(string host, CancellationToken token) =>
            ValueTask.FromResult<ImmutableArray<IPAddress>>([IPAddress.Parse("93.184.216.34")]);
    }

    private sealed class Revision : IAuthoringDocumentRevisionGate
    {
        internal bool Current { get; set; } = true;
        internal Action? OnCheck { get; set; }
        public ValueTask<bool> IsCurrentAsync(string id, long epoch, long revision, CancellationToken token)
        {
            OnCheck?.Invoke();
            return ValueTask.FromResult(Current);
        }
    }

    private sealed class NoTransaction : IAuthoringCanonicalDocumentTransaction
    {
        internal int Calls { get; private set; }
        public ValueTask<AuthoringTransactionReceipt> ApplyAsync(AuthoringMutationPlan plan, CancellationToken token)
        {
            Calls++;
            throw new InvalidOperationException("Broker results cannot mutate documents.");
        }
    }

    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now { get; set; } = new(639265824000000000L, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class NoAdapter : ITrustedAuthoringAdapterSourceVerifier, ITrustedAuthoringAdapterModuleVerifier
    {
        public ValueTask<bool> IsCheckedInSourceExactAsync(TrustedAuthoringAdapterDescriptor descriptor, CancellationToken token) => ValueTask.FromResult(false);
        public ValueTask<bool> IsLoadedModuleExactAsync(TrustedAuthoringAdapterDescriptor descriptor, CancellationToken token) => ValueTask.FromResult(false);
    }

    private sealed class Trust(TimeProvider clock) : IAuthoringPackageTrustVerifier
    {
        public ValueTask<AuthoringPackageTrustDecision> VerifyAsync(string publisher, string key, ReadOnlyMemory<byte> archive,
            ReadOnlyMemory<byte> signature, CancellationToken token) => ValueTask.FromResult(new AuthoringPackageTrustDecision(
                AuthoringPackageTrustStatus.Trusted, publisher, key, clock.GetUtcNow(), clock.GetUtcNow().AddHours(1), new string('1', 64)));
    }

    private sealed class Archive(AuthoringPackageArchiveContents contents) : IAuthoringPackageArchiveReader
    {
        public ValueTask<AuthoringPackageArchiveContents> ReadAsync(ReadOnlyMemory<byte> archive, CancellationToken token) => ValueTask.FromResult(contents);
    }
}
