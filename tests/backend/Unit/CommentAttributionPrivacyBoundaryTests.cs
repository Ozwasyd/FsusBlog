using System.Reflection;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentAttributionPrivacyBoundaryTests
{
    [Fact]
    public void DependencyGraph_MovesIdentityAndPrivacyPortsOutOfCommentCommand()
    {
        Type[] commandDependencies = Assert.Single(typeof(CommentCommandService).GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Contains(typeof(ICommentAttributionPrivacyService), commandDependencies);
        Assert.DoesNotContain(typeof(ICommentActorResolver), commandDependencies);
        Assert.DoesNotContain(typeof(IAnonymousCommentPolicyService), commandDependencies);
        Assert.DoesNotContain(typeof(ICommentAnonymousNullifierService), commandDependencies);
        Assert.DoesNotContain(typeof(ISecurityRiskSignalSink), commandDependencies);
        Assert.DoesNotContain(typeof(IAnonymousCommentTicketService), commandDependencies);
        Assert.DoesNotContain(typeof(IZkAnonymousProofService), commandDependencies);

        ParameterInfo[] attributionDependencies = Assert.Single(typeof(CommentAttributionPrivacyService).GetConstructors())
            .GetParameters();
        Assert.DoesNotContain(
            attributionDependencies,
            static parameter => parameter.ParameterType == typeof(CommentCommandService));
    }

    [Fact]
    public void RuntimeBoundary_HasNoGenericCommentServiceForwardingMethods()
    {
        string[] methods = typeof(ICommentAttributionPrivacyService)
            .GetMethods(BindingFlags.Instance | BindingFlags.Public)
            .Select(static method => method.Name)
            .ToArray();

        Assert.DoesNotContain(methods, static name => name is "CreateCommentAsync" or "DeleteCommentAsync");
        Assert.Contains(nameof(ICommentAttributionPrivacyService.ResolvePublicActorAsync), methods);
        Assert.Contains(nameof(ICommentAttributionPrivacyService.ResolveStrongAnonymousActorAsync), methods);
        Assert.Contains(nameof(ICommentAttributionPrivacyService.ConsumeAnonymousNullifierAsync), methods);
    }
}
