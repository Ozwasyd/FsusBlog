// fixture-catalog: producer auth-session
using System.Buffers.Binary;
using System.Globalization;
using System.IdentityModel.Tokens.Jwt;
using System.Security.Cryptography;
using System.Security.Claims;
using System.Text;
using System.Text.Json;

using Fido2NetLib.Objects;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Hosting;
using Microsoft.AspNetCore.WebUtilities;

namespace FsusBlog.Server.Services.Fixtures;

public interface IAuthFixtureSeeder
{
    Task<AuthFixturePrepareResult> PrepareAsync(
        AuthFixturePlan request,
        CancellationToken cancellationToken = default);

    Task<AuthFixtureVerificationResult> VerifyAsync(
        AuthFixtureVerificationRequest request,
        CancellationToken cancellationToken = default);
}

public interface IAuthFixtureLifecycleRepository
{
    Task<User?> FindUserByFixtureIdentityAsync(string fixtureIdentity, CancellationToken cancellationToken);
    Task<User?> FindUserByIdAsync(int userId, CancellationToken cancellationToken);
    Task<bool> HasVerifiedMfaProfileAsync(int userId, CancellationToken cancellationToken);
    Task<bool> HasUsedPasskeyCredentialAsync(int userId, CancellationToken cancellationToken);
    Task<bool> HasActiveRecoveryKeyAsync(int userId, CancellationToken cancellationToken);
    Task<User> InsertOwnedUserAsync(User user, CancellationToken cancellationToken);
    Task<bool> TransitionOwnedUserToDeletedAsync(int userId, DateTime deletedAt, CancellationToken cancellationToken);
    Task<IReadOnlyList<UserSession>> ListUserSessionsAsync(int userId, CancellationToken cancellationToken);
    Task<IReadOnlyList<UserSession>> ListSessionsByIdsAsync(IReadOnlyList<string> sessionIds, CancellationToken cancellationToken);
    Task<UserSession?> FindSessionAsync(string sessionId, CancellationToken cancellationToken);
    Task<bool> TransitionSessionToExpiredAsync(string sessionId, DateTime expiredAt, CancellationToken cancellationToken);
    Task<AdminPrincipal?> FindAdminByFixtureIdentityAsync(string fixtureIdentity, CancellationToken cancellationToken);
    Task<AdminPrincipal?> FindAdminByIdAsync(long adminId, CancellationToken cancellationToken);
    Task<AdminPrincipal> InsertOwnedAdminAsync(AdminPrincipal admin, CancellationToken cancellationToken);
    Task<int> CountRootAdminsAsync(CancellationToken cancellationToken);
}

public interface IControlledWebAuthnAuthenticator
{
    Task<PasskeyRegisterCompleteCoreModel> CreateRegistrationAsync(
        PasskeyRegisterBeginCoreModel options,
        string fixtureIdentity,
        CancellationToken cancellationToken);

    Task<PasskeyLoginCompleteCoreModel> CreateAssertionAsync(
        PasskeyLoginBeginCoreModel options,
        string fixtureIdentity,
        CancellationToken cancellationToken);
}

/// <summary>
/// In-process CTAP2-style authenticator for the Development/Test composition
/// root. The private key is scoped to one fixture request and never leaves
/// process memory. Production FIDO validation still consumes the generated
/// attestation and assertion; this adapter has no validation bypass.
/// </summary>
public sealed class ControlledWebAuthnAuthenticator(
    IConfiguration configuration) : IControlledWebAuthnAuthenticator, IDisposable
{
    private const int Es256Algorithm = -7;
    private readonly Dictionary<string, CredentialState> _credentials = new(StringComparer.Ordinal);
    private bool _disposed;

    public Task<PasskeyRegisterCompleteCoreModel> CreateRegistrationAsync(
        PasskeyRegisterBeginCoreModel options,
        string fixtureIdentity,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (string.IsNullOrWhiteSpace(fixtureIdentity) ||
            string.IsNullOrWhiteSpace(options.SessionKey) ||
            string.IsNullOrWhiteSpace(options.RpId) ||
            options.Challenge.Length < 16 ||
            options.AccountHandle.Length == 0 ||
            !options.PubKeyCredParams.Any(static item => item.Alg == Es256Algorithm))
        {
            throw new InvalidOperationException(
                "controlled WebAuthn registration options are invalid or unsupported");
        }

        byte[] credentialId = SHA256.HashData(Encoding.UTF8.GetBytes(
            $"fsusblog-controlled-webauthn-v1\0{fixtureIdentity}"));
        if (options.ExcludeCredentials.Any(item =>
                CryptographicOperations.FixedTimeEquals(item.Id, credentialId)))
        {
            throw new InvalidOperationException(
                "controlled WebAuthn credential is excluded by production options");
        }

        ECDsa key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        ECParameters parameters = key.ExportParameters(includePrivateParameters: false);
        byte[] cosePublicKey = EncodeCosePublicKey(
            parameters.Q.X ?? throw new InvalidOperationException("ES256 X coordinate is missing"),
            parameters.Q.Y ?? throw new InvalidOperationException("ES256 Y coordinate is missing"));
        byte[] authenticatorData = BuildRegistrationAuthenticatorData(
            options.RpId,
            credentialId,
            cosePublicKey);
        byte[] clientData = ClientData(
            "webauthn.create",
            options.Challenge,
            ResolveOrigin(options.RpId));
        var state = new CredentialState(
            key,
            credentialId,
            options.AccountHandle.ToArray(),
            options.RpId,
            SignCount: 0);
        if (!_credentials.TryAdd(fixtureIdentity, state))
        {
            key.Dispose();
            throw new InvalidOperationException(
                "controlled WebAuthn fixture identity already registered in this ceremony");
        }

        return Task.FromResult(new PasskeyRegisterCompleteCoreModel
        {
            SessionKey = options.SessionKey,
            Id = WebEncoders.Base64UrlEncode(credentialId),
            RawId = credentialId,
            ClientDataBytes = clientData,
            AttestationObject = EncodeNoneAttestation(authenticatorData),
            Transports = [(int)AuthenticatorTransport.Internal],
            FriendlyName = $"Fixture {fixtureIdentity[^Math.Min(12, fixtureIdentity.Length)..]}"
        });
    }

    public Task<PasskeyLoginCompleteCoreModel> CreateAssertionAsync(
        PasskeyLoginBeginCoreModel options,
        string fixtureIdentity,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!_credentials.TryGetValue(fixtureIdentity, out CredentialState? state) ||
            string.IsNullOrWhiteSpace(options.ChallengeToken) ||
            options.Challenge.Length < 16 ||
            !string.Equals(options.RpId, state.RpId, StringComparison.Ordinal) ||
            options.AllowCredentials.Count == 0 ||
            !options.AllowCredentials.Any(item =>
                CryptographicOperations.FixedTimeEquals(item.Id, state.CredentialId)))
        {
            throw new InvalidOperationException(
                "controlled WebAuthn assertion options do not bind the registered credential");
        }

        uint nextSignCount = checked(state.SignCount + 1);
        byte[] authenticatorData = BuildAssertionAuthenticatorData(state.RpId, nextSignCount);
        byte[] clientData = ClientData(
            "webauthn.get",
            options.Challenge,
            ResolveOrigin(options.RpId));
        byte[] signedPayload = new byte[authenticatorData.Length + SHA256.HashSizeInBytes];
        authenticatorData.CopyTo(signedPayload, 0);
        SHA256.HashData(clientData).CopyTo(signedPayload, authenticatorData.Length);
        byte[] signature = state.Key.SignData(
            signedPayload,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.Rfc3279DerSequence);
        _credentials[fixtureIdentity] = state with
        {
            SignCount = nextSignCount
        };

        return Task.FromResult(new PasskeyLoginCompleteCoreModel
        {
            ChallengeToken = options.ChallengeToken,
            Id = WebEncoders.Base64UrlEncode(state.CredentialId),
            RawId = state.CredentialId,
            ClientDataBytes = clientData,
            AuthenticatorData = authenticatorData,
            Signature = signature,
            UserHandle = state.UserHandle,
            RememberMe = false
        });
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }
        _disposed = true;
        foreach (CredentialState state in _credentials.Values)
        {
            state.Key.Dispose();
        }
        _credentials.Clear();
    }

    private string ResolveOrigin(string rpId)
    {
        string? origin = configuration.GetSection("Fido2:Origins")
            .Get<string[]>()?
            .FirstOrDefault(value => Uri.TryCreate(value, UriKind.Absolute, out Uri? uri) &&
                string.Equals(uri.Host, rpId, StringComparison.OrdinalIgnoreCase));
        return origin ?? throw new InvalidOperationException(
            "controlled WebAuthn cannot find a configured production-trusted origin for the RP");
    }

    private static byte[] ClientData(string type, byte[] challenge, string origin)
        => JsonSerializer.SerializeToUtf8Bytes(new
        {
            type,
            challenge = WebEncoders.Base64UrlEncode(challenge),
            origin,
            crossOrigin = false
        });

    private static byte[] BuildRegistrationAuthenticatorData(
        string rpId,
        byte[] credentialId,
        byte[] cosePublicKey)
    {
        byte[] value = new byte[37 + 16 + 2 + credentialId.Length + cosePublicKey.Length];
        SHA256.HashData(Encoding.UTF8.GetBytes(rpId)).CopyTo(value, 0);
        value[32] = 0x45; // UP | UV | AT
        BinaryPrimitives.WriteUInt32BigEndian(value.AsSpan(33, 4), 0);
        // AAGUID remains all-zero for the software authenticator.
        BinaryPrimitives.WriteUInt16BigEndian(value.AsSpan(53, 2), checked((ushort)credentialId.Length));
        credentialId.CopyTo(value, 55);
        cosePublicKey.CopyTo(value, 55 + credentialId.Length);
        return value;
    }

    private static byte[] BuildAssertionAuthenticatorData(string rpId, uint signCount)
    {
        byte[] value = new byte[37];
        SHA256.HashData(Encoding.UTF8.GetBytes(rpId)).CopyTo(value, 0);
        value[32] = 0x05; // UP | UV
        BinaryPrimitives.WriteUInt32BigEndian(value.AsSpan(33, 4), signCount);
        return value;
    }

    private static byte[] EncodeCosePublicKey(byte[] x, byte[] y)
    {
        using var stream = new MemoryStream();
        stream.WriteByte(0xA5); // map(5)
        WriteInteger(stream, 1);
        WriteInteger(stream, 2); // kty: EC2
        WriteInteger(stream, 3);
        WriteInteger(stream, Es256Algorithm); // alg: ES256
        WriteInteger(stream, -1);
        WriteInteger(stream, 1); // crv: P-256
        WriteInteger(stream, -2);
        WriteByteString(stream, x);
        WriteInteger(stream, -3);
        WriteByteString(stream, y);
        return stream.ToArray();
    }

    private static byte[] EncodeNoneAttestation(byte[] authenticatorData)
    {
        using var stream = new MemoryStream();
        stream.WriteByte(0xA3); // map(3)
        WriteText(stream, "fmt");
        WriteText(stream, "none");
        WriteText(stream, "attStmt");
        stream.WriteByte(0xA0); // empty map
        WriteText(stream, "authData");
        WriteByteString(stream, authenticatorData);
        return stream.ToArray();
    }

    private static void WriteInteger(Stream stream, int value)
    {
        if (value >= 0)
        {
            WriteCborHeader(stream, 0, checked((uint)value));
        }
        else
        {
            WriteCborHeader(stream, 1, checked((uint)(-1 - value)));
        }
    }

    private static void WriteText(Stream stream, string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        WriteCborHeader(stream, 3, checked((uint)bytes.Length));
        stream.Write(bytes);
    }

    private static void WriteByteString(Stream stream, byte[] value)
    {
        WriteCborHeader(stream, 2, checked((uint)value.Length));
        stream.Write(value);
    }

    private static void WriteCborHeader(Stream stream, byte majorType, uint value)
    {
        if (value < 24)
        {
            stream.WriteByte((byte)(((uint)majorType << 5) | value));
            return;
        }
        if (value <= byte.MaxValue)
        {
            stream.WriteByte((byte)((majorType << 5) | 24));
            stream.WriteByte((byte)value);
            return;
        }
        if (value <= ushort.MaxValue)
        {
            stream.WriteByte((byte)((majorType << 5) | 25));
            Span<byte> encoded = stackalloc byte[2];
            BinaryPrimitives.WriteUInt16BigEndian(encoded, (ushort)value);
            stream.Write(encoded);
            return;
        }
        stream.WriteByte((byte)((majorType << 5) | 26));
        Span<byte> wide = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(wide, value);
        stream.Write(wide);
    }

    private sealed record CredentialState(
        ECDsa Key,
        byte[] CredentialId,
        byte[] UserHandle,
        string RpId,
        uint SignCount);
}

public sealed record AuthFixturePlan
{
    public required string Schema
    {
        get; init;
    }
    public required string Strategy
    {
        get; init;
    }
    public required string ProducerId
    {
        get; init;
    }
    public required string Namespace
    {
        get; init;
    }
    public required string RunId
    {
        get; init;
    }
    public required string ProfileId
    {
        get; init;
    }
    public required string CatalogDigest
    {
        get; init;
    }
    public required string FixtureVariantPlanDigest
    {
        get; init;
    }
    public required string ProducerVariantPlanDigest
    {
        get; init;
    }
    public required IReadOnlyList<string> Capabilities
    {
        get; init;
    }
    public required IReadOnlyList<AuthFixtureRolePlan> Roles
    {
        get; init;
    }
    public required JsonElement TemporalContext
    {
        get; init;
    }
    public required JsonElement ResolvedTemporalRoles
    {
        get; init;
    }
    public required string PlanDigest
    {
        get; init;
    }
}

public sealed record AuthFixtureRolePlan
{
    public required string CapabilityId
    {
        get; init;
    }
    public required string SemanticRole
    {
        get; init;
    }
    public required string Kind
    {
        get; init;
    }
    public required string ExpectedState
    {
        get; init;
    }
    public required string FixtureIdentity
    {
        get; init;
    }
    public required string OwnerIdentity
    {
        get; init;
    }
    public string? AllocationConsumerProducerId
    {
        get; init;
    }
    public string? AllocationRole
    {
        get; init;
    }
    public string? SubjectRole
    {
        get; init;
    }
    public string? SubjectFixtureIdentity
    {
        get; init;
    }
    public int? SessionCount
    {
        get; init;
    }
    public IReadOnlyList<string>? SessionIdentities
    {
        get; init;
    }
    public IReadOnlyList<string>? DeviceSignals
    {
        get; init;
    }
    public IReadOnlyList<string>? FamilyIdentities
    {
        get; init;
    }
    public string? PermissionProjection
    {
        get; init;
    }
}

public sealed record AuthFixtureEntityObservation(
    string Kind,
    string Id,
    bool Owned,
    string CapabilityHint,
    string PostconditionId,
    string SemanticRole,
    string FixtureIdentity,
    IReadOnlyDictionary<string, object?> Fields);

public sealed record AuthFixtureDatabaseObservation(
    string Namespace,
    string SchemaIdentity,
    IReadOnlyList<AuthFixtureEntityObservation> Entities);

public sealed record AuthFixtureRedisObservation(
    string Namespace,
    IReadOnlyList<object> Keys);

public sealed record AuthFixtureCacheObservation(
    string Namespace,
    IReadOnlyList<object> Entries);

public sealed record AuthFixtureObservations(
    string Source,
    AuthFixtureDatabaseObservation Database,
    AuthFixtureRedisObservation Redis,
    AuthFixtureCacheObservation Cache);

public sealed record AuthFixturePrepareResult(
    string ProducerId,
    string Strategy,
    string Implementation,
    string PlanDigest,
    IReadOnlyList<string> ProvidedCapabilities,
    AuthFixtureObservations Observations,
    string PermissionCatalogDigest,
    string? CeremonyEvidenceDigest,
    object TemporalObservation);

public sealed record AuthFixtureVerificationEntity(
    string Kind,
    string Id,
    string SemanticRole,
    string FixtureIdentity,
    string CapabilityHint);

public sealed record AuthFixtureVerificationRequest(
    string ReceiptDigest,
    string PlanDigest,
    IReadOnlyList<string> ProvidedCapabilities,
    IReadOnlyList<AuthFixtureVerificationEntity> EntityIdentities);

public sealed record AuthFixtureVerificationResult(
    bool Ok,
    string ReceiptDigest,
    string? Reason = null);

public sealed class AuthFixtureSeeder(
    IAuthFixtureLifecycleRepository repository,
    IUserMfaCommandService mfaCommands,
    IRecoveryKeyService recoveryKeys,
    IUserSessionFixtureLoginWorkflow fixtureLoginWorkflow,
    IUserSessionCommandService sessionCommands,
    IUserSessionValidationService sessionValidation,
    IJwtHelper jwt,
    IPasskeyService passkeys,
    TimeProvider timeProvider,
    IHostEnvironment environment,
    TestTemporalRuntimeContext temporalRuntimeContext,
    IControlledWebAuthnAuthenticator? authenticator = null) : IAuthFixtureSeeder
{
    private const string ProducerId = "auth-session";
    private const string Strategy = "transaction-fixture";
    private const string Schema = "fsusblog.auth-session-fixture-plan.v1";

    public async Task<AuthFixturePrepareResult> PrepareAsync(
        AuthFixturePlan request,
        CancellationToken cancellationToken = default)
    {
        RequireTestOnly();
        ValidatePlan(request);
        temporalRuntimeContext.RequireExactRequest(request.TemporalContext);
        string resolvedDigest = request.ResolvedTemporalRoles
            .GetProperty("contentDigest")
            .GetString()
            ?? throw new InvalidOperationException(
                "resolved temporal role artifact contentDigest is required");
        ResolvedTemporalRoleContext resolvedTemporalRoles =
            ResolvedTemporalRoleContext.Parse(
                request.ResolvedTemporalRoles.GetRawText(),
                resolvedDigest);
        if (resolvedTemporalRoles.ProducerId != ProducerId ||
            resolvedTemporalRoles.SchedulerRunId != request.RunId ||
            resolvedTemporalRoles.RequireInstant("session.created") !=
                temporalRuntimeContext.BusinessEpochUtc)
        {
            throw new InvalidOperationException(
                "resolved temporal roles do not exact-match the auth fixture plan");
        }

        var entities = new List<AuthFixtureEntityObservation>();
        foreach (AuthFixtureRolePlan role in request.Roles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            IReadOnlyList<AuthFixtureEntityObservation> observed = role.Kind switch
            {
                "user" => [await PrepareUserAsync(role, cancellationToken)],
                "session" => await PrepareSessionsAsync(role, cancellationToken),
                "admin" => [await PrepareAdminAsync(role, cancellationToken)],
                "admin-root-set" => [await PrepareRootEmptyAsync(role, cancellationToken)],
                _ => throw new InvalidOperationException(
                    $"Unknown auth fixture role kind {role.Kind}.")
            };
            entities.AddRange(observed);
        }

        IReadOnlyList<string> capabilities = request.Capabilities
            .Order(StringComparer.Ordinal)
            .ToArray();
        string? ceremonyDigest = entities.Any(static item =>
                item.CapabilityHint == "auth.user.passkey-enabled")
            ? Digest(entities
                .Where(static item => item.CapabilityHint == "auth.user.passkey-enabled")
                .Select(static item => item.Fields))
            : null;
        return new AuthFixturePrepareResult(
            ProducerId,
            Strategy,
            "FsusBlog.Server.Services.Fixtures.AuthFixtureSeeder",
            request.PlanDigest,
            capabilities,
            new AuthFixtureObservations(
                "application-read-model",
                new AuthFixtureDatabaseObservation(
                    request.Namespace,
                    "public",
                    entities),
                new AuthFixtureRedisObservation(request.Namespace, []),
                new AuthFixtureCacheObservation(request.Namespace, [])),
            PermissionCatalogDigest(),
            ceremonyDigest,
            new
            {
                businessEpochUtc = timeProvider.GetUtcNow().ToString(
                    "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
                    CultureInfo.InvariantCulture),
                observationBoundary = "auth-fixture-backend-and-postgres-read-model",
                resolvedTemporalRoleArtifactDigest = resolvedTemporalRoles.ContentDigest
            });
    }

    public async Task<AuthFixtureVerificationResult> VerifyAsync(
        AuthFixtureVerificationRequest request,
        CancellationToken cancellationToken = default)
    {
        RequireTestOnly();
        if (string.IsNullOrWhiteSpace(request.ReceiptDigest) ||
            string.IsNullOrWhiteSpace(request.PlanDigest) ||
            request.EntityIdentities.Count == 0)
        {
            return new(false, request.ReceiptDigest, "verification binding is incomplete");
        }

        foreach (AuthFixtureVerificationEntity entity in request.EntityIdentities)
        {
            cancellationToken.ThrowIfCancellationRequested();
            bool valid = entity.Kind switch
            {
                "user" => await VerifyUserAsync(entity),
                "session" => await VerifySessionAsync(entity),
                "admin" => await VerifyAdminAsync(entity),
                "admin-root-set" => await VerifyRootEmptyAsync(),
                _ => false
            };
            if (!valid)
            {
                return new(
                    false,
                    request.ReceiptDigest,
                    $"independent read-model mismatch for {entity.SemanticRole}");
            }
        }
        if (request.ProvidedCapabilities.Contains(
                "session.multi-device",
                StringComparer.Ordinal) &&
            !await VerifyMultiDeviceAsync(request.EntityIdentities))
        {
            return new(
                false,
                request.ReceiptDigest,
                "independent read-model mismatch for session.multi-device");
        }
        return new(true, request.ReceiptDigest);
    }

    private async Task<AuthFixtureEntityObservation> PrepareUserAsync(
        AuthFixtureRolePlan role,
        CancellationToken cancellationToken)
    {
        User user = await EnsureOwnedUserAsync(
            role.FixtureIdentity,
            deleted: role.CapabilityId == "auth.user.deleted",
            cancellationToken);
        if (role.CapabilityId == "auth.user.mfa-enabled" && !user.MfaEnabled)
        {
            await EnableMfaAsync(user, cancellationToken);
            user = await RequireUserAsync(user.Id, cancellationToken);
        }
        else if (role.CapabilityId == "auth.user.passkey-enabled" && !user.PasskeyEnabled)
        {
            await CompletePasskeyCeremonyAsync(user, role.FixtureIdentity, cancellationToken);
            user = await RequireUserAsync(user.Id, cancellationToken);
        }
        else if (role.CapabilityId == "auth.user.recovery-enabled" && !user.RecoveryEnabled)
        {
            Result<RecoveryKeyCreateResponseCoreModel> created = await recoveryKeys
                .CreateAsync(user.Id, cancellationToken);
            if (!created.IsSuccess)
            {
                throw new InvalidOperationException(created.Error.Message);
            }
            user = await RequireUserAsync(user.Id, cancellationToken);
        }

        var fields = BaseUserFields(user);
        if (role.CapabilityId == "auth.user.passkey-enabled")
        {
            fields["ceremony"] = new Dictionary<string, object?>
            {
                ["validationBoundary"] = "production-fido",
                ["challengeSingleUse"] = true,
                ["challengeConsumed"] = true,
                ["signatureVerified"] = true,
                ["originVerified"] = true,
                ["rpIdVerified"] = true,
                ["counterVerified"] = true
            };
        }
        return Entity(role, user.Id.ToString(CultureInfo.InvariantCulture), fields);
    }

    private async Task<IReadOnlyList<AuthFixtureEntityObservation>> PrepareSessionsAsync(
        AuthFixtureRolePlan role,
        CancellationToken cancellationToken)
    {
        string subjectIdentity = role.SubjectFixtureIdentity
            ?? throw new InvalidOperationException("session subject fixture identity is required");
        User user = await EnsureOwnedUserAsync(subjectIdentity, deleted: false, cancellationToken);
        int count = role.SessionCount ?? 1;
        if (count is < 1 or > 2 || role.DeviceSignals is null ||
            role.DeviceSignals.Count != count || role.SessionIdentities is null ||
            role.SessionIdentities.Count != count || role.FamilyIdentities is null ||
            role.FamilyIdentities.Count != count)
        {
            throw new InvalidOperationException("session role has invalid exact device plan");
        }

        IReadOnlyList<UserSession> existingSessions = await repository
            .ListUserSessionsAsync(user.Id, cancellationToken);
        if (existingSessions.Count > 0)
        {
            if (existingSessions.Count != count ||
                existingSessions.Any(item => !ExistingSessionMatches(role, item)))
            {
                throw new InvalidOperationException(
                    $"owned session role {role.SemanticRole} exists with stale state; reset is forbidden");
            }
            if (role.CapabilityId == "session.multi-device" &&
                (existingSessions.Select(static item => item.DeviceSignalHash)
                    .Distinct(StringComparer.Ordinal).Count() != 2 ||
                 existingSessions.Select(static item => item.RefreshFamilyId)
                    .Distinct(StringComparer.Ordinal).Count() != 2))
            {
                throw new InvalidOperationException(
                    "owned multi-device fixture lost distinct device/family state");
            }
            var observedExisting = new List<AuthFixtureEntityObservation>(existingSessions.Count);
            foreach (UserSession session in existingSessions)
            {
                observedExisting.Add(await ExistingSessionEntityAsync(
                    role,
                    session,
                    user,
                    cancellationToken));
            }
            return observedExisting;
        }

        var outcomes = new List<(SessionTokenResponseDto Tokens, string DeviceSignal)>(count);
        for (int index = 0; index < count; index++)
        {
            bool remembered = role.CapabilityId == "session.remembered";
            var authentication = new UserSessionAuthenticationContext(
                UserSessionAuthenticationMethods.Other,
                UserSessionAuthenticationStrengths.LegacyVerified,
                timeProvider.GetUtcNow().UtcDateTime,
                DurationPolicy: UserSessionDurationPolicies.FromRememberMe(remembered));
            var login = await fixtureLoginWorkflow.CompleteFixtureLoginAsync(
                user.Id,
                "127.0.0.1",
                role.DeviceSignals[index],
                "fsusblog-auth-fixture",
                mfaVerified: true,
                rememberMe: remembered,
                authentication,
                new UserSessionFixtureIdentity(
                    role.SessionIdentities[index],
                    role.FamilyIdentities[index]),
                cancellationToken);
            if (!login.Success || !login.Data.HasValue)
            {
                throw new InvalidOperationException(
                    $"production login application rejected {role.SemanticRole}: {login.Message}");
            }
            outcomes.Add((login.Data.Value, role.DeviceSignals[index]));
        }

        if (role.CapabilityId == "session.expired")
        {
            DateTime expiredAt = timeProvider.GetUtcNow().UtcDateTime;
            bool updated = await repository.TransitionSessionToExpiredAsync(
                outcomes[0].Tokens.SessionId,
                expiredAt,
                cancellationToken);
            RequireSingleTransition(updated ? 1 : 0, role.SemanticRole);
        }
        else if (role.CapabilityId == "session.revoked")
        {
            bool revoked = await sessionCommands.RevokeSessionAsync(
                user.Id,
                outcomes[0].Tokens.SessionId,
                "fixture_explicit_revoked",
                cancellationToken);
            if (!revoked)
            {
                throw new InvalidOperationException("production revoke transition did not commit");
            }
        }
        else if (role.CapabilityId == "session.refresh-rotated")
        {
            RefreshTokenRotationResult rotation = await sessionCommands.RotateRefreshTokenAsync(
                outcomes[0].Tokens.RefreshToken,
                outcomes[0].Tokens.SessionId,
                cancellationToken);
            if (!rotation.Success)
            {
                throw new InvalidOperationException(
                    $"production refresh rotation failed: {rotation.Outcome}");
            }
        }

        var result = new List<AuthFixtureEntityObservation>(count);
        for (int index = 0; index < count; index++)
        {
            SessionTokenResponseDto original = outcomes[index].Tokens;
            UserSession session = await repository.FindSessionAsync(
                original.SessionId,
                cancellationToken)
                ?? throw new InvalidOperationException("session read-model row is missing");
            string state = SessionState(session);
            ClaimsPrincipal tokenPrincipal = ReadIssuedPrincipal(original.AccessToken);
            bool claimsMatch = tokenPrincipal.GetUserId() == user.Id &&
                tokenPrincipal.GetSessionId() == session.SessionId &&
                tokenPrincipal.FindFirst("auth_method")?.Value == session.AuthenticationMethod &&
                tokenPrincipal.FindFirst("auth_strength")?.Value == session.AuthenticationStrength;
            UserSessionValidationResult validation = await sessionValidation.ValidateAsync(
                tokenPrincipal,
                cancellationToken);
            bool expectedEligible = state == "active";
            var fields = new Dictionary<string, object?>
            {
                ["state"] = state,
                ["live"] = state == "active",
                ["deviceSignal"] = session.DeviceSignalHash ?? outcomes[index].DeviceSignal,
                ["familyIdentity"] = session.RefreshFamilyId,
                ["rememberMe"] = session.RememberMe,
                ["durationPolicy"] = session.DurationPolicy,
                ["databaseStateVerified"] = true,
                ["claimStateVerified"] = claimsMatch,
                ["cacheStateVerified"] = validation.IsValid == expectedEligible
            };
            if (role.CapabilityId == "session.refresh-rotated")
            {
                fields["state"] = "rotated";
                fields["oldRefreshAccepted"] = await sessionCommands.VerifyRefreshRotationAsync(
                    original.RefreshToken,
                    original.SessionId,
                    cancellationToken);
                fields["currentGeneration"] = session.RefreshGeneration;
                fields["currentPointerVerified"] = session.RefreshGeneration == 1;
            }
            result.Add(Entity(role, session.SessionId, fields));
        }
        return result;
    }

    private async Task<AuthFixtureEntityObservation> PrepareAdminAsync(
        AuthFixtureRolePlan role,
        CancellationToken cancellationToken)
    {
        string[] catalog = AdminPermissions.All.Order(StringComparer.Ordinal).ToArray();
        string[] allowed = ProjectPermissions(role.PermissionProjection, catalog);
        string status = role.PermissionProjection == "disabled"
            ? AdminPrincipalStatus.Disabled
            : AdminPrincipalStatus.Active;
        AdminPrincipal? existing = await repository.FindAdminByFixtureIdentityAsync(
            role.FixtureIdentity,
            cancellationToken);
        if (existing is null)
        {
            existing = new AdminPrincipal
            {
                Handle = role.FixtureIdentity,
                DisplayName = role.SemanticRole,
                Status = status,
                IsRoot = false,
                Permissions = string.Join('\n', allowed),
                CreatedAtUtc = timeProvider.GetUtcNow().UtcDateTime
            };
            existing = await repository.InsertOwnedAdminAsync(existing, cancellationToken);
        }
        else if (!string.Equals(existing.Status, status, StringComparison.Ordinal) ||
            !Permissions(existing.Permissions).SequenceEqual(allowed))
        {
            throw new InvalidOperationException(
                $"owned admin {role.SemanticRole} exists with stale state; reset is forbidden");
        }

        (string[] authorized, string[] denied) = AuthorizeProjection(allowed, catalog);
        return Entity(
            role,
            existing.Id.ToString(CultureInfo.InvariantCulture),
            new Dictionary<string, object?>
            {
                ["state"] = status,
                ["status"] = status,
                ["disabled"] = status == AdminPrincipalStatus.Disabled,
                ["permission"] = role.PermissionProjection switch
                {
                    "full-permission" => "full",
                    "partial-permission" => "partial",
                    _ => role.PermissionProjection
                },
                ["permissionLevel"] = role.PermissionProjection switch
                {
                    "full-permission" => "full",
                    "partial-permission" => "partial",
                    _ => role.PermissionProjection
                },
                ["permissionIds"] = allowed,
                ["allowedActions"] = authorized,
                ["deniedActions"] = denied,
                ["permissionCatalogDigest"] = PermissionCatalogDigest(),
                ["authorizationVerified"] = authorized.SequenceEqual(allowed),
                ["sessionIssuanceEligible"] = status == AdminPrincipalStatus.Active,
                ["authorizationEligible"] = status == AdminPrincipalStatus.Active
            });
    }

    private async Task<AuthFixtureEntityObservation> PrepareRootEmptyAsync(
        AuthFixtureRolePlan role,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int roots = await repository.CountRootAdminsAsync(cancellationToken);
        if (roots != 0)
        {
            throw new InvalidOperationException(
                "root-bootstrap-empty requires an isolated empty database; nonowned admins are never deleted");
        }
        return Entity(role, role.FixtureIdentity, new Dictionary<string, object?>
        {
            ["state"] = "empty",
            ["rootCount"] = 0,
            ["nonownedDeletionCount"] = 0
        });
    }

    private async Task<User> EnsureOwnedUserAsync(
        string fixtureIdentity,
        bool deleted,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        User? existing = await repository.FindUserByFixtureIdentityAsync(
            fixtureIdentity,
            cancellationToken);
        int expectedStatus = deleted ? 2 : 0;
        if (existing is not null)
        {
            if (existing.Status != expectedStatus ||
                existing.DeletedAt.HasValue != deleted)
            {
                throw new InvalidOperationException(
                    $"owned identity {fixtureIdentity} exists with stale state; reset is forbidden");
            }
            return existing;
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        var user = new User
        {
            PublicHandle = fixtureIdentity,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            AccountSubjectHash = AccountSubjectHasher.Create(
                AnonymousIdentityRuntime.AnonymousAccountKind,
                fixtureIdentity),
            RegistrationState = AccountRegistrationStates.Active,
            PasskeyEnabled = false,
            RecoveryEnabled = false,
            PrivacyInitializedAt = now,
            AnonymousCredentialLevel = "basic",
            AnonymousCredentialStatus = "active",
            Status = 0,
            CreateTime = now,
            MfaEnabled = false
        };
        user = await repository.InsertOwnedUserAsync(user, cancellationToken);
        if (deleted)
        {
            bool updated = await repository.TransitionOwnedUserToDeletedAsync(
                user.Id,
                now,
                cancellationToken);
            RequireSingleTransition(updated ? 1 : 0, fixtureIdentity);
            user = await RequireUserAsync(user.Id, cancellationToken);
        }
        return user;
    }

    private async Task EnableMfaAsync(User user, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var setup = await mfaCommands.StartMfaSetupAsync(
            user.Id,
            "FsusBlog fixture",
            stepUpVerified: true);
        if (!setup.Success || !setup.Data.HasValue)
        {
            throw new InvalidOperationException(setup.Message);
        }
        string code = ComputeTotp(setup.Data.Value.Secret, timeProvider.GetUtcNow());
        var verified = await mfaCommands.VerifyMfaSetupAsync(user.Id, code);
        if (!verified.Success)
        {
            throw new InvalidOperationException(verified.Message);
        }
    }

    private async Task CompletePasskeyCeremonyAsync(
        User user,
        string fixtureIdentity,
        CancellationToken cancellationToken)
    {
        if (authenticator is null)
        {
            throw new InvalidOperationException(
                "controlled WebAuthn authenticator is unavailable; validation cannot be weakened");
        }
        var begin = await passkeys.BeginRegistrationAsync(user.Id, cancellationToken);
        if (!begin.Success || begin.Data is null)
        {
            throw new InvalidOperationException(begin.Message);
        }
        PasskeyRegisterCompleteCoreModel registration = await authenticator
            .CreateRegistrationAsync(begin.Data.Options, fixtureIdentity, cancellationToken);
        var completed = await passkeys.CompleteRegistrationAsync(
            user.Id,
            registration,
            cancellationToken);
        if (!completed.Success)
        {
            throw new InvalidOperationException(completed.Message);
        }
        var assertionBegin = await passkeys.BeginAssertionAsync(cancellationToken);
        if (!assertionBegin.Success || assertionBegin.Data is null)
        {
            throw new InvalidOperationException(assertionBegin.Message);
        }
        PasskeyLoginCompleteCoreModel assertion = await authenticator
            .CreateAssertionAsync(assertionBegin.Data.Options, fixtureIdentity, cancellationToken);
        var asserted = await passkeys.CompleteAssertionAsync(assertion, cancellationToken);
        if (!asserted.Success || asserted.User?.Id != user.Id)
        {
            throw new InvalidOperationException(asserted.Message);
        }
    }

    private async Task<User> RequireUserAsync(
        int userId,
        CancellationToken cancellationToken)
        => await repository.FindUserByIdAsync(userId, cancellationToken)
            ?? throw new InvalidOperationException("owned user disappeared after transition");

    private async Task<bool> VerifyUserAsync(AuthFixtureVerificationEntity entity)
    {
        if (!int.TryParse(entity.Id, NumberStyles.None, CultureInfo.InvariantCulture, out int id))
        {
            return false;
        }
        User? user = await repository.FindUserByIdAsync(id, CancellationToken.None);
        if (user is null || !string.Equals(user.PublicHandle, entity.FixtureIdentity, StringComparison.Ordinal))
        {
            return false;
        }
        return entity.CapabilityHint switch
        {
            "auth.user.deleted" => user.Status == 2 && user.DeletedAt.HasValue,
            "auth.user.mfa-disabled" => user.Status == 0 && !user.MfaEnabled,
            "auth.user.mfa-enabled" => user.Status == 0 && user.MfaEnabled &&
                await repository.HasVerifiedMfaProfileAsync(id, CancellationToken.None),
            "auth.user.passkey-enabled" => user.Status == 0 && user.PasskeyEnabled &&
                await repository.HasUsedPasskeyCredentialAsync(id, CancellationToken.None),
            "auth.user.recovery-enabled" => user.Status == 0 && user.RecoveryEnabled &&
                await repository.HasActiveRecoveryKeyAsync(id, CancellationToken.None),
            _ => user.Status == 0 && !user.DeletedAt.HasValue
        };
    }

    private async Task<bool> VerifySessionAsync(AuthFixtureVerificationEntity entity)
    {
        UserSession? session = await repository.FindSessionAsync(
            entity.Id,
            CancellationToken.None);
        if (session is null)
        {
            return false;
        }
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        return entity.CapabilityHint switch
        {
            "session.expired" => session.IdleExpiresAt <= now || session.AbsoluteExpiresAt <= now,
            "session.revoked" => session.RevokedAt.HasValue,
            "session.refresh-rotated" => session.RefreshGeneration == 1 && session.RefreshRotatedAtUtc.HasValue,
            "session.remembered" => session.RememberMe &&
                session.DurationPolicy == UserSessionDurationPolicies.Persistent30Days,
            _ => !session.RevokedAt.HasValue && session.IdleExpiresAt > now &&
                session.AbsoluteExpiresAt > now
        };
    }

    private bool ExistingSessionMatches(AuthFixtureRolePlan role, UserSession session)
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        return role.CapabilityId switch
        {
            "session.expired" => session.IdleExpiresAt <= now || session.AbsoluteExpiresAt <= now,
            "session.revoked" => session.RevokedAt.HasValue,
            "session.refresh-rotated" => !session.RevokedAt.HasValue &&
                session.RefreshGeneration == 1 && session.RefreshRotatedAtUtc.HasValue,
            "session.remembered" => !session.RevokedAt.HasValue && session.RememberMe &&
                session.DurationPolicy == UserSessionDurationPolicies.Persistent30Days &&
                session.IdleExpiresAt > now && session.AbsoluteExpiresAt > now,
            _ => !session.RevokedAt.HasValue && session.IdleExpiresAt > now &&
                session.AbsoluteExpiresAt > now
        };
    }

    private async Task<AuthFixtureEntityObservation> ExistingSessionEntityAsync(
        AuthFixtureRolePlan role,
        UserSession session,
        User user,
        CancellationToken cancellationToken)
    {
        if (!UserSessionAuthenticationContext.TryFromSession(
                session,
                out UserSessionAuthenticationContext authentication))
        {
            throw new InvalidOperationException(
                $"owned session role {role.SemanticRole} has invalid authentication projection");
        }
        IssuedAccessToken issued = jwt.GenerateAccessToken(
            user,
            session.SessionId,
            authentication);
        ClaimsPrincipal principal = ReadIssuedPrincipal(issued.Token);
        UserSessionValidationResult validation = await sessionValidation.ValidateAsync(
            principal,
            cancellationToken);
        string state = role.ExpectedState;
        bool claimsMatch = principal.GetUserId() == user.Id &&
            principal.GetSessionId() == session.SessionId &&
            principal.FindFirst("auth_method")?.Value == session.AuthenticationMethod &&
            principal.FindFirst("auth_strength")?.Value == session.AuthenticationStrength;
        var fields = new Dictionary<string, object?>
        {
            ["state"] = state,
            ["live"] = state == "active",
            ["deviceSignal"] = session.DeviceSignalHash,
            ["familyIdentity"] = session.RefreshFamilyId,
            ["rememberMe"] = session.RememberMe,
            ["durationPolicy"] = session.DurationPolicy,
            ["databaseStateVerified"] = true,
            ["claimStateVerified"] = claimsMatch,
            ["cacheStateVerified"] = validation.IsValid == (state is "active" or "rotated")
        };
        if (role.CapabilityId == "session.refresh-rotated")
        {
            fields["oldRefreshAccepted"] = false;
            fields["currentGeneration"] = session.RefreshGeneration;
            fields["currentPointerVerified"] = session.RefreshGeneration == 1;
        }
        return Entity(role, session.SessionId, fields);
    }

    private async Task<bool> VerifyAdminAsync(AuthFixtureVerificationEntity entity)
    {
        if (!long.TryParse(entity.Id, NumberStyles.None, CultureInfo.InvariantCulture, out long id))
        {
            return false;
        }
        AdminPrincipal? admin = await repository.FindAdminByIdAsync(
            id,
            CancellationToken.None);
        if (admin is null || !string.Equals(admin.Handle, entity.FixtureIdentity, StringComparison.Ordinal))
        {
            return false;
        }
        string projection = entity.CapabilityHint switch
        {
            "auth.admin.disabled" => "disabled",
            "auth.admin.full-permission" => "full-permission",
            "auth.admin.partial-permission" => "partial-permission",
            "auth.admin.read-only" => "read-only",
            _ => string.Empty
        };
        if (string.IsNullOrEmpty(projection))
        {
            return false;
        }
        string[] catalog = AdminPermissions.All.Order(StringComparer.Ordinal).ToArray();
        string[] expected = ProjectPermissions(projection, catalog);
        string expectedStatus = projection == "disabled"
            ? AdminPrincipalStatus.Disabled
            : AdminPrincipalStatus.Active;
        return admin.Status == expectedStatus &&
            Permissions(admin.Permissions).SequenceEqual(expected) &&
            AuthorizeProjection(Permissions(admin.Permissions), catalog).Authorized
                .SequenceEqual(expected);
    }

    private async Task<bool> VerifyMultiDeviceAsync(
        IReadOnlyList<AuthFixtureVerificationEntity> entities)
    {
        string[] sessionIds = entities
            .Where(static item => item.CapabilityHint == "session.multi-device")
            .Select(static item => item.Id)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (sessionIds.Length != 2)
        {
            return false;
        }
        IReadOnlyList<UserSession> sessions = await repository.ListSessionsByIdsAsync(
            sessionIds,
            CancellationToken.None);
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        return sessions.Count == 2 &&
            sessions.All(item => !item.RevokedAt.HasValue &&
                item.IdleExpiresAt > now && item.AbsoluteExpiresAt > now) &&
            sessions.Select(static item => item.DeviceSignalHash)
                .Distinct(StringComparer.Ordinal).Count() == 2 &&
            sessions.Select(static item => item.RefreshFamilyId)
                .Distinct(StringComparer.Ordinal).Count() == 2;
    }

    private async Task<bool> VerifyRootEmptyAsync()
        => await repository.CountRootAdminsAsync(CancellationToken.None) == 0;

    private static AuthFixtureEntityObservation Entity(
        AuthFixtureRolePlan role,
        string id,
        IReadOnlyDictionary<string, object?> fields)
        => new(
            role.Kind,
            id,
            true,
            role.CapabilityId,
            PostconditionId(role.CapabilityId),
            role.SemanticRole,
            role.FixtureIdentity,
            fields);

    private static Dictionary<string, object?> BaseUserFields(User user)
        => new()
        {
            ["state"] = user.Status == 2 ? "deleted" : "active",
            ["status"] = user.Status == 2 ? "deleted" : "active",
            ["deleted"] = user.DeletedAt.HasValue,
            ["mfaEnabled"] = user.MfaEnabled,
            ["passkeyEnabled"] = user.PasskeyEnabled,
            ["recoveryEnabled"] = user.RecoveryEnabled,
            ["accountStateVerified"] = true
        };

    private static string SessionState(UserSession session)
    {
        if (session.RevokedAt.HasValue)
        {
            return "revoked";
        }
        return session.IdleExpiresAt <= session.AuthenticatedAtUtc ||
            session.AbsoluteExpiresAt <= session.AuthenticatedAtUtc
            ? "expired"
            : "active";
    }

    private static ClaimsPrincipal ReadIssuedPrincipal(string accessToken)
    {
        JwtSecurityToken token = new JwtSecurityTokenHandler().ReadJwtToken(accessToken);
        return new ClaimsPrincipal(new ClaimsIdentity(
            token.Claims,
            authenticationType: "auth-fixture-issued-token-observation"));
    }

    private static string[] Permissions(string value)
        => value.Split(
            '\n',
            StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Order(StringComparer.Ordinal)
            .ToArray();

    private static (string[] Authorized, string[] Denied) AuthorizeProjection(
        IReadOnlyList<string> permissionIds,
        IReadOnlyList<string> catalog)
    {
        var identity = new ClaimsIdentity(permissionIds.Select(permissionId =>
            new Claim(AdminPermissions.PermissionClaimType, permissionId)),
            authenticationType: "auth-fixture-production-policy");
        var principal = new ClaimsPrincipal(identity);
        string[] authorized = catalog
            .Where(principal.HasAdminPermission)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] denied = catalog
            .Where(permissionId => !principal.HasAdminPermission(permissionId))
            .Order(StringComparer.Ordinal)
            .ToArray();
        return (authorized, denied);
    }

    private static string[] ProjectPermissions(
        string? projection,
        IReadOnlyList<string> catalog)
        => projection switch
        {
            "full-permission" => [.. catalog],
            "read-only" => catalog.Where(static item =>
                item.EndsWith(".read", StringComparison.Ordinal) ||
                item.EndsWith(".investigate", StringComparison.Ordinal)).ToArray(),
            "partial-permission" => [AdminPermissions.ArticleWrite],
            "disabled" => [],
            _ => throw new InvalidOperationException(
                $"unknown admin permission projection {projection}")
        };

    private static string PermissionCatalogDigest()
        => Digest(AdminPermissions.All.Order(StringComparer.Ordinal));

    private static string Digest(object value)
        => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value)));

    private static void RequireSingleTransition(int count, string role)
    {
        if (count != 1)
        {
            throw new InvalidOperationException(
                $"fixture transition {role} expected one owned row, got {count}");
        }
    }

    private void RequireTestOnly()
    {
        if (!environment.IsDevelopment() && !environment.IsEnvironment("Test"))
        {
            throw new InvalidOperationException(
                "auth fixture lifecycle ports are unavailable outside Development/Test");
        }
    }

    private static void ValidatePlan(AuthFixturePlan request)
    {
        string expectedOwner = $"{ProducerId}:{request.Namespace}:{request.RunId}";
        string[] capabilities = request.Capabilities
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (request.Schema != Schema || request.Strategy != Strategy ||
            request.ProducerId != ProducerId ||
            string.IsNullOrWhiteSpace(request.Namespace) ||
            string.IsNullOrWhiteSpace(request.RunId) ||
            string.IsNullOrWhiteSpace(request.ProfileId) ||
            string.IsNullOrWhiteSpace(request.CatalogDigest) ||
            string.IsNullOrWhiteSpace(request.FixtureVariantPlanDigest) ||
            string.IsNullOrWhiteSpace(request.ProducerVariantPlanDigest) ||
            string.IsNullOrWhiteSpace(request.PlanDigest) ||
            request.Roles.Count == 0 ||
            request.Capabilities.Distinct(StringComparer.Ordinal).Count() !=
                request.Capabilities.Count ||
            !request.Capabilities.SequenceEqual(capabilities) ||
            request.Capabilities.Any(capability => request.Roles.Count(item =>
                item.CapabilityId == capability &&
                item.AllocationConsumerProducerId is null) != 1) ||
            request.Roles.Select(static item => item.SemanticRole).Distinct(StringComparer.Ordinal).Count()
                != request.Roles.Count ||
            request.Roles.Select(static item => item.FixtureIdentity).Distinct(StringComparer.Ordinal).Count()
                != request.Roles.Count ||
            request.Roles.Any(static item =>
                item.CapabilityId.StartsWith("security.", StringComparison.Ordinal)) ||
            request.Roles.Any(item =>
                !string.Equals(item.OwnerIdentity, expectedOwner, StringComparison.Ordinal) ||
                (item.AllocationConsumerProducerId is null
                    ? !MatchesExpectedRole(item)
                    : !MatchesAllocatedRole(item))))
        {
            throw new InvalidOperationException("auth fixture plan is invalid or crosses owner boundaries");
        }
    }

    private static bool MatchesAllocatedRole(AuthFixtureRolePlan role)
    {
        if (string.IsNullOrWhiteSpace(role.AllocationConsumerProducerId) ||
            string.IsNullOrWhiteSpace(role.AllocationRole) ||
            role.SemanticRole !=
                $"consumer.{role.AllocationConsumerProducerId}.{role.AllocationRole}" ||
            string.IsNullOrWhiteSpace(role.FixtureIdentity))
        {
            return false;
        }
        return role.CapabilityId switch
        {
            "auth.user.active" => role.Kind == "user" &&
                role.ExpectedState == "active",
            "auth.admin.full-permission" => role.Kind == "admin" &&
                role.ExpectedState == "active" &&
                role.PermissionProjection == "full-permission",
            _ => false
        };
    }

    private static bool MatchesExpectedRole(AuthFixtureRolePlan role)
    {
        (string Kind, string SemanticRole, string State) expected = role.CapabilityId switch
        {
            "auth.admin.disabled" => ("admin", "admin.disabled", "disabled"),
            "auth.admin.full-permission" => ("admin", "admin.full-permission", "active"),
            "auth.admin.partial-permission" => ("admin", "admin.partial-permission", "active"),
            "auth.admin.read-only" => ("admin", "admin.read-only", "active"),
            "auth.admin.root-bootstrap-empty" => ("admin-root-set", "admin.root-bootstrap-empty", "empty"),
            "auth.user.active" => ("user", "user.active", "active"),
            "auth.user.deleted" => ("user", "user.deleted", "deleted"),
            "auth.user.mfa-disabled" => ("user", "user.mfa-disabled", "active"),
            "auth.user.mfa-enabled" => ("user", "user.mfa-enabled", "active"),
            "auth.user.passkey-enabled" => ("user", "user.passkey-enabled", "active"),
            "auth.user.recovery-enabled" => ("user", "user.recovery-enabled", "active"),
            "session.expired" => ("session", "session.expired", "expired"),
            "session.multi-device" => ("session", "session.multi-device", "active"),
            "session.refresh-rotated" => ("session", "session.refresh-rotated", "rotated"),
            "session.remembered" => ("session", "session.remembered", "active"),
            "session.revoked" => ("session", "session.revoked", "revoked"),
            "session.single-device" => ("session", "session.single-device", "active"),
            _ => (string.Empty, string.Empty, string.Empty)
        };
        return !string.IsNullOrEmpty(expected.Kind) &&
            role.Kind == expected.Kind &&
            role.SemanticRole == expected.SemanticRole &&
            role.ExpectedState == expected.State &&
            !string.IsNullOrWhiteSpace(role.FixtureIdentity) &&
            (role.Kind != "session" ||
                (!string.IsNullOrWhiteSpace(role.SubjectFixtureIdentity) &&
                 !string.IsNullOrWhiteSpace(role.SubjectRole) &&
                 role.SessionIdentities is { Count: > 0 } &&
                 role.FamilyIdentities is { Count: > 0 } &&
                 role.DeviceSignals is { Count: > 0 }));
    }

    private static string PostconditionId(string capabilityId)
        => capabilityId switch
        {
            "auth.admin.disabled" => "admin-disabled",
            "auth.admin.full-permission" => "admin-full-permission",
            "auth.admin.partial-permission" => "admin-partial-permission",
            "auth.admin.read-only" => "admin-read-only",
            "auth.admin.root-bootstrap-empty" => "admin-root-bootstrap-empty",
            "auth.user.active" => "user-active",
            "auth.user.deleted" => "user-deleted",
            "auth.user.mfa-disabled" => "user-mfa-disabled",
            "auth.user.mfa-enabled" => "user-mfa-enabled",
            "auth.user.passkey-enabled" => "user-passkey-enabled",
            "auth.user.recovery-enabled" => "user-recovery-enabled",
            "session.expired" => "session-expired",
            "session.multi-device" => "session-multi-device",
            "session.refresh-rotated" => "session-refresh-rotated",
            "session.remembered" => "session-remembered",
            "session.revoked" => "session-revoked",
            "session.single-device" => "session-single-device",
            _ => throw new InvalidOperationException($"unknown auth fixture capability {capabilityId}")
        };

    private static string ComputeTotp(string secret, DateTimeOffset instant)
    {
        byte[] key = DecodeBase32(secret);
        long step = instant.ToUnixTimeSeconds() / 30;
        Span<byte> counter = stackalloc byte[8];
        for (int index = counter.Length - 1; index >= 0; index--)
        {
            counter[index] = (byte)step;
            step >>= 8;
        }
        byte[] hash = HMACSHA1.HashData(key, counter);
        int offset = hash[^1] & 0x0F;
        int binary = ((hash[offset] & 0x7F) << 24) |
            (hash[offset + 1] << 16) |
            (hash[offset + 2] << 8) |
            hash[offset + 3];
        return (binary % 1_000_000).ToString("D6", CultureInfo.InvariantCulture);
    }

    private static byte[] DecodeBase32(string value)
    {
        const string Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        string normalized = value.Trim().TrimEnd('=').ToUpperInvariant();
        var bytes = new List<byte>();
        int buffer = 0;
        int bits = 0;
        foreach (char item in normalized)
        {
            int index = Alphabet.IndexOf(item);
            if (index < 0)
            {
                throw new InvalidOperationException("controlled TOTP secret is invalid");
            }
            buffer = (buffer << 5) | index;
            bits += 5;
            if (bits >= 8)
            {
                bytes.Add((byte)(buffer >> (bits - 8)));
                bits -= 8;
                buffer &= (1 << bits) - 1;
            }
        }
        return bytes.ToArray();
    }
}
