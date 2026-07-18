using System.Globalization;
using System.Net;
using System.Numerics;
using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Validation;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AnonymousCredentialIssuerTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly BigInteger CircuitNativeScalarOrder = BigInteger.Parse(
        "21888242871839275222246405745257275088548364400416034343698204186575808495617",
        CultureInfo.InvariantCulture);

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
        Assert.Contains("subject_hash varchar(64) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("epoch bigint NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("status varchar(32) NOT NULL DEFAULT 'issued'", fingerprint, StringComparison.Ordinal);
        Assert.Contains("unique_idx_anonymous_credential_issuance_subject_epoch", fingerprint, StringComparison.Ordinal);
        Assert.Contains("idx_anonymous_credential_issuance_subject", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_issuance_user_epoch", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("CREATE INDEX IF NOT EXISTS idx_anonymous_credential_issuance_user", fingerprint, StringComparison.Ordinal);
        Assert.Contains("anonymous_credential_issuance_audit.request_hash", fingerprint, StringComparison.Ordinal);
        Assert.Contains("anonymous_credential_issuance_audit.user_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("DROP INDEX IF EXISTS unique_idx_anonymous_credential_issuance_user_epoch", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain("request_hash varchar", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("user_id integer NOT NULL", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(entityColumns, static column => column.Contains("RequestHash", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(entityColumns, static column => column.Contains("UserId", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(entityColumns, static column => string.Equals(column, "SubjectHash", StringComparison.Ordinal));
        Assert.DoesNotContain("credential_commitment", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("commitment_hash", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("credential_request", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("issuer_signature", fingerprint, StringComparison.OrdinalIgnoreCase);
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
        Assert.Contains(
            services,
            static item => item.ServiceType == typeof(ICircuitNativeCredentialIssuer)
                && item.ImplementationType == typeof(UnavailableCircuitNativeCredentialIssuer)
                && item.Lifetime == ServiceLifetime.Singleton);
    }

    [Fact]
    public void AnonymousCredentialIssuerConfig_ExplicitlyRejectsBannedAccountsByDefault()
    {
        foreach (string[] configurationFiles in new[]
        {
            new[] { "src/backend/appsettings.json" },
            new[] { "src/backend/appsettings.json", "src/backend/appsettings.Development.example.json" },
            new[] { "src/backend/appsettings.json", "src/backend/appsettings.Production.json" }
        })
        {
            var configurationBuilder = new ConfigurationBuilder();
            foreach (string relativePath in configurationFiles)
            {
                configurationBuilder.AddJsonFile(
                    BackendTestPaths.FromRoot(relativePath),
                    optional: false,
                    reloadOnChange: false);
            }
            IConfiguration configuration = configurationBuilder.Build();

            Assert.False(configuration.GetValue<bool>("AnonymousCredentialIssuer:AllowBannedAccountIssuance"));
            Assert.NotNull(configuration["AnonymousCredentialIssuer:SubjectHashPepper"]);
            Assert.Equal("managed_circuit_native_v2", configuration["AnonymousCredentialIssuer:CircuitNative:Backend"]);
            Assert.False(configuration.GetValue<bool>("AnonymousCredentialIssuer:CircuitNative:Enabled"));
        }
    }

    [Fact]
    public async Task ProductionCircuitNativeCredentialIssuer_ConfiguredManagedBackend_SignsAndVerifiesCircuitNativeRequest()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), $"fsus-circuit-native-issuer-sign-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempRoot);
        try
        {
            byte[] privateKey = CreateManagedCircuitNativePrivateKey();
            byte[] publicKey = ManagedCircuitNativeCredentialSigner.DerivePublicKey(privateKey);
            IConfiguration configuration = CreateManagedCircuitNativeIssuerConfiguration(tempRoot, privateKey: privateKey);
            using var issuer = new ProductionCircuitNativeCredentialIssuer(
                configuration,
                NullLogger<ProductionCircuitNativeCredentialIssuer>.Instance);
            CircuitNativeCredentialIssueMaterial material = CreateManagedCircuitNativeIssueMaterial();

            Result<CircuitNativeCredentialIssueResult> issued = await issuer.SignAsync(material, CancellationToken.None);

            Assert.True(issuer.IsConfigured);
            Assert.True(issued.IsSuccess, issued.Error.Message);
            Assert.Equal("issuer-key:test", issued.Value.IssuerPublicKeyId);
            Assert.Equal(96, issued.Value.IssuerSignature.Length);
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(publicKey)), issuer.IssuerPublicKeyHash);
            Assert.True(ManagedCircuitNativeCredentialSigner.Verify(publicKey, material, issued.Value.IssuerSignature));
            Assert.False(ManagedCircuitNativeCredentialSigner.Verify(
                publicKey,
                material with
                {
                    CredentialEpoch = material.CredentialEpoch + 1
                },
                issued.Value.IssuerSignature));
            byte[] tamperedSignature = [.. issued.Value.IssuerSignature];
            tamperedSignature[^1] ^= 0x80;
            Assert.False(ManagedCircuitNativeCredentialSigner.Verify(publicKey, material, tamperedSignature));
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void ManagedCircuitNativeCredentialSigner_SignsLowSAndRejectsHighSResponse()
    {
        byte[] privateKey = CreateManagedCircuitNativePrivateKey();
        byte[] publicKey = ManagedCircuitNativeCredentialSigner.DerivePublicKey(privateKey);

        for (int i = 0; i < 4; i++)
        {
            CircuitNativeCredentialIssueMaterial material = CreateManagedCircuitNativeIssueMaterial() with
            {
                CredentialEpoch = 10_000 + i
            };
            byte[] signature = ManagedCircuitNativeCredentialSigner.Sign(privateKey, publicKey, material);
            BigInteger response = ReadSignatureResponse(signature);

            Assert.InRange(response, BigInteger.One, (CircuitNativeScalarOrder / 2) - BigInteger.One);
            Assert.True(ManagedCircuitNativeCredentialSigner.Verify(publicKey, material, signature));

            byte[] highSVariant = [.. signature];
            WriteSignatureResponse(CircuitNativeScalarOrder - response, highSVariant);
            Assert.False(ManagedCircuitNativeCredentialSigner.Verify(publicKey, material, highSVariant));
        }
    }

    [Fact]
    public void ManagedCircuitNativeCredentialSigner_VerifyRuntimeKeepsSubgroupChecksOnPublicKeyAndNoncePoint()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(ManagedCircuitNativeCredentialSigner),
            nameof(ManagedCircuitNativeCredentialSigner.Verify),
            "IsInPrimeOrderSubgroup",
            "MultiplyUnreduced",
            "ReadPublicKey");

        Assert.Contains("IsInPrimeOrderSubgroup", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("MultiplyUnreduced", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ReadPublicKey", runtimeShape, StringComparison.Ordinal);
        Assert.True(runtimeShape.Split("ReadPublicKey", StringSplitOptions.None).Length - 1 >= 2);
    }

    [Fact]
    public async Task ProductionCircuitNativeCredentialIssuer_ConfiguredManagedBackendWithoutPrivateKey_FailsClosed()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), $"fsus-circuit-native-issuer-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempRoot);
        try
        {
            IConfiguration configuration = CreateManagedCircuitNativeIssuerConfiguration(tempRoot, writePrivateKey: false);
            using var issuer = new ProductionCircuitNativeCredentialIssuer(
                configuration,
                NullLogger<ProductionCircuitNativeCredentialIssuer>.Instance);

            Result<CircuitNativeCredentialIssueResult> issued = await issuer.SignAsync(
                CreateManagedCircuitNativeIssueMaterial(),
                CancellationToken.None);

            Assert.False(issuer.IsConfigured);
            Assert.True(issued.IsFailure);
            Assert.Equal(ErrorCode.InfraFailure, issued.Error.Code);
            Assert.Equal("anonymous_credential_issuer_unavailable", issued.Error.Message);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task ProductionCircuitNativeCredentialIssuer_PublicKeyHashMismatch_FailsClosed()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), $"fsus-circuit-native-issuer-mismatch-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempRoot);
        try
        {
            IConfiguration configuration = CreateManagedCircuitNativeIssuerConfiguration(
                tempRoot,
                publicKeyHashOverride: new string('0', 64));
            using var issuer = new ProductionCircuitNativeCredentialIssuer(
                configuration,
                NullLogger<ProductionCircuitNativeCredentialIssuer>.Instance);

            Result<CircuitNativeCredentialIssueResult> issued = await issuer.SignAsync(
                CreateManagedCircuitNativeIssueMaterial(),
                CancellationToken.None);

            Assert.False(issuer.IsConfigured);
            Assert.True(issued.IsFailure);
            Assert.Equal(ErrorCode.InfraFailure, issued.Error.Code);
            Assert.Equal("anonymous_credential_issuer_unavailable", issued.Error.Message);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void ProductionCircuitNativeCredentialIssuer_WorldReadablePrivateKey_ThrowsOnStartup()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        string tempRoot = Path.Combine(Path.GetTempPath(), $"fsus-circuit-native-issuer-mode-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempRoot);
        try
        {
            IConfiguration configuration = CreateManagedCircuitNativeIssuerConfiguration(tempRoot);
            string privateKeyPath = configuration["AnonymousCredentialIssuer:CircuitNative:IssuerPrivateKeyPath"]!;
            File.SetUnixFileMode(
                privateKeyPath,
                UnixFileMode.UserRead |
                UnixFileMode.UserWrite |
                UnixFileMode.GroupRead |
                UnixFileMode.OtherRead);

            InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
                new ProductionCircuitNativeCredentialIssuer(
                    configuration,
                    NullLogger<ProductionCircuitNativeCredentialIssuer>.Instance));

            Assert.Contains("IssuerPrivateKeyPath", error.Message, StringComparison.Ordinal);
            Assert.Contains("0600", error.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void ProductionCircuitNativeCredentialIssuer_PrivateKeyUnderWwwroot_ThrowsOnStartup()
    {
        string tempRoot = Path.Combine(Path.GetTempPath(), $"fsus-circuit-native-issuer-wwwroot-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempRoot);
        try
        {
            IConfiguration configuration = CreateManagedCircuitNativeIssuerConfiguration(
                tempRoot,
                privateKeyPathOverride: Path.Combine(tempRoot, "wwwroot", "issuer.sk"));

            InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
                new ProductionCircuitNativeCredentialIssuer(
                    configuration,
                    NullLogger<ProductionCircuitNativeCredentialIssuer>.Instance));

            Assert.Contains("IssuerPrivateKeyPath", error.Message, StringComparison.Ordinal);
            Assert.Contains("wwwroot", error.Message, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void ProductionCircuitNativeCredentialIssuer_RuntimeUsesBoundedConcurrencyAndDoesNotLogPayloads()
    {
        FieldInfo signatureSlots = typeof(ProductionCircuitNativeCredentialIssuer).GetField(
            "_signatureSlots",
            BindingFlags.Instance | BindingFlags.NonPublic)!;
        Assert.Equal(typeof(SemaphoreSlim), signatureSlots.FieldType);
        Assert.NotNull(typeof(CircuitNativeCredentialIssuerOptions).GetProperty("MaxConcurrentSignatures"));

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(ProductionCircuitNativeCredentialIssuer),
            nameof(ProductionCircuitNativeCredentialIssuer.SignAsync));

        Assert.Contains("SemaphoreSlim.WaitAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("get_TimeoutMs", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("LogInformation", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("LogDebug", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("get_CredentialRequest", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("signature}", runtimeShape, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task IssueAsync_EligibleAccount_ReturnsCredentialResponseAndStoresOnlyIrreversibleAudit()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedUser(db, status: 0);
        var auditEvents = new CapturingAuditEventService();
        var credentialIssuer = new CapturingCircuitNativeCredentialIssuer();
        var service = CreateService(db, auditEvents, credentialIssuer: credentialIssuer);
        AnonymousCredentialIssueRequestCoreModel request = CreateIssueRequest();

        Result<AnonymousCredentialIssueResponseCoreModel> issued = await service.IssueAsync(42, request, "trace-secret", CancellationToken.None);

        Assert.True(issued.IsSuccess, issued.Error.Message);
        AnonymousCredentialIssueResponseCoreModel response = issued.Value;
        Assert.Equal(request.CredentialEpoch, response.CredentialEpoch);
        Assert.Equal(request.CircuitNumericId, response.CircuitNumericId);
        Assert.Equal(request.PublicInputLayoutVersion, response.PublicInputLayoutVersion);
        Assert.Equal(AnonymousPrivacyContract.CircuitId, response.CircuitId);
        Assert.Equal(AnonymousCredentialLevels.StrongAnonymous, response.CredentialLevel);
        Assert.Equal(credentialIssuer.IssuerPublicKeyId, response.IssuerPublicKeyId);
        Assert.Equal(96, response.IssuerSignature.Length);
        Assert.Single(credentialIssuer.Requests);
        CircuitNativeCredentialIssueMaterial signedMaterial = credentialIssuer.Requests[0];
        Assert.Equal(request.CredentialEpoch, signedMaterial.CredentialEpoch);
        Assert.Equal(request.CredentialRequest, signedMaterial.CredentialRequest);
        Assert.DoesNotContain(
            Convert.ToHexString(request.ClientNonce),
            Convert.ToHexString(signedMaterial.CredentialRequest),
            StringComparison.OrdinalIgnoreCase);
        Assert.True(credentialIssuer.VerifyIssuerSignature(signedMaterial, response.IssuerSignature));

        List<AnonymousCredentialIssuanceAudit> rows = await db.Queryable<AnonymousCredentialIssuanceAudit>().ToListAsync();
        AnonymousCredentialIssuanceAudit row = Assert.Single(rows);
        Assert.Equal(64, row.SubjectHash.Length);
        Assert.NotEqual("42", row.SubjectHash);
        Assert.Equal(request.CredentialEpoch, row.Epoch);
        Assert.Equal(AnonymousCredentialIssuanceStatuses.Issued, row.Status);
        string[] dbColumns = db.DbMaintenance.GetColumnInfosByTableName("anonymous_credential_issuance_audit")
            .Select(static column => column.DbColumnName)
            .ToArray();
        Assert.Contains("subject_hash", dbColumns);
        Assert.DoesNotContain("user_id", dbColumns);
        Assert.DoesNotContain(dbColumns, static column => column.Contains("request_hash", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(dbColumns, static column => column.Contains("credential_commitment", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(dbColumns, static column => column.Contains("credential_request", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(dbColumns, static column => column.Contains("issuer_signature", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(dbColumns, static column => column.Contains("nullifier", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(dbColumns, static column => column.Contains("secret", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(dbColumns, static column => column.Contains("witness", StringComparison.OrdinalIgnoreCase));

        Assert.Empty(auditEvents.Events);
    }

    [Fact]
    public async Task IssueAsync_SameAccountAcrossEpochs_ProducesUnlinkableCircuitNativeSignaturesWithoutStoredLinkingMaterial()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedUser(db, status: 0);
        var auditEvents = new CapturingAuditEventService();
        var credentialIssuer = new CapturingCircuitNativeCredentialIssuer();
        var service = CreateService(db, auditEvents, credentialIssuer: credentialIssuer);

        AnonymousCredentialIssueRequestCoreModel firstRequest = CreateIssueRequest(epoch: 2042) with
        {
            CredentialRequest = Enumerable.Range(0, 64).Select(static value => (byte)(value + 1)).ToArray(),
            ClientNonce = Encoding.UTF8.GetBytes("client-opening-secret-a")
        };
        AnonymousCredentialIssueRequestCoreModel secondRequest = CreateIssueRequest(epoch: 2043) with
        {
            CredentialRequest = Enumerable.Range(0, 64).Select(static value => (byte)(255 - value)).ToArray(),
            ClientNonce = Encoding.UTF8.GetBytes("client-opening-secret-b")
        };

        Result<AnonymousCredentialIssueResponseCoreModel> first = await service.IssueAsync(42, firstRequest, "trace-1", CancellationToken.None);
        Result<AnonymousCredentialIssueResponseCoreModel> second = await service.IssueAsync(42, secondRequest, "trace-2", CancellationToken.None);

        Assert.True(first.IsSuccess, first.Error.Message);
        Assert.True(second.IsSuccess, second.Error.Message);
        Assert.NotEqual(Convert.ToHexString(first.Value.IssuerSignature), Convert.ToHexString(second.Value.IssuerSignature));
        Assert.Equal(2, credentialIssuer.Requests.Count);
        Assert.True(credentialIssuer.VerifyIssuerSignature(credentialIssuer.Requests[0], first.Value.IssuerSignature));
        Assert.True(credentialIssuer.VerifyIssuerSignature(credentialIssuer.Requests[1], second.Value.IssuerSignature));

        List<AnonymousCredentialIssuanceAudit> rows = await db.Queryable<AnonymousCredentialIssuanceAudit>()
            .OrderBy(static row => row.Epoch)
            .ToListAsync();
        Assert.Equal([2042, 2043], rows.Select(static row => row.Epoch).ToArray());
        foreach (AuditEvent audit in auditEvents.Events)
        {
            string auditText = string.Join('|', audit.Context?.Select(static item => $"{item.Key}:{item.Value}") ?? []);
            Assert.DoesNotContain(Convert.ToHexString(firstRequest.CredentialRequest), auditText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(Convert.ToHexString(secondRequest.CredentialRequest), auditText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(Convert.ToHexString(first.Value.IssuerSignature), auditText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain(Convert.ToHexString(second.Value.IssuerSignature), auditText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("request_hash", auditText, StringComparison.OrdinalIgnoreCase);
        }
    }

    [Fact]
    public async Task IssueAsync_DuplicateEpoch_ReturnsConflictAndDoesNotCreateSecondAuditRow()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedUser(db, status: 0);
        var service = CreateService(db, new CapturingAuditEventService(), credentialIssuer: new CapturingCircuitNativeCredentialIssuer());
        AnonymousCredentialIssueRequestCoreModel request = CreateIssueRequest();

        Result<AnonymousCredentialIssueResponseCoreModel> first = await service.IssueAsync(42, request, "trace-1", CancellationToken.None);
        Result<AnonymousCredentialIssueResponseCoreModel> second = await service.IssueAsync(
            42,
            request with
            {
                ClientNonce = Encoding.UTF8.GetBytes("another-client-nonce")
            },
            "trace-2",
            CancellationToken.None);

        Assert.True(first.IsSuccess, first.Error.Message);
        Assert.True(second.IsFailure);
        Assert.Equal(ErrorCode.Conflict, second.Error.Code);
        Assert.Equal("anonymous_credential_issue_rate_limited", second.Error.Message);
        Assert.Equal(1, await db.Queryable<AnonymousCredentialIssuanceAudit>().CountAsync());
    }

    [Fact]
    public async Task IssueAsync_RejectsIssuerSignatureThatFailsServerSideVerification()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedUser(db, status: 0);
        var credentialIssuer = new CapturingCircuitNativeCredentialIssuer { ForceVerifyFailure = true };
        var service = CreateService(db, new CapturingAuditEventService(), credentialIssuer: credentialIssuer);

        Result<AnonymousCredentialIssueResponseCoreModel> result = await service.IssueAsync(
            42,
            CreateIssueRequest(),
            "trace-invalid-signature",
            CancellationToken.None);

        Assert.True(result.IsFailure);
        Assert.Equal(ErrorCode.InfraFailure, result.Error.Code);
        Assert.Equal("anonymous_credential_issuer_unavailable", result.Error.Message);
        Assert.Empty(await db.Queryable<AnonymousCredentialIssuanceAudit>().ToListAsync());
    }

    [Fact]
    public async Task IssuerService_VerifiesReturnedIssuerSignatureBeforePersistingAudit()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedUser(db, status: 0);
        var credentialIssuer = new CapturingCircuitNativeCredentialIssuer { ForceVerifyFailure = true };
        var service = CreateService(db, new CapturingAuditEventService(), credentialIssuer: credentialIssuer);

        Result<AnonymousCredentialIssueResponseCoreModel> result = await service.IssueAsync(
            42,
            CreateIssueRequest(),
            "trace-verify-before-persist",
            CancellationToken.None);

        Assert.True(result.IsFailure);
        Assert.Equal("anonymous_credential_issuer_unavailable", result.Error.Message);
        Assert.Empty(await db.Queryable<AnonymousCredentialIssuanceAudit>().ToListAsync());
    }

    [Fact]
    public async Task IssuerService_SuccessPathUsesIssuanceAuditRowWithoutSecondHighValueAuditInsert()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedUser(db, status: 0);
        var auditEvents = new CapturingAuditEventService();
        var service = CreateService(
            db,
            auditEvents,
            credentialIssuer: new CapturingCircuitNativeCredentialIssuer());

        Result<AnonymousCredentialIssueResponseCoreModel> result = await service.IssueAsync(
            42,
            CreateIssueRequest(),
            "trace-success-audit",
            CancellationToken.None);

        Assert.True(result.IsSuccess, result.Error.Message);
        Assert.Single(await db.Queryable<AnonymousCredentialIssuanceAudit>().ToListAsync());
        Assert.Empty(auditEvents.Events);
    }

    [Fact]
    public async Task IssueAsync_DifferentAccountsSameEpoch_UseDifferentSubjectHashesAndBothIssue()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedUser(db, id: 42, status: 0);
        SeedUser(db, id: 43, status: 0);
        var service = CreateService(db, new CapturingAuditEventService(), credentialIssuer: new CapturingCircuitNativeCredentialIssuer());
        AnonymousCredentialIssueRequestCoreModel request = CreateIssueRequest(epoch: 2042);

        Result<AnonymousCredentialIssueResponseCoreModel> first = await service.IssueAsync(42, request, "trace-42", CancellationToken.None);
        Result<AnonymousCredentialIssueResponseCoreModel> second = await service.IssueAsync(43, request, "trace-43", CancellationToken.None);

        Assert.True(first.IsSuccess, first.Error.Message);
        Assert.True(second.IsSuccess, second.Error.Message);
        List<AnonymousCredentialIssuanceAudit> rows = await db.Queryable<AnonymousCredentialIssuanceAudit>()
            .OrderBy(static row => row.SubjectHash)
            .ToListAsync();
        Assert.Equal(2, rows.Count);
        Assert.All(rows, static row => Assert.Equal(64, row.SubjectHash.Length));
        Assert.NotEqual(rows[0].SubjectHash, rows[1].SubjectHash);
        Assert.All(rows, row => Assert.Equal(2042, row.Epoch));
    }

    [Fact]
    public async Task IssueAsync_RejectsSlidingWindowBurstAcrossManyEpochs()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedUser(db, status: 0);
        var service = CreateService(db, new CapturingAuditEventService(), credentialIssuer: new CapturingCircuitNativeCredentialIssuer());

        Result<AnonymousCredentialIssueResponseCoreModel> first = await service.IssueAsync(42, CreateIssueRequest(epoch: 3042), "trace-1", CancellationToken.None);
        Result<AnonymousCredentialIssueResponseCoreModel> second = await service.IssueAsync(42, CreateIssueRequest(epoch: 3043), "trace-2", CancellationToken.None);
        Result<AnonymousCredentialIssueResponseCoreModel> third = await service.IssueAsync(42, CreateIssueRequest(epoch: 3044), "trace-3", CancellationToken.None);

        Assert.True(first.IsSuccess, first.Error.Message);
        Assert.True(second.IsSuccess, second.Error.Message);
        Assert.True(third.IsFailure);
        Assert.Equal(ErrorCode.Conflict, third.Error.Code);
        Assert.Equal("anonymous_credential_issue_rate_limited", third.Error.Message);
        Assert.Equal(2, await db.Queryable<AnonymousCredentialIssuanceAudit>()
            .Where(static row => row.Status == AnonymousCredentialIssuanceStatuses.Issued)
            .CountAsync());
    }

    [Fact]
    public void IssuerService_RuntimeContractDoesNotWriteRawUserIdToIssuanceStoreOrHighValueAudit()
    {
        string[] entityProperties = typeof(AnonymousCredentialIssuanceAudit)
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(static property => property.Name)
            .ToArray();
        string[] writeProperties = typeof(AnonymousCredentialIssuanceAuditWrite)
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(static property => property.Name)
            .ToArray();
        Assert.DoesNotContain("UserId", entityProperties);
        Assert.DoesNotContain("UserId", writeProperties);
        Assert.Contains("SubjectHash", entityProperties);
        Assert.Contains("SubjectHash", writeProperties);

        string storeShape = RuntimeMetadataInspection.DescribeType(typeof(AnonymousCredentialIssuanceAuditStore));
        Assert.DoesNotContain("user_id", storeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("subject_hash", storeShape, StringComparison.OrdinalIgnoreCase);
        string issuerShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(AnonymousCredentialIssuerService),
            "RecordIssuanceAuditAsync",
            "ShortSubjectHash");
        Assert.Contains("ShortSubjectHash", issuerShape, StringComparison.Ordinal);
    }

    [Fact]
    public async Task IssuerService_RuntimeRequiresIndependentSubjectHashPepperWithoutFallbacks()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedUser(db, status: 0);
        foreach (IReadOnlyDictionary<string, string?> values in new[]
        {
            new Dictionary<string, string?> { ["Jwt:SecretKey"] = new string('j', 64) },
            new Dictionary<string, string?> { ["AnonymousCredentialIssuer:SubjectHashPepper"] = "too-short" }
        })
        {
            IConfiguration configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
            var service = new AnonymousCredentialIssuerService(
                db,
                new AnonymousCredentialIssuanceAuditStore(db),
                new CapturingCircuitNativeCredentialIssuer(),
                new CapturingAuditEventService(),
                configuration);

            InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                service.IssueAsync(42, CreateIssueRequest(), "trace-pepper", CancellationToken.None));
            Assert.Contains("AnonymousCredentialIssuer:SubjectHashPepper", error.Message, StringComparison.Ordinal);
            Assert.Contains("at least 32 characters", error.Message, StringComparison.Ordinal);
        }
    }

    [Fact]
    public async Task LogCleanupService_AnonymousCredentialIssuanceAuditRetentionDeletesRowsOlderThan90Days()
    {
        using SqlSugarClient db = await CreateDbAsync();
        PostgresSqlSugarTestClient.InitTables(db, typeof(AnonymousCredentialIssuanceAudit));
        await db.Insertable(new[]
        {
            new AnonymousCredentialIssuanceAudit
            {
                SubjectHash = HashSubject("expired-subject"),
                Epoch = 1001,
                Status = AnonymousCredentialIssuanceStatuses.Issued,
                CreatedAtUtc = new DateTime(2026, 3, 25, 23, 0, 0, DateTimeKind.Utc)
            },
            new AnonymousCredentialIssuanceAudit
            {
                SubjectHash = HashSubject("retained-subject"),
                Epoch = 1002,
                Status = AnonymousCredentialIssuanceStatuses.Issued,
                CreatedAtUtc = new DateTime(2026, 3, 26, 0, 0, 0, DateTimeKind.Utc)
            }
        }).ExecuteCommandAsync();

        int deleted = await LogCleanupService.CleanupAnonymousCredentialIssuanceAuditAsync(
            db,
            new DateTime(2026, 3, 26, 0, 0, 0, DateTimeKind.Utc),
            CancellationToken.None);

        Assert.Equal(1, deleted);
        List<AnonymousCredentialIssuanceAudit> rows = await db.Queryable<AnonymousCredentialIssuanceAudit>()
            .OrderBy(static row => row.Epoch)
            .ToListAsync();
        AnonymousCredentialIssuanceAudit retained = Assert.Single(rows);
        Assert.Equal(1002, retained.Epoch);
        Assert.Equal(new DateTime(2026, 3, 26, 0, 0, 0, DateTimeKind.Utc), retained.CreatedAtUtc);
    }

    [Fact]
    public async Task IssueAsync_BannedAccountRequiresExplicitAllowConfiguration()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedUser(db, status: 1);
        var denied = CreateService(db, new CapturingAuditEventService(), new Dictionary<string, string?>
        {
            ["AnonymousCredentialIssuer:AllowBannedAccountIssuance"] = "false"
        }, new CapturingCircuitNativeCredentialIssuer());
        var allowed = CreateService(db, new CapturingAuditEventService(), new Dictionary<string, string?>
        {
            ["AnonymousCredentialIssuer:AllowBannedAccountIssuance"] = "true"
        }, new CapturingCircuitNativeCredentialIssuer());

        Result<AnonymousCredentialIssueResponseCoreModel> deniedResult = await denied.IssueAsync(42, CreateIssueRequest(1042), "trace-denied", CancellationToken.None);
        Result<AnonymousCredentialIssueResponseCoreModel> allowedResult = await allowed.IssueAsync(42, CreateIssueRequest(1043), "trace-allowed", CancellationToken.None);

        Assert.True(deniedResult.IsFailure);
        Assert.Equal(ErrorCode.Forbidden, deniedResult.Error.Code);
        Assert.Equal("anonymous_credential_account_banned", deniedResult.Error.Message);
        Assert.True(allowedResult.IsSuccess, allowedResult.Error.Message);
    }

    [Fact]
    public async Task IssueAsync_InactiveCredentialStatusIsRejectedBeforeCircuitNativeSigning()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedUser(db, status: 0, credentialStatus: "disabled");
        var credentialIssuer = new CapturingCircuitNativeCredentialIssuer();
        var service = CreateService(db, new CapturingAuditEventService(), credentialIssuer: credentialIssuer);

        Result<AnonymousCredentialIssueResponseCoreModel> result = await service.IssueAsync(42, CreateIssueRequest(), "trace-disabled", CancellationToken.None);

        Assert.True(result.IsFailure);
        Assert.Equal(ErrorCode.Forbidden, result.Error.Code);
        Assert.Equal("anonymous_credential_disabled", result.Error.Message);
        Assert.Empty(credentialIssuer.Requests);
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

        var users = new StubUserAccountReader(CreateAccountSnapshot(42));
        var auditEvents = new CapturingAuditEventService();

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialIssueAsync(context, aeds, issuer, users, auditEvents, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.AnonymousCredentialIssueResponse, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeAnonymousCredentialIssueResponse(decoded.Payload, out AnonymousCredentialIssueResponseCoreModel response));
        Assert.Equal(request.CredentialEpoch, response.CredentialEpoch);
        Assert.Equal(42, issuer.UserId);
        Assert.Equal(request.CredentialRequest, issuer.Request.CredentialRequest);
        Assert.Equal(AnonymousCredentialIssuerLimits.MaxIssueRequestFrameBytes, context.RequestServices.GetRequiredService<FakeBinaryEndpointRequestContext>().MaxFrameBytes);
        Assert.Equal([42], users.RequestedIds);
        Assert.Empty(auditEvents.Events);
    }

    [Fact]
    public async Task HandleAnonymousCredentialIssueAsync_UnauthenticatedRequest_ReturnsApiError401()
    {
        var aeds = new AedsEncoder();
        var context = CreateEndpointContext(
            AedsFrameType.AnonymousCredentialIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeAnonymousCredentialIssueRequest(CreateIssueRequest())),
            userId: null);

        var issuer = new CapturingIssuerService();
        var users = new StubUserAccountReader(CreateAccountSnapshot(42));
        var auditEvents = new CapturingAuditEventService();

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialIssueAsync(context, aeds, issuer, users, auditEvents, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal(ErrorCode.Unauthorized, PodBinaryCodec.ToErrorDetail(errorPod).Code);
        Assert.Equal(0, issuer.CallCount);
        Assert.Empty(users.RequestedIds);
        Assert.Empty(auditEvents.Events);
    }

    [Fact]
    public async Task HandleAnonymousCredentialIssueAsync_AdminPrincipalCollision_ReturnsForbiddenWithoutIssuer()
    {
        var aeds = new AedsEncoder();
        var context = CreateEndpointContext(
            AedsFrameType.AnonymousCredentialIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeAnonymousCredentialIssueRequest(CreateIssueRequest())),
            userId: 1,
            identityKind: AnonymousIdentityRuntime.AdminPrincipalKind);
        var issuer = new CapturingIssuerService
        {
            Result = Result<AnonymousCredentialIssueResponseCoreModel>.Success(CreateIssueResponse(CreateIssueRequest()))
        };
        var users = new StubUserAccountReader(CreateAccountSnapshot(1));
        var auditEvents = new CapturingAuditEventService();

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialIssueAsync(context, aeds, issuer, users, auditEvents, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status403Forbidden, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        ErrorDetail error = PodBinaryCodec.ToErrorDetail(errorPod);
        Assert.Equal(ErrorCode.Forbidden, error.Code);
        Assert.Equal("anonymous_credential_anonymous_account_required", error.Message);
        Assert.Equal(0, issuer.CallCount);
        Assert.Empty(users.RequestedIds);
        AuditEvent audit = Assert.Single(auditEvents.Events);
        Assert.True(audit.IsHighValue);
        Assert.Equal(AuditOutcomeCatalog.Denied, audit.Outcome);
        Assert.Equal("admin_principal_rejected", audit.ReasonCode);
    }

    [Fact]
    public async Task HandleAnonymousCredentialIssueAsync_MissingIdentityKind_ReturnsForbiddenWithoutIssuer()
    {
        var aeds = new AedsEncoder();
        var context = CreateEndpointContext(
            AedsFrameType.AnonymousCredentialIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeAnonymousCredentialIssueRequest(CreateIssueRequest())),
            userId: 42,
            identityKind: null);
        var issuer = new CapturingIssuerService();
        var users = new StubUserAccountReader(CreateAccountSnapshot(42));
        var auditEvents = new CapturingAuditEventService();

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialIssueAsync(context, aeds, issuer, users, auditEvents, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status403Forbidden, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal(ErrorCode.Forbidden, PodBinaryCodec.ToErrorDetail(errorPod).Code);
        Assert.Equal(0, issuer.CallCount);
        Assert.Empty(users.RequestedIds);
        Assert.Equal("identity_kind_missing", Assert.Single(auditEvents.Events).ReasonCode);
    }

    [Fact]
    public async Task HandleAnonymousCredentialIssueAsync_InactiveCredentialStatus_ReturnsForbiddenWithoutIssuer()
    {
        var aeds = new AedsEncoder();
        var context = CreateEndpointContext(
            AedsFrameType.AnonymousCredentialIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeAnonymousCredentialIssueRequest(CreateIssueRequest())),
            userId: 42);
        var issuer = new CapturingIssuerService();
        var users = new StubUserAccountReader(CreateAccountSnapshot(42, anonymousCredentialStatus: AnonymousCredentialStatuses.Revoked));
        var auditEvents = new CapturingAuditEventService();

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialIssueAsync(context, aeds, issuer, users, auditEvents, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status403Forbidden, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("anonymous_credential_disabled", PodBinaryCodec.ToErrorDetail(errorPod).Message);
        Assert.Equal(0, issuer.CallCount);
        Assert.Equal([42], users.RequestedIds);
        Assert.Equal("credential_disabled", Assert.Single(auditEvents.Events).ReasonCode);
    }

    [Fact]
    public async Task HandleAnonymousCredentialIssueAsync_MissingCredentialStatus_ReturnsForbiddenWithoutIssuer()
    {
        var aeds = new AedsEncoder();
        var context = CreateEndpointContext(
            AedsFrameType.AnonymousCredentialIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeAnonymousCredentialIssueRequest(CreateIssueRequest())),
            userId: 42);
        var issuer = new CapturingIssuerService();
        var users = new StubUserAccountReader(CreateAccountSnapshot(42, anonymousCredentialStatus: null));
        var auditEvents = new CapturingAuditEventService();

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialIssueAsync(context, aeds, issuer, users, auditEvents, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status403Forbidden, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("anonymous_credential_disabled", PodBinaryCodec.ToErrorDetail(errorPod).Message);
        Assert.Equal(0, issuer.CallCount);
        Assert.Equal([42], users.RequestedIds);
        Assert.Equal("credential_disabled", Assert.Single(auditEvents.Events).ReasonCode);
    }

    [Fact]
    public async Task HandleAnonymousCredentialIssueAsync_MalformedPayload_ReturnsApiError()
    {
        var aeds = new AedsEncoder();
        var context = CreateEndpointContext(
            AedsFrameType.AnonymousCredentialIssueRequest,
            BinaryRequestPayload.Success(new byte[] { 0x01, 0x02 }),
            userId: 42);

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCredentialIssueAsync(
            context,
            aeds,
            new CapturingIssuerService(),
            new StubUserAccountReader(CreateAccountSnapshot(42)),
            new CapturingAuditEventService(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("anonymous_credential_issue_request_invalid", PodBinaryCodec.ToErrorDetail(errorPod).Message);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task LegacyAnonymousCredentialIssueEndpoint_IsGoneAndCannotReattachOldHandler()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint endpoint = EndpointContractApplication.Find(
            app,
            "/api/binary/anonymous-credential/issue",
            HttpMethods.Post);
        Assert.Null(endpoint.Metadata.GetMetadata<IAllowAnonymous>());
        ClaimsAuthorizationRequirement identity = Assert.Single(endpoint.Metadata
            .GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>(),
            static requirement => requirement.ClaimType == "identity_kind");
        Assert.Contains(AnonymousIdentityRuntime.AnonymousAccountKind, identity.AllowedValues ?? []);
        Assert.Equal(
            "fixed_ip",
            Assert.IsType<EnableRateLimitingAttribute>(
                endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
        Assert.NotNull(endpoint.Metadata.GetMetadata<NoStoreResponseMetadata>());

        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create();
        using HttpClient client = server.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/binary/anonymous-credential/issue");
        request.Headers.Accept.ParseAdd("application/octet-stream");
        EndpointSecurityTestServer.AddAnonymousAccount(request);
        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Gone, response.StatusCode);
        var error = await EndpointSecurityTestServer.ReadErrorAsync(response);
        Assert.Equal("anonymous_credential_legacy_issuance_rejected", error.Message);
    }

    private static AnonymousCredentialIssuerService CreateService(
        SqlSugarClient db,
        CapturingAuditEventService auditEvents,
        IReadOnlyDictionary<string, string?>? config = null,
        ICircuitNativeCredentialIssuer? credentialIssuer = null)
    {
        Dictionary<string, string?> values = new(StringComparer.Ordinal)
        {
            ["AnonymousCredentialIssuer:AllowBannedAccountIssuance"] = "false",
            ["AnonymousCredentialIssuer:MaxCredentialRequestBytes"] = "8192",
            ["AnonymousCredentialIssuer:MaxClientNonceBytes"] = "128",
            ["AnonymousCredentialIssuer:EpochDurationMinutes"] = "1440",
            ["AnonymousCredentialIssuer:CredentialTtlMinutes"] = "1440",
            ["AnonymousCredentialIssuer:SubjectHashPepper"] = "unit-test-subject-hash-pepper-with-enough-entropy"
        };

        if (config is not null)
        {
            foreach (KeyValuePair<string, string?> item in config)
            {
                values[item.Key] = item.Value;
            }
        }

        return new AnonymousCredentialIssuerService(
            db,
            new AnonymousCredentialIssuanceAuditStore(db),
            credentialIssuer ?? new CapturingCircuitNativeCredentialIssuer(),
            auditEvents,
            new ConfigurationBuilder()
                .AddInMemoryCollection(values)
                .Build());
    }

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

    private static IConfiguration CreateManagedCircuitNativeIssuerConfiguration(
        string tempRoot,
        string? publicKeyHashOverride = null,
        byte[]? privateKey = null,
        bool writePrivateKey = true,
        string? privateKeyPathOverride = null)
    {
        string privateKeyPath = privateKeyPathOverride ?? Path.Combine(tempRoot, "issuer.sk");
        string publicKeyPath = Path.Combine(tempRoot, "issuer.pk");
        privateKey ??= CreateManagedCircuitNativePrivateKey();
        byte[] publicKey = ManagedCircuitNativeCredentialSigner.DerivePublicKey(privateKey);
        if (writePrivateKey)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(privateKeyPath)!);
            File.WriteAllBytes(privateKeyPath, privateKey);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(privateKeyPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
        }
        Directory.CreateDirectory(Path.GetDirectoryName(publicKeyPath)!);
        File.WriteAllBytes(publicKeyPath, publicKey);
        string publicKeyHash = publicKeyHashOverride ?? Convert.ToHexStringLower(SHA256.HashData(publicKey));

        return new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["AnonymousCredentialIssuer:IssuerPublicKeyId"] = "issuer-key:test",
                ["AnonymousCredentialIssuer:CircuitNative:Enabled"] = "true",
                ["AnonymousCredentialIssuer:CircuitNative:Backend"] = CircuitNativeCredentialIssuerOptions.ManagedCircuitNativeBackend,
                ["AnonymousCredentialIssuer:CircuitNative:IssuerPrivateKeyPath"] = privateKeyPath,
                ["AnonymousCredentialIssuer:CircuitNative:IssuerPublicKeyPath"] = publicKeyPath,
                ["AnonymousCredentialIssuer:CircuitNative:IssuerPublicKeyHash"] = publicKeyHash,
                ["AnonymousCredentialIssuer:CircuitNative:MaxConcurrentSignatures"] = "2",
                ["AnonymousCredentialIssuer:CircuitNative:TimeoutMs"] = "2000"
            })
            .Build();
    }

    private static byte[] CreateManagedCircuitNativePrivateKey()
        => [.. Enumerable.Range(1, 32).Select(static value => (byte)value)];

    private static string HashSubject(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static CircuitNativeCredentialIssueMaterial CreateManagedCircuitNativeIssueMaterial()
        => new(
            CredentialEpoch: 2042,
            CircuitNumericId: 7,
            PublicInputLayoutVersion: AnonymousPrivacyContract.PublicInputLayoutVersion,
            CircuitId: AnonymousPrivacyContract.CircuitId,
            CredentialLevel: AnonymousCredentialLevels.StrongAnonymous,
            CredentialRequest: [.. Enumerable.Range(0, 64).Select(static value => (byte)value)]);

    private static BigInteger ReadSignatureResponse(ReadOnlySpan<byte> signature)
        => new(signature.Slice(ManagedCircuitNativeCredentialSigner.PublicKeyBytes, 32), isUnsigned: true, isBigEndian: true);

    private static void WriteSignatureResponse(BigInteger response, Span<byte> signature)
    {
        Span<byte> destination = signature.Slice(ManagedCircuitNativeCredentialSigner.PublicKeyBytes, 32);
        destination.Clear();
        byte[] bytes = response.ToByteArray(isUnsigned: true, isBigEndian: true);
        bytes.CopyTo(destination[(destination.Length - bytes.Length)..]);
    }

    private Task<SqlSugarClient> CreateDbAsync()
        => PostgresSqlSugarTestClient.CreateAsync(fixture);

    private static void CreateTables(SqlSugarClient db)
    {
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(AnonymousCredentialIssuanceAudit));
    }

    private static void SeedUser(SqlSugarClient db, int status, string credentialStatus = AnonymousCredentialStatuses.Active, int id = 42)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO sys_user
                (id, status, identity_kind, deleted_at, anonymous_credential_level, anonymous_credential_status)
            VALUES
                (@Id, @Status, 'anonymous_account', NULL, @Level, @CredentialStatus);
            """,
            new SugarParameter("@Id", id),
            new SugarParameter("@Status", status),
            new SugarParameter("@Level", AnonymousCredentialLevels.StrongAnonymous),
            new SugarParameter("@CredentialStatus", credentialStatus));

    private static DefaultHttpContext CreateEndpointContext(
        AedsFrameType expectedFrameType,
        BinaryRequestPayload payload,
        int? userId,
        string? identityKind = AnonymousIdentityRuntime.AnonymousAccountKind)
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.TraceIdentifier = "trace-endpoint";
        context.Request.Headers.Accept = "application/octet-stream";
        if (userId.HasValue)
        {
            List<Claim> claims =
            [
                new Claim(ClaimTypes.NameIdentifier, userId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture))
            ];
            if (identityKind is not null)
            {
                claims.Add(new Claim("identity_kind", identityKind));
            }

            context.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "unit-test"));
        }

        var requestContext = new FakeBinaryEndpointRequestContext(expectedFrameType, payload);
        context.RequestServices = new ServiceCollection()
            .AddSingleton(requestContext)
            .AddSingleton<IBinaryEndpointRequestContext>(requestContext)
            .BuildServiceProvider();
        return context;
    }

    private static UserAccountSnapshot CreateAccountSnapshot(
        int id,
        int status = 0,
        DateTime? deletedAt = null,
        string identityKind = AnonymousIdentityRuntime.AnonymousAccountKind,
        string? anonymousCredentialStatus = AnonymousCredentialStatuses.Active)
        => new(
            id,
            status,
            BanReason: null,
            MfaEnabled: false,
            DeletedAt: deletedAt,
            PublicHandle: null,
            IdentityKind: identityKind,
            PasskeyEnabled: true,
            RecoveryEnabled: true,
            AnonymousCredentialStatus: anonymousCredentialStatus,
            AnonymousCredentialLevel: AnonymousCredentialLevels.StrongAnonymous);

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
            Events.Add(auditEvent with
            {
                IsHighValue = true
            });
            return Task.CompletedTask;
        }
    }

    private sealed class CapturingCircuitNativeCredentialIssuer : ICircuitNativeCredentialIssuer
    {
        private static readonly byte[] Key = "fsus-test-circuit-native-signature-key"u8.ToArray();

        public bool IsConfigured => true;
        public string IssuerPublicKeyId { get; init; } = "issuer-key:local";
        public string IssuerPublicKeyHash => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(IssuerPublicKeyId)));
        public bool ForceVerifyFailure
        {
            get; init;
        }
        public List<CircuitNativeCredentialIssueMaterial> Requests { get; } = [];

        public ValueTask<Result<CircuitNativeCredentialIssueResult>> SignAsync(
            CircuitNativeCredentialIssueMaterial material,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var captured = material with
            {
                CredentialRequest = [.. material.CredentialRequest]
            };
            Requests.Add(captured);
            return ValueTask.FromResult(Result<CircuitNativeCredentialIssueResult>.Success(new CircuitNativeCredentialIssueResult(
                IssuerPublicKeyId,
                CreateSignature(captured))));
        }

        public bool VerifyIssuerSignature(CircuitNativeCredentialIssueMaterial material, ReadOnlySpan<byte> signature)
            => !ForceVerifyFailure && CryptographicOperations.FixedTimeEquals(CreateSignature(material), signature);

        private static byte[] CreateSignature(CircuitNativeCredentialIssueMaterial material)
        {
            byte[] seed = HMACSHA256.HashData(Key, Canonicalize(material));
            byte[] signature = new byte[96];
            for (int offset = 0, counter = 0; offset < signature.Length; counter++)
            {
                byte[] input = new byte[seed.Length + 1];
                seed.CopyTo(input, 0);
                input[^1] = (byte)counter;
                byte[] block = HMACSHA256.HashData(Key, input);
                int take = Math.Min(block.Length, signature.Length - offset);
                block.AsSpan(0, take).CopyTo(signature.AsSpan(offset, take));
                offset += take;
            }

            return signature;
        }

        private static byte[] Canonicalize(CircuitNativeCredentialIssueMaterial material)
        {
            using var output = new MemoryStream();
            using var writer = new BinaryWriter(output, Encoding.UTF8, leaveOpen: true);
            writer.Write(material.CredentialEpoch);
            writer.Write(material.CircuitNumericId);
            writer.Write(material.PublicInputLayoutVersion);
            writer.Write(material.CircuitId);
            writer.Write(material.CredentialLevel);
            writer.Write(material.CredentialRequest.Length);
            writer.Write(material.CredentialRequest);
            writer.Flush();
            return output.ToArray();
        }
    }

    private sealed class CapturingIssuerService : IAnonymousCredentialIssuerService
    {
        public int UserId
        {
            get; private set;
        }
        public int CallCount
        {
            get; private set;
        }
        public AnonymousCredentialIssueRequestCoreModel Request
        {
            get; private set;
        }
        public Result<AnonymousCredentialIssueResponseCoreModel> Result
        {
            get; init;
        } =
            Result<AnonymousCredentialIssueResponseCoreModel>.Failure(ErrorCode.Forbidden, "issuer_not_configured");

        public Task<Result<AnonymousCredentialIssueResponseCoreModel>> IssueAsync(
            int userId,
            AnonymousCredentialIssueRequestCoreModel request,
            string? traceId,
            CancellationToken cancellationToken = default)
        {
            CallCount++;
            UserId = userId;
            Request = request;
            return Task.FromResult(Result);
        }
    }

    private sealed class StubUserAccountReader(UserAccountSnapshot? snapshot) : IUserAccountReader
    {
        public List<int> RequestedIds { get; } = [];

        public Task<UserAccountSnapshot?> GetAccountByIdAsync(int id)
        {
            RequestedIds.Add(id);
            return Task.FromResult(snapshot.HasValue && snapshot.Value.Id == id ? snapshot : null);
        }
    }

    private sealed class FakeBinaryEndpointRequestContext(
        AedsFrameType expectedFrameType,
        BinaryRequestPayload payload) : IBinaryEndpointRequestContext
    {
        public int? MaxFrameBytes
        {
            get; private set;
        }

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
