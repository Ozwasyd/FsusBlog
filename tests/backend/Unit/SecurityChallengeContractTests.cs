using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Security;
using FsusBlog.Shared.Contracts.Validation;

using SharedFrameType = FsusBlog.Shared.AedsFrameType;
namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityChallengeContractTests
{
    private const string Hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    public void SupportedKinds_HaveStableWireNames()
    {
        string[] expected =
        [
            "sha256PowV1",
            "argon2idPoSpaceV1",
            "captchaV1",
            "humanReadProofV1",
            "passkeyStepUpV1",
            "adminPasskeyStepUpV1",
            "recoveryKeyProofV1",
            "anonymousCredentialProofV1",
            "zkAnonymousCommentProofV1",
            "perceptionCharacterV2",
            "perceptionLocalizationV2",
            "perceptionMicroInteractionV2",
            "perceptionCharacterV3"
        ];

        Assert.Equal(expected.Length, SecurityChallengeContracts.SupportedKinds.Count);
        foreach (string wireName in expected)
        {
            Assert.True(SecurityChallengeContracts.TryParseKind(wireName, out SecurityChallengeKind kind));
            Assert.Equal(wireName, SecurityChallengeContracts.ToWireName(kind));
        }
    }

    [Fact]
    public void CreateChallengeId_UsesUuidV7()
    {
        string challengeId = SecurityChallengeContracts.CreateChallengeId();

        Assert.True(Guid.TryParseExact(challengeId, "D", out _));
        Assert.Equal('7', challengeId[14]);
    }

    [Theory]
    [InlineData("challenge_id_missing")]
    [InlineData("traceparent_missing")]
    [InlineData("tenant_id_missing")]
    [InlineData("action_missing")]
    [InlineData("route_key_missing")]
    [InlineData("kind_mismatch")]
    [InlineData("expires_at_invalid")]
    [InlineData("subject_hash_invalid")]
    [InlineData("client_ip_hash_invalid")]
    [InlineData("device_fp_hash_invalid")]
    public void ValidateAssignment_RejectsInvalidContractShapes(string expectedError)
    {
        SecurityChallengeAssignment assignment = expectedError switch
        {
            "challenge_id_missing" => CreateAssignment() with { ChallengeId = string.Empty },
            "traceparent_missing" => CreateAssignment() with { Traceparent = string.Empty },
            "tenant_id_missing" => CreateAssignment() with { TenantId = string.Empty },
            "action_missing" => CreateAssignment() with { Action = string.Empty },
            "route_key_missing" => CreateAssignment() with { RouteKey = string.Empty },
            "expires_at_invalid" => CreateAssignment() with { ExpiresAtUnixMs = 1000, IssuedAtUnixMs = 1000 },
            "subject_hash_invalid" => CreateAssignment() with { SubjectHash = "not-a-hash" },
            "client_ip_hash_invalid" => CreateAssignment() with { ClientIpHash = "not-a-hash" },
            "device_fp_hash_invalid" => CreateAssignment() with { DeviceFpHash = "not-a-hash" },
            _ => CreateAssignment()
        };

        SecurityChallengeValidationResult result = expectedError == "kind_mismatch"
            ? SecurityChallengeContracts.ValidateAssignment(assignment, SecurityChallengeKind.CaptchaV1)
            : SecurityChallengeContracts.ValidateAssignment(assignment);

        Assert.False(result.IsValid);
        Assert.Equal(expectedError, result.ErrorCode);
    }

    [Fact]
    public void ValidateAssignment_CaptchaAcceptsUuidV4OrV7_NonCaptchaRequiresUuidV7()
    {
        string uuidV4 = Guid.NewGuid().ToString("D");
        SecurityChallengeAssignment captcha = CreateAssignment(SecurityChallengeKind.CaptchaV1) with
        {
            ChallengeId = uuidV4
        };
        SecurityChallengeAssignment pow = CreateAssignment(SecurityChallengeKind.Sha256PowV1) with
        {
            ChallengeId = uuidV4
        };

        Assert.True(SecurityChallengeContracts.ValidateAssignment(captcha).IsValid);
        SecurityChallengeValidationResult powResult = SecurityChallengeContracts.ValidateAssignment(pow);
        Assert.False(powResult.IsValid);
        Assert.Equal("challenge_id_invalid", powResult.ErrorCode);
    }

    [Fact]
    public void AssignmentPod_RoundTripsAndHonorsExpectedKind()
    {
        SecurityChallengeAssignment assignment = CreateAssignment();

        byte[] encoded = PodBinaryCodec.EncodeSecurityChallengeAssignment(assignment);

        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeAssignment(encoded, out SecurityChallengeAssignment decoded, SecurityChallengeKind.Sha256PowV1));
        Assert.Equal(assignment, decoded);
        Assert.False(PodBinaryCodec.TryDecodeSecurityChallengeAssignment(encoded, out _, SecurityChallengeKind.CaptchaV1));
        Assert.Equal(PodSizeCatalog.SecurityChallengeAssignmentPod, encoded.Length);
    }

    [Fact]
    public void EnvelopePod_RoundTripsAssignments()
    {
        SecurityChallengeAssignment assignment = CreateAssignment();
        var envelope = new SecurityChallengeEnvelope(
            SecurityChallengeContracts.CreateChallengeId(),
            "risk-policy-v2",
            [assignment]);

        byte[] encoded = PodBinaryCodec.EncodeSecurityChallengeEnvelope(envelope);

        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeEnvelope(encoded, out SecurityChallengeEnvelope decoded));
        Assert.Equal(envelope.EnvelopeId, decoded.EnvelopeId);
        Assert.Equal(envelope.PolicyVersion, decoded.PolicyVersion);
        SecurityChallengeAssignment decodedAssignment = Assert.Single(decoded.Assignments);
        Assert.Equal(assignment, decodedAssignment);
        Assert.Equal(PodSizeCatalog.SecurityChallengeEnvelopePod + PodSizeCatalog.SecurityChallengeAssignmentPod, encoded.Length);
    }

    [Fact]
    public void AedsFrameTypes_RegisterSecurityChallengeFrames()
    {
        Assert.Equal(171, (ushort)AedsFrameType.SecurityChallengeAssignment);
        Assert.Equal(172, (ushort)AedsFrameType.SecurityChallengeEnvelope);
        Assert.Equal(173, (ushort)AedsFrameType.SecurityChallengeIssueRequest);
        Assert.Equal(174, (ushort)AedsFrameType.SecurityChallengeVerifyRequest);
        Assert.Equal(175, (ushort)AedsFrameType.SecurityChallengeIssueResponse);
        Assert.Equal(176, (ushort)AedsFrameType.SecurityChallengeVerifyResponse);
        Assert.Equal((ushort)AedsFrameType.SecurityChallengeAssignment, (ushort)SharedFrameType.SecurityChallengeAssignment);
        Assert.Equal((ushort)AedsFrameType.SecurityChallengeEnvelope, (ushort)SharedFrameType.SecurityChallengeEnvelope);
        Assert.Equal((ushort)AedsFrameType.SecurityChallengeIssueRequest, (ushort)SharedFrameType.SecurityChallengeIssueRequest);
        Assert.Equal((ushort)AedsFrameType.SecurityChallengeVerifyRequest, (ushort)SharedFrameType.SecurityChallengeVerifyRequest);
        Assert.Equal((ushort)AedsFrameType.SecurityChallengeIssueResponse, (ushort)SharedFrameType.SecurityChallengeIssueResponse);
        Assert.Equal((ushort)AedsFrameType.SecurityChallengeVerifyResponse, (ushort)SharedFrameType.SecurityChallengeVerifyResponse);
        Assert.True(AedsProtocolMetadata.FrameTypes.ContainsKey(nameof(AedsFrameType.SecurityChallengeAssignment)));
        Assert.True(AedsProtocolMetadata.FrameTypes.ContainsKey(nameof(AedsFrameType.SecurityChallengeEnvelope)));
        Assert.True(AedsProtocolMetadata.FrameTypes.ContainsKey(nameof(AedsFrameType.SecurityChallengeIssueRequest)));
        Assert.True(AedsProtocolMetadata.FrameTypes.ContainsKey(nameof(AedsFrameType.SecurityChallengeVerifyRequest)));
        Assert.True(AedsProtocolMetadata.FrameTypes.ContainsKey(nameof(AedsFrameType.SecurityChallengeIssueResponse)));
        Assert.True(AedsProtocolMetadata.FrameTypes.ContainsKey(nameof(AedsFrameType.SecurityChallengeVerifyResponse)));
    }

    [Theory]
    [InlineData(SecurityChallengeKind.PerceptionCharacterV2, "perceptionCharacterV2", PerceptionSealedTaskKind.Character)]
    [InlineData(SecurityChallengeKind.PerceptionLocalizationV2, "perceptionLocalizationV2", PerceptionSealedTaskKind.Localization)]
    [InlineData(SecurityChallengeKind.PerceptionMicroInteractionV2, "perceptionMicroInteractionV2", PerceptionSealedTaskKind.MicroInteraction)]
    public void PerceptionSealedKinds_HaveStableWireNamesAndTaskMapping(
        SecurityChallengeKind kind,
        string wireName,
        PerceptionSealedTaskKind taskKind)
    {
        Assert.True(SecurityChallengeContracts.TryParseKind(wireName, out SecurityChallengeKind parsed));
        Assert.Equal(kind, parsed);
        Assert.Equal(wireName, SecurityChallengeContracts.ToWireName(kind));
        Assert.Equal(taskKind, PerceptionSealedChallengeV2Contracts.ToTaskKind(kind));
        Assert.Equal(kind, PerceptionSealedChallengeV2Contracts.ToChallengeKind(taskKind));
    }

    [Fact]
    public void AedsFrameTypes_RegisterPerceptionSealedFrames()
    {
        Assert.Equal(184, (ushort)AedsFrameType.PerceptionSealedChallengeV2);
        Assert.Equal(185, (ushort)AedsFrameType.PerceptionSealedResultV2);
        Assert.Equal((ushort)AedsFrameType.PerceptionSealedChallengeV2, (ushort)SharedFrameType.PerceptionSealedChallengeV2);
        Assert.Equal((ushort)AedsFrameType.PerceptionSealedResultV2, (ushort)SharedFrameType.PerceptionSealedResultV2);
        Assert.True(AedsProtocolMetadata.FrameTypes.ContainsKey(nameof(AedsFrameType.PerceptionSealedChallengeV2)));
        Assert.True(AedsProtocolMetadata.FrameTypes.ContainsKey(nameof(AedsFrameType.PerceptionSealedResultV2)));
    }

    [Theory]
    [InlineData(SecurityChallengeKind.PerceptionCharacterV2, PerceptionSealedTaskKind.Character)]
    [InlineData(SecurityChallengeKind.PerceptionLocalizationV2, PerceptionSealedTaskKind.Localization)]
    [InlineData(SecurityChallengeKind.PerceptionMicroInteractionV2, PerceptionSealedTaskKind.MicroInteraction)]
    public void PerceptionSealedChallengeV2_ValidatesThreeTaskKinds(SecurityChallengeKind kind, PerceptionSealedTaskKind taskKind)
    {
        var challenge = new PerceptionSealedChallengeV2(
            CreateAssignment(kind),
            PerceptionSealedChallengeV2Contracts.Algorithm,
            taskKind,
            "eyJ2IjoxfQ==",
            Hash,
            "c2VhbGVkLXRva2Vu",
            Hash,
            4,
            4,
            "latin",
            "baseline",
            1000,
            2000);

        PerceptionSealedContractValidationResult result = PerceptionSealedChallengeV2Contracts.ValidateChallenge(challenge);

        Assert.True(result.IsValid, result.ErrorCode);
    }

    [Theory]
    [InlineData(SecurityChallengeKind.PerceptionCharacterV2, PerceptionSealedTaskKind.Character, PerceptionSealedResultPayloadKind.Character)]
    [InlineData(SecurityChallengeKind.PerceptionLocalizationV2, PerceptionSealedTaskKind.Localization, PerceptionSealedResultPayloadKind.Coordinates)]
    [InlineData(SecurityChallengeKind.PerceptionMicroInteractionV2, PerceptionSealedTaskKind.MicroInteraction, PerceptionSealedResultPayloadKind.Steps)]
    public void PerceptionSealedResultV2_ValidatesThreePayloadKinds(
        SecurityChallengeKind kind,
        PerceptionSealedTaskKind taskKind,
        PerceptionSealedResultPayloadKind payloadKind)
    {
        var resultFrame = new PerceptionSealedResultV2(
            CreateAssignment(kind),
            PerceptionSealedChallengeV2Contracts.Algorithm,
            taskKind,
            payloadKind,
            "eyJ2IjoxfQ==",
            Hash,
            "c2VhbGVkLXRva2Vu",
            Hash,
            1000,
            2000);

        PerceptionSealedContractValidationResult result = PerceptionSealedChallengeV2Contracts.ValidateResult(resultFrame);

        Assert.True(result.IsValid, result.ErrorCode);
    }

    [Fact]
    public void PerceptionSealedContracts_DoNotExposeForbiddenSemanticFields()
    {
        string[] names =
        [
            .. typeof(PerceptionSealedChallengeV2).GetProperties().Select(static property => property.Name),
            .. typeof(PerceptionSealedResultV2).GetProperties().Select(static property => property.Name),
            .. typeof(PerceptionSealedChallengeV2Pod).GetFields().Select(static field => field.Name),
            .. typeof(PerceptionSealedResultV2Pod).GetFields().Select(static field => field.Name)
        ];

        Assert.DoesNotContain(names, ContainsForbiddenPerceptionFieldName);
        Assert.True(PodContractValidation.AreAllPodModelsReferenceFree());
        Assert.True(PodSizeCatalog.PerceptionSealedChallengeV2Pod > PodSizeCatalog.SecurityChallengeAssignmentPod);
        Assert.True(PodSizeCatalog.PerceptionSealedResultV2Pod > PodSizeCatalog.SecurityChallengeAssignmentPod);
    }

    [Fact]
    public void SecurityChallengeIssueAndVerifyContracts_RoundTrip()
    {
        var issue = new SecurityChallengeIssueBinaryRequest(
            "public.read",
            "article:42",
            "device-123456",
            """{"locale":"zh-CN"}""",
            SecurityChallengeCapabilityCatalog.ManifestVersion);
        byte[] issueEncoded = PodBinaryCodec.EncodeSecurityChallengeIssueRequest(issue);

        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeIssueRequest(issueEncoded, out SecurityChallengeIssueBinaryRequest issueDecoded));
        Assert.Equal(issue, issueDecoded);
        Assert.Equal(40, PodSizeCatalog.SecurityChallengeIssueRequestPod);

        var legacyIssue = new SecurityChallengeIssueBinaryRequest("public.read", "article:42", "device-123456", """{"locale":"zh-CN"}""");
        byte[] currentWithoutManifest = PodBinaryCodec.EncodeSecurityChallengeIssueRequest(legacyIssue);
        byte[] legacyEncoded = [.. currentWithoutManifest.AsSpan(0, 32), .. currentWithoutManifest.AsSpan(40)];

        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeIssueRequest(legacyEncoded, out SecurityChallengeIssueBinaryRequest legacyDecoded));
        Assert.Equal(legacyIssue, legacyDecoded);

        var verify = new SecurityChallengeVerifyBinaryRequest(
            SecurityChallengeContracts.CreateChallengeId(),
            SecurityChallengeContracts.CreateChallengeId(),
            SecurityChallengeKind.Sha256PowV1,
            "public.read",
            "article:42",
            """{"proof":"fpow"}""");
        byte[] verifyEncoded = PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(verify);

        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeVerifyRequest(verifyEncoded, out SecurityChallengeVerifyBinaryRequest verifyDecoded));
        Assert.Equal(verify, verifyDecoded);
        Assert.Equal(44, PodSizeCatalog.SecurityChallengeVerifyRequestPod);
    }

    [Fact]
    public void SecurityChallengeIssueAndVerifyResponses_RoundTrip()
    {
        SecurityChallengeAssignment assignment = CreateAssignment();
        var envelope = new SecurityChallengeEnvelope(
            SecurityChallengeContracts.CreateChallengeId(),
            "risk-policy-v2",
            [assignment]);
        var issueResponse = new SecurityChallengeIssueBinaryResponse(
            SecurityChallengeDecisionKind.Challenge,
            50,
            50,
            1,
            "risk-policy-v2",
            0,
            envelope,
            [new SecurityChallengeProviderPayload(assignment.ChallengeId, """{"salt":"s","difficulty":"16"}""")]);

        byte[] issueEncoded = PodBinaryCodec.EncodeSecurityChallengeIssueResponse(issueResponse);

        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeIssueResponse(issueEncoded, out SecurityChallengeIssueBinaryResponse decodedIssue));
        Assert.Equal(issueResponse.Decision, decodedIssue.Decision);
        Assert.NotNull(decodedIssue.Envelope);
        Assert.Equal(envelope.EnvelopeId, decodedIssue.Envelope.EnvelopeId);
        Assert.Equal(envelope.PolicyVersion, decodedIssue.Envelope.PolicyVersion);
        Assert.Equal(envelope.Assignments, decodedIssue.Envelope.Assignments);
        Assert.Equal(issueResponse.ProviderPayloads, decodedIssue.ProviderPayloads);

        var verifyResponse = new SecurityChallengeVerifyBinaryResponse(
            true,
            envelope.EnvelopeId,
            assignment.ChallengeId,
            SecurityChallengeKind.Sha256PowV1,
            "risk-policy-v2",
            1,
            1,
            true,
            "fcp_token",
            1_770_000_300_000,
            "ok",
            0);
        byte[] verifyEncoded = PodBinaryCodec.EncodeSecurityChallengeVerifyResponse(verifyResponse);

        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeVerifyResponse(verifyEncoded, out SecurityChallengeVerifyBinaryResponse decodedVerify));
        Assert.Equal(verifyResponse, decodedVerify);
        Assert.Equal(232, PodSizeCatalog.SecurityChallengeVerifyResponsePod);
    }

    [Fact]
    public void IssueResponse_RejectsProviderPayloadForDifferentChallenge()
    {
        SecurityChallengeAssignment assignment = CreateAssignment();
        var response = new SecurityChallengeIssueBinaryResponse(
            SecurityChallengeDecisionKind.Challenge,
            50,
            50,
            1,
            "risk-policy-v2",
            0,
            new SecurityChallengeEnvelope(SecurityChallengeContracts.CreateChallengeId(), "risk-policy-v2", [assignment]),
            [new SecurityChallengeProviderPayload(SecurityChallengeContracts.CreateChallengeId(), "{}")]);

        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeSecurityChallengeIssueResponse(response));
    }

    [Fact]
    public void VerifyRequest_RequiresUuidV7EnvelopeId()
    {
        var request = new SecurityChallengeVerifyBinaryRequest(
            Guid.NewGuid().ToString("D"),
            SecurityChallengeContracts.CreateChallengeId(),
            SecurityChallengeKind.Sha256PowV1,
            "public.read",
            "article:42",
            """{"proof":"fpow"}""");

        SecurityChallengeValidationResult result = SecurityChallengeContracts.ValidateVerifyRequest(request);

        Assert.False(result.IsValid);
        Assert.Equal("envelope_id_invalid", result.ErrorCode);
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(request));
    }

    [Theory]
    [InlineData(0, 0, true, false, "member_count_invalid")]
    [InlineData(-1, 2, true, false, "completed_count_invalid")]
    [InlineData(3, 2, true, false, "completed_count_invalid")]
    [InlineData(1, 9, true, false, "member_count_invalid")]
    [InlineData(1, 2, true, true, "envelope_completed_invalid")]
    [InlineData(2, 2, false, true, "envelope_completed_invalid")]
    [InlineData(1, 2, true, false, "proof_token_invalid")]
    public void VerifyResponse_RejectsInvalidAggregateState(
        int completedCount,
        int memberCount,
        bool verified,
        bool envelopeCompleted,
        string expectedError)
    {
        SecurityChallengeVerifyBinaryResponse response = CreateVerifyResponse(
            completedCount,
            memberCount,
            verified,
            envelopeCompleted,
            proofToken: "fcp_token");

        SecurityChallengeValidationResult result = SecurityChallengeContracts.ValidateVerifyResponse(response);

        Assert.False(result.IsValid);
        Assert.Equal(expectedError, result.ErrorCode);
    }

    [Fact]
    public void VerifyResponse_AllowsMemberProgressWithoutProofToken()
    {
        SecurityChallengeVerifyBinaryResponse response = CreateVerifyResponse(
            completedCount: 1,
            memberCount: 2,
            verified: true,
            envelopeCompleted: false,
            proofToken: string.Empty);

        byte[] encoded = PodBinaryCodec.EncodeSecurityChallengeVerifyResponse(response);

        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeVerifyResponse(encoded, out SecurityChallengeVerifyBinaryResponse decoded));
        Assert.Equal(response, decoded);
    }

    [Fact]
    public void VerifyResponse_RequiresProofTokenOnlyWhenEnvelopeCompletes()
    {
        SecurityChallengeVerifyBinaryResponse incompleteWithProof = CreateVerifyResponse(
            completedCount: 1,
            memberCount: 2,
            verified: true,
            envelopeCompleted: false,
            proofToken: "fcp_early");
        SecurityChallengeVerifyBinaryResponse completedWithoutProof = CreateVerifyResponse(
            completedCount: 2,
            memberCount: 2,
            verified: true,
            envelopeCompleted: true,
            proofToken: string.Empty);

        Assert.Equal("proof_token_invalid", SecurityChallengeContracts.ValidateVerifyResponse(incompleteWithProof).ErrorCode);
        Assert.Equal("proof_token_invalid", SecurityChallengeContracts.ValidateVerifyResponse(completedWithoutProof).ErrorCode);
    }

    private static SecurityChallengeVerifyBinaryResponse CreateVerifyResponse(
        int completedCount,
        int memberCount,
        bool verified,
        bool envelopeCompleted,
        string proofToken)
        => new(
            verified,
            SecurityChallengeContracts.CreateChallengeId(),
            SecurityChallengeContracts.CreateChallengeId(),
            SecurityChallengeKind.Sha256PowV1,
            "risk-policy-v2",
            completedCount,
            memberCount,
            envelopeCompleted,
            proofToken,
            1_770_000_300_000,
            "ok",
            0);

    private static SecurityChallengeAssignment CreateAssignment(SecurityChallengeKind kind = SecurityChallengeKind.Sha256PowV1)
        => new(
            SecurityChallengeContracts.CreateChallengeId(),
            Traceparent,
            "tenant-default",
            kind,
            1,
            "public.read",
            "article:42",
            Hash,
            Hash,
            Hash,
            1000,
            2000);

    private static bool ContainsForbiddenPerceptionFieldName(string name)
    {
        string normalized = new(name.Where(char.IsAsciiLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
        return normalized.Contains("answer", StringComparison.Ordinal) ||
               normalized.Contains("glyphids", StringComparison.Ordinal) ||
               normalized.Contains("charids", StringComparison.Ordinal);
    }
}
