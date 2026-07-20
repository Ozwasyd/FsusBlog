using System.Diagnostics;
using System.Security.Cryptography;
using System.Security.Claims;
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

public sealed class PerceptionCharacterV3Tests
{
    private static readonly string s_root = FindRoot();
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
        foreach (string alias in new[] { "captchaV1", "perceptionCharacterV2", "perceptionTextTaskV2", "text-task" })
            Assert.NotEqual(SecurityChallengeKind.PerceptionCharacterV3, Parse(alias));
        SecurityChallengeCapability capability = SecurityChallengeCapabilityCatalog.Get(SecurityChallengeKind.PerceptionCharacterV3);
        Assert.True(capability.ProviderAvailable);
        Assert.False(capability.UiExecutorAvailable);
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
        var state = new PerceptionCharacterV3State(tag, context.MediaHash, context.ChallengeId, context.EnvelopeId, context.Action, context.RouteKey, context.SubjectHash, context.DeviceBindingHash, context.ClientIpBindingHash, context.PolicyVersion, 2, "visual", context.IssuedAtUnixMs, context.ExpiresAtUnixMs, context.TokenKeyVersion, root.GetProperty("state").GetProperty("answerKeyVersion").GetString()!);
        Assert.Equal(root.GetProperty("state").GetProperty("aadHex").GetString(), Convert.ToHexStringLower(PerceptionCharacterV3Crypto.EncodeAad(context)));
        Assert.Equal(root.GetProperty("state").GetProperty("plaintextHex").GetString(), Convert.ToHexStringLower(PerceptionCharacterV3Crypto.EncodeState(state)));
        byte[] tokenKey = Convert.FromHexString(root.GetProperty("state").GetProperty("tokenKeyHex").GetString()!);
        string token = PerceptionCharacterV3Crypto.SealState(tokenKey, context, state, new FixedNonce(Convert.FromHexString(root.GetProperty("state").GetProperty("nonceHex").GetString()!)));
        Assert.Equal(root.GetProperty("state").GetProperty("token").GetString(), token);
        Assert.True(PerceptionCharacterV3Crypto.TryOpenState(tokenKey, token, context, out PerceptionCharacterV3State? opened));
        Assert.NotNull(opened);
        Assert.Equal(PerceptionCharacterV3Crypto.EncodeState(state), PerceptionCharacterV3Crypto.EncodeState(opened));
    }

    [Fact]
    public void Raster_MatchesCanonicalHash_AndAudioIsBoundedFinalMedia()
    {
        JsonElement vector = Vectors.GetProperty("raster");
        var renderer = new PerceptionCharacterV3Renderer();
        byte[] raster = renderer.RenderVisual(vector.GetProperty("answer").GetString()!, Convert.FromHexString(vector.GetProperty("seedHex").GetString()!));
        Assert.Equal(98_304, raster.Length);
        Assert.Equal(vector.GetProperty("mediaHashHex").GetString(), Convert.ToHexStringLower(SHA256.HashData(raster)));
        byte[] audio = renderer.RenderAudio("A7C9Q", new byte[32]);
        Assert.InRange(audio.Length, 45, PerceptionCharacterV3Contracts.MaxAudioMediaBytes);
        Assert.Equal("RIFF", Encoding.ASCII.GetString(audio, 0, 4));
        AssertSpokenAudioFixture(audio, "A7C9Q");
        PerceptionCharacterV3SpokenUnit longest = PerceptionCharacterV3SpokenAtlasContract.Value.Units.Values.MaxBy(static unit => unit.SampleCount)!;
        string longestSymbol = PerceptionCharacterV3SpokenAtlasContract.Value.Units.Single(item => item.Value == longest).Key;
        Assert.InRange(renderer.RenderAudio(string.Concat(Enumerable.Repeat(longestSymbol, 5)), new byte[32]).Length, 45, PerceptionCharacterV3Contracts.MaxAudioMediaBytes);
    }

    [Fact]
    public void TypedAedsUnion_RoundTripsAndRejectsMalformedOversizedTruncatedAndUnknownKind()
    {
        string challenge = Guid.CreateVersion7().ToString("D"), envelope = Guid.CreateVersion7().ToString("D");
        byte[] media = new byte[98_304];
        var issue = new PerceptionCharacterV3IssuePayload(PerceptionCharacterV3Contracts.Algorithm, challenge, envelope, PerceptionCharacterV3Representation.Visual, "application/x-fsus-gray8", media, 512, 192, 320, 120, 2, "p1", 1, 2, "opaque");
        byte[] encoded = PodBinaryCodec.EncodePerceptionCharacterV3Issue(issue);
        Assert.True(PodBinaryCodec.TryDecodePerceptionCharacterV3Issue(encoded, out PerceptionCharacterV3IssuePayload decoded));
        Assert.Equal(issue.MediaBytes, decoded.MediaBytes);
        Assert.False(PodBinaryCodec.TryDecodePerceptionCharacterV3Issue(encoded[..^1], out _));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodePerceptionCharacterV3Issue(issue with { MediaBytes = new byte[98_305] }));
        encoded[0] = 99;
        Assert.False(PodBinaryCodec.TryDecodePerceptionCharacterV3Issue(encoded, out _));
        var verify = new PerceptionCharacterV3VerifyPayload(PerceptionCharacterV3Contracts.Algorithm, challenge, envelope, PerceptionCharacterV3Representation.Visual, "A7C9Q", "opaque");
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

    [Fact]
    public async Task ResourceLimits_RunBeforeRenderAndQueueHonorsCancellation()
    {
        var gate = new PerceptionCharacterV3ResourceGate();
        for (int i = 0; i < 8; i++)
            Assert.True(gate.TryAcquireIssue("ip" + i, "d" + i, "s", "a" + i, "c" + i, 1, out _));
        Assert.False(gate.TryAcquireIssue("new-ip", "new-device", "s", "new-action", "new-id", 1, out string dimension));
        Assert.Equal("subject", dimension);
        await using IAsyncDisposable? first = await gate.EnterRenderAsync(CancellationToken.None);
        Assert.NotNull(first);
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await gate.EnterRenderAsync(cts.Token));
    }

    [Theory]
    [InlineData("ip", 12)]
    [InlineData("device", 10)]
    [InlineData("subject", 8)]
    [InlineData("action", 30)]
    [InlineData("challenge", 2)]
    public void ResourceLimits_AreIndependent(string target, int maximum)
    {
        var gate = new PerceptionCharacterV3ResourceGate();
        for (int i = 0; i < maximum; i++)
        {
            Assert.True(gate.TryAcquireIssue(
                target == "ip" ? "same" : "ip" + i,
                target == "device" ? "same" : "device" + i,
                target == "subject" ? "same" : "subject" + i,
                target == "action" ? "same" : "action" + i,
                target == "challenge" ? "same" : "challenge" + i,
                1,
                out _));
        }

        Assert.False(gate.TryAcquireIssue(
            target == "ip" ? "same" : "ip-final",
            target == "device" ? "same" : "device-final",
            target == "subject" ? "same" : "subject-final",
            target == "action" ? "same" : "action-final",
            target == "challenge" ? "same" : "challenge-final",
            1,
            out string dimension));
        Assert.Equal(target, dimension);
    }

    [Fact]
    public async Task RejectedResourceGate_PreventsRenderAndCryptography()
    {
        var renderer = new CountingRenderer();
        var keys = new CountingKeys();
        var nonce = new CountingNonce();
        var store = new MemoryStore();
        var provider = new PerceptionCharacterV3Provider(
            keys,
            renderer,
            store,
            new DenyGate(),
            new TestDeviceAuthority(),
            nonce,
            new AuditSink(),
            TimeProvider.System);

        SecurityChallengeProviderIssueResult result = await provider.IssueAsync(ProviderIssueRequest(), CancellationToken.None);

        Assert.False(result.Succeeded);
        Assert.Equal(0, renderer.Calls);
        Assert.Equal(0, keys.Accesses);
        Assert.Equal(0, nonce.Calls);
        Assert.Empty(store.Records);
    }

    [Fact]
    public async Task StableActiveIdentityAndServerDeviceBindingCannotBeBypassedByFingerprintRotation()
    {
        var gate = new PerceptionCharacterV3ResourceGate();
        var provider = new PerceptionCharacterV3Provider(new Keys(Enumerable.Repeat((byte)0x23, 32).ToArray(), Enumerable.Repeat((byte)0x24, 32).ToArray()), new FixedRenderer(), new MemoryStore(), gate, new TestDeviceAuthority(), new PerceptionCharacterV3RandomNonceSource(), new AuditSink(), TimeProvider.System);
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
        var finalContext = new DefaultHttpContext();
        finalContext.Request.Headers["X-Fsus-Device-Fp"] = "third-rotated-client-value";
        SecurityChallengeProviderIssueResult rejected = await provider.IssueAsync(template with
        {
            Context = finalContext,
            DeviceFpHash = new string('f', 64),
            EnvelopeId = Guid.CreateVersion7().ToString("D")
        });
        Assert.False(rejected.Succeeded);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RenderExecutionDeadlineCancelsVisualAndAudioWithoutHoldingLease(bool audio)
    {
        var renderer = new TimeoutThenRenderRenderer();
        var provider = new PerceptionCharacterV3Provider(
            new Keys(Enumerable.Repeat((byte)0x25, 32).ToArray(), Enumerable.Repeat((byte)0x26, 32).ToArray()),
            renderer,
            new MemoryStore(),
            new PerceptionCharacterV3ResourceGate(),
            new TestDeviceAuthority(),
            new PerceptionCharacterV3RandomNonceSource(),
            new AuditSink(),
            TimeProvider.System,
            new PerceptionCharacterV3ProviderOptions(TimeSpan.FromMilliseconds(40)));
        SecurityChallengeProviderIssueRequest first = ProviderIssueRequest();
        if (audio)
            first.Context.Request.Headers["X-Fsus-Challenge-Representation"] = "audio";
        SecurityChallengeProviderIssueResult timedOut = await provider.IssueAsync(first);
        Assert.False(timedOut.Succeeded);
        Assert.Equal(0, renderer.ActiveCalls);

        var secondContext = new DefaultHttpContext();
        if (audio)
            secondContext.Request.Headers["X-Fsus-Challenge-Representation"] = "audio";
        SecurityChallengeProviderIssueResult recovered = await provider.IssueAsync(first with
        {
            Context = secondContext,
            EnvelopeId = Guid.CreateVersion7().ToString("D")
        });
        Assert.True(recovered.Succeeded);
        Assert.Equal(0, renderer.ActiveCalls);
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
    public void RendererHonorsCancellationBeforeExpensiveWork()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();
        Assert.ThrowsAny<OperationCanceledException>(() => new PerceptionCharacterV3Renderer().RenderVisual("A7C9Q", new byte[32], cts.Token));
        Assert.ThrowsAny<OperationCanceledException>(() => new PerceptionCharacterV3Renderer().RenderAudio("A7C9Q", new byte[32], cts.Token));
    }

    [Fact]
    public async Task RenderQueueRejectsSaturationAtBoundedDepth()
    {
        var gate = new PerceptionCharacterV3ResourceGate();
        await using IAsyncDisposable? one = await gate.EnterRenderAsync(CancellationToken.None);
        await using IAsyncDisposable? two = await gate.EnterRenderAsync(CancellationToken.None);
        using var cts = new CancellationTokenSource();
        Task<IAsyncDisposable?>[] queued = Enumerable.Range(0, 8).Select(_ => gate.EnterRenderAsync(cts.Token).AsTask()).ToArray();
        await Task.Delay(50);
        Assert.Null(await gate.EnterRenderAsync(CancellationToken.None));
        cts.Cancel();
        foreach (Task<IAsyncDisposable?> task in queued)
            await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await task);
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

    [Fact]
    public async Task Provider_IssuesOnlyTypedFinalMediaAndSupportsRevokingReplacement()
    {
        var store = new MemoryStore();
        var audit = new AuditSink();
        byte[] tokenKey = Enumerable.Repeat((byte)0x61, 32).ToArray(), answerKey = Enumerable.Repeat((byte)0x62, 32).ToArray();
        var provider = new PerceptionCharacterV3Provider(new Keys(tokenKey, answerKey), new FixedRenderer(), store, new AllowGate(), new TestDeviceAuthority(), new FixedNonce(new byte[12]), audit, TimeProvider.System);
        SecurityChallengeProviderIssueRequest request = ProviderIssueRequest();
        SecurityChallengeProviderIssueResult result = await provider.IssueAsync(request, CancellationToken.None);
        Assert.True(result.Succeeded);
        Assert.NotNull(result.PerceptionCharacterV3);
        Assert.Empty(result.ProviderPayload);
        Assert.Equal(98_304, result.PerceptionCharacterV3.MediaBytes.Length);
        Assert.DoesNotContain("answer", result.PerceptionCharacterV3.StateToken, StringComparison.OrdinalIgnoreCase);

        PerceptionCharacterV3StateRecord first = store.Records.Values.Single();
        Assert.Equal(request.DeviceFpHash, result.Assignment!.DeviceFpHash);
        Assert.NotEqual(first.DeviceBindingHash, result.Assignment.DeviceFpHash);
        var audioContext = new DefaultHttpContext();
        audioContext.Request.Headers["X-Fsus-Challenge-Representation"] = "audio";
        audioContext.Request.Headers["X-Fsus-Replaces-Challenge"] = first.ChallengeId;
        audioContext.Request.Headers["X-Fsus-Replaces-Envelope"] = first.EnvelopeId;
        audioContext.Request.Headers["X-Fsus-Replaces-State-Token"] = result.PerceptionCharacterV3.StateToken;
        SecurityChallengeProviderIssueResult replacement = await provider.IssueAsync(request with
        {
            Context = audioContext,
            EnvelopeId = Guid.CreateVersion7().ToString("D")
        }, CancellationToken.None);
        Assert.True(replacement.Succeeded);
        Assert.Equal(PerceptionCharacterV3Representation.Audio, replacement.PerceptionCharacterV3!.Representation);
        Assert.Equal(PerceptionCharacterV3TransitionKind.ReissueRequired, store.LastRevocation!.Kind);
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
        var provider = new PerceptionCharacterV3Provider(new Keys(tokenKey, answerKey), new FixedRenderer(), store, new AllowGate(), new TestDeviceAuthority(), new PerceptionCharacterV3RandomNonceSource(), audit, TimeProvider.System);
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
        var provider = new PerceptionCharacterV3Provider(new Keys(Enumerable.Repeat((byte)0x29, 32).ToArray(), Enumerable.Repeat((byte)0x2a, 32).ToArray()), new FixedRenderer(), store, new AllowGate(), new TestDeviceAuthority(), new PerceptionCharacterV3RandomNonceSource(), audit, TimeProvider.System);
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
    public async Task ReplacementInvalidFieldsKeepSpecificAuditBehindCoarseRejection()
    {
        var store = new MemoryStore();
        var audit = new AuditSink();
        var provider = new PerceptionCharacterV3Provider(
            new Keys(Enumerable.Repeat((byte)0x31, 32).ToArray(), Enumerable.Repeat((byte)0x32, 32).ToArray()),
            new FixedRenderer(), store, new AllowGate(), new TestDeviceAuthority(), new FixedNonce(new byte[12]), audit, TimeProvider.System);
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
            request.ClientIpHash, request.PolicyVersion, new string('4', 64), "visual", 1, 2, "tk", "ak",
            Convert.ToHexStringLower(SHA256.HashData(Encoding.ASCII.GetBytes(token))));
        var audit = new AuditSink();
        var provider = new PerceptionCharacterV3Provider(
            new Keys(Enumerable.Repeat((byte)0x33, 32).ToArray(), answerKey), new FixedRenderer(),
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

    [Theory]
    [InlineData("comment.create", "/api/binary/comment")]
    [InlineData("auth.login", "/api/binary/auth/login")]
    [InlineData("admin.security.write", "/api/binary/admin/security")]
    [InlineData("notification.subscribe", "notification:subscribe")]
    public async Task ProviderPreservesBindingsAcrossAnonymousLoginAdminAndNotificationActions(string action, string route)
    {
        byte[] tokenKey = Enumerable.Repeat((byte)0x31, 32).ToArray(), answerKey = Enumerable.Repeat((byte)0x32, 32).ToArray();
        var store = new MemoryStore();
        var provider = new PerceptionCharacterV3Provider(new Keys(tokenKey, answerKey), new FixedRenderer(), store, new AllowGate(), new TestDeviceAuthority(), new FixedNonce(new byte[12]), new AuditSink(), TimeProvider.System);
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
        var context = new PerceptionCharacterV3BindingContext(record.ChallengeId, record.EnvelopeId, record.Action, record.RouteKey, record.SubjectHash, record.DeviceBindingHash, record.ClientIpBindingHash, record.PolicyVersion, record.MediaHash, record.IssuedAtUnixMs, record.ExpiresAtUnixMs, record.TokenKeyVersion);
        byte[] tag = PerceptionCharacterV3Crypto.ComputeAnswerTag(answerKey, context, "A7C9Q");
        var state = new PerceptionCharacterV3State(tag, record.MediaHash, record.ChallengeId, record.EnvelopeId, record.Action, record.RouteKey, record.SubjectHash, record.DeviceBindingHash, record.ClientIpBindingHash, record.PolicyVersion, 2, "visual", record.IssuedAtUnixMs, record.ExpiresAtUnixMs, record.TokenKeyVersion, record.AnswerKeyVersion);
        string token = PerceptionCharacterV3Crypto.SealState(tokenKey, context, state, new FixedNonce(new byte[12]));
        record = record with
        {
            TokenHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.ASCII.GetBytes(token)))
        };
        Assert.True(await store.CreateAsync(record, CancellationToken.None));
        var provider = new PerceptionCharacterV3Provider(new Keys(tokenKey, answerKey), new FixedRenderer(), store, new AllowGate(), new TestDeviceAuthority(), new FixedNonce(new byte[12]), audit, TimeProvider.System);
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
    public void RendererAndCryptoStayWithinLocalPerformanceBudget()
    {
        var renderer = new PerceptionCharacterV3Renderer();
        var watch = Stopwatch.StartNew();
        _ = renderer.RenderVisual("A7C9Q", new byte[32]);
        watch.Stop();
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(3), watch.Elapsed.ToString());
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
        var store = new RedisPerceptionCharacterV3StateStore(redis, new DefaultRuntimeKeyScope());
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        var deviceAuthority = new RedisPerceptionCharacterV3DeviceAuthority(redis, new DefaultRuntimeKeyScope());
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
        var authoritativeDeviceGate = new PerceptionCharacterV3ResourceGate();
        for (int i = 0; i < 10; i++)
            Assert.True(authoritativeDeviceGate.TryAcquireIssue("ip" + i, firstDevice.Binding, "subject" + i, "action" + i, "identity" + i, now, out _));
        Assert.False(authoritativeDeviceGate.TryAcquireIssue("ip-final", firstDevice.Binding, "subject-final", "action-final", "identity-final", now, out string deviceDimension));
        Assert.Equal("device", deviceDimension);
        Assert.True(authoritativeDeviceGate.TryAcquireIssue("ip-independent", independentDevice.Binding, "subject-independent", "action-independent", "identity-independent", now, out _));

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

        await using ConnectionMultiplexer unavailable = await ConnectionMultiplexer.ConnectAsync("127.0.0.1:1,abortConnect=false,connectTimeout=50,syncTimeout=50,asyncTimeout=50");
        var unavailableStore = new RedisPerceptionCharacterV3StateStore(unavailable, new DefaultRuntimeKeyScope());
        Assert.Equal(PerceptionCharacterV3TransitionKind.Unavailable, (await unavailableStore.VerifyAsync(Record(now), true, now, CancellationToken.None)).Kind);
        var unavailableAuthority = new RedisPerceptionCharacterV3DeviceAuthority(unavailable, new DefaultRuntimeKeyScope());
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
        return new(c.GetProperty("challengeId").GetString()!, c.GetProperty("envelopeId").GetString()!, c.GetProperty("action").GetString()!, c.GetProperty("routeKey").GetString()!, c.GetProperty("subjectHash").GetString()!, c.GetProperty("deviceBindingHash").GetString()!, c.GetProperty("clientIpBindingHash").GetString()!, c.GetProperty("policyVersion").GetString()!, c.GetProperty("mediaHash").GetString()!, c.GetProperty("issuedAtUnixMs").GetInt64(), c.GetProperty("expiresAtUnixMs").GetInt64(), c.GetProperty("tokenKeyVersion").GetString()!);
    }
    private static PerceptionCharacterV3StateRecord Record(long now) => new(Guid.CreateVersion7().ToString("D"), Guid.CreateVersion7().ToString("D"), "comment.create", "/api/binary/comment", new string('1', 64), new string('2', 64), new string('3', 64), "issued-policy", new string('4', 64), "visual", now, now + 120_000, "tk", "ak", new string('5', 64));
    private static IEnumerable<Func<PerceptionCharacterV3StateRecord, PerceptionCharacterV3StateRecord>> Mutations()
    {
        yield return x => x with { ChallengeId = Guid.CreateVersion7().ToString("D") };
        yield return x => x with { EnvelopeId = Guid.CreateVersion7().ToString("D") };
        yield return x => x with { Action = "auth.login" };
        yield return x => x with { RouteKey = "/other" };
        yield return x => x with { SubjectHash = new string('a', 64) };
        yield return x => x with { DeviceBindingHash = new string('b', 64) };
        yield return x => x with { ClientIpBindingHash = new string('c', 64) };
        yield return x => x with { PolicyVersion = "new-policy" };
        yield return x => x with { MediaHash = new string('d', 64) };
        yield return x => x with { Representation = "audio" };
        yield return x => x with { TokenHash = new string('e', 64) };
    }
    private static Dictionary<string, string?> Config(string tokenCurrent, string answerCurrent, string token, string answer) => new() { ["Security:PerceptionCharacterV3:TokenKeyCurrent"] = tokenCurrent, ["Security:PerceptionCharacterV3:AnswerKeyCurrent"] = answerCurrent, ["Security:PerceptionCharacterV3:TokenKeys:tk"] = token, ["Security:PerceptionCharacterV3:AnswerKeys:ak"] = answer };
    private static PerceptionCharacterV3KeyRing CreateKeys(Dictionary<string, string?> values) => new(new ConfigurationBuilder().AddInMemoryCollection(values).Build(), new FakeEnvironment());
    private static string FindRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null && !File.Exists(Path.Combine(current.FullName, "FsusBlog.slnx")))
            current = current.Parent;
        return current?.FullName ?? throw new DirectoryNotFoundException();
    }
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
        public string CurrentTokenVersion => "tk"; public string CurrentAnswerVersion => "ak"; public bool TryGetTokenKey(string version, out byte[] key)
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
    private sealed class FixedRenderer : IPerceptionCharacterV3Renderer
    {
        public byte[] RenderVisual(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default) => new byte[98_304]; public byte[] RenderAudio(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default) => Encoding.ASCII.GetBytes("RIFF-final-audio");
    }
    private sealed class CountingRenderer : IPerceptionCharacterV3Renderer
    {
        public int Calls
        {
            get; private set;
        }
        public byte[] RenderVisual(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default)
        {
            Calls++;
            return new byte[98_304];
        }
        public byte[] RenderAudio(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default)
        {
            Calls++;
            return Encoding.ASCII.GetBytes("RIFF-final-audio");
        }
    }
    private sealed class TimeoutThenRenderRenderer : IPerceptionCharacterV3Renderer
    {
        private int _calls;
        public int ActiveCalls
        {
            get; private set;
        }
        public byte[] RenderVisual(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default)
            => Render(false, cancellationToken);
        public byte[] RenderAudio(string answer, ReadOnlySpan<byte> seed, CancellationToken cancellationToken = default)
            => Render(true, cancellationToken);
        private byte[] Render(bool audio, CancellationToken cancellationToken)
        {
            ActiveCalls++;
            try
            {
                if (Interlocked.Increment(ref _calls) == 1)
                {
                    cancellationToken.WaitHandle.WaitOne();
                    cancellationToken.ThrowIfCancellationRequested();
                }
                return audio ? Encoding.ASCII.GetBytes("RIFF-final-audio") : new byte[98_304];
            }
            finally { ActiveCalls--; }
        }
    }
    private sealed class AllowGate : IPerceptionCharacterV3ResourceGate
    {
        public bool TryAcquireIssue(string ip, string device, string subject, string action, string identity, long nowUnixMs, out string dimension)
        {
            dimension = string.Empty;
            return true;
        }
        public ValueTask<IAsyncDisposable?> EnterRenderAsync(CancellationToken cancellationToken) => ValueTask.FromResult<IAsyncDisposable?>(new AsyncLease());
    }
    private sealed class DenyGate : IPerceptionCharacterV3ResourceGate
    {
        public bool TryAcquireIssue(string ip, string device, string subject, string action, string identity, long nowUnixMs, out string dimension)
        {
            dimension = "ip";
            return false;
        }
        public ValueTask<IAsyncDisposable?> EnterRenderAsync(CancellationToken cancellationToken) => throw new InvalidOperationException("Render queue must not be reached.");
    }
    private sealed class AsyncLease : IAsyncDisposable
    {
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
    private sealed class AuditSink : IPerceptionCharacterV3AuditSink
    {
        public List<(string Operation, string Outcome, string Reason)> Events { get; } = []; public ValueTask WriteAsync(string operation, string challengeId, string action, string outcome, string internalReason, CancellationToken cancellationToken)
        {
            Events.Add((operation, outcome, internalReason));
            return ValueTask.CompletedTask;
        }
    }
    private sealed class ReplacementFailureStore(PerceptionCharacterV3StateRecord record, bool failRead) : IPerceptionCharacterV3StateStore
    {
        public Task<bool> CreateAsync(PerceptionCharacterV3StateRecord created, CancellationToken cancellationToken)
            => Task.FromResult(false);
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
        private readonly object _sync = new(); public Dictionary<string, PerceptionCharacterV3StateRecord> Records { get; } = []; public PerceptionCharacterV3Transition? LastRevocation
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
    private static SecurityChallengeProviderIssueRequest ProviderIssueRequest() => new(new DefaultHttpContext(), PerceptionCharacterV3Contracts.WireName, "comment.create", "/api/binary/comment", "tenant-main", new string('1', 64), new string('3', 64), new string('9', 64), "issued-policy", 1, "trace") { EnvelopeId = Guid.CreateVersion7().ToString("D") };
}
