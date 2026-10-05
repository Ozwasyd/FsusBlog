using System.Collections.Immutable;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.Unit;

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
                envelope with
                {
                    SourceRevision = 3
                },
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
    public async Task ApplyMutationAsync_RechecksRevokedGrantAfterSuspendedRevisionGateWithoutConsumingRequestId()
    {
        RpcFixture fixture = await CreateFixtureAsync();
        var clock = new AdmissionTimeProvider(fixture.Envelope.Deadline.AddMinutes(-1));
        var gate = new SuspendedAdmissionRevisionGate();
        var grants = new AuthoringCapabilityGrantAuthority(fixture.Store, clock);
        var authority = new AuthoringExtensionRpcAuthority(grants, fixture.Transaction, gate, clock);
        authority.ValidateEnvelope(fixture.Envelope);
        await grants.RequireAsync(fixture.Envelope.GrantDigest, fixture.Envelope,
            AuthoringCapability.DocumentMutationRequest);

        Task<AuthoringTransactionReceipt> pending = authority.ApplyMutationAsync(
            fixture.Envelope, fixture.Approval).AsTask();
        try
        {
            Assert.Equal(1, gate.CallCount);
            Assert.False(pending.IsCompleted);
            await grants.RevokeAsync(fixture.Envelope.GrantDigest);
            Assert.Null(await fixture.Store.FindAsync(fixture.Envelope.GrantDigest, CancellationToken.None));
            Assert.True(fixture.Envelope.Deadline > clock.GetUtcNow());
            gate.Release();

            AuthoringExtensionContractException exception = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
                async () => await pending);
            Assert.Equal("Capability grant is missing, expired, revoked, or outside the exact scope.", exception.Message);
            Assert.Equal(0, fixture.Transaction.CallCount);
        }
        finally
        {
            gate.Release();
            try
            {
                await pending;
            }
            catch (AuthoringExtensionContractException)
            {
            }
        }

        AuthoringCapabilityGrant renewed = await grants.IssueAsync(CreateGrantRequest());
        Assert.Equal(fixture.Envelope.GrantDigest, renewed.GrantDigest);
        AuthoringTransactionReceipt receipt = await authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval);
        Assert.Equal(fixture.Envelope.Payload.MutationPlan!.PlanId, receipt.PlanId);
        Assert.Equal(2, gate.CallCount);
        Assert.Equal(1, fixture.Transaction.CallCount);
        AuthoringExtensionContractException duplicate = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
            async () => await authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval));
        Assert.Equal("Duplicate mutation request is rejected.", duplicate.Message);
        Assert.Equal(1, fixture.Transaction.CallCount);
    }

    [Fact]
    public async Task ApplyMutationAsync_RechecksExpiredGrantAfterSuspendedRevisionGateWithoutConsumingRequestId()
    {
        RpcFixture fixture = await CreateFixtureAsync();
        var clock = new AdmissionTimeProvider(fixture.Envelope.Deadline.AddMinutes(-1));
        AuthoringRpcEnvelope envelope = fixture.Envelope with { Deadline = clock.GetUtcNow().AddMinutes(10) };
        var gate = new SuspendedAdmissionRevisionGate();
        var grants = new AuthoringCapabilityGrantAuthority(fixture.Store, clock);
        var authority = new AuthoringExtensionRpcAuthority(grants, fixture.Transaction, gate, clock);
        authority.ValidateEnvelope(envelope);
        AuthoringCapabilityGrant original = await grants.RequireAsync(envelope.GrantDigest, envelope,
            AuthoringCapability.DocumentMutationRequest);

        AuthoringMutationApproval approval = PreviewFor(envelope, fixture.Approval);
        Task<AuthoringTransactionReceipt> pending = authority.ApplyMutationAsync(envelope, approval).AsTask();
        try
        {
            Assert.Equal(1, gate.CallCount);
            Assert.False(pending.IsCompleted);
            clock.UtcNow = original.ExpiresAt;
            Assert.True(envelope.Deadline > clock.GetUtcNow());
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await grants.RequireAsync(envelope.GrantDigest, envelope, AuthoringCapability.DocumentMutationRequest));
            gate.Release();

            AuthoringExtensionContractException exception = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
                async () => await pending);
            Assert.Equal("Capability grant is missing, expired, revoked, or outside the exact scope.", exception.Message);
            Assert.Equal(0, fixture.Transaction.CallCount);
        }
        finally
        {
            gate.Release();
            try
            {
                await pending;
            }
            catch (AuthoringExtensionContractException)
            {
            }
        }

        AuthoringCapabilityGrant renewed = await grants.IssueAsync(CreateGrantRequest());
        Assert.NotEqual(original.GrantDigest, renewed.GrantDigest);
        AuthoringRpcEnvelope retry = envelope with { GrantDigest = renewed.GrantDigest };
        Assert.Equal(envelope.RequestId, retry.RequestId);
        AuthoringMutationApproval retryApproval = PreviewFor(retry, fixture.Approval);
        AuthoringTransactionReceipt receipt = await authority.ApplyMutationAsync(retry, retryApproval);
        Assert.Equal(envelope.Payload.MutationPlan!.PlanId, receipt.PlanId);
        Assert.Equal(2, gate.CallCount);
        Assert.Equal(1, fixture.Transaction.CallCount);
        AuthoringExtensionContractException duplicate = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
            async () => await authority.ApplyMutationAsync(retry, retryApproval));
        Assert.Equal("Duplicate mutation request is rejected.", duplicate.Message);
        Assert.Equal(1, fixture.Transaction.CallCount);
    }

    [Fact]
    public async Task ApplyMutationAsync_RechecksDeadlineAfterSuspendedGrantRecheckWithoutConsumingRequestId()
    {
        RpcFixture fixture = await CreateFixtureAsync();
        var clock = new AdmissionTimeProvider(fixture.Envelope.Deadline.AddMinutes(-1));
        var store = new SuspendedAdmissionGrantStore(fixture.Store);
        var grants = new AuthoringCapabilityGrantAuthority(store, clock);
        var authority = new AuthoringExtensionRpcAuthority(grants, fixture.Transaction, new RevisionGate(true), clock);
        authority.ValidateEnvelope(fixture.Envelope);
        AuthoringCapabilityGrant original = await fixture.Grants.RequireAsync(
            fixture.Envelope.GrantDigest, fixture.Envelope, AuthoringCapability.DocumentMutationRequest);

        Task<AuthoringTransactionReceipt> pending = authority.ApplyMutationAsync(
            fixture.Envelope, fixture.Approval).AsTask();
        try
        {
            Assert.Equal(2, store.FindCallCount);
            Assert.False(pending.IsCompleted);
            clock.UtcNow = fixture.Envelope.Deadline;
            Assert.True(original.ExpiresAt > clock.GetUtcNow());
            store.Release();

            AuthoringExtensionContractException exception = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
                async () => await pending);
            Assert.Equal("Mutation request deadline has expired.", exception.Message);
            Assert.Equal(0, fixture.Transaction.CallCount);
        }
        finally
        {
            store.Release();
            try
            {
                await pending;
            }
            catch (AuthoringExtensionContractException)
            {
            }
        }

        AuthoringRpcEnvelope retry = fixture.Envelope with { Deadline = clock.GetUtcNow().AddMinutes(1) };
        Assert.Equal(fixture.Envelope.RequestId, retry.RequestId);
        AuthoringMutationApproval retryApproval = PreviewFor(retry, fixture.Approval);
        AuthoringTransactionReceipt receipt = await authority.ApplyMutationAsync(retry, retryApproval);
        Assert.Equal(fixture.Envelope.Payload.MutationPlan!.PlanId, receipt.PlanId);
        Assert.Equal(1, fixture.Transaction.CallCount);
        AuthoringExtensionContractException duplicate = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
            async () => await authority.ApplyMutationAsync(retry, retryApproval));
        Assert.Equal("Duplicate mutation request is rejected.", duplicate.Message);
        Assert.Equal(1, fixture.Transaction.CallCount);
    }

    [Fact]
    public async Task ApplyMutationAsync_RechecksCancellationAfterSuspendedGrantRecheckWithoutConsumingRequestId()
    {
        RpcFixture fixture = await CreateFixtureAsync();
        var clock = new AdmissionTimeProvider(fixture.Envelope.Deadline.AddMinutes(-1));
        using var caller = new CancellationTokenSource();
        var store = new SuspendedAdmissionGrantStore(fixture.Store);
        var grants = new AuthoringCapabilityGrantAuthority(store, clock);
        var authority = new AuthoringExtensionRpcAuthority(grants, fixture.Transaction, new RevisionGate(true), clock);
        authority.ValidateEnvelope(fixture.Envelope);
        await fixture.Grants.RequireAsync(fixture.Envelope.GrantDigest, fixture.Envelope,
            AuthoringCapability.DocumentMutationRequest, caller.Token);

        Task<AuthoringTransactionReceipt> pending = authority.ApplyMutationAsync(
            fixture.Envelope, fixture.Approval, caller.Token).AsTask();
        try
        {
            Assert.Equal(2, store.FindCallCount);
            Assert.Equal(caller.Token, store.LastLookupToken);
            Assert.False(pending.IsCompleted);
            caller.Cancel();
            Assert.True(fixture.Envelope.Deadline > clock.GetUtcNow());
            store.Release();

            OperationCanceledException exception = await Assert.ThrowsAnyAsync<OperationCanceledException>(
                async () => await pending);
            Assert.Equal(caller.Token, exception.CancellationToken);
            Assert.Equal(0, fixture.Transaction.CallCount);
        }
        finally
        {
            store.Release();
            try
            {
                await pending;
            }
            catch (OperationCanceledException exception) when (exception.CancellationToken == caller.Token)
            {
            }
        }

        AuthoringTransactionReceipt receipt = await authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval);
        Assert.Equal(fixture.Envelope.Payload.MutationPlan!.PlanId, receipt.PlanId);
        Assert.Equal(1, fixture.Transaction.CallCount);
        AuthoringExtensionContractException duplicate = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
            async () => await authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval));
        Assert.Equal("Duplicate mutation request is rejected.", duplicate.Message);
        Assert.Equal(1, fixture.Transaction.CallCount);
    }

    private sealed class SuspendedAdmissionRevisionGate : IAuthoringDocumentRevisionGate
    {
        private readonly TaskCompletionSource _released = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int CallCount { get; private set; }

        public void Release() => _released.TrySetResult();

        public async ValueTask<bool> IsCurrentAsync(
            string documentId,
            long documentEpoch,
            long sourceRevision,
            CancellationToken cancellationToken)
        {
            Assert.Equal("document-1", documentId);
            Assert.Equal(1, documentEpoch);
            Assert.Equal(2, sourceRevision);
            CallCount++;
            await _released.Task.WaitAsync(cancellationToken);
            return true;
        }
    }

    private sealed class SuspendedAdmissionGrantStore(GrantStore store) : IAuthoringCapabilityGrantStore
    {
        private readonly TaskCompletionSource _released = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int FindCallCount { get; private set; }

        public CancellationToken LastLookupToken { get; private set; }

        public void Release() => _released.TrySetResult();

        public async ValueTask<AuthoringCapabilityGrant?> FindAsync(string grantId, CancellationToken cancellationToken)
        {
            FindCallCount++;
            LastLookupToken = cancellationToken;
            if (FindCallCount == 2)
            {
                await _released.Task;
            }
            return await store.FindAsync(grantId, cancellationToken);
        }

        public ValueTask StoreAsync(AuthoringCapabilityGrant grant, CancellationToken cancellationToken) =>
            store.StoreAsync(grant, cancellationToken);

        public ValueTask RevokeAsync(string grantId, CancellationToken cancellationToken) =>
            store.RevokeAsync(grantId, cancellationToken);
    }

    [Theory]
    [InlineData(-1L)]
    [InlineData(0L)]
    [InlineData(1L)]
    public async Task ApplyMutationAsync_RechecksDeadlineAfterRevisionGateBeforeRequestConsumption(long deadlineOffsetTicks)
    {
        RpcFixture fixture = await CreateFixtureAsync();
        var clock = new AdmissionTimeProvider(fixture.Envelope.Deadline.AddMinutes(-1));
        var gate = new AdmissionRevisionGate(_ => clock.UtcNow =
            fixture.Envelope.Deadline.AddTicks(deadlineOffsetTicks));
        var grants = new AuthoringCapabilityGrantAuthority(fixture.Store, clock);
        var authority = new AuthoringExtensionRpcAuthority(grants, fixture.Transaction, gate, clock);
        authority.ValidateEnvelope(fixture.Envelope);
        await grants.RequireAsync(fixture.Envelope.GrantDigest, fixture.Envelope,
            AuthoringCapability.DocumentMutationRequest);

        if (deadlineOffsetTicks < 0)
        {
            AuthoringTransactionReceipt receipt = await authority.ApplyMutationAsync(
                fixture.Envelope, fixture.Approval);
            Assert.Equal(fixture.Envelope.Payload.MutationPlan!.PlanId, receipt.PlanId);
            Assert.Equal(1, fixture.Transaction.CallCount);
        }
        else
        {
            AuthoringExtensionContractException exception = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
                async () => await authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval));
            Assert.Equal("Mutation request deadline has expired.", exception.Message);
            Assert.Equal(0, fixture.Transaction.CallCount);
        }
        Assert.Equal(1, gate.CallCount);
        Assert.Equal(fixture.Envelope.Deadline.AddTicks(deadlineOffsetTicks), clock.GetUtcNow());
        AuthoringCapabilityGrant stillValidGrant = await grants.RequireAsync(
            fixture.Envelope.GrantDigest, fixture.Envelope, AuthoringCapability.DocumentMutationRequest);
        Assert.True(stillValidGrant.ExpiresAt > clock.GetUtcNow());
        AuthoringRpcEnvelope retry = fixture.Envelope with
        {
            Deadline = clock.GetUtcNow().AddMinutes(1)
        };
        Assert.Equal(fixture.Envelope.RequestId, retry.RequestId);
        AuthoringMutationApproval retryApproval = PreviewFor(retry, fixture.Approval);
        if (deadlineOffsetTicks >= 0)
        {
            AuthoringTransactionReceipt receipt = await authority.ApplyMutationAsync(retry, retryApproval);
            Assert.Equal(fixture.Envelope.Payload.MutationPlan!.PlanId, receipt.PlanId);
            Assert.Equal(2, gate.CallCount);
            Assert.Equal(1, fixture.Transaction.CallCount);
        }

        AuthoringExtensionContractException duplicate = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
            async () => await authority.ApplyMutationAsync(retry, retryApproval));
        Assert.Equal("Duplicate mutation request is rejected.", duplicate.Message);
        Assert.Equal(1, fixture.Transaction.CallCount);
    }

    [Fact]
    public async Task ApplyMutationAsync_RechecksCallerCancellationAfterRevisionGateWithoutConsumingRequestId()
    {
        RpcFixture fixture = await CreateFixtureAsync();
        var clock = new AdmissionTimeProvider(fixture.Envelope.Deadline.AddMinutes(-1));
        using var caller = new CancellationTokenSource();
        var gate = new AdmissionRevisionGate(token =>
        {
            Assert.Equal(caller.Token, token);
            caller.Cancel();
        });
        var grants = new AuthoringCapabilityGrantAuthority(fixture.Store, clock);
        var authority = new AuthoringExtensionRpcAuthority(grants, fixture.Transaction, gate, clock);
        authority.ValidateEnvelope(fixture.Envelope);
        await grants.RequireAsync(fixture.Envelope.GrantDigest, fixture.Envelope,
            AuthoringCapability.DocumentMutationRequest, caller.Token);

        OperationCanceledException exception = await Assert.ThrowsAnyAsync<OperationCanceledException>(
            async () => await authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval, caller.Token));
        Assert.Equal(caller.Token, exception.CancellationToken);
        Assert.True(caller.IsCancellationRequested);
        Assert.Equal(1, gate.CallCount);
        Assert.Equal(0, fixture.Transaction.CallCount);

        AuthoringTransactionReceipt receipt = await authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval);
        Assert.Equal(fixture.Envelope.Payload.MutationPlan!.PlanId, receipt.PlanId);
        Assert.Equal(2, gate.CallCount);
        Assert.Equal(1, fixture.Transaction.CallCount);
        AuthoringExtensionContractException duplicate = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
            async () => await authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval));
        Assert.Equal("Duplicate mutation request is rejected.", duplicate.Message);
        Assert.Equal(1, fixture.Transaction.CallCount);
    }

    private sealed class AdmissionRevisionGate(Action<CancellationToken> onCurrent) : IAuthoringDocumentRevisionGate
    {
        public int CallCount { get; private set; }

        public ValueTask<bool> IsCurrentAsync(
            string documentId,
            long documentEpoch,
            long sourceRevision,
            CancellationToken cancellationToken)
        {
            Assert.Equal("document-1", documentId);
            Assert.Equal(1, documentEpoch);
            Assert.Equal(2, sourceRevision);
            CallCount++;
            if (CallCount == 1)
            {
                onCurrent(cancellationToken);
            }
            return ValueTask.FromResult(true);
        }
    }

    private sealed class AdmissionTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = now;

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }

    [Fact]
    public void RpcSource_DoesNotExposeLiveEditorOrDirectMutationAuthority()
    {
        Type[] rpcTypes =
        [
            typeof(AuthoringRpcMethod),
            typeof(AuthoringMutationOperation),
            typeof(AuthoringTextRange),
            typeof(AuthoringDocumentSnapshot),
            typeof(AuthoringMutation),
            typeof(AuthoringMutationPlan),
            typeof(AuthoringRpcPayload),
            typeof(AuthoringRpcEnvelope),
            typeof(AuthoringCapabilityGrant),
            typeof(AuthoringGrantRequest),
            typeof(AuthoringMutationApproval),
            typeof(AuthoringTransactionReceipt),
            typeof(IAuthoringCapabilityGrantStore),
            typeof(IAuthoringCanonicalDocumentTransaction),
            typeof(AuthoringCapabilityGrantAuthority),
            typeof(AuthoringExtensionRpcAuthority)
        ];
        Assert.All(rpcTypes, AssertRpcTypeHasNoLiveEditorOrDirectMutationAuthority);
    }

    [Fact]
    public void CompiledRpcBoundary_RejectsUncalledNestedMethodBody()
    {
        Type type = typeof(UncalledNestedFixture);
        Type nested = Assert.Single(type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic));
        MethodInfo method = Assert.Single(nested.GetMethods(
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            | BindingFlags.Instance | BindingFlags.DeclaredOnly));
        Assert.Equal("Read", method.Name);
        Assert.NotNull(method.GetMethodBody());

        string rootOnly = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(type),
            RuntimeMetadataInspection.DescribeConstructors(type));
        Assert.DoesNotContain("splice", rootOnly, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("splice", RuntimeMetadataInspection.DescribeMethods(nested, method.Name),
            StringComparison.Ordinal);

        Xunit.Sdk.XunitException exception = Assert.ThrowsAny<Xunit.Sdk.XunitException>(() =>
            AssertRpcTypeHasNoLiveEditorOrDirectMutationAuthority(type));
        Assert.Contains("splice", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CompiledRpcBoundary_AcceptsAndDescribesBenignUncalledNestedMethodBody()
    {
        Type type = typeof(ContractOnlyFixture);
        Type nested = Assert.Single(type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic));
        MethodInfo method = Assert.Single(nested.GetMethods(
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
            | BindingFlags.Instance | BindingFlags.DeclaredOnly));
        Assert.Equal("Read", method.Name);
        Assert.NotNull(method.GetMethodBody());

        string rootOnly = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(type),
            RuntimeMetadataInspection.DescribeConstructors(type));
        Assert.DoesNotContain("rpc-contract-safe", rootOnly, StringComparison.Ordinal);
        Assert.Contains("rpc-contract-safe", RuntimeMetadataInspection.DescribeMethods(nested, method.Name),
            StringComparison.Ordinal);
        Assert.Contains("rpc-contract-safe", DescribeRpcTypeTree(type), StringComparison.Ordinal);
        AssertRpcTypeHasNoLiveEditorOrDirectMutationAuthority(type);
    }

    [Theory]
    [InlineData("replacement", "f89348136d888080a251c21c08a688ffcf4605eea20d1c1cb04dbcfb6c658d1b")]
    [InlineData("a\n\0é𝄞\ud800", "89f57d854aa2b871834c31342c1451edd26c031936a43cfd444f24187424f008")]
    public async Task MutationPreview_ExactFramedMaterialMatchesIndependentLiteralVectors(string text, string digest)
    {
        RpcFixture fixture = await CreateFixtureAsync();
        Assert.Equal("a80d7cc420549ed58fc55ee2cb500c2b6a23bb3e301cfcf7bacccb898ed85ca7", fixture.Envelope.GrantDigest);
        AuthoringMutationPlan plan = fixture.Envelope.Payload.MutationPlan!;
        AuthoringRpcEnvelope envelope = fixture.Envelope with
        {
            Payload = new AuthoringRpcPayload(MutationPlan: plan with
            {
                Mutations = [plan.Mutations[0] with { Text = text }]
            })
        };

        // Literal vectors were framed independently, not obtained from this producer.
        Assert.Equal(digest, AuthoringExtensionRpcAuthority.ComputeMutationPreviewDigest(envelope));
    }

    [Theory]
    [InlineData("text")]
    [InlineData("start")]
    [InlineData("end")]
    [InlineData("operation")]
    [InlineData("selection")]
    [InlineData("snapshot")]
    [InlineData("epoch")]
    [InlineData("revision")]
    [InlineData("package")]
    [InlineData("content")]
    [InlineData("hostApi")]
    [InlineData("schema")]
    [InlineData("policy")]
    [InlineData("deadline")]
    public async Task ApplyMutationAsync_SamePlanIdChangedMaterialCannotReuseApproval(string field)
    {
        RpcFixture fixture = await CreateFixtureAsync();
        AuthoringMutationPlan plan = fixture.Envelope.Payload.MutationPlan!;
        AuthoringMutation mutation = plan.Mutations[0];
        AuthoringRpcEnvelope changed = field switch
        {
            "package" => fixture.Envelope with { PackageSha256 = new string('3', 64) },
            "content" => fixture.Envelope with { ContentSha256 = new string('3', 64) },
            "hostApi" => fixture.Envelope with { HostApiDigest = new string('3', 64) },
            "schema" => fixture.Envelope with { SchemaDigest = new string('3', 64) },
            "policy" => fixture.Envelope with { PolicyDigest = new string('3', 64) },
            "deadline" => fixture.Envelope with { Deadline = fixture.Envelope.Deadline.AddTicks(1) },
            "snapshot" => fixture.Envelope with { SnapshotSha256 = new string('3', 64) },
            "epoch" => fixture.Envelope with { DocumentEpoch = 2 },
            "revision" => fixture.Envelope with { SourceRevision = 3 },
            _ => fixture.Envelope
        };
        plan = field switch
        {
            "text" => plan with { Mutations = [mutation with { Text = "changed plain text" }] },
            "start" => plan with { Mutations = [mutation with { Range = new AuthoringTextRange(1, 1) }] },
            "end" => plan with { Mutations = [mutation with { Range = new AuthoringTextRange(0, 2) }] },
            "operation" => plan with { Mutations = [mutation with { Operation = AuthoringMutationOperation.Insert }] },
            "selection" => plan with { SelectionIdentity = "selection-2" },
            "snapshot" => plan with { ExpectedSnapshotSha256 = changed.SnapshotSha256 },
            "epoch" => plan with { DocumentEpoch = changed.DocumentEpoch },
            "revision" => plan with { ExpectedSourceRevision = changed.SourceRevision },
            _ => plan
        };
        changed = changed with { Payload = new AuthoringRpcPayload(MutationPlan: plan) };
        fixture.Authority.ValidateEnvelope(changed);
        await fixture.Grants.RequireAsync(changed.GrantDigest, changed, AuthoringCapability.DocumentMutationRequest);
        Assert.Equal(fixture.Envelope.Payload.MutationPlan!.PlanId, plan.PlanId);
        Assert.Equal(1, plan.Mutations.Length);
        Assert.NotEqual(fixture.Approval.PreviewDigest, AuthoringExtensionRpcAuthority.ComputeMutationPreviewDigest(changed));

        AuthoringExtensionContractException exception = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
            async () => await fixture.Authority.ApplyMutationAsync(changed, fixture.Approval));
        Assert.Equal("Mutation preview does not bind the exact approved plan and host context.", exception.Message);
        Assert.Equal(0, fixture.Transaction.CallCount);
        await fixture.Authority.ApplyMutationAsync(fixture.Envelope, fixture.Approval);
        Assert.Equal(1, fixture.Transaction.CallCount);
    }

    [Theory]
    [InlineData("runtime")]
    [InlineData("extension")]
    [InlineData("version")]
    [InlineData("contribution")]
    [InlineData("class")]
    [InlineData("request")]
    [InlineData("document")]
    [InlineData("site")]
    [InlineData("purpose")]
    [InlineData("grant")]
    [InlineData("planId")]
    public async Task MutationPreview_RemainingExactIdentityFieldsAffectMaterial(string field)
    {
        RpcFixture fixture = await CreateFixtureAsync();
        AuthoringRpcEnvelope changed = field switch
        {
            "runtime" => fixture.Envelope with { RuntimeIdentity = new string('3', 64) },
            "extension" => fixture.Envelope with { ExtensionId = "other.extension" },
            "version" => fixture.Envelope with { ExtensionVersion = "2.0.0" },
            "contribution" => fixture.Envelope with { ContributionId = "other.command" },
            "class" => fixture.Envelope with { ExecutionClass = AuthoringExecutionClass.OutOfProcessService },
            "request" => fixture.Envelope with { RequestId = "request-2" },
            "document" => fixture.Envelope with { DocumentId = "document-2" },
            "site" => fixture.Envelope with { SiteIdentity = "site-2" },
            "purpose" => fixture.Envelope with { Purpose = "other-purpose" },
            "grant" => fixture.Envelope with { GrantDigest = new string('3', 64) },
            _ => fixture.Envelope
        };
        AuthoringMutationPlan plan = changed.Payload.MutationPlan! with { DocumentId = changed.DocumentId };
        if (field == "planId")
        {
            plan = plan with { PlanId = "plan-2" };
        }
        changed = changed with { Payload = new AuthoringRpcPayload(MutationPlan: plan) };
        Assert.NotEqual(fixture.Approval.PreviewDigest, AuthoringExtensionRpcAuthority.ComputeMutationPreviewDigest(changed));
    }

    [Fact]
    public async Task ApplyMutationAsync_OrderedMutationsAndLengthFramedTextRemainExact()
    {
        RpcFixture fixture = await CreateFixtureAsync();
        AuthoringMutationPlan plan = fixture.Envelope.Payload.MutationPlan! with
        {
            Mutations =
            [
                new(AuthoringMutationOperation.Replace, new(0, 1), "first\nsecond"),
                new(AuthoringMutationOperation.Replace, new(2, 3), "third")
            ]
        };
        AuthoringRpcEnvelope envelope = fixture.Envelope with { Payload = new AuthoringRpcPayload(MutationPlan: plan) };
        AuthoringMutationApproval approval = PreviewFor(envelope, fixture.Approval);
        AuthoringRpcEnvelope reordered = envelope with
        {
            Payload = new AuthoringRpcPayload(MutationPlan: plan with { Mutations = [plan.Mutations[1], plan.Mutations[0]] })
        };
        AuthoringRpcEnvelope reframed = envelope with
        {
            Payload = new AuthoringRpcPayload(MutationPlan: plan with
            {
                Mutations = [plan.Mutations[0] with { Text = "first" }, plan.Mutations[1] with { Text = "second\nthird" }]
            })
        };
        foreach (AuthoringRpcEnvelope changed in new[] { reordered, reframed })
        {
            Assert.NotEqual(approval.PreviewDigest, AuthoringExtensionRpcAuthority.ComputeMutationPreviewDigest(changed));
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(
                async () => await fixture.Authority.ApplyMutationAsync(changed, approval));
            Assert.Equal(0, fixture.Transaction.CallCount);
        }
        await fixture.Authority.ApplyMutationAsync(envelope, approval);
        Assert.Equal(plan.Mutations.ToArray(), fixture.Transaction.LastPlan!.Mutations.ToArray());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ApplyMutationAsync_OwnedPlanSurvivesCallerArrayMutationAcrossAuthorityAwait(bool finalGrantAwait)
    {
        RpcFixture fixture = await CreateFixtureAsync();
        AuthoringMutationPlan original = fixture.Envelope.Payload.MutationPlan!;
        AuthoringMutation[] callerArray = [original.Mutations[0]];
        AuthoringRpcEnvelope envelope = fixture.Envelope with
        {
            Payload = new AuthoringRpcPayload(MutationPlan: original with
            {
                Mutations = ImmutableCollectionsMarshal.AsImmutableArray(callerArray)
            })
        };
        var gate = new SuspendedAdmissionRevisionGate();
        var store = new SuspendedAdmissionGrantStore(fixture.Store);
        IAuthoringDocumentRevisionGate actualGate = finalGrantAwait ? new RevisionGate(true) : gate;
        var grants = finalGrantAwait
            ? new AuthoringCapabilityGrantAuthority(store, new FixedTimeProvider(envelope.Deadline.AddMinutes(-1)))
            : fixture.Grants;
        var authority = new AuthoringExtensionRpcAuthority(
            grants, fixture.Transaction, actualGate, new FixedTimeProvider(envelope.Deadline.AddMinutes(-1)));
        Task<AuthoringTransactionReceipt> pending = authority.ApplyMutationAsync(envelope, fixture.Approval).AsTask();
        try
        {
            Assert.False(pending.IsCompleted);
            callerArray[0] = callerArray[0] with { Text = "caller alias changed after preview validation" };
            Assert.NotEqual(fixture.Approval.PreviewDigest, AuthoringExtensionRpcAuthority.ComputeMutationPreviewDigest(envelope));
            gate.Release();
            store.Release();
            await pending;
            Assert.Equal("replacement", fixture.Transaction.LastPlan!.Mutations[0].Text);
            Assert.Equal(1, fixture.Transaction.CallCount);
        }
        finally
        {
            gate.Release();
            store.Release();
            try
            {
                await pending;
            }
            catch (AuthoringExtensionContractException)
            {
            }
        }
    }

    [Theory]
    [InlineData(1000, true)]
    [InlineData(1001, false)]
    public async Task MutationPreview_OriginalOrderedMutationCeilingIsNotExpanded(int count, bool accepted)
    {
        RpcFixture fixture = await CreateFixtureAsync();
        AuthoringMutationPlan plan = fixture.Envelope.Payload.MutationPlan! with
        {
            Mutations = [.. Enumerable.Range(0, count).Select(index =>
                new AuthoringMutation(AuthoringMutationOperation.Replace, new AuthoringTextRange(index * 2, index * 2 + 1), "x"))]
        };
        AuthoringRpcEnvelope envelope = fixture.Envelope with { Payload = new AuthoringRpcPayload(MutationPlan: plan) };
        if (!accepted)
        {
            Assert.Throws<AuthoringExtensionContractException>(() =>
                AuthoringExtensionRpcAuthority.ComputeMutationPreviewDigest(envelope));
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(
                async () => await fixture.Authority.ApplyMutationAsync(envelope, fixture.Approval));
            Assert.Equal(0, fixture.Transaction.CallCount);
            return;
        }
        await fixture.Authority.ApplyMutationAsync(envelope, PreviewFor(envelope, fixture.Approval));
        Assert.Equal(count, fixture.Transaction.LastPlan!.Mutations.Length);
        Assert.Equal(1, fixture.Transaction.CallCount);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, true)]
    public async Task ApplyMutationAsync_ContentHashCannotGrantApprovalOrAcceptAnUnboundPreview(bool approved, bool tamperDigest)
    {
        RpcFixture fixture = await CreateFixtureAsync();
        AuthoringMutationApproval approval = fixture.Approval with
        {
            Approved = approved,
            PreviewDigest = tamperDigest ? new string('2', 64) : fixture.Approval.PreviewDigest
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(
            async () => await fixture.Authority.ApplyMutationAsync(fixture.Envelope, approval));
        Assert.Equal(0, fixture.Transaction.CallCount);
    }

    // SOURCE COMPONENT_SIMULATION: these public-handler controls use the real
    // manifest validator, package verifier, resolver and grant authority, with
    // simulated canonical document, installed-package and trust owners. They do
    // not prove a production consent issuer, document bridge or native runtime.
    [Theory]
    [InlineData(AuthoringRpcMethod.DocumentRangeRead)]
    [InlineData(AuthoringRpcMethod.SelectionRead)]
    [InlineData(AuthoringRpcMethod.DocumentFullRead)]
    public async Task ReadDocumentAsync_ExactDeclaredGrantReturnsOnlyCanonicalImmutableScope(AuthoringRpcMethod method)
    {
        ReadFixture fixture = await CreateReadFixtureAsync(method);
        AuthoringDocumentReadResult result = await fixture.Authority.ReadDocumentAsync(
            fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope);

        Assert.Equal(fixture.Envelope.Payload.DocumentRange, result.Snapshot.IncludedRange);
        Assert.Equal(fixture.Reader.Document.Substring(result.Snapshot.IncludedRange.Start,
            result.Snapshot.IncludedRange.End - result.Snapshot.IncludedRange.Start), result.Snapshot.Text);
        Assert.Equal(fixture.Envelope.RequestId, result.Receipt.RequestId);
        Assert.Equal(fixture.Envelope.GrantDigest, result.Receipt.GrantDigest);
        Assert.Equal(fixture.Envelope.SnapshotSha256, result.Receipt.SnapshotSha256);
        Assert.DoesNotContain(result.Snapshot.Text, JsonSerializer.Serialize(result.Receipt), StringComparison.Ordinal);
        Assert.Equal(0, fixture.Reader.TransactionCalls);
        Assert.Equal(2, fixture.Active.Calls);
        Assert.Equal(2, fixture.Reader.CurrentChecks);
    }

    [Theory]
    [InlineData(AuthoringRpcMethod.DocumentRangeRead)]
    [InlineData(AuthoringRpcMethod.SelectionRead)]
    [InlineData(AuthoringRpcMethod.DocumentFullRead)]
    public async Task ReadDocumentAsync_DefaultDenyHasNoDocumentRead(AuthoringRpcMethod method)
    {
        ReadFixture fixture = await CreateReadFixtureAsync(method);
        await fixture.Grants.RevokeAsync(fixture.Envelope.GrantDigest);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        Assert.Equal(0, fixture.Reader.ReadCalls);
        Assert.Equal(0, fixture.Reader.TransactionCalls);
    }

    [Theory]
    [InlineData(AuthoringRpcMethod.DocumentRangeRead)]
    [InlineData(AuthoringRpcMethod.SelectionRead)]
    public async Task ReadDocumentAsync_MinimalGrantCannotReturnWholeDocument(AuthoringRpcMethod method)
    {
        ReadFixture fixture = await CreateReadFixtureAsync(method);
        AuthoringRpcEnvelope full = fixture.Envelope with
        {
            Payload = new AuthoringRpcPayload(DocumentRange: new AuthoringTextRange(0, fixture.Reader.Document.Length))
        };
        fixture.Reader.ExpectedEnvelope = full;
        fixture.Reader.Selection = full.Payload.DocumentRange!;
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, full));
        Assert.Equal(0, fixture.Reader.TransactionCalls);
    }

    [Fact]
    public async Task ReadDocumentAsync_FullReadRequiresManifestCapabilityInAdditionToExactGrant()
    {
        ReadFixture fixture = await CreateReadFixtureAsync(AuthoringRpcMethod.DocumentFullRead,
            declaredCapability: AuthoringCapability.DocumentRangeRead);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        Assert.Equal(0, fixture.Active.Calls);
        Assert.Equal(0, fixture.Reader.ReadCalls);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    public async Task ReadDocumentAsync_GrantIdentityReuseDoesNotRead(int field)
    {
        ReadFixture fixture = await CreateReadFixtureAsync();
        AuthoringRpcEnvelope changed = field switch
        {
            0 => fixture.Envelope with { ExtensionVersion = "2.0.0" },
            1 => fixture.Envelope with { DocumentId = "document-2" },
            2 => fixture.Envelope with { Purpose = "other-purpose" },
            3 => fixture.Envelope with { SiteIdentity = "site-2" },
            _ => fixture.Envelope with { ExecutionClass = AuthoringExecutionClass.OutOfProcessService }
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, changed));
        Assert.Equal(0, fixture.Reader.ReadCalls);
    }

    [Theory]
    [InlineData(-1, 1)]
    [InlineData(2, 1)]
    [InlineData(0, int.MaxValue)]
    public async Task ReadDocumentAsync_InvalidOrOverBudgetRangeIsRejectedBeforeOwnerRead(int start, int end)
    {
        ReadFixture fixture = await CreateReadFixtureAsync();
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux,
                fixture.Envelope with { Payload = new AuthoringRpcPayload(DocumentRange: new AuthoringTextRange(start, end)) }));
        Assert.Equal(0, fixture.Reader.ReadCalls);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    public async Task ReadDocumentAsync_CanonicalSnapshotDriftOrOverbroadReturnIsRejected(int field)
    {
        ReadFixture fixture = await CreateReadFixtureAsync(AuthoringRpcMethod.SelectionRead);
        fixture.Reader.ChangeObservation = observation => field switch
        {
            0 => observation with { Snapshot = observation.Snapshot with { DocumentId = "document-2" } },
            1 => observation with { Snapshot = observation.Snapshot with { DocumentEpoch = 2 } },
            2 => observation with { Snapshot = observation.Snapshot with { SourceRevision = 3 } },
            3 => observation with { Snapshot = observation.Snapshot with { SnapshotSha256 = new string('0', 64) } },
            4 => observation with { Selection = new AuthoringTextRange(0, 1) },
            _ => observation with { Snapshot = observation.Snapshot with { Text = fixture.Reader.Document } }
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        Assert.Equal(0, fixture.Reader.TransactionCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReadDocumentAsync_CanonicalStateChangedDuringFinalGrantAwaitCannotReturn(bool selection)
    {
        ReadFixture fixture = await CreateReadFixtureAsync(AuthoringRpcMethod.SelectionRead);
        fixture.Lookup.OnLookup = count =>
        {
            if (count == 2)
            {
                if (selection)
                {
                    fixture.Reader.Selection = new AuthoringTextRange(0, 1);
                }
                else
                {
                    fixture.Reader.Revision++;
                }
            }
            return ValueTask.CompletedTask;
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        Assert.Equal(1, fixture.Reader.ReadCalls);
        Assert.Equal(0, fixture.Reader.TransactionCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReadDocumentAsync_NonCooperativeReadOrFinalGrantCancellationCannotReturn(bool finalGrant)
    {
        ReadFixture fixture = await CreateReadFixtureAsync();
        using var caller = new CancellationTokenSource();
        if (finalGrant)
        {
            fixture.Lookup.OnLookup = count =>
            {
                if (count == 2)
                {
                    caller.Cancel();
                }
                return ValueTask.CompletedTask;
            };
        }
        else
        {
            fixture.Reader.OnRead = () => { caller.Cancel(); return ValueTask.CompletedTask; };
        }
        OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope, caller.Token));
        Assert.Equal(caller.Token, error.CancellationToken);
        Assert.Equal(0, fixture.Reader.TransactionCalls);
    }

    [Theory]
    [InlineData(-1L)]
    [InlineData(0L)]
    [InlineData(1L)]
    public async Task ReadDocumentAsync_LastGrantDeadlineBoundaryRemainsExclusive(long ticks)
    {
        ReadFixture fixture = await CreateReadFixtureAsync();
        fixture.Lookup.OnLookup = count =>
        {
            if (count == 2)
            {
                fixture.Clock.UtcNow = fixture.Envelope.Deadline.AddTicks(ticks);
            }
            return ValueTask.CompletedTask;
        };
        if (ticks < 0)
        {
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope);
        }
        else
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        }
        Assert.Equal(0, fixture.Reader.TransactionCalls);
    }

    [Fact]
    public async Task ReadDocumentAsync_RevokedGrantOrInactivePackageAfterReadCannotReturn()
    {
        foreach (bool revoke in new[] { false, true })
        {
            ReadFixture fixture = await CreateReadFixtureAsync();
            fixture.Reader.OnRead = async () =>
            {
                if (revoke)
                {
                    await fixture.Grants.RevokeAsync(fixture.Envelope.GrantDigest);
                }
                else
                {
                    fixture.Active.Active = false;
                }
            };
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
            Assert.Equal(0, fixture.Reader.TransactionCalls);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReadDocumentAsync_OriginalDeclaredRequestAndResponseBudgetsAreEnforced(bool response)
    {
        ReadFixture fixture = await CreateReadFixtureAsync(requestBytes: response ? 65536 : 1,
            responseBytes: response ? 1 : 65536);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        Assert.Equal(0, fixture.Reader.TransactionCalls);
    }

    [Fact]
    public async Task ReadDocumentAsync_AbsentCanonicalReadOwnerOrResolverHasNoFallback()
    {
        ReadFixture fixture = await CreateReadFixtureAsync();
        var noResolver = new AuthoringExtensionRpcAuthority(fixture.Grants, fixture.Reader,
            new RevisionGate(true), fixture.Clock);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await noResolver.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        var noReader = new AuthoringExtensionRpcAuthority(fixture.Grants, new TransactionPort(),
            new RevisionGate(true), fixture.Clock, fixture.Resolver);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await noReader.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        Assert.Equal(0, fixture.Reader.ReadCalls);
    }

    [Theory]
    [InlineData(false, -1)]
    [InlineData(false, 0)]
    [InlineData(false, 1)]
    [InlineData(true, -1)]
    [InlineData(true, 0)]
    [InlineData(true, 1)]
    public async Task ReadDocumentAsync_SerializedResponseBudgetIncludesMetadataEscapingAndSurrogateBoundaries(
        bool escaped, int offset)
    {
        string text = escaped ? new string('a', 255) + "\U0001F600<&\n" : "SELECTED";
        ReadFixture generous = await CreateReadFixtureAsync(selectedText: text);
        AuthoringDocumentReadResult control = await generous.Authority.ReadDocumentAsync(
            generous.Package, AuthoringHostPlatform.ServerLinux, generous.Envelope);
        int actualValueBytes = JsonSerializer.SerializeToUtf8Bytes(control).Length;
        ReadFixture bounded = await CreateReadFixtureAsync(responseBytes: actualValueBytes + offset, selectedText: text);
        if (offset < 0)
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await bounded.Authority.ReadDocumentAsync(bounded.Package, AuthoringHostPlatform.ServerLinux, bounded.Envelope));
        }
        else
        {
            AuthoringDocumentReadResult result = await bounded.Authority.ReadDocumentAsync(
                bounded.Package, AuthoringHostPlatform.ServerLinux, bounded.Envelope);
            Assert.Equal(text, result.Snapshot.Text);
            Assert.Equal(actualValueBytes, JsonSerializer.SerializeToUtf8Bytes(result).Length);
        }
        Assert.Equal(1, bounded.Reader.ReadCalls);
        Assert.Equal(0, bounded.Reader.TransactionCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReadDocumentAsync_LastCanonicalOwnerCheckPreservesCancellationAndDeadline(bool cancel)
    {
        ReadFixture fixture = await CreateReadFixtureAsync();
        using var caller = new CancellationTokenSource();
        fixture.Reader.OnCurrentCheck = count =>
        {
            if (count == 2)
            {
                if (cancel)
                {
                    caller.Cancel();
                }
                else
                {
                    fixture.Clock.UtcNow = fixture.Envelope.Deadline;
                }
            }
        };
        if (cancel)
        {
            OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
                await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux,
                    fixture.Envelope, caller.Token));
            Assert.Equal(caller.Token, error.CancellationToken);
        }
        else
        {
            await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
                await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        }
        Assert.Equal(0, fixture.Reader.TransactionCalls);
    }

    [Theory]
    [InlineData(AuthoringRpcMethod.DocumentRangeRead)]
    [InlineData(AuthoringRpcMethod.SelectionRead)]
    [InlineData(AuthoringRpcMethod.DocumentFullRead)]
    public async Task ReadDocumentAsync_LastGrantAwaitPackageDeactivationCannotPublish(AuthoringRpcMethod method)
    {
        ReadFixture fixture = await CreateReadFixtureAsync(method);
        fixture.Lookup.OnLookup = count =>
        {
            if (count == 2)
            {
                fixture.Active.Active = false;
            }
            return ValueTask.CompletedTask;
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        Assert.Equal(2, fixture.Active.Calls);
        Assert.False(fixture.Active.ScopeHeld);
        Assert.False(fixture.Lookup.ScopeHeld);
        Assert.Equal(0, fixture.Reader.TransactionCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReadDocumentAsync_OriginalAuthorityMissingExclusionPortHasNoFallback(bool packagePort)
    {
        ReadFixture fixture = await CreateReadFixtureAsync();
        AuthoringExecutionResolver resolver = packagePort
            ? new AuthoringExecutionResolver(new ClosedTrustedAuthoringAdapterRegistry([]),
                new ReadUnavailableAdapterVerifier(), new ReadUnavailableAdapterVerifier(),
                new ReadUnscopedActiveAuthority(fixture.Active))
            : fixture.Resolver;
        AuthoringCapabilityGrantAuthority grants = packagePort ? fixture.Grants
            : new AuthoringCapabilityGrantAuthority(new ReadUnscopedGrantStore(fixture.Lookup), fixture.Clock);
        var authority = new AuthoringExtensionRpcAuthority(grants, fixture.Reader,
            new RevisionGate(true), fixture.Clock, resolver);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        Assert.False(fixture.Active.ScopeHeld);
        Assert.False(fixture.Lookup.ScopeHeld);
        Assert.Equal(packagePort ? 0 : 1, fixture.Active.ScopeReleases);
    }

    [Fact]
    public async Task ReadDocumentAsync_WholePublicationHoldsBothOriginalAuthorityScopes()
    {
        ReadFixture fixture = await CreateReadFixtureAsync();
        fixture.Reader.OnCurrentCheck = _ =>
        {
            Assert.True(fixture.Active.ScopeHeld);
            Assert.True(fixture.Lookup.ScopeHeld);
            Assert.Throws<AuthoringExtensionContractException>(() => fixture.Active.Active = false);
            Assert.Throws<AuthoringExtensionContractException>(() =>
            {
                fixture.Lookup.RevokeAsync(fixture.Envelope.GrantDigest, default).GetAwaiter().GetResult();
            });
        };
        AuthoringDocumentReadResult result = await fixture.Authority.ReadDocumentAsync(
            fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope);
        Assert.Equal("SELECTED", result.Snapshot.Text);
        Assert.Equal(1, fixture.Active.ScopeReleases);
        Assert.Equal(1, fixture.Lookup.ScopeReleases);
        await fixture.Grants.RevokeAsync(fixture.Envelope.GrantDigest);
        fixture.Active.Active = false;
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ReadDocumentAsync_FinalAuthorityExpiryIsIndependentOfEnvelopeDeadline(bool trust)
    {
        ReadFixture fixture = await CreateReadFixtureAsync(trustLifetime: trust ? TimeSpan.FromMinutes(2) : null);
        DateTimeOffset expiry = trust ? fixture.Package.Trust.ValidUntil
            : (await fixture.Lookup.FindAsync(fixture.Envelope.GrantDigest, default))!.ExpiresAt;
        AuthoringRpcEnvelope envelope = fixture.Envelope with { Deadline = expiry.AddMinutes(1) };
        fixture.Reader.ExpectedEnvelope = envelope;
        fixture.Reader.OnCurrentCheck = count =>
        {
            if (count == 2)
            {
                fixture.Clock.UtcNow = expiry;
            }
        };
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, envelope));
        Assert.Equal(2, fixture.Reader.CurrentChecks);
        Assert.Equal(1, fixture.Active.ScopeReleases);
        Assert.Equal(1, fixture.Lookup.ScopeReleases);
    }

    [Fact]
    public async Task ReadDocumentAsync_ScopeCleanupPreservesPrimaryAndBothSecondaryFailures()
    {
        ReadFixture fixture = await CreateReadFixtureAsync();
        var primary = new IOException("canonical completion failed");
        var packageCleanup = new IOException("package release failed");
        var grantCleanup = new IOException("grant release failed");
        fixture.Active.DisposeFailure = packageCleanup;
        fixture.Lookup.DisposeFailure = grantCleanup;
        fixture.Reader.OnCurrentCheck = _ => throw primary;
        IOException actual = await Assert.ThrowsAsync<IOException>(async () =>
            await fixture.Authority.ReadDocumentAsync(fixture.Package, AuthoringHostPlatform.ServerLinux, fixture.Envelope));
        Assert.Same(primary, actual);
        Assert.Equal(new Exception[] { grantCleanup, packageCleanup },
            Assert.IsType<Exception[]>(actual.Data["AuthoringTerminalReadScopeCleanupFailures"]));
        Assert.False(fixture.Active.ScopeHeld);
        Assert.False(fixture.Lookup.ScopeHeld);
        Assert.Equal(1, fixture.Active.ScopeReleases);
        Assert.Equal(1, fixture.Lookup.ScopeReleases);
    }

    private static async ValueTask<ReadFixture> CreateReadFixtureAsync(
        AuthoringRpcMethod method = AuthoringRpcMethod.DocumentRangeRead,
        AuthoringCapability? declaredCapability = null,
        int requestBytes = 65536,
        int responseBytes = 65536,
        string? selectedText = null,
        TimeSpan? trustLifetime = null)
    {
        RpcFixture original = await CreateFixtureAsync();
        AuthoringCapability capability = method switch
        {
            AuthoringRpcMethod.SelectionRead => AuthoringCapability.SelectionRead,
            AuthoringRpcMethod.DocumentFullRead => AuthoringCapability.DocumentFullRead,
            _ => AuthoringCapability.DocumentRangeRead
        };
        byte[] archive = "read-component-archive"u8.ToArray();
        ImmutableArray<byte> module = [1, 2, 3];
        ImmutableArray<AuthoringPackageEntry> entries =
        [
            new("worker/main.wasm", module, Convert.ToHexStringLower(SHA256.HashData(module.AsSpan())))
        ];
        AuthoringExtensionManifest template = AuthoringExtensionContractsTests.CreateManifest();
        AuthoringExtensionManifest manifest = template with
        {
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Contributions = [template.Contributions[0] with
            {
                Entrypoint = template.Contributions[0].Entrypoint with { ContentSha256 = entries[0].ContentSha256 },
                Capabilities = [declaredCapability ?? capability]
            }],
            Limits = template.Limits with { MaximumRequestBytes = requestBytes, MaximumResponseBytes = responseBytes }
        };
        var clock = new AdmissionTimeProvider(original.Envelope.Deadline.AddMinutes(-1));
        var verifier = new AuthoringPackageVerifier(new ReadTrustVerifier(clock, trustLifetime ?? TimeSpan.FromHours(1)),
            new ReadArchiveReader(new AuthoringPackageArchiveContents(
                ImmutableArray.Create(JsonSerializer.SerializeToUtf8Bytes(manifest)), entries)), clock);
        VerifiedAuthoringPackage package = await verifier.VerifyAsync(new AuthoringPackageArtifact(
            ImmutableArray.Create(archive), [1], "acme", "key-1", "approved-source/catalog-1", "provenance/build-1",
            Convert.ToHexStringLower(SHA256.HashData(archive))), AuthoringHostPlatform.ServerLinux);
        var active = new ReadActivePackageAuthority(package);
        var resolver = new AuthoringExecutionResolver(new ClosedTrustedAuthoringAdapterRegistry([]),
            new ReadUnavailableAdapterVerifier(), new ReadUnavailableAdapterVerifier(), active);
        AuthoringExecutionTarget target = await resolver.ResolveAsync(package, manifest.Contributions[0].Id,
            AuthoringHostPlatform.ServerLinux);
        active.Calls = 0;
        var lookup = new ReadGrantLookup();
        var grants = new AuthoringCapabilityGrantAuthority(lookup, clock);
        AuthoringGrantRequest request = CreateGrantRequest() with { Capability = capability, RuntimeIdentity = target.RuntimeIdentity };
        if (capability == AuthoringCapability.DocumentFullRead)
        {
            request = request with { DocumentEpoch = 1, SourceRevision = 2, SnapshotSha256 = original.Envelope.SnapshotSha256 };
        }
        AuthoringCapabilityGrant grant = await grants.IssueAsync(request);
        var reader = new ReadCanonicalTransaction();
        if (selectedText is not null)
        {
            reader.Document = "before " + selectedText + " after";
            reader.Selection = new AuthoringTextRange(7, 7 + selectedText.Length);
        }
        AuthoringRpcEnvelope envelope = original.Envelope with
        {
            Method = method,
            RuntimeIdentity = target.RuntimeIdentity,
            PackageSha256 = manifest.PackageSha256,
            ContentSha256 = manifest.ContentSha256,
            GrantDigest = grant.GrantDigest,
            Payload = new AuthoringRpcPayload(DocumentRange: method == AuthoringRpcMethod.DocumentFullRead
                ? new AuthoringTextRange(0, reader.Document.Length) : reader.Selection)
        };
        reader.ExpectedEnvelope = envelope;
        var authority = new AuthoringExtensionRpcAuthority(grants, reader, new RevisionGate(true), clock, resolver);
        return new ReadFixture(authority, package, envelope, reader, grants, lookup, active, clock, resolver);
    }

    private sealed record ReadFixture(AuthoringExtensionRpcAuthority Authority, VerifiedAuthoringPackage Package,
        AuthoringRpcEnvelope Envelope, ReadCanonicalTransaction Reader, AuthoringCapabilityGrantAuthority Grants,
        ReadGrantLookup Lookup, ReadActivePackageAuthority Active, AdmissionTimeProvider Clock, AuthoringExecutionResolver Resolver);

    private sealed class ReadCanonicalTransaction : IAuthoringCanonicalDocumentReadTransaction
    {
        public string Document { get; set; } = "before SELECTED after";
        public AuthoringTextRange Selection { get; set; } = new(7, 15);
        public long Revision { get; set; } = 2;
        public int ReadCalls { get; private set; }
        public int TransactionCalls { get; private set; }
        public int CurrentChecks { get; private set; }
        public AuthoringRpcEnvelope ExpectedEnvelope { get; set; } = null!;
        public Func<ValueTask>? OnRead { get; set; }
        public Action<int>? OnCurrentCheck { get; set; }
        public Func<AuthoringCanonicalDocumentRead, AuthoringCanonicalDocumentRead>? ChangeObservation { get; set; }

        public async ValueTask<AuthoringCanonicalDocumentRead> ReadSnapshotAsync(
            AuthoringRpcEnvelope envelope, CancellationToken cancellationToken)
        {
            ReadCalls++;
            AuthoringTextRange range = envelope.Payload.DocumentRange!;
            var observation = new AuthoringCanonicalDocumentRead(new AuthoringDocumentSnapshot(
                "document-1", 1, Revision, ExpectedEnvelope.SnapshotSha256, range,
                Document.Substring(range.Start, range.End - range.Start)), Document.Length, Selection);
            if (OnRead is not null)
            {
                await OnRead();
            }
            return ChangeObservation?.Invoke(observation) ?? observation;
        }

        public bool IsCurrentSnapshot(AuthoringRpcEnvelope envelope, AuthoringCanonicalDocumentRead observation)
        {
            CurrentChecks++;
            OnCurrentCheck?.Invoke(CurrentChecks);
            AuthoringTextRange range = observation.Snapshot.IncludedRange;
            return envelope == ExpectedEnvelope && observation.Snapshot.SourceRevision == Revision &&
                observation.DocumentLength == Document.Length &&
                observation.Snapshot.Text == Document.Substring(range.Start, range.End - range.Start) &&
                (envelope.Method != AuthoringRpcMethod.SelectionRead || observation.Selection == Selection);
        }

        public ValueTask<AuthoringTransactionReceipt> ApplyAsync(AuthoringMutationPlan plan, CancellationToken cancellationToken)
        {
            TransactionCalls++;
            throw new InvalidOperationException("Read component must never apply a transaction.");
        }
    }

    // SOURCE COMPONENT_SIMULATION only: these original-store exclusion scopes
    // protect the actual fixture state, not a DTO pretending to be authority.
    private sealed class ReadGrantLookup : IAuthoringCapabilityGrantReadScopeStore
    {
        private readonly object _gate = new();
        private readonly Dictionary<string, AuthoringCapabilityGrant> _grants = new(StringComparer.Ordinal);
        private bool _scopeHeld;
        public bool ScopeHeld => _scopeHeld;
        public int ScopeReleases { get; private set; }
        public Exception? DisposeFailure { get; set; }
        public int Calls { get; private set; }
        public Func<int, ValueTask>? OnLookup { get; set; }
        public async ValueTask<AuthoringCapabilityGrant?> FindAsync(string grantId, CancellationToken cancellationToken)
        {
            Calls++;
            if (OnLookup is not null)
            {
                await OnLookup(Calls);
            }
            lock (_gate)
            {
                return _grants.GetValueOrDefault(grantId);
            }
        }
        public ValueTask StoreAsync(AuthoringCapabilityGrant grant, CancellationToken cancellationToken)
        {
            lock (_gate)
            {
                if (_scopeHeld || !_grants.TryAdd(grant.GrantId, grant))
                {
                    throw new AuthoringExtensionContractException("Grant mutation conflicts with a held read scope.");
                }
            }
            return ValueTask.CompletedTask;
        }
        public ValueTask RevokeAsync(string grantId, CancellationToken cancellationToken)
        {
            lock (_gate)
            {
                if (_scopeHeld)
                {
                    throw new AuthoringExtensionContractException("Grant revoke conflicts with a held read scope.");
                }
                _grants.Remove(grantId);
            }
            return ValueTask.CompletedTask;
        }
        public IAuthoringCapabilityGrantReadScope AcquireReadScope(string grantId)
        {
            if (!Monitor.TryEnter(_gate))
            {
                throw new AuthoringExtensionContractException("Grant store is busy; read does not wait for a scope.");
            }
            if (_scopeHeld || !_grants.TryGetValue(grantId, out AuthoringCapabilityGrant? grant))
            {
                Monitor.Exit(_gate);
                throw new AuthoringExtensionContractException("Grant has no current store-owned read scope.");
            }
            _scopeHeld = true;
            return new ReadGrantScope(this, grant);
        }
        private sealed class ReadGrantScope(ReadGrantLookup owner, AuthoringCapabilityGrant grant)
            : IAuthoringCapabilityGrantReadScope
        {
            private bool _released;
            public AuthoringCapabilityGrant Grant => grant;
            public void Dispose()
            {
                if (!_released)
                {
                    _released = true;
                    owner._scopeHeld = false;
                    owner.ScopeReleases++;
                    Monitor.Exit(owner._gate);
                    if (owner.DisposeFailure is { } failure)
                    {
                        throw failure;
                    }
                }
            }
        }
    }

    private sealed class ReadActivePackageAuthority(VerifiedAuthoringPackage package) : IAuthoringInstalledPackageReadScopeAuthority
    {
        private readonly object _gate = new();
        private bool _active = true;
        private bool _scopeHeld;
        public bool ScopeHeld => _scopeHeld;
        public int ScopeReleases { get; private set; }
        public Exception? DisposeFailure { get; set; }
        public bool Active
        {
            get { lock (_gate) { return _active; } }
            set
            {
                lock (_gate)
                {
                    if (_scopeHeld)
                    {
                        throw new AuthoringExtensionContractException("Package change conflicts with a held read scope.");
                    }
                    _active = value;
                }
            }
        }
        public int Calls { get; set; }
        public ValueTask<bool> IsActiveExactAsync(VerifiedAuthoringPackage candidate, CancellationToken cancellationToken)
        {
            Calls++;
            return ValueTask.FromResult(Active && candidate.PackageIdentity == package.PackageIdentity &&
                candidate.Contract.ContractIdentity == package.Contract.ContractIdentity);
        }
        public IAuthoringInstalledPackageReadScope AcquireActiveReadScope(VerifiedAuthoringPackage candidate)
        {
            if (!Monitor.TryEnter(_gate))
            {
                throw new AuthoringExtensionContractException("Package store is busy; read does not wait for a scope.");
            }
            if (_scopeHeld || !_active || candidate.PackageIdentity != package.PackageIdentity)
            {
                Monitor.Exit(_gate);
                throw new AuthoringExtensionContractException("Package has no current store-owned read scope.");
            }
            _scopeHeld = true;
            return new ReadPackageScope(this, package);
        }
        private sealed class ReadPackageScope(ReadActivePackageAuthority owner, VerifiedAuthoringPackage active)
            : IAuthoringInstalledPackageReadScope
        {
            private bool _released;
            public VerifiedAuthoringPackage ActivePackage => active;
            public void Dispose()
            {
                if (!_released)
                {
                    _released = true;
                    owner._scopeHeld = false;
                    owner.ScopeReleases++;
                    Monitor.Exit(owner._gate);
                    if (owner.DisposeFailure is { } failure)
                    {
                        throw failure;
                    }
                }
            }
        }
    }

    private sealed class ReadUnscopedActiveAuthority(ReadActivePackageAuthority authority)
        : IAuthoringInstalledPackageAuthority
    {
        public ValueTask<bool> IsActiveExactAsync(VerifiedAuthoringPackage package, CancellationToken cancellationToken) =>
            authority.IsActiveExactAsync(package, cancellationToken);
    }

    private sealed class ReadUnscopedGrantStore(ReadGrantLookup store) : IAuthoringCapabilityGrantStore
    {
        public ValueTask<AuthoringCapabilityGrant?> FindAsync(string id, CancellationToken ct) => store.FindAsync(id, ct);
        public ValueTask StoreAsync(AuthoringCapabilityGrant grant, CancellationToken ct) => store.StoreAsync(grant, ct);
        public ValueTask RevokeAsync(string id, CancellationToken ct) => store.RevokeAsync(id, ct);
    }

    private sealed class ReadUnavailableAdapterVerifier : ITrustedAuthoringAdapterSourceVerifier, ITrustedAuthoringAdapterModuleVerifier
    {
        public ValueTask<bool> IsCheckedInSourceExactAsync(TrustedAuthoringAdapterDescriptor descriptor, CancellationToken cancellationToken) => ValueTask.FromResult(false);
        public ValueTask<bool> IsLoadedModuleExactAsync(TrustedAuthoringAdapterDescriptor descriptor, CancellationToken cancellationToken) => ValueTask.FromResult(false);
    }

    private sealed class ReadTrustVerifier(TimeProvider clock, TimeSpan lifetime) : IAuthoringPackageTrustVerifier
    {
        public ValueTask<AuthoringPackageTrustDecision> VerifyAsync(string publisher, string keyId,
            ReadOnlyMemory<byte> archive, ReadOnlyMemory<byte> signature, CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringPackageTrustDecision(AuthoringPackageTrustStatus.Trusted,
                publisher, keyId, clock.GetUtcNow(), clock.GetUtcNow() + lifetime, new string('1', 64)));
    }

    private sealed class ReadArchiveReader(AuthoringPackageArchiveContents contents) : IAuthoringPackageArchiveReader
    {
        public ValueTask<AuthoringPackageArchiveContents> ReadAsync(ReadOnlyMemory<byte> archive,
            CancellationToken cancellationToken) => ValueTask.FromResult(contents);
    }

    private static AuthoringMutationApproval PreviewFor(AuthoringRpcEnvelope envelope, AuthoringMutationApproval approval)
        => approval with { PreviewDigest = AuthoringExtensionRpcAuthority.ComputeMutationPreviewDigest(envelope) };

    private static async ValueTask<RpcFixture> CreateFixtureAsync(
        bool storeGrant = true,
        bool currentRevision = true,
        bool tamperReceipt = false)
    {
        DateTimeOffset now = new(639265824000000000L, TimeSpan.Zero);
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
            "f89348136d888080a251c21c08a688ffcf4605eea20d1c1cb04dbcfb6c658d1b");
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
        public AuthoringMutationPlan? LastPlan { get; private set; }

        public int CallCount
        {
            get; private set;
        }

        public ValueTask<AuthoringTransactionReceipt> ApplyAsync(
            AuthoringMutationPlan plan,
            CancellationToken cancellationToken)
        {
            CallCount++;
            LastPlan = plan;
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

    private static void AssertRpcTypeHasNoLiveEditorOrDirectMutationAuthority(Type type)
    {
        string compiled = DescribeRpcTypeTree(type);
        Assert.DoesNotContain("editorRef", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Pinia", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("IServiceProvider", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("innerHTML", compiled, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("splice", compiled, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Delegate", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Callback", compiled, StringComparison.Ordinal);
    }

    private static string DescribeRpcTypeTree(Type type) => string.Join('\n',
        EnumerateRpcTypeTree(type).SelectMany(candidate => new[]
        {
            RuntimeMetadataInspection.DescribeType(candidate),
            RuntimeMetadataInspection.DescribeConstructors(candidate)
        }));

    private static IEnumerable<Type> EnumerateRpcTypeTree(Type type)
    {
        yield return type;
        foreach (Type nested in type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
        {
            foreach (Type descendant in EnumerateRpcTypeTree(nested))
            {
                yield return descendant;
            }
        }
    }

    private static class UncalledNestedFixture
    {
        private static class Entry
        {
            public static void Read() => GC.KeepAlive("splice");
        }
    }

    private static class ContractOnlyFixture
    {
        private static class Entry
        {
            public static string Read() => "rpc-contract-safe";
        }
    }
}
