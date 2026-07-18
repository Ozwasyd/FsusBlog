using System.Numerics;
using System.Reflection;
using System.Security.Cryptography;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Validation;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
namespace FsusBlog.Server.Tests.Unit;

public sealed class BlindCredentialIssuanceTests
{
    [Fact]
    public async Task Rfc9474Signer_BlindSignProducesUnlinkableValidRsaOperation()
    {
        using BlindSignerFixture fixture = BlindSignerFixture.Create();
        using var signer = new ProductionRfc9474BlindCredentialSigner(fixture.Configuration);
        Assert.True(signer.IsConfigured);
        Assert.Equal(Rfc9474BlindCredentialProfile.ModulusBytes, signer.ModulusBytes);
        Assert.Equal(fixture.PublicKeyHash, signer.PublicKeyHash);

        RSAParameters publicParameters = fixture.Rsa.ExportParameters(false);
        BigInteger modulus = ReadInteger(publicParameters.Modulus!);
        BigInteger exponent = ReadInteger(publicParameters.Exponent!);
        BigInteger blind = new(2);
        // Extended Euclid is used because the RSA modulus is composite.
        BigInteger blindInverse = ModInverse(blind, modulus);

        BigInteger[] messages = [new(41), new(73)];
        var transcripts = new List<(BigInteger Blinded, BigInteger BlindSignature, BigInteger FinalSignature)>();
        foreach (BigInteger message in messages)
        {
            BigInteger blinded = Mod(message * BigInteger.ModPow(blind, exponent, modulus), modulus);
            Result<byte[]> signed = await signer.BlindSignAsync(
                WriteInteger(blinded, Rfc9474BlindCredentialProfile.ModulusBytes));
            Assert.True(signed.IsSuccess, signed.Error.Message);
            BigInteger blindSignature = ReadInteger(signed.Value);
            BigInteger finalSignature = Mod(blindSignature * blindInverse, modulus);
            Assert.Equal(message, BigInteger.ModPow(finalSignature, exponent, modulus));
            transcripts.Add((blinded, blindSignature, finalSignature));
        }

        // A signer holding the private key can construct a valid blind factor for
        // every issuance/final-token pairing. The compatibility matrix contains
        // no deterministic attribution signal.
        RSAParameters privateParameters = fixture.Rsa.ExportParameters(true);
        BigInteger privateExponent = ReadInteger(privateParameters.D!);
        foreach ((BigInteger blinded, BigInteger blindSignature, _) in transcripts)
        {
            foreach ((_, _, BigInteger finalSignature) in transcripts)
            {
                BigInteger encoded = BigInteger.ModPow(finalSignature, exponent, modulus);
                BigInteger candidateBlind = BigInteger.ModPow(
                    Mod(blinded * ModInverse(encoded, modulus), modulus),
                    privateExponent,
                    modulus);
                Assert.Equal(
                    finalSignature,
                    Mod(blindSignature * ModInverse(candidateBlind, modulus), modulus));
            }
        }
    }

    [Fact]
    public async Task Rfc9474Signer_RejectsMalformedRepresentativeAndKeyRotationMismatch()
    {
        using BlindSignerFixture fixture = BlindSignerFixture.Create();
        using var signer = new ProductionRfc9474BlindCredentialSigner(fixture.Configuration);

        Result<byte[]> zero = await signer.BlindSignAsync(
            new byte[Rfc9474BlindCredentialProfile.ModulusBytes]);
        Result<byte[]> shortInput = await signer.BlindSignAsync(new byte[32]);

        Assert.True(zero.IsFailure);
        Assert.True(shortInput.IsFailure);

        IConfiguration rotated = fixture.BuildConfiguration(new string('0', 64));
        using var rotatedSigner = new ProductionRfc9474BlindCredentialSigner(rotated);
        Assert.False(rotatedSigner.IsConfigured);
    }

    [Fact]
    public void BlindCredentialPods_RoundTripAndRejectLegacyLayout()
    {
        var request = new BlindCredentialIssueRequestCoreModel(
            42,
            7,
            AnonymousPrivacyContract.PublicInputLayoutVersion,
            AnonymousPrivacyContract.CircuitId,
            AnonymousCredentialLevels.Basic,
            Rfc9474BlindCredentialProfile.SchemeId,
            "blind-rsa:test",
            Enumerable.Repeat((byte)0x5a, Rfc9474BlindCredentialProfile.ModulusBytes).ToArray());
        byte[] encoded = Encode(writer => PodBinaryCodec.WriteBlindCredentialIssueRequest(request, writer));

        Assert.True(PodBinaryCodec.TryDecodeBlindCredentialIssueRequest(encoded, out var decoded));
        Assert.Equal(request.CredentialEpoch, decoded.CredentialEpoch);
        Assert.Equal(request.CircuitNumericId, decoded.CircuitNumericId);
        Assert.Equal(request.PublicInputLayoutVersion, decoded.PublicInputLayoutVersion);
        Assert.Equal(request.CircuitId, decoded.CircuitId);
        Assert.Equal(request.CredentialLevel, decoded.CredentialLevel);
        Assert.Equal(request.SchemeId, decoded.SchemeId);
        Assert.Equal(request.IssuerPublicKeyId, decoded.IssuerPublicKeyId);
        Assert.Equal(request.BlindedMessage, decoded.BlindedMessage);

        encoded[12] = 4;
        encoded[13] = 0;
        Assert.False(PodBinaryCodec.TryDecodeBlindCredentialIssueRequest(encoded, out _));
    }

    [Fact]
    public void BlindIssueRequest_MustMatchReadyCurrentRootAndIssuerKey()
    {
        using BlindSignerFixture fixture = BlindSignerFixture.Create();
        using var signer = new ProductionRfc9474BlindCredentialSigner(fixture.Configuration);
        var request = new BlindCredentialIssueRequestCoreModel(
            42,
            7,
            AnonymousPrivacyContract.PublicInputLayoutVersion,
            AnonymousPrivacyContract.CircuitId,
            AnonymousCredentialLevels.Basic,
            Rfc9474BlindCredentialProfile.SchemeId,
            signer.KeyId,
            Enumerable.Repeat((byte)0x5a, Rfc9474BlindCredentialProfile.ModulusBytes).ToArray());
        var root = new AnonymousCredentialRootSnapshotCoreModel(
            42,
            DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeMilliseconds(),
            DateTimeOffset.UtcNow.AddHours(2).ToUnixTimeMilliseconds(),
            7,
            AnonymousPrivacyContract.PublicInputLayoutVersion,
            true,
            true,
            AnonymousPrivacyContract.CircuitId,
            new string('a', 64),
            signer.PublicKeyHash,
            new byte[32],
            new byte[32],
            []);

        Assert.True(BlindCredentialIssuanceService.RequestMatchesRoot(request, signer, root));
        Assert.False(BlindCredentialIssuanceService.RequestMatchesRoot(
            request with
            {
                CredentialEpoch = 43
            }, signer, root));
        Assert.False(BlindCredentialIssuanceService.RequestMatchesRoot(
            request, signer, root with
            {
                IssuerPublicKeyHash = new string('0', 64)
            }));
        Assert.False(BlindCredentialIssuanceService.RequestMatchesRoot(
            request, signer, root with
            {
                VerifierConfigured = false
            }));
    }

    [Fact]
    public void RuntimeGate_ReloadDisableAndLatencyBucketsApplyWithoutSignerRebuild()
    {
        var monitor = new MutableOptionsMonitor<BlindCredentialRuntimeOptions>(new()
        {
            Enabled = true,
            TimeoutMs = 2_000,
            MinimumResponseMilliseconds = 2_500
        });
        var gate = new BlindCredentialRuntimeGate(monitor);

        Assert.True(gate.IsEnabled);
        Assert.Equal(TimeSpan.FromMilliseconds(2_490), gate.GetEnvelopeDelay(TimeSpan.FromMilliseconds(10)));
        Assert.Equal(TimeSpan.FromMilliseconds(300), gate.GetEnvelopeDelay(TimeSpan.FromMilliseconds(2_200)));
        Assert.Equal(TimeSpan.FromMilliseconds(2_400), gate.GetEnvelopeDelay(TimeSpan.FromMilliseconds(2_600)));

        monitor.Set(new BlindCredentialRuntimeOptions
        {
            Enabled = false,
            TimeoutMs = 2_000,
            MinimumResponseMilliseconds = 2_500
        });
        Assert.False(gate.IsEnabled);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task BlindRoutes_AllowPublicMetadataButOnlyAnonymousAccountCanIssue()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint metadata = EndpointContractApplication.Find(
            app,
            "/api/binary/anonymous-credential/blind-issuer",
            HttpMethods.Get);
        Assert.NotNull(metadata.Metadata.GetMetadata<IAllowAnonymous>());
        Assert.Equal(
            "public_read",
            Assert.IsType<EnableRateLimitingAttribute>(
                metadata.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
        Assert.NotNull(metadata.Metadata.GetMetadata<NoStoreResponseMetadata>());

        RouteEndpoint issue = EndpointContractApplication.Find(
            app,
            "/api/binary/anonymous-credential/blind-issue",
            HttpMethods.Post);
        Assert.Null(issue.Metadata.GetMetadata<IAllowAnonymous>());
        ClaimsAuthorizationRequirement identity = Assert.Single(issue.Metadata
            .GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>(),
            static requirement => requirement.ClaimType == "identity_kind");
        Assert.Equal([AnonymousIdentityRuntime.AnonymousAccountKind], identity.AllowedValues);
        Assert.DoesNotContain(AnonymousIdentityRuntime.AdminPrincipalKind, identity.AllowedValues ?? []);
        Assert.NotNull(issue.Metadata.GetMetadata<NoStoreResponseMetadata>());

        MethodInfo handler = Assert.Single(typeof(BinaryEndpoints)
            .GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic),
            static method => method.Name == "HandleBlindCredentialIssueAsync");
        Assert.DoesNotContain(
            handler.GetParameters(),
            static parameter => parameter.ParameterType == typeof(IAuditEventService));
    }

    [Fact]
    public void IssuanceMigrationAndEntity_DoNotPersistRequestCorrelation()
    {
        var registry = new SchemaMigrationRegistry();
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            registry.GetDescriptors(),
            static item => item.MigrationId == "20260715-post-blind-credential-issuance-privacy");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Contains("trace_id", fingerprint, StringComparison.Ordinal);
        Assert.Contains("information_schema.columns", fingerprint, StringComparison.Ordinal);
        Assert.Contains("date_trunc('hour'", fingerprint, StringComparison.Ordinal);
        Assert.DoesNotContain(
            typeof(AnonymousCredentialIssuanceAudit).GetProperties(),
            static property => property.Name.Contains("Trace", StringComparison.OrdinalIgnoreCase));
    }

    private static byte[] Encode(Action<System.Buffers.IBufferWriter<byte>> write)
    {
        var writer = new System.Buffers.ArrayBufferWriter<byte>();
        write(writer);
        return writer.WrittenSpan.ToArray();
    }

    private static BigInteger ReadInteger(ReadOnlySpan<byte> value) =>
        new(value, isUnsigned: true, isBigEndian: true);

    private static byte[] WriteInteger(BigInteger value, int length)
    {
        byte[] encoded = value.ToByteArray(isUnsigned: true, isBigEndian: true);
        byte[] output = new byte[length];
        encoded.CopyTo(output, length - encoded.Length);
        return output;
    }

    private static BigInteger ModInverse(BigInteger value, BigInteger modulus)
    {
        BigInteger oldR = value;
        BigInteger r = modulus;
        BigInteger oldS = BigInteger.One;
        BigInteger s = BigInteger.Zero;
        while (!r.IsZero)
        {
            BigInteger quotient = oldR / r;
            (oldR, r) = (r, oldR - quotient * r);
            (oldS, s) = (s, oldS - quotient * s);
        }
        Assert.Equal(BigInteger.One, oldR);
        return Mod(oldS, modulus);
    }

    private static BigInteger Mod(BigInteger value, BigInteger modulus)
    {
        BigInteger result = value % modulus;
        return result.Sign >= 0 ? result : result + modulus;
    }

    private sealed class BlindSignerFixture : IDisposable
    {
        private BlindSignerFixture(string root, RSA rsa, string publicKeyHash)
        {
            Root = root;
            Rsa = rsa;
            PublicKeyHash = publicKeyHash;
            Configuration = BuildConfiguration(publicKeyHash);
        }

        public string Root
        {
            get;
        }
        public RSA Rsa
        {
            get;
        }
        public string PublicKeyHash
        {
            get;
        }
        public IConfiguration Configuration
        {
            get;
        }

        public static BlindSignerFixture Create()
        {
            string root = Path.Combine(Path.GetTempPath(), $"fsus-rfc9474-{Guid.NewGuid():N}");
            Directory.CreateDirectory(root);
            RSA rsa = RSA.Create(3072);
            string path = Path.Combine(root, "issuer-private.der");
            File.WriteAllBytes(path, rsa.ExportPkcs8PrivateKey());
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }
            string hash = Convert.ToHexStringLower(SHA256.HashData(rsa.ExportSubjectPublicKeyInfo()));
            return new BlindSignerFixture(root, rsa, hash);
        }

        public IConfiguration BuildConfiguration(string publicKeyHash) =>
            new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["AnonymousCredentialIssuer:BlindRsa:Enabled"] = "true",
                    ["AnonymousCredentialIssuer:BlindRsa:Profile"] = Rfc9474BlindCredentialProfile.SchemeId,
                    ["AnonymousCredentialIssuer:BlindRsa:KeyId"] = "blind-rsa:test",
                    ["AnonymousCredentialIssuer:BlindRsa:PublicKeyHash"] = publicKeyHash,
                    ["AnonymousCredentialIssuer:BlindRsa:PrivateKeyPath"] = Path.Combine(Root, "issuer-private.der"),
                    ["AnonymousCredentialIssuer:BlindRsa:CredentialLevel"] = AnonymousCredentialLevels.Basic
                })
                .Build();

        public void Dispose()
        {
            Rsa.Dispose();
            Directory.Delete(Root, recursive: true);
        }
    }

    private sealed class MutableOptionsMonitor<T>(T value) : IOptionsMonitor<T>
    {
        private T _value = value;

        public T CurrentValue => _value;
        public T Get(string? name) => _value;
        public IDisposable? OnChange(Action<T, string?> listener) => null;
        public void Set(T next) => _value = next;
    }
}
