using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
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
            "zkAnonymousCommentProofV1"
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
        SecurityChallengeAssignment captcha = CreateAssignment(SecurityChallengeKind.CaptchaV1) with { ChallengeId = uuidV4 };
        SecurityChallengeAssignment pow = CreateAssignment(SecurityChallengeKind.Sha256PowV1) with { ChallengeId = uuidV4 };

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

    [Fact]
    public void SecurityChallengeIssueAndVerifyContracts_RoundTrip()
    {
        var issue = new SecurityChallengeIssueBinaryRequest("public.read", "article:42", "device-123456", """{"locale":"zh-CN"}""");
        byte[] issueEncoded = PodBinaryCodec.EncodeSecurityChallengeIssueRequest(issue);

        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeIssueRequest(issueEncoded, out SecurityChallengeIssueBinaryRequest issueDecoded));
        Assert.Equal(issue, issueDecoded);

        var verify = new SecurityChallengeVerifyBinaryRequest(
            SecurityChallengeContracts.CreateChallengeId(),
            SecurityChallengeKind.Sha256PowV1,
            "public.read",
            "article:42",
            """{"proof":"fpow"}""");
        byte[] verifyEncoded = PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(verify);

        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeVerifyRequest(verifyEncoded, out SecurityChallengeVerifyBinaryRequest verifyDecoded));
        Assert.Equal(verify, verifyDecoded);
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
            assignment.ChallengeId,
            SecurityChallengeKind.Sha256PowV1,
            "risk-policy-v2",
            "fcp_token",
            "ok",
            0);
        byte[] verifyEncoded = PodBinaryCodec.EncodeSecurityChallengeVerifyResponse(verifyResponse);

        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeVerifyResponse(verifyEncoded, out SecurityChallengeVerifyBinaryResponse decodedVerify));
        Assert.Equal(verifyResponse, decodedVerify);
    }

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
}
