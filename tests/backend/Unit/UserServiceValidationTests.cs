using System.Reflection;
using System.Linq.Expressions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public class UserServiceValidationTests
{
    private static UserService BuildService()
    {
        return BuildService(
            db: Substitute.For<ISqlSugarClient>(),
            jwtHelper: Substitute.For<IJwtHelper>());
    }

    private static UserService BuildService(ISqlSugarClient db, IJwtHelper jwtHelper)
    {
        return new UserService(
            _db: db,
            _logger: NullLogger<UserService>.Instance,
            _jwtHelper: jwtHelper,
            _cache: Substitute.For<IUnifiedCache>(),
            _blacklistService: Substitute.For<IBlacklistService>(),
            _messageCommandService: Substitute.For<IMessageCommandService>(),
            _messageRealtimePublisher: Substitute.For<IMessageRealtimePublisher>(),
            _totpService: Substitute.For<ITotpService>(),
            _authRiskService: Substitute.For<IAuthRiskService>());
    }

    private static (IInsertable<UserSession> SessionInsert, IUpdateable<User> UserUpdate) ConfigureLoginPersistence(ISqlSugarClient db)
    {
        var sessionInsert = Substitute.For<IInsertable<UserSession>>();
        sessionInsert.ExecuteCommandAsync().Returns(Task.FromResult(1));
        db.Insertable(Arg.Any<UserSession>()).Returns(sessionInsert);

        var userUpdate = Substitute.For<IUpdateable<User>>();
        userUpdate.SetColumns(Arg.Any<Expression<Func<User, bool>>>()).Returns(userUpdate);
        userUpdate.Where(Arg.Any<Expression<Func<User, bool>>>()).Returns(userUpdate);
        userUpdate.ExecuteCommandAsync().Returns(Task.FromResult(1));
        db.Updateable<User>().Returns(userUpdate);

        return (sessionInsert, userUpdate);
    }

    [Fact]
    public async Task RegisterAsync_PasswordTooShort_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new RegisterDto { Username = "alice", Password = "short", ConfirmPassword = "short" };
        var (success, message) = await svc.RegisterAsync(dto);
        Assert.False(success);
        Assert.Contains("8", message);
    }

    [Fact]
    public async Task RegisterAsync_PasswordTooLong_ReturnsFalse()
    {
        var svc = BuildService();
        string tooLong = new string('a', 129);
        var dto = new RegisterDto { Username = "alice", Password = tooLong, ConfirmPassword = tooLong };
        var (success, _) = await svc.RegisterAsync(dto);
        Assert.False(success);
    }

    [Fact]
    public async Task RegisterAsync_PasswordMinLength_Passes()
    {
        var svc = BuildService();
        var dto = new RegisterDto { Username = "alice", Password = "12345678", ConfirmPassword = "87654321" };
        var (success, message) = await svc.RegisterAsync(dto);
        Assert.False(success);
        Assert.Contains("不一致", message);
    }

    [Fact]
    public async Task RegisterAsync_PasswordsDoNotMatch_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new RegisterDto { Username = "alice", Password = "validPassword1", ConfirmPassword = "differentPassword1" };
        var (success, message) = await svc.RegisterAsync(dto);
        Assert.False(success);
        Assert.Contains("不一致", message);
    }

    [Fact]
    public async Task RegisterAsync_EmptyUsername_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new RegisterDto { Username = "   ", Password = "validPass1", ConfirmPassword = "validPass1" };
        var (success, message) = await svc.RegisterAsync(dto);
        Assert.False(success);
        Assert.Contains("用户名", message);
    }

    [Fact]
    public async Task RegisterAsync_UsernameWithDigits_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new RegisterDto { Username = "alice123", Password = "validPass1", ConfirmPassword = "validPass1" };
        var (success, message) = await svc.RegisterAsync(dto);
        Assert.False(success);
        Assert.Contains("格式", message);
    }

    [Fact]
    public async Task RegisterAsync_UsernameWithSpecialChars_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new RegisterDto { Username = "alice@test", Password = "validPass1", ConfirmPassword = "validPass1" };
        var (success, message) = await svc.RegisterAsync(dto);
        Assert.False(success);
        Assert.Contains("格式", message);
    }

    [Fact]
    public async Task RegisterAsync_ChineseUsername_PassesValidation_HitsDb()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<FsusBlog.Server.Entities.User>>();
        db.Queryable<FsusBlog.Server.Entities.User>().Returns(queryable);
        queryable.AnyAsync(Arg.Any<System.Linq.Expressions.Expression<Func<FsusBlog.Server.Entities.User, bool>>>())
                 .Returns(Task.FromResult(false));
        var insertable = Substitute.For<IInsertable<FsusBlog.Server.Entities.User>>();
        db.Insertable(Arg.Any<FsusBlog.Server.Entities.User>()).Returns(insertable);
        insertable.ExecuteCommandAsync().Returns(Task.FromResult(1));
        var svc = new UserService(_db: db, _logger: NullLogger<UserService>.Instance,
            _jwtHelper: Substitute.For<IJwtHelper>(), _cache: Substitute.For<IUnifiedCache>(),
            _blacklistService: Substitute.For<IBlacklistService>(),
            _messageCommandService: Substitute.For<IMessageCommandService>(),
            _messageRealtimePublisher: Substitute.For<IMessageRealtimePublisher>(),
            _totpService: Substitute.For<ITotpService>(), _authRiskService: Substitute.For<IAuthRiskService>());
        var dto = new RegisterDto { Username = "用户名", Password = "validPass1!", ConfirmPassword = "validPass1!" };
        var (success, _) = await svc.RegisterAsync(dto);
        Assert.True(success);
    }

    [Fact]
    public async Task ValidateCredentials_EmptyUsername_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new LoginDto { Username = "   ", Password = "anything" };
        var (success, message, user) = await svc.ValidateCredentialsAsync(dto, "127.0.0.1");
        Assert.False(success);
        Assert.Contains("用户名", message);
        Assert.Null(user);
    }

    [Fact]
    public async Task UpdateUsernameAsync_EmptyNewUsername_ReturnsFalse()
    {
        var svc = BuildService();
        var (success, message, data) = await svc.UpdateUsernameAsync(1, "   ");
        Assert.False(success);
        Assert.Contains("用户名", message);
        Assert.Null(data);
    }

    [Fact]
    public async Task UpdateUsernameAsync_InvalidUsernameChars_ReturnsFalse()
    {
        var svc = BuildService();
        var (success, message, data) = await svc.UpdateUsernameAsync(1, "user123");
        Assert.False(success);
        Assert.Contains("格式", message);
        Assert.Null(data);
    }

    [Fact]
    public async Task UpdatePasswordAsync_PasswordTooShort_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new UpdatePasswordDto { OldPassword = "oldpassword", NewPassword = "short", ConfirmPassword = "short" };
        var (success, message) = await svc.UpdatePasswordAsync(1, dto);
        Assert.False(success);
        Assert.Contains("8", message);
    }

    [Fact]
    public async Task UpdatePasswordAsync_PasswordsDoNotMatch_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new UpdatePasswordDto { OldPassword = "oldpassword1", NewPassword = "newPassword1!", ConfirmPassword = "differentNewPassword!" };
        var (success, message) = await svc.UpdatePasswordAsync(1, dto);
        Assert.False(success);
        Assert.Contains("不一致", message);
    }

    [Fact]
    public async Task GetByUsernameAsync_EmptyUsername_ReturnsNull()
    {
        var svc = BuildService();
        Assert.Null(await svc.GetByUsernameAsync("   "));
    }

    [Fact]
    public async Task RevokeRefreshTokenAsync_EmptyToken_ReturnsFalse()
    {
        var svc = BuildService();
        Assert.False(await svc.RevokeRefreshTokenAsync("   "));
    }

    [Theory]
    [InlineData("ALICE")]
    [InlineData("  Alice  ")]
    public async Task RegisterAsync_UsernameNormalizedToLowercase(string rawUsername)
    {
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<FsusBlog.Server.Entities.User>>();
        db.Queryable<FsusBlog.Server.Entities.User>().Returns(queryable);
        queryable.AnyAsync(Arg.Any<System.Linq.Expressions.Expression<Func<FsusBlog.Server.Entities.User, bool>>>())
                 .Returns(Task.FromResult(false));
        var insertable = Substitute.For<IInsertable<FsusBlog.Server.Entities.User>>();
        db.Insertable(Arg.Any<FsusBlog.Server.Entities.User>()).Returns(insertable);
        insertable.ExecuteCommandAsync().Returns(Task.FromResult(1));
        var svc = new UserService(db, NullLogger<UserService>.Instance,
            Substitute.For<IJwtHelper>(), Substitute.For<IUnifiedCache>(),
            Substitute.For<IBlacklistService>(), Substitute.For<IMessageCommandService>(),
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<ITotpService>(), Substitute.For<IAuthRiskService>());
        var dto = new RegisterDto { Username = rawUsername, Password = "validPass1!", ConfirmPassword = "validPass1!" };
        var (success, _) = await svc.RegisterAsync(dto);
        Assert.True(success);
    }

    [Fact]
    public async Task RegisterAsync_UsernameTooLong_IsTruncated_NotRejected()
    {
        string longName = new string('a', 50);
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<FsusBlog.Server.Entities.User>>();
        db.Queryable<FsusBlog.Server.Entities.User>().Returns(queryable);
        queryable.AnyAsync(Arg.Any<System.Linq.Expressions.Expression<Func<FsusBlog.Server.Entities.User, bool>>>())
                 .Returns(Task.FromResult(false));
        var insertable = Substitute.For<IInsertable<FsusBlog.Server.Entities.User>>();
        db.Insertable(Arg.Any<FsusBlog.Server.Entities.User>()).Returns(insertable);
        insertable.ExecuteCommandAsync().Returns(Task.FromResult(1));
        var svc = new UserService(db, NullLogger<UserService>.Instance,
            Substitute.For<IJwtHelper>(), Substitute.For<IUnifiedCache>(),
            Substitute.For<IBlacklistService>(), Substitute.For<IMessageCommandService>(),
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<ITotpService>(), Substitute.For<IAuthRiskService>());
        var dto = new RegisterDto { Username = longName, Password = "validPass1!", ConfirmPassword = "validPass1!" };
        var (success, _) = await svc.RegisterAsync(dto);
        Assert.True(success);
    }

    [Fact]
    public async Task RevokeSessionAsync_EmptySessionId_ReturnsFalse()
    {
        var svc = BuildService();
        Assert.False(await svc.RevokeSessionAsync(1, "   "));
    }

    [Fact]
    public async Task RevokeSessionAsync_NullSessionId_ReturnsFalse()
    {
        var svc = BuildService();
        Assert.False(await svc.RevokeSessionAsync(1, null!));
    }

    [Fact]
    public async Task RefreshTokenAsync_WithSessionId_EmptyToken_ReturnsFalse()
    {
        var svc = BuildService();
        var (success, data) = await svc.RefreshTokenAsync("   ", "session123");
        Assert.False(success);
        Assert.Null(data);
    }

    [Fact]
    public async Task RefreshTokenAsync_NullToken_ReturnsFalse()
    {
        var svc = BuildService();
        var (success, data) = await svc.RefreshTokenAsync(null!, null);
        Assert.False(success);
        Assert.Null(data);
    }

    [Fact]
    public async Task RefreshTokenAsync_EmptyToken_ReturnsFalse()
    {
        var svc = BuildService();
        var (success, data) = await svc.RefreshTokenAsync("");
        Assert.False(success);
        Assert.Null(data);
    }

    [Fact]
    public async Task GetSessionByRefreshTokenAsync_EmptyToken_ReturnsNull()
    {
        var svc = BuildService();
        Assert.Null(await svc.GetSessionByRefreshTokenAsync("   "));
    }

    [Fact]
    public async Task GetSessionByRefreshTokenAsync_NullToken_ReturnsNull()
    {
        var svc = BuildService();
        Assert.Null(await svc.GetSessionByRefreshTokenAsync(null!));
    }

    [Fact]
    public async Task CompleteLoginAsync_BannedUser_ReturnsFailureWithoutIssuingTokens()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("refresh-token");
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), Arg.Any<bool>()).Returns("access-token");
        ConfigureLoginPersistence(db);
        var svc = BuildService(db, jwt);
        var bannedUser = new User { Id = 42, Username = "banned-user", Role = "guest", Status = 1 };

        var (success, message, data, userEntity) = await svc.CompleteLoginAsync(
            bannedUser,
            "127.0.0.1",
            deviceFingerprint: "device-1",
            userAgent: "test-agent",
            mfaVerified: false,
            rememberMe: false);

        Assert.False(success);
        Assert.Equal("账户已被封禁", message);
        Assert.Null(data);
        Assert.Null(userEntity);
        jwt.DidNotReceive().GenerateRefreshToken();
        jwt.DidNotReceive().GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), Arg.Any<bool>());
        db.DidNotReceive().Insertable(Arg.Any<UserSession>());
    }

    [Fact]
    public async Task CompleteLoginAsync_NormalUser_IssuesSessionToken()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("refresh-token");
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), Arg.Any<bool>()).Returns("access-token");
        var persistence = ConfigureLoginPersistence(db);
        var svc = BuildService(db, jwt);
        var user = new User { Id = 7, Username = "normal-user", Role = "guest", Status = 0 };

        var (success, message, data, userEntity) = await svc.CompleteLoginAsync(
            user,
            "127.0.0.1",
            deviceFingerprint: "device-1",
            userAgent: "test-agent",
            mfaVerified: true,
            rememberMe: false);

        Assert.True(success);
        Assert.Equal("登录成功", message);
        Assert.NotNull(data);
        Assert.Equal("access-token", data.Value.AccessToken);
        Assert.Equal("refresh-token", data.Value.RefreshToken);
        Assert.Same(user, userEntity);
        jwt.Received(1).GenerateRefreshToken();
        jwt.Received(1).GenerateAccessToken(user, Arg.Any<string>(), true);
        await persistence.SessionInsert.Received(1).ExecuteCommandAsync();
        await persistence.UserUpdate.Received(1).ExecuteCommandAsync();
    }

    [Fact]
    public async Task UpdatePasswordAsync_NewPasswordTooShort_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new UpdatePasswordDto { OldPassword = "OldPass123!", NewPassword = "sh0rt", ConfirmPassword = "sh0rt" };
        var (success, message) = await svc.UpdatePasswordAsync(1, dto);
        Assert.False(success);
        Assert.Contains("8", message);
    }

    [Fact]
    public async Task UpdatePasswordAsync_PasswordsDoNotMatch_ReturnsFalse_Alt()
    {
        var svc = BuildService();
        var dto = new UpdatePasswordDto { OldPassword = "OldPass123!", NewPassword = "NewPassword1!", ConfirmPassword = "DifferentPass1!" };
        var (success, _) = await svc.UpdatePasswordAsync(1, dto);
        Assert.False(success);
    }

    // ── Private static helpers via reflection ─────────────────────────────────

    private static T InvokePrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(UserService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
    }

    [Theory]
    [InlineData("  Alice  ", "alice")]
    [InlineData("UPPER", "upper")]
    [InlineData("", "")]
    [InlineData("   ", "")]
    public void NormalizeUsername_TrimsAndLowercases(string input, string expected)
    {
        var result = InvokePrivateStatic<string>("NormalizeUsername", [input]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void NormalizeUsername_TruncatesAtMaxLength()
    {
        string longName = new string('a', 200);
        var result = InvokePrivateStatic<string>("NormalizeUsername", [longName]);
        Assert.Equal(32, result.Length); // MaxUsernameLength = 32
    }

    [Theory]
    [InlineData("abc12345", true)]   // exactly 8 chars
    [InlineData("abcdefghij", true)] // 10 chars
    [InlineData("short1", false)]    // 6 chars
    [InlineData("", false)]
    [InlineData(null, false)]
    public void IsPasswordLengthValid_ReturnsExpected(string? input, bool expected)
    {
        var result = InvokePrivateStatic<bool>("IsPasswordLengthValid", [input]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("192.168.1.1", "192.168.1.1")]
    [InlineData("  127.0.0.1  ", "127.0.0.1")]
    [InlineData("", "")]
    [InlineData(null, "")]
    public void NormalizeClientIp_TrimsInput(string? input, string expected)
    {
        var result = InvokePrivateStatic<string>("NormalizeClientIp", [input]);
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("hi", "hi")]        // shorter than maxLen → unchanged
    [InlineData("hello world", "hell")]
    [InlineData(null, null)]
    [InlineData("", null)]
    public void Truncate_CutsAtMaxLen(string? input, string? expected)
    {
        var result = InvokePrivateStatic<string?>("Truncate", [input, 4]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void BuildDeletedUsername_HasExpectedFormat()
    {
        var result = InvokePrivateStatic<string>("BuildDeletedUsername", [42]);
        Assert.StartsWith("deleted_42_", result);
    }

    [Theory]
    [InlineData(null, null, "unknown")]
    [InlineData("", null, "unknown")]
    [InlineData("Mozilla/5.0", null, "Mozilla/5.0")]
    [InlineData(null, "fp-abc", "fp-abc")]
    public void BuildDeviceLabel_ReturnsExpected(string? userAgent, string? fingerprint, string expected)
    {
        var result = InvokePrivateStatic<string>("BuildDeviceLabel", [userAgent, fingerprint]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void BuildDeviceLabel_LongUserAgent_Truncates()
    {
        string longAgent = new string('x', 200);
        var result = InvokePrivateStatic<string>("BuildDeviceLabel", [longAgent, null]);
        Assert.EndsWith("...", result);
        Assert.Equal(99, result.Length); // 96 + "..."
    }
}
