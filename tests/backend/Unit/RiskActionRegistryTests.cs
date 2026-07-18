using FsusBlog.Server.Infrastructure.Security;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RiskActionRegistryTests
{
    [Fact]
    public void DefaultRegistry_DefinesStableProductionActions()
    {
        string[] expected =
        [
            RiskActionNames.PublicRead,
            RiskActionNames.CommentCreate,
            RiskActionNames.CommentReply,
            RiskActionNames.AuthLogin,
            RiskActionNames.AuthPasskeyBegin,
            RiskActionNames.AuthPasskeyComplete,
            RiskActionNames.RecoveryKeyVerify,
            RiskActionNames.NotificationSubscribe,
            RiskActionNames.AdminSecurityWrite,
            RiskActionNames.AdminCommentBatch
        ];

        Assert.Equal(expected.OrderBy(static name => name, StringComparer.Ordinal), RiskActionRegistry.Default.Actions.Select(static action => action.Name).OrderBy(static name => name, StringComparer.Ordinal));
    }

    [Fact]
    public void Create_RejectsDuplicateActionNames()
    {
        var action = new RiskAction(RiskActionNames.AuthLogin, "Auth login", "auth", requiresRouteKey: false, defaultRouteKey: "auth.login");

        InvalidOperationException ex = Assert.Throws<InvalidOperationException>(() => RiskActionRegistry.Create([action, action]));

        Assert.Contains(RiskActionNames.AuthLogin, ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CreateMetadata_RejectsUnknownAction()
    {
        InvalidOperationException ex = Assert.Throws<InvalidOperationException>(() => RiskActionRegistry.Default.CreateMetadata("unknown.action", "unknown"));

        Assert.Contains("unknown.action", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CreateMetadata_RequiresRouteKey_WhenActionHasNoDefaultRouteKey()
    {
        InvalidOperationException ex = Assert.Throws<InvalidOperationException>(() => RiskActionRegistry.Default.CreateMetadata(RiskActionNames.PublicRead));

        Assert.Contains("routeKey", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void WithRiskAction_AttachesEndpointMetadata()
    {
        var builder = new RecordingEndpointConventionBuilder("/api/binary/auth/login");

        builder.WithRiskAction(RiskActionNames.AuthLogin);
        Endpoint endpoint = builder.Build();

        Assert.True(RiskActionRegistry.Default.TryGetEndpointMetadata(endpoint, out RiskActionEndpointMetadata metadata));
        Assert.Equal(RiskActionNames.AuthLogin, metadata.ActionName);
        Assert.Equal("auth.login", metadata.RouteKey);
    }

    [Fact]
    public void FindMissingActionMetadata_FindsProtectedEndpointsWithoutAction()
    {
        Endpoint protectedEndpoint = new RouteEndpointBuilder(_ => Task.CompletedTask, RoutePatternFactory.Parse("/api/binary/comment"), 0)
        {
            DisplayName = "POST /api/binary/comment"
        }.Build();
        var annotatedBuilder = new RecordingEndpointConventionBuilder("/api/binary/auth/login", "POST /api/binary/auth/login");
        annotatedBuilder.WithRiskAction(RiskActionNames.AuthLogin);
        Endpoint annotatedEndpoint = annotatedBuilder.Build();

        IReadOnlyList<RiskActionEndpointAuditFinding> findings = RiskActionRegistry.Default.FindMissingActionMetadata(
            [protectedEndpoint, annotatedEndpoint],
            static endpoint => endpoint.DisplayName?.StartsWith("POST", StringComparison.Ordinal) == true);

        RiskActionEndpointAuditFinding finding = Assert.Single(findings);
        Assert.Equal("POST /api/binary/comment", finding.EndpointDisplayName);
        Assert.Equal("missing-risk-action", finding.Reason);
    }

    private sealed class RecordingEndpointConventionBuilder(
        string pattern,
        string? displayName = null) : IEndpointConventionBuilder
    {
        private readonly List<Action<EndpointBuilder>> _conventions = [];

        public void Add(Action<EndpointBuilder> convention)
        {
            _conventions.Add(convention);
        }

        public Endpoint Build()
        {
            var builder = new RouteEndpointBuilder(_ => Task.CompletedTask, RoutePatternFactory.Parse(pattern), 0)
            {
                DisplayName = displayName
            };
            foreach (Action<EndpointBuilder> convention in _conventions)
            {
                convention(builder);
            }

            return builder.Build();
        }
    }
}
