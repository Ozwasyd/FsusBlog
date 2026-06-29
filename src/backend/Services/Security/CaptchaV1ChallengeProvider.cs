using System.Buffers.Binary;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Shared.Contracts.Security;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.Server.Services.Security;

public sealed class CaptchaV1ChallengeProvider(
    IUnifiedCache cache,
    ISecurityChallengePersistenceService persistence,
    ISecurityRiskSignalSink riskSignalSink,
    IConfiguration configuration,
    TimeProvider timeProvider) : ISecurityChallengeProvider
{
    public const string WireKind = "captchaV1";
    public const string Algorithm = "fsu.captcha/chebyshev-noise@v1";

    private const int ChallengeTtlSeconds = 300;
    private const int MinSolveDurationMs = 750;
    private const int MaxSolveDurationMs = 60_000;
    private const int GridWidth = 64;
    private const int GridHeight = 24;
    private const int DistortionLevel = 18;
    private const int PowDifficultyBits = 8;
    private static readonly TimeSpan RiskSignalTtl = TimeSpan.FromMinutes(10);
    private static readonly HashSet<string> KnownDevelopmentSigningKeys = new(StringComparer.Ordinal)
    {
        "development-captcha-signing-key-change-before-shared-use",
        "CHANGE_ME_CAPTCHA_SIGNING_KEY"
    };

    public string Kind => WireKind;

    public async Task<SecurityChallengeProviderIssueResult> IssueAsync(SecurityChallengeProviderIssueRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        DateTimeOffset issuedAt = timeProvider.GetUtcNow();
        DateTimeOffset expiresAt = issuedAt.AddSeconds(ChallengeTtlSeconds);
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        string polynomialSeedHex = CaptchaV1ChallengeCodec.RandomSeedHex();
        string noiseSeedHex = CaptchaV1ChallengeCodec.RandomSeedHex();
        string seedPayloadBase64 = CaptchaV1ChallengeCodec.CreateSeedPayloadBase64(
            challengeId,
            request,
            polynomialSeedHex,
            noiseSeedHex,
            GridWidth,
            GridHeight,
            DistortionLevel,
            PowDifficultyBits,
            issuedAt.ToUnixTimeMilliseconds(),
            expiresAt.ToUnixTimeMilliseconds());
        string signatureHex = CaptchaV1ChallengeCodec.SignSeedPayload(seedPayloadBase64, ResolveSigningKey(configuration));

        var payload = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["algorithm"] = Algorithm,
            ["polynomialSeedHex"] = polynomialSeedHex,
            ["noiseSeedHex"] = noiseSeedHex,
            ["seedPayloadBase64"] = seedPayloadBase64,
            ["signatureHex"] = signatureHex,
            ["gridWidth"] = GridWidth.ToString(CultureInfo.InvariantCulture),
            ["gridHeight"] = GridHeight.ToString(CultureInfo.InvariantCulture),
            ["distortionLevel"] = DistortionLevel.ToString(CultureInfo.InvariantCulture),
            ["powDifficultyBits"] = PowDifficultyBits.ToString(CultureInfo.InvariantCulture),
            ["issuedAtUnixMs"] = issuedAt.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture),
            ["expiresAtUnixMs"] = expiresAt.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture)
        };
        string payloadHash = HashPayload(payload);

        await persistence.IssueAsync(
            new SecurityChallengeIssueRequest(
                challengeId,
                WireKind,
                Algorithm,
                request.Action,
                request.RouteKey,
                request.SubjectHash,
                request.ClientIpHash,
                request.DeviceFpHash,
                request.PolicyVersion,
                payloadHash,
                request.Context.TraceIdentifier,
                request.Traceparent,
                issuedAt.UtcDateTime,
                expiresAt.UtcDateTime),
            cancellationToken);
        await cache.SetStringAsync(
            CachePolicyId.SecurityCaptchaChallenge,
            challengeId,
            payloadHash,
            expiresAt - issuedAt,
            cancellationToken);

        var assignment = new SecurityChallengeAssignment(
            challengeId,
            request.Traceparent,
            request.TenantId,
            SecurityChallengeKind.CaptchaV1,
            request.EscalationLevel,
            request.Action,
            request.RouteKey,
            request.SubjectHash,
            request.ClientIpHash,
            request.DeviceFpHash,
            issuedAt.ToUnixTimeMilliseconds(),
            expiresAt.ToUnixTimeMilliseconds());
        return SecurityChallengeProviderIssueResult.Success(assignment, payload);
    }

    public async Task<SecurityChallengeProviderVerifyResult> VerifyAsync(SecurityChallengeProviderVerifyRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();

        if (!CaptchaV1ChallengeCodec.TryParseVerifyPayload(request.ProviderPayload, out CaptchaV1ChallengeVerifyPayload payload))
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, "captcha_payload_invalid", "CaptchaInvalid", null, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("captcha_payload_invalid");
        }

        if (!CaptchaV1ChallengeCodec.VerifySignedPayload(payload, request, ResolveSigningKey(configuration)))
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, "captcha_signature_invalid", "CaptchaInvalid", payload.ResponseTokenHex, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("captcha_signature_invalid");
        }

        DateTimeOffset now = timeProvider.GetUtcNow();
        DateTimeOffset expiresAt = DateTimeOffset.FromUnixTimeMilliseconds(payload.ExpiresAtUnixMs);
        if (expiresAt <= now)
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Expired, "captcha_expired", "CaptchaInvalid", payload.ResponseTokenHex, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("captcha_expired");
        }

        bool consumed = await cache.ConsumeOnceAsync(CachePolicyId.SecurityCaptchaChallenge, request.ChallengeId, cancellationToken);
        if (!consumed)
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Replayed, "captcha_replayed", "CaptchaReplay", payload.ResponseTokenHex, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("captcha_replayed");
        }

        if (payload.SolveDurationMs < MinSolveDurationMs)
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, "captcha_solve_too_fast", "CaptchaSolveTooFast", payload.ResponseTokenHex, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("captcha_solve_too_fast");
        }

        if (payload.SolveDurationMs > MaxSolveDurationMs)
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, "captcha_solve_too_slow", "CaptchaSolveTooSlow", payload.ResponseTokenHex, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("captcha_solve_too_slow");
        }

        CaptchaV1ChallengeSolution expected = CaptchaV1ChallengeCodec.CreateSolution(payload);
        if (!string.Equals(payload.AnswerText.Trim().ToUpperInvariant(), expected.AnswerText, StringComparison.Ordinal))
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, "captcha_answer_invalid", "CaptchaInvalid", payload.ResponseTokenHex, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("captcha_answer_invalid");
        }

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(payload.NonceHex),
                Encoding.ASCII.GetBytes(expected.NonceHex)))
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, "captcha_nonce_invalid", "CaptchaInvalid", payload.ResponseTokenHex, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("captcha_nonce_invalid");
        }

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(payload.ResponseTokenHex),
                Encoding.ASCII.GetBytes(expected.ResponseTokenHex)))
        {
            await RecordRejectedAsync(request, SecurityChallengeAttemptOutcomes.Failed, "captcha_token_invalid", "CaptchaInvalid", payload.ResponseTokenHex, cancellationToken);
            return SecurityChallengeProviderVerifyResult.Failed("captcha_token_invalid");
        }

        await RecordAttemptAsync(request, SecurityChallengeAttemptOutcomes.Verified, "ok", payload.ResponseTokenHex, cancellationToken);
        return SecurityChallengeProviderVerifyResult.Success(expiresAt);
    }

    private async Task RecordRejectedAsync(
        SecurityChallengeProviderVerifyRequest request,
        string outcome,
        string reason,
        string riskDetail,
        string? responseTokenHex,
        CancellationToken cancellationToken)
    {
        await RecordAttemptAsync(request, outcome, reason, responseTokenHex, cancellationToken);
        await riskSignalSink.AddRiskAsync(
            new SecurityRiskSignal(
                request.Context,
                SecurityRiskReason.SecurityChallengeRejected,
                10,
                RiskSignalTtl,
                SecurityRiskSources.RiskControl,
                string.IsNullOrWhiteSpace(request.Action) ? "security_challenge" : request.Action,
                riskDetail),
            cancellationToken);
    }

    private Task RecordAttemptAsync(
        SecurityChallengeProviderVerifyRequest request,
        string outcome,
        string reason,
        string? responseTokenHex,
        CancellationToken cancellationToken)
        => persistence.RecordAttemptAsync(
            new SecurityChallengeAttemptRequest(
                request.ChallengeId,
                outcome,
                reason,
                string.IsNullOrWhiteSpace(responseTokenHex) ? null : HashValue(responseTokenHex),
                request.ClientIpHash,
                request.DeviceFpHash,
                request.Context.TraceIdentifier,
                ResolveTraceparent(request.Context),
                timeProvider.GetUtcNow().UtcDateTime),
            cancellationToken);

    private static string? ResolveTraceparent(HttpContext context)
        => context.Request.Headers.TryGetValue("traceparent", out var values)
            ? values.ToString()
            : null;

    private static byte[] ResolveSigningKey(IConfiguration configuration)
    {
        string key = configuration["Security:CaptchaV1:SigningKey"] ?? string.Empty;
        if (string.IsNullOrWhiteSpace(key) || key.Trim().Length < 32)
        {
            throw new InvalidOperationException("Security:CaptchaV1:SigningKey must be configured with at least 32 characters.");
        }

        string normalized = key.Trim();
        if (KnownDevelopmentSigningKeys.Contains(normalized))
        {
            throw new InvalidOperationException("Security:CaptchaV1:SigningKey must not use a checked-in development value.");
        }

        return Encoding.UTF8.GetBytes(normalized);
    }

    private static string HashPayload(IReadOnlyDictionary<string, string> payload)
    {
        using var stream = new MemoryStream();
        foreach (KeyValuePair<string, string> item in payload.OrderBy(static item => item.Key, StringComparer.Ordinal))
        {
            WriteLengthPrefixed(stream, item.Key);
            WriteLengthPrefixed(stream, item.Value);
        }

        return Convert.ToHexStringLower(SHA256.HashData(stream.ToArray()));
    }

    private static void WriteLengthPrefixed(Stream stream, string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        Span<byte> length = stackalloc byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
        stream.Write(length);
        stream.Write(bytes);
    }

    private static string HashValue(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}

public sealed record CaptchaV1ChallengeSolution(
    string AnswerText,
    string ResponseTokenHex,
    string NonceHex);

public sealed record CaptchaV1ChallengeVerifyPayload(
    string Algorithm,
    string PolynomialSeedHex,
    string NoiseSeedHex,
    string SeedPayloadBase64,
    string SignatureHex,
    int GridWidth,
    int GridHeight,
    int DistortionLevel,
    int PowDifficultyBits,
    long IssuedAtUnixMs,
    long ExpiresAtUnixMs,
    string AnswerText,
    string ResponseTokenHex,
    string NonceHex,
    int SolveDurationMs);

public static class CaptchaV1ChallengeCodec
{
    private static readonly string[] Alphabet = ["A", "E", "F", "H", "K", "M", "R", "T", "Y", "2", "3", "4"];
    private const int MaxPowNonceAttempts = 1 << (8 + 4);
    private const ulong Mask64 = ulong.MaxValue;

    public static string RandomSeedHex()
        => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    public static string CreateSeedPayloadBase64(
        string challengeId,
        SecurityChallengeProviderIssueRequest request,
        string polynomialSeedHex,
        string noiseSeedHex,
        int gridWidth,
        int gridHeight,
        int distortionLevel,
        int powDifficultyBits,
        long issuedAtUnixMs,
        long expiresAtUnixMs)
    {
        string payload = string.Join('\n',
            "v=1",
            $"challengeId={challengeId}",
            $"kind={CaptchaV1ChallengeProvider.WireKind}",
            $"algorithm={CaptchaV1ChallengeProvider.Algorithm}",
            $"action={request.Action}",
            $"routeKey={request.RouteKey}",
            $"tenantId={request.TenantId}",
            $"subjectHash={request.SubjectHash}",
            $"clientIpHash={request.ClientIpHash}",
            $"deviceFpHash={request.DeviceFpHash}",
            $"policyVersion={request.PolicyVersion}",
            $"polynomialSeedHex={polynomialSeedHex}",
            $"noiseSeedHex={noiseSeedHex}",
            $"gridWidth={gridWidth.ToString(CultureInfo.InvariantCulture)}",
            $"gridHeight={gridHeight.ToString(CultureInfo.InvariantCulture)}",
            $"distortionLevel={distortionLevel.ToString(CultureInfo.InvariantCulture)}",
            $"powDifficultyBits={powDifficultyBits.ToString(CultureInfo.InvariantCulture)}",
            $"issuedAtUnixMs={issuedAtUnixMs.ToString(CultureInfo.InvariantCulture)}",
            $"expiresAtUnixMs={expiresAtUnixMs.ToString(CultureInfo.InvariantCulture)}");
        return WebEncoders.Base64UrlEncode(Encoding.UTF8.GetBytes(payload));
    }

    public static string SignSeedPayload(string seedPayloadBase64, byte[] signingKey)
    {
        using var hmac = new HMACSHA256(signingKey);
        return Convert.ToHexStringLower(hmac.ComputeHash(Encoding.UTF8.GetBytes(seedPayloadBase64)));
    }

    public static bool TryParseVerifyPayload(IReadOnlyDictionary<string, string> payload, out CaptchaV1ChallengeVerifyPayload parsed)
    {
        parsed = default!;
        if (!TryGet(payload, "algorithm", out string algorithm)
            || !TryGet(payload, "polynomialSeedHex", out string polynomialSeedHex)
            || !TryGet(payload, "noiseSeedHex", out string noiseSeedHex)
            || !TryGet(payload, "seedPayloadBase64", out string seedPayloadBase64)
            || !TryGet(payload, "signatureHex", out string signatureHex)
            || !TryGet(payload, "answerText", out string answerText)
            || !TryGet(payload, "responseTokenHex", out string responseTokenHex)
            || !TryGet(payload, "nonceHex", out string nonceHex)
            || !TryInt(payload, "gridWidth", out int gridWidth)
            || !TryInt(payload, "gridHeight", out int gridHeight)
            || !TryInt(payload, "distortionLevel", out int distortionLevel)
            || !TryInt(payload, "powDifficultyBits", out int powDifficultyBits)
            || !TryLong(payload, "issuedAtUnixMs", out long issuedAtUnixMs)
            || !TryLong(payload, "expiresAtUnixMs", out long expiresAtUnixMs)
            || !TryInt(payload, "solveDurationMs", out int solveDurationMs))
        {
            return false;
        }

        if (!string.Equals(algorithm, CaptchaV1ChallengeProvider.Algorithm, StringComparison.Ordinal)
            || !IsHex(polynomialSeedHex, 64)
            || !IsHex(noiseSeedHex, 64)
            || !IsHex(signatureHex, 64)
            || !IsHex(responseTokenHex, 64)
            || !IsHex(nonceHex, 8)
            || gridWidth is < 1 or > 256
            || gridHeight is < 1 or > 64
            || distortionLevel is < 0 or > 100
            || powDifficultyBits is < 1 or > 24
            || expiresAtUnixMs <= issuedAtUnixMs)
        {
            return false;
        }

        parsed = new CaptchaV1ChallengeVerifyPayload(
            algorithm,
            polynomialSeedHex.ToLowerInvariant(),
            noiseSeedHex.ToLowerInvariant(),
            seedPayloadBase64,
            signatureHex.ToLowerInvariant(),
            gridWidth,
            gridHeight,
            distortionLevel,
            powDifficultyBits,
            issuedAtUnixMs,
            expiresAtUnixMs,
            answerText,
            responseTokenHex.ToLowerInvariant(),
            nonceHex.ToLowerInvariant(),
            solveDurationMs);
        return true;
    }

    public static bool VerifySignedPayload(CaptchaV1ChallengeVerifyPayload payload, SecurityChallengeProviderVerifyRequest request, byte[] signingKey)
    {
        string expectedSignature = SignSeedPayload(payload.SeedPayloadBase64, signingKey);
        if (!FixedTimeEqualsHex(payload.SignatureHex, expectedSignature))
        {
            return false;
        }

        if (!TryDecodeSeedPayload(payload.SeedPayloadBase64, out IReadOnlyDictionary<string, string> claims))
        {
            return false;
        }

        return Matches(claims, "challengeId", request.ChallengeId)
            && Matches(claims, "kind", CaptchaV1ChallengeProvider.WireKind)
            && Matches(claims, "algorithm", CaptchaV1ChallengeProvider.Algorithm)
            && Matches(claims, "action", request.Action)
            && Matches(claims, "routeKey", request.RouteKey)
            && Matches(claims, "subjectHash", request.SubjectHash)
            && Matches(claims, "clientIpHash", request.ClientIpHash)
            && Matches(claims, "deviceFpHash", request.DeviceFpHash)
            && Matches(claims, "policyVersion", request.PolicyVersion)
            && Matches(claims, "polynomialSeedHex", payload.PolynomialSeedHex)
            && Matches(claims, "noiseSeedHex", payload.NoiseSeedHex)
            && Matches(claims, "gridWidth", payload.GridWidth.ToString(CultureInfo.InvariantCulture))
            && Matches(claims, "gridHeight", payload.GridHeight.ToString(CultureInfo.InvariantCulture))
            && Matches(claims, "distortionLevel", payload.DistortionLevel.ToString(CultureInfo.InvariantCulture))
            && Matches(claims, "powDifficultyBits", payload.PowDifficultyBits.ToString(CultureInfo.InvariantCulture))
            && Matches(claims, "issuedAtUnixMs", payload.IssuedAtUnixMs.ToString(CultureInfo.InvariantCulture))
            && Matches(claims, "expiresAtUnixMs", payload.ExpiresAtUnixMs.ToString(CultureInfo.InvariantCulture));
    }

    public static CaptchaV1ChallengeSolution CreateSolution(IReadOnlyDictionary<string, string> payload)
    {
        if (!TryParseIssuePayload(payload, out CaptchaV1ChallengeVerifyPayload parsed))
        {
            throw new ArgumentException("captcha issue payload is invalid", nameof(payload));
        }

        return CreateSolution(parsed);
    }

    public static CaptchaV1ChallengeSolution CreateSolution(CaptchaV1ChallengeVerifyPayload payload)
    {
        CaptchaV1ChallengeSpec spec = CreateSpec(payload);
        string answer = DeriveAnswer(spec);
        byte[] specMaterial = BuildSpecMaterial(spec);
        byte[] answerBytes = Encoding.ASCII.GetBytes(answer);
        byte[] buffer = new byte[specMaterial.Length + answerBytes.Length + sizeof(uint)];
        specMaterial.CopyTo(buffer, 0);
        answerBytes.CopyTo(buffer.AsSpan(specMaterial.Length));
        int nonceOffset = specMaterial.Length + answerBytes.Length;
        Span<byte> hash = stackalloc byte[32];
        for (uint nonce = 0; nonce < MaxPowNonceAttempts; nonce++)
        {
            WriteUInt32LittleEndian(buffer.AsSpan(nonceOffset), nonce);
            SHA256.HashData(buffer, hash);
            if (LeadingZeroBits(hash) >= spec.PowDifficultyBits)
            {
                return new CaptchaV1ChallengeSolution(answer, Convert.ToHexStringLower(hash), NonceToHex(nonce));
            }
        }

        throw new InvalidOperationException("captcha nonce unavailable");
    }

    private static bool TryParseIssuePayload(IReadOnlyDictionary<string, string> payload, out CaptchaV1ChallengeVerifyPayload parsed)
    {
        var copy = new Dictionary<string, string>(payload, StringComparer.Ordinal)
        {
            ["answerText"] = "AAAA",
            ["responseTokenHex"] = new string('0', 64),
            ["nonceHex"] = new string('0', 8),
            ["solveDurationMs"] = "1000"
        };
        return TryParseVerifyPayload(copy, out parsed);
    }

    private static CaptchaV1ChallengeSpec CreateSpec(CaptchaV1ChallengeVerifyPayload payload)
        => new(
            HexToBytes(payload.PolynomialSeedHex),
            HexToBytes(payload.NoiseSeedHex),
            payload.GridWidth,
            payload.GridHeight,
            payload.DistortionLevel,
            payload.PowDifficultyBits);

    private static string DeriveAnswer(CaptchaV1ChallengeSpec spec)
    {
        (ulong S0, ulong S1, ulong S2, ulong S3) state = MakeSeedState(spec);
        var builder = new StringBuilder(4);
        for (int i = 0; i < 4; i++)
        {
            builder.Append(Alphabet[(int)(XoshiroNext(ref state) % (ulong)Alphabet.Length)]);
        }

        return builder.ToString();
    }

    private static (ulong S0, ulong S1, ulong S2, ulong S3) MakeSeedState(CaptchaV1ChallengeSpec spec)
    {
        ulong key0 = LoadLittleEndian64(spec.PolynomialSeed, 0);
        ulong key1 = LoadLittleEndian64(spec.PolynomialSeed, 8);
        return NormalizeSeedState((
            SipHash24(key0, key1, LoadLittleEndian64(spec.NoiseSeed, 0), LoadLittleEndian64(spec.NoiseSeed, 8)),
            SipHash24(key0 ^ 0x9e3779b97f4a7c15UL, key1 ^ 0x243f6a8885a308d3UL, LoadLittleEndian64(spec.NoiseSeed, 16), LoadLittleEndian64(spec.NoiseSeed, 24)),
            SipHash24(key0 ^ 0x13198a2e03707344UL, key1 ^ 0xa4093822299f31d0UL, LoadLittleEndian64(spec.PolynomialSeed, 16), LoadLittleEndian64(spec.PolynomialSeed, 24)),
            SipHash24(
                key0 ^ 0x082efa98ec4e6c89UL,
                key1 ^ 0x452821e638d01377UL,
                ((ulong)(ushort)spec.GridWidth) |
                ((ulong)(ushort)spec.GridHeight << 16) |
                ((ulong)(byte)spec.DistortionLevel << 32) |
                ((ulong)(byte)spec.PowDifficultyBits << 40),
                key0 ^ key1)));
    }

    private static (ulong S0, ulong S1, ulong S2, ulong S3) NormalizeSeedState((ulong S0, ulong S1, ulong S2, ulong S3) state)
        => (state.S0 | state.S1 | state.S2 | state.S3) == 0
            ? (0x9e3779b97f4a7c15UL, 0x243f6a8885a308d3UL, 0x13198a2e03707344UL, 0xa4093822299f31d0UL)
            : state;

    private static ulong SipHash24(ulong key0, ulong key1, ulong message0, ulong message1)
    {
        ulong v0 = 0x736f6d6570736575UL ^ key0;
        ulong v1 = 0x646f72616e646f6dUL ^ key1;
        ulong v2 = 0x6c7967656e657261UL ^ key0;
        ulong v3 = 0x7465646279746573UL ^ key1;
        Span<ulong> words = [message0, message1, 0x10UL << 56];

        foreach (ulong word in words)
        {
            v3 ^= word;
            SipRound(ref v0, ref v1, ref v2, ref v3);
            SipRound(ref v0, ref v1, ref v2, ref v3);
            v0 ^= word;
        }

        v2 ^= 0xff;
        SipRound(ref v0, ref v1, ref v2, ref v3);
        SipRound(ref v0, ref v1, ref v2, ref v3);
        SipRound(ref v0, ref v1, ref v2, ref v3);
        SipRound(ref v0, ref v1, ref v2, ref v3);
        return (v0 ^ v1 ^ v2 ^ v3) & Mask64;
    }

    private static void SipRound(ref ulong v0, ref ulong v1, ref ulong v2, ref ulong v3)
    {
        v0 += v1;
        v1 = RotateLeft(v1, 13) ^ v0;
        v0 = RotateLeft(v0, 32);
        v2 += v3;
        v3 = RotateLeft(v3, 16) ^ v2;
        v0 += v3;
        v3 = RotateLeft(v3, 21) ^ v0;
        v2 += v1;
        v1 = RotateLeft(v1, 17) ^ v2;
        v2 = RotateLeft(v2, 32);
    }

    private static ulong XoshiroNext(ref (ulong S0, ulong S1, ulong S2, ulong S3) state)
    {
        ulong result = RotateLeft(state.S0 + state.S3, 23) + state.S0;
        ulong mix = state.S1 << 17;
        state.S2 ^= state.S0;
        state.S3 ^= state.S1;
        state.S1 ^= state.S2;
        state.S0 ^= state.S3;
        state.S2 ^= mix;
        state.S3 = RotateLeft(state.S3, 45);
        return result;
    }

    private static byte[] BuildSpecMaterial(CaptchaV1ChallengeSpec spec)
    {
        byte[] material = new byte[70];
        spec.PolynomialSeed.CopyTo(material, 0);
        spec.NoiseSeed.CopyTo(material, 32);
        material[64] = (byte)(spec.GridWidth & 0xff);
        material[65] = (byte)((spec.GridWidth >> 8) & 0xff);
        material[66] = (byte)(spec.GridHeight & 0xff);
        material[67] = (byte)((spec.GridHeight >> 8) & 0xff);
        material[68] = (byte)spec.DistortionLevel;
        material[69] = (byte)spec.PowDifficultyBits;
        return material;
    }

    private static int LeadingZeroBits(ReadOnlySpan<byte> digest)
    {
        int zeros = 0;
        foreach (byte value in digest)
        {
            if (value == 0)
            {
                zeros += 8;
                continue;
            }

            return zeros + int.LeadingZeroCount(value) - 24;
        }

        return zeros;
    }

    private static bool TryDecodeSeedPayload(string seedPayloadBase64, out IReadOnlyDictionary<string, string> claims)
    {
        claims = new Dictionary<string, string>(0, StringComparer.Ordinal);
        if (seedPayloadBase64.AsSpan().IndexOfAny('+', '/', '=') >= 0)
        {
            return false;
        }

        try
        {
            string text = Encoding.UTF8.GetString(WebEncoders.Base64UrlDecode(seedPayloadBase64));
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string line in text.Split('\n'))
            {
                int equals = line.IndexOf('=');
                if (equals <= 0)
                {
                    return false;
                }

                result[line[..equals]] = line[(equals + 1)..];
            }

            claims = result;
            return Matches(claims, "v", "1");
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static bool Matches(IReadOnlyDictionary<string, string> claims, string key, string expected)
        => claims.TryGetValue(key, out string? actual) && string.Equals(actual, expected, StringComparison.Ordinal);

    private static bool TryGet(IReadOnlyDictionary<string, string> payload, string key, out string value)
    {
        value = string.Empty;
        if (!payload.TryGetValue(key, out string? raw) || string.IsNullOrWhiteSpace(raw))
        {
            return false;
        }

        value = raw.Trim();
        return true;
    }

    private static bool TryInt(IReadOnlyDictionary<string, string> payload, string key, out int value)
    {
        value = 0;
        return TryGet(payload, key, out string raw)
            && int.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out value);
    }

    private static bool TryLong(IReadOnlyDictionary<string, string> payload, string key, out long value)
    {
        value = 0;
        return TryGet(payload, key, out string raw)
            && long.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out value);
    }

    private static bool FixedTimeEqualsHex(string left, string right)
        => left.Length == right.Length &&
           CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(left), Encoding.ASCII.GetBytes(right));

    private static bool IsHex(string value, int length)
    {
        if (value.Length != length)
        {
            return false;
        }

        foreach (char ch in value)
        {
            if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')))
            {
                return false;
            }
        }

        return true;
    }

    private static byte[] HexToBytes(string hex)
    {
        byte[] bytes = new byte[hex.Length / 2];
        for (int i = 0; i < bytes.Length; i++)
        {
            bytes[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
        }

        return bytes;
    }

    private static ulong LoadLittleEndian64(byte[] bytes, int offset)
    {
        ulong value = 0;
        for (int i = 0; i < 8; i++)
        {
            value |= (ulong)bytes[offset + i] << (i * 8);
        }

        return value;
    }

    private static ulong RotateLeft(ulong value, int bits)
        => (value << bits) | (value >> (64 - bits));

    private static void WriteUInt32LittleEndian(Span<byte> destination, uint value)
    {
        BinaryPrimitives.WriteUInt32LittleEndian(destination, value);
    }

    private static string NonceToHex(uint nonce)
        => $"{nonce & 0xff:x2}{(nonce >> 8) & 0xff:x2}{(nonce >> 16) & 0xff:x2}{(nonce >> 24) & 0xff:x2}";

    private sealed record CaptchaV1ChallengeSpec(
        byte[] PolynomialSeed,
        byte[] NoiseSeed,
        int GridWidth,
        int GridHeight,
        int DistortionLevel,
        int PowDifficultyBits);
}
