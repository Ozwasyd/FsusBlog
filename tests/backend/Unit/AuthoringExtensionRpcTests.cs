using System.Collections.Immutable;
using System.Reflection;

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

        Task<AuthoringTransactionReceipt> pending = authority.ApplyMutationAsync(envelope, fixture.Approval).AsTask();
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
        AuthoringTransactionReceipt receipt = await authority.ApplyMutationAsync(retry, fixture.Approval);
        Assert.Equal(envelope.Payload.MutationPlan!.PlanId, receipt.PlanId);
        Assert.Equal(2, gate.CallCount);
        Assert.Equal(1, fixture.Transaction.CallCount);
        AuthoringExtensionContractException duplicate = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
            async () => await authority.ApplyMutationAsync(retry, fixture.Approval));
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
        AuthoringTransactionReceipt receipt = await authority.ApplyMutationAsync(retry, fixture.Approval);
        Assert.Equal(fixture.Envelope.Payload.MutationPlan!.PlanId, receipt.PlanId);
        Assert.Equal(1, fixture.Transaction.CallCount);
        AuthoringExtensionContractException duplicate = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
            async () => await authority.ApplyMutationAsync(retry, fixture.Approval));
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
        if (deadlineOffsetTicks >= 0)
        {
            AuthoringTransactionReceipt receipt = await authority.ApplyMutationAsync(retry, fixture.Approval);
            Assert.Equal(fixture.Envelope.Payload.MutationPlan!.PlanId, receipt.PlanId);
            Assert.Equal(2, gate.CallCount);
            Assert.Equal(1, fixture.Transaction.CallCount);
        }

        AuthoringExtensionContractException duplicate = await Assert.ThrowsAsync<AuthoringExtensionContractException>(
            async () => await authority.ApplyMutationAsync(retry, fixture.Approval));
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
