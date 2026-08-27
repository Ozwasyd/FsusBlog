using System.Text.Json;

using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Fixtures;

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
        Assert.DoesNotContain(dependencies, static type => type.Name.Contains("Mock", StringComparison.Ordinal));
    }
}
