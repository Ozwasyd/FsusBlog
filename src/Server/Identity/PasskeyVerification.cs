namespace FsusBlog.V2.Server.Passkeys;

internal static class PasskeyVerification
{
    internal static AssertionOptions RequestAssertion(this Fido2 verifier, IReadOnlyList<byte[]> credentials) =>
        verifier.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = credentials.Select(id => new PublicKeyCredentialDescriptor(id)).ToArray(),
            UserVerification = UserVerificationRequirement.Required
        });

    internal static CredentialCreateOptions RequestRegistration(this Fido2 verifier, byte[] handle,
        string name = "fsus-anonymous-account", string displayName = "Anonymous account") =>
        verifier.RequestNewCredential(new RequestNewCredentialParams
        {
            User = new Fido2User { Id = handle, Name = name, DisplayName = displayName },
            AuthenticatorSelection = new AuthenticatorSelection
            {
                ResidentKey = ResidentKeyRequirement.Required,
                UserVerification = UserVerificationRequirement.Required
            },
            AttestationPreference = AttestationConveyancePreference.None
        });

    internal static byte[] LoginFrame(this AssertionOptions options, string token, IReadOnlyList<byte[]>? allowed = null) =>
        PasskeyWire.LoginBegin(token, checked((uint)options.Timeout), options.RpId!, options.Challenge, allowed);

    internal static byte[] RegistrationFrame(this CredentialCreateOptions options, string token) =>
        PasskeyWire.ProvisionBegin(token, checked((uint)options.Timeout), options.Rp.Id, options.Rp.Name,
            options.User.Name, options.User.DisplayName, options.User.Id, options.Challenge,
            options.PubKeyCredParams.Select(parameter => (int)parameter.Alg).ToArray());

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
