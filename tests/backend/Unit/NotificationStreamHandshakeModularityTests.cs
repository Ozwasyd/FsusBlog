using System.Reflection;

using FsusBlog.Server.Infrastructure.NotificationStream;

using Microsoft.AspNetCore.Http;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class NotificationStreamHandshakeModularityTests
{
    [Fact]
    public async Task RequestRejection_StopsBeforeRiskAndAdmission()
    {
        var requestValidator = Substitute.For<INotificationStreamHandshakeRequestValidator>();
        var riskProofPolicy = Substitute.For<INotificationStreamRiskProofPolicy>();
        var connectionAdmission = Substitute.For<INotificationStreamConnectionAdmission>();
        var context = new DefaultHttpContext();
        requestValidator.Validate(context, true).Returns(
            NotificationStreamHandshakeRequestValidation.Rejected(
                StatusCodes.Status403Forbidden,
                "origin_not_allowed"));
        var service = new NotificationStreamHandshakeService(requestValidator, riskProofPolicy, connectionAdmission);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(context, CancellationToken.None);

        Assert.False(result.IsSuccess);
        Assert.Equal("origin_not_allowed", result.ErrorCode);
        await riskProofPolicy.DidNotReceiveWithAnyArgs().ValidateAsync(default!, default, default, default);
        await connectionAdmission.DidNotReceiveWithAnyArgs().AdmitAsync(default!, default, default, default);
    }

    [Fact]
    public async Task RiskRejection_StopsBeforeConnectionAdmission()
    {
        var requestValidator = Substitute.For<INotificationStreamHandshakeRequestValidator>();
        var riskProofPolicy = Substitute.For<INotificationStreamRiskProofPolicy>();
        var connectionAdmission = Substitute.For<INotificationStreamConnectionAdmission>();
        var context = new DefaultHttpContext();
        requestValidator.Validate(context, false).Returns(NotificationStreamHandshakeRequestValidation.Allowed(false));
        riskProofPolicy.ValidateAsync(context, false, false, Arg.Any<CancellationToken>()).Returns(
            NotificationStreamRiskProofResult.Rejected(
                StatusCodes.Status428PreconditionRequired,
                "risk_challenge_required"));
        var service = new NotificationStreamHandshakeService(requestValidator, riskProofPolicy, connectionAdmission);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(
            context,
            CancellationToken.None,
            requireWebSocket: false);

        Assert.False(result.IsSuccess);
        Assert.Equal("risk_challenge_required", result.ErrorCode);
        await connectionAdmission.DidNotReceiveWithAnyArgs().AdmitAsync(default!, default, default, default);
    }

    [Fact]
    public async Task AllowedProof_PassesGrantToConnectionAdmission()
    {
        var requestValidator = Substitute.For<INotificationStreamHandshakeRequestValidator>();
        var riskProofPolicy = Substitute.For<INotificationStreamRiskProofPolicy>();
        var connectionAdmission = Substitute.For<INotificationStreamConnectionAdmission>();
        var context = new DefaultHttpContext();
        requestValidator.Validate(context, false).Returns(NotificationStreamHandshakeRequestValidation.Allowed(false));
        riskProofPolicy.ValidateAsync(context, false, false, Arg.Any<CancellationToken>()).Returns(
            NotificationStreamRiskProofResult.Allowed("one-time-grant"));
        NotificationStreamHandshakeResult expected = NotificationStreamHandshakeResult.Success(
            new NotificationStreamHandshake(
                NotificationStreamHandshakeProtocol.Value,
                null,
                new HashSet<string>(StringComparer.Ordinal)),
            "one-time-grant");
        connectionAdmission.AdmitAsync(context, false, "one-time-grant", Arg.Any<CancellationToken>())
            .Returns(expected);
        var service = new NotificationStreamHandshakeService(requestValidator, riskProofPolicy, connectionAdmission);

        NotificationStreamHandshakeResult result = await service.ValidateAsync(
            context,
            CancellationToken.None,
            requireWebSocket: false);

        Assert.Same(expected, result);
        await connectionAdmission.Received(1).AdmitAsync(
            context,
            false,
            "one-time-grant",
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public void Coordinator_DependsOnlyOnUseCasePorts_AndModulesDoNotCallBack()
    {
        ConstructorInfo constructor = Assert.Single(typeof(NotificationStreamHandshakeService).GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic));
        Assert.Equal(
            [
                typeof(INotificationStreamHandshakeRequestValidator),
                typeof(INotificationStreamRiskProofPolicy),
                typeof(INotificationStreamConnectionAdmission)
            ],
            constructor.GetParameters().Select(static parameter => parameter.ParameterType));

        Type[] modules =
        [
            typeof(NotificationStreamHandshakeRequestValidator),
            typeof(NotificationStreamRiskProofPolicy),
            typeof(NotificationStreamConnectionAdmission)
        ];
        foreach (Type module in modules)
        {
            ConstructorInfo moduleConstructor = Assert.Single(module.GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic));
            Assert.DoesNotContain(
                moduleConstructor.GetParameters(),
                static parameter => parameter.ParameterType == typeof(INotificationStreamHandshakeService)
                    || parameter.ParameterType == typeof(NotificationStreamHandshakeService));
        }
    }
}
