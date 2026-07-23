using System.Diagnostics;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class PerceptionCharacterV3Tests
{
    private static readonly string s_root = BackendTestPaths.RepositoryRoot;
    private static JsonElement Vectors => JsonDocument.Parse(File.ReadAllBytes(Path.Combine(s_root, "tests/fixtures/security/perception-character-v3-vectors.json"))).RootElement.Clone();

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task DefaultDisabledConfigurationMapsAndStartsBinaryCancelRouteWithoutV3KeyServices()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        EndpointContractApplication.AddContractServices(builder);
        await using WebApplication app = builder.Build();
        app.MapBinaryEndpoints();

        Assert.Null(app.Services.GetService<IPerceptionCharacterV3KeyRing>());
        Assert.Null(app.Services.GetService<IPerceptionCharacterV3AuditSink>());
        await app.StartAsync();
        Assert.NotNull(EndpointContractApplication.Find(app, "/api/binary/security/challenge/cancel", HttpMethods.Post).RequestDelegate);
    }

    [Fact]
    public void CanonicalIdentity_HasNoLegacyAlias()
    {
        Assert.Equal(SecurityChallengeKind.PerceptionCharacterV3, Parse(PerceptionCharacterV3Contracts.WireName));
        Assert.Equal(PerceptionCharacterV3Contracts.Algorithm, PerceptionCharacterV3CanonicalContract.Value.Algorithm);
        foreach (string alias in new[] { "perceptionLocalizationV2", "perceptionMicroInteractionV2" })
            Assert.NotEqual(SecurityChallengeKind.PerceptionCharacterV3, Parse(alias));
        SecurityChallengeCapability capability = SecurityChallengeCapabilityCatalog.Get(SecurityChallengeKind.PerceptionCharacterV3);
        Assert.True(capability.ProviderAvailable);
        Assert.True(capability.UiExecutorAvailable);
        Assert.False(SecurityChallengeCapabilityCatalog.Resolve(SecurityChallengeKind.PerceptionCharacterV3, "notification.subscribe", SecurityChallengeExecutionMode.Headless).PolicyEligible);
    }

    [Fact]
    public void AnswerSampling_RejectionAndNormalizationAreExact()
    {
        var bytes = new Queue<byte>(new byte[] { 234, 255, 0, 25, 26, 51, 52 });
        Assert.Equal("A9A9A", PerceptionCharacterV3Crypto.SampleAnswer(_ => [bytes.Dequeue()]));
        Assert.Equal("A7C9Q", PerceptionCharacterV3Crypto.NormalizeAnswer(" a7\tC\n9q "));
        Assert.Null(PerceptionCharacterV3Crypto.NormalizeAnswer("Ａ7C9Q"));
    }

    [Fact]
    public void CanonicalCrypto_MatchesLanguageNeutralVectorsByteForByte()
    {
        JsonElement root = Vectors;
        PerceptionCharacterV3BindingContext context = Context(root);
        byte[] answerKey = Convert.FromHexString(root.GetProperty("answer").GetProperty("keyHex").GetString()!);
        Assert.Equal(root.GetProperty("answer").GetProperty("materialHex").GetString(), Convert.ToHexStringLower(PerceptionCharacterV3Crypto.EncodeAnswerMaterial(context, " a7\tC\n9q ")));
        Assert.Equal(root.GetProperty("answer").GetProperty("tagHex").GetString(), Convert.ToHexStringLower(PerceptionCharacterV3Crypto.ComputeAnswerTag(answerKey, context, " a7\tC\n9q ")));
        byte[] tag = Convert.FromHexString(root.GetProperty("answer").GetProperty("tagHex").GetString()!);
        var state = new PerceptionCharacterV3State(tag, context.ArtifactHash, context.MediaType, context.PhysicalWidth, context.PhysicalHeight, context.DisplayWidth, context.DisplayHeight,
            context.ChallengeId, context.EnvelopeId, context.Action, context.RouteKey, context.SubjectHash, context.DeviceBindingHash, context.ClientIpBindingHash, context.PolicyVersion, 2,
            context.Representation, context.IssuedAtUnixMs, context.ExpiresAtUnixMs, context.TokenKeyVersion, root.GetProperty("state").GetProperty("answerKeyVersion").GetString()!);
        Assert.Equal(root.GetProperty("state").GetProperty("aadHex").GetString(), Convert.ToHexStringLower(PerceptionCharacterV3Crypto.EncodeAad(context)));
        Assert.Equal(root.GetProperty("state").GetProperty("plaintextHex").GetString(), Convert.ToHexStringLower(PerceptionCharacterV3Crypto.EncodeState(state)));
        byte[] tokenKey = Convert.FromHexString(root.GetProperty("state").GetProperty("tokenKeyHex").GetString()!);
        string token = PerceptionCharacterV3Crypto.SealState(tokenKey, context, state, new FixedNonce(Convert.FromHexString(root.GetProperty("state").GetProperty("nonceHex").GetString()!)));
        Assert.Equal(root.GetProperty("state").GetProperty("token").GetString(), token);
        Assert.True(PerceptionCharacterV3Crypto.TryOpenState(tokenKey, token, context, out PerceptionCharacterV3State? opened));
        Assert.NotNull(opened);
        Assert.Equal(PerceptionCharacterV3Crypto.EncodeState(state), PerceptionCharacterV3Crypto.EncodeState(opened));
        Assert.False(PerceptionCharacterV3Crypto.TryOpenState(
            tokenKey,
            Convert.ToBase64String(Encoding.UTF8.GetBytes("retired-v3-state-layout")),
            context,
            out _));
    }

    [Fact]
    public void FinalMediaVectors_AreAcceptedAndRetiredMediaIsRejected()
    {
        string challenge = Guid.CreateVersion7().ToString("D");
        string envelope = Guid.CreateVersion7().ToString("D");
        var visual = Issue(challenge, envelope, PerceptionCharacterV3Representation.Visual, VisualArtifact());
        var audio = Issue(challenge, envelope, PerceptionCharacterV3Representation.Audio, AudioArtifact());
        Assert.True(PerceptionCharacterV3Contracts.ValidateIssue(visual).IsValid);
        Assert.True(PerceptionCharacterV3Contracts.ValidateIssue(audio).IsValid);
        Assert.False(PerceptionCharacterV3Contracts.ValidateIssue(visual with
        {
            MediaType = "application/x-fsus-gray8",
            MediaBytes = new byte[98_304],
            PhysicalWidth = 512,
            PhysicalHeight = 192
        }).IsValid);
        Assert.False(PerceptionCharacterV3Contracts.ValidateIssue(audio with
        {
            MediaType = "audio/wav"
        }).IsValid);
        byte[] badPngCrc = [.. visual.MediaBytes];
        badPngCrc[40] ^= 1;
        Assert.False(PerceptionCharacterV3Contracts.ValidateIssue(visual with
        {
            MediaBytes = badPngCrc
        }).IsValid);
        Assert.False(PerceptionCharacterV3Contracts.ValidateIssue(visual with
        {
            MediaBytes = [.. visual.MediaBytes, 0]
        }).IsValid);
        byte[] badOggCrc = [.. audio.MediaBytes];
        badOggCrc[22] ^= 1;
        Assert.False(PerceptionCharacterV3Contracts.ValidateIssue(audio with
        {
            MediaBytes = badOggCrc
        }).IsValid);
        byte[] polyglot = [.. audio.MediaBytes, .. Encoding.ASCII.GetBytes("OpusHeadOpusTags")];
        Assert.False(PerceptionCharacterV3Contracts.ValidateIssue(audio with
        {
            MediaBytes = polyglot
        }).IsValid);
    }

    [Fact]
    public void TypedAedsUnion_RoundTripsAndRejectsMalformedOversizedTruncatedAndUnknownKind()
    {
        string challenge = Guid.CreateVersion7().ToString("D"), envelope = Guid.CreateVersion7().ToString("D");
        byte[] media = VisualArtifact();
        var issue = Issue(challenge, envelope, PerceptionCharacterV3Representation.Visual, media);
        byte[] encoded = PodBinaryCodec.EncodePerceptionCharacterV3Issue(issue);
        Assert.True(PodBinaryCodec.TryDecodePerceptionCharacterV3Issue(encoded, out PerceptionCharacterV3IssuePayload decoded));
        Assert.Equal(issue.MediaBytes, decoded.MediaBytes);
        Assert.False(PodBinaryCodec.TryDecodePerceptionCharacterV3Issue(encoded[..^1], out _));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodePerceptionCharacterV3Issue(issue with { MediaBytes = new byte[32 * 1024 + 1] }));
        encoded[0] = 99;
        Assert.False(PodBinaryCodec.TryDecodePerceptionCharacterV3Issue(encoded, out _));
        var verify = new PerceptionCharacterV3VerifyPayload(PerceptionCharacterV3Contracts.Algorithm, challenge, envelope, PerceptionCharacterV3Representation.Visual, "A7C9Q", "opaque");
        Assert.False(PerceptionCharacterV3Contracts.ValidateVerify(verify with
        {
            Algorithm = "fsu.challenge/perception-character-raster@v3"
        }).IsValid);
        byte[] verifyBytes = PodBinaryCodec.EncodePerceptionCharacterV3Verify(verify);
        Assert.True(PodBinaryCodec.TryDecodePerceptionCharacterV3Verify(verifyBytes, out PerceptionCharacterV3VerifyPayload verifyDecoded));
        Assert.Equal(verify, verifyDecoded);
        for (int i = 0; i < Math.Min(64, verifyBytes.Length); i++)
            Assert.False(PodBinaryCodec.TryDecodePerceptionCharacterV3Verify(verifyBytes.AsMemory(0, i), out _));
        var assignment = new SecurityChallengeAssignment(challenge, "trace", "tenant", SecurityChallengeKind.PerceptionCharacterV3, 1, "comment.create", "/api/binary/comment", new string('1', 64), new string('2', 64), new string('3', 64), 1, 2);
        var outerIssue = new SecurityChallengeIssueBinaryResponse(SecurityChallengeDecisionKind.Challenge, 0, 0, 1, "p1", 0, new SecurityChallengeEnvelope(envelope, "p1", [assignment]), [new SecurityChallengeProviderPayload(challenge, string.Empty) { PerceptionCharacterV3 = issue }]);
        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeIssueResponse(PodBinaryCodec.EncodeSecurityChallengeIssueResponse(outerIssue), out SecurityChallengeIssueBinaryResponse outerDecoded));
        Assert.NotNull(Assert.Single(outerDecoded.ProviderPayloads).PerceptionCharacterV3);
        var outerVerify = new SecurityChallengeVerifyBinaryRequest(envelope, challenge, SecurityChallengeKind.PerceptionCharacterV3, "comment.create", "/api/binary/comment", string.Empty) { PerceptionCharacterV3 = verify };
        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeVerifyRequest(PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(outerVerify), out SecurityChallengeVerifyBinaryRequest outerVerifyDecoded));
        Assert.NotNull(outerVerifyDecoded.PerceptionCharacterV3);
        Assert.Empty(outerVerifyDecoded.ProviderPayloadJson);
    }

    [Fact]
    public void PublicIssueContract_HasNoTruthBearingFields()
    {
        string[] names = typeof(PerceptionCharacterV3IssuePayload).GetProperties().Select(p => p.Name).ToArray();
        foreach (string forbidden in PerceptionCharacterV3CanonicalContract.Value.Answer.Alphabet.Length > 0
            ? new[] { "AnswerHash", "AnswerTag", "ExpectedAnswer", "GlyphId", "GlyphVariant", "RasterSeed", "Recipe", "Signature", "SolveDurationMs", "WarpLattice" } : [])
            Assert.DoesNotContain(forbidden, names, StringComparer.OrdinalIgnoreCase);
        string[] verify = typeof(PerceptionCharacterV3VerifyPayload).GetProperties().Select(p => p.Name).ToArray();
        Assert.Equal(new[] { "Algorithm", "ChallengeId", "EnvelopeId", "Representation", "Answer", "StateToken" }, verify);
    }

    [Fact]
    public void KeyRing_FailsClosedForMissingShortEqualUnknownAndCheckedInKeys()
    {
        Assert.Throws<InvalidOperationException>(() => CreateKeys(new Dictionary<string, string?>()));
        Assert.Throws<InvalidOperationException>(() => CreateKeys(Config("tk", "ak", "00", new string('1', 64))));
        Assert.Throws<InvalidOperationException>(() => CreateKeys(Config("missing", "ak", new string('2', 64), new string('3', 64))));
        Assert.Throws<InvalidOperationException>(() => CreateKeys(Config("tk", "ak", new string('4', 64), new string('4', 64))));
        Assert.Throws<InvalidOperationException>(() => CreateKeys(Config("tk", "ak", "f0e0d0c0b0a09080706050403020100ff1e1d1c1b1a191817161514131211100", new string('5', 64))));
    }

    [Theory]
    [InlineData("comment.create", PerceptionCharacterV3ResourceDisposition.QueueForModeration)]
    [InlineData("auth.passkey.register", PerceptionCharacterV3ResourceDisposition.Block)]
    [InlineData("account.recovery", PerceptionCharacterV3ResourceDisposition.Block)]
    [InlineData("admin.security.rotate", PerceptionCharacterV3ResourceDisposition.Block)]
    [InlineData("article.read", PerceptionCharacterV3ResourceDisposition.RequireCheaperProof)]
    public void ResourcePlanner_EmptyPoolUsesConfiguredFailClosedDisposition(
        string action,
        PerceptionCharacterV3ResourceDisposition expected)
    {
        IPerceptionCharacterV3ResourcePlanner planner = new AllowGate();
        PerceptionCharacterV3ResourceDecision decision = planner.Plan(new(
            action,
            PerceptionCharacterV3Representation.Visual,
            new("g", 0, 4, 4, 0, 0, false, false, true),
            2,
            100,
            true,
            false,
            true));

        Assert.Equal(expected, decision.Disposition);
        Assert.NotEqual(PerceptionCharacterV3ResourceDisposition.AllocateV3, decision.Disposition);
    }

    [Fact]
    public async Task RejectedResourceGate_PreventsPoolLeaseAndCryptography()
    {
        var pool = new CountingPool();
        var keys = new CountingKeys();
        var nonce = new CountingNonce();
        var store = new MemoryStore();
        var provider = new PerceptionCharacterV3Provider(
            keys,
            pool,
            store,
            new DenyGate(),
            new TestDeviceAuthority(),
            nonce,
            new AuditSink(),
            TimeProvider.System);

        SecurityChallengeProviderIssueResult result = await provider.IssueAsync(ProviderIssueRequest(), CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal(0, pool.Calls);
        Assert.Equal(0, keys.Accesses);
        Assert.Equal(0, nonce.Calls);
        Assert.Empty(store.Records);
    }

    [Fact]
    public async Task ServerDeviceBudgetBindingCannotBeBypassedByFingerprintRotation()
    {
        var pool = new CapturingBudgetPool();
        var provider = new PerceptionCharacterV3Provider(new Keys(Enumerable.Repeat((byte)0x23, 32).ToArray(), Enumerable.Repeat((byte)0x24, 32).ToArray()), pool, new MemoryStore(), new AllowGate(), new TestDeviceAuthority(), new PerceptionCharacterV3RandomNonceSource(), new AuditSink(), TimeProvider.System);
        SecurityChallengeProviderIssueRequest template = ProviderIssueRequest();
        for (int i = 0; i < 2; i++)
        {
            var context = new DefaultHttpContext();
            context.Request.Headers["X-Fsus-Device-Fp"] = "rotated-client-value-" + i;
            SecurityChallengeProviderIssueResult issued = await provider.IssueAsync(template with
            {
                Context = context,
                DeviceFpHash = new string((char)('a' + i), 64),
                EnvelopeId = Guid.CreateVersion7().ToString("D")
            });
            Assert.True(issued.Succeeded);
        }
        Assert.Equal(2, pool.Budgets.Count);
        Assert.Equal(pool.Budgets[0].DeviceHash, pool.Budgets[1].DeviceHash);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PoolExhaustionFailsClosedWithoutOnlineFallback(bool audio)
    {
        var pool = new EmptyPool();
        var provider = new PerceptionCharacterV3Provider(
            new Keys(Enumerable.Repeat((byte)0x25, 32).ToArray(), Enumerable.Repeat((byte)0x26, 32).ToArray()),
            pool,
            new MemoryStore(),
            new AllowGate(),
            new TestDeviceAuthority(),
            new PerceptionCharacterV3RandomNonceSource(),
            new AuditSink(),
            TimeProvider.System);
        SecurityChallengeProviderIssueRequest first = ProviderIssueRequest();
        if (audio)
            first.Context.Request.Headers["X-Fsus-Challenge-Representation"] = "audio";
        SecurityChallengeProviderIssueResult exhausted = await provider.IssueAsync(first);
        Assert.False(exhausted.Succeeded);
        Assert.Equal("unavailable", exhausted.Reason);
        Assert.Equal(1, pool.Calls);
    }

    [Fact]
    public void FixedTimeCompare_RejectsMalformedLength()
    {
        Assert.True(PerceptionCharacterV3Crypto.FixedTimeTagEquals(new byte[32], new byte[32]));
        Assert.False(PerceptionCharacterV3Crypto.FixedTimeTagEquals(new byte[31], new byte[32]));
    }

    [Fact]
    public void RuntimeNonceSource_DoesNotReuseNonce()
    {
        var source = new PerceptionCharacterV3RandomNonceSource();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < 512; i++)
        {
            byte[] nonce = new byte[12];
            source.Fill(nonce);
            Assert.True(seen.Add(Convert.ToHexString(nonce)));
        }
    }

    [Fact]
    public async Task ArtifactLeaseZeroesDecryptedAnswerOnEveryExit()
    {
        byte[] answer = Encoding.ASCII.GetBytes("A7C9Q");
        var lease = new PerceptionCharacterV3ArtifactLease(
            Guid.CreateVersion7().ToString("D"),
            "test-generation",
            PerceptionCharacterV3Representation.Visual,
            PerceptionCharacterV3Contracts.VisualMediaType,
            VisualArtifact(),
            new string('a', 64),
            answer);

        await lease.DisposeAsync();

        Assert.All(answer, value => Assert.Equal(0, value));
        Assert.True(lease.AnswerBytes.IsEmpty);
    }

    [Fact]
    public void TypedAedsFuzz_NeverAcceptsArbitraryMalformedFrames()
    {
        for (int i = 0; i < 500; i++)
        {
            byte[] bytes = RandomNumberGenerator.GetBytes(i % 257);
            Exception? issue = Xunit.Record.Exception(() => PodBinaryCodec.TryDecodePerceptionCharacterV3Issue(bytes, out _));
            Exception? verify = Xunit.Record.Exception(() => PodBinaryCodec.TryDecodePerceptionCharacterV3Verify(bytes, out _));
            Assert.Null(issue);
            Assert.Null(verify);
        }
    }

    [Theory]
    [InlineData("visual")]
    [InlineData("audio")]
    public async Task Provider_IssuesOnlyTypedFinalMediaAndSupportsAtomicSameOrCrossRepresentationReplacement(string requestedRepresentation)
    {
        var store = new MemoryStore();
        var audit = new AuditSink();
        byte[] tokenKey = Enumerable.Repeat((byte)0x61, 32).ToArray(), answerKey = Enumerable.Repeat((byte)0x62, 32).ToArray();
        var provider = new PerceptionCharacterV3Provider(new Keys(tokenKey, answerKey), new FixedPool(), store, new AllowGate(), new TestDeviceAuthority(), new FixedNonce(new byte[12]), audit, TimeProvider.System);
        SecurityChallengeProviderIssueRequest request = ProviderIssueRequest();
        SecurityChallengeProviderIssueResult result = await provider.IssueAsync(request, CancellationToken.None);
        Assert.True(result.Succeeded);
        Assert.NotNull(result.PerceptionCharacterV3);
        Assert.Empty(result.ProviderPayload);
        Assert.Equal(VisualArtifact().Length, result.PerceptionCharacterV3.MediaBytes.Length);
        Assert.DoesNotContain("answer", result.PerceptionCharacterV3.StateToken, StringComparison.OrdinalIgnoreCase);

        PerceptionCharacterV3StateRecord first = store.Records.Values.Single();
        Assert.Equal(request.DeviceFpHash, result.Assignment!.DeviceFpHash);
        Assert.NotEqual(first.DeviceBindingHash, result.Assignment.DeviceFpHash);
        var audioContext = new DefaultHttpContext();
        audioContext.Request.Headers["X-Fsus-Challenge-Representation"] = requestedRepresentation;
        audioContext.Request.Headers["X-Fsus-Replaces-Challenge"] = first.ChallengeId;
        audioContext.Request.Headers["X-Fsus-Replaces-Envelope"] = first.EnvelopeId;
        audioContext.Request.Headers["X-Fsus-Replaces-State-Token"] = result.PerceptionCharacterV3.StateToken;
        SecurityChallengeProviderIssueResult replacement = await provider.IssueAsync(request with
        {
            Context = audioContext,
            EnvelopeId = Guid.CreateVersion7().ToString("D"),
            Representation = requestedRepresentation
        }, CancellationToken.None);
        Assert.True(replacement.Succeeded);
        Assert.Equal(
            requestedRepresentation == "audio" ? PerceptionCharacterV3Representation.Audio : PerceptionCharacterV3Representation.Visual,
            replacement.PerceptionCharacterV3!.Representation);
        Assert.Equal((PerceptionCharacterV3TransitionKind.Success, "replaced"), (store.LastRevocation!.Kind, store.LastRevocation.InternalReason));
        Assert.NotEqual(first.ChallengeId, replacement.Assignment!.ChallengeId);
        Assert.NotEqual(first.EnvelopeId, replacement.PerceptionCharacterV3.EnvelopeId);
    }

    [Theory]
    [InlineData("envelope")]
    [InlineData("token")]
    [InlineData("action")]
    [InlineData("route")]
    [InlineData("subject")]
    [InlineData("device")]
    [InlineData("ip")]
    public async Task ReplacementRequiresOldTokenEnvelopeAndEveryAuthoritativeBinding(string substitution)
    {
        var store = new MemoryStore();
        var audit = new AuditSink();
        byte[] tokenKey = Enumerable.Repeat((byte)0x27, 32).ToArray(), answerKey = Enumerable.Repeat((byte)0x28, 32).ToArray();
        var provider = new PerceptionCharacterV3Provider(new Keys(tokenKey, answerKey), new FixedPool(), store, new AllowGate(), new TestDeviceAuthority(), new PerceptionCharacterV3RandomNonceSource(), audit, TimeProvider.System);
        SecurityChallengeProviderIssueRequest initial = ProviderIssueRequest() with
        {
            Context = ContextWithSession("server-session-a")
        };
        SecurityChallengeProviderIssueResult issued = await provider.IssueAsync(initial);
        PerceptionCharacterV3StateRecord old = Assert.Single(store.Records.Values);
        var replacementContext = ContextWithSession(substitution == "device" ? "server-session-b" : "server-session-a");
        replacementContext.Request.Headers["X-Fsus-Challenge-Representation"] = "audio";
        replacementContext.Request.Headers["X-Fsus-Replaces-Challenge"] = old.ChallengeId;
        replacementContext.Request.Headers["X-Fsus-Replaces-Envelope"] = substitution == "envelope" ? Guid.CreateVersion7().ToString("D") : old.EnvelopeId;
        replacementContext.Request.Headers["X-Fsus-Replaces-State-Token"] = substitution == "token" ? "wrong-token" : issued.PerceptionCharacterV3!.StateToken;
        SecurityChallengeProviderIssueRequest replacement = initial with
        {
            Context = replacementContext,
            EnvelopeId = Guid.CreateVersion7().ToString("D"),
            Action = substitution == "action" ? "auth.login" : initial.Action,
            RouteKey = substitution == "route" ? "/other" : initial.RouteKey,
            SubjectHash = substitution == "subject" ? new string('a', 64) : initial.SubjectHash,
            ClientIpHash = substitution == "ip" ? new string('b', 64) : initial.ClientIpHash,
            PolicyVersion = initial.PolicyVersion
        };
        SecurityChallengeProviderIssueResult result = await provider.IssueAsync(replacement);
        Assert.False(result.Succeeded);
        Assert.Null(store.LastRevocation);
        Assert.Contains(audit.Events, entry => entry == ("issue", "rejected", "binding_mismatch"));
    }

    [Fact]
    public async Task ReplacementUsesOldIssuedPolicyAuthorityAndNewChallengeUsesPublishedPolicy()
    {
        var store = new MemoryStore();
        var audit = new AuditSink();
        var provider = new PerceptionCharacterV3Provider(new Keys(Enumerable.Repeat((byte)0x29, 32).ToArray(), Enumerable.Repeat((byte)0x2a, 32).ToArray()), new FixedPool(), store, new AllowGate(), new TestDeviceAuthority(), new PerceptionCharacterV3RandomNonceSource(), audit, TimeProvider.System);
        SecurityChallengeProviderIssueRequest initial = ProviderIssueRequest();
        SecurityChallengeProviderIssueResult issued = await provider.IssueAsync(initial);
        PerceptionCharacterV3StateRecord old = Assert.Single(store.Records.Values);
        var replacementContext = new DefaultHttpContext();
        replacementContext.Request.Headers["X-Fsus-Challenge-Representation"] = "audio";
        replacementContext.Request.Headers["X-Fsus-Replaces-Challenge"] = old.ChallengeId;
        replacementContext.Request.Headers["X-Fsus-Replaces-Envelope"] = old.EnvelopeId;
        replacementContext.Request.Headers["X-Fsus-Replaces-State-Token"] = issued.PerceptionCharacterV3!.StateToken;
        SecurityChallengeProviderIssueResult replacement = await provider.IssueAsync(initial with
        {
            Context = replacementContext,
            EnvelopeId = Guid.CreateVersion7().ToString("D"),
            PolicyVersion = "newly-published-policy"
        });
        Assert.True(replacement.Succeeded);
        Assert.Equal("newly-published-policy", replacement.PerceptionCharacterV3!.PolicyVersion);

        PerceptionCharacterV3StateRecord terminal = store.Records[replacement.Assignment!.ChallengeId];
        Assert.Equal(PerceptionCharacterV3TransitionKind.ReissueRequired, (await store.RevokeAsync(terminal, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), CancellationToken.None)).Kind);
        var secondContext = new DefaultHttpContext();
        secondContext.Request.Headers["X-Fsus-Challenge-Representation"] = "visual";
        secondContext.Request.Headers["X-Fsus-Replaces-Challenge"] = terminal.ChallengeId;
        secondContext.Request.Headers["X-Fsus-Replaces-Envelope"] = terminal.EnvelopeId;
        secondContext.Request.Headers["X-Fsus-Replaces-State-Token"] = replacement.PerceptionCharacterV3.StateToken;
        Assert.False((await provider.IssueAsync(initial with
        {
            Context = secondContext,
            EnvelopeId = Guid.CreateVersion7().ToString("D"),
            PolicyVersion = "next-policy"
        })).Succeeded);
        Assert.Contains(audit.Events, entry => entry == ("issue", "rejected", "expired_or_revoked"));
    }

    [Fact]
    public async Task ReplacementAndActiveIdentityRemainStableAcrossAnswerKeyRotation()
    {
        var store = new MemoryStore();
        var keys = new RotatingKeys(
            Enumerable.Repeat((byte)0x41, 32).ToArray(),
            Enumerable.Repeat((byte)0x42, 32).ToArray(),
            Enumerable.Repeat((byte)0x43, 32).ToArray());
        var provider = new PerceptionCharacterV3Provider(
            keys, new FixedPool(), store, new AllowGate(), new TestDeviceAuthority(),
            new PerceptionCharacterV3RandomNonceSource(), new AuditSink(), TimeProvider.System);
        SecurityChallengeProviderIssueRequest request = ProviderIssueRequest();
        SecurityChallengeProviderIssueResult issued = await provider.IssueAsync(request);
        PerceptionCharacterV3StateRecord old = Assert.Single(store.Records.Values);
        Assert.Equal("ak1", old.AnswerKeyVersion);
        keys.CurrentAnswerVersionValue = "ak2";
        var replacementContext = new DefaultHttpContext();
        replacementContext.Request.Headers["X-Fsus-Replaces-Challenge"] = old.ChallengeId;
        replacementContext.Request.Headers["X-Fsus-Replaces-Envelope"] = old.EnvelopeId;
        replacementContext.Request.Headers["X-Fsus-Replaces-State-Token"] = issued.PerceptionCharacterV3!.StateToken;

        SecurityChallengeProviderIssueResult replacement = await provider.IssueAsync(request with
        {
            Context = replacementContext,
            EnvelopeId = Guid.CreateVersion7().ToString("D")
        });

        Assert.True(replacement.Succeeded);
        PerceptionCharacterV3StateRecord current = store.Records[replacement.Assignment!.ChallengeId];
        Assert.Equal("ak2", current.AnswerKeyVersion);
        Assert.NotEqual(old.DeviceBindingHash, current.DeviceBindingHash);
        Assert.Equal(old.DeviceAuthorityHash, current.DeviceAuthorityHash);
        Assert.Equal((PerceptionCharacterV3TransitionKind.Success, "replaced"), (store.LastRevocation!.Kind, store.LastRevocation.InternalReason));
    }

    [Fact]
    public async Task ReplacementInvalidFieldsKeepSpecificAuditBehindCoarseRejection()
    {
        var store = new MemoryStore();
        var audit = new AuditSink();
        var provider = new PerceptionCharacterV3Provider(
            new Keys(Enumerable.Repeat((byte)0x31, 32).ToArray(), Enumerable.Repeat((byte)0x32, 32).ToArray()),
            new FixedPool(), store, new AllowGate(), new TestDeviceAuthority(), new FixedNonce(new byte[12]), audit, TimeProvider.System);
        SecurityChallengeProviderIssueRequest initial = ProviderIssueRequest();
        SecurityChallengeProviderIssueResult issued = await provider.IssueAsync(initial);
        PerceptionCharacterV3StateRecord old = Assert.Single(store.Records.Values);
        var replacementContext = new DefaultHttpContext();
        replacementContext.Request.Headers["X-Fsus-Replaces-Challenge"] = old.ChallengeId;
        replacementContext.Request.Headers["X-Fsus-Replaces-Envelope"] = old.EnvelopeId;

        SecurityChallengeProviderIssueResult result = await provider.IssueAsync(initial with
        {
            Context = replacementContext,
            EnvelopeId = Guid.CreateVersion7().ToString("D")
        });

        Assert.False(result.Succeeded);
        Assert.Equal("rejected", result.Reason);
        Assert.Contains(audit.Events, entry => entry == ("issue", "rejected", "replacement_fields_invalid"));
        Assert.NotNull(issued.PerceptionCharacterV3);
    }

    [Theory]
    [InlineData(true, "replacement_state_unavailable")]
    [InlineData(false, "replacement_revoke_store_failure")]
    public async Task ReplacementStoreFailuresKeepSpecificAuditBehindCoarseUnavailable(bool failRead, string expectedInternalReason)
    {
        byte[] answerKey = Enumerable.Repeat((byte)0x34, 32).ToArray();
        SecurityChallengeProviderIssueRequest request = ProviderIssueRequest();
        string oldChallengeId = Guid.CreateVersion7().ToString("D");
        string oldEnvelopeId = Guid.CreateVersion7().ToString("D");
        string token = "old-state-token";
        string deviceBinding = PerceptionCharacterV3Crypto.DeriveDeviceBinding(answerKey, "session:server-issued-test");
        var record = new PerceptionCharacterV3StateRecord(
            oldChallengeId, oldEnvelopeId, request.Action, request.RouteKey, request.SubjectHash, deviceBinding,
            new string('9', 64), request.ClientIpHash, request.PolicyVersion, new string('4', 64), "visual",
            PerceptionCharacterV3Contracts.VisualMediaType, 384, 144, 320, 120, 1, 2, "tk", "ak",
            Convert.ToHexStringLower(SHA256.HashData(Encoding.ASCII.GetBytes(token))));
        var audit = new AuditSink();
        var provider = new PerceptionCharacterV3Provider(
            new Keys(Enumerable.Repeat((byte)0x33, 32).ToArray(), answerKey), new FixedPool(),
            new ReplacementFailureStore(record, failRead), new AllowGate(), new TestDeviceAuthority(),
            new FixedNonce(new byte[12]), audit, TimeProvider.System);
        var context = new DefaultHttpContext();
        context.Request.Headers["X-Fsus-Challenge-Representation"] = "audio";
        context.Request.Headers["X-Fsus-Replaces-Challenge"] = oldChallengeId;
        context.Request.Headers["X-Fsus-Replaces-Envelope"] = oldEnvelopeId;
        context.Request.Headers["X-Fsus-Replaces-State-Token"] = token;

        SecurityChallengeProviderIssueResult result = await provider.IssueAsync(request with
        {
            Context = context,
            EnvelopeId = Guid.CreateVersion7().ToString("D")
        });

        Assert.False(result.Succeeded);
        Assert.Equal("unavailable", result.Reason);
        Assert.Contains(audit.Events, entry => entry == ("issue", "unavailable", expectedInternalReason));
    }

    [Fact]
    public async Task ReplacementPreparationFailureLeavesOnlyTheOldIdentityActive()
    {
        var store = new MemoryStore();
        var pool = new TogglePool();
        var provider = new PerceptionCharacterV3Provider(
            new Keys(Enumerable.Repeat((byte)0x35, 32).ToArray(), Enumerable.Repeat((byte)0x36, 32).ToArray()),
            pool, store, new AllowGate(), new TestDeviceAuthority(), new FixedNonce(new byte[12]),
            new AuditSink(), TimeProvider.System);
        SecurityChallengeProviderIssueRequest request = ProviderIssueRequest();
        SecurityChallengeProviderIssueResult issued = await provider.IssueAsync(request);
        PerceptionCharacterV3StateRecord old = Assert.Single(store.Records.Values);
        var replacementContext = new DefaultHttpContext();
        replacementContext.Request.Headers["X-Fsus-Replaces-Challenge"] = old.ChallengeId;
        replacementContext.Request.Headers["X-Fsus-Replaces-Envelope"] = old.EnvelopeId;
        replacementContext.Request.Headers["X-Fsus-Replaces-State-Token"] = issued.PerceptionCharacterV3!.StateToken;
        pool.Available = false;

        SecurityChallengeProviderIssueResult failed = await provider.IssueAsync(request with
        {
            Context = replacementContext,
            EnvelopeId = Guid.CreateVersion7().ToString("D")
        });

        Assert.False(failed.Succeeded);
        Assert.Equal("unavailable", failed.Reason);
        Assert.Single(store.Records);
        Assert.Equal(
            "revoked_now",
            (await store.RevokeAsync(old, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), CancellationToken.None)).InternalReason);
    }

    [Theory]
    [InlineData("comment.create", "/api/binary/comment")]
    [InlineData("auth.login", "/api/binary/auth/login")]
    [InlineData("admin.security.write", "/api/binary/admin/security")]
    [InlineData("notification.subscribe", "notification:subscribe")]
    public async Task ProviderPreservesBindingsAcrossAnonymousLoginAdminAndNotificationActions(string action, string route)
    {
        byte[] tokenKey = Enumerable.Repeat((byte)0x31, 32).ToArray(), answerKey = Enumerable.Repeat((byte)0x32, 32).ToArray();
        var store = new MemoryStore();
        var provider = new PerceptionCharacterV3Provider(new Keys(tokenKey, answerKey), new FixedPool(), store, new AllowGate(), new TestDeviceAuthority(), new FixedNonce(new byte[12]), new AuditSink(), TimeProvider.System);
        SecurityChallengeProviderIssueRequest request = ProviderIssueRequest() with
        {
            Action = action,
            RouteKey = route
        };
        SecurityChallengeProviderIssueResult result = await provider.IssueAsync(request, CancellationToken.None);
        Assert.True(result.Succeeded);
        PerceptionCharacterV3StateRecord stored = Assert.Single(store.Records.Values);
        Assert.Equal(action, stored.Action);
        Assert.Equal(route, stored.RouteKey);
    }

    [Fact]
    public async Task Provider_VerifyUsesIssuedPolicyAndReturnsOnlyCoarseFailures()
    {
        byte[] tokenKey = Enumerable.Repeat((byte)0x71, 32).ToArray(), answerKey = Enumerable.Repeat((byte)0x72, 32).ToArray();
        var store = new MemoryStore();
        var audit = new AuditSink();
        PerceptionCharacterV3StateRecord record = Record(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        string rawDevice = new string('9', 64);
        string trustedDevice = "session:server-issued-test";
        string device = Convert.ToHexStringLower(HMACSHA256.HashData(answerKey, Encoding.UTF8.GetBytes("fsus.perception-character.device\0" + trustedDevice)));
        record = record with
        {
            DeviceBindingHash = device
        };
        var context = new PerceptionCharacterV3BindingContext(record.ChallengeId, record.EnvelopeId, record.Action, record.RouteKey, record.SubjectHash, record.DeviceBindingHash, record.ClientIpBindingHash, record.PolicyVersion, record.ArtifactHash,
            record.Representation, record.MediaType, record.PhysicalWidth, record.PhysicalHeight, record.DisplayWidth, record.DisplayHeight,
            record.IssuedAtUnixMs, record.ExpiresAtUnixMs, record.TokenKeyVersion);
        byte[] tag = PerceptionCharacterV3Crypto.ComputeAnswerTag(answerKey, context, "A7C9Q");
        var state = new PerceptionCharacterV3State(tag, record.ArtifactHash, record.MediaType, record.PhysicalWidth, record.PhysicalHeight, record.DisplayWidth, record.DisplayHeight,
            record.ChallengeId, record.EnvelopeId, record.Action, record.RouteKey, record.SubjectHash, record.DeviceBindingHash, record.ClientIpBindingHash, record.PolicyVersion, 2,
            record.Representation, record.IssuedAtUnixMs, record.ExpiresAtUnixMs, record.TokenKeyVersion, record.AnswerKeyVersion);
        string token = PerceptionCharacterV3Crypto.SealState(tokenKey, context, state, new FixedNonce(new byte[12]));
        record = record with
        {
            TokenHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.ASCII.GetBytes(token)))
        };
        Assert.True(await store.CreateAsync(record, CancellationToken.None));
        var provider = new PerceptionCharacterV3Provider(new Keys(tokenKey, answerKey), new FixedPool(), store, new AllowGate(), new TestDeviceAuthority(), new FixedNonce(new byte[12]), audit, TimeProvider.System);
        var typed = new PerceptionCharacterV3VerifyPayload(PerceptionCharacterV3Contracts.Algorithm, record.ChallengeId, record.EnvelopeId, PerceptionCharacterV3Representation.Visual, "A7C9Q", token);
        var request = new SecurityChallengeProviderVerifyRequest(new DefaultHttpContext(), PerceptionCharacterV3Contracts.WireName, record.ChallengeId, record.Action, record.RouteKey, record.SubjectHash, record.ClientIpBindingHash, rawDevice, "newly-published-policy", new Dictionary<string, string>()) { EnvelopeId = record.EnvelopeId, PerceptionCharacterV3 = typed };
        Assert.True((await provider.VerifyAsync(request)).Succeeded);
        Assert.Equal(record.PolicyVersion, store.LastExpected!.PolicyVersion);
        SecurityChallengeProviderVerifyResult replay = await provider.VerifyAsync(request);
        Assert.False(replay.Succeeded);
        Assert.Equal("rejected", replay.Reason);
        Assert.All(audit.Events, item => Assert.DoesNotContain("key", item.Outcome, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void CryptoStaysWithinLocalPerformanceBudget()
    {
        var watch = Stopwatch.StartNew();
        PerceptionCharacterV3BindingContext context = Context(Vectors);
        byte[] key = Enumerable.Repeat((byte)0x41, 32).ToArray();
        watch.Restart();
        for (int i = 0; i < 1000; i++)
            _ = PerceptionCharacterV3Crypto.ComputeAnswerTag(key, context, "A7C9Q");
        watch.Stop();
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(2), watch.Elapsed.ToString());
    }

    [Fact]
    [Trait("Fixture", "LocalRedis")]
    public async Task RedisLua_IsLinearizableBoundedBindingAwareAndFailClosed()
    {
        string? connectionString = Environment.GetEnvironmentVariable("FSUSBLOG_TEST_REDIS");
        if (string.IsNullOrWhiteSpace(connectionString))
            return;
        await using ConnectionMultiplexer redis = await ConnectionMultiplexer.ConnectAsync(connectionString);
        string redisPrefix = "test:perception-v3:" + Guid.CreateVersion7().ToString("N") + ":";
        var keyScope = new TestRuntimeKeyScope(redisPrefix);
        await using var redisCleanup = new RedisPrefixCleanup(redis, redisPrefix);
        var store = new RedisPerceptionCharacterV3StateStore(redis, keyScope);
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var deviceAuthority = new RedisPerceptionCharacterV3DeviceAuthority(redis, keyScope);
        var firstAnonymous = new DefaultHttpContext();
        PerceptionCharacterV3DeviceAuthorityResult firstDevice = await deviceAuthority.ResolveAsync(firstAnonymous, new string('8', 64), CancellationToken.None);
        Assert.True(firstDevice.Succeeded);
        Assert.StartsWith("anonymous-device:", firstDevice.Binding, StringComparison.Ordinal);
        string setCookie = firstAnonymous.Response.Headers.SetCookie.ToString();
        Assert.Contains(RedisPerceptionCharacterV3DeviceAuthority.CookieName + "=", setCookie, StringComparison.Ordinal);
        Assert.Contains("httponly", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("secure", setCookie, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("samesite=strict", setCookie, StringComparison.OrdinalIgnoreCase);
        var missingCookieReuse = new DefaultHttpContext();
        PerceptionCharacterV3DeviceAuthorityResult reusedDevice = await deviceAuthority.ResolveAsync(missingCookieReuse, new string('8', 64), CancellationToken.None);
        Assert.Equal(firstDevice.Binding, reusedDevice.Binding);
        string deviceId = firstDevice.Binding["anonymous-device:".Length..];
        var cookieReuse = new DefaultHttpContext();
        cookieReuse.Request.Headers.Cookie = RedisPerceptionCharacterV3DeviceAuthority.CookieName + "=" + deviceId;
        Assert.Equal(firstDevice.Binding, (await deviceAuthority.ResolveAsync(cookieReuse, new string('9', 64), CancellationToken.None)).Binding);
        var forgedCookie = new DefaultHttpContext();
        forgedCookie.Request.Headers.Cookie = RedisPerceptionCharacterV3DeviceAuthority.CookieName + "=" + Guid.CreateVersion7().ToString("D");
        Assert.False((await deviceAuthority.ResolveAsync(forgedCookie, new string('8', 64), CancellationToken.None)).Succeeded);
        var independentAnonymous = new DefaultHttpContext();
        PerceptionCharacterV3DeviceAuthorityResult independentDevice = await deviceAuthority.ResolveAsync(independentAnonymous, new string('7', 64), CancellationToken.None);
        Assert.NotEqual(firstDevice.Binding, independentDevice.Binding);
        PerceptionCharacterV3StateRecord correctRace = Record(now);
        Assert.True(await store.CreateAsync(correctRace, CancellationToken.None));
        PerceptionCharacterV3Transition[] correct = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => store.VerifyAsync(correctRace, true, now, CancellationToken.None)));
        Assert.Single(correct, x => x.Kind == PerceptionCharacterV3TransitionKind.Success);
        Assert.Equal(7, correct.Count(x => x.Kind == PerceptionCharacterV3TransitionKind.Rejected));

        PerceptionCharacterV3StateRecord wrongRace = Record(now);
        Assert.True(await store.CreateAsync(wrongRace, CancellationToken.None));
        PerceptionCharacterV3Transition[] wrong = await Task.WhenAll(store.VerifyAsync(wrongRace, false, now, CancellationToken.None), store.VerifyAsync(wrongRace, false, now, CancellationToken.None));
        Assert.Contains(wrong, x => x.Kind == PerceptionCharacterV3TransitionKind.Retryable && x.Attempts == 1);
        Assert.Contains(wrong, x => x.Kind == PerceptionCharacterV3TransitionKind.Rejected && x.Attempts == 2);

        PerceptionCharacterV3StateRecord wrongThenCorrect = Record(now);
        Assert.True(await store.CreateAsync(wrongThenCorrect, CancellationToken.None));
        (PerceptionCharacterV3Transition wrongFirst, PerceptionCharacterV3Transition correctSecond) = await ConcurrentTransitionsWithIssuedOrder(store, wrongThenCorrect, false, true, now);
        Assert.Equal((PerceptionCharacterV3TransitionKind.Retryable, 1), (wrongFirst.Kind, wrongFirst.Attempts));
        Assert.Equal((PerceptionCharacterV3TransitionKind.Success, 2), (correctSecond.Kind, correctSecond.Attempts));

        PerceptionCharacterV3StateRecord correctThenWrong = Record(now);
        Assert.True(await store.CreateAsync(correctThenWrong, CancellationToken.None));
        (PerceptionCharacterV3Transition correctFirst, PerceptionCharacterV3Transition wrongSecond) = await ConcurrentTransitionsWithIssuedOrder(store, correctThenWrong, true, false, now);
        Assert.Equal((PerceptionCharacterV3TransitionKind.Success, 1), (correctFirst.Kind, correctFirst.Attempts));
        Assert.Equal((PerceptionCharacterV3TransitionKind.Rejected, 1), (wrongSecond.Kind, wrongSecond.Attempts));

        foreach (Func<PerceptionCharacterV3StateRecord, PerceptionCharacterV3StateRecord> mutate in Mutations())
        {
            PerceptionCharacterV3StateRecord original = Record(now);
            Assert.True(await store.CreateAsync(original, CancellationToken.None));
            PerceptionCharacterV3Transition rejected = await store.VerifyAsync(mutate(original), true, now, CancellationToken.None);
            Assert.Equal(PerceptionCharacterV3TransitionKind.Rejected, rejected.Kind);
            Assert.Equal(0, rejected.Attempts);
            Assert.Equal(PerceptionCharacterV3TransitionKind.ReissueRequired, (await store.RevokeAsync(original, now, CancellationToken.None)).Kind);
        }

        PerceptionCharacterV3StateRecord expired = Record(now) with
        {
            ExpiresAtUnixMs = now + 1
        };
        Assert.True(await store.CreateAsync(expired, CancellationToken.None));
        Assert.Equal(PerceptionCharacterV3TransitionKind.ReissueRequired, (await store.VerifyAsync(expired, true, now + 1, CancellationToken.None)).Kind);
        foreach (Func<PerceptionCharacterV3StateRecord, PerceptionCharacterV3StateRecord> mutate in Mutations())
            Assert.Equal(PerceptionCharacterV3TransitionKind.Rejected, (await store.RevokeAsync(mutate(expired), now + 1, CancellationToken.None)).Kind);
        PerceptionCharacterV3StateRecord revoked = Record(now);
        Assert.True(await store.CreateAsync(revoked, CancellationToken.None));
        Assert.Equal(PerceptionCharacterV3TransitionKind.ReissueRequired, (await store.RevokeAsync(revoked, now, CancellationToken.None)).Kind);
        Assert.Equal(PerceptionCharacterV3TransitionKind.ReissueRequired, (await store.VerifyAsync(revoked, true, now, CancellationToken.None)).Kind);
        foreach (Func<PerceptionCharacterV3StateRecord, PerceptionCharacterV3StateRecord> mutate in Mutations())
            Assert.Equal(PerceptionCharacterV3TransitionKind.Rejected, (await store.RevokeAsync(mutate(revoked), now, CancellationToken.None)).Kind);

        PerceptionCharacterV3StateRecord atomicCreate = Record(now);
        var createFaults = new HashSet<PerceptionCharacterV3RedisFaultPoint> { PerceptionCharacterV3RedisFaultPoint.CreateReply };
        var createReplyLoss = new RedisPerceptionCharacterV3StateStore(redis, keyScope, createFaults.Remove);
        Assert.True(await createReplyLoss.CreateAsync(atomicCreate, CancellationToken.None));
        TimeSpan? stateTtl = await redis.GetDatabase().KeyTimeToLiveAsync(keyScope.PrefixKey("security:perception-v3:" + atomicCreate.ChallengeId), CommandFlags.DemandMaster);
        Assert.True(stateTtl > TimeSpan.Zero);
        Assert.False(await store.CreateAsync(atomicCreate with
        {
            TokenHash = new string('6', 64)
        }, CancellationToken.None));

        PerceptionCharacterV3StateRecord competingIdentity = atomicCreate with
        {
            ChallengeId = Guid.CreateVersion7().ToString("D"),
            EnvelopeId = Guid.CreateVersion7().ToString("D"),
            DeviceBindingHash = new string('f', 64),
            TokenHash = new string('7', 64)
        };
        Assert.False(await store.CreateAsync(competingIdentity, CancellationToken.None));
        Assert.Null(await store.ReadAsync(competingIdentity.ChallengeId, CancellationToken.None));
        Assert.Equal(PerceptionCharacterV3TransitionKind.ReissueRequired, (await store.RevokeAsync(atomicCreate, now, CancellationToken.None)).Kind);

        PerceptionCharacterV3StateRecord transitionReplyLossRecord = Record(now);
        Assert.True(await store.CreateAsync(transitionReplyLossRecord, CancellationToken.None));
        var transitionFaults = new HashSet<PerceptionCharacterV3RedisFaultPoint> { PerceptionCharacterV3RedisFaultPoint.TransitionReply };
        var transitionReplyLoss = new RedisPerceptionCharacterV3StateStore(redis, keyScope, transitionFaults.Remove);
        PerceptionCharacterV3Transition recoveredTransition = await transitionReplyLoss.VerifyAsync(transitionReplyLossRecord, false, now, CancellationToken.None);
        Assert.Equal((PerceptionCharacterV3TransitionKind.Retryable, 1), (recoveredTransition.Kind, recoveredTransition.Attempts));
        PerceptionCharacterV3Transition secondWrong = await store.VerifyAsync(transitionReplyLossRecord, false, now, CancellationToken.None);
        Assert.Equal((PerceptionCharacterV3TransitionKind.Rejected, 2), (secondWrong.Kind, secondWrong.Attempts));

        PerceptionCharacterV3StateRecord settlementReplyLossRecord = Record(now);
        Assert.True(await store.CreateAsync(settlementReplyLossRecord, CancellationToken.None));
        var settlementFaults = new HashSet<PerceptionCharacterV3RedisFaultPoint> { PerceptionCharacterV3RedisFaultPoint.OperationSettlement };
        var settlementReplyLoss = new RedisPerceptionCharacterV3StateStore(redis, keyScope, settlementFaults.Remove);
        Assert.Equal(PerceptionCharacterV3TransitionKind.Retryable,
            (await settlementReplyLoss.VerifyAsync(settlementReplyLossRecord, false, now, CancellationToken.None)).Kind);
        Assert.Equal(PerceptionCharacterV3TransitionKind.Rejected,
            (await store.VerifyAsync(settlementReplyLossRecord, false, now, CancellationToken.None)).Kind);

        PerceptionCharacterV3StateRecord unresolvedReplyLossRecord = Record(now) with
        {
            SubjectHash = new string('a', 64)
        };
        Assert.True(await store.CreateAsync(unresolvedReplyLossRecord, CancellationToken.None));
        var unresolvedFaults = new HashSet<PerceptionCharacterV3RedisFaultPoint>
        {
            PerceptionCharacterV3RedisFaultPoint.TransitionReply,
            PerceptionCharacterV3RedisFaultPoint.OperationReadback
        };
        var unresolvedReplyLoss = new RedisPerceptionCharacterV3StateStore(redis, keyScope, unresolvedFaults.Remove);
        Assert.Equal("redis_result_ambiguous", (await unresolvedReplyLoss.VerifyAsync(unresolvedReplyLossRecord, false, now, CancellationToken.None)).InternalReason);
        PerceptionCharacterV3Transition prohibitedRetry = await store.VerifyAsync(unresolvedReplyLossRecord, true, now, CancellationToken.None);
        Assert.Equal((PerceptionCharacterV3TransitionKind.Unavailable, "ambiguous_operation_pending", 1),
            (prohibitedRetry.Kind, prohibitedRetry.InternalReason, prohibitedRetry.Attempts));

        PerceptionCharacterV3StateRecord staleIndexRecord = Record(now) with
        {
            SubjectHash = new string('b', 64)
        };
        Assert.True(await store.CreateAsync(staleIndexRecord, CancellationToken.None));
        Assert.True(await redis.GetDatabase().KeyDeleteAsync(keyScope.PrefixKey(ActiveIdentityKeySuffix(staleIndexRecord)), CommandFlags.DemandMaster));
        PerceptionCharacterV3Transition staleIndex = await store.VerifyAsync(staleIndexRecord, true, now, CancellationToken.None);
        Assert.Equal(
            (PerceptionCharacterV3TransitionKind.Rejected, "replacement_conflict", 0),
            (staleIndex.Kind, staleIndex.InternalReason, staleIndex.Attempts));
        Assert.True(await redis.GetDatabase().KeyDeleteAsync(keyScope.PrefixKey("security:perception-v3:" + staleIndexRecord.ChallengeId), CommandFlags.DemandMaster));

        PerceptionCharacterV3StateRecord replaceOld = Record(now);
        Assert.True(await store.CreateAsync(replaceOld, CancellationToken.None));
        PerceptionCharacterV3StateRecord replaceNew = replaceOld with
        {
            ChallengeId = Guid.CreateVersion7().ToString("D"),
            EnvelopeId = Guid.CreateVersion7().ToString("D"),
            TokenHash = new string('8', 64)
        };
        var replaceFaults = new HashSet<PerceptionCharacterV3RedisFaultPoint> { PerceptionCharacterV3RedisFaultPoint.ReplaceReply };
        var replaceReplyLoss = new RedisPerceptionCharacterV3StateStore(redis, keyScope, replaceFaults.Remove);
        PerceptionCharacterV3Transition replaced = await replaceReplyLoss.ReplaceAsync(replaceOld, replaceNew, now, CancellationToken.None);
        Assert.Equal((PerceptionCharacterV3TransitionKind.Success, "replaced"), (replaced.Kind, replaced.InternalReason));
        Assert.NotNull(await store.ReadAsync(replaceNew.ChallengeId, CancellationToken.None));
        Assert.Equal(PerceptionCharacterV3TransitionKind.ReissueRequired, (await store.VerifyAsync(replaceOld, true, now, CancellationToken.None)).Kind);
        Assert.Equal(PerceptionCharacterV3TransitionKind.Success, (await store.VerifyAsync(replaceNew, true, now, CancellationToken.None)).Kind);

        PerceptionCharacterV3StateRecord staleOld = Record(now) with
        {
            ExpiresAtUnixMs = now + 1
        };
        Assert.True(await store.CreateAsync(staleOld, CancellationToken.None));
        PerceptionCharacterV3StateRecord staleNew = staleOld with
        {
            ChallengeId = Guid.CreateVersion7().ToString("D"),
            EnvelopeId = Guid.CreateVersion7().ToString("D")
        };
        Assert.Equal(PerceptionCharacterV3TransitionKind.ReissueRequired, (await store.ReplaceAsync(staleOld, staleNew, now + 1, CancellationToken.None)).Kind);
        Assert.Null(await store.ReadAsync(staleNew.ChallengeId, CancellationToken.None));

        await using ConnectionMultiplexer unavailable = await ConnectionMultiplexer.ConnectAsync("127.0.0.1:1,abortConnect=false,connectTimeout=50,syncTimeout=50,asyncTimeout=50");
        var unavailableStore = new RedisPerceptionCharacterV3StateStore(unavailable, keyScope);
        Assert.Equal(PerceptionCharacterV3TransitionKind.Unavailable, (await unavailableStore.VerifyAsync(Record(now), true, now, CancellationToken.None)).Kind);
        var unavailableAuthority = new RedisPerceptionCharacterV3DeviceAuthority(unavailable, keyScope);
        Assert.False((await unavailableAuthority.ResolveAsync(new DefaultHttpContext(), new string('6', 64), CancellationToken.None)).Succeeded);
        Assert.True((await unavailableAuthority.ResolveAsync(ContextWithSession("server-session-offline"), new string('6', 64), CancellationToken.None)).Succeeded);
    }

    private static SecurityChallengeKind Parse(string value) => SecurityChallengeContracts.TryParseKind(value, out SecurityChallengeKind kind) ? kind : SecurityChallengeKind.Unknown;
    private static async Task<(PerceptionCharacterV3Transition First, PerceptionCharacterV3Transition Second)> ConcurrentTransitionsWithIssuedOrder(
        IPerceptionCharacterV3StateStore store,
        PerceptionCharacterV3StateRecord record,
        bool firstCorrect,
        bool secondCorrect,
        long now)
    {
        using var start = new Barrier(2);
        using var firstIssued = new ManualResetEventSlim();
        Task<PerceptionCharacterV3Transition> firstTask = Task.Run(async () =>
        {
            start.SignalAndWait();
            Task<PerceptionCharacterV3Transition> transition = store.VerifyAsync(record, firstCorrect, now, CancellationToken.None);
            firstIssued.Set();
            return await transition;
        });
        Task<PerceptionCharacterV3Transition> secondTask = Task.Run(async () =>
        {
            start.SignalAndWait();
            firstIssued.Wait();
            return await store.VerifyAsync(record, secondCorrect, now, CancellationToken.None);
        });
        await Task.WhenAll(firstTask, secondTask);
        return (firstTask.Result, secondTask.Result);
    }
    private static DefaultHttpContext ContextWithSession(string sessionId)
    {
        var context = new DefaultHttpContext();
        context.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sid", sessionId)], "test"));
        return context;
    }
    private sealed class TestRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string PrefixKey(string key) => prefix + key;
    }
    private sealed class RedisPrefixCleanup(ConnectionMultiplexer redis, string prefix) : IAsyncDisposable
    {
        public async ValueTask DisposeAsync()
        {
            var keys = new HashSet<RedisKey>();
            foreach (System.Net.EndPoint endpoint in redis.GetEndPoints())
            {
                IServer server = redis.GetServer(endpoint);
                if (!server.IsReplica)
                    keys.UnionWith(server.Keys(pattern: prefix + "*"));
            }
            if (keys.Count > 0)
                await redis.GetDatabase().KeyDeleteAsync([.. keys], CommandFlags.DemandMaster);
        }
    }
    private static void AssertSpokenAudioFixture(byte[] wav, string expected)
    {
        byte[] sourceBytes = File.ReadAllBytes(Path.Combine(s_root, "src/shared/Contracts/Validation/Security/perception-character-v3-spoken-atlas-source.json"));
        byte[] outputBytes = File.ReadAllBytes(Path.Combine(s_root, "src/shared/Contracts/Validation/Security/perception-character-v3-spoken-atlas.json"));
        using JsonDocument golden = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(s_root, "tests/fixtures/security/perception-character-v3-spoken-atlas-golden.json")));
        Assert.Equal(golden.RootElement.GetProperty("sourceManifestSha256").GetString(), Convert.ToHexStringLower(SHA256.HashData(sourceBytes)));
        Assert.Equal(golden.RootElement.GetProperty("outputSha256").GetString(), Convert.ToHexStringLower(SHA256.HashData(outputBytes)));
        using JsonDocument source = JsonDocument.Parse(sourceBytes);
        using JsonDocument fixture = JsonDocument.Parse(outputBytes);
        JsonElement root = fixture.RootElement;
        Assert.Equal(12_000, BitConverter.ToInt32(wav, 24));
        Assert.Equal("fsus.perception-character.spoken-atlas.v1", root.GetProperty("schema").GetString());
        int cursor = 44;
        for (int index = 0; index < expected.Length; index++)
        {
            JsonElement unit = root.GetProperty("units").GetProperty(expected[index].ToString());
            JsonElement sourceUnit = source.RootElement.GetProperty("units").EnumerateArray().Single(item => item.GetProperty("symbol").GetString() == expected[index].ToString());
            byte[] pcm = Convert.FromBase64String(unit.GetProperty("pcm16Base64").GetString()!);
            Assert.Equal(pcm, wav.AsSpan(cursor, pcm.Length).ToArray());
            string expectedName = expected[index] switch
            {
                '7' => "seven",
                '9' => "nine",
                _ => "letter " + expected[index]
            };
            Assert.Equal(expectedName, unit.GetProperty("spokenName").GetString());
            Assert.Equal(expectedName, sourceUnit.GetProperty("spokenName").GetString());
            Assert.Equal($"<say-as interpret-as=\"characters\">{expected[index]}</say-as>", sourceUnit.GetProperty("ssml").GetString());
            Assert.Equal(sourceUnit.GetProperty("pcmSha256").GetString(), Convert.ToHexStringLower(SHA256.HashData(pcm)));
            Assert.Equal(sourceUnit.GetProperty("sampleCount").GetInt32(), pcm.Length / 2);
            cursor += pcm.Length;
            if (index != expected.Length - 1)
            {
                Assert.All(wav.AsSpan(cursor, 2_160 * 2).ToArray(), static value => Assert.Equal(0, value));
                cursor += 2_160 * 2;
            }
        }
        Assert.Equal(wav.Length, cursor);
    }
    private static PerceptionCharacterV3BindingContext Context(JsonElement root)
    {
        JsonElement c = root.GetProperty("state").GetProperty("context");
        return new(c.GetProperty("challengeId").GetString()!, c.GetProperty("envelopeId").GetString()!, c.GetProperty("action").GetString()!, c.GetProperty("routeKey").GetString()!, c.GetProperty("subjectHash").GetString()!, c.GetProperty("deviceBindingHash").GetString()!, c.GetProperty("clientIpBindingHash").GetString()!, c.GetProperty("policyVersion").GetString()!, c.GetProperty("artifactHash").GetString()!,
            c.GetProperty("representation").GetString()!, c.GetProperty("mediaType").GetString()!, c.GetProperty("physicalWidth").GetUInt16(), c.GetProperty("physicalHeight").GetUInt16(), c.GetProperty("displayWidth").GetUInt16(), c.GetProperty("displayHeight").GetUInt16(),
            c.GetProperty("issuedAtUnixMs").GetInt64(), c.GetProperty("expiresAtUnixMs").GetInt64(), c.GetProperty("tokenKeyVersion").GetString()!);
    }
    private static byte[] VisualArtifact()
        => Convert.FromBase64String(Vectors.GetProperty("visual").GetProperty("artifactBase64").GetString()!);
    private static byte[] AudioArtifact()
        => Convert.FromBase64String(Vectors.GetProperty("audio").GetProperty("artifactBase64").GetString()!);
    private static PerceptionCharacterV3ArtifactLease Lease(PerceptionCharacterV3Representation representation)
    {
        byte[] artifact = representation == PerceptionCharacterV3Representation.Visual
            ? VisualArtifact()
            : AudioArtifact();
        return new(
            Guid.CreateVersion7().ToString("D"),
            "test-generation",
            representation,
            representation == PerceptionCharacterV3Representation.Visual
                ? PerceptionCharacterV3Contracts.VisualMediaType
                : PerceptionCharacterV3Contracts.AudioMediaType,
            artifact,
            Convert.ToHexStringLower(SHA256.HashData(artifact)),
            Encoding.ASCII.GetBytes("A7C9Q"));
    }
    private static PerceptionCharacterV3IssuePayload Issue(
        string challenge,
        string envelope,
        PerceptionCharacterV3Representation representation,
        byte[] media)
        => new(
            PerceptionCharacterV3Contracts.Algorithm,
            challenge,
            envelope,
            representation,
            representation == PerceptionCharacterV3Representation.Visual
                ? PerceptionCharacterV3Contracts.VisualMediaType
                : PerceptionCharacterV3Contracts.AudioMediaType,
            media,
            representation == PerceptionCharacterV3Representation.Visual ? (ushort)PerceptionCharacterV3Contracts.PhysicalWidth : (ushort)0,
            representation == PerceptionCharacterV3Representation.Visual ? (ushort)PerceptionCharacterV3Contracts.PhysicalHeight : (ushort)0,
            representation == PerceptionCharacterV3Representation.Visual ? (ushort)PerceptionCharacterV3Contracts.DisplayWidth : (ushort)0,
            representation == PerceptionCharacterV3Representation.Visual ? (ushort)PerceptionCharacterV3Contracts.DisplayHeight : (ushort)0,
            2,
            "p1",
            1,
            2,
            "opaque");
    private static PerceptionCharacterV3StateRecord Record(long now) => new(Guid.CreateVersion7().ToString("D"), Guid.CreateVersion7().ToString("D"), "comment.create", "/api/binary/comment", new string('1', 64), new string('2', 64), new string('9', 64), new string('3', 64), "issued-policy", new string('4', 64), "visual", PerceptionCharacterV3Contracts.VisualMediaType, 384, 144, 320, 120, now, now + 120_000, "tk", "ak", new string('5', 64));
    private static string ActiveIdentityKeySuffix(PerceptionCharacterV3StateRecord record)
    {
        byte[] material = PerceptionCharacterV3Crypto.EncodeLp(
            Encoding.UTF8.GetBytes(record.SubjectHash),
            Encoding.UTF8.GetBytes(record.DeviceAuthorityHash),
            Encoding.UTF8.GetBytes(record.ClientIpBindingHash),
            Encoding.UTF8.GetBytes(record.Action),
            Encoding.UTF8.GetBytes(record.RouteKey));
        try
        {
            return "security:perception-v3-active:" + Convert.ToHexStringLower(SHA256.HashData(material));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(material);
        }
    }
    private static IEnumerable<Func<PerceptionCharacterV3StateRecord, PerceptionCharacterV3StateRecord>> Mutations()
    {
        yield return x => x with { ChallengeId = Guid.CreateVersion7().ToString("D") };
        yield return x => x with { EnvelopeId = Guid.CreateVersion7().ToString("D") };
        yield return x => x with { Action = "auth.login" };
        yield return x => x with { RouteKey = "/other" };
        yield return x => x with { SubjectHash = new string('a', 64) };
        yield return x => x with { DeviceBindingHash = new string('b', 64) };
        yield return x => x with { DeviceAuthorityHash = new string('f', 64) };
        yield return x => x with { ClientIpBindingHash = new string('c', 64) };
        yield return x => x with { PolicyVersion = "new-policy" };
        yield return x => x with { ArtifactHash = new string('d', 64) };
        yield return x => x with { Representation = "audio" };
        yield return x => x with { MediaType = PerceptionCharacterV3Contracts.AudioMediaType };
        yield return x => x with { PhysicalWidth = 383 };
        yield return x => x with { PhysicalHeight = 143 };
        yield return x => x with { DisplayWidth = 319 };
        yield return x => x with { DisplayHeight = 119 };
        yield return x => x with { TokenHash = new string('e', 64) };
    }
    private static Dictionary<string, string?> Config(string tokenCurrent, string answerCurrent, string token, string answer)
        => new()
        {
            ["Security:PerceptionCharacterV3:TokenKeyCurrent"] = tokenCurrent,
            ["Security:PerceptionCharacterV3:AnswerKeyCurrent"] = answerCurrent,
            ["Security:PerceptionCharacterV3:TokenKeys:tk"] = token,
            ["Security:PerceptionCharacterV3:AnswerKeys:ak"] = answer
        };
    private static PerceptionCharacterV3KeyRing CreateKeys(Dictionary<string, string?> values) => new(new ConfigurationBuilder().AddInMemoryCollection(values).Build(), new FakeEnvironment());
    private sealed class FixedNonce(byte[] value) : IPerceptionCharacterV3NonceSource
    {
        public void Fill(Span<byte> destination) => value.CopyTo(destination);
    }
    private sealed class FakeEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = Environments.Production; public string ApplicationName { get; set; } = "Tests"; public string ContentRootPath { get; set; } = s_root; public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
    private sealed class Keys(byte[] token, byte[] answer) : IPerceptionCharacterV3KeyRing
    {
        public string CurrentTokenVersion => "tk";
        public string CurrentAnswerVersion => "ak";
        public bool TryGetTokenKey(string version, out byte[] key)
        {
            key = token;
            return version == "tk";
        }
        public bool TryGetAnswerKey(string version, out byte[] key)
        {
            key = answer;
            return version == "ak";
        }
    }
    private sealed class CountingKeys : IPerceptionCharacterV3KeyRing
    {
        public int Accesses
        {
            get; private set;
        }
        public string CurrentTokenVersion
        {
            get
            {
                Accesses++;
                return "tk";
            }
        }
        public string CurrentAnswerVersion
        {
            get
            {
                Accesses++;
                return "ak";
            }
        }
        public bool TryGetTokenKey(string version, out byte[] key)
        {
            Accesses++;
            key = Enumerable.Repeat((byte)0x21, 32).ToArray();
            return true;
        }
        public bool TryGetAnswerKey(string version, out byte[] key)
        {
            Accesses++;
            key = Enumerable.Repeat((byte)0x22, 32).ToArray();
            return true;
        }
    }
    private sealed class RotatingKeys(byte[] tokenKey, byte[] answerKey1, byte[] answerKey2) : IPerceptionCharacterV3KeyRing
    {
        public string CurrentTokenVersion => "tk";
        public string CurrentAnswerVersionValue { get; set; } = "ak1";
        public string CurrentAnswerVersion => CurrentAnswerVersionValue;
        public bool TryGetTokenKey(string version, out byte[] key)
        {
            key = tokenKey;
            return version == "tk";
        }
        public bool TryGetAnswerKey(string version, out byte[] key)
        {
            key = version == "ak2" ? answerKey2 : answerKey1;
            return version is "ak1" or "ak2";
        }
    }
    private sealed class CountingNonce : IPerceptionCharacterV3NonceSource
    {
        public int Calls
        {
            get; private set;
        }
        public void Fill(Span<byte> destination)
        {
            Calls++;
            destination.Clear();
        }
    }
    private sealed class TestDeviceAuthority : IPerceptionCharacterV3DeviceAuthority
    {
        public Task<PerceptionCharacterV3DeviceAuthorityResult> ResolveAsync(HttpContext context, string clientIpHash, CancellationToken cancellationToken)
        {
            string binding = context.User.FindFirst("admin_sid")?.Value ?? context.User.FindFirst("sid")?.Value ?? "server-issued-test";
            return Task.FromResult(PerceptionCharacterV3DeviceAuthorityResult.Success("session:" + binding));
        }
    }
    private sealed class FixedPool : IPerceptionCharacterV3ArtifactPool
    {
        public string ActiveGenerationId => "test-generation";
        public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task<PerceptionCharacterV3ArtifactLease?> LeaseAsync(PerceptionCharacterV3Representation representation, CancellationToken cancellationToken)
            => Task.FromResult<PerceptionCharacterV3ArtifactLease?>(Lease(representation));
    }
    private sealed class CountingPool : IPerceptionCharacterV3ArtifactPool
    {
        public string ActiveGenerationId => "test-generation";
        public int Calls
        {
            get; private set;
        }
        public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task<PerceptionCharacterV3ArtifactLease?> LeaseAsync(PerceptionCharacterV3Representation representation, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult<PerceptionCharacterV3ArtifactLease?>(Lease(representation));
        }
    }
    private sealed class CapturingBudgetPool : IPerceptionCharacterV3ArtifactPool
    {
        public string ActiveGenerationId => "test-generation";
        public List<PerceptionCharacterV3LeaseBudget> Budgets { get; } = [];
        public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task<PerceptionCharacterV3ArtifactLease?> LeaseAsync(
            PerceptionCharacterV3Representation representation,
            CancellationToken cancellationToken)
            => Task.FromResult<PerceptionCharacterV3ArtifactLease?>(Lease(representation));
        public Task<PerceptionCharacterV3PoolLeaseResult> LeaseBudgetedAsync(
            PerceptionCharacterV3Representation representation,
            PerceptionCharacterV3LeaseBudget budget,
            CancellationToken cancellationToken)
        {
            Budgets.Add(budget);
            return Task.FromResult(PerceptionCharacterV3PoolLeaseResult.Success(Lease(representation)));
        }
    }
    private sealed class EmptyPool : IPerceptionCharacterV3ArtifactPool
    {
        public string ActiveGenerationId => "test-generation";
        public int Calls
        {
            get; private set;
        }
        public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task<PerceptionCharacterV3ArtifactLease?> LeaseAsync(PerceptionCharacterV3Representation representation, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult<PerceptionCharacterV3ArtifactLease?>(null);
        }
    }
    private sealed class TogglePool : IPerceptionCharacterV3ArtifactPool
    {
        public string ActiveGenerationId => "test-generation";
        public bool Available { get; set; } = true;
        public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task<PerceptionCharacterV3ArtifactLease?> LeaseAsync(PerceptionCharacterV3Representation representation, CancellationToken cancellationToken)
        {
            return Task.FromResult<PerceptionCharacterV3ArtifactLease?>(Available ? Lease(representation) : null);
        }
    }
    private sealed class AllowGate : IPerceptionCharacterV3ResourcePlanner
    {
        private readonly PerceptionCharacterV3ResourcePlanner _inner = new(new PerceptionCharacterV3ResourcePlannerOptions());
        public void Validate() => _inner.Validate();
        public void ValidateInventory(PerceptionCharacterV3PoolInventory inventory) => _inner.ValidateInventory(inventory);
        public PerceptionCharacterV3ResourcePlannerOptions CurrentOptions() => _inner.CurrentOptions();
        public PerceptionCharacterV3ResourceDecision Plan(PerceptionCharacterV3ResourcePlanInput input) => _inner.Plan(input);
        public PerceptionCharacterV3ResourceDecision ResolveLeaseFailure(
            PerceptionCharacterV3ResourceDecision planned,
            PerceptionCharacterV3PoolLeaseOutcome outcome) => _inner.ResolveLeaseFailure(planned, outcome);
        public PerceptionCharacterV3ReplenishmentDecision PlanReplenishment(PerceptionCharacterV3ReplenishmentInput input)
            => _inner.PlanReplenishment(input);
    }
    private sealed class DenyGate : IPerceptionCharacterV3ResourcePlanner
    {
        private readonly PerceptionCharacterV3ResourcePlannerOptions _options = new();
        public void Validate() => _options.Validate();
        public void ValidateInventory(PerceptionCharacterV3PoolInventory inventory)
        {
        }
        public PerceptionCharacterV3ResourcePlannerOptions CurrentOptions() => _options;
        public PerceptionCharacterV3ResourceDecision Plan(PerceptionCharacterV3ResourcePlanInput input)
            => new(PerceptionCharacterV3ResourceDisposition.Block, PerceptionCharacterV3WatermarkState.Normal,
                PerceptionCharacterV3ActionClass.Other, "test_denied");
        public PerceptionCharacterV3ResourceDecision ResolveLeaseFailure(
            PerceptionCharacterV3ResourceDecision planned,
            PerceptionCharacterV3PoolLeaseOutcome outcome) => planned;
        public PerceptionCharacterV3ReplenishmentDecision PlanReplenishment(PerceptionCharacterV3ReplenishmentInput input)
            => new(false, 0, 0, "test_denied");
    }
    private sealed class AuditSink : IPerceptionCharacterV3AuditSink
    {
        public List<(string Operation, string Outcome, string Reason)> Events { get; } = [];
        public ValueTask WriteAsync(string operation, string challengeId, string action, string outcome, string internalReason, CancellationToken cancellationToken)
        {
            Events.Add((operation, outcome, internalReason));
            return ValueTask.CompletedTask;
        }
    }
    private sealed class ReplacementFailureStore(PerceptionCharacterV3StateRecord record, bool failRead) : IPerceptionCharacterV3StateStore
    {
        public Task<bool> CreateAsync(PerceptionCharacterV3StateRecord created, CancellationToken cancellationToken)
            => Task.FromResult(false);
        public Task<PerceptionCharacterV3Transition> ReplaceAsync(PerceptionCharacterV3StateRecord expected, PerceptionCharacterV3StateRecord replacement, long nowUnixMs, CancellationToken cancellationToken)
            => Task.FromResult(new PerceptionCharacterV3Transition(PerceptionCharacterV3TransitionKind.Unavailable, "redis_unavailable", 0));
        public Task<PerceptionCharacterV3StateRecord?> ReadAsync(string challengeId, CancellationToken cancellationToken)
            => failRead
                ? Task.FromException<PerceptionCharacterV3StateRecord?>(new PerceptionCharacterV3StoreUnavailableException(new InvalidOperationException("redis unavailable")))
                : Task.FromResult<PerceptionCharacterV3StateRecord?>(record);
        public Task<PerceptionCharacterV3Transition> VerifyAsync(PerceptionCharacterV3StateRecord expected, bool answerMatches, long nowUnixMs, CancellationToken cancellationToken)
            => throw new NotSupportedException();
        public Task<PerceptionCharacterV3Transition> RevokeAsync(PerceptionCharacterV3StateRecord expected, long nowUnixMs, CancellationToken cancellationToken)
            => Task.FromResult(new PerceptionCharacterV3Transition(PerceptionCharacterV3TransitionKind.Unavailable, "redis_unavailable", 0));
    }
    private sealed class MemoryStore : IPerceptionCharacterV3StateStore
    {
        private readonly object _sync = new();
        public Dictionary<string, PerceptionCharacterV3StateRecord> Records { get; } = [];
        public PerceptionCharacterV3Transition? LastRevocation
        {
            get; private set;
        }
        public PerceptionCharacterV3StateRecord? LastExpected
        {
            get; private set;
        }
        private readonly Dictionary<string, (string Status, int Attempts)> _states = [];
        public Task<bool> CreateAsync(PerceptionCharacterV3StateRecord record, CancellationToken cancellationToken)
        {
            lock (_sync)
            {
                Records[record.ChallengeId] = record;
                _states[record.ChallengeId] = ("active", 0);
            }
            return Task.FromResult(true);
        }
        public Task<PerceptionCharacterV3StateRecord?> ReadAsync(string challengeId, CancellationToken cancellationToken)
        {
            lock (_sync)
                return Task.FromResult(Records.GetValueOrDefault(challengeId));
        }
        public Task<PerceptionCharacterV3Transition> ReplaceAsync(PerceptionCharacterV3StateRecord expected, PerceptionCharacterV3StateRecord replacement, long nowUnixMs, CancellationToken cancellationToken)
        {
            lock (_sync)
            {
                if (!Records.TryGetValue(expected.ChallengeId, out PerceptionCharacterV3StateRecord? stored) || stored != expected)
                    return Task.FromResult(new PerceptionCharacterV3Transition(PerceptionCharacterV3TransitionKind.Rejected, "binding_mismatch", 0));
                (string status, int attempts) = _states[expected.ChallengeId];
                if (status is "expired" or "revoked")
                    return Task.FromResult(new PerceptionCharacterV3Transition(PerceptionCharacterV3TransitionKind.ReissueRequired, "expired_or_revoked", attempts));
                if (status != "active" || Records.ContainsKey(replacement.ChallengeId))
                    return Task.FromResult(new PerceptionCharacterV3Transition(PerceptionCharacterV3TransitionKind.Rejected, "replacement_conflict", attempts));
                _states[expected.ChallengeId] = ("revoked", attempts);
                Records[replacement.ChallengeId] = replacement;
                _states[replacement.ChallengeId] = ("active", 0);
                LastRevocation = new(PerceptionCharacterV3TransitionKind.Success, "replaced", attempts);
                return Task.FromResult(LastRevocation);
            }
        }
        public Task<PerceptionCharacterV3Transition> VerifyAsync(PerceptionCharacterV3StateRecord expected, bool answerMatches, long nowUnixMs, CancellationToken cancellationToken)
        {
            lock (_sync)
            {
                LastExpected = expected;
                if (!Records.TryGetValue(expected.ChallengeId, out PerceptionCharacterV3StateRecord? stored))
                    return Task.FromResult(new PerceptionCharacterV3Transition(PerceptionCharacterV3TransitionKind.Rejected, "missing", 0));
                (string status, int attempts) = _states[expected.ChallengeId];
                if (status != "active")
                    return Task.FromResult(new PerceptionCharacterV3Transition(PerceptionCharacterV3TransitionKind.Rejected, "terminal", attempts));
                if (stored != expected)
                    return Task.FromResult(new PerceptionCharacterV3Transition(PerceptionCharacterV3TransitionKind.Rejected, "binding_mismatch", attempts));
                attempts++;
                if (answerMatches)
                {
                    _states[expected.ChallengeId] = ("consumed", attempts);
                    return Task.FromResult(new PerceptionCharacterV3Transition(PerceptionCharacterV3TransitionKind.Success, "consumed", attempts));
                }
                _states[expected.ChallengeId] = (attempts == 2 ? "exhausted" : "active", attempts);
                return Task.FromResult(new PerceptionCharacterV3Transition(attempts == 2 ? PerceptionCharacterV3TransitionKind.Rejected : PerceptionCharacterV3TransitionKind.Retryable, "wrong", attempts));
            }
        }
        public Task<PerceptionCharacterV3Transition> RevokeAsync(PerceptionCharacterV3StateRecord expected, long nowUnixMs, CancellationToken cancellationToken)
        {
            lock (_sync)
            {
                if (!Records.TryGetValue(expected.ChallengeId, out PerceptionCharacterV3StateRecord? stored) || stored != expected)
                    return Task.FromResult(new PerceptionCharacterV3Transition(PerceptionCharacterV3TransitionKind.Rejected, "binding_mismatch", 0));
                if (_states[expected.ChallengeId].Status != "active")
                    return Task.FromResult(new PerceptionCharacterV3Transition(PerceptionCharacterV3TransitionKind.ReissueRequired, "expired_or_revoked", _states[expected.ChallengeId].Attempts));
                _states[expected.ChallengeId] = ("revoked", _states.GetValueOrDefault(expected.ChallengeId).Attempts);
                LastRevocation = new(PerceptionCharacterV3TransitionKind.ReissueRequired, "revoked_now", 0);
                return Task.FromResult(LastRevocation);
            }
        }
    }
    private static SecurityChallengeProviderIssueRequest ProviderIssueRequest()
        => new(new DefaultHttpContext(), PerceptionCharacterV3Contracts.WireName, "comment.create", "/api/binary/comment", "tenant-main", new string('1', 64), new string('3', 64), new string('9', 64), "issued-policy", 1, "trace")
        {
            EnvelopeId = Guid.CreateVersion7().ToString("D")
        };
}
