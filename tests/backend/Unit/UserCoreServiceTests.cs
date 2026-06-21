using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Core.Services.Implementations;
using FsusBlog.Shared.Contracts.AuthSystem;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public class UserCoreServiceTests
{
    private readonly IUserCoreGateway _gw = Substitute.For<IUserCoreGateway>();
    private UserCoreService Svc() => new(_gw);

    // GetByIdAsync
    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task GetById_InvalidId_ReturnsValidationFailure(int id)
    {
        var result = await Svc().GetByIdAsync(id);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task GetById_NotFound_ReturnsNotFound()
    {
        _gw.GetByIdAsync(99).Returns(Task.FromResult<AccountSnapshotContract?>(null));
        var result = await Svc().GetByIdAsync(99);
        Assert.Equal(ErrorCode.NotFound, result.Error.Code);
    }

    [Fact]
    public async Task GetById_Found_ReturnsAccountSnapshot()
    {
        var snapshot = new AccountSnapshotContract(
            AccountId: 5,
            IdentityKind: "anonymous_account",
            PublicHandle: "Public Bob",
            PasskeyEnabled: true,
            RecoveryEnabled: true,
            TotpStepUpEnabled: false,
            AnonymousCredentialStatus: "active",
            AnonymousCredentialLevel: "strong_anonymous",
            Status: 0,
            DeletedAt: null);
        _gw.GetByIdAsync(5).Returns(Task.FromResult<AccountSnapshotContract?>(snapshot));
        var result = await Svc().GetByIdAsync(5);
        Assert.True(result.IsSuccess);
        Assert.Equal(5, result.Value?.AccountId);
        Assert.Equal("anonymous_account", result.Value?.IdentityKind);
        Assert.Equal("Public Bob", result.Value?.PublicHandle);
        Assert.True(result.Value?.PasskeyEnabled);
        Assert.Equal("strong_anonymous", result.Value?.AnonymousCredentialLevel);
    }

    // RefreshTokenAsync
    [Fact]
    public async Task RefreshToken_GatewaySuccess_ReturnsTokens()
    {
        var token = new TokenPairContract("a", "r");
        _gw.RefreshTokenAsync("rt").Returns(Task.FromResult<(bool, TokenPairContract?)>((true, token)));
        var result = await Svc().RefreshTokenAsync("rt");
        Assert.True(result.IsSuccess);
        Assert.Equal("a", result.Value.AccessToken);
    }

    [Fact]
    public async Task RefreshToken_GatewayFailure_ReturnsUnauthorized()
    {
        _gw.RefreshTokenAsync("expired").Returns(Task.FromResult<(bool, TokenPairContract?)>((false, null)));
        Assert.Equal(ErrorCode.Unauthorized, (await Svc().RefreshTokenAsync("expired")).Error.Code);
    }

    // RevokeRefreshTokenAsync
    [Fact]
    public async Task RevokeToken_Success()
    {
        _gw.RevokeRefreshTokenAsync("rt").Returns(true);
        Assert.True((await Svc().RevokeRefreshTokenAsync("rt")).IsSuccess);
    }

    [Fact]
    public async Task RevokeToken_NotFound()
    {
        _gw.RevokeRefreshTokenAsync("unknown").Returns(false);
        Assert.Equal(ErrorCode.NotFound, (await Svc().RevokeRefreshTokenAsync("unknown")).Error.Code);
    }

    // GetAdminUserListAsync
    [Theory]
    [InlineData(0, 10)]
    [InlineData(1, 0)]
    public async Task GetAdminUserList_InvalidPagination_ReturnsValidationFailure(int page, int size)
    {
        Assert.Equal(ErrorCode.Validation, (await Svc().GetAdminUserListAsync(page, size, null, null)).Error.Code);
    }

    [Fact]
    public async Task GetAdminUserList_ValidParams_ReturnsData()
    {
        var page = new AdminUserPageContract { Total = 1, Items = [] };
        _gw.GetAdminUserListAsync(1, 10, null, null).Returns(page);
        var result = await Svc().GetAdminUserListAsync(1, 10, null, null);
        Assert.True(result.IsSuccess);
    }

    // AdminChangeStatusAsync
    [Fact]
    public async Task AdminChangeStatus_GatewaySuccess()
    {
        _gw.AdminChangeStatusAsync(1, 1, "spam").Returns(Task.FromResult((true, "ok")));
        Assert.True((await Svc().AdminChangeStatusAsync(1, 1, "spam")).IsSuccess);
    }

    [Fact]
    public async Task AdminChangeStatus_GatewayFailure_ReturnsValidationError()
    {
        _gw.AdminChangeStatusAsync(1, 1, null).Returns(Task.FromResult((false, "error")));
        Assert.Equal(ErrorCode.Validation, (await Svc().AdminChangeStatusAsync(1, 1, null)).Error.Code);
    }

}
