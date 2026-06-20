using System.Buffers;
using System.Runtime.InteropServices;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.AuthSystem;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Core.Cache;

public static partial class PodBinaryCodec
{
    public static void WriteAuthLoginFlow(AuthLoginFlowDto flow, IBufferWriter<byte> destination)
    {
        var mutable = new MutableAuthLoginFlowPod
        {
            UserId = flow.User.Id,
            AuthPhase = string.Equals(flow.AuthPhase, "mfa_required", StringComparison.OrdinalIgnoreCase) ? (byte)2 : (byte)1,
            MfaMode = string.Equals(flow.MfaMode, "risk", StringComparison.OrdinalIgnoreCase)
                ? (byte)1
                : string.Equals(flow.MfaMode, "standard", StringComparison.OrdinalIgnoreCase)
                    ? (byte)2
                    : (byte)0,
            HasChallengeToken = string.IsNullOrWhiteSpace(flow.ChallengeToken) ? (byte)0 : (byte)1,
            Reserved = 0,
            Username = PodUtf8Codec.ToFixed64(flow.User.Username),
            Role = PodUtf8Codec.ToFixed32(flow.User.Role),
            ChallengeToken = PodUtf8Codec.ToFixed64(flow.ChallengeToken ?? string.Empty)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAuthLoginFlowPod, AuthLoginFlowPod>(mutable));
    }

    public static byte[] EncodeAuthLoginFlow(AuthLoginFlowDto flow)
        => EncodeToArray(Marshal.SizeOf<AuthLoginFlowPod>(), writer => WriteAuthLoginFlow(flow, writer));

    public static bool TryDecodeAuthLoginFlow(ReadOnlyMemory<byte> source, out AuthLoginFlowDto flow)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out AuthLoginFlowPod pod) ||
            pod.AuthPhase is < 1 or > 2 ||
            pod.MfaMode > 2 ||
            pod.HasChallengeToken > 1)
        {
            flow = default;
            return false;
        }

        flow = new AuthLoginFlowDto(
            new AuthIdentitySnapshotDto(pod.UserId, PodUtf8Codec.FromFixed64(pod.Username), PodUtf8Codec.FromFixed32(pod.Role)),
            pod.AuthPhase == 2 ? "mfa_required" : "authenticated",
            pod.MfaMode == 1 ? "risk" : pod.MfaMode == 2 ? "standard" : null,
            pod.HasChallengeToken == 1 ? PodUtf8Codec.FromFixed64(pod.ChallengeToken) : null);
        return reader.IsConsumed;
    }

    public static void WriteCurrentUserSnapshot(CurrentUserSnapshotDto snapshot, IBufferWriter<byte> destination)
    {
        var mutable = new MutableCurrentUserSnapshotPod
        {
            Id = snapshot.Id,
            Status = snapshot.Status,
            DeletedAtUnixMs = snapshot.DeletedAt.HasValue ? PodTimeCodec.ToUnixMs(snapshot.DeletedAt.Value) : 0,
            HasDeletedAt = snapshot.DeletedAt.HasValue ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Reserved1 = 0,
            Username = PodUtf8Codec.ToFixed64(snapshot.Username),
            Role = PodUtf8Codec.ToFixed32(snapshot.Role),
            BanReason = PodUtf8Codec.ToFixed256(snapshot.BanReason ?? string.Empty)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableCurrentUserSnapshotPod, CurrentUserSnapshotPod>(mutable));
    }

    public static byte[] EncodeCurrentUserSnapshot(CurrentUserSnapshotDto snapshot)
        => EncodeToArray(Marshal.SizeOf<CurrentUserSnapshotPod>(), writer => WriteCurrentUserSnapshot(snapshot, writer));

    public static bool TryDecodeCurrentUserSnapshot(ReadOnlyMemory<byte> source, out CurrentUserSnapshotDto snapshot)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out CurrentUserSnapshotPod pod) || pod.HasDeletedAt > 1)
        {
            snapshot = default;
            return false;
        }

        snapshot = new CurrentUserSnapshotDto(
            pod.Id,
            PodUtf8Codec.FromFixed64(pod.Username),
            PodUtf8Codec.FromFixed32(pod.Role),
            pod.Status,
            NullUserFieldIfEmpty(PodUtf8Codec.FromFixed256(pod.BanReason)),
            pod.HasDeletedAt == 1 ? PodTimeCodec.FromUnixMs(pod.DeletedAtUnixMs) : null);
        return reader.IsConsumed;
    }

    public static void WriteIdentityAccountSnapshot(IdentityAccountSnapshotCoreModel snapshot, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(128);
        bool hasPublicHandle = !string.IsNullOrWhiteSpace(snapshot.PublicHandle);
        bool hasAnonymousCredential = !string.IsNullOrWhiteSpace(snapshot.AnonymousCredentialStatus);
        var mutable = new MutableIdentityAccountSnapshotPod
        {
            AccountId = snapshot.AccountId,
            InternalUserId = snapshot.InternalUserId,
            HasPublicHandle = hasPublicHandle ? (byte)1 : (byte)0,
            PasskeyEnabled = snapshot.PasskeyEnabled ? (byte)1 : (byte)0,
            RecoveryEnabled = snapshot.RecoveryEnabled ? (byte)1 : (byte)0,
            HasTotpStepUpEnabled = snapshot.TotpStepUpEnabled.HasValue ? (byte)1 : (byte)0,
            TotpStepUpEnabled = snapshot.TotpStepUpEnabled == true ? (byte)1 : (byte)0,
            HasAnonymousCredential = hasAnonymousCredential ? (byte)1 : (byte)0,
            Reserved0 = 0,
            PublicHandle = PodUtf8Codec.AppendSlice(hasPublicHandle ? snapshot.PublicHandle : string.Empty, payload),
            AnonymousCredentialStatus = PodUtf8Codec.AppendSlice(hasAnonymousCredential ? snapshot.AnonymousCredentialStatus : string.Empty, payload),
            AnonymousCredentialLevel = PodUtf8Codec.AppendSlice(hasAnonymousCredential ? snapshot.AnonymousCredentialLevel ?? string.Empty : string.Empty, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableIdentityAccountSnapshotPod, IdentityAccountSnapshotPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeIdentityAccountSnapshot(IdentityAccountSnapshotCoreModel snapshot)
        => EncodeToArray(Marshal.SizeOf<IdentityAccountSnapshotPod>() + 128, writer => WriteIdentityAccountSnapshot(snapshot, writer));

    public static bool TryDecodeIdentityAccountSnapshot(ReadOnlyMemory<byte> source, out IdentityAccountSnapshotCoreModel snapshot)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out IdentityAccountSnapshotPod pod) ||
            pod.HasPublicHandle > 1 ||
            pod.PasskeyEnabled > 1 ||
            pod.RecoveryEnabled > 1 ||
            pod.HasTotpStepUpEnabled > 1 ||
            pod.TotpStepUpEnabled > 1 ||
            pod.HasAnonymousCredential > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            snapshot = default;
            return false;
        }

        snapshot = new IdentityAccountSnapshotCoreModel(
            pod.AccountId,
            pod.InternalUserId,
            pod.HasPublicHandle == 1 ? PodProjector.ReadSlice(pod.PublicHandle, payload) : null,
            pod.PasskeyEnabled == 1,
            pod.RecoveryEnabled == 1,
            pod.HasTotpStepUpEnabled == 1 ? pod.TotpStepUpEnabled == 1 : null,
            pod.HasAnonymousCredential == 1 ? NullUserFieldIfEmpty(PodProjector.ReadSlice(pod.AnonymousCredentialStatus, payload)) : null,
            pod.HasAnonymousCredential == 1 ? NullUserFieldIfEmpty(PodProjector.ReadSlice(pod.AnonymousCredentialLevel, payload)) : null);
        return reader.IsConsumed;
    }

    public static void WriteUserSessions(IReadOnlyList<UserSessionSummaryDto> sessions, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(sessions.Count);
        foreach (UserSessionSummaryDto session in sessions)
        {
            var mutable = new MutableUserSessionSummaryPod
            {
                LastSeenAtUnixMs = session.LastSeenAt.HasValue ? PodTimeCodec.ToUnixMs(session.LastSeenAt.Value) : 0,
                IsCurrent = session.IsCurrent ? (byte)1 : (byte)0,
                MfaVerified = session.MfaVerified ? (byte)1 : (byte)0,
                HasLastSeenAt = session.LastSeenAt.HasValue ? (byte)1 : (byte)0,
                Reserved = 0,
                SessionId = PodUtf8Codec.ToFixed64(session.SessionId),
                DeviceFingerprint = PodUtf8Codec.ToFixed128(session.DeviceFingerprint),
                LastIp = PodUtf8Codec.ToFixed64(session.LastIp),
                DeviceLabel = PodUtf8Codec.ToFixed128(session.DeviceLabel)
            };
            writer.WritePod(CastUserPod<MutableUserSessionSummaryPod, UserSessionSummaryPod>(mutable));
        }
    }

    public static byte[] EncodeUserSessions(IReadOnlyList<UserSessionSummaryDto> sessions)
        => EncodeToArray(sizeof(int) + sessions.Count * Marshal.SizeOf<UserSessionSummaryPod>(), writer => WriteUserSessions(sessions, writer));

    public static bool TryDecodeUserSessions(ReadOnlyMemory<byte> source, out IReadOnlyList<UserSessionSummaryDto> sessions)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadInt32(out int count) || count < 0)
        {
            sessions = Array.Empty<UserSessionSummaryDto>();
            return false;
        }

        var items = new List<UserSessionSummaryDto>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out UserSessionSummaryPod pod) ||
                pod.IsCurrent > 1 ||
                pod.MfaVerified > 1 ||
                pod.HasLastSeenAt > 1)
            {
                sessions = Array.Empty<UserSessionSummaryDto>();
                return false;
            }

            items.Add(new UserSessionSummaryDto(
                PodUtf8Codec.FromFixed64(pod.SessionId),
                PodUtf8Codec.FromFixed128(pod.DeviceFingerprint),
                PodUtf8Codec.FromFixed64(pod.LastIp),
                PodUtf8Codec.FromFixed128(pod.DeviceLabel),
                pod.HasLastSeenAt == 1 ? PodTimeCodec.FromUnixMs(pod.LastSeenAtUnixMs) : null,
                pod.IsCurrent == 1,
                pod.MfaVerified == 1));
        }

        sessions = items;
        return reader.IsConsumed;
    }

    public static void WriteAdminSessions(IReadOnlyList<AdminSessionSummaryDto> sessions, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(sessions.Count);
        foreach (AdminSessionSummaryDto session in sessions)
        {
            var mutable = new MutableAdminSessionSummaryPod
            {
                CreatedAtUnixMs = PodTimeCodec.ToUnixMs(session.CreatedAtUtc),
                LastSeenAtUnixMs = session.LastSeenAtUtc.HasValue ? PodTimeCodec.ToUnixMs(session.LastSeenAtUtc.Value) : 0,
                IdleExpiresAtUnixMs = PodTimeCodec.ToUnixMs(session.IdleExpiresAtUtc),
                AbsoluteExpiresAtUnixMs = PodTimeCodec.ToUnixMs(session.AbsoluteExpiresAtUtc),
                IsCurrent = session.IsCurrent ? (byte)1 : (byte)0,
                IsRevoked = session.IsRevoked ? (byte)1 : (byte)0,
                HasLastSeenAt = session.LastSeenAtUtc.HasValue ? (byte)1 : (byte)0,
                Reserved = 0,
                SessionId = PodUtf8Codec.ToFixed64(session.SessionId),
                DeviceFingerprint = PodUtf8Codec.ToFixed128(session.DeviceFingerprint ?? string.Empty),
                LastIp = PodUtf8Codec.ToFixed64(session.LastIp ?? string.Empty),
                UserAgent = PodUtf8Codec.ToFixed128(session.UserAgent ?? string.Empty)
            };
            writer.WritePod(CastUserPod<MutableAdminSessionSummaryPod, AdminSessionSummaryPod>(mutable));
        }
    }

    public static byte[] EncodeAdminSessions(IReadOnlyList<AdminSessionSummaryDto> sessions)
        => EncodeToArray(sizeof(int) + sessions.Count * Marshal.SizeOf<AdminSessionSummaryPod>(), writer => WriteAdminSessions(sessions, writer));

    public static bool TryDecodeAdminSessions(ReadOnlyMemory<byte> source, out IReadOnlyList<AdminSessionSummaryDto> sessions)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadInt32(out int count) || count < 0)
        {
            sessions = Array.Empty<AdminSessionSummaryDto>();
            return false;
        }

        var items = new List<AdminSessionSummaryDto>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out AdminSessionSummaryPod pod) ||
                pod.IsCurrent > 1 ||
                pod.IsRevoked > 1 ||
                pod.HasLastSeenAt > 1)
            {
                sessions = Array.Empty<AdminSessionSummaryDto>();
                return false;
            }

            items.Add(new AdminSessionSummaryDto(
                PodUtf8Codec.FromFixed64(pod.SessionId),
                NullIfEmpty(PodUtf8Codec.FromFixed128(pod.DeviceFingerprint)),
                NullIfEmpty(PodUtf8Codec.FromFixed64(pod.LastIp)),
                NullIfEmpty(PodUtf8Codec.FromFixed128(pod.UserAgent)),
                PodTimeCodec.FromUnixMs(pod.CreatedAtUnixMs),
                pod.HasLastSeenAt == 1 ? PodTimeCodec.FromUnixMs(pod.LastSeenAtUnixMs) : null,
                PodTimeCodec.FromUnixMs(pod.IdleExpiresAtUnixMs),
                PodTimeCodec.FromUnixMs(pod.AbsoluteExpiresAtUnixMs),
                pod.IsCurrent == 1,
                pod.IsRevoked == 1));
        }

        sessions = items;
        return reader.IsConsumed;
    }

    public static void WriteMfaSetupStart(MfaSetupStartDto dto, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(512);
        var mutable = new MutableMfaSetupStartPod
        {
            Enabled = dto.Enabled ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Reserved1 = 0,
            Secret = PodUtf8Codec.AppendSlice(dto.Secret, payload),
            OtpAuthUrl = PodUtf8Codec.AppendSlice(dto.OtpAuthUrl, payload),
            Issuer = PodUtf8Codec.AppendSlice(dto.Issuer, payload),
            Account = PodUtf8Codec.AppendSlice(dto.Account, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableMfaSetupStartPod, MfaSetupStartPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static bool TryDecodeMfaSetupStart(ReadOnlyMemory<byte> source, out MfaSetupStartDto dto)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out MfaSetupStartPod pod) || pod.Enabled > 1 || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            dto = default;
            return false;
        }

        dto = new MfaSetupStartDto(
            pod.Enabled == 1,
            PodProjector.ReadSlice(pod.Secret, payload),
            PodProjector.ReadSlice(pod.OtpAuthUrl, payload),
            PodProjector.ReadSlice(pod.Issuer, payload),
            PodProjector.ReadSlice(pod.Account, payload));
        return reader.IsConsumed;
    }

    public static void WriteMfaSetupVerify(MfaSetupVerifyDto dto, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        var header = new MutableMfaSetupVerifyPod
        {
            Enabled = dto.Enabled ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Reserved1 = 0,
            RecoveryCodeCount = dto.RecoveryCodes.Count
        };
        writer.WritePod(CastUserPod<MutableMfaSetupVerifyPod, MfaSetupVerifyPod>(header));
        foreach (string code in dto.RecoveryCodes)
        {
            writer.WritePod(CastUserPod<MutableMfaRecoveryCodePod, MfaRecoveryCodePod>(
                new MutableMfaRecoveryCodePod { Code = PodUtf8Codec.ToFixed64(code) }));
        }
    }

    public static byte[] EncodeMfaSetupVerify(MfaSetupVerifyDto dto)
        => EncodeToArray(8 + dto.RecoveryCodes.Count * Marshal.SizeOf<MfaRecoveryCodePod>(), writer => WriteMfaSetupVerify(dto, writer));

    public static bool TryDecodeMfaSetupVerify(ReadOnlyMemory<byte> source, out MfaSetupVerifyDto dto)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out MfaSetupVerifyPod header) || header.Enabled > 1 || header.RecoveryCodeCount < 0)
        {
            dto = new MfaSetupVerifyDto();
            return false;
        }

        var codes = new List<string>(header.RecoveryCodeCount);
        for (int i = 0; i < header.RecoveryCodeCount; i++)
        {
            if (!reader.TryReadPod(out MfaRecoveryCodePod code))
            {
                dto = new MfaSetupVerifyDto();
                return false;
            }

            codes.Add(PodUtf8Codec.FromFixed64(code.Code));
        }

        dto = new MfaSetupVerifyDto { Enabled = header.Enabled == 1, RecoveryCodes = codes };
        return reader.IsConsumed;
    }

    public static void WriteMfaProfile(MfaProfileDto dto, IBufferWriter<byte> destination)
    {
        var mutable = new MutableMfaProfilePod
        {
            VerifiedAtUnixMs = dto.VerifiedAt.HasValue ? PodTimeCodec.ToUnixMs(dto.VerifiedAt.Value) : 0,
            Enabled = dto.Enabled ? (byte)1 : (byte)0,
            HasVerifiedAt = dto.VerifiedAt.HasValue ? (byte)1 : (byte)0,
            Reserved = 0
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableMfaProfilePod, MfaProfilePod>(mutable));
    }

    public static bool TryDecodeMfaProfile(ReadOnlyMemory<byte> source, out MfaProfileDto dto)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out MfaProfilePod pod) || pod.Enabled > 1 || pod.HasVerifiedAt > 1)
        {
            dto = default;
            return false;
        }

        dto = new MfaProfileDto(pod.Enabled == 1, pod.HasVerifiedAt == 1 ? PodTimeCodec.FromUnixMs(pod.VerifiedAtUnixMs) : null);
        return reader.IsConsumed;
    }

    public static void WriteMfaChallengeResult(MfaChallengeResultDto dto, IBufferWriter<byte> destination)
    {
        var mutable = new MutableMfaChallengeResultPod
        {
            UserId = dto.User?.Id ?? 0,
            Verified = dto.Verified ? (byte)1 : (byte)0,
            HasProofToken = string.IsNullOrWhiteSpace(dto.ProofToken) ? (byte)0 : (byte)1,
            HasUser = dto.User.HasValue ? (byte)1 : (byte)0,
            Reserved = 0,
            Username = PodUtf8Codec.ToFixed64(dto.User?.Username ?? string.Empty),
            Role = PodUtf8Codec.ToFixed32(dto.User?.Role ?? string.Empty),
            Action = PodUtf8Codec.ToFixed64(dto.Action),
            ProofToken = PodUtf8Codec.ToFixed128(dto.ProofToken ?? string.Empty)
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableMfaChallengeResultPod, MfaChallengeResultPod>(mutable));
    }

    public static bool TryDecodeMfaChallengeResult(ReadOnlyMemory<byte> source, out MfaChallengeResultDto dto)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out MfaChallengeResultPod pod) ||
            pod.Verified > 1 ||
            pod.HasProofToken > 1 ||
            pod.HasUser > 1)
        {
            dto = default;
            return false;
        }

        AuthIdentitySnapshotDto? user = pod.HasUser == 1
            ? new AuthIdentitySnapshotDto(pod.UserId, PodUtf8Codec.FromFixed64(pod.Username), PodUtf8Codec.FromFixed32(pod.Role))
            : null;
        dto = new MfaChallengeResultDto(
            pod.Verified == 1,
            PodUtf8Codec.FromFixed64(pod.Action),
            pod.HasProofToken == 1 ? PodUtf8Codec.FromFixed128(pod.ProofToken) : null,
            user);
        return reader.IsConsumed;
    }

    public static void WriteMfaPasswordProofRequest(MfaPasswordProofRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableMfaPasswordProofRequestPod
        {
            Password = PodUtf8Codec.AppendSlice(request.Password, payload),
            Code = PodUtf8Codec.AppendSlice(request.Code ?? string.Empty, payload),
            RecoveryCode = PodUtf8Codec.AppendSlice(request.RecoveryCode ?? string.Empty, payload)
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableMfaPasswordProofRequestPod, MfaPasswordProofRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeMfaPasswordProofRequest(MfaPasswordProofRequestCoreModel request)
        => EncodeToArray(256, writer => WriteMfaPasswordProofRequest(request, writer));

    public static bool TryDecodeMfaPasswordProofRequest(ReadOnlyMemory<byte> source, out MfaPasswordProofRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out MfaPasswordProofRequestPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new MfaPasswordProofRequestCoreModel(
            PodProjector.ReadSlice(pod.Password, payload),
            NullUserFieldIfEmpty(PodProjector.ReadSlice(pod.Code, payload)),
            NullUserFieldIfEmpty(PodProjector.ReadSlice(pod.RecoveryCode, payload)));
        return reader.IsConsumed;
    }

    public static void WriteMfaChallengeVerifyRequest(MfaChallengeVerifyRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableMfaChallengeVerifyRequestPod
        {
            ChallengeToken = PodUtf8Codec.AppendSlice(request.ChallengeToken, payload),
            Action = PodUtf8Codec.AppendSlice(request.Action ?? string.Empty, payload),
            Code = PodUtf8Codec.AppendSlice(request.Code ?? string.Empty, payload),
            RecoveryCode = PodUtf8Codec.AppendSlice(request.RecoveryCode ?? string.Empty, payload)
        };
        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableMfaChallengeVerifyRequestPod, MfaChallengeVerifyRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeMfaChallengeVerifyRequest(MfaChallengeVerifyRequestCoreModel request)
        => EncodeToArray(256, writer => WriteMfaChallengeVerifyRequest(request, writer));

    public static bool TryDecodeMfaChallengeVerifyRequest(ReadOnlyMemory<byte> source, out MfaChallengeVerifyRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out MfaChallengeVerifyRequestPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new MfaChallengeVerifyRequestCoreModel(
            PodProjector.ReadSlice(pod.ChallengeToken, payload),
            NullUserFieldIfEmpty(PodProjector.ReadSlice(pod.Action, payload)),
            NullUserFieldIfEmpty(PodProjector.ReadSlice(pod.Code, payload)),
            NullUserFieldIfEmpty(PodProjector.ReadSlice(pod.RecoveryCode, payload)));
        return reader.IsConsumed;
    }

    public static void WriteRecoveryKeyCreateResponse(RecoveryKeyCreateResponseCoreModel response, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(128);
        var mutable = new MutableRecoveryKeyCreateResponsePod
        {
            KeyVersion = response.KeyVersion,
            Reserved0 = 0,
            CreatedAtUnixMs = PodTimeCodec.ToUnixMs(response.CreatedAt),
            RecoveryKey = PodUtf8Codec.AppendSlice(response.RecoveryKey, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableRecoveryKeyCreateResponsePod, RecoveryKeyCreateResponsePod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static bool TryDecodeRecoveryKeyCreateResponse(ReadOnlyMemory<byte> source, out RecoveryKeyCreateResponseCoreModel response)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out RecoveryKeyCreateResponsePod pod) || pod.KeyVersion <= 0 || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            response = default;
            return false;
        }

        response = new RecoveryKeyCreateResponseCoreModel(
            PodProjector.ReadSlice(pod.RecoveryKey, payload),
            pod.KeyVersion,
            PodTimeCodec.FromUnixMs(pod.CreatedAtUnixMs));
        return reader.IsConsumed;
    }

    public static void WriteRecoveryKeyVerifyRequest(RecoveryKeyVerifyRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(128);
        var mutable = new MutableRecoveryKeyVerifyRequestPod
        {
            UserId = request.UserId,
            RevokeSessions = request.RevokeSessions ? (byte)1 : (byte)0,
            RevokePasskeys = request.RevokePasskeys ? (byte)1 : (byte)0,
            Reserved0 = 0,
            RecoveryKey = PodUtf8Codec.AppendSlice(request.RecoveryKey, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableRecoveryKeyVerifyRequestPod, RecoveryKeyVerifyRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static bool TryDecodeRecoveryKeyVerifyRequest(ReadOnlyMemory<byte> source, out RecoveryKeyVerifyRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out RecoveryKeyVerifyRequestPod pod) ||
            pod.RevokeSessions > 1 ||
            pod.RevokePasskeys > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new RecoveryKeyVerifyRequestCoreModel(
            pod.UserId,
            PodProjector.ReadSlice(pod.RecoveryKey, payload),
            pod.RevokeSessions == 1,
            pod.RevokePasskeys == 1);
        return reader.IsConsumed;
    }

    public static void WriteRecoveryKeyVerifyResponse(RecoveryKeyVerifyResponseCoreModel response, IBufferWriter<byte> destination)
    {
        var mutable = new MutableRecoveryKeyVerifyResponsePod
        {
            UserId = response.UserId,
            Reserved0 = 0,
            ExpiresAtUnixMs = PodTimeCodec.ToUnixMs(response.ExpiresAt),
            RecoverySessionToken = PodUtf8Codec.ToFixed128(response.RecoverySessionToken)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableRecoveryKeyVerifyResponsePod, RecoveryKeyVerifyResponsePod>(mutable));
    }

    public static bool TryDecodeRecoveryKeyVerifyResponse(ReadOnlyMemory<byte> source, out RecoveryKeyVerifyResponseCoreModel response)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out RecoveryKeyVerifyResponsePod pod) || pod.UserId <= 0)
        {
            response = default;
            return false;
        }

        response = new RecoveryKeyVerifyResponseCoreModel(
            pod.UserId,
            PodUtf8Codec.FromFixed128(pod.RecoverySessionToken),
            PodTimeCodec.FromUnixMs(pod.ExpiresAtUnixMs));
        return reader.IsConsumed;
    }

    public static void WriteAuthLoginRequest(AuthLoginRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableAuthLoginRequestPod
        {
            RememberMe = request.RememberMe ? (byte)1 : (byte)0,
            Reserved0 = 0,
            Reserved1 = 0,
            Username = PodUtf8Codec.AppendSlice(request.Username, payload),
            Password = PodUtf8Codec.AppendSlice(request.Password, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAuthLoginRequestPod, AuthLoginRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAuthLoginRequest(AuthLoginRequestCoreModel request)
        => EncodeToArray(256, writer => WriteAuthLoginRequest(request, writer));

    public static bool TryDecodeAuthLoginRequest(ReadOnlyMemory<byte> source, out AuthLoginRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out AuthLoginRequestPod pod) || pod.RememberMe > 1 || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new AuthLoginRequestCoreModel(
            PodProjector.ReadSlice(pod.Username, payload),
            PodProjector.ReadSlice(pod.Password, payload),
            pod.RememberMe == 1);
        return reader.IsConsumed;
    }

    public static void WriteAuthRegisterRequest(AuthRegisterRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableAuthRegisterRequestPod
        {
            Username = PodUtf8Codec.AppendSlice(request.Username, payload),
            Password = PodUtf8Codec.AppendSlice(request.Password, payload),
            ConfirmPassword = PodUtf8Codec.AppendSlice(request.ConfirmPassword, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAuthRegisterRequestPod, AuthRegisterRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAuthRegisterRequest(AuthRegisterRequestCoreModel request)
        => EncodeToArray(256, writer => WriteAuthRegisterRequest(request, writer));

    public static bool TryDecodeAuthRegisterRequest(ReadOnlyMemory<byte> source, out AuthRegisterRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out AuthRegisterRequestPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new AuthRegisterRequestCoreModel(
            PodProjector.ReadSlice(pod.Username, payload),
            PodProjector.ReadSlice(pod.Password, payload),
            PodProjector.ReadSlice(pod.ConfirmPassword, payload));
        return reader.IsConsumed;
    }

    public static void WriteAuthAnonymousBootstrapRequest(AuthAnonymousBootstrapRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(64);
        string publicHandle = request.PublicHandle?.Trim() ?? string.Empty;
        bool hasPublicHandle = publicHandle.Length > 0;
        var mutable = new MutableAuthAnonymousBootstrapRequestPod
        {
            AcceptedGuidelines = request.AcceptedGuidelines ? (byte)1 : (byte)0,
            HasPublicHandle = hasPublicHandle ? (byte)1 : (byte)0,
            Reserved0 = 0,
            PublicHandle = PodUtf8Codec.AppendSlice(hasPublicHandle ? publicHandle : string.Empty, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAuthAnonymousBootstrapRequestPod, AuthAnonymousBootstrapRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAuthAnonymousBootstrapRequest(AuthAnonymousBootstrapRequestCoreModel request)
        => EncodeToArray(96, writer => WriteAuthAnonymousBootstrapRequest(request, writer));

    public static bool TryDecodeAuthAnonymousBootstrapRequest(ReadOnlyMemory<byte> source, out AuthAnonymousBootstrapRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out AuthAnonymousBootstrapRequestPod pod) ||
            pod.AcceptedGuidelines > 1 ||
            pod.HasPublicHandle > 1 ||
            !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new AuthAnonymousBootstrapRequestCoreModel(
            pod.HasPublicHandle == 1 ? NullUserFieldIfEmpty(PodProjector.ReadSlice(pod.PublicHandle, payload)) : null,
            pod.AcceptedGuidelines == 1);
        return reader.IsConsumed;
    }

    public static void WriteAuthUpdatePasswordRequest(AuthUpdatePasswordRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableAuthUpdatePasswordRequestPod
        {
            OldPassword = PodUtf8Codec.AppendSlice(request.OldPassword, payload),
            NewPassword = PodUtf8Codec.AppendSlice(request.NewPassword, payload),
            ConfirmPassword = PodUtf8Codec.AppendSlice(request.ConfirmPassword, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAuthUpdatePasswordRequestPod, AuthUpdatePasswordRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAuthUpdatePasswordRequest(AuthUpdatePasswordRequestCoreModel request)
        => EncodeToArray(256, writer => WriteAuthUpdatePasswordRequest(request, writer));

    public static bool TryDecodeAuthUpdatePasswordRequest(ReadOnlyMemory<byte> source, out AuthUpdatePasswordRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out AuthUpdatePasswordRequestPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new AuthUpdatePasswordRequestCoreModel(
            PodProjector.ReadSlice(pod.OldPassword, payload),
            PodProjector.ReadSlice(pod.NewPassword, payload),
            PodProjector.ReadSlice(pod.ConfirmPassword, payload));
        return reader.IsConsumed;
    }

    public static void WriteAuthDeleteAccountRequest(AuthDeleteAccountRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableAuthDeleteAccountRequestPod
        {
            Password = PodUtf8Codec.AppendSlice(request.Password, payload),
            ConfirmText = PodUtf8Codec.AppendSlice(request.ConfirmText, payload),
            Code = PodUtf8Codec.AppendSlice(request.Code ?? string.Empty, payload),
            RecoveryCode = PodUtf8Codec.AppendSlice(request.RecoveryCode ?? string.Empty, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAuthDeleteAccountRequestPod, AuthDeleteAccountRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAuthDeleteAccountRequest(AuthDeleteAccountRequestCoreModel request)
        => EncodeToArray(256, writer => WriteAuthDeleteAccountRequest(request, writer));

    public static bool TryDecodeAuthDeleteAccountRequest(ReadOnlyMemory<byte> source, out AuthDeleteAccountRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out AuthDeleteAccountRequestPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new AuthDeleteAccountRequestCoreModel(
            PodProjector.ReadSlice(pod.Password, payload),
            PodProjector.ReadSlice(pod.ConfirmText, payload),
            NullUserFieldIfEmpty(PodProjector.ReadSlice(pod.Code, payload)),
            NullUserFieldIfEmpty(PodProjector.ReadSlice(pod.RecoveryCode, payload)));
        return reader.IsConsumed;
    }

    public static void WriteAdminUserPage(AdminUserPageContract page, IBufferWriter<byte> destination)
    {
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(page.Total);
        writer.WriteInt32(page.Items.Count);

        foreach (UserListItemContract item in page.Items)
        {
            var mutable = new MutableUserListItemPod
            {
                Id = item.Id,
                Status = item.Status,
                CreateTimeUnixMs = PodTimeCodec.ToUnixMs(item.CreateTime),
                LastLoginTimeUnixMs = item.LastLoginTime.HasValue ? PodTimeCodec.ToUnixMs(item.LastLoginTime.Value) : 0,
                Username = PodUtf8Codec.ToFixed64(item.Username),
                Role = PodUtf8Codec.ToFixed32(item.Role),
                LastLoginIp = PodUtf8Codec.ToFixed64(item.LastLoginIp ?? string.Empty),
                HasLastLoginIp = string.IsNullOrWhiteSpace(item.LastLoginIp) ? (byte)0 : (byte)1,
                HasLastLoginTime = item.LastLoginTime.HasValue ? (byte)1 : (byte)0,
                Reserved = 0,
                DeletedAtUnixMs = item.DeletedAt.HasValue ? PodTimeCodec.ToUnixMs(item.DeletedAt.Value) : 0,
                HasDeletedAt = item.DeletedAt.HasValue ? (byte)1 : (byte)0,
                Reserved2 = 0,
                Reserved3 = 0
            };
            writer.WritePod(CastUserPod<MutableUserListItemPod, UserListItemPod>(mutable));
        }
    }

    public static byte[] EncodeAdminUserPage(AdminUserPageContract page)
        => EncodeToArray(8 + page.Items.Count * Marshal.SizeOf<UserListItemPod>(), writer => WriteAdminUserPage(page, writer));

    public static bool TryDecodeAdminUserPage(ReadOnlyMemory<byte> source, out AdminUserPageContract page)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadInt32(out int total) || !reader.TryReadInt32(out int count) || total < 0 || count < 0)
        {
            page = new AdminUserPageContract();
            return false;
        }

        var items = new List<UserListItemContract>(count);
        for (int i = 0; i < count; i++)
        {
            if (!reader.TryReadPod(out UserListItemPod pod) ||
                pod.HasLastLoginIp > 1 ||
                pod.HasLastLoginTime > 1 ||
                pod.HasDeletedAt > 1)
            {
                page = new AdminUserPageContract();
                return false;
            }

            items.Add(new UserListItemContract(
                pod.Id,
                PodUtf8Codec.FromFixed64(pod.Username),
                PodUtf8Codec.FromFixed32(pod.Role),
                pod.Status,
                PodTimeCodec.FromUnixMs(pod.CreateTimeUnixMs),
                pod.HasLastLoginIp == 1 ? PodUtf8Codec.FromFixed64(pod.LastLoginIp) : null,
                pod.HasLastLoginTime == 1 ? PodTimeCodec.FromUnixMs(pod.LastLoginTimeUnixMs) : null,
                pod.HasDeletedAt == 1 ? PodTimeCodec.FromUnixMs(pod.DeletedAtUnixMs) : null));
        }

        page = new AdminUserPageContract { Total = total, Items = items };
        return reader.IsConsumed;
    }

    public static void WriteAdminChangeUserStatusRequest(AdminChangeUserStatusRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableAdminChangeUserStatusRequestPod
        {
            UserId = request.UserId,
            Status = request.Status,
            Reason = PodUtf8Codec.AppendSlice(request.Reason ?? string.Empty, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAdminChangeUserStatusRequestPod, AdminChangeUserStatusRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAdminChangeUserStatusRequest(AdminChangeUserStatusRequestCoreModel request)
        => EncodeToArray(128 + (request.Reason?.Length ?? 0), writer => WriteAdminChangeUserStatusRequest(request, writer));

    public static bool TryDecodeAdminChangeUserStatusRequest(ReadOnlyMemory<byte> source, out AdminChangeUserStatusRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out AdminChangeUserStatusRequestPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        string reason = PodProjector.ReadSlice(pod.Reason, payload);
        request = new AdminChangeUserStatusRequestCoreModel(
            pod.UserId,
            pod.Status,
            string.IsNullOrWhiteSpace(reason) ? null : reason);
        return reader.IsConsumed;
    }

    public static void WriteAdminResetUserPasswordRequest(AdminResetUserPasswordRequestCoreModel request, IBufferWriter<byte> destination)
    {
        var payload = new ArrayBufferWriter<byte>(256);
        var mutable = new MutableAdminResetUserPasswordRequestPod
        {
            UserId = request.UserId,
            Reserved = 0,
            NewPassword = PodUtf8Codec.AppendSlice(request.NewPassword, payload)
        };

        var writer = new BinaryPodWriter(destination);
        writer.WritePod(CastUserPod<MutableAdminResetUserPasswordRequestPod, AdminResetUserPasswordRequestPod>(mutable));
        writer.WriteBytes(payload.WrittenSpan);
    }

    public static byte[] EncodeAdminResetUserPasswordRequest(AdminResetUserPasswordRequestCoreModel request)
        => EncodeToArray(128 + request.NewPassword.Length, writer => WriteAdminResetUserPasswordRequest(request, writer));

    public static bool TryDecodeAdminResetUserPasswordRequest(ReadOnlyMemory<byte> source, out AdminResetUserPasswordRequestCoreModel request)
    {
        var reader = new BinaryPodReader(source.Span);
        if (!reader.TryReadPod(out AdminResetUserPasswordRequestPod pod) || !reader.TryReadBytes(out ReadOnlySpan<byte> payload))
        {
            request = default;
            return false;
        }

        request = new AdminResetUserPasswordRequestCoreModel(pod.UserId, PodProjector.ReadSlice(pod.NewPassword, payload));
        return reader.IsConsumed;
    }

    private static TTo CastUserPod<TFrom, TTo>(TFrom source)
        where TFrom : unmanaged
        where TTo : unmanaged
    {
        Span<TFrom> from = stackalloc TFrom[1];
        from[0] = source;
        return MemoryMarshal.Read<TTo>(MemoryMarshal.AsBytes(from));
    }

    private static string? NullUserFieldIfEmpty(string value) => value.Length == 0 ? null : value;

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAuthLoginFlowPod
    {
        public int UserId;
        public byte AuthPhase;
        public byte MfaMode;
        public byte HasChallengeToken;
        public byte Reserved;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 Username;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed32 Role;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 ChallengeToken;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableCurrentUserSnapshotPod
    {
        public int Id;
        public int Status;
        public long DeletedAtUnixMs;
        public byte HasDeletedAt;
        public byte Reserved0;
        public ushort Reserved1;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 Username;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed32 Role;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed256 BanReason;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableIdentityAccountSnapshotPod
    {
        public int AccountId;
        public int InternalUserId;
        public byte HasPublicHandle;
        public byte PasskeyEnabled;
        public byte RecoveryEnabled;
        public byte HasTotpStepUpEnabled;
        public byte TotpStepUpEnabled;
        public byte HasAnonymousCredential;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef PublicHandle;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef AnonymousCredentialStatus;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef AnonymousCredentialLevel;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUserSessionSummaryPod
    {
        public long LastSeenAtUnixMs;
        public byte IsCurrent;
        public byte MfaVerified;
        public byte HasLastSeenAt;
        public byte Reserved;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 SessionId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed128 DeviceFingerprint;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 LastIp;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed128 DeviceLabel;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAdminSessionSummaryPod
    {
        public long CreatedAtUnixMs;
        public long LastSeenAtUnixMs;
        public long IdleExpiresAtUnixMs;
        public long AbsoluteExpiresAtUnixMs;
        public byte IsCurrent;
        public byte IsRevoked;
        public byte HasLastSeenAt;
        public byte Reserved;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 SessionId;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed128 DeviceFingerprint;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 LastIp;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed128 UserAgent;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableMfaSetupStartPod
    {
        public byte Enabled;
        public byte Reserved0;
        public ushort Reserved1;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Secret;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef OtpAuthUrl;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Issuer;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Account;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableMfaSetupVerifyPod
    {
        public byte Enabled;
        public byte Reserved0;
        public ushort Reserved1;
        public int RecoveryCodeCount;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableMfaRecoveryCodePod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 Code;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableMfaProfilePod
    {
        public long VerifiedAtUnixMs;
        public byte Enabled;
        public byte HasVerifiedAt;
        public ushort Reserved;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableMfaChallengeResultPod
    {
        public int UserId;
        public byte Verified;
        public byte HasProofToken;
        public byte HasUser;
        public byte Reserved;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 Username;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed32 Role;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 Action;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed128 ProofToken;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableMfaPasswordProofRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Password;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Code;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RecoveryCode;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableMfaChallengeVerifyRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ChallengeToken;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Action;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Code;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RecoveryCode;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRecoveryKeyCreateResponsePod
    {
        public int KeyVersion;
        public int Reserved0;
        public long CreatedAtUnixMs;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RecoveryKey;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRecoveryKeyVerifyRequestPod
    {
        public int UserId;
        public byte RevokeSessions;
        public byte RevokePasskeys;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RecoveryKey;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableRecoveryKeyVerifyResponsePod
    {
        public int UserId;
        public int Reserved0;
        public long ExpiresAtUnixMs;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed128 RecoverySessionToken;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAuthLoginRequestPod
    {
        public byte RememberMe;
        public byte Reserved0;
        public ushort Reserved1;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Username;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Password;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAuthRegisterRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Username;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Password;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ConfirmPassword;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAuthAnonymousBootstrapRequestPod
    {
        public byte AcceptedGuidelines;
        public byte HasPublicHandle;
        public ushort Reserved0;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef PublicHandle;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAuthUpdatePasswordRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef OldPassword;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef NewPassword;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ConfirmPassword;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAuthDeleteAccountRequestPod
    {
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Password;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef ConfirmText;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Code;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef RecoveryCode;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableUserListItemPod
    {
        public int Id;
        public int Status;
        public long CreateTimeUnixMs;
        public long LastLoginTimeUnixMs;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 Username;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed32 Role;
        public FsusBlog.Shared.Contracts.Primitives.Utf8Fixed64 LastLoginIp;
        public byte HasLastLoginIp;
        public byte HasLastLoginTime;
        public ushort Reserved;
        public long DeletedAtUnixMs;
        public byte HasDeletedAt;
        public byte Reserved2;
        public ushort Reserved3;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAdminChangeUserStatusRequestPod
    {
        public int UserId;
        public int Status;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef Reason;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    private struct MutableAdminResetUserPasswordRequestPod
    {
        public int UserId;
        public int Reserved;
        public FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef NewPassword;
    }
}
