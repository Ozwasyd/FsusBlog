using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Services.Security;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityChallengeKindCutoverTests
{
    private static readonly SecurityChallengeKindCutoverTarget[] s_targets =
    [
        new(3, string.Concat("cap", "tchaV1")),
        new(10, string.Concat("perception", "CharacterV2")),
        new(13, string.Concat("perception", "TextTaskV2"))
    ];

    [Fact]
    public async Task Execute_BindsMutationToExactActiveFence_AndReturnsAuditableReceipt()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(Verified());
        var store = new RecordingStore(new(7, 5, 4, 2, ["envelope-b", "envelope-a"]));
        var sut = new SecurityChallengeKindCutover(fence, store, TimeProvider.System);

        SecurityChallengeKindCutoverReceipt receipt = await sut.ExecuteAsync(Request());

        Assert.True(receipt.Accepted);
        Assert.False(receipt.Idempotent);
        Assert.Equal("applied", receipt.Status);
        Assert.True(receipt.FenceVerifiedBefore);
        Assert.True(receipt.FenceVerifiedImmediatelyBeforeMutation);
        Assert.True(receipt.FenceVerifiedAfter);
        Assert.Equal([3, 10, 13], receipt.NumericKinds);
        Assert.Equal(SecurityChallengeKindCutover.ComputeTargetFingerprint(s_targets), receipt.TargetFingerprint);
        Assert.Equal(7, receipt.V2AttemptKeys);
        Assert.Equal(5, receipt.V2UsedKeys);
        Assert.Equal(4, receipt.EnvelopesExamined);
        Assert.Equal(2, receipt.EnvelopesRevoked);
        Assert.Matches("^[a-f0-9]{64}$", receipt.RevokedEnvelopeIdsDigest);
        Assert.DoesNotContain("envelope-a", System.Text.Json.JsonSerializer.Serialize(receipt), StringComparison.Ordinal);
        Assert.Equal(SecurityChallengeKindCutover.ReceiptSchemaVersion, receipt.SchemaVersion);
        await fence.Received(3).VerifyAsync(
            Arg.Is<ActiveReleaseFenceVerifyRequest>(request =>
                request.ReleaseId == "release-a"
                && request.Slot == "green"
                && request.Generation == 42
                && request.RequireActive),
            Arg.Any<CancellationToken>());
        Assert.Equal(1, store.ApplyCount);
    }

    [Fact]
    public async Task Execute_RejectsIncompleteOrDifferentNumericTargetSet()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        var store = new RecordingStore(new(0, 0, 0, 0, []));
        var sut = new SecurityChallengeKindCutover(fence, store, TimeProvider.System);
        SecurityChallengeKindCutoverRequest request = Request() with
        {
            Targets = [new(3, "retired/three"), new(10, "retired/ten"), new(14, "retired/other")]
        };

        ArgumentException error = await Assert.ThrowsAsync<ArgumentException>(() => sut.ExecuteAsync(request));

        Assert.Contains("complete retired numeric set", error.Message, StringComparison.Ordinal);
        Assert.Equal(0, store.ApplyCount);
        await fence.DidNotReceive().VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Execute_FreshOperationRejectsWrongWireMappingBeforeIntentOrMutation()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        var store = new RecordingStore(new(0, 0, 0, 0, []));
        var sut = new SecurityChallengeKindCutover(fence, store, TimeProvider.System);
        SecurityChallengeKindCutoverRequest request = Request() with
        {
            Targets = [s_targets[0], new(10, "localization/v2"), s_targets[2]]
        };

        ArgumentException error = await Assert.ThrowsAsync<ArgumentException>(() => sut.ExecuteAsync(request));

        Assert.Contains("authoritative retired mapping", error.Message, StringComparison.Ordinal);
        Assert.Equal(0, store.PrepareCreateCount);
        Assert.Equal(0, store.ApplyCount);
    }

    [Fact]
    public async Task Execute_SameOperationIdWithRemappedWireCannotReuseReceipt()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(Verified());
        var store = new RecordingStore(new(0, 0, 0, 0, []));
        var sut = new SecurityChallengeKindCutover(fence, store, TimeProvider.System);
        await sut.ExecuteAsync(Request());
        SecurityChallengeKindCutoverRequest remapped = Request() with
        {
            ReleaseId = "release-b"
        };

        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.ExecuteAsync(remapped));

        Assert.Equal(1, store.ApplyCount);
    }

    [Fact]
    public async Task Execute_RepeatedOperationIsIdempotent_WithoutSecondMutation()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(Verified());
        var store = new RecordingStore(new(1, 1, 1, 1, ["envelope-a"]));
        var sut = new SecurityChallengeKindCutover(fence, store, TimeProvider.System);

        SecurityChallengeKindCutoverReceipt first = await sut.ExecuteAsync(Request());
        SecurityChallengeKindCutoverReceipt repeated = await sut.ExecuteAsync(Request());

        Assert.True(first.Accepted);
        Assert.True(repeated.Accepted);
        Assert.True(repeated.Idempotent);
        Assert.Equal(first.RequestFingerprint, repeated.RequestFingerprint);
        Assert.Equal(1, store.ApplyCount);
        await fence.Received(3).VerifyAsync(
            Arg.Any<ActiveReleaseFenceVerifyRequest>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Execute_FenceLossImmediatelyBeforeMutation_PersistsRejectWithoutMutation()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(Verified(), Rejected("active_release_generation_mismatch"));
        var store = new RecordingStore(new(1, 1, 1, 1, ["digest-a"]));
        var sut = new SecurityChallengeKindCutover(fence, store, TimeProvider.System);

        SecurityChallengeKindCutoverReceipt receipt = await sut.ExecuteAsync(Request());

        Assert.False(receipt.Accepted);
        Assert.Equal("fence-lost-before-mutation", receipt.Status);
        Assert.True(receipt.FenceVerifiedBefore);
        Assert.False(receipt.FenceVerifiedImmediatelyBeforeMutation);
        Assert.False(receipt.FenceVerifiedAfter);
        Assert.Equal(0, store.ApplyCount);
    }

    [Fact]
    public async Task Execute_FenceLossAfterMutation_PersistsManualBlockedReceiptWithRecordedProgress()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(Verified(), Verified(), Rejected("active_release_generation_mismatch"));
        var store = new RecordingStore(new(7, 5, 4, 2, ["digest-a", "digest-b"]));
        var sut = new SecurityChallengeKindCutover(fence, store, TimeProvider.System);

        SecurityChallengeKindCutoverReceipt receipt = await sut.ExecuteAsync(Request());

        Assert.False(receipt.Accepted);
        Assert.Equal("manual-blocked-fence-lost-after-mutation", receipt.Status);
        Assert.True(receipt.FenceVerifiedBefore);
        Assert.True(receipt.FenceVerifiedImmediatelyBeforeMutation);
        Assert.False(receipt.FenceVerifiedAfter);
        Assert.Equal(7, receipt.V2AttemptKeys);
        Assert.Equal(2, receipt.EnvelopesRevoked);
        Assert.Equal(SecurityChallengeKindCutover.FenceLostAfterMutationStatus, store.Status);
        Assert.Equal(1, store.ApplyCount);
    }

    [Fact]
    public async Task Execute_ReceiptWriteCrash_ResumesFromDurableMutationProgressWithoutReapplying()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(Verified());
        var store = new RecordingStore(new(7, 5, 4, 2, ["digest-a", "digest-b"]))
        {
            FailNextSave = true
        };
        var sut = new SecurityChallengeKindCutover(fence, store, TimeProvider.System);

        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.ExecuteAsync(Request()));
        SecurityChallengeKindCutoverReceipt recovered = await sut.ExecuteAsync(Request());

        Assert.True(recovered.Accepted);
        Assert.Equal(7, recovered.V2AttemptKeys);
        Assert.Equal(5, recovered.V2UsedKeys);
        Assert.Equal(2, recovered.EnvelopesRevoked);
        Assert.Equal(1, store.ApplyCount);
        Assert.Equal(1, store.PrepareCreateCount);
    }

    [Fact]
    public async Task Execute_DurableIntentBlocksTargetRemapAfterReceiptWriteCrash()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(Verified());
        var store = new RecordingStore(new(1, 1, 1, 1, ["digest-a"]))
        {
            FailNextSave = true
        };
        var sut = new SecurityChallengeKindCutover(fence, store, TimeProvider.System);
        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.ExecuteAsync(Request()));
        SecurityChallengeKindCutoverRequest remapped = Request() with
        {
            ReleaseId = "release-b"
        };

        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.ExecuteAsync(remapped));

        Assert.Equal(1, store.ApplyCount);
        Assert.Equal(1, store.PrepareCreateCount);
    }

    [Fact]
    public async Task Execute_IntentOnlyPrepareCrashRepairsDurableStateAndResumesSameOperation()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(Verified());
        var store = new RecordingStore(new(1, 1, 1, 1, ["digest-a"]))
        {
            FailAfterIntentWriteOnNextPrepare = true
        };
        var sut = new SecurityChallengeKindCutover(fence, store, TimeProvider.System);

        await Assert.ThrowsAsync<InvalidOperationException>(() => sut.ExecuteAsync(Request()));
        SecurityChallengeKindCutoverReceipt resumed = await sut.ExecuteAsync(Request());

        Assert.True(resumed.Accepted);
        Assert.Equal(1, store.PrepareCreateCount);
        Assert.Equal(1, store.StateRepairCount);
        Assert.Equal(1, store.ApplyCount);
    }

    [Fact]
    public async Task Execute_RejectsBeforeMutation_WhenFenceIdentityDoesNotMatch()
    {
        IActiveReleaseFence fence = Substitute.For<IActiveReleaseFence>();
        fence.VerifyAsync(Arg.Any<ActiveReleaseFenceVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(Rejected("active_release_generation_mismatch"));
        var store = new RecordingStore(new(1, 1, 1, 1, ["envelope-a"]));
        var sut = new SecurityChallengeKindCutover(fence, store, TimeProvider.System);

        SecurityChallengeKindCutoverReceipt receipt = await sut.ExecuteAsync(Request());

        Assert.False(receipt.Accepted);
        Assert.Equal("rejected", receipt.Status);
        Assert.Equal("active_release_generation_mismatch", receipt.ErrorCode);
        Assert.False(receipt.FenceVerifiedBefore);
        Assert.Equal(0, store.ApplyCount);
    }

    [Fact]
    public void EnvelopeCodec_RevokesWholeMixedEnvelope_AndLeavesUnrelatedEnvelopeUntouched()
    {
        SecurityChallengeEnvelopeState mixed = Envelope(
            [s_targets[1].WireName, "localization/v2"],
            [SecurityChallengeEnvelopeMemberStatuses.Verified, SecurityChallengeEnvelopeMemberStatuses.Issued]);
        SecurityChallengeEnvelopeState unrelated = Envelope(
            ["localization/v2", "micro/v2"],
            [SecurityChallengeEnvelopeMemberStatuses.Issued, SecurityChallengeEnvelopeMemberStatuses.Issued]);
        HashSet<string> wires = s_targets.Select(static target => target.WireName).ToHashSet(StringComparer.Ordinal);

        bool changed = SecurityChallengeKindCutoverEnvelopeCodec.TryBuildRevocation(
            SecurityChallengeKindCutoverEnvelopeCodec.Encode(mixed),
            wires,
            out string replacement,
            out string? envelopeId);
        bool unrelatedChanged = SecurityChallengeKindCutoverEnvelopeCodec.TryBuildRevocation(
            SecurityChallengeKindCutoverEnvelopeCodec.Encode(unrelated),
            wires,
            out _,
            out _);

        Assert.True(changed);
        Assert.False(unrelatedChanged);
        Assert.Equal(mixed.EnvelopeId, envelopeId);
        Assert.True(SecurityChallengeKindCutoverEnvelopeCodec.TryDecode(replacement, out SecurityChallengeEnvelopeState? revoked));
        Assert.NotNull(revoked);
        Assert.Equal(SecurityChallengeEnvelopeStatuses.Revoked, revoked.Status);
        Assert.All(revoked.MemberStatuses, status => Assert.Equal(SecurityChallengeEnvelopeMemberStatuses.Revoked, status));
        Assert.Equal(mixed.Version + 1, revoked.Version);
        Assert.Equal("challenge_kind_cutover", revoked.TerminalReason);
        Assert.Null(revoked.ProofToken);
    }

    [Theory]
    [InlineData(SecurityChallengeEnvelopeStatuses.Completed)]
    [InlineData(SecurityChallengeEnvelopeStatuses.Failed)]
    [InlineData(SecurityChallengeEnvelopeStatuses.Expired)]
    [InlineData(SecurityChallengeEnvelopeStatuses.Revoked)]
    public void EnvelopeCodec_PreservesTerminalEnvelopeEvidence(string terminalStatus)
    {
        SecurityChallengeEnvelopeState terminal = Envelope(
            [s_targets[1].WireName, "localization/v2"],
            [SecurityChallengeEnvelopeMemberStatuses.Verified, SecurityChallengeEnvelopeMemberStatuses.Issued],
            terminalStatus);
        HashSet<string> wires = s_targets.Select(static target => target.WireName).ToHashSet(StringComparer.Ordinal);

        bool changed = SecurityChallengeKindCutoverEnvelopeCodec.TryBuildRevocation(
            SecurityChallengeKindCutoverEnvelopeCodec.Encode(terminal),
            wires,
            out _,
            out _);

        Assert.False(changed);
    }

    [Theory]
    [InlineData(SecurityChallengeEnvelopeStatuses.Active)]
    [InlineData(SecurityChallengeEnvelopeStatuses.ProofMinting)]
    public void EnvelopeCodec_RevokesOnlyExplicitNonTerminalStates(string nonTerminalStatus)
    {
        SecurityChallengeEnvelopeState state = Envelope(
            [s_targets[1].WireName, "localization/v2"],
            [SecurityChallengeEnvelopeMemberStatuses.Verified, SecurityChallengeEnvelopeMemberStatuses.Issued],
            nonTerminalStatus);
        HashSet<string> wires = s_targets.Select(static target => target.WireName).ToHashSet(StringComparer.Ordinal);

        Assert.True(SecurityChallengeKindCutoverEnvelopeCodec.TryBuildRevocation(
            SecurityChallengeKindCutoverEnvelopeCodec.Encode(state),
            wires,
            out _,
            out _));
    }

    [Fact]
    public void RedisStore_ClearsSharedV2NamespacesWithoutFilteringByKind()
    {
        string runtime = RuntimeMetadataInspection.DescribeMethods(
            typeof(RedisSecurityChallengeKindCutoverStore),
            nameof(RedisSecurityChallengeKindCutoverStore.ApplyAsync));

        Assert.Contains("security:challenge:v2:attempt:*", runtime, StringComparison.Ordinal);
        Assert.Contains("security:challenge:v2:used:*", runtime, StringComparison.Ordinal);
        Assert.Contains("EnvelopePattern", runtime, StringComparison.Ordinal);
        Assert.Contains("TryBuildRevocation", runtime, StringComparison.Ordinal);
    }

    private static SecurityChallengeKindCutoverRequest Request()
        => new("operation-a", "release-a", "green", 42, s_targets);

    private static ActiveReleaseFenceOperationResult Verified()
        => FenceResult(true, "verified", null);

    private static ActiveReleaseFenceOperationResult Rejected(string errorCode)
        => FenceResult(false, "rejected", errorCode);

    private static ActiveReleaseFenceOperationResult FenceResult(bool accepted, string status, string? errorCode)
        => new(
            accepted,
            accepted,
            status,
            errorCode,
            false,
            new ActiveReleaseFenceSnapshot(
                true,
                ActiveReleaseFenceStatuses.Active,
                "release-a",
                "green",
                42,
                "sha256:test",
                DateTimeOffset.UtcNow,
                null));

    private static SecurityChallengeEnvelopeState Envelope(
        string[] kinds,
        string[] statuses,
        string envelopeStatus = SecurityChallengeEnvelopeStatuses.Active)
        => new(
            Guid.CreateVersion7().ToString("D"),
            "comment.create",
            "/api/comment",
            "subject",
            "ip",
            "device",
            "policy",
            Enumerable.Range(0, kinds.Length).Select(_ => Guid.CreateVersion7().ToString("D")).ToArray(),
            kinds,
            statuses,
            1,
            2,
            envelopeStatus,
            4,
            ProofToken: "proof",
            ProofNonce: "nonce",
            ProofIssuedAtUnixMs: 1,
            ProofExpiresAtUnixMs: 2);

    private sealed class RecordingStore(SecurityChallengeKindCutoverMutationResult mutation)
        : ISecurityChallengeKindCutoverStore
    {
        private SecurityChallengeKindCutoverReceipt? _receipt;
        private SecurityChallengeKindCutoverIntent? _intent;

        public bool FailNextSave
        {
            get;
            set;
        }

        public bool FailAfterIntentWriteOnNextPrepare
        {
            get;
            set;
        }

        public int StateRepairCount
        {
            get;
            private set;
        }

        private bool StateInitialized
        {
            get;
            set;
        }

        public string Status
        {
            get;
            private set;
        } = SecurityChallengeKindCutover.PreparedStatus;

        public int PrepareCreateCount
        {
            get;
            private set;
        }

        public int ApplyCount
        {
            get;
            private set;
        }

        public Task<SecurityChallengeKindCutoverPreparation> PrepareAsync(
            SecurityChallengeKindCutoverIntent intent,
            CancellationToken cancellationToken = default)
        {
            if (_intent is null)
            {
                _intent = intent;
                PrepareCreateCount++;
                if (FailAfterIntentWriteOnNextPrepare)
                {
                    FailAfterIntentWriteOnNextPrepare = false;
                    throw new InvalidOperationException("simulated crash after intent write");
                }
            }
            if (!StateInitialized)
            {
                StateInitialized = true;
                StateRepairCount++;
            }
            return Task.FromResult(new SecurityChallengeKindCutoverPreparation(_intent, Status, _receipt));
        }

        public Task<SecurityChallengeKindCutoverMutationResult> ApplyAsync(
            SecurityChallengeKindCutoverRequest request,
            CancellationToken cancellationToken = default)
        {
            ApplyCount++;
            Status = SecurityChallengeKindCutover.MutationRecordedStatus;
            return Task.FromResult(mutation);
        }

        public Task<SecurityChallengeKindCutoverMutationResult> ReadMutationResultAsync(
            string operationId,
            CancellationToken cancellationToken = default)
            => Task.FromResult(mutation);

        public Task<SecurityChallengeKindCutoverReceipt?> ReadReceiptAsync(
            string operationId,
            CancellationToken cancellationToken = default)
            => Task.FromResult(_receipt);

        public Task MarkStatusAsync(
            string operationId,
            string requestFingerprint,
            string status,
            CancellationToken cancellationToken = default)
        {
            Status = status;
            return Task.CompletedTask;
        }

        public Task<SecurityChallengeKindCutoverReceipt> SaveReceiptAsync(
            SecurityChallengeKindCutoverReceipt receipt,
            CancellationToken cancellationToken = default)
        {
            if (FailNextSave && _receipt is null)
            {
                FailNextSave = false;
                throw new InvalidOperationException("simulated receipt write crash");
            }
            _receipt ??= receipt;
            return Task.FromResult(_receipt);
        }
    }
}
