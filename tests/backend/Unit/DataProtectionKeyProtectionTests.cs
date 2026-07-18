using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Tests;

public sealed class DataProtectionKeyProtectionTests
{
    [Fact]
    public void ProductionRegistration_RejectsMissingAtRestProtector()
    {
        string root = CreateTempDirectory();
        try
        {
            var services = new ServiceCollection();
            IConfiguration configuration = CreateConfiguration(root, currentCertificatePath: null);

            InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
                () => services.AddFsusApiFoundation(configuration));

            Assert.Contains("key-at-rest protection mode", exception.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ProductionRegistration_RejectsExistingPlaintextKeyRing()
    {
        string root = CreateTempDirectory();
        try
        {
            string certificatePath = CreateCertificate(root, "current", "current-password");
            string keyRingPath = Path.Combine(root, "shared-key-ring");
            Directory.CreateDirectory(keyRingPath);
            File.WriteAllText(
                Path.Combine(keyRingPath, "key-legacy.xml"),
                "<key><descriptor><masterKey>plaintext</masterKey></descriptor></key>");

            var services = new ServiceCollection();
            IConfiguration configuration = CreateConfiguration(
                root,
                certificatePath,
                "current-password");

            InvalidOperationException exception = Assert.Throws<InvalidOperationException>(
                () => services.AddFsusApiFoundation(configuration));

            Assert.Contains("unencrypted key material", exception.Message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ProductionRegistration_EncryptsKeyFilesAndWrongCertificateCannotUnprotect()
    {
        string root = CreateTempDirectory();
        try
        {
            string certificatePath = CreateCertificate(root, "current", "current-password");
            string wrongCertificatePath = CreateCertificate(root, "wrong", "wrong-password");
            IConfiguration configuration = CreateConfiguration(
                root,
                certificatePath,
                "current-password");
            using ServiceProvider provider = BuildProvider(configuration);
            StartDataProtectionValidator(provider);
            IDataProtector protector = provider
                .GetRequiredService<IDataProtectionProvider>()
                .CreateProtector("issue-1102-at-rest");

            string protectedPayload = protector.Protect("protected-cookie");
            string[] keyFiles = Directory.GetFiles(Path.Combine(root, "shared-key-ring"), "key-*.xml");

            Assert.NotEmpty(keyFiles);
            Assert.All(keyFiles, static keyFile =>
            {
                string xml = File.ReadAllText(keyFile);
                Assert.Contains("encryptedSecret", xml, StringComparison.Ordinal);
                Assert.DoesNotContain("masterKey", xml, StringComparison.Ordinal);
            });

            using ServiceProvider wrongProvider = BuildProvider(CreateConfiguration(
                root,
                wrongCertificatePath,
                "wrong-password"));
            DataProtectionKeyRingStartupValidator startupValidator = wrongProvider
                .GetRequiredService<DataProtectionKeyRingStartupValidator>();
            Assert.Throws<InvalidOperationException>(() =>
                startupValidator.StartAsync(CancellationToken.None).GetAwaiter().GetResult());
            IDataProtector wrongProtector = wrongProvider
                .GetRequiredService<IDataProtectionProvider>()
                .CreateProtector("issue-1102-at-rest");

            Assert.ThrowsAny<CryptographicException>(() => wrongProtector.Unprotect(protectedPayload));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void CertificateRollover_BlueAndGreenCanReadOldAndNewKeys()
    {
        string root = CreateTempDirectory();
        try
        {
            string certificateA = CreateCertificate(root, "certificate-a", "password-a");
            string certificateB = CreateCertificate(root, "certificate-b", "password-b");

            using ServiceProvider initialProvider = BuildProvider(CreateConfiguration(
                root,
                certificateA,
                "password-a"));
            StartDataProtectionValidator(initialProvider);
            IDataProtector initialProtector = initialProvider
                .GetRequiredService<IDataProtectionProvider>()
                .CreateProtector("blue-green-session-v1");
            string oldPayload = initialProtector.Protect("old-cookie");

            using ServiceProvider greenProvider = BuildProvider(CreateConfiguration(
                root,
                certificateB,
                "password-b",
                certificateA,
                "password-a"));
            IKeyManager keyManager = greenProvider.GetRequiredService<IKeyManager>();
            keyManager.CreateNewKey(
                DateTimeOffset.UtcNow.AddMinutes(-5),
                DateTimeOffset.UtcNow.AddDays(90));
            StartDataProtectionValidator(greenProvider);
            IDataProtector greenProtector = greenProvider
                .GetRequiredService<IDataProtectionProvider>()
                .CreateProtector("blue-green-session-v1");
            string newPayload = greenProtector.Protect("new-cookie");

            using ServiceProvider blueProvider = BuildProvider(CreateConfiguration(
                root,
                certificateA,
                "password-a",
                certificateB,
                "password-b"));
            StartDataProtectionValidator(blueProvider);
            IDataProtector blueProtector = blueProvider
                .GetRequiredService<IDataProtectionProvider>()
                .CreateProtector("blue-green-session-v1");

            Assert.Equal("old-cookie", greenProtector.Unprotect(oldPayload));
            Assert.Equal("new-cookie", greenProtector.Unprotect(newPayload));
            Assert.Equal("old-cookie", blueProtector.Unprotect(oldPayload));
            Assert.Equal("new-cookie", blueProtector.Unprotect(newPayload));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static ServiceProvider BuildProvider(IConfiguration configuration)
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddFsusApiFoundation(configuration);
        return services.BuildServiceProvider();
    }

    private static void StartDataProtectionValidator(ServiceProvider provider)
    {
        DataProtectionKeyRingStartupValidator startupValidator = provider
            .GetRequiredService<DataProtectionKeyRingStartupValidator>();
        startupValidator.StartAsync(CancellationToken.None).GetAwaiter().GetResult();
    }

    private static IConfiguration CreateConfiguration(
        string root,
        string? currentCertificatePath,
        string? currentPassword = null,
        string? previousCertificatePath = null,
        string? previousPassword = null)
    {
        Dictionary<string, string?> values = new(StringComparer.Ordinal)
        {
            ["ASPNETCORE_ENVIRONMENT"] = Environments.Production,
            ["CORS_ALLOWED_HOSTS"] = "https://fsusblog.test",
            ["ConnectionStrings:Redis"] = "localhost:6379,connectTimeout=50",
            ["Jwt:SecretKey"] = TestSecrets.JwtSigningKey,
            ["Jwt:Issuer"] = "FsusBlog.Tests",
            ["Jwt:Audience"] = "FsusBlog.Tests",
            ["DataProtection:ApplicationName"] = ReleaseStorageLayout.RequiredDataProtectionApplicationName,
            ["DataProtection:KeyRingPath"] = Path.Combine(root, "shared-key-ring")
        };

        if (currentCertificatePath is not null)
        {
            values[DataProtectionKeyProtection.ModeKey] = "Certificate";
            values[DataProtectionKeyProtection.CurrentCertificatePathKey] = currentCertificatePath;
            values[DataProtectionKeyProtection.CurrentCertificatePasswordKey] = currentPassword;
        }

        if (previousCertificatePath is not null)
        {
            values[$"{DataProtectionKeyProtection.PreviousCertificatesSection}:0:Path"] = previousCertificatePath;
            values[$"{DataProtectionKeyProtection.PreviousCertificatesSection}:0:Password"] = previousPassword;
        }

        return new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
    }

    private static string CreateCertificate(string root, string name, string password)
    {
        using RSA rsa = RSA.Create(2048);
        var request = new CertificateRequest(
            $"CN=FsusBlog DataProtection {name}",
            rsa,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509KeyUsageExtension(
            X509KeyUsageFlags.KeyEncipherment,
            critical: true));
        using X509Certificate2 certificate = request.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddMinutes(-5),
            DateTimeOffset.UtcNow.AddDays(30));
        string path = Path.Combine(root, $"{name}.pfx");
        File.WriteAllBytes(path, certificate.Export(X509ContentType.Pkcs12, password));
        return path;
    }

    private static string CreateTempDirectory()
    {
        string path = Path.Combine(
            Path.GetTempPath(),
            "fsusblog-data-protection-key-protection-tests",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }
}
