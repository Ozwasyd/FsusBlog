using System.Collections.Immutable;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using Microsoft.AspNetCore.DataProtection;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions.Tests;

public sealed class LocalAuthoringCapabilityGrantStoreTests
{
    private static readonly DateTimeOffset s_now = new(2026, 10, 17, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task CatalogAndRpc_ObserveOneProtectedPersistentFactSet()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        await fixture.Store.StoreAsync(grant, default);
        Assert.Equal(grant, await fixture.Store.FindAsync(grant.GrantId, default));
        Assert.Equal(new[] { grant }, await fixture.Store.FindActiveAsync(grant.ExtensionId, grant.ContributionId, grant.RuntimeIdentity, default));
        Assert.Equal(new[] { grant }, await FindExact(fixture.Store, grant));
        Assert.Equal(grant, await fixture.Reopen().FindAsync(grant.GrantId, default));
        byte[] stored = File.ReadAllBytes(Path.Combine(fixture.Root, "grants.bin"));
        Assert.DoesNotContain(grant.DocumentId, Encoding.UTF8.GetString(stored));
        Assert.DoesNotContain(grant.ApprovalReceiptId, Encoding.UTF8.GetString(stored));
        Assert.False(fixture.Store is IAuthoringCapabilityBrokerGrantReadScopeStore);
    }

    [Fact]
    public async Task ExactQueries_IsolateEveryContractCoordinate()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        foreach (AuthoringCapabilityGrant item in new[]
        {
            grant,
            Seal(grant with { RequestId = "version", ExtensionVersion = "2.0.0" }),
            Seal(grant with { RequestId = "extension", ExtensionId = "other.extension" }),
            Seal(grant with { RequestId = "contribution", ContributionId = "other" }),
            Seal(grant with { RequestId = "runtime", RuntimeIdentity = new string('b', 64) }),
            Seal(grant with { RequestId = "class", ExecutionClass = AuthoringExecutionClass.OutOfProcessService }),
            Seal(grant with { RequestId = "document", DocumentId = "other-document" })
        })
        {
            await fixture.Store.StoreAsync(item, default);
        }
        Assert.Equal(new[] { grant }, await FindExact(fixture.Store, grant));
        Assert.Empty(await fixture.Store.FindActiveAsync("ACME.extension", grant.ContributionId, grant.RuntimeIdentity, default));
        Assert.Equal(4, (await fixture.Store.FindActiveAsync(grant.ExtensionId, grant.ContributionId, grant.RuntimeIdentity, default)).Length);
    }

    [Fact]
    public async Task Expiry_AndClockBeforeIssuance_AreInactiveWithoutDeletingFacts()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        await fixture.Store.StoreAsync(grant, default);
        fixture.Clock.Now = grant.IssuedAt.AddTicks(-1);
        Assert.Null(await fixture.Store.FindAsync(grant.GrantId, default));
        Assert.Empty(await FindExact(fixture.Store, grant));
        Assert.Throws<AuthoringExtensionContractException>(() => fixture.Store.AcquireReadScope(grant.GrantId));
        fixture.Clock.Now = grant.ExpiresAt;
        Assert.Null(await fixture.Reopen().FindAsync(grant.GrantId, default));
        Assert.Empty(await FindExact(fixture.Store, grant));
        Assert.Equal(1, await fixture.Store.RevokeExtensionAsync(grant.ExtensionId, default));
        fixture.Clock.Now = s_now;
        Assert.Null(await fixture.Reopen().FindAsync(grant.GrantId, default));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.Store.StoreAsync(grant, default).AsTask());
    }

    [Fact]
    public async Task Revocation_UsesExactExtensionAndRuntimeAndPersistsTombstones()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant first = CreateGrant("first");
        AuthoringCapabilityGrant second = Seal(first with
        {
            RequestId = "second",
            RuntimeIdentity = new string('b', 64)
        });
        AuthoringCapabilityGrant foreign = Seal(first with
        {
            RequestId = "foreign",
            ExtensionId = "other.extension"
        });
        foreach (AuthoringCapabilityGrant grant in new[] { first, second, foreign })
        {
            await fixture.Store.StoreAsync(grant, default);
        }
        Assert.Equal(1, await fixture.Store.RevokeRuntimesAsync(first.ExtensionId,
            ImmutableHashSet.Create(StringComparer.OrdinalIgnoreCase, first.RuntimeIdentity), default));
        Assert.Equal(second, await fixture.Reopen().FindAsync(second.GrantId, default));
        Assert.Null(await fixture.Reopen().FindAsync(first.GrantId, default));
        Assert.Equal(0, await fixture.Store.RevokeRuntimesAsync(first.ExtensionId, [first.RuntimeIdentity], default));
        Assert.Equal(1, await fixture.Reopen().RevokeExtensionAsync(first.ExtensionId, default));
        Assert.Equal(foreign, await fixture.Store.FindAsync(foreign.GrantId, default));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.Reopen().StoreAsync(first, default).AsTask());
        Assert.Equal(0, await fixture.Store.RevokeExtensionAsync(first.ExtensionId, default));
    }

    [Fact]
    public async Task RpcRevocation_AndLifecycleRevocation_ShareFacts()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant first = CreateGrant("first");
        await fixture.Store.StoreAsync(first, default);
        var authority = new AuthoringCapabilityGrantAuthority(fixture.Store, fixture.Clock);
        Assert.Equal(first, await authority.RequireAsync(first.GrantId, Envelope(first), first.Capability));
        using (IAuthoringCapabilityGrantReadScope scope = authority.AcquireReadScope(first.GrantId, Envelope(first), first.Capability))
        {
            Assert.Equal(first, scope.Grant);
        }
        await fixture.Reopen().RevokeExtensionAsync(first.ExtensionId, default);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() =>
            authority.RequireAsync(first.GrantId, Envelope(first), first.Capability).AsTask());
        AuthoringCapabilityGrant second = CreateGrant("second");
        await fixture.Store.StoreAsync(second, default);
        await authority.RevokeAsync(second.GrantId);
        Assert.Empty(await FindExact(fixture.Reopen(), second));
    }

    [Fact]
    public async Task HeldReadScope_RejectsSameAndCrossInstanceMutationUntilCrossThreadDispose()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        await fixture.Store.StoreAsync(grant, default);
        LocalAuthoringCapabilityGrantStore second = fixture.Reopen();
        IAuthoringCapabilityGrantReadScope scope = fixture.Store.AcquireReadScope(grant.GrantId);
        try
        {
            foreach (LocalAuthoringCapabilityGrantStore store in new[] { fixture.Store, second })
            {
                await Assert.ThrowsAnyAsync<Exception>(() => store.StoreAsync(grant, default).AsTask());
                await Assert.ThrowsAnyAsync<Exception>(() => store.RevokeAsync(grant.GrantId, default).AsTask());
                await Assert.ThrowsAnyAsync<Exception>(() => store.RevokeExtensionAsync(grant.ExtensionId, default).AsTask());
                await Assert.ThrowsAnyAsync<Exception>(() => store.RevokeRuntimesAsync(grant.ExtensionId, [grant.RuntimeIdentity], default).AsTask());
                Assert.ThrowsAny<Exception>(() => store.AcquireReadScope(grant.GrantId));
            }
            Assert.Equal(grant, scope.Grant);
        }
        finally
        {
            await Task.Run(scope.Dispose);
        }
        scope.Dispose();
        Assert.Throws<ObjectDisposedException>(() => scope.Grant);
        await second.RevokeAsync(grant.GrantId, default);
        Assert.Null(await fixture.Store.FindAsync(grant.GrantId, default));
    }

    [Fact]
    public async Task ConcurrentWriters_RefuseConflictThenRetryWithoutLostUpdate()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant first = CreateGrant("first");
        await fixture.Store.StoreAsync(first, default);
        using (var lockOwner = new FileStream(Path.Combine(fixture.Root, ".mutation.lock"), FileMode.Open,
            FileAccess.ReadWrite, FileShare.None))
        {
            await Assert.ThrowsAsync<IOException>(() => fixture.Reopen().StoreAsync(CreateGrant("second"), default).AsTask());
            await Assert.ThrowsAsync<IOException>(() => fixture.Store.RevokeExtensionAsync(first.ExtensionId, default).AsTask());
        }
        await fixture.Reopen().StoreAsync(CreateGrant("second"), default);
        Assert.Equal(2, (await FindExact(fixture.Store, first)).Length);
        Assert.Equal(2, await fixture.Store.RevokeExtensionAsync(first.ExtensionId, default));
        Assert.Empty(await FindExact(fixture.Reopen(), first));
    }

    [Fact]
    public async Task CancelledWrites_AndProtectionFailure_KeepOriginalStateAndReleaseOwner()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        await fixture.Store.StoreAsync(grant, default);
        byte[] original = File.ReadAllBytes(Path.Combine(fixture.Root, "grants.bin"));
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Store.RevokeAsync(grant.GrantId, cancelled.Token).AsTask());
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Store.StoreAsync(CreateGrant("second"), cancelled.Token).AsTask());
        fixture.Protection.FailProtect = true;
        await Assert.ThrowsAsync<CryptographicException>(() => fixture.Store.RevokeExtensionAsync(grant.ExtensionId, default).AsTask());
        Assert.Equal(original, File.ReadAllBytes(Path.Combine(fixture.Root, "grants.bin")));
        fixture.Protection.FailProtect = false;
        Assert.Equal(grant, await fixture.Reopen().FindAsync(grant.GrantId, default));
        await fixture.Store.RevokeAsync(grant.GrantId, default);
        Assert.Null(await fixture.Reopen().FindAsync(grant.GrantId, default));
    }

    [Fact]
    public async Task Corruption_AndWrongProtectionOwner_FailClosedWithoutOverwrite()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        await fixture.Store.StoreAsync(grant, default);
        string path = Path.Combine(fixture.Root, "grants.bin");
        byte[] original = File.ReadAllBytes(path);
        var wrong = new LocalAuthoringCapabilityGrantStore(fixture.Root, new EphemeralDataProtectionProvider(), fixture.Clock);
        await Assert.ThrowsAsync<CryptographicException>(() => wrong.FindAsync(grant.GrantId, default).AsTask());
        original[original.Length / 2] ^= 1;
        File.WriteAllBytes(path, original);
        await Assert.ThrowsAsync<CryptographicException>(() => fixture.Reopen().FindAsync(grant.GrantId, default).AsTask());
        await Assert.ThrowsAsync<CryptographicException>(() => fixture.Store.RevokeAsync(grant.GrantId, default).AsTask());
        await Assert.ThrowsAsync<CryptographicException>(() => fixture.Store.StoreAsync(CreateGrant("second"), default).AsTask());
        Assert.Equal(original, File.ReadAllBytes(path));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("unknown")]
    [InlineData("duplicate")]
    [InlineData("duplicate-grant")]
    [InlineData("schema")]
    [InlineData("digest")]
    [InlineData("null")]
    [InlineData("null-with-tombstone")]
    public async Task AuthenticatedMalformedState_IsRejected(string mutation)
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        await fixture.Store.StoreAsync(grant, default);
        string path = Path.Combine(fixture.Root, "grants.bin");
        IDataProtector protector = fixture.Protection.CreateProtector("FsusBlog.AuthoringExtensions.CapabilityGrants.v1",
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(fixture.Root))));
        JsonObject state = JsonNode.Parse(protector.Unprotect(File.ReadAllBytes(path)))!.AsObject();
        switch (mutation)
        {
            case "missing":
                state.Remove("grants");
                break;
            case "unknown":
                state["approved"] = true;
                break;
            case "duplicate-grant":
                state["grants"]!.AsArray().Add(state["grants"]![0]!.DeepClone());
                break;
            case "schema":
                state["schemaVersion"] = 2;
                break;
            case "digest":
                state["grants"]![0]!["grant"]!["purpose"] = "tampered";
                break;
            case "null":
                state["grants"]![0] = null;
                break;
            case "null-with-tombstone":
                state["grants"]![0] = null;
                state["revokedGrantIds"]!.AsArray().Add(new string('b', 64));
                break;
        }
        string json = state.ToJsonString();
        if (mutation == "duplicate")
        {
            json = json.Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"schemaVersion\":1", StringComparison.Ordinal);
        }
        File.WriteAllBytes(path, protector.Protect(Encoding.UTF8.GetBytes(json)));
        await Assert.ThrowsAnyAsync<Exception>(() => fixture.Reopen().FindAsync(grant.GrantId, default).AsTask());
    }

    [Theory]
    [InlineData("digest")]
    [InlineData("ttl")]
    [InlineData("purpose")]
    [InlineData("class")]
    [InlineData("capability")]
    [InlineData("mixed-io")]
    [InlineData("revision")]
    [InlineData("future")]
    [InlineData("newline")]
    public async Task InvalidGrantRecords_CannotEnterPersistentFacts(string mutation)
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        grant = mutation switch
        {
            "ttl" => Seal(grant with { ExpiresAt = s_now.AddDays(2) }),
            "purpose" => Seal(grant with { Purpose = "all" }),
            "class" => Seal(grant with { ExecutionClass = (AuthoringExecutionClass)99 }),
            "capability" => Seal(grant with { Capability = (AuthoringCapability)99 }),
            "mixed-io" => Seal(grant with { Destination = "https://example.invalid" }),
            "revision" => Seal(grant with { DocumentEpoch = 1 }),
            "future" => Seal(grant with { IssuedAt = s_now.AddMinutes(1) }),
            "newline" => Seal(grant with { Purpose = "a\nb" }),
            _ => grant with { GrantDigest = new string('c', 64) }
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.Store.StoreAsync(grant, default).AsTask());
        Assert.Null(await fixture.Store.FindAsync(grant.GrantId, default));
    }

    [Fact]
    public async Task FullDocumentGrant_PreservesExactEpochRevisionAndSnapshot()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = Seal(CreateGrant("full") with
        {
            Capability = AuthoringCapability.DocumentFullRead,
            DocumentEpoch = 7,
            SourceRevision = 12,
            SnapshotSha256 = new string('d', 64)
        });
        await fixture.Store.StoreAsync(grant, default);
        Assert.Equal(grant, await fixture.Reopen().FindAsync(grant.GrantId, default));
        var authority = new AuthoringCapabilityGrantAuthority(fixture.Reopen(), fixture.Clock);
        AuthoringRpcEnvelope envelope = Envelope(grant) with
        {
            DocumentEpoch = 7,
            SourceRevision = 12,
            SnapshotSha256 = grant.SnapshotSha256!
        };
        Assert.Equal(grant, await authority.RequireAsync(grant.GrantId, envelope, grant.Capability));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => authority.RequireAsync(grant.GrantId,
            envelope with
            {
                SourceRevision = 13
            }, grant.Capability).AsTask());
    }

    [Fact]
    public async Task PersistencePaths_RejectSymlinkRootLeafAndLock()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        string alias = Path.Combine(fixture.Directory, "alias");
        Directory.CreateSymbolicLink(alias, fixture.Root);
        Assert.Throws<AuthoringExtensionContractException>(() =>
            new LocalAuthoringCapabilityGrantStore(Path.Combine(alias, "child"), fixture.Protection, fixture.Clock));
        string target = Path.Combine(fixture.Directory, "target");
        File.WriteAllText(target, "do not overwrite");
        foreach (string leaf in new[] { "grants.bin", ".mutation.lock" })
        {
            string path = Path.Combine(fixture.Root, leaf);
            File.Delete(path);
            File.CreateSymbolicLink(path, target);
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.Store.StoreAsync(grant, default).AsTask());
            Assert.Equal("do not overwrite", File.ReadAllText(target));
            File.Delete(path);
        }
    }

    [Fact]
    public async Task FullStore_DoesNotEvictRevocationFactsToAdmitAnotherGrant()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        await fixture.Store.StoreAsync(grant, default);
        string path = Path.Combine(fixture.Root, "grants.bin");
        IDataProtector protector = fixture.Protection.CreateProtector("FsusBlog.AuthoringExtensions.CapabilityGrants.v1",
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(fixture.Root))));
        JsonObject state = JsonNode.Parse(protector.Unprotect(File.ReadAllBytes(path)))!.AsObject();
        JsonArray ids = state["revokedGrantIds"]!.AsArray();
        for (int index = 0; index < 4095; index++)
        {
            ids.Add(Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("synthetic-" + index))));
        }
        byte[] original = protector.Protect(Encoding.UTF8.GetBytes(state.ToJsonString()));
        File.WriteAllBytes(path, original);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.Store.StoreAsync(CreateGrant("second"), default).AsTask());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.Store.RevokeAsync(CreateGrant("second").GrantId, default).AsTask());
        Assert.Equal(original, File.ReadAllBytes(path));
        Assert.Equal(grant, await fixture.Store.FindAsync(grant.GrantId, default));
        await fixture.Store.RevokeAsync(grant.GrantId, default);
        Assert.Null(await fixture.Reopen().FindAsync(grant.GrantId, default));
    }

    [Fact]
    public async Task OversizedState_IsRejectedBeforeDecryption()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        await fixture.Store.StoreAsync(grant, default);
        using (var file = new FileStream(Path.Combine(fixture.Root, "grants.bin"), FileMode.Open, FileAccess.Write))
        {
            file.SetLength(16 * 1024 * 1024 + 1);
        }
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.Reopen().FindAsync(grant.GrantId, default).AsTask());
    }

    [Fact]
    public async Task MissingInitializedState_CannotForgetARevocation()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        await fixture.Store.StoreAsync(grant, default);
        await fixture.Store.RevokeAsync(grant.GrantId, default);
        File.Delete(Path.Combine(fixture.Root, "grants.bin"));
        foreach (LocalAuthoringCapabilityGrantStore store in new[] { fixture.Store, fixture.Reopen() })
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.FindAsync(grant.GrantId, default).AsTask());
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.StoreAsync(grant, default).AsTask());
        }
        Assert.False(File.Exists(Path.Combine(fixture.Root, "grants.bin")));
    }

    [Fact]
    public async Task MissingOwnershipLock_RefusesIncompletePersistentLayout()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        await fixture.Store.StoreAsync(grant, default);
        File.Delete(Path.Combine(fixture.Root, ".mutation.lock"));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.Reopen().StoreAsync(grant, default).AsTask());
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.Store.FindAsync(grant.GrantId, default).AsTask());
        Assert.False(File.Exists(Path.Combine(fixture.Root, ".mutation.lock")));
    }

    [Fact]
    public async Task RevokeBeforeStore_IsDurableAndCannotBeOvertakenByLateApproval()
    {
        using var fixture = new Fixture();
        AuthoringCapabilityGrant grant = CreateGrant("first");
        await fixture.Store.RevokeAsync(grant.GrantId, default);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => fixture.Reopen().StoreAsync(grant, default).AsTask());
        Assert.Null(await fixture.Store.FindAsync(grant.GrantId, default));
    }

    [Fact]
    public async Task RestartedProcess_ObservesRevocationAndSharedExclusion()
    {
        string? childRoot = Environment.GetEnvironmentVariable("FSUSBLOG_GRANT_CATALOG_TEST_ROOT");
        if (childRoot is not null)
        {
            var clock = new Clock();
            var store = new LocalAuthoringCapabilityGrantStore(Path.Combine(childRoot, "catalog"),
                DataProtectionProvider.Create(new DirectoryInfo(Path.Combine(childRoot, "test-keys"))), clock);
            AuthoringCapabilityGrant first = CreateGrant("first");
            AuthoringCapabilityGrant second = CreateGrant("second");
            if (Environment.GetEnvironmentVariable("FSUSBLOG_GRANT_CATALOG_TEST_MODE") == "held")
            {
                await Assert.ThrowsAsync<IOException>(() => store.RevokeAsync(second.GrantId, default).AsTask());
                await Assert.ThrowsAsync<IOException>(() => store.StoreAsync(second, default).AsTask());
                Assert.Throws<IOException>(() => store.AcquireReadScope(second.GrantId));
                return;
            }
            Assert.Null(await store.FindAsync(first.GrantId, default));
            Assert.Equal(second, await store.FindAsync(second.GrantId, default));
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => store.StoreAsync(first, default).AsTask());
            await store.RevokeAsync(second.GrantId, default);
            return;
        }
        using var fixture = new Fixture();
        var provider = DataProtectionProvider.Create(new DirectoryInfo(Path.Combine(fixture.Directory, "test-keys")));
        var parent = new LocalAuthoringCapabilityGrantStore(fixture.Root, provider, fixture.Clock);
        await parent.StoreAsync(CreateGrant("first"), default);
        await parent.StoreAsync(CreateGrant("second"), default);
        await parent.RevokeAsync(CreateGrant("first").GrantId, default);
        using (IAuthoringCapabilityGrantReadScope scope = parent.AcquireReadScope(CreateGrant("second").GrantId))
        {
            await RunRestartChild(fixture.Directory, "held");
            Assert.Equal(CreateGrant("second"), scope.Grant);
        }
        await RunRestartChild(fixture.Directory, "restart");
        Assert.Null(await parent.FindAsync(CreateGrant("second").GrantId, default));
    }

    private static async Task RunRestartChild(string directory, string mode)
    {
        string assembly = typeof(LocalAuthoringCapabilityGrantStoreTests).Assembly.Location;
        var start = new ProcessStartInfo("dotnet") { RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (string argument in new[] { "vstest", assembly,
            "--TestCaseFilter:FullyQualifiedName~LocalAuthoringCapabilityGrantStoreTests.RestartedProcess_ObservesRevocationAndSharedExclusion",
            "--Logger:trx;LogFileName=grant-restart-child.trx", "--ResultsDirectory:" + Path.Combine(directory, "child-results") })
        {
            start.ArgumentList.Add(argument);
        }
        start.Environment["FSUSBLOG_GRANT_CATALOG_TEST_ROOT"] = directory;
        start.Environment["FSUSBLOG_GRANT_CATALOG_TEST_MODE"] = mode;
        using Process process = Process.Start(start)!;
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch
        {
            process.Kill(entireProcessTree: true);
            throw;
        }
        Assert.True(process.ExitCode == 0, await stdout + await stderr);
    }

    private static ValueTask<ImmutableArray<AuthoringCapabilityGrant>> FindExact(
        LocalAuthoringCapabilityGrantStore store, AuthoringCapabilityGrant grant) => store.FindActiveExactAsync(
            grant.ExtensionId, grant.ExtensionVersion, grant.ContributionId, grant.RuntimeIdentity,
            grant.ExecutionClass, grant.DocumentId, default);

    private static AuthoringCapabilityGrant CreateGrant(string request) => Seal(new AuthoringCapabilityGrant(
        string.Empty, new string('a', 64), "acme.extension", "1.0.0", "command", AuthoringExecutionClass.IsolatedWorkerWasm,
        AuthoringCapability.DocumentRangeRead, "synthetic-document", "synthetic-site", "synthetic-review",
        null, null, s_now.AddMinutes(-1), s_now.AddMinutes(10), "synthetic-approval", request, string.Empty));

    private static AuthoringCapabilityGrant Seal(AuthoringCapabilityGrant grant)
    {
        string digest = AuthoringCapabilityGrantAuthority.ComputeGrantDigest(grant);
        return grant with
        {
            GrantId = digest,
            GrantDigest = digest
        };
    }

    private static AuthoringRpcEnvelope Envelope(AuthoringCapabilityGrant grant) => new(
        1, AuthoringRpcMethod.DocumentRangeRead, grant.RuntimeIdentity, grant.ExtensionId, grant.ExtensionVersion,
        new string('1', 64), new string('2', 64), grant.ContributionId, grant.ExecutionClass, grant.RequestId,
        grant.DocumentId, 1, 0, new string('f', 64), new string('3', 64), new string('4', 64), new string('5', 64),
        grant.GrantDigest, s_now.AddMinutes(1), new AuthoringRpcPayload())
    {
        SiteIdentity = grant.SiteIdentity,
        Purpose = grant.Purpose
    };

    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = s_now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class Protection(IDataProtector inner) : IDataProtectionProvider, IDataProtector
    {
        public bool FailProtect
        {
            get; set;
        }
        public IDataProtector CreateProtector(string purpose) => new ProtectionOwner(this, inner.CreateProtector(purpose));
        public byte[] Protect(byte[] plaintext) => FailProtect ? throw new CryptographicException("synthetic failure") : inner.Protect(plaintext);
        public byte[] Unprotect(byte[] protectedData) => inner.Unprotect(protectedData);
        private sealed class ProtectionOwner(Protection owner, IDataProtector protector) : IDataProtector
        {
            public IDataProtector CreateProtector(string purpose) => new ProtectionOwner(owner, protector.CreateProtector(purpose));
            public byte[] Protect(byte[] plaintext) => owner.FailProtect ? throw new CryptographicException("synthetic failure") : protector.Protect(plaintext);
            public byte[] Unprotect(byte[] protectedData) => protector.Unprotect(protectedData);
        }
    }

    private sealed class Fixture : IDisposable
    {
        public string Directory { get; } = Path.Combine(Path.GetTempPath(), "fsusblog-grant-test-" + Guid.NewGuid().ToString("N"));
        public string Root => Path.Combine(Directory, "catalog");
        public Clock Clock { get; } = new();
        public Protection Protection { get; } = new(new EphemeralDataProtectionProvider().CreateProtector("synthetic-grant-test"));
        public LocalAuthoringCapabilityGrantStore Store
        {
            get;
        }
        public Fixture() => Store = Reopen();
        public LocalAuthoringCapabilityGrantStore Reopen() => new(Root, Protection, Clock);
        public void Dispose() => System.IO.Directory.Delete(Directory, recursive: true);
    }
}
