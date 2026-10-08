using System.Text.Json;

using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ZkPolicyOwnershipTests
{
    [Theory]
    [InlineData("AnonymousIdentity:ZkProd:Enabled")]
    [InlineData("AnonymousIdentity:ZkProd:FallbackToLegacyAnonymous")]
    [InlineData("AnonymousIdentity:ZkCommentPolicy:FallbackToLegacyAnonymous")]
    [InlineData("AnonymousIdentity:ZkCommentPolicy:VerifierBackend")]
    [InlineData("AnonymousIdentity:ZkCommentPolicy:VerifyingKeyHash")]
    public void ProductAdmission_RejectsRetiredAndVerifierOwnedInputsEvenWhenDisabled(string key)
    {
        IConfiguration configuration = Configuration(new() { [key] = "true" });
        Assert.Throws<InvalidOperationException>(() => ZkCommentPolicyOptions.FromConfiguration(configuration));
    }

    [Theory]
    [InlineData("AnonymousIdentity:ZkVerifier:NativeGroth16:VerifyingKeyHash")]
    [InlineData("AnonymousIdentity:ZkVerifier:NativeGroth16:VerifyingKeySha256")]
    public void VerifierAdmission_RejectsDuplicateHashRegardlessOfAgreement(string key)
    {
        foreach (char duplicate in new[] { 'a', 'b' })
        {
            IConfiguration configuration = Configuration(new()
            {
                ["AnonymousIdentity:ZkVerifier:VerifyingKeyHash"] = new string('a', 64),
                [key] = new string(duplicate, 64)
            });
            Assert.Throws<InvalidOperationException>(() => ZkVerifierOptions.FromConfiguration(configuration));
        }
    }

    [Fact]
    public void Readiness_ReadsManifestsOnlyWhenVerifierCapabilityIsConstructed()
    {
        string directory = Path.Combine(Path.GetTempPath(), "fsus-zk-ownership-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            string setup = Path.Combine(directory, "setup.json");
            string key = Path.Combine(directory, "key.json");
            string hash = new('a', 64);
            string manifest = JsonSerializer.Serialize(new { production_usable = true, verifying_key_hash = hash });
            File.WriteAllText(setup, manifest);
            File.WriteAllText(key, manifest);
            IZkProofVerifier verifier = Substitute.For<IZkProofVerifier>();
            verifier.IsConfigured.Returns(true);
            var options = new ZkVerifierOptions
            {
                Enabled = true,
                Backend = ZkVerifierOptions.NativeGroth16Backend,
                VerifyingKeyHash = hash,
                TrustedSetupManifestPath = setup,
                VerifyingKeyManifestPath = key
            };
            var readiness = new ZkVerifierReadiness(options, verifier);
            Assert.True(readiness.Current.TrustedSetupVerified);
            File.WriteAllText(key, JsonSerializer.Serialize(new { production_usable = true, verifying_key_hash = new string('b', 64) }));
            Assert.True(readiness.Current.TrustedSetupVerified);
            Assert.False(new ZkVerifierReadiness(options, verifier).Current.TrustedSetupVerified);
            File.Delete(key);
            Assert.False(new ZkVerifierReadiness(options, verifier).Current.TrustedSetupVerified);
            File.WriteAllText(key, "{\"production_usable\":false}");
            Assert.False(new ZkVerifierReadiness(options, verifier).Current.TrustedSetupVerified);
            File.WriteAllText(key, "[]");
            Assert.False(new ZkVerifierReadiness(options, verifier).Current.TrustedSetupVerified);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void ProductSnapshot_IsStableAndReloadedPolicyFailsClosed()
    {
        IConfigurationRoot configuration = Configuration(new()
        {
            ["AnonymousIdentity:ZkCommentPolicy:Enabled"] = "true"
        });
        using var authority = new ZkCommentPolicyAuthority(configuration);
        IZkVerifierReadiness readiness = Substitute.For<IZkVerifierReadiness>();
        readiness.Current.Returns(new ZkVerifierReadinessSnapshot(true, false, true));
        var service = new ZkAnonymousProofService(configuration, new DisabledZkProofVerifier(), authority, readiness);
        ZkCommentPolicySnapshot first = service.CurrentZkCommentPolicy;
        Assert.Same(first, service.CurrentZkCommentPolicy);
        Assert.Equal("native_verifier_unavailable", first.UnavailableReason);
        configuration["AnonymousIdentity:ZkCommentPolicy:Enabled"] = "false";
        configuration.Reload();
        Assert.False(service.CurrentZkCommentPolicy.Enabled);
        Assert.Equal("disabled", service.CurrentZkCommentPolicy.UnavailableReason);
        configuration["AnonymousIdentity:ZkCommentPolicy:Enabled"] = "true";
        configuration["AnonymousIdentity:ZkCommentPolicy:VerifierBackend"] = "native_groth16";
        configuration.Reload();
        Assert.False(service.CurrentZkCommentPolicy.Enabled);
    }

    private static IConfigurationRoot Configuration(Dictionary<string, string?> values)
        => new ConfigurationBuilder().AddInMemoryCollection(values).Build();
}
