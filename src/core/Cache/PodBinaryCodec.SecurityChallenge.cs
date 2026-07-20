using System.Buffers;
using System.Runtime.InteropServices;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;
using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Core.Cache;

/// <summary>
/// Provides binary serialization and decoding operations for security challenge contracts.
/// </summary>
public static partial class PodBinaryCodec
{
    /// <summary>
    /// Writes the <c>SecurityChallengeAssignment</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteSecurityChallengeAssignment(SecurityChallengeAssignment assignment, IBufferWriter<byte> destination)
    {
        SecurityChallengeValidationResult validation = SecurityChallengeContracts.ValidateAssignment(assignment);
        if (!validation.IsValid)
        {
            throw new ArgumentException($"Invalid security challenge assignment: {validation.ErrorCode}", nameof(assignment));
        }

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CreateSecurityChallengeAssignmentPod(assignment));
    }

    /// <summary>
    /// Encodes the <c>SecurityChallengeAssignment</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeSecurityChallengeAssignment(SecurityChallengeAssignment assignment)
        => EncodeToArray(Marshal.SizeOf<SecurityChallengeAssignmentPod>(), writer => WriteSecurityChallengeAssignment(assignment, writer));

    /// <summary>
    /// Attempts to decode the <c>SecurityChallengeAssignment</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeSecurityChallengeAssignment(
        ReadOnlyMemory<byte> source,
        out SecurityChallengeAssignment assignment,
        SecurityChallengeKind? expectedKind = null)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out SecurityChallengeAssignmentPod pod) || !reader.IsConsumed)
        {
            assignment = EmptySecurityChallengeAssignment();
            return false;
        }

        assignment = FromSecurityChallengeAssignmentPod(pod);
        return SecurityChallengeContracts.ValidateAssignment(assignment, expectedKind).IsValid;
    }

    /// <summary>
    /// Writes the <c>SecurityChallengeEnvelope</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteSecurityChallengeEnvelope(SecurityChallengeEnvelope envelope, IBufferWriter<byte> destination)
    {
        SecurityChallengeValidationResult validation = SecurityChallengeContracts.ValidateEnvelope(envelope);
        if (!validation.IsValid)
        {
            throw new ArgumentException($"Invalid security challenge envelope: {validation.ErrorCode}", nameof(envelope));
        }

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(new MutableSecurityChallengeEnvelopePod
        {
            AssignmentCount = envelope.Assignments.Count,
            EnvelopeId = PodUtf8Codec.ToFixed64(envelope.EnvelopeId),
            PolicyVersion = PodUtf8Codec.ToFixed64(envelope.PolicyVersion)
        });
        foreach (SecurityChallengeAssignment assignment in envelope.Assignments)
        {
            writer.WritePod(CreateSecurityChallengeAssignmentPod(assignment));
        }
    }

    /// <summary>
    /// Encodes the <c>SecurityChallengeEnvelope</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeSecurityChallengeEnvelope(SecurityChallengeEnvelope envelope)
        => EncodeToArray(
            Marshal.SizeOf<SecurityChallengeEnvelopePod>() + envelope.Assignments.Count * Marshal.SizeOf<SecurityChallengeAssignmentPod>(),
            writer => WriteSecurityChallengeEnvelope(envelope, writer));

    /// <summary>
    /// Attempts to decode the <c>SecurityChallengeEnvelope</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeSecurityChallengeEnvelope(ReadOnlyMemory<byte> source, out SecurityChallengeEnvelope envelope)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out SecurityChallengeEnvelopePod pod) ||
            pod.AssignmentCount is <= 0 or > SecurityChallengeContracts.MaxAssignmentsPerEnvelope)
        {
            envelope = EmptySecurityChallengeEnvelope();
            return false;
        }

        var assignments = new List<SecurityChallengeAssignment>(pod.AssignmentCount);
        for (int i = 0; i < pod.AssignmentCount; i++)
        {
            if (!reader.TryReadPod(out SecurityChallengeAssignmentPod assignmentPod))
            {
                envelope = EmptySecurityChallengeEnvelope();
                return false;
            }

            assignments.Add(FromSecurityChallengeAssignmentPod(assignmentPod));
        }

        if (!reader.IsConsumed)
        {
            envelope = EmptySecurityChallengeEnvelope();
            return false;
        }

        envelope = new SecurityChallengeEnvelope(
            PodUtf8Codec.FromFixed64(pod.EnvelopeId),
            PodUtf8Codec.FromFixed64(pod.PolicyVersion),
            assignments);
        return SecurityChallengeContracts.ValidateEnvelope(envelope).IsValid;
    }

    /// <summary>
    /// Writes the <c>SecurityChallengeIssueRequest</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteSecurityChallengeIssueRequest(SecurityChallengeIssueBinaryRequest request, IBufferWriter<byte> destination)
    {
        var blob = new ArrayBufferWriter<byte>(Math.Max(
            128,
            (request.Action?.Length ?? 0) +
            (request.RouteKey?.Length ?? 0) +
            (request.DeviceFingerprint?.Length ?? 0) +
            (request.AttributesJson?.Length ?? 0) +
            (request.CapabilityManifestVersion?.Length ?? 0)));
        var mutable = new MutableSecurityChallengeIssueRequestPod
        {
            Action = PodUtf8Codec.AppendSlice(request.Action, blob),
            RouteKey = PodUtf8Codec.AppendSlice(request.RouteKey, blob),
            DeviceFingerprint = PodUtf8Codec.AppendSlice(request.DeviceFingerprint, blob),
            AttributesJson = PodUtf8Codec.AppendSlice(request.AttributesJson, blob),
            CapabilityManifestVersion = PodUtf8Codec.AppendSlice(request.CapabilityManifestVersion, blob)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableSecurityChallengeIssueRequestPod, SecurityChallengeIssueRequestPod>(mutable));
        writer.WriteBytes(blob.WrittenSpan);
    }

    /// <summary>
    /// Encodes the <c>SecurityChallengeIssueRequest</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeSecurityChallengeIssueRequest(SecurityChallengeIssueBinaryRequest request)
        => EncodeToArray(
            128 + (request.Action?.Length ?? 0) + (request.RouteKey?.Length ?? 0) + (request.DeviceFingerprint?.Length ?? 0) +
            (request.AttributesJson?.Length ?? 0) + (request.CapabilityManifestVersion?.Length ?? 0),
            writer => WriteSecurityChallengeIssueRequest(request, writer));

    /// <summary>
    /// Attempts to decode the <c>SecurityChallengeIssueRequest</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeSecurityChallengeIssueRequest(ReadOnlyMemory<byte> source, out SecurityChallengeIssueBinaryRequest request)
    {
        if (TryDecodeCurrentSecurityChallengeIssueRequest(source.Span, out request))
        {
            return true;
        }

        return TryDecodeLegacySecurityChallengeIssueRequest(source.Span, out request);
    }

    private static bool TryDecodeCurrentSecurityChallengeIssueRequest(
        ReadOnlySpan<byte> source,
        out SecurityChallengeIssueBinaryRequest request)
    {
        var reader = new BinaryPodReader(source);
        if (!reader.TryReadPod(out SecurityChallengeIssueRequestPod pod) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> blob) ||
            !reader.IsConsumed ||
            !AreSecurityChallengeIssueSlicesValid(
                pod.Action,
                pod.RouteKey,
                pod.DeviceFingerprint,
                pod.AttributesJson,
                pod.CapabilityManifestVersion,
                blob.Length))
        {
            request = EmptySecurityChallengeIssueRequest();
            return false;
        }

        request = new SecurityChallengeIssueBinaryRequest(
            PodUtf8Codec.ReadSlice(pod.Action, blob),
            PodUtf8Codec.ReadSlice(pod.RouteKey, blob),
            PodUtf8Codec.ReadSlice(pod.DeviceFingerprint, blob),
            PodUtf8Codec.ReadSlice(pod.AttributesJson, blob),
            PodUtf8Codec.ReadSlice(pod.CapabilityManifestVersion, blob));
        return true;
    }

    private static bool TryDecodeLegacySecurityChallengeIssueRequest(
        ReadOnlySpan<byte> source,
        out SecurityChallengeIssueBinaryRequest request)
    {
        var reader = new BinaryPodReader(source);
        if (!reader.TryReadPod(out LegacySecurityChallengeIssueRequestPod pod) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> blob) ||
            !reader.IsConsumed ||
            !AreSecurityChallengeIssueSlicesValid(
                pod.Action,
                pod.RouteKey,
                pod.DeviceFingerprint,
                pod.AttributesJson,
                default,
                blob.Length))
        {
            request = EmptySecurityChallengeIssueRequest();
            return false;
        }

        request = new SecurityChallengeIssueBinaryRequest(
            PodUtf8Codec.ReadSlice(pod.Action, blob),
            PodUtf8Codec.ReadSlice(pod.RouteKey, blob),
            PodUtf8Codec.ReadSlice(pod.DeviceFingerprint, blob),
            PodUtf8Codec.ReadSlice(pod.AttributesJson, blob));
        return true;
    }

    private static bool AreSecurityChallengeIssueSlicesValid(
        Utf8SliceRef action,
        Utf8SliceRef routeKey,
        Utf8SliceRef deviceFingerprint,
        Utf8SliceRef attributesJson,
        Utf8SliceRef capabilityManifestVersion,
        int blobLength)
        => IsSecurityChallengeIssueSliceValid(action, blobLength)
            && IsSecurityChallengeIssueSliceValid(routeKey, blobLength)
            && IsSecurityChallengeIssueSliceValid(deviceFingerprint, blobLength)
            && IsSecurityChallengeIssueSliceValid(attributesJson, blobLength)
            && IsSecurityChallengeIssueSliceValid(capabilityManifestVersion, blobLength);

    private static bool IsSecurityChallengeIssueSliceValid(Utf8SliceRef slice, int blobLength)
        => slice.Offset >= 0 && slice.Length >= 0 && slice.Offset <= blobLength - slice.Length;

    private static SecurityChallengeIssueBinaryRequest EmptySecurityChallengeIssueRequest()
        => new(string.Empty, string.Empty, string.Empty, string.Empty);

    /// <summary>
    /// Writes the <c>SecurityChallengeVerifyRequest</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteSecurityChallengeVerifyRequest(SecurityChallengeVerifyBinaryRequest request, IBufferWriter<byte> destination)
    {
        SecurityChallengeValidationResult validation = SecurityChallengeContracts.ValidateVerifyRequest(request);
        if (!validation.IsValid)
        {
            throw new ArgumentException($"Invalid security challenge verify request: {validation.ErrorCode}", nameof(request));
        }

        var blob = new ArrayBufferWriter<byte>(Math.Max(
            128,
            (request.EnvelopeId?.Length ?? 0) +
            (request.ChallengeId?.Length ?? 0) +
            (request.Action?.Length ?? 0) +
            (request.RouteKey?.Length ?? 0) +
            (request.ProviderPayloadJson?.Length ?? 0)));
        byte[]? typedV3 = request.Kind == SecurityChallengeKind.PerceptionCharacterV3 && request.PerceptionCharacterV3 is not null
            ? EncodePerceptionCharacterV3Verify(request.PerceptionCharacterV3)
            : null;
        var mutable = new MutableSecurityChallengeVerifyRequestPod
        {
            Kind = (byte)request.Kind,
            EnvelopeId = PodUtf8Codec.AppendSlice(request.EnvelopeId, blob),
            ChallengeId = PodUtf8Codec.AppendSlice(request.ChallengeId, blob),
            Action = PodUtf8Codec.AppendSlice(request.Action, blob),
            RouteKey = PodUtf8Codec.AppendSlice(request.RouteKey, blob),
            ProviderPayloadJson = typedV3 is null ? PodUtf8Codec.AppendSlice(request.ProviderPayloadJson, blob) : AppendBytes(typedV3, blob)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableSecurityChallengeVerifyRequestPod, SecurityChallengeVerifyRequestPod>(mutable));
        writer.WriteBytes(blob.WrittenSpan);
    }

    /// <summary>
    /// Encodes the <c>SecurityChallengeVerifyRequest</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeSecurityChallengeVerifyRequest(SecurityChallengeVerifyBinaryRequest request)
        => EncodeToArray(
            128 + (request.EnvelopeId?.Length ?? 0) + (request.ChallengeId?.Length ?? 0) + (request.Action?.Length ?? 0) + (request.RouteKey?.Length ?? 0) + (request.ProviderPayloadJson?.Length ?? 0),
            writer => WriteSecurityChallengeVerifyRequest(request, writer));

    /// <summary>
    /// Attempts to decode the <c>SecurityChallengeVerifyRequest</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeSecurityChallengeVerifyRequest(ReadOnlyMemory<byte> source, out SecurityChallengeVerifyBinaryRequest request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out SecurityChallengeVerifyRequestPod pod) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            request = new SecurityChallengeVerifyBinaryRequest(string.Empty, string.Empty, SecurityChallengeKind.Unknown, string.Empty, string.Empty, string.Empty);
            return false;
        }

        SecurityChallengeKind kind = ToSecurityChallengeKind(pod.Kind);
        PerceptionCharacterV3VerifyPayload? typed = null;
        string legacyJson = string.Empty;
        if (kind == SecurityChallengeKind.PerceptionCharacterV3)
        {
            if (!TryReadBytes(pod.ProviderPayloadJson, blob, out byte[] bytes) || !TryDecodePerceptionCharacterV3Verify(bytes, out typed))
            {
                request = new SecurityChallengeVerifyBinaryRequest(string.Empty, string.Empty, SecurityChallengeKind.Unknown, string.Empty, string.Empty, string.Empty);
                return false;
            }
        }
        else
            legacyJson = PodUtf8Codec.ReadSlice(pod.ProviderPayloadJson, blob);
        request = new SecurityChallengeVerifyBinaryRequest(
            PodUtf8Codec.ReadSlice(pod.EnvelopeId, blob),
            PodUtf8Codec.ReadSlice(pod.ChallengeId, blob),
            kind,
            PodUtf8Codec.ReadSlice(pod.Action, blob),
            PodUtf8Codec.ReadSlice(pod.RouteKey, blob),
            legacyJson)
        {
            PerceptionCharacterV3 = typed
        };
        return reader.IsConsumed && SecurityChallengeContracts.ValidateVerifyRequest(request).IsValid;
    }

    /// <summary>
    /// Writes the <c>SecurityChallengeIssueResponse</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteSecurityChallengeIssueResponse(SecurityChallengeIssueBinaryResponse response, IBufferWriter<byte> destination)
    {
        IReadOnlyList<SecurityChallengeAssignment> assignments = response.Envelope?.Assignments ?? [];
        IReadOnlyList<SecurityChallengeProviderPayload> providerPayloads = response.ProviderPayloads ?? [];
        if (assignments.Count > SecurityChallengeContracts.MaxAssignmentsPerEnvelope ||
            providerPayloads.Count > SecurityChallengeContracts.MaxAssignmentsPerEnvelope)
        {
            throw new ArgumentException("Security challenge response exceeds maximum assignment count.", nameof(response));
        }

        if (response.Envelope is not null)
        {
            SecurityChallengeValidationResult validation = SecurityChallengeContracts.ValidateEnvelope(response.Envelope);
            if (!validation.IsValid)
            {
                throw new ArgumentException($"Invalid security challenge envelope: {validation.ErrorCode}", nameof(response));
            }
        }

        if (!ProviderPayloadsMatchAssignments(assignments, providerPayloads))
        {
            throw new ArgumentException("Security challenge provider payload challenge id does not match an assignment.", nameof(response));
        }

        var blob = new ArrayBufferWriter<byte>(Math.Max(128, providerPayloads.Sum(static item => item.PayloadJson?.Length ?? 0)));
        var payloadPods = new List<SecurityChallengeProviderPayloadPod>(providerPayloads.Count);
        foreach (SecurityChallengeProviderPayload payload in providerPayloads)
        {
            byte[]? typedV3 = payload.PerceptionCharacterV3 is null ? null : EncodePerceptionCharacterV3Issue(payload.PerceptionCharacterV3);
            var mutablePayload = new MutableSecurityChallengeProviderPayloadPod
            {
                ChallengeId = PodUtf8Codec.ToFixed64(payload.ChallengeId),
                PayloadJson = typedV3 is null ? PodUtf8Codec.AppendSlice(payload.PayloadJson, blob) : AppendBytes(typedV3, blob)
            };
            payloadPods.Add(Cast<MutableSecurityChallengeProviderPayloadPod, SecurityChallengeProviderPayloadPod>(mutablePayload));
        }

        var mutable = new MutableSecurityChallengeIssueResponsePod
        {
            Decision = (byte)response.Decision,
            AssignmentCount = checked((byte)assignments.Count),
            ProviderPayloadCount = checked((ushort)payloadPods.Count),
            RiskScore = response.RiskScore,
            EffectiveRiskScore = response.EffectiveRiskScore,
            EscalationLevel = response.EscalationLevel,
            RetryAfterMs = response.RetryAfterMs,
            EnvelopeId = PodUtf8Codec.ToFixed64(response.Envelope?.EnvelopeId),
            PolicyVersion = PodUtf8Codec.ToFixed64(response.PolicyVersion)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableSecurityChallengeIssueResponsePod, SecurityChallengeIssueResponsePod>(mutable));
        foreach (SecurityChallengeAssignment assignment in assignments)
        {
            writer.WritePod(CreateSecurityChallengeAssignmentPod(assignment));
        }

        foreach (SecurityChallengeProviderPayloadPod payloadPod in payloadPods)
        {
            writer.WritePod(payloadPod);
        }

        writer.WriteBytes(blob.WrittenSpan);
    }

    /// <summary>
    /// Encodes the <c>SecurityChallengeIssueResponse</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeSecurityChallengeIssueResponse(SecurityChallengeIssueBinaryResponse response)
        => EncodeToArray(
            Marshal.SizeOf<SecurityChallengeIssueResponsePod>() +
            ((response.Envelope?.Assignments.Count ?? 0) * Marshal.SizeOf<SecurityChallengeAssignmentPod>()) +
            ((response.ProviderPayloads?.Count ?? 0) * Marshal.SizeOf<SecurityChallengeProviderPayloadPod>()) +
            ((response.ProviderPayloads?.Sum(static item => item.PayloadJson?.Length ?? 0)) ?? 0),
            writer => WriteSecurityChallengeIssueResponse(response, writer));

    /// <summary>
    /// Attempts to decode the <c>SecurityChallengeIssueResponse</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeSecurityChallengeIssueResponse(ReadOnlyMemory<byte> source, out SecurityChallengeIssueBinaryResponse response)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out SecurityChallengeIssueResponsePod pod) ||
            pod.AssignmentCount > SecurityChallengeContracts.MaxAssignmentsPerEnvelope ||
            pod.ProviderPayloadCount > SecurityChallengeContracts.MaxAssignmentsPerEnvelope)
        {
            response = EmptySecurityChallengeIssueResponse();
            return false;
        }

        var assignments = new List<SecurityChallengeAssignment>(pod.AssignmentCount);
        for (int i = 0; i < pod.AssignmentCount; i++)
        {
            if (!reader.TryReadPod(out SecurityChallengeAssignmentPod assignmentPod))
            {
                response = EmptySecurityChallengeIssueResponse();
                return false;
            }

            assignments.Add(FromSecurityChallengeAssignmentPod(assignmentPod));
        }

        var payloadPods = new List<SecurityChallengeProviderPayloadPod>(pod.ProviderPayloadCount);
        for (int i = 0; i < pod.ProviderPayloadCount; i++)
        {
            if (!reader.TryReadPod(out SecurityChallengeProviderPayloadPod payloadPod))
            {
                response = EmptySecurityChallengeIssueResponse();
                return false;
            }

            payloadPods.Add(payloadPod);
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            response = EmptySecurityChallengeIssueResponse();
            return false;
        }

        List<SecurityChallengeProviderPayload> providerPayloads = [];
        foreach (SecurityChallengeProviderPayloadPod payloadPod in payloadPods)
        {
            string id = PodUtf8Codec.FromFixed64(payloadPod.ChallengeId);
            SecurityChallengeKind kind = assignments.FirstOrDefault(item => string.Equals(item.ChallengeId, id, StringComparison.Ordinal))?.Kind ?? SecurityChallengeKind.Unknown;
            if (kind == SecurityChallengeKind.PerceptionCharacterV3)
            {
                if (!TryReadBytes(payloadPod.PayloadJson, blob, out byte[] bytes) || !TryDecodePerceptionCharacterV3Issue(bytes, out PerceptionCharacterV3IssuePayload typed))
                {
                    response = EmptySecurityChallengeIssueResponse();
                    return false;
                }
                providerPayloads.Add(new SecurityChallengeProviderPayload(id, string.Empty) { PerceptionCharacterV3 = typed });
            }
            else
                providerPayloads.Add(new SecurityChallengeProviderPayload(id, PodUtf8Codec.ReadSlice(payloadPod.PayloadJson, blob)));
        }

        SecurityChallengeEnvelope? envelope = pod.AssignmentCount > 0
            ? new SecurityChallengeEnvelope(PodUtf8Codec.FromFixed64(pod.EnvelopeId), PodUtf8Codec.FromFixed64(pod.PolicyVersion), assignments)
            : null;
        response = new SecurityChallengeIssueBinaryResponse(
            ToDecisionKind(pod.Decision),
            pod.RiskScore,
            pod.EffectiveRiskScore,
            pod.EscalationLevel,
            PodUtf8Codec.FromFixed64(pod.PolicyVersion),
            pod.RetryAfterMs,
            envelope,
            providerPayloads);
        return reader.IsConsumed &&
            (envelope is null || SecurityChallengeContracts.ValidateEnvelope(envelope).IsValid) &&
            ProviderPayloadsMatchAssignments(assignments, providerPayloads);
    }

    /// <summary>
    /// Writes the <c>SecurityChallengeVerifyResponse</c> contract to the supplied binary destination.
    /// </summary>
    public static void WriteSecurityChallengeVerifyResponse(SecurityChallengeVerifyBinaryResponse response, IBufferWriter<byte> destination)
    {
        SecurityChallengeValidationResult validation = SecurityChallengeContracts.ValidateVerifyResponse(response);
        if (!validation.IsValid)
        {
            throw new ArgumentException($"Invalid security challenge verify response: {validation.ErrorCode}", nameof(response));
        }

        var blob = new ArrayBufferWriter<byte>(Math.Max(128, (response.ProofToken?.Length ?? 0) + (response.Reason?.Length ?? 0)));
        var mutable = new MutableSecurityChallengeVerifyResponsePod
        {
            Verified = response.Verified ? (byte)1 : (byte)0,
            Kind = (byte)response.Kind,
            EnvelopeCompleted = response.EnvelopeCompleted ? (byte)1 : (byte)0,
            RetryAfterMs = response.RetryAfterMs,
            CompletedCount = response.CompletedCount,
            MemberCount = response.MemberCount,
            EnvelopeId = PodUtf8Codec.ToFixed64(response.EnvelopeId),
            ChallengeId = PodUtf8Codec.ToFixed64(response.ChallengeId),
            PolicyVersion = PodUtf8Codec.ToFixed64(response.PolicyVersion),
            ProofToken = PodUtf8Codec.AppendSlice(response.ProofToken, blob),
            Reason = PodUtf8Codec.AppendSlice(response.Reason, blob),
            ExpiresAtUnixMs = response.ExpiresAtUnixMs
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(Cast<MutableSecurityChallengeVerifyResponsePod, SecurityChallengeVerifyResponsePod>(mutable));
        writer.WriteBytes(blob.WrittenSpan);
    }

    /// <summary>
    /// Encodes the <c>SecurityChallengeVerifyResponse</c> contract into a new binary payload.
    /// </summary>
    public static byte[] EncodeSecurityChallengeVerifyResponse(SecurityChallengeVerifyBinaryResponse response)
        => EncodeToArray(
            Marshal.SizeOf<SecurityChallengeVerifyResponsePod>() + (response.ProofToken?.Length ?? 0) + (response.Reason?.Length ?? 0),
            writer => WriteSecurityChallengeVerifyResponse(response, writer));

    /// <summary>
    /// Attempts to decode the <c>SecurityChallengeVerifyResponse</c> contract from a binary payload.
    /// </summary>
    public static bool TryDecodeSecurityChallengeVerifyResponse(ReadOnlyMemory<byte> source, out SecurityChallengeVerifyBinaryResponse response)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out SecurityChallengeVerifyResponsePod pod) ||
            pod.Verified > 1 ||
            pod.EnvelopeCompleted > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> blob))
        {
            response = EmptySecurityChallengeVerifyResponse();
            return false;
        }

        response = new SecurityChallengeVerifyBinaryResponse(
            pod.Verified == 1,
            PodUtf8Codec.FromFixed64(pod.EnvelopeId),
            PodUtf8Codec.FromFixed64(pod.ChallengeId),
            ToSecurityChallengeKind(pod.Kind),
            PodUtf8Codec.FromFixed64(pod.PolicyVersion),
            pod.CompletedCount,
            pod.MemberCount,
            pod.EnvelopeCompleted == 1,
            PodUtf8Codec.ReadSlice(pod.ProofToken, blob),
            pod.ExpiresAtUnixMs,
            PodUtf8Codec.ReadSlice(pod.Reason, blob),
            pod.RetryAfterMs);
        return reader.IsConsumed && SecurityChallengeContracts.ValidateVerifyResponse(response).IsValid;
    }

    private static SecurityChallengeAssignmentPod CreateSecurityChallengeAssignmentPod(SecurityChallengeAssignment assignment)
    {
        var mutable = new MutableSecurityChallengeAssignmentPod
        {
            Kind = (byte)assignment.Kind,
            EscalationLevel = assignment.EscalationLevel,
            IssuedAtUnixMs = assignment.IssuedAtUnixMs,
            ExpiresAtUnixMs = assignment.ExpiresAtUnixMs,
            ChallengeId = PodUtf8Codec.ToFixed64(assignment.ChallengeId),
            Traceparent = PodUtf8Codec.ToFixed128(assignment.Traceparent),
            TenantId = PodUtf8Codec.ToFixed64(assignment.TenantId),
            Action = PodUtf8Codec.ToFixed64(assignment.Action),
            RouteKey = PodUtf8Codec.ToFixed128(assignment.RouteKey),
            SubjectHash = PodUtf8Codec.ToFixed64(assignment.SubjectHash),
            ClientIpHash = PodUtf8Codec.ToFixed64(assignment.ClientIpHash),
            DeviceFpHash = PodUtf8Codec.ToFixed64(assignment.DeviceFpHash)
        };
        return Cast<MutableSecurityChallengeAssignmentPod, SecurityChallengeAssignmentPod>(mutable);
    }

    private static SecurityChallengeAssignment FromSecurityChallengeAssignmentPod(SecurityChallengeAssignmentPod pod)
        => new(
            PodUtf8Codec.FromFixed64(pod.ChallengeId),
            PodUtf8Codec.FromFixed128(pod.Traceparent),
            PodUtf8Codec.FromFixed64(pod.TenantId),
            (SecurityChallengeKind)pod.Kind,
            pod.EscalationLevel,
            PodUtf8Codec.FromFixed64(pod.Action),
            PodUtf8Codec.FromFixed128(pod.RouteKey),
            PodUtf8Codec.FromFixed64(pod.SubjectHash),
            PodUtf8Codec.FromFixed64(pod.ClientIpHash),
            PodUtf8Codec.FromFixed64(pod.DeviceFpHash),
            pod.IssuedAtUnixMs,
            pod.ExpiresAtUnixMs);

    private static SecurityChallengeAssignment EmptySecurityChallengeAssignment()
        => new(string.Empty, string.Empty, string.Empty, SecurityChallengeKind.Unknown, 0, string.Empty, string.Empty, string.Empty, string.Empty, string.Empty, 0, 0);

    private static SecurityChallengeEnvelope EmptySecurityChallengeEnvelope()
        => new(string.Empty, string.Empty, []);

    private static SecurityChallengeIssueBinaryResponse EmptySecurityChallengeIssueResponse()
        => new(SecurityChallengeDecisionKind.Unknown, 0, 0, 0, string.Empty, 0, null, []);

    private static bool ProviderPayloadsMatchAssignments(
        IReadOnlyList<SecurityChallengeAssignment> assignments,
        IReadOnlyList<SecurityChallengeProviderPayload> providerPayloads)
    {
        var assignmentIds = assignments.Select(static assignment => assignment.ChallengeId).ToHashSet(StringComparer.Ordinal);
        var payloadIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (SecurityChallengeProviderPayload payload in providerPayloads)
        {
            if (!assignmentIds.Contains(payload.ChallengeId) || !payloadIds.Add(payload.ChallengeId))
            {
                return false;
            }
        }

        return true;
    }

    private static SecurityChallengeVerifyBinaryResponse EmptySecurityChallengeVerifyResponse()
        => new(false, string.Empty, string.Empty, SecurityChallengeKind.Unknown, string.Empty, 0, 0, false, string.Empty, 0, string.Empty, 0);

    private static SecurityChallengeKind ToSecurityChallengeKind(byte raw)
    {
        var kind = (SecurityChallengeKind)raw;
        return Enum.IsDefined(kind) ? kind : SecurityChallengeKind.Unknown;
    }

    private static SecurityChallengeDecisionKind ToDecisionKind(byte raw)
    {
        var kind = (SecurityChallengeDecisionKind)raw;
        return Enum.IsDefined(kind) ? kind : SecurityChallengeDecisionKind.Unknown;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSecurityChallengeAssignmentPod
    {
        public byte Kind;
        public byte Reserved0;
        public ushort Reserved1;
        public int EscalationLevel;
        public long IssuedAtUnixMs;
        public long ExpiresAtUnixMs;
        public Utf8Fixed64 ChallengeId;
        public Utf8Fixed128 Traceparent;
        public Utf8Fixed64 TenantId;
        public Utf8Fixed64 Action;
        public Utf8Fixed128 RouteKey;
        public Utf8Fixed64 SubjectHash;
        public Utf8Fixed64 ClientIpHash;
        public Utf8Fixed64 DeviceFpHash;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSecurityChallengeEnvelopePod
    {
        public int AssignmentCount;
        public Utf8Fixed64 EnvelopeId;
        public Utf8Fixed64 PolicyVersion;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSecurityChallengeIssueRequestPod
    {
        public Utf8SliceRef Action;
        public Utf8SliceRef RouteKey;
        public Utf8SliceRef DeviceFingerprint;
        public Utf8SliceRef AttributesJson;
        public Utf8SliceRef CapabilityManifestVersion;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct LegacySecurityChallengeIssueRequestPod
    {
        public Utf8SliceRef Action;
        public Utf8SliceRef RouteKey;
        public Utf8SliceRef DeviceFingerprint;
        public Utf8SliceRef AttributesJson;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSecurityChallengeVerifyRequestPod
    {
        public byte Kind;
        public byte Reserved0;
        public ushort Reserved1;
        public Utf8SliceRef EnvelopeId;
        public Utf8SliceRef ChallengeId;
        public Utf8SliceRef Action;
        public Utf8SliceRef RouteKey;
        public Utf8SliceRef ProviderPayloadJson;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSecurityChallengeIssueResponsePod
    {
        public byte Decision;
        public byte AssignmentCount;
        public ushort ProviderPayloadCount;
        public int RiskScore;
        public int EffectiveRiskScore;
        public int EscalationLevel;
        public int RetryAfterMs;
        public Utf8Fixed64 EnvelopeId;
        public Utf8Fixed64 PolicyVersion;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSecurityChallengeProviderPayloadPod
    {
        public Utf8Fixed64 ChallengeId;
        public Utf8SliceRef PayloadJson;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSecurityChallengeVerifyResponsePod
    {
        public byte Verified;
        public byte Kind;
        public byte EnvelopeCompleted;
        public byte Reserved0;
        public int RetryAfterMs;
        public int CompletedCount;
        public int MemberCount;
        public Utf8Fixed64 EnvelopeId;
        public Utf8Fixed64 ChallengeId;
        public Utf8Fixed64 PolicyVersion;
        public Utf8SliceRef ProofToken;
        public Utf8SliceRef Reason;
        public long ExpiresAtUnixMs;
    }
}
