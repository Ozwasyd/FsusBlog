using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct TokenResponsePod
{
    public readonly Utf8Fixed512 AccessToken;
    public readonly Utf8Fixed512 RefreshToken;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct LoginResponsePod
{
    public readonly int AccountId;
    public readonly Utf8Fixed64 IdentityKind;
    public readonly Utf8Fixed32 ReservedIdentity;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AuthLoginFlowPod
{
    public readonly int AccountId;
    public readonly byte AuthPhase;
    public readonly byte MfaMode;
    public readonly byte HasChallengeToken;
    public readonly byte HasIdentityKind;
    public readonly Utf8Fixed64 IdentityKind;
    public readonly Utf8Fixed32 ReservedIdentity;
    public readonly Utf8Fixed64 ChallengeToken;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CurrentUserSnapshotPod
{
    public readonly int AccountId;
    public readonly int Status;
    public readonly long DeletedAtUnixMs;
    public readonly byte HasDeletedAt;
    public readonly byte HasIdentityKind;
    public readonly ushort Reserved1;
    public readonly Utf8Fixed64 IdentityKind;
    public readonly Utf8Fixed32 ReservedIdentity;
    public readonly Utf8Fixed256 BanReason;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct IdentityAccountSnapshotPod
{
    public readonly int AccountId;
    public readonly int Reserved0;
    public readonly int Status;
    public readonly long DeletedAtUnixMs;
    public readonly byte HasPublicHandle;
    public readonly byte PasskeyEnabled;
    public readonly byte RecoveryEnabled;
    public readonly byte HasTotpStepUpEnabled;
    public readonly byte TotpStepUpEnabled;
    public readonly byte HasAnonymousCredential;
    public readonly byte HasDeletedAt;
    public readonly byte HasBanReason;
    public readonly uint Reserved1;
    public readonly Utf8SliceRef PublicHandle;
    public readonly Utf8SliceRef AnonymousCredentialStatus;
    public readonly Utf8SliceRef AnonymousCredentialLevel;
    public readonly Utf8SliceRef IdentityKind;
    public readonly Utf8SliceRef BanReason;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UserSessionSummaryPod
{
    public readonly long LastSeenAtUnixMs;
    public readonly byte IsCurrent;
    public readonly byte MfaVerified;
    public readonly byte HasLastSeenAt;
    public readonly byte Reserved;
    public readonly Utf8Fixed64 SessionId;
    public readonly Utf8Fixed128 DeviceFingerprint;
    public readonly Utf8Fixed128 DeviceLabel;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AdminSessionSummaryPod
{
    public readonly long CreatedAtUnixMs;
    public readonly long LastSeenAtUnixMs;
    public readonly long IdleExpiresAtUnixMs;
    public readonly long AbsoluteExpiresAtUnixMs;
    public readonly byte IsCurrent;
    public readonly byte IsRevoked;
    public readonly byte HasLastSeenAt;
    public readonly byte Reserved;
    public readonly Utf8Fixed64 SessionId;
    public readonly Utf8Fixed128 DeviceFingerprint;
    public readonly Utf8Fixed64 LastIp;
    public readonly Utf8Fixed128 UserAgent;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MfaSetupStartPod
{
    public readonly byte Enabled;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef Secret;
    public readonly Utf8SliceRef OtpAuthUrl;
    public readonly Utf8SliceRef Issuer;
    public readonly Utf8SliceRef Account;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MfaSetupVerifyPod
{
    public readonly byte Enabled;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly int RecoveryCodeCount;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MfaRecoveryCodePod
{
    public readonly Utf8Fixed64 Code;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MfaProfilePod
{
    public readonly long VerifiedAtUnixMs;
    public readonly byte Enabled;
    public readonly byte HasVerifiedAt;
    public readonly ushort Reserved;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MfaChallengeResultPod
{
    public readonly int AccountId;
    public readonly byte Verified;
    public readonly byte HasProofToken;
    public readonly byte HasUser;
    public readonly byte HasIdentityKind;
    public readonly Utf8Fixed64 IdentityKind;
    public readonly Utf8Fixed32 ReservedIdentity;
    public readonly Utf8Fixed64 Action;
    public readonly Utf8Fixed128 ProofToken;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MfaPasswordProofRequestPod
{
    public readonly Utf8SliceRef Password;
    public readonly Utf8SliceRef Code;
    public readonly Utf8SliceRef RecoveryCode;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MfaChallengeVerifyRequestPod
{
    public readonly Utf8SliceRef ChallengeToken;
    public readonly Utf8SliceRef Action;
    public readonly Utf8SliceRef Code;
    public readonly Utf8SliceRef RecoveryCode;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RecoveryKeyCreateResponsePod
{
    public readonly int KeyVersion;
    public readonly int Reserved0;
    public readonly long CreatedAtUnixMs;
    public readonly Utf8SliceRef RecoveryKey;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RecoveryKeyVerifyRequestPod
{
    public readonly byte RevokeSessions;
    public readonly byte RevokePasskeys;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef RecoveryKey;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RecoveryKeyVerifyResponsePod
{
    public readonly int Reserved0;
    public readonly int Reserved1;
    public readonly long ExpiresAtUnixMs;
    public readonly Utf8Fixed128 RecoverySessionToken;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AuthAnonymousBootstrapRequestPod
{
    public readonly byte AcceptedGuidelines;
    public readonly byte HasPublicHandle;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef PublicHandle;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AuthDeleteAccountRequestPod
{
    public readonly Utf8SliceRef ConfirmText;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UserListItemPod
{
    public readonly int AccountId;
    public readonly int Status;
    public readonly int RiskFlags;
    public readonly int Reserved;
    public readonly long CreateTimeUnixMs;
    public readonly long PrivacyInitializedAtUnixMs;
    public readonly long DeletedAtUnixMs;
    public readonly Utf8Fixed32 IdentityKind;
    public readonly Utf8Fixed64 PublicHandle;
    public readonly Utf8Fixed32 AnonymousCredentialStatus;
    public readonly Utf8Fixed32 AnonymousCredentialLevel;
    public readonly byte HasPublicHandle;
    public readonly byte PasskeyInitialized;
    public readonly byte RecoveryInitialized;
    public readonly byte HasPrivacyInitializedAt;
    public readonly byte HasDeletedAt;
    public readonly byte Reserved2;
    public readonly ushort Reserved3;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UserListPagePod
{
    public readonly PagedPodEnvelope Envelope;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AdminChangeUserStatusRequestPod
{
    public readonly int AccountId;
    public readonly int Status;
    public readonly Utf8SliceRef Reason;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PasskeyPublicKeyCredentialParamPod
{
    public readonly int Type;
    public readonly int Alg;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PasskeyCredentialDescriptorPod
{
    public readonly int Type;
    public readonly int TransportCount;
    public readonly Utf8SliceRef Id;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PasskeyRegisterBeginPod
{
    public readonly ulong Timeout;
    public readonly int PubKeyCredParamCount;
    public readonly int ExcludeCredentialCount;
    public readonly int Attestation;
    public readonly int ResidentKey;
    public readonly int UserVerification;
    public readonly int AuthenticatorAttachment;
    public readonly byte HasAuthenticatorAttachment;
    public readonly byte RequireResidentKey;
    public readonly ushort Reserved0;
    public readonly Utf8Fixed64 SessionKey;
    public readonly Utf8SliceRef RpId;
    public readonly Utf8SliceRef RpName;
    public readonly Utf8SliceRef UserName;
    public readonly Utf8SliceRef UserDisplayName;
    public readonly Utf8SliceRef UserId;
    public readonly Utf8SliceRef Challenge;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PasskeyLoginBeginPod
{
    public readonly ulong Timeout;
    public readonly int AllowCredentialCount;
    public readonly int UserVerification;
    public readonly int Reserved0;
    public readonly Utf8Fixed64 ChallengeToken;
    public readonly Utf8SliceRef RpId;
    public readonly Utf8SliceRef Challenge;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PasskeyRegisterCompleteRequestPod
{
    public readonly byte HasFriendlyName;
    public readonly byte HasMfaProofToken;
    public readonly ushort Reserved0;
    public readonly int TransportCount;
    public readonly Utf8Fixed64 SessionKey;
    public readonly Utf8SliceRef Id;
    public readonly Utf8SliceRef RawId;
    public readonly Utf8SliceRef ClientDataBytes;
    public readonly Utf8SliceRef AttestationObject;
    public readonly Utf8SliceRef FriendlyName;
    public readonly Utf8SliceRef MfaProofToken;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PasskeyLoginCompleteRequestPod
{
    public readonly byte RememberMe;
    public readonly byte HasUserHandle;
    public readonly ushort Reserved0;
    public readonly int Reserved1;
    public readonly Utf8Fixed64 ChallengeToken;
    public readonly Utf8SliceRef Id;
    public readonly Utf8SliceRef RawId;
    public readonly Utf8SliceRef ClientDataBytes;
    public readonly Utf8SliceRef AuthenticatorData;
    public readonly Utf8SliceRef Signature;
    public readonly Utf8SliceRef UserHandle;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PasskeyCredentialSummaryPod
{
    public readonly int Id;
    public readonly byte HasDeviceFriendlyName;
    public readonly byte HasLastUsedAt;
    public readonly byte BackupEligible;
    public readonly byte BackupState;
    public readonly long CreatedAtUnixMs;
    public readonly long LastUsedAtUnixMs;
    public readonly Utf8Fixed64 AaGuid;
    public readonly Utf8SliceRef DeviceFriendlyName;
}
