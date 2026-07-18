using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Xml;
using System.Xml.Linq;

using FsusBlog.Server.Infrastructure.Storage;

using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class DataProtectionKeyProtection
{
    internal const string ModeKey = "DataProtection:KeyProtection:Mode";
    internal const string CurrentCertificatePathKey =
        "DataProtection:KeyProtection:CurrentCertificate:Path";
    internal const string CurrentCertificatePasswordKey =
        "DataProtection:KeyProtection:CurrentCertificate:Password";
    internal const string PreviousCertificatesSection =
        "DataProtection:KeyProtection:PreviousCertificates";
    private const string CertificateMode = "Certificate";
    private const long MaxKeyFileCharacters = 1024 * 1024;

    internal static IDataProtectionBuilder Apply(
        IDataProtectionBuilder builder,
        IConfiguration configuration,
        string keyRingPath,
        bool enforceProductionRules)
    {
        string mode = (configuration[ModeKey] ?? string.Empty).Trim();
        if (mode.Length == 0)
        {
            if (enforceProductionRules)
            {
                throw new InvalidOperationException(
                    "Production DataProtection key-at-rest protection mode is required.");
            }

            return builder;
        }

        if (!string.Equals(mode, CertificateMode, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                "DataProtection key-at-rest protection mode must be 'Certificate'.");
        }

        if (enforceProductionRules)
        {
            EnsureExistingKeysAreEncrypted(keyRingPath);
        }

        X509Certificate2 current = LoadCertificate(
            configuration[CurrentCertificatePathKey],
            configuration[CurrentCertificatePasswordKey],
            requireCurrentValidity: true,
            "current");
        List<X509Certificate2> decryptCertificates = [current];
        HashSet<string> thumbprints = new(StringComparer.OrdinalIgnoreCase)
        {
            current.Thumbprint
        };

        foreach (IConfigurationSection previous in configuration
            .GetSection(PreviousCertificatesSection)
            .GetChildren())
        {
            X509Certificate2 certificate = LoadCertificate(
                previous["Path"],
                previous["Password"],
                requireCurrentValidity: false,
                "previous");
            if (thumbprints.Add(certificate.Thumbprint))
            {
                decryptCertificates.Add(certificate);
            }
            else
            {
                certificate.Dispose();
            }
        }

        return builder
            .ProtectKeysWithCertificate(current)
            .UnprotectKeysWithAnyCertificate([.. decryptCertificates]);
    }

    internal static IReadOnlyList<string> ValidateConfiguration(
        IConfiguration configuration,
        bool enforceProductionRules)
    {
        string mode = (configuration[ModeKey] ?? string.Empty).Trim();
        if (!enforceProductionRules && mode.Length == 0)
        {
            return [];
        }

        List<string> errors = [];
        string applicationName = (
            configuration["DataProtection:ApplicationName"]
                ?? ReleaseStorageLayout.RequiredDataProtectionApplicationName).Trim();
        if (enforceProductionRules
            && !string.Equals(
                applicationName,
                ReleaseStorageLayout.RequiredDataProtectionApplicationName,
                StringComparison.Ordinal))
        {
            errors.Add(
                $"DataProtection:ApplicationName must be '{ReleaseStorageLayout.RequiredDataProtectionApplicationName}' in production.");
        }

        if (mode.Length == 0)
        {
            errors.Add($"{ModeKey} is required in production.");
            return errors;
        }

        if (!string.Equals(mode, CertificateMode, StringComparison.OrdinalIgnoreCase))
        {
            errors.Add($"{ModeKey} must be 'Certificate'.");
        }

        ValidateCertificatePath(
            configuration[CurrentCertificatePathKey],
            CurrentCertificatePathKey,
            configuration,
            errors);

        foreach (IConfigurationSection previous in configuration
            .GetSection(PreviousCertificatesSection)
            .GetChildren())
        {
            ValidateCertificatePath(
                previous["Path"],
                $"{PreviousCertificatesSection}:{previous.Key}:Path",
                configuration,
                errors);
        }

        return errors;
    }

    private static X509Certificate2 LoadCertificate(
        string? configuredPath,
        string? password,
        bool requireCurrentValidity,
        string role)
    {
        if (string.IsNullOrWhiteSpace(configuredPath))
        {
            throw new InvalidOperationException(
                $"DataProtection {role} key-protection certificate path is required.");
        }

        X509Certificate2 certificate;
        try
        {
            string fullPath = Path.GetFullPath(configuredPath.Trim());
            if (!File.Exists(fullPath))
            {
                throw new FileNotFoundException();
            }

            certificate = X509CertificateLoader.LoadPkcs12FromFile(
                fullPath,
                password,
                X509KeyStorageFlags.EphemeralKeySet);
        }
        catch (Exception exception) when (
            exception is ArgumentException
                or CryptographicException
                or IOException
                or UnauthorizedAccessException)
        {
            throw new InvalidOperationException(
                $"DataProtection {role} key-protection certificate could not be loaded.");
        }

        using RSA? privateKey = certificate.GetRSAPrivateKey();
        if (privateKey is null)
        {
            certificate.Dispose();
            throw new InvalidOperationException(
                $"DataProtection {role} key-protection certificate must contain an RSA private key.");
        }

        DateTime utcNow = DateTime.UtcNow;
        if (requireCurrentValidity
            && (certificate.NotBefore.ToUniversalTime() > utcNow
                || certificate.NotAfter.ToUniversalTime() <= utcNow))
        {
            certificate.Dispose();
            throw new InvalidOperationException(
                "DataProtection current key-protection certificate is outside its validity window.");
        }

        return certificate;
    }

    private static void EnsureExistingKeysAreEncrypted(string keyRingPath)
    {
        foreach (string keyFile in Directory.EnumerateFiles(keyRingPath, "key-*.xml"))
        {
            try
            {
                using XmlReader reader = XmlReader.Create(
                    keyFile,
                    new XmlReaderSettings
                    {
                        DtdProcessing = DtdProcessing.Prohibit,
                        XmlResolver = null,
                        MaxCharactersInDocument = MaxKeyFileCharacters
                    });
                XDocument document = XDocument.Load(reader, LoadOptions.None);
                bool encrypted = document
                    .Descendants()
                    .Any(static element =>
                        string.Equals(element.Name.LocalName, "encryptedSecret", StringComparison.Ordinal));
                bool containsPlaintextMasterKey = document
                    .Descendants()
                    .Any(static element =>
                        string.Equals(element.Name.LocalName, "masterKey", StringComparison.Ordinal));
                if (!encrypted || containsPlaintextMasterKey)
                {
                    throw new InvalidOperationException(
                        "Production DataProtection key ring contains unencrypted key material; migrate it before startup.");
                }
            }
            catch (InvalidOperationException)
            {
                throw;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or XmlException)
            {
                throw new InvalidOperationException(
                    "Production DataProtection key ring could not be verified as encrypted.");
            }
        }
    }

    private static void ValidateCertificatePath(
        string? configuredPath,
        string key,
        IConfiguration configuration,
        List<string> errors)
    {
        if (string.IsNullOrWhiteSpace(configuredPath))
        {
            errors.Add($"{key} is required.");
            return;
        }

        try
        {
            string certificatePath = Path.GetFullPath(configuredPath.Trim());
            string? configuredKeyRingPath = configuration["DataProtection:KeyRingPath"];
            string? environmentKeyRingPath = configuration["FSUSBLOG_DATA_PROTECTION_KEY_RING"]
                ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_PROTECTION_KEY_RING");
            string? dataRoot = configuration["FSUSBLOG_DATA_ROOT"];
            string keyRingCandidate;
            if (!string.IsNullOrWhiteSpace(configuredKeyRingPath))
            {
                keyRingCandidate = configuredKeyRingPath;
            }
            else if (!string.IsNullOrWhiteSpace(environmentKeyRingPath))
            {
                keyRingCandidate = environmentKeyRingPath;
            }
            else
            {
                keyRingCandidate = Path.Combine(
                    !string.IsNullOrWhiteSpace(dataRoot) ? dataRoot : AppContext.BaseDirectory,
                    "data-protection-keys");
            }

            string keyRingPath = Path.GetFullPath(keyRingCandidate);
            string relative = Path.GetRelativePath(keyRingPath, certificatePath);
            if (!relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                && !string.Equals(relative, "..", StringComparison.Ordinal)
                && !Path.IsPathRooted(relative))
            {
                errors.Add($"{key} must not be stored inside the shared DataProtection key ring.");
            }
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
        {
            errors.Add($"{key} must be a valid filesystem path.");
        }
    }
}

internal sealed class DataProtectionKeyRingStartupValidator(
    IDataProtectionProvider dataProtectionProvider,
    IKeyManager keyManager) : IHostedService
{
    private const string ValidationPurpose = "fsusblog.startup.data-protection-key-ring.v1";

    public Task StartAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            foreach (IKey key in keyManager.GetAllKeys())
            {
                _ = key.CreateEncryptor();
            }
            IDataProtector protector = dataProtectionProvider.CreateProtector(ValidationPurpose);
            string sentinel = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            string protectedSentinel = protector.Protect(sentinel);
            string roundTrip = protector.Unprotect(protectedSentinel);
            if (!CryptographicOperations.FixedTimeEquals(
                    Convert.FromHexString(sentinel),
                    Convert.FromHexString(roundTrip)))
            {
                throw new CryptographicException();
            }
        }
        catch (Exception exception) when (
            exception is CryptographicException
                or InvalidOperationException
                or IOException
                or UnauthorizedAccessException)
        {
            throw new InvalidOperationException(
                "Production DataProtection key ring could not be opened with the configured certificate set.");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
