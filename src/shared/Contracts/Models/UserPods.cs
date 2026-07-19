using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>TokenResponse</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct TokenResponsePod
{
    public readonly Utf8Fixed512 AccessToken;
    public readonly Utf8Fixed512 RefreshToken;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>LoginResponse</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct LoginResponsePod
{
    public readonly int AccountId;
    public readonly Utf8Fixed64 IdentityKind;
    public readonly Utf8Fixed32 ReservedIdentity;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>AuthLoginFlow</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>CurrentUserSnapshot</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>IdentityAccountSnapshot</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>UserSessionSummary</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>AdminSessionSummary</c> wire contract.
/// </summary>
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
    public readonly Utf8Fixed128 UserAgent;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>MfaSetupStart</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>MfaSetupVerify</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MfaSetupVerifyPod
{
    public readonly byte Enabled;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly int RecoveryCodeCount;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>MfaRecoveryCode</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MfaRecoveryCodePod
{
    public readonly Utf8Fixed64 Code;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>MfaProfile</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MfaProfilePod
{
    public readonly long VerifiedAtUnixMs;
    public readonly byte Enabled;
    public readonly byte HasVerifiedAt;
    public readonly ushort Reserved;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>MfaChallengeResult</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>MfaPasswordProofRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MfaPasswordProofRequestPod
{
    public readonly Utf8SliceRef Password;
    public readonly Utf8SliceRef Code;
    public readonly Utf8SliceRef RecoveryCode;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>MfaChallengeVerifyRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct MfaChallengeVerifyRequestPod
{
    public readonly Utf8SliceRef ChallengeToken;
    public readonly Utf8SliceRef Action;
    public readonly Utf8SliceRef Code;
    public readonly Utf8SliceRef RecoveryCode;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>RecoveryKeyCreateResponse</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RecoveryKeyCreateResponsePod
{
    public readonly int KeyVersion;
    public readonly int Reserved0;
    public readonly long CreatedAtUnixMs;
    public readonly Utf8SliceRef RecoveryKey;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>RecoveryKeyVerifyRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RecoveryKeyVerifyRequestPod
{
    public readonly byte RevokeSessions;
    public readonly byte RevokePasskeys;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef RecoveryKey;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>RecoveryKeyVerifyResponse</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct RecoveryKeyVerifyResponsePod
{
    public readonly int Reserved0;
    public readonly int Reserved1;
    public readonly long ExpiresAtUnixMs;
    public readonly Utf8Fixed128 RecoverySessionToken;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>AuthAnonymousBootstrapRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AuthAnonymousBootstrapRequestPod
{
    public readonly byte AcceptedGuidelines;
    public readonly byte HasPublicHandle;
    public readonly ushort Reserved0;
    public readonly Utf8SliceRef PublicHandle;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>AuthDeleteAccountRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AuthDeleteAccountRequestPod
{
    public readonly Utf8SliceRef ConfirmText;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>UserListItem</c> wire contract.
/// </summary>
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
    public readonly Utf8Fixed32 ReservedCredentialClass;
    public readonly byte HasPublicHandle;
    public readonly byte PasskeyInitialized;
    public readonly byte RecoveryInitialized;
    public readonly byte HasPrivacyInitializedAt;
    public readonly byte HasDeletedAt;
    public readonly byte Reserved2;
    public readonly ushort Reserved3;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>UserListPage</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UserListPagePod
{
    public readonly PagedPodEnvelope Envelope;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>AdminChangeUserStatusRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AdminChangeUserStatusRequestPod
{
    public readonly int AccountId;
    public readonly int Status;
    public readonly Utf8SliceRef Reason;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>PasskeyPublicKeyCredentialParam</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PasskeyPublicKeyCredentialParamPod
{
    public readonly int Type;
    public readonly int Alg;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>PasskeyCredentialDescriptor</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PasskeyCredentialDescriptorPod
{
    public readonly int Type;
    public readonly int TransportCount;
    public readonly Utf8SliceRef Id;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>PasskeyRegisterBegin</c> wire contract.
/// </summary>
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
    public readonly Utf8SliceRef AccountName;
    public readonly Utf8SliceRef AccountDisplayName;
    public readonly Utf8SliceRef AccountHandle;
    public readonly Utf8SliceRef Challenge;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>PasskeyLoginBegin</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>PasskeyRegisterCompleteRequest</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>PasskeyLoginCompleteRequest</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>PasskeyCredentialSummary</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout envelope for an authenticated WebAuthn Signal API state snapshot.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PasskeySignalStatePod
{
    public readonly long Revision;
    public readonly int CredentialCount;
    public readonly int Reserved;
    public readonly Utf8SliceRef RpId;
    public readonly Utf8SliceRef UserId;
    public readonly Utf8SliceRef Name;
    public readonly Utf8SliceRef DisplayName;
}

/// <summary>
/// Defines one credential identifier reference in a WebAuthn Signal API state snapshot.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PasskeySignalCredentialPod
{
    public readonly Utf8SliceRef CredentialId;
}
