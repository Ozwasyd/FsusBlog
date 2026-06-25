using System.Reflection;
using System.Linq.Expressions;
using System.Data;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.Fixtures;
using FsusBlog.Server.Tests.TestInfrastructure;
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

    private static UserService BuildService(ISqlSugarClient db, IJwtHelper jwtHelper, IBlacklistService blacklistService)
        => BuildService(db, jwtHelper, Substitute.For<ITotpService>(), blacklistService);

    private static UserService BuildService(
        ISqlSugarClient db,
        IJwtHelper jwtHelper,
        ITotpService totpService,
        IBlacklistService? blacklistService = null)
    {
        return new UserService(
            _db: db,
            _logger: NullLogger<UserService>.Instance,
            _jwtHelper: jwtHelper,
            _cache: Substitute.For<IUnifiedCache>(),
            _blacklistService: blacklistService ?? Substitute.For<IBlacklistService>(),
            _messageCommandService: Substitute.For<IMessageCommandService>(),
            _messageRealtimePublisher: Substitute.For<IMessageRealtimePublisher>(),
            _totpService: totpService,
            _authRiskService: Substitute.For<IAuthRiskService>());
    }

    private static (IInsertable<UserSession> SessionInsert, IUpdateable<User> UserUpdate) ConfigureLoginPersistence(ISqlSugarClient db)
    {
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            await call.Arg<Func<Task>>()();
            return new DbResult<bool> { IsSuccess = true };
        });
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(_ => Task.FromResult((IDataReader)new DataTable().CreateDataReader()));

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
        Assert.Equal(AnonymousIdentityRuntime.AnonymousAccountKind, inserted.IdentityKind);
        Assert.Equal("quietreader", inserted.PublicHandle);
        Assert.NotNull(inserted.PrivacyInitializedAt);
        Assert.False(inserted.PasskeyEnabled);
        Assert.False(inserted.RecoveryEnabled);
    }

    [Fact]
    public async Task UpdatePublicHandleAsync_ValidHandle_SavesNormalizedHandle()
    {
        var db = Substitute.For<ISqlSugarClient>();
        db.Ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(Task.FromResult(1));
        var svc = BuildService(db, Substitute.For<IJwtHelper>());

        var (success, message) = await svc.UpdatePublicHandleAsync(7, "QuietReader#123");

        Assert.True(success, message);
        Assert.Equal("公开称呼已保存", message);
        await db.Ado.Received(1).ExecuteCommandAsync(
            Arg.Is<string>(sql => sql.Contains("NOT EXISTS", StringComparison.Ordinal)),
            Arg.Any<SugarParameter[]>());
    }

    [Fact]
    public async Task UpdatePublicHandleAsync_DuplicateHandle_ReturnsConflict()
    {
        var db = Substitute.For<ISqlSugarClient>();
        db.Ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(Task.FromResult(0));
        db.Ado.GetIntAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(Task.FromResult(1));
        var svc = BuildService(db, Substitute.For<IJwtHelper>());

        var (success, message) = await svc.UpdatePublicHandleAsync(7, "QuietReader");

        Assert.False(success);
        Assert.Equal("公开称呼已被占用", message);
        db.DidNotReceive().Updateable<User>();
    }

    [Fact]
    public async Task UpdatePublicHandleAsync_UniqueConstraintViolation_ReturnsConflict()
    {
        var db = Substitute.For<ISqlSugarClient>();
        db.Ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns<Task<int>>(_ => throw new Exception("23505 duplicate key value violates unique constraint"));
        var svc = BuildService(db, Substitute.For<IJwtHelper>());

        var (success, message) = await svc.UpdatePublicHandleAsync(7, "QuietReader");

        Assert.False(success);
        Assert.Equal("公开称呼已被占用", message);
    }

    [Fact]
    public async Task UpdatePublicHandleAsync_InvalidHandle_ReturnsValidationError()
    {
        var svc = BuildService();

        var (success, message) = await svc.UpdatePublicHandleAsync(7, "reader_123");

        Assert.False(success);
        Assert.Contains("允许中文、英文字母、数字和 #", message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task UpdatePublicHandleAsync_EmptyHandle_ClearsPublicHandle()
    {
        var db = Substitute.For<ISqlSugarClient>();
        db.Ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(Task.FromResult(1));
        var svc = BuildService(db, Substitute.For<IJwtHelper>());

        var (success, message) = await svc.UpdatePublicHandleAsync(7, "   ");

        Assert.True(success, message);
        Assert.Equal("公开称呼已清空", message);
        await db.Ado.Received(1).ExecuteCommandAsync(
            Arg.Is<string>(sql => sql.Contains("SET public_handle = NULL", StringComparison.Ordinal)),
            Arg.Any<SugarParameter[]>());
    }

    [Fact]
    public void UpdatePublicHandleAsync_SourceUsesAtomicUniqueUpdate()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string method = ExtractUserServiceMethod(
            source,
            "public async Task<(bool Success, string Message)> UpdatePublicHandleAsync",
            "public async Task<(bool Success, TokenResponseDto? Data)> RefreshTokenAsync");

        Assert.Contains("NOT EXISTS", method, StringComparison.Ordinal);
        Assert.Contains("public_handle = @publicHandle", method, StringComparison.Ordinal);
        Assert.Contains("id <> @userId", method, StringComparison.Ordinal);
        Assert.Contains("IsUniqueViolation", method, StringComparison.Ordinal);
        Assert.DoesNotContain("AnyAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Updateable<User>()", method, StringComparison.Ordinal);
    }

    [Fact]
    public void DeleteAccountAsync_SourceUsesAnonymousTombstoneAndRevokesAccountAssets()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string method = ExtractUserServiceMethod(
            source,
            "public async Task<(bool Success, string Message)> DeleteAccountAsync",
            "public async Task<MfaProfileDto?> GetMfaProfileAsync");

        Assert.DoesNotContain("LegacyPasswordDisabledMessage", method, StringComparison.Ordinal);
        Assert.DoesNotContain("BCrypt.Net.BCrypt.Verify(dto.Password", method, StringComparison.Ordinal);
        Assert.DoesNotContain("BuildDeletedUsername", method, StringComparison.Ordinal);
        Assert.Contains("IdentityKind == AnonymousIdentityRuntime.AnonymousAccountKind", method, StringComparison.Ordinal);
        Assert.Contains("PublicHandle == null", method, StringComparison.Ordinal);
        Assert.Contains("PasskeyEnabled == false", method, StringComparison.Ordinal);
        Assert.Contains("RecoveryEnabled == false", method, StringComparison.Ordinal);
        Assert.Contains("AnonymousCredentialStatus == AnonymousCredentialStatuses.Revoked", method, StringComparison.Ordinal);
        Assert.Contains("Updateable<RecoveryKeyCredential>()", method, StringComparison.Ordinal);
        Assert.Contains("Updateable<AnonymousCredential>()", method, StringComparison.Ordinal);
        Assert.Contains("Deleteable<PasskeyCredential>()", method, StringComparison.Ordinal);
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
    public async Task StartMfaSetupAsync_UsesAtomicMfaProfileUpsert()
    {
        using var _ = SetAnonymousIdentityMode("1");
        var db = Substitute.For<ISqlSugarClient>();
        var userQueryable = Substitute.For<ISugarQueryable<User>>();
        db.Queryable<User>().Returns(userQueryable);
        userQueryable.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            MfaEnabled = false
        }));
        var profileQueryable = Substitute.For<ISugarQueryable<UserMfaProfile>>();
        db.Queryable<UserMfaProfile>().Returns(profileQueryable);
        profileQueryable.Where(Arg.Any<Expression<Func<UserMfaProfile, bool>>>()).Returns(profileQueryable);
        profileQueryable.FirstAsync().Returns(Task.FromResult((UserMfaProfile)null!));
        db.Ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(Task.FromResult(1));
        var totp = Substitute.For<ITotpService>();
        totp.GenerateSecret().Returns("SECRET");
        totp.ProtectSecret("SECRET").Returns("protected-secret");
        totp.BuildOtpAuthUri("FsusBlog", "FsusBlog:account:42", "SECRET").Returns("otpauth://totp/FsusBlog:account:42");
        var svc = BuildService(db, Substitute.For<IJwtHelper>(), totp);

        var (success, _, message) = await svc.StartMfaSetupAsync(42, "FsusBlog");

        Assert.True(success, message);
        await db.Ado.Received(1).ExecuteCommandAsync(
            Arg.Is<string>(sql =>
                sql.Contains("INSERT INTO user_mfa_profile", StringComparison.Ordinal) &&
                sql.Contains("ON CONFLICT (user_id) DO UPDATE SET", StringComparison.Ordinal) &&
                !sql.Contains("UPDATE user_mfa_profile", StringComparison.Ordinal)),
            Arg.Is<SugarParameter[]>(parameters => parameters.Any(parameter => parameter.ParameterName == "@UserId" && Equals(parameter.Value, 42))));
        db.DidNotReceive().Updateable<UserMfaProfile>();
        db.DidNotReceive().Insertable(Arg.Any<UserMfaProfile>());
    }

    [Fact]
    public void UserService_MfaProfileUpsertUsesSingleConflictSafeStatement()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string method = ExtractUserServiceMethod(
            source,
            "private async Task UpsertUserMfaProfileAsync",
            "private static (bool Success, string? PublicHandle, string Message) NormalizePublicHandle");

        Assert.Contains("INSERT INTO user_mfa_profile", method, StringComparison.Ordinal);
        Assert.Contains("ON CONFLICT (user_id) DO UPDATE SET", method, StringComparison.Ordinal);
        Assert.Contains("ExecuteCommandAsync", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Updateable<UserMfaProfile>()", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Insertable(profile)", method, StringComparison.Ordinal);
    }

    [Fact]
    public async Task VerifyMfaOrRecoveryCodeAsync_RecoveryCodeCasConflictReturnsFalse()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var queryable = Substitute.For<ISugarQueryable<UserMfaProfile>>();
        db.Queryable<UserMfaProfile>().Returns(queryable);
        queryable.Where(Arg.Any<Expression<Func<UserMfaProfile, bool>>>()).Returns(queryable);
        queryable.FirstAsync().Returns(Task.FromResult(new UserMfaProfile
        {
            UserId = 42,
            MfaSecretEncrypted = "protected-secret",
            MfaRecoveryCodesHash = "old-hashes",
            MfaRecoveryCodesHashVersion = TotpService.CurrentRecoveryCodeHashVersion
        }));
        db.Ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(Task.FromResult(0));
        var totp = Substitute.For<ITotpService>();
        totp.ConsumeRecoveryCode("old-hashes", "RECOVERY").Returns(new RecoveryCodeConsumeResult(
            Success: true,
            UpdatedHashes: "new-hashes",
            ConsumedLegacyHash: false,
            LegacyHashExpired: false,
            RequiresRecoveryCodeRegeneration: false));
        var svc = BuildService(db, Substitute.For<IJwtHelper>(), totp);

        bool verified = await svc.VerifyMfaOrRecoveryCodeAsync(
            new User { Id = 42, MfaEnabled = true },
            code: null,
            recoveryCode: "RECOVERY",
            persistRecoveryConsumption: true);

        Assert.False(verified);
        await db.Ado.Received(1).ExecuteCommandAsync(
            Arg.Is<string>(sql =>
                sql.Contains("UPDATE user_mfa_profile", StringComparison.Ordinal) &&
                sql.Contains("mfa_recovery_codes_hash = @UpdatedHashes", StringComparison.Ordinal) &&
                sql.Contains("mfa_recovery_codes_hash = @OldHashes", StringComparison.Ordinal)),
            Arg.Is<SugarParameter[]>(parameters =>
                parameters.Any(parameter => parameter.ParameterName == "@OldHashes" && Equals(parameter.Value, "old-hashes")) &&
                parameters.Any(parameter => parameter.ParameterName == "@UpdatedHashes" && Equals(parameter.Value, "new-hashes"))));
    }

    [Fact]
    public void UserService_RecoveryCodeConsumptionUsesHashCompareAndSwap()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string verifyMethod = ExtractUserServiceMethod(
            source,
            "public async Task<bool> VerifyMfaOrRecoveryCodeAsync",
            "private async Task RevokeLikelyRefreshReplayAsync");
        string casMethod = ExtractUserServiceMethod(
            source,
            "private async Task<bool> TryPersistRecoveryCodeConsumptionAsync",
            "private async Task RevokeLikelyRefreshReplayAsync");

        Assert.Contains("TryPersistRecoveryCodeConsumptionAsync", verifyMethod, StringComparison.Ordinal);
        Assert.Contains("UPDATE user_mfa_profile", casMethod, StringComparison.Ordinal);
        Assert.Contains("mfa_recovery_codes_hash = @UpdatedHashes", casMethod, StringComparison.Ordinal);
        Assert.Contains("mfa_recovery_codes_hash = @OldHashes", casMethod, StringComparison.Ordinal);
        AssertContainsAfter(verifyMethod, "RecoveryCodeConsumeResult consumeResult", "TryPersistRecoveryCodeConsumptionAsync");
    }

    [Fact]
    public void UserService_SourceDoesNotWriteSysUserLegacySecurityColumns()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");

        foreach (string forbidden in new[]
        {
            "LegacyPasswordHash = string.Empty",
            "LegacyProjectRole = \"guest\"",
            "it.LastLoginTime == now",
            "it.LastLoginIp == clientIp",
            "u.MfaSecretEncrypted ==",
            "u.MfaPendingSecretEncrypted ==",
            "u.MfaRecoveryCodesHash ==",
            "u.MfaVerifiedAt =="
        })
        {
            Assert.DoesNotContain(forbidden, source, StringComparison.Ordinal);
        }

        Assert.Contains("INSERT INTO user_mfa_profile", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RevokeRefreshTokenAsync_EmptyToken_ReturnsFalse()
    {
        var svc = BuildService();
        Assert.False(await svc.RevokeRefreshTokenAsync("   "));
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
        var bannedUser = new User { Id = 42, Status = 1 };

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
        await persistence.UserUpdate.DidNotReceive().ExecuteCommandAsync();
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
        var user = new User { Id = 7, Status = 0 };

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
        await persistence.UserUpdate.DidNotReceive().ExecuteCommandAsync();
    }

    [Fact]
    public void CompleteLoginAsync_SourceRevokesPreviousSessionsAndInsertsNewSessionInTransaction()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string method = ExtractUserServiceMethod(
            source,
            "public async Task<(bool Success, string Message, SessionTokenResponseDto? Data, User? UserEntity)> CompleteLoginAsync",
            "public async Task<UserSession?> GetSessionByRefreshTokenAsync");

        Assert.Contains("_db.Ado.UseTranAsync(async () =>", method, StringComparison.Ordinal);
        AssertContainsAfter(method, "_db.Ado.UseTranAsync(async () =>", "LoadActiveUserSessionVersionsAsync(user.Id)");
        AssertContainsAfter(method, "LoadActiveUserSessionVersionsAsync(user.Id)", "TryRevokeSessionAsync(activeSession.SessionId, activeSession.RowVersion");
        AssertContainsAfter(method, "TryRevokeSessionAsync(activeSession.SessionId, activeSession.RowVersion", "_db.Insertable(session).ExecuteCommandAsync()");
        Assert.Contains("if (!tran.IsSuccess)", method, StringComparison.Ordinal);
    }

    [Fact]
    public void UserSessionEntity_ExposesPostgresRowVersionForSessionRevocationGuards()
    {
        Assert.True(typeof(UserSession).GetProperty("RowVersion") is { });

        string entity = BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/UserSession.cs");
        Assert.Contains("public string? RowVersion", entity, StringComparison.Ordinal);
        Assert.Contains("[SugarColumn(IsIgnore = true)]", entity, StringComparison.Ordinal);
    }

    [Fact]
    public void SchemaMigrationRegistry_UserSessionActiveUniqueIndex_BlocksTwoActiveSessions()
    {
        string migrations = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/SchemaMigration/SchemaMigrationRegistry.cs");

        Assert.Contains("20260625-post-user-session-active-unique", migrations, StringComparison.Ordinal);
        Assert.Contains("ux_user_session_one_active_per_user", migrations, StringComparison.Ordinal);
        Assert.Contains("CREATE UNIQUE INDEX IF NOT EXISTS ux_user_session_one_active_per_user", migrations, StringComparison.Ordinal);
        Assert.Contains("ON sys_user_session(userid) WHERE revokedat IS NULL", migrations, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminChangeStatusAsync_LegacyAdminRole_DoesNotGrantAccountGovernanceProtection()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string method = ExtractUserServiceMethod(
            source,
            "public async Task<(bool Success, string Message)> AdminChangeStatusAsync",
            "private async Task<AdminStatusTarget?> LoadAdminStatusTargetAsync");

        Assert.Contains("user.IdentityKind", method, StringComparison.Ordinal);
        Assert.Contains("AnonymousIdentityRuntime.AdminPrincipalKind", method, StringComparison.Ordinal);
        Assert.DoesNotContain("LegacyProjectRole", method, StringComparison.Ordinal);
        Assert.DoesNotContain(".Role", method, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminChangeStatusAsync_AdminPrincipalIdentityKind_RejectsOrdinaryAccountGovernance()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string method = ExtractUserServiceMethod(
            source,
            "public async Task<(bool Success, string Message)> AdminChangeStatusAsync",
            "private async Task<AdminStatusTarget?> LoadAdminStatusTargetAsync");

        Assert.Contains("string.Equals(user.IdentityKind, AnonymousIdentityRuntime.AdminPrincipalKind, StringComparison.Ordinal)", method, StringComparison.Ordinal);
        Assert.Contains("管理员主体不通过普通账号状态接口治理", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Updateable<User>()", method, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminChangeStatusAsync_SourceDoesNotReadLegacyRoleForAdminProtection()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string method = ExtractUserServiceMethod(
            source,
            "public async Task<(bool Success, string Message)> AdminChangeStatusAsync",
            "public async Task<(bool Success, string Message, SessionTokenResponseDto? Data, User? UserEntity)> CompleteLoginAsync");

        Assert.DoesNotContain("LegacyProjectRole", method, StringComparison.Ordinal);
        Assert.DoesNotContain(".Role", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Role == \"admin\"", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Role.Equals(\"admin\"", method, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminChangeStatusAsync_SourceUsesRowVersionGuardForStatusMutation()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string method = ExtractUserServiceMethod(
            source,
            "public async Task<(bool Success, string Message)> AdminChangeStatusAsync",
            "public async Task<(bool Success, string Message, SessionTokenResponseDto? Data, User? UserEntity)> CompleteLoginAsync");
        string loadMethod = ExtractUserServiceMethod(
            source,
            "private async Task<AdminStatusTarget?> LoadAdminStatusTargetAsync",
            "private async Task<bool> TryUpdateAdminStatusAsync");
        string updateMethod = ExtractUserServiceMethod(
            source,
            "private async Task<bool> TryUpdateAdminStatusAsync",
            "public async Task<(bool Success, string Message, SessionTokenResponseDto? Data, User? UserEntity)> CompleteLoginAsync");

        Assert.Contains("LoadAdminStatusTargetAsync(dto.AccountId)", method, StringComparison.Ordinal);
        Assert.Contains("TryUpdateAdminStatusAsync(user, dto.Status, effectiveReason)", method, StringComparison.Ordinal);
        Assert.Contains("LoadAdminStatusTargetAsync(dto.AccountId)", method, StringComparison.Ordinal);
        Assert.Contains("xmin::text AS row_version", loadMethod, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("identity_kind = @IdentityKind", updateMethod, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("deleted_at IS NULL", updateMethod, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("status <> 2", updateMethod, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("xmin::text = @RowVersion", updateMethod, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Updateable<User>()", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoggerMessages_UseAccountSubjectInsteadOfInternalSubjectOrAccountIdForAnonymousAccountEvents()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");

        Assert.Contains("AccountSubjectHasher.Create(user)", source, StringComparison.Ordinal);
        Assert.Contains("LogBannedAccountLogin(accountSubject)", source, StringComparison.Ordinal);
        Assert.Contains("LogBannedAccountTokenRefresh(accountSubject)", source, StringComparison.Ordinal);

        foreach (string loggerName in new[]
        {
            "LogRegistrationConflict",
            "LogLoginFailure",
            "LogBannedAccountLogin",
            "LogBannedAccountTokenRefresh"
        })
        {
            string declaration = ExtractLoggerDeclaration(source, loggerName);
            Assert.Contains("accountSubject", declaration, StringComparison.Ordinal);
            Assert.Contains("AccountSubject", declaration, StringComparison.Ordinal);
            Assert.DoesNotContain("InternalSubject", declaration, StringComparison.Ordinal);
            Assert.DoesNotContain("int accountId", declaration, StringComparison.Ordinal);
        }

        Assert.DoesNotContain("LogBannedUserLogin", source, StringComparison.Ordinal);
        Assert.DoesNotContain("LogBannedUserTokenRefresh", source, StringComparison.Ordinal);
    }

    // ── Private static helpers via reflection ─────────────────────────────────

    private static T InvokePrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(UserService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
    }

    private static IDisposable SetAnonymousIdentityMode(string? value)
        => new EnvironmentVariableScope(AnonymousIdentityRuntime.ModeEnvironmentVariable, value);

    private static string ExtractUserServiceMethod(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex, StringComparison.Ordinal);
        Assert.True(endIndex > startIndex, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }

    private static string ExtractLoggerDeclaration(string source, string methodName)
    {
        int methodIndex = source.IndexOf($"partial void {methodName}", StringComparison.Ordinal);
        Assert.True(methodIndex >= 0, $"Missing logger method: {methodName}");
        int attributeStart = source.LastIndexOf("[LoggerMessage", methodIndex, StringComparison.Ordinal);
        Assert.True(attributeStart >= 0, $"Missing LoggerMessage attribute: {methodName}");
        int declarationEnd = source.IndexOf(';', methodIndex);
        Assert.True(declarationEnd > methodIndex, $"Missing logger declaration terminator: {methodName}");
        return source[attributeStart..(declarationEnd + 1)];
    }

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
    public void NormalizePublicHandleToken_TrimsAndLowercases(string input, string expected)
    {
        var result = InvokePrivateStatic<string>("NormalizePublicHandleToken", [input]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void NormalizePublicHandleToken_TruncatesAtMaxLength()
    {
        string longName = new string('a', 200);
        var result = InvokePrivateStatic<string>("NormalizePublicHandleToken", [longName]);
        Assert.Equal(20, result.Length);
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
    public void DeleteAccountAsync_DoesNotUseLegacyDeletedUsernameRewrite()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/UserService.cs");
        string method = ExtractUserServiceMethod(
            source,
            "public async Task<(bool Success, string Message)> DeleteAccountAsync",
            "public async Task<MfaProfileDto?> GetMfaProfileAsync");

        Assert.DoesNotContain("BuildDeletedUsername", method, StringComparison.Ordinal);
        Assert.DoesNotContain("deleted_", method, StringComparison.Ordinal);
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

    private static void AssertContainsAfter(string source, string first, string second)
    {
        int firstIndex = source.IndexOf(first, StringComparison.Ordinal);
        Assert.True(firstIndex >= 0, $"Missing '{first}'.");
        int secondIndex = source.IndexOf(second, firstIndex + first.Length, StringComparison.Ordinal);
        Assert.True(secondIndex >= 0, $"Missing '{second}' after '{first}'.");
    }
}
