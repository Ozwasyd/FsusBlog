using System.Buffers;
using System.Runtime.InteropServices;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Primitives;
using FsusBlog.Shared.Contracts.Security;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
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

    public static byte[] EncodeSecurityChallengeAssignment(SecurityChallengeAssignment assignment)
        => EncodeToArray(Marshal.SizeOf<SecurityChallengeAssignmentPod>(), writer => WriteSecurityChallengeAssignment(assignment, writer));

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

    public static byte[] EncodeSecurityChallengeEnvelope(SecurityChallengeEnvelope envelope)
        => EncodeToArray(
            Marshal.SizeOf<SecurityChallengeEnvelopePod>() + envelope.Assignments.Count * Marshal.SizeOf<SecurityChallengeAssignmentPod>(),
            writer => WriteSecurityChallengeEnvelope(envelope, writer));

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
}
