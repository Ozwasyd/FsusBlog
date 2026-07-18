using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PerceptionSealedTokenServiceTests
{
    private static readonly DateTimeOffset s_baselineNow = new(2026, 6, 19, 12, 0, 0, TimeSpan.Zero);
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string HashD = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    private const string HashE = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    private const string HashF = "f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1";
    private const string HashG = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    private const string HashH = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    private const string NonceHex = "00112233445566778899aabbccddeeff";

    [Fact]
    public void RuntimeServices_RegisterPerceptionSealedTokenService()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(new ConfigurationBuilder().Build());

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static item => item.ServiceType == typeof(IPerceptionSealedTokenService));
        Assert.Equal(ServiceLifetime.Singleton, descriptor.Lifetime);
        Assert.Equal(typeof(PerceptionSealedTokenService), descriptor.ImplementationType);
    }

    [Fact]
    public void SealOpen_RoundTripsPayloadWithConfiguredKeyVersion()
    {
        var clock = new MutableTimeProvider(s_baselineNow);
        IPerceptionSealedTokenService service = CreateService(clock, ("v2", KeyMaterial(2)));
        PerceptionSealedTokenPayload payload = CreatePayload(keyVersion: "v2");

        string token = service.Seal(payload);
        PerceptionSealedTokenOpenResult result = service.Open(token);

        Assert.StartsWith("fpst_", token, StringComparison.Ordinal);
        Assert.True(result.Succeeded, result.Reason);
        Assert.Equal("ok", result.Reason);
        Assert.NotNull(result.Payload);
        Assert.Matches("^[0-9a-f]{64}$", result.Payload.PayloadBindingHashHex);
        Assert.Equal(payload, result.Payload! with
        {
            PayloadBindingHashHex = string.Empty
        });
    }

    [Fact]
    public void Seal_DoesNotExposeAnswerCoordinateOrExpectedStepMaterial()
    {
        IPerceptionSealedTokenService service = CreateService(new MutableTimeProvider(s_baselineNow), ("v2", KeyMaterial(2)));
        PerceptionSealedTokenPayload payload = CreatePayload(keyVersion: "v2");

        string token = service.Seal(payload);
        string decodedEnvelopeJson = DecodeEnvelopeJson(token);

        Assert.DoesNotContain(payload.ExpectedAnswerHashHex, token, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(payload.ExpectedPointHashHex, token, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(payload.ExpectedStepHashHex, token, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(payload.ExpectedAnswerHashHex, decodedEnvelopeJson, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(payload.ExpectedPointHashHex, decodedEnvelopeJson, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(payload.ExpectedStepHashHex, decodedEnvelopeJson, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(payload.RecipeHashHex, decodedEnvelopeJson, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Open_RejectsTamperedCiphertext()
    {
        IPerceptionSealedTokenService service = CreateService(new MutableTimeProvider(s_baselineNow), ("v2", KeyMaterial(2)));
        string token = service.Seal(CreatePayload(keyVersion: "v2"));
        string tampered = MutateEnvelope(token, "ciphertext", MutateBase64Url(ReadEnvelopeString(token, "ciphertext")));

        PerceptionSealedTokenOpenResult result = service.Open(tampered);

        Assert.False(result.Succeeded);
        Assert.Equal("token_tampered", result.Reason);
        Assert.Null(result.Payload);
    }

    [Fact]
    public void Open_RejectsTamperedAadField()
    {
        IPerceptionSealedTokenService service = CreateService(new MutableTimeProvider(s_baselineNow), ("v2", KeyMaterial(2)));
        string token = service.Seal(CreatePayload(keyVersion: "v2"));
        string tampered = MutateEnvelope(token, "recipeHashHex", HashA);

        PerceptionSealedTokenOpenResult result = service.Open(tampered);

        Assert.False(result.Succeeded);
        Assert.Equal("token_tampered", result.Reason);
        Assert.Null(result.Payload);
    }

    [Fact]
    public void Open_RejectsCrossActionRouteEnvelopeSwap()
    {
        IPerceptionSealedTokenService service = CreateService(new MutableTimeProvider(s_baselineNow), ("v2", KeyMaterial(2)));
        string token = service.Seal(CreatePayload(keyVersion: "v2"));
        string tampered = MutateEnvelope(
            MutateEnvelope(token, "action", "comment.delete"),
            "routeKey",
            "article:99");

        PerceptionSealedTokenOpenResult result = service.Open(tampered);

        Assert.False(result.Succeeded);
        Assert.Equal("token_tampered", result.Reason);
        Assert.Null(result.Payload);
    }

    [Fact]
    public void Open_RejectsPayloadOnlyFieldMutation()
    {
        IPerceptionSealedTokenService service = CreateService(new MutableTimeProvider(s_baselineNow), ("v2", KeyMaterial(2)));
        string token = service.Seal(CreatePayload(keyVersion: "v2"));
        string tampered = ReencryptPayloadOnlyMutation(token, KeyMaterial(2), payload =>
        {
            payload["subjectHash"] = HashC;
        });

        PerceptionSealedTokenOpenResult result = service.Open(tampered);

        Assert.False(result.Succeeded);
        Assert.Equal("context_mismatch", result.Reason);
        Assert.Null(result.Payload);
    }

    [Fact]
    public void Open_RejectsExpiredToken()
    {
        var clock = new MutableTimeProvider(s_baselineNow);
        IPerceptionSealedTokenService service = CreateService(clock, ("v2", KeyMaterial(2)));
        string token = service.Seal(CreatePayload(keyVersion: "v2", expiresAtUnixMs: s_baselineNow.AddMinutes(1).ToUnixTimeMilliseconds()));
        clock.UtcNow = s_baselineNow.AddMinutes(2);

        PerceptionSealedTokenOpenResult result = service.Open(token);

        Assert.False(result.Succeeded);
        Assert.Equal("token_expired", result.Reason);
        Assert.Null(result.Payload);
    }

    [Fact]
    public void Open_RejectsMissingKeyVersion()
    {
        IPerceptionSealedTokenService issuer = CreateService(new MutableTimeProvider(s_baselineNow), ("v2", KeyMaterial(2)));
        IPerceptionSealedTokenService verifier = CreateService(new MutableTimeProvider(s_baselineNow), ("v1", KeyMaterial(1)));
        string token = issuer.Seal(CreatePayload(keyVersion: "v2"));

        PerceptionSealedTokenOpenResult result = verifier.Open(token);

        Assert.False(result.Succeeded);
        Assert.Equal("key_version_unknown", result.Reason);
        Assert.Null(result.Payload);
    }

    [Fact]
    public void Open_RejectsWrongKeyMaterial()
    {
        IPerceptionSealedTokenService issuer = CreateService(new MutableTimeProvider(s_baselineNow), ("v2", KeyMaterial(2)));
        IPerceptionSealedTokenService verifier = CreateService(new MutableTimeProvider(s_baselineNow), ("v2", KeyMaterial(9)));
        string token = issuer.Seal(CreatePayload(keyVersion: "v2"));

        PerceptionSealedTokenOpenResult result = verifier.Open(token);

        Assert.False(result.Succeeded);
        Assert.Equal("token_tampered", result.Reason);
        Assert.Null(result.Payload);
    }

    [Fact]
    public void Open_UsesEnvelopeKeyVersionForRotatedKeys()
    {
        IPerceptionSealedTokenService service = CreateService(
            new MutableTimeProvider(s_baselineNow),
            ("v1", KeyMaterial(1)),
            ("v2", KeyMaterial(2)));
        string tokenV1 = service.Seal(CreatePayload(keyVersion: "v1"));
        string tokenV2 = service.Seal(CreatePayload(keyVersion: "v2"));

        PerceptionSealedTokenOpenResult resultV1 = service.Open(tokenV1);
        PerceptionSealedTokenOpenResult resultV2 = service.Open(tokenV2);

        Assert.True(resultV1.Succeeded, resultV1.Reason);
        Assert.True(resultV2.Succeeded, resultV2.Reason);
        Assert.Equal("v1", resultV1.Payload!.KeyVersion);
        Assert.Equal("v2", resultV2.Payload!.KeyVersion);
    }

    private static IPerceptionSealedTokenService CreateService(
        MutableTimeProvider clock,
        params (string Version, string Key)[] keys)
        => new PerceptionSealedTokenService(
            new StaticOptionsMonitor<PerceptionSealedTokenOptions>(
                new PerceptionSealedTokenOptions
                {
                    CurrentKeyVersion = keys[^1].Version,
                    Keys = keys.ToDictionary(static item => item.Version, static item => item.Key, StringComparer.Ordinal)
                }),
            clock);

    private static PerceptionSealedTokenPayload CreatePayload(
        string keyVersion,
        long? expiresAtUnixMs = null)
        => new(
            ChallengeId: "challenge-1",
            TaskKind: "character",
            Action: "comment.create",
            RouteKey: "article:42",
            SubjectHash: HashA,
            ClientIpHash: HashB,
            DeviceFpHash: HashC,
            UaHash: HashD,
            Algorithm: "fsus.perception/character@v2",
            Family: "perception",
            Variant: "glyph-rotation",
            RecipeHashHex: HashE,
            ExpectedAnswerHashHex: HashF,
            ExpectedPointHashHex: HashG,
            ToleranceRadiusPx: 8,
            ExpectedStepHashHex: HashH,
            IssuedAtUnixMs: s_baselineNow.ToUnixTimeMilliseconds(),
            ExpiresAtUnixMs: expiresAtUnixMs ?? s_baselineNow.AddMinutes(5).ToUnixTimeMilliseconds(),
            MaxAttempts: 3,
            MinSolveDurationMs: 750,
            MaxSolveDurationMs: 60_000,
            NonceHex: NonceHex,
            KeyVersion: keyVersion,
            PolicyVersion: "risk-policy-v2");

    private static string KeyMaterial(byte seed)
        => Convert.ToBase64String(Enumerable.Repeat(seed, 32).ToArray());

    private static string DecodeEnvelopeJson(string token)
    {
        Assert.StartsWith("fpst_", token, StringComparison.Ordinal);
        return Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(token["fpst_".Length..]));
    }

    private static string ReadEnvelopeString(string token, string propertyName)
    {
        JsonNode root = JsonNode.Parse(DecodeEnvelopeJson(token)) ?? throw new InvalidOperationException("token envelope missing");
        return root[propertyName]?.GetValue<string>() ?? throw new InvalidOperationException($"token envelope property missing: {propertyName}");
    }

    private static string MutateEnvelope(string token, string propertyName, string value)
    {
        JsonNode root = JsonNode.Parse(DecodeEnvelopeJson(token)) ?? throw new InvalidOperationException("token envelope missing");
        root[propertyName] = value;
        byte[] json = JsonSerializer.SerializeToUtf8Bytes(root);
        return "fpst_" + WebEncoders.Base64UrlEncode(json);
    }

    private static string ReencryptPayloadOnlyMutation(string token, string keyMaterial, Action<JsonObject> mutate)
    {
        JsonObject envelope = JsonNode.Parse(DecodeEnvelopeJson(token))?.AsObject()
            ?? throw new InvalidOperationException("token envelope missing");
        byte[] key = Convert.FromBase64String(keyMaterial);
        byte[] nonce = WebEncoders.Base64UrlDecode(envelope["nonce"]!.GetValue<string>());
        byte[] ciphertext = WebEncoders.Base64UrlDecode(envelope["ciphertext"]!.GetValue<string>());
        byte[] tag = WebEncoders.Base64UrlDecode(envelope["tag"]!.GetValue<string>());
        byte[] plaintext = new byte[ciphertext.Length];

        using (var aes = new AesGcm(key, tag.Length))
        {
            aes.Decrypt(nonce, ciphertext, tag, plaintext, BuildTestAad(envelope, ciphertext));
        }

        JsonObject payload = JsonNode.Parse(plaintext)?.AsObject()
            ?? throw new InvalidOperationException("token payload missing");
        mutate(payload);
        byte[] mutatedPlaintext = JsonSerializer.SerializeToUtf8Bytes(payload);
        byte[] mutatedCiphertext = new byte[mutatedPlaintext.Length];
        byte[] mutatedTag = new byte[tag.Length];

        using (var aes = new AesGcm(key, tag.Length))
        {
            aes.Encrypt(nonce, mutatedPlaintext, mutatedCiphertext, mutatedTag, BuildTestAad(envelope, mutatedCiphertext));
        }

        envelope["ciphertext"] = WebEncoders.Base64UrlEncode(mutatedCiphertext);
        envelope["tag"] = WebEncoders.Base64UrlEncode(mutatedTag);
        return "fpst_" + WebEncoders.Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(envelope));
    }

    private static byte[] BuildTestAad(JsonObject envelope, byte[] ciphertext)
        => JsonSerializer.SerializeToUtf8Bytes(new
        {
            challengeId = envelope["challengeId"]!.GetValue<string>(),
            algorithm = envelope["algorithm"]!.GetValue<string>(),
            taskKind = envelope["taskKind"]!.GetValue<string>(),
            action = envelope["action"]!.GetValue<string>(),
            routeKey = envelope["routeKey"]!.GetValue<string>(),
            recipeHashHex = envelope["recipeHashHex"]!.GetValue<string>().ToLowerInvariant(),
            issuedAtUnixMs = envelope["issuedAtUnixMs"]!.GetValue<long>(),
            expiresAtUnixMs = envelope["expiresAtUnixMs"]!.GetValue<long>(),
            keyVersion = envelope["keyVersion"]!.GetValue<string>(),
            payloadCiphertextHashHex = "aes-gcm-tag-bound"
        });

    private static string MutateBase64Url(string value)
        => string.IsNullOrEmpty(value)
            ? "A"
            : (value[0] == 'A' ? 'B' : 'A').ToString() + value[1..];

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public DateTimeOffset UtcNow { get; set; } = utcNow;

        public override DateTimeOffset GetUtcNow() => UtcNow;
    }

    private sealed class StaticOptionsMonitor<T>(T value) : IOptionsMonitor<T>
    {
        public T CurrentValue { get; } = value;

        public T Get(string? name) => CurrentValue;

        public IDisposable? OnChange(Action<T, string?> listener) => null;
    }
}
