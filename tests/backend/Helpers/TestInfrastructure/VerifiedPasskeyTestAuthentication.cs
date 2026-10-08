using Fido2NetLib;
using Fido2NetLib.Objects;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Configuration;

using SqlSugar;

namespace FsusBlog.Server.Tests.TestInfrastructure;

/// <summary>Creates verified FIDO provenance for login persistence controls in their disposable database.</summary>
internal static class VerifiedPasskeyTestAuthentication
{
    public static async Task<UserSessionAuthenticationContext> CreateAsync(
        SqlSugarClient db, User user, TimeProvider? timeProvider = null)
    {
        string fixtureIdentity = $"native-login-input-{user.Id}-{Guid.NewGuid():N}";
        const string Origin = "http://localhost:5173";
        var fido = new Fido2(new Fido2Configuration
        {
            ServerDomain = "localhost",
            ServerName = "FsusBlog fixture contract",
            Origins = new HashSet<string>(StringComparer.Ordinal) { Origin },
            TimestampDriftTolerance = 300_000
        });
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Fido2:Origins:0"] = Origin
            })
            .Build();
        using var authenticator = new ControlledWebAuthnAuthenticator(configuration);
        byte[] userHandle = System.Security.Cryptography.SHA256.HashData(
            System.Text.Encoding.UTF8.GetBytes(AccountSubjectHashRequirement.Require(user.AccountSubjectHash, "verified-login-test-input")));
        CredentialCreateOptions originalRegistration = fido.RequestNewCredential(
            new RequestNewCredentialParams
            {
                User = new Fido2User
                {
                    Id = userHandle,
                    Name = "fixture-account",
                    DisplayName = "Fixture account"
                },
                ExcludeCredentials = [],
                AuthenticatorSelection = new AuthenticatorSelection
                {
                    ResidentKey = ResidentKeyRequirement.Required,
                    UserVerification = UserVerificationRequirement.Required
                },
                AttestationPreference = AttestationConveyancePreference.None
            });
        var registrationCore = new PasskeyRegisterBeginCoreModel
        {
            SessionKey = "registration-session",
            Timeout = originalRegistration.Timeout,
            Attestation = (int)originalRegistration.Attestation,
            ResidentKey = (int)originalRegistration.AuthenticatorSelection.ResidentKey,
            UserVerification = (int)originalRegistration.AuthenticatorSelection.UserVerification,
            RequireResidentKey = true,
            RpId = originalRegistration.Rp.Id!,
            RpName = originalRegistration.Rp.Name,
            AccountName = originalRegistration.User.Name,
            AccountDisplayName = originalRegistration.User.DisplayName,
            AccountHandle = originalRegistration.User.Id,
            Challenge = originalRegistration.Challenge,
            PubKeyCredParams = [.. originalRegistration.PubKeyCredParams.Select(
                static item => new PasskeyPublicKeyCredentialParamCoreModel(
                    (int)item.Type,
                    (int)item.Alg))]
        };
        PasskeyRegisterCompleteCoreModel registration = await authenticator
            .CreateRegistrationAsync(
                registrationCore,
                fixtureIdentity,
                CancellationToken.None);
        RegisteredPublicKeyCredential credential = await fido.MakeNewCredentialAsync(
            new MakeNewCredentialParams
            {
                AttestationResponse = new AuthenticatorAttestationRawResponse
                {
                    Id = registration.Id,
                    RawId = registration.RawId,
                    Type = PublicKeyCredentialType.PublicKey,
                    Response = new AuthenticatorAttestationRawResponse.AttestationResponse
                    {
                        ClientDataJson = registration.ClientDataBytes,
                        AttestationObject = registration.AttestationObject,
                        Transports = [AuthenticatorTransport.Internal]
                    },
                    ClientExtensionResults = new AuthenticationExtensionsClientOutputs()
                },
                OriginalOptions = originalRegistration,
                IsCredentialIdUniqueToUserCallback = async (parameters, _) =>
                {
                    string credentialId = WebEncoders.Base64UrlEncode(parameters.CredentialId);
                    return !await db.Queryable<PasskeyCredential>()
                        .Where(stored => stored.CredentialId == credentialId)
                        .AnyAsync();
                }
            },
            CancellationToken.None);

        AssertionOptions originalAssertion = fido.GetAssertionOptions(
            new GetAssertionOptionsParams
            {
                AllowedCredentials = [],
                UserVerification = UserVerificationRequirement.Required
            });
        var assertionCore = new PasskeyLoginBeginCoreModel
        {
            ChallengeToken = "assertion-session",
            Timeout = originalAssertion.Timeout,
            RpId = originalAssertion.RpId!,
            UserVerification = (int?)originalAssertion.UserVerification,
            Challenge = originalAssertion.Challenge,
            AllowCredentials = [.. originalAssertion.AllowCredentials.Select(static item =>
                new PasskeyCredentialDescriptorCoreModel((int)item.Type, item.Id, []))]
        };
        PasskeyLoginCompleteCoreModel assertion = await authenticator.CreateAssertionAsync(
            assertionCore,
            fixtureIdentity,
            CancellationToken.None);
        VerifyAssertionResult verified = await fido.MakeAssertionAsync(
            new MakeAssertionParams
            {
                AssertionResponse = new AuthenticatorAssertionRawResponse
                {
                    Id = assertion.Id,
                    RawId = assertion.RawId,
                    Type = PublicKeyCredentialType.PublicKey,
                    Response = new AuthenticatorAssertionRawResponse.AssertionResponse
                    {
                        ClientDataJson = assertion.ClientDataBytes,
                        AuthenticatorData = assertion.AuthenticatorData,
                        Signature = assertion.Signature,
                        UserHandle = assertion.UserHandle!
                    },
                    ClientExtensionResults = new AuthenticationExtensionsClientOutputs()
                },
                OriginalOptions = originalAssertion,
                StoredPublicKey = credential.PublicKey,
                StoredSignatureCounter = credential.SignCount,
                IsUserHandleOwnerOfCredentialIdCallback = (parameters, _) => Task.FromResult(
                    System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(parameters.UserHandle, userHandle)
                    && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(parameters.CredentialId, credential.Id))
            });
        Assert.Equal(1u, verified.SignCount);
        DateTime authenticatedAtUtc = (timeProvider ?? TimeProvider.System).GetUtcNow().UtcDateTime;
        var stored = new PasskeyCredential
        {
            AccountId = user.Id,
            CredentialId = WebEncoders.Base64UrlEncode(credential.Id),
            PublicKey = WebEncoders.Base64UrlEncode(credential.PublicKey),
            SignCount = verified.SignCount,
            AaGuid = Guid.Empty.ToString(),
            CreatedAt = authenticatedAtUtc,
            LastUsedAt = authenticatedAtUtc
        };
        stored.Id = await db.Insertable(stored).ExecuteReturnIdentityAsync();
        Assert.True(stored.Id > 0);
        return new UserSessionAuthenticationContext(
            UserSessionAuthenticationMethods.Passkey,
            UserSessionAuthenticationStrengths.WebAuthnUv,
            authenticatedAtUtc,
            stored.Id);
    }
}
