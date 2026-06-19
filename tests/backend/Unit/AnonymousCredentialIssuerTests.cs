using System.Net;
using System.Security.Claims;
using System.Text;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Validation;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCredentialIssuerTests
{
    [Fact]
    public void Migration_CreatesIssuanceAuditWithoutCredentialMapping()
    {
        var registry = new SchemaMigrationRegistry();

        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260618-post-anonymous-credential-issuance-audit");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));
        string[] entityColumns = typeof(AnonymousCredentialIssuanceAudit)
            .GetProperties()
            .Select(static property => property.Name)
            .ToArray();

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("CREATE TABLE IF NOT EXISTS anonymous_credential_issuance_audit", fingerprint, StringComparison.Ordinal);
        Assert.Contains("user_id integer NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("epoch bigint NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("request_hash varchar(64) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("unique_idx_anonymous_credential_issuance_user_epoch", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("credential_commitment", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("commitment_hash", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("nullifier", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("witness", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("secret", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(entityColumns, static column => column.Contains("Commitment", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(entityColumns, static column => column.Contains("Nullifier", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(entityColumns, static column => column.Contains("Secret", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(entityColumns, static column => column.Contains("Witness", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void RuntimeServices_RegisterAnonymousCredentialIssuer()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeSecurityAndLifecycleServices(new ConfigurationBuilder().Build());

        ServiceDescriptor issuer = Assert.Single(
            services,
            static item => item.ServiceType == typeof(IAnonymousCredentialIssuerService));
        ServiceDescriptor store = Assert.Single(
            services,
            static item => item.ServiceType == typeof(IAnonymousCredentialIssuanceAuditStore));
        Assert.Equal(ServiceLifetime.Scoped, issuer.Lifetime);
        Assert.Equal(typeof(AnonymousCredentialIssuerService), issuer.ImplementationType);
        Assert.Equal(ServiceLifetime.Scoped, store.Lifetime);
        Assert.Equal(typeof(AnonymousCredentialIssuanceAuditStore), store.ImplementationType);
    }

    [Fact]
    public void AnonymousCredentialIssuerConfig_ExplicitlyRejectsBannedAccountsByDefault()
    {
        foreach (string relativePath in new[]
        {
            "src/backend/appsettings.json",
            "src/backend/appsettings.example.json",
            "src/backend/appsettings.Production.json",
            "src/backend/appsettings.Production.example.json"
        })
        {
            string source = BackendTestPaths.ReadAllTextFromRoot(relativePath);

            Assert.Contains("\"AnonymousCredentialIssuer\"", source, StringComparison.Ordinal);
            Assert.Contains("\"AllowBannedAccountIssuance\": false", source, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task IssueAsync_EligibleAccount_ReturnsCredentialResponseAndStoresOnlyIrreversibleAudit()
    {
        using SqlSugarClient db = CreateDb();
        CreateTables(db);
        SeedUser(db, status: 0);
        var auditEvents = new CapturingAuditEventService();
        var service = CreateService(db, auditEvents);
        AnonymousCredentialIssueRequestCoreModel request = CreateIssueRequest();

        Result<AnonymousCredentialIssueResponseCoreModel> issued = await service.IssueAsync(42, request, "trace-secret", CancellationToken.None);

        Assert.True(issued.IsSuccess, issued.Error.Message);
        AnonymousCredentialIssueResponseCoreModel response = issued.Value;
        Assert.Equal(request.CredentialEpoch, response.CredentialEpoch);
        Assert.Equal(request.CircuitNumericId, response.CircuitNumericId);
        Assert.Equal(request.PublicInputLayoutVersion, response.PublicInputLayoutVersion);
        Assert.Equal(AnonymousPrivacyContract.CircuitId, response.CircuitId);
        Assert.Equal(AnonymousCredentialLevels.StrongAnonymous, response.CredentialLevel);
        Assert.Equal("issuer_key:local", response.IssuerPublicKeyId);
        Assert.Equal(96, response.BbsSignature.Length);

        List<AnonymousCredentialIssuanceAudit> rows = await db.Queryable<AnonymousCredentialIssuanceAudit>().ToListAsync();
        AnonymousCredentialIssuanceAudit row = Assert.Single(rows);
        Assert.Equal(42, row.UserId);
        Assert.Equal(request.CredentialEpoch, row.Epoch);
        Assert.Equal(64, row.RequestHash.Length);
        Assert.Equal(AnonymousCredentialIssuanceStatuses.Issued, row.Status);
        string[] dbColumns = db.DbMaintenance.GetColumnInfosByTableName("anonymous_credential_issuance_audit")
            .Select(static column => column.DbColumnName)
            .ToArray();
        Assert.DoesNotContain(dbColumns, static column => column.Contains("credential_commitment", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(dbColumns, static column => column.Contains("nullifier", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(dbColumns, static column => column.Contains("secret", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(dbColumns, static column => column.Contains("witness", StringComparison.OrdinalIgnoreCase));

        AuditEvent audit = Assert.Single(auditEvents.Events);
        Assert.Equal(AuditActionCatalog.AnonymousCredentialIssued, audit.Action);
        Assert.Equal(AuditOutcomeCatalog.Success, audit.Outcome);
        Assert.NotNull(audit.Context);
        Assert.Equal(request.CredentialEpoch, audit.Context!["epoch"]);
        Assert.Equal(AnonymousCredentialIssuanceStatuses.Issued, audit.Context["status"]);
        string auditText = string.Join('|', audit.Context.Select(static item => $"{item.Key}:{item.Value}"));
        Assert.DoesNotContain("blind-request-raw", auditText, StringComparison.Ordinal);
        Assert.DoesNotContain("credential-secret-token", auditText, StringComparison.Ordinal);
        Assert.DoesNotContain("request_hash", auditText, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(Convert.ToHexString(response.BbsSignature), auditText, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task IssueAsync_DuplicateEpoch_ReturnsConflictAndDoesNotCreateSecondAuditRow()
    {
        using SqlSugarClient db = CreateDb();
        CreateTables(db);
        SeedUser(db, status: 0);
        var service = CreateService(db, new CapturingAuditEventService());
        AnonymousCredentialIssueRequestCoreModel request = CreateIssueRequest();

        Result<AnonymousCredentialIssueResponseCoreModel> first = await service.IssueAsync(42, request, "trace-1", CancellationToken.None);
        Result<AnonymousCredentialIssueResponseCoreModel> second = await service.IssueAsync(
            42,
            request with { ClientNonce = Encoding.UTF8.GetBytes("another-client-nonce") },
            "trace-2",
            CancellationToken.None);

        Assert.True(first.IsSuccess, first.Error.Message);
        Assert.True(second.IsFailure);
        Assert.Equal(ErrorCode.Conflict, second.Error.Code);
        Assert.Equal("anonymous_credential_issue_rate_limited", second.Error.Message);
        Assert.Equal(1, await db.Queryable<AnonymousCredentialIssuanceAudit>().CountAsync());
    }

    [Fact]
    public async Task IssueAsync_BannedAccountRequiresExplicitAllowConfiguration()
    {
        using SqlSugarClient db = CreateDb();
        CreateTables(db);
        SeedUser(db, status: 1);
        var denied = CreateService(db, new CapturingAuditEventService(), new Dictionary<string, string?>
        {
            ["AnonymousCredentialIssuer:AllowBannedAccountIssuance"] = "false"
        });
        var allowed = CreateService(db, new CapturingAuditEventService(), new Dictionary<string, string?>
        {
            ["AnonymousCredentialIssuer:AllowBannedAccountIssuance"] = "true"
        });

        Result<AnonymousCredentialIssueResponseCoreModel> deniedResult = await denied.IssueAsync(42, CreateIssueRequest(1042), "trace-denied", CancellationToken.None);
        Result<AnonymousCredentialIssueResponseCoreModel> allowedResult = await allowed.IssueAsync(42, CreateIssueRequest(1043), "trace-allowed", CancellationToken.None);

        Assert.True(deniedResult.IsFailure);
        Assert.Equal(ErrorCode.Forbidden, deniedResult.Error.Code);
        Assert.Equal("anonymous_credential_account_banned", deniedResult.Error.Message);
        Assert.True(allowedResult.IsSuccess, allowedResult.Error.Message);
    }

    [Fact]
    public async Task HandleAnonymousCredentialIssueAsync_AuthenticatedRequest_ReturnsIssueResponseFrame()
    {
        var aeds = new AedsEncoder();
        AnonymousCredentialIssueRequestCoreModel request = CreateIssueRequest();
        var context = CreateEndpointContext(
            AedsFrameType.AnonymousCredentialIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeAnonymousCredentialIssueRequest(request)),
            userId: 42);
        var issuer = new CapturingIssuerService
        {
            Result = Result<AnonymousCredentialIssueResponseCoreModel>.Success(CreateIssueResponse(request))
        };

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialIssueAsync(context, aeds, issuer, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.AnonymousCredentialIssueResponse, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCredentialIssueResponse(decoded.Payload, out AnonymousCredentialIssueResponseCoreModel response));
        Assert.Equal(request.CredentialEpoch, response.CredentialEpoch);
        Assert.Equal(42, issuer.UserId);
        Assert.Equal(request.BlindedCommitment, issuer.Request.BlindedCommitment);
        Assert.Equal(AnonymousCredentialIssuerLimits.MaxIssueRequestFrameBytes, context.RequestServices.GetRequiredService<FakeBinaryEndpointRequestContext>().MaxFrameBytes);
    }

    [Fact]
    public async Task HandleAnonymousCredentialIssueAsync_UnauthenticatedRequest_ReturnsApiError401()
    {
        var aeds = new AedsEncoder();
        var context = CreateEndpointContext(
            AedsFrameType.AnonymousCredentialIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeAnonymousCredentialIssueRequest(CreateIssueRequest())),
            userId: null);

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialIssueAsync(context, aeds, new CapturingIssuerService(), CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal(ErrorCode.Unauthorized, PodBinaryCodec.ToErrorDetail(errorPod).Code);
    }

    [Fact]
    public async Task HandleAnonymousCredentialIssueAsync_MalformedPayload_ReturnsApiError()
    {
        var aeds = new AedsEncoder();
        var context = CreateEndpointContext(
            AedsFrameType.AnonymousCredentialIssueRequest,
            BinaryRequestPayload.Success(new byte[] { 0x01, 0x02 }),
            userId: 42);

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialIssueAsync(context, aeds, new CapturingIssuerService(), CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("anonymous_credential_issue_request_invalid", PodBinaryCodec.ToErrorDetail(errorPod).Message);
    }

    [Fact]
    public void AnonymousCredentialIssueEndpoint_RequiresAuthRateLimitAndNoStore()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.AnonymousCredential.cs");

        Assert.Contains("MapPost(\"/anonymous-credential/issue\"", source, StringComparison.Ordinal);
        Assert.Contains(".RequireAuthorization()", source, StringComparison.Ordinal);
        Assert.Contains(".RequireRateLimiting(\"fixed_ip\")", source, StringComparison.Ordinal);
        Assert.Contains(".RequireNoStoreResponse()", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.AnonymousCredentialIssueRequest", source, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.AnonymousCredentialIssueResponse", source, StringComparison.Ordinal);
        Assert.Contains("AnonymousCredentialIssuerLimits.MaxIssueRequestFrameBytes", source, StringComparison.Ordinal);
    }

    private static AnonymousCredentialIssuerService CreateService(
        SqlSugarClient db,
        CapturingAuditEventService auditEvents,
        IReadOnlyDictionary<string, string?>? config = null)
        => new(
            db,
            new AnonymousCredentialIssuanceAuditStore(db),
            auditEvents,
            new ConfigurationBuilder()
                .AddInMemoryCollection(config ?? new Dictionary<string, string?>
                {
                    ["AnonymousCredentialIssuer:AllowBannedAccountIssuance"] = "false",
                    ["AnonymousCredentialIssuer:MaxBlindedRequestBytes"] = "8192",
                    ["AnonymousCredentialIssuer:MaxClientNonceBytes"] = "128",
                    ["AnonymousCredentialIssuer:EpochDurationMinutes"] = "1440",
                    ["AnonymousCredentialIssuer:CredentialTtlMinutes"] = "1440"
                })
                .Build());

    private static AnonymousCredentialIssueRequestCoreModel CreateIssueRequest(long epoch = 1042)
        => new(
            epoch,
            7,
            AnonymousPrivacyContract.PublicInputLayoutVersion,
            AnonymousPrivacyContract.CircuitId,
            AnonymousCredentialLevels.Basic,
            [.. Enumerable.Range(0, 64).Select(static value => (byte)value)],
            Encoding.UTF8.GetBytes("credential-secret-token"));

    private static AnonymousCredentialIssueResponseCoreModel CreateIssueResponse(AnonymousCredentialIssueRequestCoreModel request)
        => new(
            request.CredentialEpoch,
            DateTimeOffset.UtcNow.AddDays(1).ToUnixTimeMilliseconds(),
            request.CircuitNumericId,
            request.PublicInputLayoutVersion,
            request.CircuitId,
            AnonymousCredentialLevels.StrongAnonymous,
            "issuer-key:test",
            [.. Enumerable.Range(0, 96).Select(static value => (byte)value)]);

    private static SqlSugarClient CreateDb()
        => new(new ConnectionConfig
        {
            DbType = DbType.Sqlite,
            ConnectionString = $"Data Source={Path.Combine(Path.GetTempPath(), $"fsus-anonymous-credential-issuer-{Guid.NewGuid():N}.db")}",
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true
        });

    private static void CreateTables(SqlSugarClient db)
    {
        db.Ado.ExecuteCommand("""
            CREATE TABLE IF NOT EXISTS sys_user (
                Id INTEGER PRIMARY KEY,
                Status INTEGER NOT NULL,
                deleted_at TEXT NULL,
                anonymous_credential_level TEXT NOT NULL,
                anonymous_credential_status TEXT NOT NULL
            );
            """);
        db.Ado.ExecuteCommand("""
            CREATE TABLE IF NOT EXISTS anonymous_credential_issuance_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                epoch INTEGER NOT NULL,
                request_hash TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at_utc TEXT NOT NULL,
                trace_id TEXT NULL,
                UNIQUE(user_id, epoch)
            );
            """);
    }

    private static void SeedUser(SqlSugarClient db, int status)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO sys_user
                (Id, Status, deleted_at, anonymous_credential_level, anonymous_credential_status)
            VALUES
                (@Id, @Status, NULL, @Level, @CredentialStatus);
            """,
            new SugarParameter("@Id", 42),
            new SugarParameter("@Status", status),
            new SugarParameter("@Level", AnonymousCredentialLevels.StrongAnonymous),
            new SugarParameter("@CredentialStatus", AnonymousCredentialStatuses.Active));

    private static DefaultHttpContext CreateEndpointContext(
        AedsFrameType expectedFrameType,
        BinaryRequestPayload payload,
        int? userId)
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.TraceIdentifier = "trace-endpoint";
        context.Request.Headers.Accept = "application/octet-stream";
        if (userId.HasValue)
        {
            context.User = new ClaimsPrincipal(new ClaimsIdentity(
                [new Claim(ClaimTypes.NameIdentifier, userId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture))],
                "unit-test"));
        }

        var requestContext = new FakeBinaryEndpointRequestContext(expectedFrameType, payload);
        context.RequestServices = new ServiceCollection()
            .AddSingleton(requestContext)
            .AddSingleton<IBinaryEndpointRequestContext>(requestContext)
            .BuildServiceProvider();
        return context;
    }

    private static async Task<AedsDecodeResult> ExecuteAndDecodeAsync(BinaryFrameResult result, DefaultHttpContext context, AedsEncoder aeds)
    {
        await result.ExecuteAsync(context);
        byte[] frame = ((MemoryStream)context.Response.Body).ToArray();
        Result<AedsDecodeResult> decoded = aeds.TryDecode(frame);

        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }

    private sealed class CapturingAuditEventService : IAuditEventService
    {
        public List<AuditEvent> Events { get; } = [];

        public Task RecordAsync(AuditEvent auditEvent, CancellationToken cancellationToken = default)
        {
            Events.Add(auditEvent);
            return Task.CompletedTask;
        }

        public Task RecordHighValueAsync(AuditEvent auditEvent, CancellationToken cancellationToken = default)
        {
            Events.Add(auditEvent with { IsHighValue = true });
            return Task.CompletedTask;
        }
    }

    private sealed class CapturingIssuerService : IAnonymousCredentialIssuerService
    {
        public int UserId { get; private set; }
        public AnonymousCredentialIssueRequestCoreModel Request { get; private set; }
        public Result<AnonymousCredentialIssueResponseCoreModel> Result { get; init; } =
            Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Forbidden, "issuer_not_configured");

        public Task<Result<AnonymousCredentialIssueResponseCoreModel>> IssueAsync(
            int userId,
            AnonymousCredentialIssueRequestCoreModel request,
            string? traceId,
            CancellationToken cancellationToken = default)
        {
            UserId = userId;
            Request = request;
            return Task.FromResult(Result);
        }
    }

    private sealed class FakeBinaryEndpointRequestContext(
        AedsFrameType expectedFrameType,
        BinaryRequestPayload payload) : IBinaryEndpointRequestContext
    {
        public int? MaxFrameBytes { get; private set; }

        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expected,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
        {
            Assert.Equal(expectedFrameType, expected);
            MaxFrameBytes = maxFrameBytes;
            return Task.FromResult(payload);
        }

        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            IReadOnlyCollection<AedsFrameType> expected,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
        {
            Assert.Contains(expectedFrameType, expected);
            MaxFrameBytes = maxFrameBytes;
            return Task.FromResult(payload);
        }

        public Task<NameMutationPayload> ReadNameMutationAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expectedFrameType,
            CancellationToken cancellationToken)
            => throw new NotSupportedException();

        public string BuildArticleViewerIdentity(HttpContext context, int articleId)
            => throw new NotSupportedException();

        public ValueTask<long> GetArticleListCacheVersionAsync(IUnifiedCache cache)
            => throw new NotSupportedException();

        public string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string keyword = "")
            => throw new NotSupportedException();

        public string BuildArticleHotCacheIdentity(int count)
            => throw new NotSupportedException();

        public string? GetDeviceFingerprint(HttpContext context)
            => null;

        public bool TryReadMfaProof(HttpContext context, out string proofToken)
        {
            proofToken = string.Empty;
            return false;
        }
    }
}
