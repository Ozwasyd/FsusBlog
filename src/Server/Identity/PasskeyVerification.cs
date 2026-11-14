using System.Security.Cryptography;
using Fido2NetLib;
using Fido2NetLib.Objects;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Passkeys;

internal static class PasskeyVerification
{
    internal static Task<RegisteredPublicKeyCredential> Attest(Fido2 verifier, PasskeyProvisionRequest request,
        CredentialCreateOptions options, IsCredentialIdUniqueToUserAsyncDelegate unique, CancellationToken ct) =>
        verifier.MakeNewCredentialAsync(new MakeNewCredentialParams
        {
            AttestationResponse = new AuthenticatorAttestationRawResponse
            {
                Id = request.CredentialId,
                RawId = request.RawId,
                Type = PublicKeyCredentialType.PublicKey,
                Response = new AuthenticatorAttestationRawResponse.AttestationResponse
                {
                    ClientDataJson = request.ClientData,
                    AttestationObject = request.Attestation,
                    Transports = request.Transports.Select(value => (AuthenticatorTransport)value).ToArray()
                },
                ClientExtensionResults = new AuthenticationExtensionsClientOutputs()
            },
            OriginalOptions = options,
            IsCredentialIdUniqueToUserCallback = unique
        }, ct);

    internal static Task<VerifyAssertionResult> Assert(Fido2 verifier, PasskeyLoginRequest request,
        AssertionOptions options, byte[] handle, byte[] key, uint counter, CancellationToken ct) =>
        verifier.MakeAssertionAsync(new MakeAssertionParams
        {
            AssertionResponse = new AuthenticatorAssertionRawResponse
            {
                Id = request.CredentialId,
                RawId = request.RawId,
                Type = PublicKeyCredentialType.PublicKey,
                Response = new AuthenticatorAssertionRawResponse.AssertionResponse
                {
                    ClientDataJson = request.ClientData,
                    AuthenticatorData = request.AuthenticatorData,
                    Signature = request.Signature,
                    UserHandle = request.UserHandle.Length == 0 ? null : request.UserHandle
                },
                ClientExtensionResults = new AuthenticationExtensionsClientOutputs()
            },
            OriginalOptions = options,
            StoredPublicKey = key,
            StoredSignatureCounter = counter,
            IsUserHandleOwnerOfCredentialIdCallback = (candidate, _) => Task.FromResult(
                CryptographicOperations.FixedTimeEquals(candidate.UserHandle, handle) &&
                CryptographicOperations.FixedTimeEquals(candidate.CredentialId, request.RawId))
        }, ct);
}
