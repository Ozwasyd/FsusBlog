using System.Buffers;
using System.Runtime.InteropServices;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WritePasskeyRegisterBegin(PasskeyRegisterBeginCoreModel value, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512);
        var mutable = new MutablePasskeyRegisterBeginPod
        {
            Timeout = value.Timeout,
            PubKeyCredParamCount = value.PubKeyCredParams.Count,
            ExcludeCredentialCount = value.ExcludeCredentials.Count,
            Attestation = value.Attestation,
            ResidentKey = value.ResidentKey,
            UserVerification = value.UserVerification,
            AuthenticatorAttachment = value.AuthenticatorAttachment ?? 0,
            HasAuthenticatorAttachment = value.AuthenticatorAttachment.HasValue ? (byte)1 : (byte)0,
            RequireResidentKey = value.RequireResidentKey ? (byte)1 : (byte)0,
            Reserved0 = 0,
            SessionKey = PodUtf8Codec.ToFixed64(value.SessionKey),
            RpId = PodUtf8Codec.AppendSlice(value.RpId, payload),
            RpName = PodUtf8Codec.AppendSlice(value.RpName, payload),
            UserName = PodUtf8Codec.AppendSlice(value.UserName, payload),
            UserDisplayName = PodUtf8Codec.AppendSlice(value.UserDisplayName, payload),
            UserId = AppendBytes(value.UserId, payload),
            Challenge = AppendBytes(value.Challenge, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutablePasskeyRegisterBeginPod, PasskeyRegisterBeginPod>(mutable));
        foreach (PasskeyPublicKeyCredentialParamCoreModel param in value.PubKeyCredParams)
        {
            writer.WritePod(CastUserPod<MutablePasskeyPublicKeyCredentialParamPod, PasskeyPublicKeyCredentialParamPod>(
                new MutablePasskeyPublicKeyCredentialParamPod { Type = param.Type, Alg = param.Alg }));
        }

        foreach (PasskeyCredentialDescriptorCoreModel descriptor in value.ExcludeCredentials)
        {
            writer.WritePod(CreateDescriptorPod(descriptor, payload));
            writer.WriteInt32(descriptor.Transports.Count);
            foreach (int transport in descriptor.Transports)
            {
                writer.WriteInt32(transport);
            }
        }

        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodePasskeyRegisterBegin(PasskeyRegisterBeginCoreModel value)
        => EncodeToArray(512, writer => WritePasskeyRegisterBegin(value, writer));

    public static bool TryDecodePasskeyRegisterBegin(ReadOnlyMemory<byte> source, out PasskeyRegisterBeginCoreModel value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out PasskeyRegisterBeginPod pod) ||
            pod.PubKeyCredParamCount < 0 ||
            pod.ExcludeCredentialCount < 0 ||
            pod.HasAuthenticatorAttachment > 1 ||
            pod.RequireResidentKey > 1)
        {
            value = new PasskeyRegisterBeginCoreModel();
            return false;
        }

        var parameters = new List<PasskeyPublicKeyCredentialParamCoreModel>(pod.PubKeyCredParamCount);
        for (int i = 0; i < pod.PubKeyCredParamCount; i++)
        {
            if (!reader.TryReadPod(out PasskeyPublicKeyCredentialParamPod param))
            {
                value = new PasskeyRegisterBeginCoreModel();
                return false;
            }

            parameters.Add(new PasskeyPublicKeyCredentialParamCoreModel(param.Type, param.Alg));
        }

        if (!ReadDescriptors(ref reader, pod.ExcludeCredentialCount, out var descriptors) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            value = new PasskeyRegisterBeginCoreModel();
            return false;
        }

        value = new PasskeyRegisterBeginCoreModel
        {
            SessionKey = PodUtf8Codec.FromFixed64(pod.SessionKey),
            Timeout = pod.Timeout,
            Attestation = pod.Attestation,
            ResidentKey = pod.ResidentKey,
            UserVerification = pod.UserVerification,
            AuthenticatorAttachment = pod.HasAuthenticatorAttachment == 1 ? pod.AuthenticatorAttachment : null,
            RequireResidentKey = pod.RequireResidentKey == 1,
            RpId = PodProjector.ReadSlice(pod.RpId, payload),
            RpName = PodProjector.ReadSlice(pod.RpName, payload),
            UserName = PodProjector.ReadSlice(pod.UserName, payload),
            UserDisplayName = PodProjector.ReadSlice(pod.UserDisplayName, payload),
            UserId = ReadBytes(pod.UserId, payload),
            Challenge = ReadBytes(pod.Challenge, payload),
            PubKeyCredParams = parameters,
            ExcludeCredentials = MaterializeDescriptors(descriptors, payload)
        };
        return reader.IsConsumed;
    }

    public static void WritePasskeyLoginBegin(PasskeyLoginBeginCoreModel value, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutablePasskeyLoginBeginPod
        {
            Timeout = value.Timeout,
            AllowCredentialCount = value.AllowCredentials.Count,
            UserVerification = value.UserVerification ?? -1,
            Reserved0 = 0,
            ChallengeToken = PodUtf8Codec.ToFixed64(value.ChallengeToken),
            RpId = PodUtf8Codec.AppendSlice(value.RpId, payload),
            Challenge = AppendBytes(value.Challenge, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutablePasskeyLoginBeginPod, PasskeyLoginBeginPod>(mutable));
        foreach (PasskeyCredentialDescriptorCoreModel descriptor in value.AllowCredentials)
        {
            writer.WritePod(CreateDescriptorPod(descriptor, payload));
            writer.WriteInt32(descriptor.Transports.Count);
            foreach (int transport in descriptor.Transports)
            {
                writer.WriteInt32(transport);
            }
        }

        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodePasskeyLoginBegin(PasskeyLoginBeginCoreModel value)
        => EncodeToArray(256, writer => WritePasskeyLoginBegin(value, writer));

    public static bool TryDecodePasskeyLoginBegin(ReadOnlyMemory<byte> source, out PasskeyLoginBeginCoreModel value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out PasskeyLoginBeginPod pod) || pod.AllowCredentialCount < 0)
        {
            value = new PasskeyLoginBeginCoreModel();
            return false;
        }

        if (!ReadDescriptors(ref reader, pod.AllowCredentialCount, out var descriptors) ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            value = new PasskeyLoginBeginCoreModel();
            return false;
        }

        value = new PasskeyLoginBeginCoreModel
        {
            ChallengeToken = PodUtf8Codec.FromFixed64(pod.ChallengeToken),
            Timeout = pod.Timeout,
            UserVerification = pod.UserVerification >= 0 ? pod.UserVerification : null,
            RpId = PodProjector.ReadSlice(pod.RpId, payload),
            Challenge = ReadBytes(pod.Challenge, payload),
            AllowCredentials = MaterializeDescriptors(descriptors, payload)
        };
        return reader.IsConsumed;
    }

    public static void WritePasskeyRegisterCompleteRequest(PasskeyRegisterCompleteCoreModel value, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512);
        var mutable = new MutablePasskeyRegisterCompleteRequestPod
        {
            HasFriendlyName = string.IsNullOrWhiteSpace(value.FriendlyName) ? (byte)0 : (byte)1,
            HasMfaProofToken = string.IsNullOrWhiteSpace(value.MfaProofToken) ? (byte)0 : (byte)1,
            Reserved0 = 0,
            TransportCount = value.Transports.Count,
            SessionKey = PodUtf8Codec.ToFixed64(value.SessionKey),
            Id = PodUtf8Codec.AppendSlice(value.Id, payload),
            RawId = AppendBytes(value.RawId, payload),
            ClientDataBytes = AppendBytes(value.ClientDataBytes, payload),
            AttestationObject = AppendBytes(value.AttestationObject, payload),
            FriendlyName = PodUtf8Codec.AppendSlice(value.FriendlyName ?? string.Empty, payload),
            MfaProofToken = PodUtf8Codec.AppendSlice(value.MfaProofToken ?? string.Empty, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutablePasskeyRegisterCompleteRequestPod, PasskeyRegisterCompleteRequestPod>(mutable));
        foreach (int transport in value.Transports)
        {
            writer.WriteInt32(transport);
        }
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static bool TryDecodePasskeyRegisterCompleteRequest(ReadOnlyMemory<byte> source, out PasskeyRegisterCompleteCoreModel value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out PasskeyRegisterCompleteRequestPod pod) ||
            pod.HasFriendlyName > 1 ||
            pod.HasMfaProofToken > 1 ||
            pod.TransportCount < 0)
        {
            value = new PasskeyRegisterCompleteCoreModel();
            return false;
        }

        var transports = new List<int>(pod.TransportCount);
        for (int i = 0; i < pod.TransportCount; i++)
        {
            if (!reader.TryReadInt32(out int transport))
            {
                value = new PasskeyRegisterCompleteCoreModel();
                return false;
            }
            transports.Add(transport);
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            value = new PasskeyRegisterCompleteCoreModel();
            return false;
        }

        value = new PasskeyRegisterCompleteCoreModel
        {
            SessionKey = PodUtf8Codec.FromFixed64(pod.SessionKey),
            Id = PodProjector.ReadSlice(pod.Id, payload),
            RawId = ReadBytes(pod.RawId, payload),
            ClientDataBytes = ReadBytes(pod.ClientDataBytes, payload),
            AttestationObject = ReadBytes(pod.AttestationObject, payload),
            Transports = transports,
            FriendlyName = pod.HasFriendlyName == 1 ? PodProjector.ReadSlice(pod.FriendlyName, payload) : null,
            MfaProofToken = pod.HasMfaProofToken == 1 ? PodProjector.ReadSlice(pod.MfaProofToken, payload) : null
        };
        return reader.IsConsumed;
    }

    public static void WritePasskeyLoginCompleteRequest(PasskeyLoginCompleteCoreModel value, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512);
        var mutable = new MutablePasskeyLoginCompleteRequestPod
        {
            RememberMe = value.RememberMe ? (byte)1 : (byte)0,
            HasUserHandle = value.UserHandle is { Length: > 0 } ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Reserved1 = 0,
            ChallengeToken = PodUtf8Codec.ToFixed64(value.ChallengeToken),
            Id = PodUtf8Codec.AppendSlice(value.Id, payload),
            RawId = AppendBytes(value.RawId, payload),
            ClientDataBytes = AppendBytes(value.ClientDataBytes, payload),
            AuthenticatorData = AppendBytes(value.AuthenticatorData, payload),
            Signature = AppendBytes(value.Signature, payload),
            UserHandle = AppendBytes(value.UserHandle ?? [], payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutablePasskeyLoginCompleteRequestPod, PasskeyLoginCompleteRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static bool TryDecodePasskeyLoginCompleteRequest(ReadOnlyMemory<byte> source, out PasskeyLoginCompleteCoreModel value)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out PasskeyLoginCompleteRequestPod pod) ||
            pod.RememberMe > 1 ||
            pod.HasUserHandle > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            value = new PasskeyLoginCompleteCoreModel();
            return false;
        }

        value = new PasskeyLoginCompleteCoreModel
        {
            ChallengeToken = PodUtf8Codec.FromFixed64(pod.ChallengeToken),
            RememberMe = pod.RememberMe == 1,
            Id = PodProjector.ReadSlice(pod.Id, payload),
            RawId = ReadBytes(pod.RawId, payload),
            ClientDataBytes = ReadBytes(pod.ClientDataBytes, payload),
            AuthenticatorData = ReadBytes(pod.AuthenticatorData, payload),
            Signature = ReadBytes(pod.Signature, payload),
            UserHandle = pod.HasUserHandle == 1 ? ReadBytes(pod.UserHandle, payload) : null
        };
        return reader.IsConsumed;
    }

    public static void WritePasskeyCredentialList(IReadOnlyList<PasskeyCredentialSummaryDto> values, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(values.Count);
        foreach (PasskeyCredentialSummaryDto value in values)
        {
            var mutable = new MutablePasskeyCredentialSummaryPod
            {
                Id = value.Id,
                HasDeviceFriendlyName = string.IsNullOrWhiteSpace(value.DeviceFriendlyName) ? (byte)0 : (byte)1,
                HasLastUsedAt = value.LastUsedAt.HasValue ? (byte)1 : (byte)0,
                BackupEligible = value.BackupEligible ? (byte)1 : (byte)0,
                BackupState = value.BackupState ? (byte)1 : (byte)0,
                CreatedAtUnixMs = PodTimeCodec.ToUnixMs(value.CreatedAt),
                LastUsedAtUnixMs = value.LastUsedAt.HasValue ? PodTimeCodec.ToUnixMs(value.LastUsedAt.Value) : 0,
                AaGuid = PodUtf8Codec.ToFixed64(value.AaGuid),
                DeviceFriendlyName = PodUtf8Codec.AppendSlice(value.DeviceFriendlyName ?? string.Empty, payload)
            };
            writer.WritePod(CastUserPod<MutablePasskeyCredentialSummaryPod, PasskeyCredentialSummaryPod>(mutable));
        }
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static bool TryDecodePasskeyCredentialList(ReadOnlyMemory<byte> source, out IReadOnlyList<PasskeyCredentialSummaryDto> values)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadInt32(out int count) || count < 0)
        {
            values = [];
            return false;
        }

        var pods = new List<PasskeyCredentialSummaryPod>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out PasskeyCredentialSummaryPod pod) ||
                pod.HasDeviceFriendlyName > 1 ||
                pod.HasLastUsedAt > 1 ||
                pod.BackupEligible > 1 ||
                pod.BackupState > 1)
            {
                values = [];
                return false;
            }
            pods.Add(pod);
        }

        if (!reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            values = [];
            return false;
        }

        var summaries = new List<PasskeyCredentialSummaryDto>(pods.Count);
        foreach (PasskeyCredentialSummaryPod pod in pods)
        {
            summaries.Add(new PasskeyCredentialSummaryDto(
                pod.Id,
                pod.HasDeviceFriendlyName == 1 ? PodProjector.ReadSlice(pod.DeviceFriendlyName, payload) : null,
                PodTimeCodec.FromUnixMs(pod.CreatedAtUnixMs),
                pod.HasLastUsedAt == 1 ? PodTimeCodec.FromUnixMs(pod.LastUsedAtUnixMs) : null,
                PodUtf8Codec.FromFixed64(pod.AaGuid),
                pod.BackupEligible == 1,
                pod.BackupState == 1));
        }

        values = summaries;
        return reader.IsConsumed;
    }

    private readonly record struct DescriptorEnvelope(PasskeyCredentialDescriptorPod Pod, IReadOnlyList<int> Transports);

    private static bool ReadDescriptors(ref BinaryPodReader reader, int count, out IReadOnlyList<DescriptorEnvelope> descriptors)
    {
        var list = new List<DescriptorEnvelope>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out PasskeyCredentialDescriptorPod pod) ||
                pod.TransportCount < 0 ||
                !reader.TryReadInt32(out int transportCount) ||
                transportCount != pod.TransportCount)
            {
                descriptors = [];
                return false;
            }

            var transports = new List<int>(transportCount);
            for (int transportIndex = 0; transportIndex < transportCount; transportIndex++)
            {
                if (!reader.TryReadInt32(out int transport))
                {
                    descriptors = [];
                    return false;
                }
                transports.Add(transport);
            }
            list.Add(new DescriptorEnvelope(pod, transports));
        }

        descriptors = list;
        return true;
    }

    private static IReadOnlyList<PasskeyCredentialDescriptorCoreModel> MaterializeDescriptors(IReadOnlyList<DescriptorEnvelope> descriptors, ReadOnlySpan<byte> payload)
    {
        var values = new List<PasskeyCredentialDescriptorCoreModel>(descriptors.Count);
        foreach (DescriptorEnvelope descriptor in descriptors)
        {
            values.Add(new PasskeyCredentialDescriptorCoreModel(
                descriptor.Pod.Type,
                ReadBytes(descriptor.Pod.Id, payload),
                descriptor.Transports));
        }
        return values;
    }

    private static PasskeyCredentialDescriptorPod CreateDescriptorPod(PasskeyCredentialDescriptorCoreModel descriptor, ArrayBufferWriter<byte> payload)
        => CastUserPod<MutablePasskeyCredentialDescriptorPod, PasskeyCredentialDescriptorPod>(
            new MutablePasskeyCredentialDescriptorPod
            {
                Type = descriptor.Type,
                TransportCount = descriptor.Transports.Count,
                Id = AppendBytes(descriptor.Id, payload)
            });

    private static Utf8SliceRef AppendBytes(ReadOnlySpan<byte> value, ArrayBufferWriter<byte> payload)
    {
        int offset = payload.WrittenCount;
        if (!value.IsEmpty)
        {
            Span<byte> span = payload.GetSpan(value.Length);
            value.CopyTo(span);
            payload.Advance(value.Length);
        }
        return CreateSlice(offset, value.Length);
    }

    private static byte[] ReadBytes(in Utf8SliceRef slice, ReadOnlySpan<byte> payload)
    {
        if (slice.Length <= 0 || slice.Offset < 0 || slice.Offset + slice.Length > payload.Length)
        {
            return [];
        }

        return payload.Slice(slice.Offset, slice.Length).ToArray();
    }

    private static Utf8SliceRef CreateSlice(int offset, int length)
    {
        var mutable = new MutableSliceRef { Offset = offset, Length = length };
        Span<MutableSliceRef> source = stackalloc MutableSliceRef[1];
        source[0] = mutable;
        return MemoryMarshal.Read<Utf8SliceRef>(MemoryMarshal.AsBytes(source));
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableSliceRef
    {
        public int Offset;
        public int Length;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePasskeyPublicKeyCredentialParamPod
    {
        public int Type;
        public int Alg;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePasskeyCredentialDescriptorPod
    {
        public int Type;
        public int TransportCount;
        public Utf8SliceRef Id;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePasskeyRegisterBeginPod
    {
        public ulong Timeout;
        public int PubKeyCredParamCount;
        public int ExcludeCredentialCount;
        public int Attestation;
        public int ResidentKey;
        public int UserVerification;
        public int AuthenticatorAttachment;
        public byte HasAuthenticatorAttachment;
        public byte RequireResidentKey;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 SessionKey;
        public Utf8SliceRef RpId;
        public Utf8SliceRef RpName;
        public Utf8SliceRef UserName;
        public Utf8SliceRef UserDisplayName;
        public Utf8SliceRef UserId;
        public Utf8SliceRef Challenge;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePasskeyLoginBeginPod
    {
        public ulong Timeout;
        public int AllowCredentialCount;
        public int UserVerification;
        public int Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 ChallengeToken;
        public Utf8SliceRef RpId;
        public Utf8SliceRef Challenge;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePasskeyRegisterCompleteRequestPod
    {
        public byte HasFriendlyName;
        public byte HasMfaProofToken;
        public ushort Reserved0;
        public int TransportCount;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 SessionKey;
        public Utf8SliceRef Id;
        public Utf8SliceRef RawId;
        public Utf8SliceRef ClientDataBytes;
        public Utf8SliceRef AttestationObject;
        public Utf8SliceRef FriendlyName;
        public Utf8SliceRef MfaProofToken;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePasskeyLoginCompleteRequestPod
    {
        public byte RememberMe;
        public byte HasUserHandle;
        public ushort Reserved0;
        public int Reserved1;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 ChallengeToken;
        public Utf8SliceRef Id;
        public Utf8SliceRef RawId;
        public Utf8SliceRef ClientDataBytes;
        public Utf8SliceRef AuthenticatorData;
        public Utf8SliceRef Signature;
        public Utf8SliceRef UserHandle;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutablePasskeyCredentialSummaryPod
    {
        public int Id;
        public byte HasDeviceFriendlyName;
        public byte HasLastUsedAt;
        public byte BackupEligible;
        public byte BackupState;
        public long CreatedAtUnixMs;
        public long LastUsedAtUnixMs;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 AaGuid;
        public Utf8SliceRef DeviceFriendlyName;
    }
}
