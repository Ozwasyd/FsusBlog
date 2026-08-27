using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using Fido2NetLib;
using Fido2NetLib.Objects;

using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthFixtureCompositionRootTests
{
    private const string FixtureSecret = "auth-fixture-composition-root-test-secret";
    private const string SecretHeader = "X-Fsus-Local-Auth-Fixture-Secret";

    [Theory]
    [InlineData("Production", "true", false)]
    [InlineData("Development", null, false)]
    [InlineData("Development", "false", false)]
    [InlineData("Development", "true", true)]
    public async Task LifecycleRoutes_AreUnavailableOutsideExplicitDevelopmentGate(
        string environmentName,
        string? enabled,
        bool expected)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(
            new WebApplicationOptions { EnvironmentName = environmentName });
        if (enabled is not null)
        {
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                [LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey] = enabled
            });
        }

        await using WebApplication app = builder.Build();
        app.MapLocalAuthFixtureEndpoints();
        string[] routes = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Select(static endpoint => endpoint.RoutePattern.RawText ?? string.Empty)
            .ToArray();

        Assert.Equal(
            expected,
            routes.Contains("/api/local/auth-fixture/prepare", StringComparer.Ordinal));
        Assert.Equal(
            expected,
            routes.Contains("/api/local/auth-fixture/verify", StringComparer.Ordinal));
    }

    [Fact]
    public async Task Prepare_RequiresLoopbackAndSecretBeforeCallingLifecyclePort()
    {
        IAuthFixtureSeeder seeder = Substitute.For<IAuthFixtureSeeder>();
        await using WebApplication app = await CreateAppAsync(seeder, IPAddress.Loopback);
        HttpClient client = app.GetTestClient();

        using HttpResponseMessage missingSecret = await client.PostAsJsonAsync(
            "/api/local/auth-fixture/prepare",
            Plan());
        Assert.Equal(HttpStatusCode.Unauthorized, missingSecret.StatusCode);
        await seeder.DidNotReceiveWithAnyArgs().PrepareAsync(default!, default);

        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/local/auth-fixture/prepare")
        {
            Content = JsonContent.Create(Plan())
        };
        request.Headers.Add(SecretHeader, FixtureSecret);
        using HttpResponseMessage accepted = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        await seeder.Received(1).PrepareAsync(
            Arg.Is<AuthFixturePlan>(plan =>
                plan.ProducerId == "auth-session" &&
                plan.Roles.Single().SemanticRole == "user.active"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Prepare_ReturnsNotFoundForNonLoopbackAndDoesNotMutate()
    {
        IAuthFixtureSeeder seeder = Substitute.For<IAuthFixtureSeeder>();
        await using WebApplication app = await CreateAppAsync(
            seeder,
            IPAddress.Parse("192.0.2.15"));
        var request = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/local/auth-fixture/prepare")
        {
            Content = JsonContent.Create(Plan())
        };
        request.Headers.Add(SecretHeader, FixtureSecret);

        using HttpResponseMessage response = await app.GetTestClient().SendAsync(request);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        await seeder.DidNotReceiveWithAnyArgs().PrepareAsync(default!, default);
    }

    [Fact]
    public async Task Verify_UsesIndependentReadPortAndEchoesBoundDigest()
    {
        IAuthFixtureSeeder seeder = Substitute.For<IAuthFixtureSeeder>();
        await using WebApplication app = await CreateAppAsync(seeder, IPAddress.Loopback);
        var request = new HttpRequestMessage(
            HttpMethod.Post,
            "/api/local/auth-fixture/verify")
        {
            Content = JsonContent.Create(new AuthFixtureVerificationRequest(
                "a".PadLeft(64, 'a'),
                "b".PadLeft(64, 'b'),
                ["auth.user.active"],
                [new(
                    "user",
                    "17",
                    "user.active",
                    "fxauth-owned",
                    "auth.user.active")]))
        };
        request.Headers.Add(SecretHeader, FixtureSecret);

        using HttpResponseMessage response = await app.GetTestClient().SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await seeder.Received(1).VerifyAsync(
            Arg.Is<AuthFixtureVerificationRequest>(item =>
                item.EntityIdentities.Single().CapabilityHint == "auth.user.active"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ControlledAuthenticator_ProducesBoundEs256RegistrationAndAssertion()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Fido2:Origins:0"] = "http://localhost:5173"
            })
            .Build();
        using var authenticator = new ControlledWebAuthnAuthenticator(configuration);
        byte[] registrationChallenge = Enumerable.Range(1, 32).Select(static value => (byte)value).ToArray();
        var registrationOptions = new PasskeyRegisterBeginCoreModel
        {
            SessionKey = "registration-session",
            RpId = "localhost",
            Challenge = registrationChallenge,
            AccountHandle = Enumerable.Repeat((byte)0xA5, 32).ToArray(),
            PubKeyCredParams = [new(0, -7)]
        };

        PasskeyRegisterCompleteCoreModel registration = await authenticator
            .CreateRegistrationAsync(
                registrationOptions,
                "fxauth-controlled",
                CancellationToken.None);

        Assert.Equal("registration-session", registration.SessionKey);
        Assert.Equal(32, registration.RawId.Length);
        Assert.NotEmpty(registration.AttestationObject);
        using JsonDocument registrationClientData = JsonDocument.Parse(registration.ClientDataBytes);
        Assert.Equal(
            "webauthn.create",
            registrationClientData.RootElement.GetProperty("type").GetString());
        Assert.Equal(
            "http://localhost:5173",
            registrationClientData.RootElement.GetProperty("origin").GetString());

        byte[] assertionChallenge = Enumerable.Range(33, 32).Select(static value => (byte)value).ToArray();
        var assertionOptions = new PasskeyLoginBeginCoreModel
        {
            ChallengeToken = "assertion-session",
            RpId = "localhost",
            Challenge = assertionChallenge,
            AllowCredentials = [new(0, registration.RawId, [])]
        };
        PasskeyLoginCompleteCoreModel assertion = await authenticator.CreateAssertionAsync(
            assertionOptions,
            "fxauth-controlled",
            CancellationToken.None);

        Assert.Equal(registration.RawId, assertion.RawId);
        Assert.NotEmpty(assertion.Signature);
        Assert.Equal(37, assertion.AuthenticatorData.Length);
        Assert.Equal(1u, System.Buffers.Binary.BinaryPrimitives.ReadUInt32BigEndian(
            assertion.AuthenticatorData.AsSpan(33, 4)));
        using JsonDocument assertionClientData = JsonDocument.Parse(assertion.ClientDataBytes);
        Assert.Equal(
            "webauthn.get",
            assertionClientData.RootElement.GetProperty("type").GetString());
    }

    [Fact]
    public async Task ControlledAuthenticator_RejectsCrossIdentityAndUnsupportedAlgorithm()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Fido2:Origins:0"] = "http://localhost:5173"
            })
            .Build();
        using var authenticator = new ControlledWebAuthnAuthenticator(configuration);
        var unsupported = new PasskeyRegisterBeginCoreModel
        {
            SessionKey = "registration-session",
            RpId = "localhost",
            Challenge = new byte[32],
            AccountHandle = new byte[32],
            PubKeyCredParams = [new(0, -257)]
        };
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            authenticator.CreateRegistrationAsync(
                unsupported,
                "fxauth-controlled",
                CancellationToken.None));

        var assertion = new PasskeyLoginBeginCoreModel
        {
            ChallengeToken = "assertion-session",
            RpId = "localhost",
            Challenge = new byte[32],
            AllowCredentials = [new(0, new byte[32], [])]
        };
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            authenticator.CreateAssertionAsync(
                assertion,
                "fxauth-other",
                CancellationToken.None));
    }

    [Fact]
    public async Task ControlledAuthenticator_PassesProductionFidoRegistrationAndAssertionValidation()
    {
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
        byte[] userHandle = Enumerable.Repeat((byte)0x5A, 32).ToArray();
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
                "fxauth-production-fido",
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
                IsCredentialIdUniqueToUserCallback = static (_, _) => Task.FromResult(true)
            },
            CancellationToken.None);

        AssertionOptions originalAssertion = fido.GetAssertionOptions(
            new GetAssertionOptionsParams
            {
                AllowedCredentials = [new PublicKeyCredentialDescriptor(credential.Id)],
                UserVerification = UserVerificationRequirement.Required
            });
        var assertionCore = new PasskeyLoginBeginCoreModel
        {
            ChallengeToken = "assertion-session",
            Timeout = originalAssertion.Timeout,
            RpId = originalAssertion.RpId!,
            UserVerification = (int?)originalAssertion.UserVerification,
            Challenge = originalAssertion.Challenge,
            AllowCredentials = [new(0, credential.Id, [])]
        };
        PasskeyLoginCompleteCoreModel assertion = await authenticator.CreateAssertionAsync(
            assertionCore,
            "fxauth-production-fido",
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
                IsUserHandleOwnerOfCredentialIdCallback = static (_, _) => Task.FromResult(true)
            });
        Assert.Equal(1u, verified.SignCount);
    }

    private static AuthFixturePlan Plan()
    {
        using JsonDocument temporal = JsonDocument.Parse(
            """
            {"schema":"fsusblog.test-temporal-context.v1","producerId":"auth-session"}
            """);
        using JsonDocument resolvedTemporalRoles = JsonDocument.Parse(
            """
            {
              "schema":"fsusblog.resolved-temporal-roles.v1",
              "contextIdentity":{"producerId":"auth-session","schedulerRunId":"run-17"},
              "roles":[{
                "roleId":"session.created",
                "clockKind":"business-wall",
                "semanticEffect":"included",
                "precision":"millisecond",
                "instantUtc":"2024-02-29T23:59:59.000Z"
              }],
              "contentDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
            """);
        return new AuthFixturePlan
        {
            Schema = "fsusblog.auth-session-fixture-plan.v1",
            Strategy = "transaction-fixture",
            ProducerId = "auth-session",
            Namespace = "auth-fixture-tests",
            RunId = "run-17",
            ProfileId = "auth-identity-matrix",
            CatalogDigest = "sha256:catalog",
            FixtureVariantPlanDigest = "sha256:fixture-variants",
            ProducerVariantPlanDigest = "sha256:producer-variants",
            Capabilities = ["auth.user.active"],
            Roles =
            [
                new AuthFixtureRolePlan
                {
                    CapabilityId = "auth.user.active",
                    SemanticRole = "user.active",
                    Kind = "user",
                    ExpectedState = "active",
                    FixtureIdentity = "fxauth-owned",
                    OwnerIdentity = "auth-session:auth-fixture-tests:run-17"
                }
            ],
            TemporalContext = temporal.RootElement.Clone(),
            ResolvedTemporalRoles = resolvedTemporalRoles.RootElement.Clone(),
            PlanDigest = "c".PadLeft(64, 'c')
        };
    }

    private static async Task<WebApplication> CreateAppAsync(
        IAuthFixtureSeeder seeder,
        IPAddress remoteAddress)
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder(
            new WebApplicationOptions { EnvironmentName = Environments.Development });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            [LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey] = "true",
            [LocalAuthFixtureEndpoints.LocalAuthFixtureSecretConfigurationKey] = FixtureSecret
        });
        builder.Services.AddSingleton(seeder);
        seeder.PrepareAsync(Arg.Any<AuthFixturePlan>(), Arg.Any<CancellationToken>())
            .Returns(call => Prepared(call.Arg<AuthFixturePlan>()));
        seeder.VerifyAsync(
                Arg.Any<AuthFixtureVerificationRequest>(),
                Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                AuthFixtureVerificationRequest value = call.Arg<AuthFixtureVerificationRequest>();
                return new AuthFixtureVerificationResult(true, value.ReceiptDigest);
            });

        WebApplication app = builder.Build();
        app.Use(async (context, next) =>
        {
            context.Connection.RemoteIpAddress = remoteAddress;
            await next();
        });
        app.MapLocalAuthFixtureEndpoints();
        await app.StartAsync();
        return app;
    }

    private static AuthFixturePrepareResult Prepared(AuthFixturePlan plan)
        => new(
            "auth-session",
            "transaction-fixture",
            "test",
            plan.PlanDigest,
            plan.Capabilities,
            new AuthFixtureObservations(
                "application-read-model",
                new AuthFixtureDatabaseObservation(plan.Namespace, "public", []),
                new AuthFixtureRedisObservation(plan.Namespace, []),
                new AuthFixtureCacheObservation(plan.Namespace, [])),
            "d".PadLeft(64, 'd'),
            null,
            new
            {
                businessEpochUtc = "2024-02-29T23:59:59.000Z"
            });
}
