using System.Collections.Immutable;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionRpcTests
{
    [Fact]
    public async Task ApplyMutationAsync_ExactGrantAndCurrentRevision_UsesOneCanonicalTransaction()
    {
        RpcFixture fixture = await CreateFixtureAsync();

        AuthoringTransactionReceipt receipt = await fixture.Authority.ApplyMutationAsync(
            fixture.Envelope,
            fixture.Approval);

        Assert.Equal("plan-1", receipt.PlanId);
        Assert.Equal(1, fixture.Transaction.CallCount);
        Assert.True(receipt.Dirty);
    }

    [Fact]
    public async Task ApplyMutationAsync_DefaultDenyWithoutGrant()
    {
        RpcFixture fixture = await CreateFixtureAsync(storeGrant: false);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval));
        Assert.Equal(0, fixture.Transaction.CallCount);
    }

    [Fact]
    public async Task ApplyMutationAsync_VersionClassOrDocumentGrantReuse_FailsClosed()
    {
        foreach (Func<AuthoringRpcEnvelope, AuthoringRpcEnvelope> mutate in new Func<AuthoringRpcEnvelope, AuthoringRpcEnvelope>[]
        {
            envelope => envelope with { ExtensionVersion = "2.0.0" },
            envelope => envelope with { ExecutionClass = AuthoringExecutionClass.OutOfProcessService },
            envelope => envelope with { DocumentId = "document-2" },
            envelope => envelope with { SiteIdentity = "site-2" },
            envelope => envelope with { Purpose = "other-purpose" }
        })
        {
            RpcFixture fixture = await CreateFixtureAsync();
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await fixture.Authority.ApplyMutationAsync(mutate(fixture.Envelope), fixture.Approval));
        }
    }

    [Fact]
    public async Task ApplyMutationAsync_StaleRevisionRejectsWithoutNearestMatchOrRebase()
    {
        RpcFixture fixture = await CreateFixtureAsync(currentRevision: false);

        AuthoringExtensionContractException exception = await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval));

        Assert.Contains("automatic rebasing is forbidden", exception.Message, StringComparison.Ordinal);
        Assert.Equal(0, fixture.Transaction.CallCount);
    }

    [Fact]
    public async Task ApplyMutationAsync_DuplicateRetryDoesNotCreateSecondHistoryEntry()
    {
        RpcFixture fixture = await CreateFixtureAsync();
        await fixture.Authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval));

        Assert.Equal(1, fixture.Transaction.CallCount);
    }

    [Fact]
    public async Task ApplyMutationAsync_DeniedPreviewOrExecutableMarkup_FailsClosed()
    {
        RpcFixture denied = await CreateFixtureAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await denied.Authority.ApplyMutationAsync(denied.Envelope, denied.Approval with
            {
                Approved = false
            }));

        RpcFixture markup = await CreateFixtureAsync();
        AuthoringMutationPlan plan = markup.Envelope.Payload.MutationPlan! with
        {
            Mutations =
            [
                new AuthoringMutation(AuthoringMutationOperation.Replace, new AuthoringTextRange(0, 1), "<script>x</script>")
            ]
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await markup.Authority.ApplyMutationAsync(
                markup.Envelope with
                {
                    Payload = new AuthoringRpcPayload(MutationPlan: plan)
                },
                markup.Approval));
    }

    [Fact]
    public async Task ApplyMutationAsync_OverlappingRangesRejectWithoutNearestMatch()
    {
        RpcFixture fixture = await CreateFixtureAsync();
        AuthoringMutationPlan plan = fixture.Envelope.Payload.MutationPlan! with
        {
            Mutations =
            [
                new AuthoringMutation(AuthoringMutationOperation.Replace, new AuthoringTextRange(0, 2), "a"),
                new AuthoringMutation(AuthoringMutationOperation.Replace, new AuthoringTextRange(1, 3), "b")
            ]
        };

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ApplyMutationAsync(
                fixture.Envelope with
                {
                    Payload = new AuthoringRpcPayload(MutationPlan: plan)
                },
                fixture.Approval));
        Assert.Equal(0, fixture.Transaction.CallCount);
    }

    [Fact]
    public async Task ApplyMutationAsync_TamperedTransactionReceiptFailsClosed()
    {
        RpcFixture fixture = await CreateFixtureAsync(tamperReceipt: true);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval));
        Assert.Equal(1, fixture.Transaction.CallCount);
    }

    [Theory]
    [InlineData(AuthoringRpcMethod.DocumentFullRead)]
    [InlineData((AuthoringRpcMethod)999)]
    public async Task ApplyMutationAsync_AlternateOrUnknownMethodCannotBypassMutationAuthority(AuthoringRpcMethod method)
    {
        RpcFixture fixture = await CreateFixtureAsync();

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ApplyMutationAsync(fixture.Envelope with
            {
                Method = method
            }, fixture.Approval));
    }

    [Fact]
    public async Task ValidateEnvelope_MultiplePayloadsOrUnknownMethod_FailsClosed()
    {
        RpcFixture fixture = await CreateFixtureAsync();
        AuthoringRpcPayload multiple = fixture.Envelope.Payload with
        {
            QueryReference = "query/v1"
        };

        Assert.Throws<AuthoringExtensionContractException>(() =>
            fixture.Authority.ValidateEnvelope(fixture.Envelope with
            {
                Payload = multiple
            }));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            fixture.Authority.ValidateEnvelope(fixture.Envelope with
            {
                Method = (AuthoringRpcMethod)999
            }));
    }

    [Fact]
    public async Task GrantAuthority_RejectsAllowAllAndRequiresExactIoScope()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var authority = new AuthoringCapabilityGrantAuthority(new GrantStore(), new FixedTimeProvider(now));
        AuthoringGrantRequest request = CreateGrantRequest() with
        {
            Purpose = "all"
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await authority.IssueAsync(request));

        request = CreateGrantRequest() with
        {
            Capability = AuthoringCapability.NetworkDestination,
            Destination = null
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await authority.IssueAsync(request));

        request = CreateGrantRequest() with
        {
            Capability = AuthoringCapability.DocumentRangeRead,
            Destination = "example.test"
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await authority.IssueAsync(request));
    }

    [Fact]
    public async Task GrantAuthority_FullDocumentGrantRequiresExactRevisionScope()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var store = new GrantStore();
        var authority = new AuthoringCapabilityGrantAuthority(store, new FixedTimeProvider(now));
        AuthoringGrantRequest request = CreateGrantRequest() with
        {
            Capability = AuthoringCapability.DocumentFullRead
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () => await authority.IssueAsync(request));

        request = request with
        {
            DocumentEpoch = 1,
            SourceRevision = 2,
            SnapshotSha256 = new string('c', 64)
        };
        AuthoringCapabilityGrant grant = await authority.IssueAsync(request);
        RpcFixture fixture = await CreateFixtureAsync();
        AuthoringRpcEnvelope envelope = fixture.Envelope with
        {
            Method = AuthoringRpcMethod.DocumentFullRead,
            GrantDigest = grant.GrantDigest,
            Payload = new AuthoringRpcPayload(QueryReference: "full-document/v1")
        };

        await authority.RequireAsync(grant.GrantId, envelope, AuthoringCapability.DocumentFullRead);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await authority.RequireAsync(
                grant.GrantId,
                envelope with { SourceRevision = 3 },
                AuthoringCapability.DocumentFullRead));
    }

    [Fact]
    public async Task GrantAuthority_TamperedStoredGrantFailsDigestVerification()
    {
        RpcFixture fixture = await CreateFixtureAsync();
        fixture.Store.Tamper(
            fixture.Envelope.GrantDigest,
            static grant => grant with { Purpose = "tampered-purpose" });

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval));
        Assert.Equal(0, fixture.Transaction.CallCount);
    }

    [Fact]
    public async Task GrantAuthority_RevocationTakesEffectImmediately()
    {
        RpcFixture fixture = await CreateFixtureAsync();
        await fixture.Grants.RevokeAsync(fixture.Envelope.GrantDigest);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval));
    }

    [Fact]
    public void RpcSource_DoesNotExposeLiveEditorOrDirectMutationAuthority()
    {
        string source = File.ReadAllText(Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src/backend/Infrastructure/AuthoringExtensions/AuthoringExtensionRpc.cs"));

        Assert.DoesNotContain("editorRef", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Pinia", source, StringComparison.Ordinal);
        Assert.DoesNotContain("IServiceProvider", source, StringComparison.Ordinal);
        Assert.DoesNotContain("innerHTML", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("splice", source, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Delegate", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Callback", source, StringComparison.Ordinal);
    }

    private static async ValueTask<RpcFixture> CreateFixtureAsync(
        bool storeGrant = true,
        bool currentRevision = true,
        bool tamperReceipt = false)
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var store = new GrantStore();
        var grants = new AuthoringCapabilityGrantAuthority(store, new FixedTimeProvider(now));
        AuthoringCapabilityGrant grant = await grants.IssueAsync(CreateGrantRequest());
        if (!storeGrant)
        {
            await store.RevokeAsync(grant.GrantId, default);
        }

        AuthoringMutationPlan plan = new(
            "plan-1",
            "document-1",
            1,
            2,
            new string('c', 64),
            [new AuthoringMutation(AuthoringMutationOperation.Replace, new AuthoringTextRange(0, 1), "replacement")],
            "selection-1");
        var envelope = new AuthoringRpcEnvelope(
            1,
            AuthoringRpcMethod.MutationRequest,
            new string('a', 64),
            "acme.author-tools",
            "1.0.0",
            new string('b', 64),
            new string('d', 64),
            "acme.command.format",
            AuthoringExecutionClass.IsolatedWorkerWasm,
            "request-1",
            "document-1",
            1,
            2,
            new string('c', 64),
            new string('e', 64),
            new string('f', 64),
            new string('1', 64),
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
            new string('2', 64));
        var transaction = new TransactionPort(tamperReceipt);
        var authority = new AuthoringExtensionRpcAuthority(
            grants,
            transaction,
            new RevisionGate(currentRevision),
            new FixedTimeProvider(now));
        return new RpcFixture(authority, grants, envelope, approval, transaction, store);
    }

    private static AuthoringGrantRequest CreateGrantRequest() => new(
        "grant-request-1",
        new string('a', 64),
        "acme.author-tools",
        "1.0.0",
        "acme.command.format",
        AuthoringExecutionClass.IsolatedWorkerWasm,
        AuthoringCapability.DocumentMutationRequest,
        "document-1",
        "site-1",
        "format-selection",
        null,
        null,
        TimeSpan.FromMinutes(5),
        "approval-1");

    private sealed record RpcFixture(
        AuthoringExtensionRpcAuthority Authority,
        AuthoringCapabilityGrantAuthority Grants,
        AuthoringRpcEnvelope Envelope,
        AuthoringMutationApproval Approval,
        TransactionPort Transaction,
        GrantStore Store);

    private sealed class GrantStore : IAuthoringCapabilityGrantStore
    {
        private readonly Dictionary<string, AuthoringCapabilityGrant> _grants = new(StringComparer.Ordinal);

        public ValueTask<AuthoringCapabilityGrant?> FindAsync(string grantId, CancellationToken cancellationToken) =>
            ValueTask.FromResult(_grants.GetValueOrDefault(grantId));

        public ValueTask StoreAsync(AuthoringCapabilityGrant grant, CancellationToken cancellationToken)
        {
            if (!_grants.TryAdd(grant.GrantId, grant))
            {
                throw new AuthoringExtensionContractException("Duplicate grant receipt.");
            }

            return ValueTask.CompletedTask;
        }

        public ValueTask RevokeAsync(string grantId, CancellationToken cancellationToken)
        {
            _grants.Remove(grantId);
            return ValueTask.CompletedTask;
        }

        public void Tamper(
            string grantId,
            Func<AuthoringCapabilityGrant, AuthoringCapabilityGrant> mutate) =>
            _grants[grantId] = mutate(_grants[grantId]);
    }

    private sealed class TransactionPort(bool tamperReceipt = false) : IAuthoringCanonicalDocumentTransaction
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
                ReceiptDigest = tamperReceipt
                    ? new string('3', 64)
                    : AuthoringExtensionRpcAuthority.ComputeTransactionReceiptDigest(receipt)
            });
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

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
