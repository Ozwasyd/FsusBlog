using System.Reflection;
using System.Linq.Expressions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.Fixtures;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Collection(nameof(EnvironmentVariableCollection))]
public class UserServiceValidationTests
{
    private static UserService BuildService()
    {
        return BuildService(
            db: Substitute.For<ISqlSugarClient>(),
            jwtHelper: Substitute.For<IJwtHelper>());
    }

    private static UserService BuildService(ISqlSugarClient db, IJwtHelper jwtHelper)
        => BuildService(db, jwtHelper, Substitute.For<ITotpService>());

    private static UserService BuildService(ISqlSugarClient db, IJwtHelper jwtHelper, ITotpService totpService)
    {
        return new UserService(
            _db: db,
            _logger: NullLogger<UserService>.Instance,
            _jwtHelper: jwtHelper,
            _cache: Substitute.For<IUnifiedCache>(),
            _blacklistService: Substitute.For<IBlacklistService>(),
            _messageCommandService: Substitute.For<IMessageCommandService>(),
            _messageRealtimePublisher: Substitute.For<IMessageRealtimePublisher>(),
            _totpService: totpService,
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
    public async Task RegisterAsync_AnonymousIdentityMode_DisablesLegacyPasswordRegistration()
    {
        using var _ = SetAnonymousIdentityMode("1");
        var svc = BuildService();
        var dto = new RegisterDto { Username = "anonymous", Password = "validPass1!", ConfirmPassword = "validPass1!" };

        var (success, message) = await svc.RegisterAsync(dto);

        Assert.False(success);
        Assert.Contains("anonymous identity", message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task BootstrapAnonymousAccountAsync_AnonymousIdentityMode_CreatesPasswordlessAnonymousContainer()
    {
        using var _ = SetAnonymousIdentityMode("1");
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<User>>();
        db.Queryable<User>().Returns(queryable);
        queryable.AnyAsync(Arg.Any<Expression<Func<User, bool>>>()).Returns(Task.FromResult(false));

        User? inserted = null;
        var insertable = Substitute.For<IInsertable<User>>();
        db.Insertable(Arg.Do<User>(user => inserted = user)).Returns(insertable);
        insertable.ExecuteReturnIdentityAsync().Returns(Task.FromResult(42));
        var svc = BuildService(db, Substitute.For<IJwtHelper>());

        var (success, message, user) = await svc.BootstrapAnonymousAccountAsync("QuietReader");

        Assert.True(success, message);
        Assert.NotNull(inserted);
        Assert.NotNull(user);
        Assert.Equal(42, user!.Id);
        Assert.StartsWith("anon_", inserted!.Username, StringComparison.Ordinal);
        Assert.Equal(string.Empty, inserted.Password);
        Assert.Equal(AnonymousIdentityRuntime.AnonymousAccountKind, inserted.IdentityKind);
        Assert.Equal("guest", inserted.Role);
        Assert.Equal("quietreader", inserted.PublicHandle);
        Assert.NotNull(inserted.PrivacyInitializedAt);
        Assert.False(inserted.PasskeyEnabled);
        Assert.False(inserted.RecoveryEnabled);
    }

    [Fact]
    public async Task UpdatePublicHandleAsync_ValidHandle_SavesNormalizedHandle()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<User>>();
        db.Queryable<User>().Returns(queryable);
        queryable.InSingleAsync(7).Returns(Task.FromResult(new User { Id = 7, PublicHandle = null }));
        queryable.AnyAsync(Arg.Any<Expression<Func<User, bool>>>()).Returns(Task.FromResult(false));
        var update = Substitute.For<IUpdateable<User>>();
        update.SetColumns(Arg.Any<Expression<Func<User, bool>>>()).Returns(update);
        update.Where(Arg.Any<Expression<Func<User, bool>>>()).Returns(update);
        update.ExecuteCommandAsync().Returns(Task.FromResult(1));
        db.Updateable<User>().Returns(update);
        var svc = BuildService(db, Substitute.For<IJwtHelper>());

        var (success, message) = await svc.UpdatePublicHandleAsync(7, "QuietReader");

        Assert.True(success, message);
        Assert.Equal("公开称呼已保存", message);
        await update.Received(1).ExecuteCommandAsync();
    }

    [Fact]
    public async Task UpdatePublicHandleAsync_DuplicateHandle_ReturnsConflict()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<User>>();
        db.Queryable<User>().Returns(queryable);
        queryable.InSingleAsync(7).Returns(Task.FromResult(new User { Id = 7, PublicHandle = null }));
        queryable.AnyAsync(Arg.Any<Expression<Func<User, bool>>>()).Returns(Task.FromResult(true));
        var svc = BuildService(db, Substitute.For<IJwtHelper>());

        var (success, message) = await svc.UpdatePublicHandleAsync(7, "QuietReader");

        Assert.False(success);
        Assert.Equal("公开称呼已被占用", message);
        db.DidNotReceive().Updateable<User>();
    }

    [Fact]
    public async Task UpdatePublicHandleAsync_InvalidHandle_ReturnsValidationError()
    {
        var svc = BuildService();

        var (success, message) = await svc.UpdatePublicHandleAsync(7, "reader123");

        Assert.False(success);
        Assert.Contains("仅允许中文或英文字母", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task UpdatePublicHandleAsync_EmptyHandle_ClearsPublicHandle()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<User>>();
        db.Queryable<User>().Returns(queryable);
        queryable.InSingleAsync(7).Returns(Task.FromResult(new User { Id = 7, PublicHandle = "quietreader" }));
        var update = Substitute.For<IUpdateable<User>>();
        update.SetColumns(Arg.Any<Expression<Func<User, bool>>>()).Returns(update);
        update.Where(Arg.Any<Expression<Func<User, bool>>>()).Returns(update);
        update.ExecuteCommandAsync().Returns(Task.FromResult(1));
        db.Updateable<User>().Returns(update);
        var svc = BuildService(db, Substitute.For<IJwtHelper>());

        var (success, message) = await svc.UpdatePublicHandleAsync(7, "   ");

        Assert.True(success, message);
        Assert.Equal("公开称呼已清空", message);
        await update.Received(1).ExecuteCommandAsync();
        await queryable.DidNotReceive().AnyAsync(Arg.Any<Expression<Func<User, bool>>>());
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
    public async Task ValidateCredentials_AnonymousIdentityMode_DisablesLegacyPasswordLogin()
    {
        using var _ = SetAnonymousIdentityMode("1");
        var svc = BuildService();
        var dto = new LoginDto { Username = "legacy", Password = "validPass1!" };

        var (success, message, user) = await svc.ValidateCredentialsAsync(dto, "127.0.0.1");

        Assert.False(success);
        Assert.Contains("anonymous identity", message, StringComparison.OrdinalIgnoreCase);
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
    public async Task UpdatePasswordAsync_AnonymousIdentityMode_DisablesLegacyPasswordChange()
    {
        using var _ = SetAnonymousIdentityMode("1");
        var svc = BuildService();
        var dto = new UpdatePasswordDto { OldPassword = "OldPass123!", NewPassword = "NewPass123!", ConfirmPassword = "NewPass123!" };

        var (success, message) = await svc.UpdatePasswordAsync(1, dto);

        Assert.False(success);
        Assert.Contains("anonymous identity", message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task StartMfaSetupAsync_AnonymousIdentityMode_UsesStableAccountLabelWithoutUsername()
    {
        using var _ = SetAnonymousIdentityMode("1");
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<User>>();
        db.Queryable<User>().Returns(queryable);
        queryable.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            Username = "legacy-random-name",
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            MfaEnabled = false
        }));
        var update = Substitute.For<IUpdateable<User>>();
        update.SetColumns(Arg.Any<Expression<Func<User, bool>>>()).Returns(update);
        update.Where(Arg.Any<Expression<Func<User, bool>>>()).Returns(update);
        update.ExecuteCommandAsync().Returns(Task.FromResult(1));
        db.Updateable<User>().Returns(update);
        var totp = Substitute.For<ITotpService>();
        totp.GenerateSecret().Returns("SECRET");
        totp.ProtectSecret("SECRET").Returns("protected-secret");
        totp.BuildOtpAuthUri("FsusBlog", "FsusBlog:account:42", "SECRET").Returns("otpauth://totp/FsusBlog:account:42");
        var svc = BuildService(db, Substitute.For<IJwtHelper>(), totp);

        var (success, setup, message) = await svc.StartMfaSetupAsync(42, "FsusBlog");

        Assert.True(success, message);
        Assert.NotNull(setup);
        Assert.Equal("FsusBlog:account:42", setup.Value.Account);
        Assert.DoesNotContain("legacy-random-name", setup.Value.OtpAuthUrl, StringComparison.Ordinal);
        totp.Received(1).BuildOtpAuthUri("FsusBlog", "FsusBlog:account:42", "SECRET");
        totp.DidNotReceive().BuildOtpAuthUri("FsusBlog", "legacy-random-name", "SECRET");
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
    public async Task CompleteLoginAsync_BannedUser_IssuesRestrictedSessionToken()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("refresh-token");
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), Arg.Any<bool>()).Returns("access-token");
        var persistence = ConfigureLoginPersistence(db);
        var svc = BuildService(db, jwt);
        var bannedUser = new User { Id = 42, Username = "banned-user", Role = "guest", Status = 1 };

        var (success, message, data, userEntity) = await svc.CompleteLoginAsync(
            bannedUser,
            "127.0.0.1",
            deviceFingerprint: "device-1",
            userAgent: "test-agent",
            mfaVerified: false,
            rememberMe: false);

        Assert.True(success);
        Assert.Equal("登录成功", message);
        Assert.NotNull(data);
        Assert.Equal("access-token", data.Value.AccessToken);
        Assert.Equal("refresh-token", data.Value.RefreshToken);
        Assert.Same(bannedUser, userEntity);
        jwt.Received(1).GenerateRefreshToken();
        jwt.Received(1).GenerateAccessToken(bannedUser, Arg.Any<string>(), false);
        await persistence.SessionInsert.Received(1).ExecuteCommandAsync();
        await persistence.UserUpdate.Received(1).ExecuteCommandAsync();
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

    private static IDisposable SetAnonymousIdentityMode(string? value)
        => new EnvironmentVariableScope(AnonymousIdentityRuntime.ModeEnvironmentVariable, value);

    private sealed class EnvironmentVariableScope : IDisposable
    {
        private readonly string _name;
        private readonly string? _previousValue;

        public EnvironmentVariableScope(string name, string? value)
        {
            _name = name;
            _previousValue = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, value);
        }

        public void Dispose()
            => Environment.SetEnvironmentVariable(_name, _previousValue);
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
