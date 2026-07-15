using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using System.Reflection;
using System.Linq.Expressions;
using System.Data;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.Fixtures;
using Microsoft.Extensions.Logging;
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
        IBlacklistService? blacklistService = null,
        IUserSessionValidationCache? sessionValidationCache = null)
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
            _authRiskService: Substitute.For<IAuthRiskService>(),
            _userSessionValidationCache: sessionValidationCache ?? Substitute.For<IUserSessionValidationCache>());
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
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            await call.Arg<Func<Task>>()();
            return new DbResult<bool> { IsSuccess = true };
        });
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
        Assert.Equal(AccountSubjectHasher.Create(inserted), inserted.AccountSubjectHash);
    }

    [Fact]
    public async Task BootstrapAnonymousAccountAsync_WithoutHandlePersistsIdBasedPhysicalSubjectInTransaction()
    {
        using var _ = SetAnonymousIdentityMode("1");
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            await call.Arg<Func<Task>>()();
            return new DbResult<bool> { IsSuccess = true };
        });
        ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(Task.FromResult(1));

        User? inserted = null;
        var insertable = Substitute.For<IInsertable<User>>();
        db.Insertable(Arg.Do<User>(user => inserted = user)).Returns(insertable);
        insertable.ExecuteReturnIdentityAsync().Returns(Task.FromResult(42));
        var svc = BuildService(db, Substitute.For<IJwtHelper>());

        var (success, message, user) = await svc.BootstrapAnonymousAccountAsync(null);

        Assert.True(success, message);
        Assert.NotNull(inserted);
        Assert.NotNull(user);
        Assert.Equal(AccountSubjectHasher.Create(user!), user!.AccountSubjectHash);
        await ado.Received(1).ExecuteCommandAsync(
            Arg.Is<string>(sql => sql.Contains("account_subject_hash", StringComparison.Ordinal)),
            Arg.Any<SugarParameter[]>());
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
    public async Task UpdatePublicHandleAsync_SourceUsesAtomicUniqueUpdate()
    {
        var db = Substitute.For<ISqlSugarClient>();
        string? executedSql = null;
        SugarParameter[]? executedParameters = null;
        db.Ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(call =>
            {
                executedSql = call.ArgAt<string>(0);
                executedParameters = call.ArgAt<SugarParameter[]>(1);
                return Task.FromResult(1);
            });
        var service = BuildService(db, Substitute.For<IJwtHelper>());

        var (success, message) = await service.UpdatePublicHandleAsync(7, " QuietReader#123 ");

        Assert.True(success, message);
        Assert.NotNull(executedSql);
        Assert.Contains("NOT EXISTS", executedSql, StringComparison.Ordinal);
        Assert.Contains("public_handle = @publicHandle", executedSql, StringComparison.Ordinal);
        Assert.Contains("id <> @userId", executedSql, StringComparison.Ordinal);
        Assert.Contains(executedParameters!, parameter =>
            parameter.ParameterName == "@publicHandle" && Equals(parameter.Value, "quietreader#123"));
        Assert.Contains(executedParameters!, parameter =>
            parameter.ParameterName == "@userId" && Equals(parameter.Value, 7));
        db.DidNotReceive().Updateable<User>();
    }

    [Fact]
    public async Task DeleteAccountAsync_ExecutesAnonymousTombstoneAndAssetRevocationInsideTransaction()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        bool insideTransaction = false;
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            Assert.False(insideTransaction);
            insideTransaction = true;
            await call.Arg<Func<Task>>()();
            insideTransaction = false;
            return new DbResult<bool> { IsSuccess = true };
        });
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(call =>
        {
            Assert.True(insideTransaction);
            string sql = call.ArgAt<string>(0);
            SugarParameter[] parameters = call.ArgAt<SugarParameter[]>(1);
            Assert.Contains("UPDATE sys_user_session", sql, StringComparison.Ordinal);
            Assert.Contains("revokereason = 'account_deleted'", sql, StringComparison.Ordinal);
            Assert.Contains("RETURNING sessionid", sql, StringComparison.Ordinal);
            Assert.Contains(parameters, parameter => parameter.ParameterName == "@UserId" && Equals(parameter.Value, 42));
            return Task.FromResult((IDataReader)CreateRevokedSessionReader(
                "account-delete-session",
                42,
                DateTime.UtcNow,
                "account-delete-version"));
        });

        var users = Substitute.For<ISugarQueryable<User>>();
        db.Queryable<User>().Returns(users);
        users.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            PublicHandle = "reader-before-delete",
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            Status = 0,
            PasskeyEnabled = true,
            RecoveryEnabled = true,
            AnonymousCredentialStatus = AnonymousCredentialStatuses.Active,
            MfaEnabled = true,
            RiskFlags = 7,
            BanReason = "old-ban"
        }));

        Expression<Func<PasskeyCredential, bool>>? passkeyPredicate = null;
        var passkeyDelete = Substitute.For<IDeleteable<PasskeyCredential>>();
        passkeyDelete.Where(Arg.Do<Expression<Func<PasskeyCredential, bool>>>(value => passkeyPredicate = value)).Returns(passkeyDelete);
        passkeyDelete.ExecuteCommandAsync().Returns(_ =>
        {
            Assert.True(insideTransaction);
            return Task.FromResult(1);
        });
        db.Deleteable<PasskeyCredential>().Returns(passkeyDelete);

        var recoveryAssignments = new List<Expression<Func<RecoveryKeyCredential, bool>>>();
        Expression<Func<RecoveryKeyCredential, bool>>? recoveryPredicate = null;
        var recoveryUpdate = Substitute.For<IUpdateable<RecoveryKeyCredential>>();
        recoveryUpdate.SetColumns(Arg.Do<Expression<Func<RecoveryKeyCredential, bool>>>(recoveryAssignments.Add)).Returns(recoveryUpdate);
        recoveryUpdate.Where(Arg.Do<Expression<Func<RecoveryKeyCredential, bool>>>(value => recoveryPredicate = value)).Returns(recoveryUpdate);
        recoveryUpdate.ExecuteCommandAsync().Returns(_ =>
        {
            Assert.True(insideTransaction);
            return Task.FromResult(1);
        });
        db.Updateable<RecoveryKeyCredential>().Returns(recoveryUpdate);

        var anonymousAssignments = new List<Expression<Func<AnonymousCredential, bool>>>();
        Expression<Func<AnonymousCredential, bool>>? anonymousPredicate = null;
        var anonymousUpdate = Substitute.For<IUpdateable<AnonymousCredential>>();
        anonymousUpdate.SetColumns(Arg.Do<Expression<Func<AnonymousCredential, bool>>>(anonymousAssignments.Add)).Returns(anonymousUpdate);
        anonymousUpdate.Where(Arg.Do<Expression<Func<AnonymousCredential, bool>>>(value => anonymousPredicate = value)).Returns(anonymousUpdate);
        anonymousUpdate.ExecuteCommandAsync().Returns(_ =>
        {
            Assert.True(insideTransaction);
            return Task.FromResult(1);
        });
        db.Updateable<AnonymousCredential>().Returns(anonymousUpdate);

        var userAssignments = new List<Expression<Func<User, bool>>>();
        Expression<Func<User, bool>>? userPredicate = null;
        var userUpdate = Substitute.For<IUpdateable<User>>();
        userUpdate.SetColumns(Arg.Do<Expression<Func<User, bool>>>(userAssignments.Add)).Returns(userUpdate);
        userUpdate.Where(Arg.Do<Expression<Func<User, bool>>>(value => userPredicate = value)).Returns(userUpdate);
        userUpdate.ExecuteCommandAsync().Returns(_ =>
        {
            Assert.True(insideTransaction);
            return Task.FromResult(1);
        });
        db.Updateable<User>().Returns(userUpdate);

        var mfaAssignments = new List<Expression<Func<UserMfaProfile, bool>>>();
        Expression<Func<UserMfaProfile, bool>>? mfaPredicate = null;
        var mfaUpdate = Substitute.For<IUpdateable<UserMfaProfile>>();
        mfaUpdate.SetColumns(Arg.Do<Expression<Func<UserMfaProfile, bool>>>(mfaAssignments.Add)).Returns(mfaUpdate);
        mfaUpdate.Where(Arg.Do<Expression<Func<UserMfaProfile, bool>>>(value => mfaPredicate = value)).Returns(mfaUpdate);
        mfaUpdate.ExecuteCommandAsync().Returns(_ =>
        {
            Assert.True(insideTransaction);
            return Task.FromResult(1);
        });
        db.Updateable<UserMfaProfile>().Returns(mfaUpdate);

        var sessionCache = Substitute.For<IUserSessionValidationCache>();
        IReadOnlyList<UserSessionValidationCacheState>? publishedSessions = null;
        sessionCache.PublishManyAsync(
                Arg.Do<IReadOnlyList<UserSessionValidationCacheState>>(states => publishedSessions = states),
                true)
            .Returns(_ =>
            {
                Assert.True(insideTransaction);
                return Task.CompletedTask;
            });
        var blacklist = Substitute.For<IBlacklistService>();
        var service = BuildService(
            db,
            Substitute.For<IJwtHelper>(),
            Substitute.For<ITotpService>(),
            blacklist,
            sessionCache);

        var (success, message) = await service.DeleteAccountAsync(42, new DeleteAccountRequestDto { ConfirmText = " DELETE " });

        Assert.True(success, message);
        Assert.Equal("账户已注销", message);
        Assert.False(insideTransaction);
        Assert.NotNull(passkeyPredicate);
        Assert.True(passkeyPredicate!.Compile()(new PasskeyCredential { AccountId = 42 }));
        Assert.False(passkeyPredicate.Compile()(new PasskeyCredential { AccountId = 43 }));
        Assert.NotNull(recoveryPredicate);
        Assert.True(recoveryPredicate!.Compile()(new RecoveryKeyCredential { AccountId = 42, RevokedAt = null }));
        Assert.False(recoveryPredicate.Compile()(new RecoveryKeyCredential { AccountId = 42, RevokedAt = DateTime.UtcNow }));
        DateTime recoveryRevokedAt = Assert.IsType<DateTime>(ReadAssignmentValue(recoveryAssignments, nameof(RecoveryKeyCredential.RevokedAt)));
        Assert.Equal(AnonymousCredentialStatuses.Revoked, ReadAssignmentValue(anonymousAssignments, nameof(AnonymousCredential.Status)));
        DateTime anonymousRevokedAt = Assert.IsType<DateTime>(ReadAssignmentValue(anonymousAssignments, nameof(AnonymousCredential.RevokedAtUtc)));
        Assert.NotNull(anonymousPredicate);
        Assert.True(anonymousPredicate!.Compile()(new AnonymousCredential { AccountId = 42, RevokedAtUtc = null }));
        Assert.Equal(2, ReadAssignmentValue(userAssignments, nameof(User.Status)));
        Assert.Null(ReadAssignmentValue(userAssignments, nameof(User.PublicHandle)));
        Assert.Equal(AnonymousIdentityRuntime.AnonymousAccountKind, ReadAssignmentValue(userAssignments, nameof(User.IdentityKind)));
        Assert.Equal(false, ReadAssignmentValue(userAssignments, nameof(User.PasskeyEnabled)));
        Assert.Equal(false, ReadAssignmentValue(userAssignments, nameof(User.RecoveryEnabled)));
        Assert.Equal(AnonymousCredentialStatuses.Revoked, ReadAssignmentValue(userAssignments, nameof(User.AnonymousCredentialStatus)));
        Assert.Equal(false, ReadAssignmentValue(userAssignments, nameof(User.MfaEnabled)));
        Assert.Equal(0, ReadAssignmentValue(userAssignments, nameof(User.RiskFlags)));
        Assert.Null(ReadAssignmentValue(userAssignments, nameof(User.BanReason)));
        DateTime accountDeletedAt = Assert.IsType<DateTime>(ReadAssignmentValue(userAssignments, nameof(User.DeletedAt)));
        Assert.Equal("self-service", ReadAssignmentValue(userAssignments, nameof(User.DeletedReason)));
        Assert.Equal(accountDeletedAt, recoveryRevokedAt);
        Assert.Equal(accountDeletedAt, anonymousRevokedAt);
        Assert.NotNull(userPredicate);
        Assert.True(userPredicate!.Compile()(new User { Id = 42 }));
        Assert.Null(ReadAssignmentValue(mfaAssignments, nameof(UserMfaProfile.MfaSecretEncrypted)));
        Assert.Null(ReadAssignmentValue(mfaAssignments, nameof(UserMfaProfile.MfaPendingSecretEncrypted)));
        Assert.Null(ReadAssignmentValue(mfaAssignments, nameof(UserMfaProfile.MfaPendingCreatedAt)));
        Assert.Null(ReadAssignmentValue(mfaAssignments, nameof(UserMfaProfile.MfaRecoveryCodesHash)));
        Assert.Null(ReadAssignmentValue(mfaAssignments, nameof(UserMfaProfile.MfaVerifiedAt)));
        Assert.Equal(accountDeletedAt, Assert.IsType<DateTime>(ReadAssignmentValue(mfaAssignments, nameof(UserMfaProfile.UpdatedAtUtc))));
        Assert.NotNull(mfaPredicate);
        Assert.True(mfaPredicate!.Compile()(new UserMfaProfile { UserId = 42 }));
        await passkeyDelete.Received(1).ExecuteCommandAsync();
        await recoveryUpdate.Received(1).ExecuteCommandAsync();
        await anonymousUpdate.Received(1).ExecuteCommandAsync();
        await userUpdate.Received(1).ExecuteCommandAsync();
        await mfaUpdate.Received(1).ExecuteCommandAsync();
        UserSessionValidationCacheState publishedSession = Assert.Single(publishedSessions!);
        Assert.Equal("account-delete-session", publishedSession.SessionId);
        Assert.Equal("account-delete-version", publishedSession.RowVersion);
        await blacklist.Received(1).UnbanUserAsync(42);
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
    public async Task UserService_MfaProfileUpsertUsesSingleConflictSafeStatement()
    {
        await StartMfaSetupAsync_UsesAtomicMfaProfileUpsert();
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
    public async Task UserService_RecoveryCodeConsumptionUsesHashCompareAndSwap()
    {
        await VerifyMfaOrRecoveryCodeAsync_RecoveryCodeCasConflictReturnsFalse();
    }

    [Fact]
    public async Task UserService_TotpVerificationConsumesStepWithCompareAndSwap()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var profileQueryable = Substitute.For<ISugarQueryable<UserMfaProfile>>();
        db.Queryable<UserMfaProfile>().Returns(profileQueryable);
        profileQueryable.Where(Arg.Any<Expression<Func<UserMfaProfile, bool>>>()).Returns(profileQueryable);
        profileQueryable.FirstAsync().Returns(Task.FromResult(new UserMfaProfile
        {
            UserId = 42,
            MfaSecretEncrypted = "protected-secret",
            LastTotpStep = 986
        }));
        string? executedSql = null;
        SugarParameter[]? executedParameters = null;
        db.Ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(call =>
            {
                executedSql = call.ArgAt<string>(0);
                executedParameters = call.ArgAt<SugarParameter[]>(1);
                return Task.FromResult(1);
            });
        var totp = Substitute.For<ITotpService>();
        totp.UnprotectSecret("protected-secret").Returns("secret");
        long matchedStep = 0;
        totp.TryVerifyCode("secret", "123456", out matchedStep, 1)
            .Returns(call =>
            {
                call[2] = 987L;
                return true;
            });
        var service = BuildService(db, Substitute.For<IJwtHelper>(), totp);

        bool verified = await service.VerifyMfaOrRecoveryCodeAsync(
            new User { Id = 42, MfaEnabled = true },
            code: "123456",
            recoveryCode: null,
            persistRecoveryConsumption: false);

        Assert.True(verified);
        Assert.NotNull(executedSql);
        Assert.Contains("UPDATE user_mfa_profile", executedSql, StringComparison.Ordinal);
        Assert.Contains("last_totp_step = @MatchedStep", executedSql, StringComparison.Ordinal);
        Assert.Contains("last_totp_step < @MatchedStep", executedSql, StringComparison.Ordinal);
        Assert.Contains(executedParameters!, parameter =>
            parameter.ParameterName == "@MatchedStep" && Equals(parameter.Value, 987L));
        PropertyInfo lastStep = Assert.IsAssignableFrom<PropertyInfo>(typeof(UserMfaProfile).GetProperty(nameof(UserMfaProfile.LastTotpStep)));
        Assert.Equal(typeof(long?), lastStep.PropertyType);
    }

    [Fact]
    public void UserAndMfaProfile_MetadataKeepLegacySecurityStateOutOfSysUser()
    {
        Assert.Null(typeof(User).GetProperty("LegacyPasswordHash", BindingFlags.Instance | BindingFlags.Public));
        Assert.Null(typeof(User).GetProperty("LegacyProjectRole", BindingFlags.Instance | BindingFlags.Public));
        Assert.Null(typeof(User).GetProperty("LastLoginTime", BindingFlags.Instance | BindingFlags.Public));
        Assert.Null(typeof(User).GetProperty("LastLoginIp", BindingFlags.Instance | BindingFlags.Public));
        Assert.Null(typeof(User).GetProperty("MfaSecretEncrypted", BindingFlags.Instance | BindingFlags.Public));
        Assert.Null(typeof(User).GetProperty("MfaPendingSecretEncrypted", BindingFlags.Instance | BindingFlags.Public));
        Assert.Null(typeof(User).GetProperty("MfaRecoveryCodesHash", BindingFlags.Instance | BindingFlags.Public));
        Assert.Null(typeof(User).GetProperty("MfaVerifiedAt", BindingFlags.Instance | BindingFlags.Public));

        SugarTable mfaTable = Assert.IsType<SugarTable>(typeof(UserMfaProfile).GetCustomAttribute<SugarTable>());
        Assert.Equal("user_mfa_profile", mfaTable.TableName);
        Assert.Equal("mfa_secret_encrypted", SugarColumnName<UserMfaProfile>(nameof(UserMfaProfile.MfaSecretEncrypted)));
        Assert.Equal("mfa_pending_secret_encrypted", SugarColumnName<UserMfaProfile>(nameof(UserMfaProfile.MfaPendingSecretEncrypted)));
        Assert.Equal("mfa_recovery_codes_hash", SugarColumnName<UserMfaProfile>(nameof(UserMfaProfile.MfaRecoveryCodesHash)));
        Assert.Equal("mfa_verified_at", SugarColumnName<UserMfaProfile>(nameof(UserMfaProfile.MfaVerifiedAt)));
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
    public async Task RevokeSessionAsync_PublicationFailureRollsBackAndInvalidatesPossiblePartialSnapshot()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        var sequence = new List<string>();
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            sequence.Add("transaction-begin");
            try
            {
                await call.Arg<Func<Task>>()();
                sequence.Add("transaction-commit");
                return new DbResult<bool> { IsSuccess = true };
            }
            catch (Exception ex)
            {
                sequence.Add("transaction-rollback");
                return new DbResult<bool> { IsSuccess = false, ErrorException = ex };
            }
        });
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(_ =>
        {
            sequence.Add("database-revoke");
            return Task.FromResult((IDataReader)CreateRevokedSessionReader(
                "session-rollback",
                42,
                DateTime.UtcNow,
                "row-version-rollback"));
        });
        var cache = Substitute.For<IUserSessionValidationCache>();
        cache.PublishManyAsync(
                Arg.Any<IReadOnlyList<UserSessionValidationCacheState>>(),
                true)
            .Returns(_ => Task.FromException(new InvalidOperationException("forced publication failure")));
        IReadOnlyList<UserSessionValidationCacheState>? invalidated = null;
        cache.InvalidateManyAsync(
                Arg.Do<IReadOnlyList<UserSessionValidationCacheState>>(states => invalidated = states))
            .Returns(_ =>
            {
                sequence.Add("invalidate-partial-snapshot");
                return Task.CompletedTask;
            });
        var service = BuildService(
            db,
            Substitute.For<IJwtHelper>(),
            Substitute.For<ITotpService>(),
            sessionValidationCache: cache);

        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.RevokeSessionAsync(42, "session-rollback"));

        Assert.Equal("forced publication failure", error.Message);
        Assert.Equal(
            [
                "transaction-begin",
                "database-revoke",
                "transaction-rollback",
                "invalidate-partial-snapshot"
            ],
            sequence);
        UserSessionValidationCacheState invalidatedState = Assert.Single(invalidated!);
        Assert.Equal("session-rollback", invalidatedState.SessionId);
    }

    [Theory]
    [InlineData("logout")]
    [InlineData("revoke-others")]
    public async Task RevocationProducers_PublishDistributedFenceBeforeTransactionCommit(string producer)
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        var sequence = new List<string>();
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            sequence.Add("transaction-begin");
            await call.Arg<Func<Task>>()();
            sequence.Add("transaction-commit");
            return new DbResult<bool> { IsSuccess = true };
        });
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(_ =>
        {
            sequence.Add("database-revoke");
            return Task.FromResult((IDataReader)CreateRevokedSessionReader(
                $"session-{producer}",
                42,
                DateTime.UtcNow,
                $"row-version-{producer}"));
        });
        var cache = Substitute.For<IUserSessionValidationCache>();
        cache.PublishManyAsync(
                Arg.Any<IReadOnlyList<UserSessionValidationCacheState>>(),
                true)
            .Returns(_ =>
            {
                sequence.Add("publish-revoked-fence");
                return Task.CompletedTask;
            });
        var service = BuildService(
            db,
            Substitute.For<IJwtHelper>(),
            Substitute.For<ITotpService>(),
            sessionValidationCache: cache);

        int revoked = producer switch
        {
            "logout" => await service.RevokeRefreshTokenAsync("refresh-token") ? 1 : 0,
            "revoke-others" => await service.RevokeOtherSessionsAsync(42, "current-session"),
            _ => throw new ArgumentOutOfRangeException(nameof(producer), producer, null)
        };

        Assert.Equal(1, revoked);
        Assert.Equal(
            ["transaction-begin", "database-revoke", "publish-revoked-fence", "transaction-commit"],
            sequence);
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
    [Trait("Category", "SecurityStateMachine")]
    public async Task RefreshTokenAsync_RotationCarriesIssuedAccessExpiryForCookieHandoff()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var sessionQuery = Substitute.For<ISugarQueryable<UserSession>>();
        db.Queryable<UserSession>().Returns(sessionQuery);
        sessionQuery.Where(Arg.Any<Expression<Func<UserSession, bool>>>()).Returns(sessionQuery);
        sessionQuery.FirstAsync().Returns(Task.FromResult(new UserSession
        {
            SessionId = "session-rotation",
            UserId = 42,
            RefreshTokenHash = "old-hash",
            IdleExpiresAt = DateTime.UtcNow.AddHours(1),
            AbsoluteExpiresAt = DateTime.UtcNow.AddDays(1),
            MfaVerified = true,
            RememberMe = false
        }));

        var userQuery = Substitute.For<ISugarQueryable<User>>();
        db.Queryable<User>().Returns(userQuery);
        userQuery.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            Status = 0,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
            PasskeyUserHandle = "refresh-expiry-account"
        }));

        var sessionUpdate = Substitute.For<IUpdateable<UserSession>>();
        db.Updateable<UserSession>().Returns(sessionUpdate);
        sessionUpdate.SetColumns(Arg.Any<Expression<Func<UserSession, bool>>>()).Returns(sessionUpdate);
        sessionUpdate.Where(Arg.Any<Expression<Func<UserSession, bool>>>()).Returns(sessionUpdate);
        sessionUpdate.ExecuteCommandAsync().Returns(Task.FromResult(1));

        DateTimeOffset accessTokenExpiresAtUtc = DateTimeOffset.FromUnixTimeSeconds(
            DateTimeOffset.UtcNow.AddMinutes(60).ToUnixTimeSeconds());
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("rotated-refresh-token");
        jwt.GenerateAccessToken(Arg.Any<User>(), "session-rotation", true)
            .Returns(new IssuedAccessToken("rotated-access-token", accessTokenExpiresAtUtc));
        var service = BuildService(db, jwt);

        var (success, data) = await service.RefreshTokenAsync("old-refresh-token", "session-rotation");

        Assert.True(success);
        Assert.NotNull(data);
        Assert.Equal("rotated-access-token", data.Value.AccessToken);
        Assert.Equal("rotated-refresh-token", data.Value.RefreshToken);
        Assert.True(data.Value.AccessTokenExpiresAtUtc.HasValue);
        Assert.Equal(accessTokenExpiresAtUtc, data.Value.AccessTokenExpiresAtUtc.Value);
        jwt.Received(1).GenerateAccessToken(Arg.Any<User>(), "session-rotation", true);
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
    public async Task RefreshTokenWithExpiryAsync_ReturnsRotatedIdleExpiryWithoutSecondSessionLookup()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var sessionQuery = Substitute.For<ISugarQueryable<UserSession>>();
        db.Queryable<UserSession>().Returns(sessionQuery);
        sessionQuery.Where(Arg.Any<Expression<Func<UserSession, bool>>>()).Returns(sessionQuery);
        DateTime absoluteExpiry = DateTime.UtcNow.AddDays(30);
        sessionQuery.FirstAsync().Returns(Task.FromResult(new UserSession
        {
            SessionId = "facade-refresh-session",
            UserId = 42,
            RefreshTokenHash = "old-hash",
            IdleExpiresAt = DateTime.UtcNow.AddMinutes(5),
            AbsoluteExpiresAt = absoluteExpiry,
            MfaVerified = true,
            RememberMe = false
        }));
        var userQuery = Substitute.For<ISugarQueryable<User>>();
        db.Queryable<User>().Returns(userQuery);
        userQuery.InSingleAsync(42).Returns(Task.FromResult(new User
        {
            Id = 42,
            Status = 0,
            IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind
        }));
        var sessionUpdate = Substitute.For<IUpdateable<UserSession>>();
        db.Updateable<UserSession>().Returns(sessionUpdate);
        sessionUpdate.SetColumns(Arg.Any<Expression<Func<UserSession, bool>>>()).Returns(sessionUpdate);
        sessionUpdate.Where(Arg.Any<Expression<Func<UserSession, bool>>>()).Returns(sessionUpdate);
        sessionUpdate.ExecuteCommandAsync().Returns(Task.FromResult(1));
        DateTimeOffset accessExpiry = DateTimeOffset.UtcNow.AddMinutes(15);
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("rotated-refresh-token");
        jwt.GenerateAccessToken(Arg.Any<User>(), "facade-refresh-session", true)
            .Returns(new IssuedAccessToken("rotated-access-token", accessExpiry));
        var measurements = new ConcurrentBag<(string Name, double Value)>();
        using MeterListener listener = ListenToFsusMeasurements(measurements);
        var facade = new UserSessionCommandService(BuildService(db, jwt));

        var result = await facade.RefreshTokenWithExpiryAsync(
            "old-refresh-token",
            "facade-refresh-session",
            CancellationToken.None);

        Assert.True(result.Success);
        Assert.NotNull(result.Data);
        Assert.True(result.Data.Value.RefreshTokenExpiresAt.HasValue);
        Assert.Equal(result.Data.Value.RefreshTokenExpiresAt.Value, result.ExpiresAt);
        Assert.Equal(accessExpiry, result.Data.Value.AccessTokenExpiresAtUtc);
        Assert.Equal("rotated-access-token", result.Data.Value.AccessToken);
        Assert.Equal("rotated-refresh-token", result.Data.Value.RefreshToken);
        Assert.InRange(result.ExpiresAt, DateTime.UtcNow.AddDays(7).AddMinutes(-1), DateTime.UtcNow.AddDays(7).AddMinutes(1));
        Assert.True(result.ExpiresAt < absoluteExpiry);
        _ = db.Received(1).Queryable<UserSession>();
        await sessionQuery.Received(1).FirstAsync();
        await sessionUpdate.Received(1).ExecuteCommandAsync();
        Assert.Contains(measurements, measurement =>
            measurement.Name == "fsus.auth.refresh.success_db_command_count" && measurement.Value == 3);
        Assert.Contains(measurements, measurement =>
            measurement.Name == "fsus.auth.refresh.success_elapsed_ms" && measurement.Value >= 0);
        PropertyInfo refreshExpiry = Assert.IsAssignableFrom<PropertyInfo>(typeof(TokenResponseDto).GetProperty(nameof(TokenResponseDto.RefreshTokenExpiresAt)));
        Assert.Equal(typeof(DateTime?), refreshExpiry.PropertyType);
    }

    [Fact]
    public async Task VerifyRefreshRotationAsync_RequiresExactlyOneActiveSessionWithCurrentHash()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var sessionQuery = Substitute.For<ISugarQueryable<UserSession>>();
        db.Queryable<UserSession>().Returns(sessionQuery);
        Expression<Func<UserSession, bool>>? predicate = null;
        sessionQuery.Where(Arg.Do<Expression<Func<UserSession, bool>>>(value => predicate = value))
            .Returns(sessionQuery);
        sessionQuery.CountAsync().Returns(Task.FromResult(1));
        var facade = new UserSessionCommandService(BuildService(db, Substitute.For<IJwtHelper>()));

        bool verified = await facade.VerifyRefreshRotationAsync(
            "rotated-refresh-token",
            "rotated-session",
            CancellationToken.None);

        Assert.True(verified);
        Assert.NotNull(predicate);
        Func<UserSession, bool> matches = predicate.Compile();
        DateTime now = DateTime.UtcNow;
        Assert.True(matches(new UserSession
        {
            SessionId = "rotated-session",
            RefreshTokenHash = InvokePrivateStatic<string>("HashToken", ["rotated-refresh-token"]),
            IdleExpiresAt = now.AddMinutes(5),
            AbsoluteExpiresAt = now.AddDays(1)
        }));
        Assert.False(matches(new UserSession
        {
            SessionId = "rotated-session",
            RefreshTokenHash = InvokePrivateStatic<string>("HashToken", ["different-refresh-token"]),
            IdleExpiresAt = now.AddMinutes(5),
            AbsoluteExpiresAt = now.AddDays(1)
        }));
        await sessionQuery.Received(1).CountAsync();
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    public async Task VerifyRefreshRotationAsync_RejectsMissingOrAmbiguousRows(int matchCount)
    {
        var db = Substitute.For<ISqlSugarClient>();
        var sessionQuery = Substitute.For<ISugarQueryable<UserSession>>();
        db.Queryable<UserSession>().Returns(sessionQuery);
        sessionQuery.Where(Arg.Any<Expression<Func<UserSession, bool>>>()).Returns(sessionQuery);
        sessionQuery.CountAsync().Returns(Task.FromResult(matchCount));
        var facade = new UserSessionCommandService(BuildService(db, Substitute.For<IJwtHelper>()));

        bool verified = await facade.VerifyRefreshRotationAsync(
            "rotated-refresh-token",
            "rotated-session",
            CancellationToken.None);

        Assert.False(verified);
    }

    [Fact]
    public async Task RefreshTokenAsync_RotationConflictEmitsReplayMetricAndReturnsFailure()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var sessionQuery = Substitute.For<ISugarQueryable<UserSession>>();
        db.Queryable<UserSession>().Returns(sessionQuery);
        sessionQuery.Where(Arg.Any<Expression<Func<UserSession, bool>>>()).Returns(sessionQuery);
        var activeSession = new UserSession
        {
            SessionId = "replay-session",
            UserId = 42,
            RefreshTokenHash = "old-stored-hash",
            IdleExpiresAt = DateTime.UtcNow.AddHours(1),
            AbsoluteExpiresAt = DateTime.UtcNow.AddDays(1),
            MfaVerified = true
        };
        var newerSession = new UserSession
        {
            SessionId = activeSession.SessionId,
            UserId = activeSession.UserId,
            RefreshTokenHash = "newer-rotated-hash",
            IdleExpiresAt = activeSession.IdleExpiresAt,
            AbsoluteExpiresAt = activeSession.AbsoluteExpiresAt
        };
        sessionQuery.FirstAsync().Returns(Task.FromResult(activeSession));
        sessionQuery.FirstAsync(Arg.Any<Expression<Func<UserSession, bool>>>()).Returns(Task.FromResult(newerSession));
        var userQuery = Substitute.For<ISugarQueryable<User>>();
        db.Queryable<User>().Returns(userQuery);
        userQuery.InSingleAsync(42).Returns(Task.FromResult(new User { Id = 42, Status = 0 }));
        var update = Substitute.For<IUpdateable<UserSession>>();
        db.Updateable<UserSession>().Returns(update);
        update.SetColumns(Arg.Any<Expression<Func<UserSession, bool>>>()).Returns(update);
        update.Where(Arg.Any<Expression<Func<UserSession, bool>>>()).Returns(update);
        update.ExecuteCommandAsync().Returns(Task.FromResult(0));
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            await call.Arg<Func<Task>>()();
            return new DbResult<bool> { IsSuccess = true };
        });
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(_ => Task.FromResult((IDataReader)new DataTable().CreateDataReader()));
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("lost-race-refresh-token");
        jwt.GenerateAccessToken(Arg.Any<User>(), activeSession.SessionId, false)
            .Returns(new IssuedAccessToken("lost-race-access-token", DateTimeOffset.UtcNow.AddMinutes(15)));
        var measurements = new ConcurrentBag<(string Name, double Value)>();
        using MeterListener listener = ListenToFsusMeasurements(measurements);
        var service = BuildService(db, jwt);

        var result = await service.RefreshTokenAsync("old-refresh-token", activeSession.SessionId);

        Assert.False(result.Success);
        Assert.Null(result.Data);
        Assert.Contains(measurements, measurement =>
            measurement.Name == "fsus.auth.refresh.replay_detected_count" && measurement.Value == 1);
        Assert.Contains(measurements, measurement =>
            measurement.Name == "fsus.auth.refresh.family_revoke_count" && measurement.Value == 0);
        await update.Received(1).ExecuteCommandAsync();
    }

    [Fact]
    public void RefreshFamilyRevokeMetrics_ExposeClosedReplayWindowAndRevokedSessionCount()
    {
        var measurements = new ConcurrentBag<(string Name, double Value)>();
        using MeterListener listener = ListenToFsusMeasurements(measurements);

        FsusObservability.RecordAuthRefreshFamilyRevoke(2);

        Assert.Contains(measurements, measurement =>
            measurement.Name == "fsus.auth.refresh.family_revoke_count" && measurement.Value == 2);
        Assert.Contains(measurements, measurement =>
            measurement.Name == "fsus.auth.refresh.family_revoke_window_count" && measurement.Value == 1);
    }

    [Fact]
    [Trait("Category", "SecurityStateMachine")]
    public async Task CompleteLoginAsync_BannedUser_IssuesRestrictedSessionToken()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("refresh-token");
        DateTimeOffset accessTokenExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(15);
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), Arg.Any<bool>())
            .Returns(new IssuedAccessToken("access-token", accessTokenExpiresAtUtc));
        var persistence = ConfigureLoginPersistence(db);
        var svc = BuildService(db, jwt);
        var bannedUser = new User
        {
            Id = 42,
            Status = 1,
            AccountSubjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        };

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
        Assert.Equal(accessTokenExpiresAtUtc, data.Value.AccessTokenExpiresAtUtc);
        Assert.Equal("refresh-token", data.Value.RefreshToken);
        Assert.Same(bannedUser, userEntity);
        jwt.Received(1).GenerateRefreshToken();
        jwt.Received(1).GenerateAccessToken(bannedUser, Arg.Any<string>(), false);
        await persistence.SessionInsert.Received(1).ExecuteCommandAsync();
        await persistence.UserUpdate.DidNotReceive().ExecuteCommandAsync();
    }

    [Fact]
    [Trait("Category", "SecurityStateMachine")]
    public async Task CompleteLoginAsync_NormalUser_IssuesSessionToken()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("refresh-token");
        DateTimeOffset accessTokenExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(60);
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), Arg.Any<bool>())
            .Returns(new IssuedAccessToken("access-token", accessTokenExpiresAtUtc));
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
        Assert.Equal(accessTokenExpiresAtUtc, data.Value.AccessTokenExpiresAtUtc);
        Assert.Equal("refresh-token", data.Value.RefreshToken);
        Assert.Same(user, userEntity);
        jwt.Received(1).GenerateRefreshToken();
        jwt.Received(1).GenerateAccessToken(user, Arg.Any<string>(), true);
        await persistence.SessionInsert.Received(1).ExecuteCommandAsync();
        await persistence.UserUpdate.DidNotReceive().ExecuteCommandAsync();
    }

    [Fact]
    public async Task CompleteLoginAsync_UsesPostgresLockBulkRevocationAndInsertInOneTransaction()
    {
        var db = Substitute.For<ISqlSugarClient>();
        db.CurrentConnectionConfig.Returns(new ConnectionConfig { DbType = SqlSugar.DbType.PostgreSQL });
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        var sequence = new List<string>();
        string? revokeSql = null;
        SugarParameter[]? revokeParameters = null;
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            sequence.Add("transaction-begin");
            await call.Arg<Func<Task>>()();
            sequence.Add("transaction-commit");
            return new DbResult<bool> { IsSuccess = true };
        });
        ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(call =>
        {
            sequence.Add("advisory-lock");
            string sql = call.ArgAt<string>(0);
            SugarParameter[] parameters = call.ArgAt<SugarParameter[]>(1);
            Assert.Equal("SELECT pg_advisory_xact_lock(@LockNamespace, @UserId);", sql);
            Assert.Contains(parameters, parameter => parameter.ParameterName == "@UserId" && Equals(parameter.Value, 42));
            return Task.FromResult(1);
        });
        DateTime revokedAt = DateTime.UtcNow;
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(call =>
        {
            sequence.Add("bulk-revoke");
            revokeSql = call.ArgAt<string>(0);
            revokeParameters = call.ArgAt<SugarParameter[]>(1);
            return Task.FromResult((IDataReader)CreateRevokedSessionReader(
                "previous-session",
                42,
                revokedAt,
                "row-version-17"));
        });
        UserSession? inserted = null;
        var insert = Substitute.For<IInsertable<UserSession>>();
        db.Insertable(Arg.Do<UserSession>(session => inserted = session)).Returns(insert);
        insert.ExecuteCommandAsync().Returns(_ =>
        {
            sequence.Add("insert-new-session");
            return Task.FromResult(1);
        });
        var cache = Substitute.For<IUserSessionValidationCache>();
        IReadOnlyList<UserSessionValidationCacheState>? published = null;
        cache.PublishManyAsync(
                Arg.Do<IReadOnlyList<UserSessionValidationCacheState>>(states => published = states),
                true)
            .Returns(_ =>
            {
                sequence.Add("publish-revoked-fence");
                return Task.CompletedTask;
            });
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("new-refresh-token");
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), true)
            .Returns(new IssuedAccessToken("new-access-token", DateTimeOffset.UtcNow.AddMinutes(15)));
        var measurements = new ConcurrentBag<(string Name, double Value)>();
        using MeterListener listener = ListenToFsusMeasurements(measurements);
        var service = BuildService(
            db,
            jwt,
            Substitute.For<ITotpService>(),
            sessionValidationCache: cache);

        var result = await service.CompleteLoginAsync(
            new User { Id = 42, Status = 0, IdentityKind = AnonymousIdentityRuntime.AnonymousAccountKind },
            "127.0.0.1",
            "device-42",
            "agent-42",
            mfaVerified: true,
            rememberMe: false);

        Assert.True(result.Success, result.Message);
        Assert.Equal(
            new[]
            {
                "transaction-begin",
                "advisory-lock",
                "bulk-revoke",
                "insert-new-session",
                "publish-revoked-fence",
                "transaction-commit"
            },
            sequence);
        Assert.NotNull(revokeSql);
        Assert.Contains("UPDATE sys_user_session", revokeSql, StringComparison.Ordinal);
        Assert.Contains("revokereason = 'login_replaced'", revokeSql, StringComparison.Ordinal);
        Assert.Contains("WHERE userid = @UserId", revokeSql, StringComparison.Ordinal);
        Assert.Contains("AND revokedat IS NULL", revokeSql, StringComparison.Ordinal);
        Assert.Contains("RETURNING sessionid", revokeSql, StringComparison.Ordinal);
        Assert.Contains("xmin::text AS row_version", revokeSql, StringComparison.Ordinal);
        Assert.Contains(revokeParameters!, parameter => parameter.ParameterName == "@UserId" && Equals(parameter.Value, 42));
        Assert.NotNull(inserted);
        Assert.Equal(42, inserted!.UserId);
        Assert.NotEqual("previous-session", inserted.SessionId);
        Assert.NotNull(published);
        UserSessionValidationCacheState state = Assert.Single(published!);
        Assert.Equal("previous-session", state.SessionId);
        Assert.Equal("row-version-17", state.RowVersion);
        Assert.Contains(measurements, measurement =>
            measurement.Name == "fsus.auth.login.replaced_session_count" && measurement.Value == 1);
        Assert.Contains(measurements, measurement =>
            measurement.Name == "fsus.auth.login.session_revoke_command_count" && measurement.Value == 1);
        Assert.Contains(measurements, measurement =>
            measurement.Name == "fsus.auth.login.transaction_elapsed_ms" && measurement.Value >= 0);
    }

    [Fact]
    public async Task CompleteLoginAsync_TransactionFailureReturnsFailureWithoutPublishingSessionState()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(_ => Task.FromResult(new DbResult<bool>
        {
            IsSuccess = false,
            ErrorException = new InvalidOperationException("forced transaction failure")
        }));
        var cache = Substitute.For<IUserSessionValidationCache>();
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("discarded-refresh-token");
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), false)
            .Returns(new IssuedAccessToken("discarded-access-token", DateTimeOffset.UtcNow.AddMinutes(15)));
        var service = BuildService(
            db,
            jwt,
            Substitute.For<ITotpService>(),
            sessionValidationCache: cache);

        var result = await service.CompleteLoginAsync(
            new User { Id = 42, Status = 0 },
            "127.0.0.1",
            deviceFingerprint: null,
            userAgent: null,
            mfaVerified: false,
            rememberMe: false);

        Assert.False(result.Success);
        Assert.Equal("登录失败，请重试", result.Message);
        Assert.Null(result.Data);
        Assert.Null(result.UserEntity);
        _ = db.DidNotReceive().Insertable(Arg.Any<UserSession>());
        await cache.DidNotReceive().PublishManyAsync(
            Arg.Any<IReadOnlyList<UserSessionValidationCacheState>>(),
            Arg.Any<bool>());
    }

    [Fact]
    public async Task CompleteLoginAsync_CommitFailureInvalidatesPreCommitRevocationFence()
    {
        var db = Substitute.For<ISqlSugarClient>();
        db.CurrentConnectionConfig.Returns(new ConnectionConfig { DbType = SqlSugar.DbType.PostgreSQL });
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        var sequence = new List<string>();
        ado.UseTranAsync(Arg.Any<Func<Task>>()).Returns(async call =>
        {
            sequence.Add("transaction-begin");
            await call.Arg<Func<Task>>()();
            sequence.Add("transaction-commit-failed");
            return new DbResult<bool>
            {
                IsSuccess = false,
                ErrorException = new InvalidOperationException("forced commit failure")
            };
        });
        ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(_ =>
        {
            sequence.Add("advisory-lock");
            return Task.FromResult(1);
        });
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(_ =>
        {
            sequence.Add("database-revoke");
            return Task.FromResult((IDataReader)CreateRevokedSessionReader(
                "precommit-session",
                42,
                DateTime.UtcNow,
                "precommit-version"));
        });
        var insert = Substitute.For<IInsertable<UserSession>>();
        insert.ExecuteCommandAsync().Returns(_ =>
        {
            sequence.Add("insert-new-session");
            return Task.FromResult(1);
        });
        db.Insertable(Arg.Any<UserSession>()).Returns(insert);
        var cache = Substitute.For<IUserSessionValidationCache>();
        cache.PublishManyAsync(
                Arg.Any<IReadOnlyList<UserSessionValidationCacheState>>(),
                true)
            .Returns(_ =>
            {
                sequence.Add("publish-revoked-fence");
                return Task.CompletedTask;
            });
        IReadOnlyList<UserSessionValidationCacheState>? invalidated = null;
        cache.InvalidateManyAsync(
                Arg.Do<IReadOnlyList<UserSessionValidationCacheState>>(states => invalidated = states))
            .Returns(_ =>
            {
                sequence.Add("invalidate-precommit-fence");
                return Task.CompletedTask;
            });
        var jwt = Substitute.For<IJwtHelper>();
        jwt.GenerateRefreshToken().Returns("discarded-refresh-token");
        jwt.GenerateAccessToken(Arg.Any<User>(), Arg.Any<string>(), false)
            .Returns(new IssuedAccessToken("discarded-access-token", DateTimeOffset.UtcNow.AddMinutes(15)));
        var service = BuildService(
            db,
            jwt,
            Substitute.For<ITotpService>(),
            sessionValidationCache: cache);

        var result = await service.CompleteLoginAsync(
            new User { Id = 42, Status = 0 },
            "127.0.0.1",
            deviceFingerprint: null,
            userAgent: null,
            mfaVerified: false,
            rememberMe: false);

        Assert.False(result.Success);
        Assert.Equal(
            [
                "transaction-begin",
                "advisory-lock",
                "database-revoke",
                "insert-new-session",
                "publish-revoked-fence",
                "transaction-commit-failed",
                "invalidate-precommit-fence"
            ],
            sequence);
        UserSessionValidationCacheState invalidatedState = Assert.Single(invalidated!);
        Assert.Equal("precommit-session", invalidatedState.SessionId);
    }

    [Fact]
    public void UserSessionEntity_ExposesPostgresRowVersionForSessionRevocationGuards()
    {
        PropertyInfo rowVersion = Assert.IsAssignableFrom<PropertyInfo>(typeof(UserSession).GetProperty("RowVersion"));
        SugarColumn? column = rowVersion.GetCustomAttribute<SugarColumn>();

        Assert.Equal(typeof(string), rowVersion.PropertyType);
        Assert.NotNull(column);
        Assert.True(column!.IsIgnore);
    }

    [Fact]
    public void SchemaMigrationRegistry_UserSessionActiveUniqueIndex_BlocksTwoActiveSessions()
    {
        ISchemaMigrationDescriptor migration = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static descriptor => descriptor.MigrationId == "20260625-post-user-session-active-unique");
        string fingerprints = string.Join('\n', migration.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("ux_user_session_one_active_per_user", fingerprints, StringComparison.Ordinal);
        Assert.Contains("CREATE UNIQUE INDEX IF NOT EXISTS ux_user_session_one_active_per_user", fingerprints, StringComparison.Ordinal);
        Assert.Contains("ON sys_user_session(userid) WHERE revokedat IS NULL", fingerprints, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminChangeStatusAsync_CompiledTargetMetadataHasIdentityKindAndNoLegacyRole()
    {
        Assert.Null(typeof(User).GetProperty("LegacyProjectRole", BindingFlags.Instance | BindingFlags.Public));
        Assert.Null(typeof(User).GetProperty("Role", BindingFlags.Instance | BindingFlags.Public));
        PropertyInfo identityKind = Assert.IsAssignableFrom<PropertyInfo>(typeof(User).GetProperty(nameof(User.IdentityKind)));
        Assert.Equal(typeof(string), identityKind.PropertyType);

        Type target = Assert.IsAssignableFrom<Type>(typeof(UserService).GetNestedType("AdminStatusTarget", BindingFlags.NonPublic));
        PropertyInfo targetIdentityKind = Assert.IsAssignableFrom<PropertyInfo>(target.GetProperty("IdentityKind"));
        Assert.Equal(typeof(string), targetIdentityKind.PropertyType);
        Assert.Null(target.GetProperty("LegacyProjectRole"));
        Assert.Null(target.GetProperty("Role"));
    }

    [Fact]
    public async Task AdminChangeStatusAsync_AdminPrincipalIdentityKind_RejectsWithoutMutation()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(_ => Task.FromResult((IDataReader)CreateAdminStatusReader(
                42,
                AnonymousIdentityRuntime.AdminPrincipalKind,
                status: 0,
                deletedAt: null,
                rowVersion: "admin-row-version")));
        var blacklist = Substitute.For<IBlacklistService>();
        var service = BuildService(db, Substitute.For<IJwtHelper>(), blacklist);

        var result = await service.AdminChangeStatusAsync(new AdminChangeStatusDto
        {
            AccountId = 42,
            Status = 1,
            Reason = "must-not-apply"
        });

        Assert.False(result.Success);
        Assert.Equal("管理员主体不通过普通账号状态接口治理", result.Message);
        await ado.DidNotReceive().ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>());
        await blacklist.DidNotReceive().BanUserAsync(Arg.Any<int>(), Arg.Any<string>());
        await blacklist.DidNotReceive().UnbanUserAsync(Arg.Any<int>());
    }

    [Fact]
    public async Task AdminChangeStatusAsync_LoadCommandReadsIdentityKindAndPostgresRowVersionOnly()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        string? loadSql = null;
        SugarParameter[]? loadParameters = null;
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(call =>
        {
            loadSql = call.ArgAt<string>(0);
            loadParameters = call.ArgAt<SugarParameter[]>(1);
            return Task.FromResult((IDataReader)CreateAdminStatusReader(
                42,
                AnonymousIdentityRuntime.AdminPrincipalKind,
                status: 0,
                deletedAt: null,
                rowVersion: "admin-row-version"));
        });
        var service = BuildService(db, Substitute.For<IJwtHelper>());

        var result = await service.AdminChangeStatusAsync(new AdminChangeStatusDto { AccountId = 42, Status = 1 });

        Assert.False(result.Success);
        Assert.NotNull(loadSql);
        Assert.Contains("SELECT id", loadSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("identity_kind", loadSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("xmin::text AS row_version", loadSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("legacy", loadSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("role", loadSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(loadParameters!, parameter => parameter.ParameterName == "@AccountId" && Equals(parameter.Value, 42));
    }

    [Fact]
    public async Task AdminChangeStatusAsync_UpdateCommandUsesIdentityDeletionAndRowVersionGuards()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(_ => Task.FromResult((IDataReader)CreateAdminStatusReader(
                42,
                AnonymousIdentityRuntime.AnonymousAccountKind,
                status: 0,
                deletedAt: null,
                rowVersion: "row-version-42")));
        string? updateSql = null;
        SugarParameter[]? updateParameters = null;
        ado.ExecuteCommandAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>()).Returns(call =>
        {
            updateSql = call.ArgAt<string>(0);
            updateParameters = call.ArgAt<SugarParameter[]>(1);
            return Task.FromResult(1);
        });
        var blacklist = Substitute.For<IBlacklistService>();
        var service = BuildService(db, Substitute.For<IJwtHelper>(), blacklist);

        var result = await service.AdminChangeStatusAsync(new AdminChangeStatusDto
        {
            AccountId = 42,
            Status = 1,
            Reason = "policy"
        });

        Assert.True(result.Success, result.Message);
        Assert.NotNull(updateSql);
        Assert.Contains("UPDATE sys_user", updateSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("identity_kind = @IdentityKind", updateSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("deleted_at IS NULL", updateSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("status <> 2", updateSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("xmin::text = @RowVersion", updateSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(updateParameters!, parameter => parameter.ParameterName == "@AccountId" && Equals(parameter.Value, 42));
        Assert.Contains(updateParameters!, parameter => parameter.ParameterName == "@IdentityKind" && Equals(parameter.Value, AnonymousIdentityRuntime.AnonymousAccountKind));
        Assert.Contains(updateParameters!, parameter => parameter.ParameterName == "@Status" && Equals(parameter.Value, 1));
        Assert.Contains(updateParameters!, parameter => parameter.ParameterName == "@BanReason" && Equals(parameter.Value, "policy"));
        Assert.Contains(updateParameters!, parameter => parameter.ParameterName == "@RowVersion" && Equals(parameter.Value, "row-version-42"));
        _ = db.DidNotReceive().Updateable<User>();
        await blacklist.Received(1).BanUserAsync(42, "policy");
    }

    [Fact]
    public async Task LoggerMessages_CompiledMetadataAndRuntimeRequireStableAccountSubject()
    {
        AssertLoggerMessageMetadata(
            "LogRegistrationConflict",
            1,
            LogLevel.Warning,
            "匿名账号初始化竞态冲突 | AccountSubject: {AccountSubject}",
            ("accountSubject", typeof(string)));
        AssertLoggerMessageMetadata(
            "LogLoginFailure",
            2,
            LogLevel.Information,
            "登录验证未通过 | AccountSubject: {AccountSubject} | ClientIpHash: {ClientIpHash}",
            ("accountSubject", typeof(string)),
            ("clientIpHash", typeof(string)));
        AssertLoggerMessageMetadata(
            "LogBannedAccountLogin",
            3,
            LogLevel.Information,
            "封禁账号登录 | AccountSubject: {AccountSubject}",
            ("accountSubject", typeof(string)));
        AssertLoggerMessageMetadata(
            "LogBannedAccountTokenRefresh",
            5,
            LogLevel.Information,
            "受限账号执行令牌续期 | AccountSubject: {AccountSubject} | 状态: 只读模式",
            ("accountSubject", typeof(string)));

        Assert.Null(typeof(UserService).GetMethod("LogBannedUserLogin", BindingFlags.Instance | BindingFlags.NonPublic));
        Assert.Null(typeof(UserService).GetMethod("LogBannedUserTokenRefresh", BindingFlags.Instance | BindingFlags.NonPublic));

        var jwt = Substitute.For<IJwtHelper>();
        var service = BuildService(Substitute.For<ISqlSugarClient>(), jwt);
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.CompleteLoginAsync(
                new User
                {
                    Id = 42,
                    Status = 1,
                    AccountSubjectHash = null
                },
                "127.0.0.1",
                deviceFingerprint: null,
                userAgent: null,
                mfaVerified: false,
                rememberMe: false));
        Assert.Contains("login-restriction-audit", error.Message, StringComparison.Ordinal);
        jwt.DidNotReceive().GenerateRefreshToken();
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
    public void DeleteAccountContract_HasExplicitConfirmationAndNoLegacyUsernameOrPasswordSurface()
    {
        PropertyInfo confirmText = Assert.IsAssignableFrom<PropertyInfo>(
            typeof(DeleteAccountRequestDto).GetProperty(nameof(DeleteAccountRequestDto.ConfirmText)));
        Assert.Equal(typeof(string), confirmText.PropertyType);
        Assert.NotNull(confirmText.GetCustomAttribute<System.ComponentModel.DataAnnotations.RequiredAttribute>());
        Assert.Null(typeof(DeleteAccountRequestDto).GetProperty("Password"));
        Assert.Null(typeof(DeleteAccountRequestDto).GetProperty("Username"));
        Assert.Null(typeof(User).GetProperty("Username"));
        Assert.Null(typeof(User).GetProperty("LegacyUsername"));
        PropertyInfo publicHandle = Assert.IsAssignableFrom<PropertyInfo>(typeof(User).GetProperty(nameof(User.PublicHandle)));
        Assert.Equal(typeof(string), Nullable.GetUnderlyingType(publicHandle.PropertyType) ?? publicHandle.PropertyType);
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

    private static object? ReadAssignmentValue<T>(
        IReadOnlyList<Expression<Func<T, bool>>> assignments,
        string propertyName)
    {
        Expression<Func<T, bool>> assignment = Assert.Single(
            assignments,
            expression => AssignmentPropertyName(expression) == propertyName);
        BinaryExpression equality = Assert.IsAssignableFrom<BinaryExpression>(assignment.Body);
        return Expression.Lambda<Func<object?>>(
            Expression.Convert(equality.Right, typeof(object))).Compile()();
    }

    private static string AssignmentPropertyName<T>(Expression<Func<T, bool>> assignment)
    {
        BinaryExpression equality = Assert.IsAssignableFrom<BinaryExpression>(assignment.Body);
        Expression left = equality.Left;
        while (left is UnaryExpression unary && unary.NodeType is ExpressionType.Convert or ExpressionType.ConvertChecked)
        {
            left = unary.Operand;
        }

        return Assert.IsAssignableFrom<MemberExpression>(left).Member.Name;
    }

    private static string SugarColumnName<T>(string propertyName)
    {
        PropertyInfo property = Assert.IsAssignableFrom<PropertyInfo>(typeof(T).GetProperty(propertyName));
        SugarColumn column = Assert.IsType<SugarColumn>(property.GetCustomAttribute<SugarColumn>());
        return column.ColumnName;
    }

    private static IDataReader CreateRevokedSessionReader(
        string sessionId,
        int userId,
        DateTime revokedAt,
        string rowVersion)
    {
        var table = new DataTable();
        table.Columns.Add("sessionid", typeof(string));
        table.Columns.Add("userid", typeof(int));
        table.Columns.Add("revokedat", typeof(DateTime));
        table.Columns.Add("idleexpiresat", typeof(DateTime));
        table.Columns.Add("absoluteexpiresat", typeof(DateTime));
        table.Columns.Add("row_version", typeof(string));
        table.Rows.Add(
            sessionId,
            userId,
            revokedAt,
            revokedAt.AddHours(1),
            revokedAt.AddDays(1),
            rowVersion);
        return table.CreateDataReader();
    }

    private static IDataReader CreateAdminStatusReader(
        int accountId,
        string identityKind,
        int status,
        DateTime? deletedAt,
        string rowVersion)
    {
        var table = new DataTable();
        table.Columns.Add("id", typeof(int));
        table.Columns.Add("identity_kind", typeof(string));
        table.Columns.Add("status", typeof(int));
        table.Columns.Add("deleted_at", typeof(DateTime));
        table.Columns.Add("row_version", typeof(string));
        table.Rows.Add(accountId, identityKind, status, (object?)deletedAt ?? DBNull.Value, rowVersion);
        return table.CreateDataReader();
    }

    private static MeterListener ListenToFsusMeasurements(ConcurrentBag<(string Name, double Value)> measurements)
    {
        var listener = new MeterListener();
        listener.InstrumentPublished = static (instrument, state) =>
        {
            if (instrument.Meter.Name == FsusObservability.MeterName)
            {
                state.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, value, _, _) =>
            measurements.Add((instrument.Name, value)));
        listener.SetMeasurementEventCallback<double>((instrument, value, _, _) =>
            measurements.Add((instrument.Name, value)));
        listener.Start();
        return listener;
    }

    private static void AssertLoggerMessageMetadata(
        string methodName,
        int eventId,
        LogLevel level,
        string message,
        params (string Name, Type Type)[] expectedParameters)
    {
        MethodInfo method = Assert.IsAssignableFrom<MethodInfo>(
            typeof(UserService).GetMethod(methodName, BindingFlags.Instance | BindingFlags.NonPublic));
        LoggerMessageAttribute attribute = Assert.Single(method.GetCustomAttributes<LoggerMessageAttribute>());
        Assert.Equal(eventId, attribute.EventId);
        Assert.Equal(level, attribute.Level);
        Assert.Equal(message, attribute.Message);
        ParameterInfo[] parameters = method.GetParameters();
        Assert.Equal(expectedParameters.Length, parameters.Length);
        for (int index = 0; index < expectedParameters.Length; index++)
        {
            Assert.Equal(expectedParameters[index].Name, parameters[index].Name);
            Assert.Equal(expectedParameters[index].Type, parameters[index].ParameterType);
        }
    }
}
