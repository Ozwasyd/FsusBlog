using System.Buffers.Binary;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MessagingFixtureTransportContractTests
{
    private const string ValidPlan = """
        {
          "schema": "fsusblog.messaging-fixture-plan.v1",
          "producerId": "account-messaging",
          "strategy": "transaction-fixture",
          "runId": "run-1",
          "namespace": "namespace-1",
          "capabilities": ["messages.empty"],
          "identityReferences": {
            "primaryRecipientId": "101",
            "secondaryRecipientId": "102",
            "emptyRecipientId": "103",
            "adminId": "7",
            "adminActorAuditKey": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "identityProducerResultDigest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            "prepareReferenceDigests": [
              "1111111111111111111111111111111111111111111111111111111111111111",
              "2222222222222222222222222222222222222222222222222222222222222222",
              "3333333333333333333333333333333333333333333333333333333333333333",
              "4444444444444444444444444444444444444444444444444444444444444444"
            ]
          },
          "semanticRoles": [],
          "temporalRoles": {
            "schema": "fsusblog.resolved-temporal-roles.v1",
            "shape": { "id": "auth-security-messaging-account-lifecycle" },
            "contentDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          },
          "inventoryDigest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          "ownershipDigest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
          "planDigest": "sha256:3333333333333333333333333333333333333333333333333333333333333333"
        }
        """;

    [Fact]
    public void MessagingPlan_IsClosedAndRejectsDirectStorageOrFallbackControls()
    {
        string mutated = ValidPlan.Replace(
            "\"planDigest\"",
            "\"directSql\": true, \"mockStream\": true, \"planDigest\"",
            StringComparison.Ordinal);

        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<MessagingFixturePlan>(
                mutated,
                LocalMessagingFixtureEndpoints.s_json));
    }

    [Fact]
    public void MessagingPlan_BindsPrepareIdentityAndTemporalArtifacts()
    {
        MessagingFixturePlan? plan = JsonSerializer.Deserialize<MessagingFixturePlan>(
            ValidPlan,
            LocalMessagingFixtureEndpoints.s_json);

        Assert.NotNull(plan);
        Assert.Equal("fsusblog.messaging-fixture-plan.v1", plan.Schema);
        Assert.Equal("account-messaging", plan.ProducerId);
        Assert.Equal("101", plan.IdentityReferences.PrimaryRecipientId);
        Assert.Equal("fsusblog.resolved-temporal-roles.v1", plan.TemporalRoles.GetProperty("schema").GetString());
    }

    [Fact]
    public void MessagingOrdinaryResultTypes_DoNotExposeMessageOrNotificationPayload()
    {
        string[] properties = typeof(MessagingFixtureResult)
            .GetProperties()
            .Select(static item => item.Name)
            .Concat(typeof(MessagingFixtureEntityIdentity).GetProperties().Select(static item => item.Name))
            .Concat(typeof(MessagingFixtureCleanupReceipt).GetProperties().Select(static item => item.Name))
            .ToArray();

        Assert.DoesNotContain(properties, static name =>
            name.Contains("Body", StringComparison.Ordinal)
            || name.Contains("Payload", StringComparison.Ordinal)
            || name.Contains("Token", StringComparison.Ordinal)
            || name.Contains("SessionId", StringComparison.Ordinal));
    }

    [Fact]
    public void MessagingCleanupReceipt_PreservesInt64IdentitiesAsCanonicalStrings()
    {
        const string Json = """
            {
              "schema": "fsusblog.messaging-fixture-cleanup.v1",
              "planDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "runId": "run-1",
              "namespace": "namespace-1",
              "ownedEntityIds": ["9223372036854775806", "9223372036854775807"],
              "conversationIds": ["9223372036854775806"],
              "messageIds": ["9223372036854775807"],
              "eventIds": ["9007199254740993"],
              "deliveryKeys": ["fixture-delivery"]
            }
            """;

        MessagingFixtureCleanupReceipt? receipt = JsonSerializer.Deserialize<MessagingFixtureCleanupReceipt>(
            Json,
            LocalMessagingFixtureEndpoints.s_json);

        Assert.NotNull(receipt);
        Assert.Equal("9223372036854775806", Assert.Single(receipt.ConversationIds));
        Assert.Equal("9007199254740993", Assert.Single(receipt.EventIds));
        Assert.Contains("\"9223372036854775807\"", JsonSerializer.Serialize(receipt), StringComparison.Ordinal);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<MessagingFixtureCleanupReceipt>(
            Json.Replace("\"9007199254740993\"", "9007199254740993", StringComparison.Ordinal),
            LocalMessagingFixtureEndpoints.s_json));
    }

    [Fact]
    public void MessagingSeeder_DependsOnProductionPortsInsteadOfStorageWriters()
    {
        Type[] dependencies = typeof(MessagingFixtureSeeder)
            .GetConstructors()
            .Single()
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();

        Assert.Contains(typeof(IMessageCommandService), dependencies);
        Assert.Contains(typeof(IMessageQueryService), dependencies);
        Assert.Contains(typeof(IMessageAdminQueueMaintenance), dependencies);
        Assert.Contains(typeof(IMessageMutationOutboxDelivery), dependencies);
        Assert.DoesNotContain(dependencies, static type => type.Name.Contains("Mock", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("directSql")]
    [InlineData("repairCache")]
    [InlineData("skipAuthOwner")]
    [InlineData("mockStream")]
    public void MessagingVerifyEnvelope_IsClosed(string forbiddenField)
    {
        string json = "{\"" + forbiddenField + "\":true}";
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<MessagingFixtureVerificationRequest>(
            json, LocalMessagingFixtureEndpoints.s_json));
    }

    [Fact]
    public void MessagingVerifyEnvelope_KeepsSourceAndServiceBindingExplicit()
    {
        string[] properties = typeof(MessagingFixtureVerificationBinding).GetProperties()
            .Select(static property => property.Name).Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(new[] { "CatalogDigest", "ExpandedCapabilityDigest", "Namespace", "ProducerVariantPlanDigest",
            "ProfileId", "RunId", "ServiceGeneration", "SourceCommit", "SourceFingerprint", "TemporalContextDigest", "VariantPlanDigest" }, properties);
        Assert.Throws<ArgumentNullException>(() => MessagingFixtureSeeder.ValidateVerificationAuthority(null!));
    }

    [Fact]
    public async Task MessagingVerify_AlreadyCancelledDoesNotReadOrRepair()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var seeder = new MessagingFixtureSeeder(null!, null!, null!, null!, null!, null!, null!, TimeProvider.System, null!);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            seeder.VerifyAsync(null!, null!, null!, cancellation.Token));
    }

    [Theory]
    [InlineData("run")]
    [InlineData("namespace")]
    [InlineData("source")]
    [InlineData("fingerprint")]
    [InlineData("service")]
    [InlineData("profile-missing")]
    [InlineData("catalog")]
    [InlineData("capability")]
    [InlineData("variant")]
    [InlineData("producer-variant")]
    [InlineData("temporal")]
    public void MessagingCurrentBinding_RejectsUnitModelCrossIdentityBeforeAnyRead(string field)
    {
        MessagingFixturePlan plan = JsonSerializer.Deserialize<MessagingFixturePlan>(ValidPlan, LocalMessagingFixtureEndpoints.s_json)!;
        string digest = "sha256:" + new string('b', 64);
        var binding = new MessagingFixtureVerificationBinding("run-1", "namespace-1", "unit-profile", new string('a', 40),
            digest, digest, digest, digest, digest, digest, digest);
        void Require(MessagingFixtureVerificationBinding value) => MessagingFixtureSeeder.RequireCurrentBinding(
            value, plan, binding.RunId, binding.Namespace, binding.SourceCommit, binding.SourceFingerprint, binding.ServiceGeneration);
        Require(binding);
        MessagingFixtureVerificationBinding wrong = field switch
        {
            "run" => binding with { RunId = "foreign" },
            "namespace" => binding with { Namespace = "foreign" },
            "source" => binding with { SourceCommit = new string('f', 40) },
            "fingerprint" => binding with { SourceFingerprint = "sha256:" + new string('f', 64) },
            "service" => binding with { ServiceGeneration = "sha256:" + new string('f', 64) },
            "profile-missing" => binding with { ProfileId = "" },
            "catalog" => binding with { CatalogDigest = "invalid" },
            "capability" => binding with { ExpandedCapabilityDigest = "invalid" },
            "variant" => binding with { VariantPlanDigest = "invalid" },
            "producer-variant" => binding with { ProducerVariantPlanDigest = "invalid" },
            _ => binding with { TemporalContextDigest = "invalid" }
        };
        Assert.Throws<InvalidOperationException>(() => Require(wrong));
        Assert.Throws<InvalidOperationException>(() => MessagingFixtureSeeder.RequireCurrentBinding(
            binding, plan, null, null, null, null, null));
    }

    [Theory]
    [InlineData("valid")]
    [InlineData("missing")]
    [InlineData("reversed")]
    [InlineData("duplicate")]
    [InlineData("foreign")]
    [InlineData("crc")]
    [InlineData("type")]
    [InlineData("short")]
    [InlineData("failed")]
    [InlineData("gap")]
    public void MessagingReadonlyReplay_UsesCanonicalDecoderAndExactOrderedIdentities(string mutation)
    {
        var decoder = new AedsEncoder();
        long[] ids = mutation switch
        {
            "missing" => [101],
            "reversed" => [102, 101],
            "duplicate" => [101, 101],
            "foreign" => [101, 103],
            _ => [101, 102]
        };
        var frames = new List<SharedNotificationStreamFrame>();
        foreach (long id in ids)
        {
            byte[] payload = new byte[mutation == "short" ? 8 : 24];
            BinaryPrimitives.WriteInt64LittleEndian(payload, id);
            byte[] bytes = decoder.Encode(mutation == "type" ? AedsFrameType.EmptySuccess : AedsFrameType.NotificationEvent, payload);
            if (mutation == "crc")
            {
                bytes[^1] ^= 1;
            }
            frames.Add(SharedNotificationStreamFrame.FromArray(bytes));
        }
        var replay = new NotificationStreamReplayBatch(frames, mutation == "gap", mutation == "failed");
        try
        {
            if (mutation == "valid")
            {
                MessagingFixtureSeeder.RequireReadonlyReplay(replay, [101, 102], decoder);
            }
            else
            {
                Assert.Throws<InvalidOperationException>(() => MessagingFixtureSeeder.RequireReadonlyReplay(replay, [101, 102], decoder));
            }
            Assert.Throws<InvalidOperationException>(() => MessagingFixtureSeeder.RequireReadonlyReplay(replay, [101, 102], null));
        }
        finally
        {
            foreach (SharedNotificationStreamFrame frame in frames)
            {
                frame.Release();
            }
        }
    }

    [Theory]
    [InlineData("success", 200)]
    [InlineData("production", 404)]
    [InlineData("disabled", 404)]
    [InlineData("remote", 404)]
    [InlineData("secret", 401)]
    [InlineData("header", 400)]
    [InlineData("auth-missing", 400)]
    [InlineData("unknown-field", 400)]
    [InlineData("verifier-failure", 400)]
    public async Task MessagingVerifyGateway_UsesExistingGuardsAndScopedOwnersWithTransportModels(string variant, int expectedStatus)
    {
        // Actual route/filter controls with substitute ports; not DB/Redis/runtime qualification.
        var seeder = Substitute.For<IMessagingFixtureSeeder>();
        var auth = Substitute.For<IAuthFixtureSeeder>();
        var decoder = new AedsEncoder();
        MessagingFixturePlan plan = JsonSerializer.Deserialize<MessagingFixturePlan>(ValidPlan, LocalMessagingFixtureEndpoints.s_json)!;
        string digest = "sha256:" + new string('b', 64);
        var binding = new MessagingFixtureVerificationBinding(plan.RunId, plan.Namespace, "unit-profile", new string('a', 40),
            digest, digest, digest, digest, digest, digest, digest);
        using JsonDocument empty = JsonDocument.Parse("{}");
        var cleanup = new MessagingFixtureCleanupReceipt("fsusblog.messaging-fixture-cleanup.v1", plan.PlanDigest,
            plan.RunId, plan.Namespace, [], [], [], [], []);
        var body = new MessagingFixtureVerificationRequest(plan, binding, cleanup, new Dictionary<string, string>(),
            new(empty.RootElement, "{}"), empty.RootElement);
        int reads = 0;
        seeder.VerifyAsync(Arg.Any<MessagingFixtureVerificationRequest>(), auth, decoder, Arg.Any<CancellationToken>())
            .Returns(call =>
            {
                reads++;
                MessagingFixtureVerificationRequest supplied = call.Arg<MessagingFixtureVerificationRequest>();
                Assert.Equal(binding, supplied.Binding);
                Assert.Equal(plan.RunId, supplied.Plan.RunId);
                Assert.Equal(plan.Namespace, supplied.Plan.Namespace);
                if (variant == "verifier-failure")
                {
                    throw new InvalidOperationException("unit-private-diagnostic-never-published");
                }
                var observed = new MessagingFixtureObservations(new(plan.Namespace, "public", []),
                    new(plan.Namespace, []), new(plan.Namespace, []));
                var result = new MessagingFixtureResult("account-messaging", "transaction-fixture", plan.PlanDigest,
                    plan.InventoryDigest, plan.OwnershipDigest, [], [], observed, cleanup, new
                    {
                        unitModel = true
                    });
                return Task.FromResult(new MessagingFixtureVerificationResult(true, binding, digest, result, []));
            });
        WebApplicationBuilder builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = variant == "production" ? "Production" : "Development"
        });
        builder.WebHost.UseTestServer();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            [LocalMessagingFixtureEndpoints.AllowConfigurationKey] = variant == "disabled" ? "false" : "true",
            [LocalAuthFixtureEndpoints.AllowLocalAuthFixtureConfigurationKey] = "false",
            [LocalMessagingFixtureEndpoints.SecretConfigurationKey] = "unit-fixture-secret"
        });
        builder.Services.AddSingleton(seeder);
        builder.Services.AddSingleton<IAedsEncoder>(decoder);
        if (variant != "auth-missing")
        {
            builder.Services.AddSingleton(auth);
        }
        await using WebApplication app = builder.Build();
        app.Use(async (context, next) =>
        {
            context.Connection.RemoteIpAddress = IPAddress.Parse(variant == "remote" ? "192.0.2.8" : "127.0.0.1");
            await next();
        });
        app.MapLocalMessagingFixtureEndpoints();
        app.MapFallback(() => Microsoft.AspNetCore.Http.Results.NotFound());
        await app.StartAsync();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/local/messaging-fixture/verify")
        {
            Content = variant == "unknown-field" ? JsonContent.Create(new { directSql = true }) : JsonContent.Create(body)
        };
        request.Headers.Host = "fsus.blog";
        request.Headers.Add(LocalMessagingFixtureEndpoints.SecretHeaderName, variant == "secret" ? "wrong" : "unit-fixture-secret");
        request.Headers.Add(LocalPublicContentFixtureEndpoints.TestRunIdHeaderName, variant == "header" ? "foreign" : plan.RunId);
        request.Headers.Add(LocalPublicContentFixtureEndpoints.TestNamespaceHeaderName, plan.Namespace);
        using HttpResponseMessage response = await app.GetTestClient().SendAsync(request);
        Assert.Equal((HttpStatusCode)expectedStatus, response.StatusCode);
        Assert.Equal(variant is "success" or "verifier-failure" ? 1 : 0, reads);
        Assert.DoesNotContain("unit-private-diagnostic-never-published", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        await seeder.DidNotReceive().PrepareAsync(Arg.Any<MessagingFixturePlan>(), Arg.Any<CancellationToken>());
        await seeder.DidNotReceive().CleanupAsync(Arg.Any<MessagingFixtureCleanupReceipt>(), Arg.Any<CancellationToken>());
    }
}
