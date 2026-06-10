using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.NotificationStream;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
public sealed class CoreRuntimeIntegrationTests
{
    [Fact]
    public void AuthPipeline_JwtHelper_ProducesTokenWithSessionAndMfaClaims()
    {
        var settings = new JwtSettings
        {
            SecretKey = "integration-test-secret-key-with-at-least-thirty-two-chars",
            Issuer = "fsusblog-tests",
            Audience = "fsusblog-tests",
            AccessTokenExpiresMinutes = 10
        };
        var helper = new JwtHelper(Options.Create(settings));
        var user = new User { Id = 42, Username = "integration-user", Role = "admin" };

        string token = helper.GenerateAccessToken(user, "session-1", mfaVerified: true);
        var jwt = new JwtSecurityTokenHandler().ReadJwtToken(token);

        Assert.Equal("42", jwt.Claims.First(c => c.Type == ClaimTypes.NameIdentifier || c.Type == "nameid").Value);
        Assert.Equal("admin", jwt.Claims.First(c => c.Type == ClaimTypes.Role || c.Type == "role").Value);
        Assert.Equal("session-1", jwt.Claims.First(c => c.Type == "sid").Value);
        Assert.Equal("1", jwt.Claims.First(c => c.Type == "mfa").Value);
    }

    [Fact]
    public void NotificationStreamPipeline_RegisterPublishRemove_WorksForUserAndNotificationStreamGroupTargets()
    {
        IConfiguration config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["NotificationStream:QueueCapacity"] = "64" })
            .Build();
        var manager = new NotificationStreamConnectionManager(config, NullLogger<NotificationStreamConnectionManager>.Instance);

        var userConnection = manager.RegisterConnection("c-user", "u-1", new[] { "feed" });
        var groupConnection = manager.RegisterConnection("c-group", null, new[] { "feed" });

        SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray([1, 2, 3]);
        try
        {
            int userDelivered = manager.Publish(frame, new NotificationStreamUserTarget("u-1"));
            int groupDelivered = manager.Publish(frame, new NotificationStreamGroupTarget("feed"));
            int multiDelivered = manager.Publish(frame, new NotificationStreamMultiUserTarget(new[] { "u-1", "missing" }));

            Assert.Equal(1, userDelivered);
            Assert.Equal(2, groupDelivered);
            Assert.Equal(1, multiDelivered);
        }
        finally
        {
            frame.Release();
        }

        manager.RemoveConnection(userConnection.ConnectionId);
        manager.RemoveConnection(groupConnection.ConnectionId);
        Assert.Equal(0, manager.ConnectionCount);
    }
}
