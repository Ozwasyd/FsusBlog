using System.Collections.Immutable;
using System.IO.Compression;
using System.Reflection;
using System.Reflection.Emit;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.Unit;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionPackagePersistenceTests
{
    private static readonly DateTimeOffset s_now = new(2026, 9, 4, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task Install_RealArchiveAndStores_RecoversFromFreshInstances()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime first = CreateRuntime(directory.Path, fixture.Trust);

        AuthoringPackageReceipt receipt = await first.Activation.InstallOrUpdateAsync(fixture.Artifact);

        Assert.Equal(AuthoringPackageOutcome.Committed, receipt.Outcome);
        Assert.Equal(fixture.Artifact.ArchiveSha256, receipt.ArchiveSha256);
        ProductionRuntime fresh = CreateRuntime(directory.Path, fixture.Trust);
        VerifiedAuthoringPackage? recovered = await fresh.Activation.RecoverActiveAsync("acme.author-tools");
        Assert.NotNull(recovered);
        Assert.Equal(receipt.PackageIdentity, recovered.PackageIdentity);
        Assert.Equal("1.0.0", recovered.Contract.Manifest.Version);
        Assert.True(await fresh.Store.ContainsAsync(recovered.PackageIdentity, default));
    }

    [Fact]
    public async Task LocalComposition_EcdsaApprovedSourceInstallAndUninstall_AreReceiptBound()
    {
        using var directory = new TemporaryDirectory();
        using ECDsa signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        PackageFixture fixture = CreatePackage("1.0.0", "signed payload");
        byte[] signature = signer.SignData(
            fixture.Artifact.CanonicalArchive.AsSpan(),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        AuthoringPackageArtifact artifact = fixture.Artifact with
        {
            Signature = ImmutableArray.Create(signature)
        };
        var key = new AuthoringPackagePublisherKey(
            "acme",
            "key-1",
            ImmutableArray.Create(signer.ExportSubjectPublicKeyInfo()),
            s_now.AddHours(-1),
            s_now.AddHours(1));
        LocalAuthoringPackageRuntime runtime = LocalAuthoringPackageComposition.Create(
            directory.Path,
            AuthoringHostPlatform.ServerLinux,
            [key],
            [artifact],
            new FixedTimeProvider(s_now));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await runtime.Activation.InstallOrUpdateAsync(artifact));
        AuthoringPackageReceipt installed = await runtime.Activation.InstallOrUpdateFromSourceAsync(
            artifact.SourceReference);
        VerifiedAuthoringPackage active = Assert.IsType<VerifiedAuthoringPackage>(
            await runtime.Store.GetActiveAsync("acme.author-tools", default));
        AuthoringExecutionTarget resolved = await runtime.ExecutionResolver.ResolveAsync(
            active,
            "acme.command.format",
            AuthoringHostPlatform.ServerLinux);
        AuthoringPackageReceipt uninstalled = await runtime.Activation.UninstallPackageAsync(
            "acme.author-tools");
        AuthoringExecutionTarget stale = await runtime.ExecutionResolver.ResolveAsync(
            active,
            "acme.command.format",
            AuthoringHostPlatform.ServerLinux);

        Assert.Equal(AuthoringPackageTrustStatus.Trusted, installed.TrustStatus);
        Assert.Equal(AuthoringExecutionResolutionStatus.Ready, resolved.Status);
        Assert.Equal(AuthoringExecutionClass.IsolatedWorkerWasm, resolved.ExecutionClass);
        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedPackageNotActive, stale.Status);
        Assert.Matches("^[0-9a-f]{64}$", installed.KeysetIdentity);
        Assert.Equal(AuthoringPackageOperation.Uninstall, uninstalled.Operation);
        Assert.Equal(AuthoringPackageOutcome.Committed, uninstalled.Outcome);
        Assert.Equal(installed.PackageIdentity, uninstalled.PreviousPackageIdentity);
        Assert.Null(await runtime.Store.GetActiveAsync("acme.author-tools", default));
        Assert.True(await runtime.Store.ContainsAsync(installed.PackageIdentity, default));

        await runtime.Store.ActivateAsync("acme.author-tools", installed.PackageIdentity, default);
        LocalAuthoringPackageRuntime fresh = LocalAuthoringPackageComposition.Create(
            directory.Path,
            AuthoringHostPlatform.ServerLinux,
            [key],
            [artifact],
            new FixedTimeProvider(s_now));
        Assert.Null(await fresh.Activation.RecoverActiveAsync("acme.author-tools"));
        Assert.Null(await fresh.Store.GetActiveAsync("acme.author-tools", default));
    }

    [Fact]
    public async Task EcdsaTrustVerifier_UnknownRevokedExpiredAndBadSignature_FailClosed()
    {
        using ECDsa signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        byte[] publicKey = signer.ExportSubjectPublicKeyInfo();
        byte[] archive = Encoding.UTF8.GetBytes("archive");
        byte[] signature = signer.SignData(
            archive,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        var unknown = new EcdsaAuthoringPackageTrustVerifier(
            new LocalAuthoringPackageKeyset([]),
            new FixedTimeProvider(s_now));
        var revoked = new EcdsaAuthoringPackageTrustVerifier(
            new LocalAuthoringPackageKeyset(
            [
                new AuthoringPackagePublisherKey(
                    "acme",
                    "key-1",
                    ImmutableArray.Create(publicKey),
                    s_now.AddHours(-2),
                    s_now.AddHours(1),
                    s_now.AddMinutes(-1))
            ]),
            new FixedTimeProvider(s_now));
        var expired = new EcdsaAuthoringPackageTrustVerifier(
            new LocalAuthoringPackageKeyset(
            [
                new AuthoringPackagePublisherKey(
                    "acme",
                    "key-1",
                    ImmutableArray.Create(publicKey),
                    s_now.AddHours(-2),
                    s_now.AddHours(-1))
            ]),
            new FixedTimeProvider(s_now));
        var valid = new EcdsaAuthoringPackageTrustVerifier(
            new LocalAuthoringPackageKeyset(
            [
                new AuthoringPackagePublisherKey(
                    "acme",
                    "key-1",
                    ImmutableArray.Create(publicKey),
                    s_now.AddHours(-1),
                    s_now.AddHours(1))
            ]),
            new FixedTimeProvider(s_now));

        Assert.Equal(
            AuthoringPackageTrustStatus.UnknownPublisher,
            (await unknown.VerifyAsync("acme", "key-1", archive, signature, default)).Status);
        Assert.Equal(
            AuthoringPackageTrustStatus.Revoked,
            (await revoked.VerifyAsync("acme", "key-1", archive, signature, default)).Status);
        Assert.Equal(
            AuthoringPackageTrustStatus.Expired,
            (await expired.VerifyAsync("acme", "key-1", archive, signature, default)).Status);
        Assert.Equal(
            AuthoringPackageTrustStatus.Untrusted,
            (await valid.VerifyAsync("acme", "key-1", archive, new byte[64], default)).Status);
    }

    [Fact]
    public async Task EcdsaTrustVerifier_KeysetIdentityBindsCompletePublisherKeyset()
    {
        using ECDsa signer = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using ECDsa additional = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        byte[] archive = Encoding.UTF8.GetBytes("archive");
        byte[] signature = signer.SignData(
            archive,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        var selected = new AuthoringPackagePublisherKey(
            "acme",
            "key-1",
            ImmutableArray.Create(signer.ExportSubjectPublicKeyInfo()),
            s_now.AddHours(-1),
            s_now.AddHours(1));
        var extra = new AuthoringPackagePublisherKey(
            "acme",
            "key-2",
            ImmutableArray.Create(additional.ExportSubjectPublicKeyInfo()),
            s_now.AddHours(-1),
            s_now.AddHours(1));
        var oneKey = new EcdsaAuthoringPackageTrustVerifier(
            new LocalAuthoringPackageKeyset([selected]),
            new FixedTimeProvider(s_now));
        var twoKeys = new EcdsaAuthoringPackageTrustVerifier(
            new LocalAuthoringPackageKeyset([extra, selected]),
            new FixedTimeProvider(s_now));

        AuthoringPackageTrustDecision first = await oneKey.VerifyAsync(
            "acme",
            "key-1",
            archive,
            signature,
            default);
        AuthoringPackageTrustDecision second = await twoKeys.VerifyAsync(
            "acme",
            "key-1",
            archive,
            signature,
            default);

        Assert.Equal(AuthoringPackageTrustStatus.Trusted, first.Status);
        Assert.Equal(AuthoringPackageTrustStatus.Trusted, second.Status);
        Assert.NotEqual(first.KeysetIdentity, second.KeysetIdentity);
    }

    [Fact]
    public void PackageStaticGovernance_HasNoRemoteSelfUpdateOrSecondStoreComposition()
    {
        Type[] packageTypes =
        [
            typeof(AuthoringPackageTrustStatus),
            typeof(AuthoringPackageOperation),
            typeof(AuthoringPackageOutcome),
            typeof(AuthoringPackageEntry),
            typeof(AuthoringPackageArtifact),
            typeof(AuthoringPackageArchiveContents),
            typeof(AuthoringPackageTrustDecision),
            typeof(AuthoringPackagePublisherKey),
            typeof(VerifiedAuthoringPackage),
            typeof(AuthoringPackageReceipt),
            typeof(IAuthoringPackageTrustVerifier),
            typeof(IAuthoringPackageKeyset),
            typeof(IAuthoringPackageSourceFetcher),
            typeof(LocalAuthoringPackageKeyset),
            typeof(EcdsaAuthoringPackageTrustVerifier),
            typeof(LocalApprovedAuthoringPackageSourceFetcher),
            typeof(IAuthoringPackageArchiveReader),
            typeof(IAuthoringPackageStore),
            typeof(IAuthoringPackageHealthProbe),
            typeof(IAuthoringPackageReceiptStore),
            typeof(AuthoringPackageVerifier),
            typeof(AuthoringPackageReferencePolicy),
            typeof(AuthoringPackageClosedJson),
            typeof(IAuthoringPackageCompatibilityPrecheck),
            typeof(SchemaStableAuthoringPackageCompatibilityPrecheck),
            typeof(AuthoringPackageActivationCoordinator)
        ];
        Type[] activationTypes =
        [
            typeof(AuthoringPackageIntegrityHealthProbe),
            typeof(AuthoringPackageProductionActivation),
            typeof(LocalAuthoringPackageRuntime),
            typeof(LocalAuthoringPackageComposition)
        ];
        AssertNoRemotePackageAuthority(packageTypes.Concat(activationTypes));
        Assert.Contains("github_pat_", RuntimeMetadataInspection.DescribeConstructors(
            typeof(AuthoringPackageReferencePolicy)), StringComparison.Ordinal);
        Assert.Throws<AuthoringExtensionContractException>(() =>
            AuthoringPackageReferencePolicy.ValidateSource("approved-source/GITHUB_PAT_secret"));
        AssertSoleProductionStoreComposition(activationTypes);
    }

    [Theory]
    [InlineData("http", "HttpClient")]
    [InlineData("process", "Process.Start")]
    [InlineData("assembly", "Assembly.Load")]
    public void PackageStaticGovernance_UncalledNestedAuthority_RejectsExecutableBody(
        string fixture,
        string forbidden)
    {
        Type root = fixture switch
        {
            "http" => typeof(UncalledHttpFixture),
            "process" => typeof(UncalledProcessFixture),
            "assembly" => typeof(UncalledAssemblyFixture),
            _ => throw new ArgumentOutOfRangeException(nameof(fixture))
        };
        string previousRoots = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(root),
            RuntimeMetadataInspection.DescribeConstructors(root));
        Assert.DoesNotContain(forbidden, previousRoots, StringComparison.Ordinal);
        Type nested = Assert.Single(root.GetNestedTypes(BindingFlags.NonPublic));
        Assert.Contains(forbidden, RuntimeMetadataInspection.DescribeType(nested), StringComparison.Ordinal);
        IReadOnlyList<string> members = RuntimeMetadataInspection.DescribeDeclaredMemberReferencesInOrderContaining(
            nested, forbidden);
        Assert.Contains(members, member => member.Contains(forbidden, StringComparison.Ordinal));

        var refusal = Assert.Throws<Xunit.Sdk.DoesNotContainException>(() =>
            AssertNoRemotePackageAuthority([root]));
        Assert.Contains(forbidden, refusal.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void PackageStaticGovernance_UncalledBenignNestedAuthority_IsIncludedAndAccepted()
    {
        Type nested = Assert.Single(typeof(UncalledBenignFixture).GetNestedTypes(BindingFlags.NonPublic));
        Assert.Contains(nested, EnumeratePackageTypeTree(typeof(UncalledBenignFixture)));
        Assert.Contains("benign-package-body", RuntimeMetadataInspection.DescribeType(nested), StringComparison.Ordinal);

        AssertNoRemotePackageAuthority([typeof(UncalledBenignFixture)]);
    }

    [Theory]
    [InlineData("constructor")]
    [InlineData("initializer")]
    [InlineData("nested")]
    public void PackageStaticGovernance_AdditionalStoreSiteOutsideRootMethods_IsRejected(string fixture)
    {
        Type root = fixture switch
        {
            "constructor" => typeof(InstanceStoreFixture),
            "initializer" => typeof(InitializedStoreFixture),
            "nested" => typeof(NestedStoreFixture),
            _ => throw new ArgumentOutOfRangeException(nameof(fixture))
        };
        Assert.DoesNotContain("LocalAuthoringPackageStore..ctor",
            RuntimeMetadataInspection.DescribeType(root), StringComparison.Ordinal);
        StoreConstructionSite site = Assert.Single(FindStoreConstructionSites([root]));
        if (fixture == "constructor")
        {
            Assert.True(site.Method.IsConstructor);
            Assert.False(site.Method.IsStatic);
        }
        else if (fixture == "initializer")
        {
            Assert.Equal(root.TypeInitializer, site.Method);
        }
        else
        {
            Assert.NotEqual(root, site.Method.DeclaringType);
            Assert.Contains(site.Method.DeclaringType!, EnumeratePackageTypeTree(root));
        }

        Type[] roots = [typeof(LocalAuthoringPackageComposition), root];
        Assert.Equal(2, FindStoreConstructionSites(roots).Count);
        Assert.Throws<Xunit.Sdk.SingleException>(() => AssertSoleProductionStoreComposition(roots));
    }

    [Fact]
    public void PackageStaticGovernance_TwoExactConstructionsInOneBody_AreTwoSites()
    {
        IReadOnlyList<StoreConstructionSite> sites = FindStoreConstructionSites([typeof(TwoStoreSitesFixture)]);
        Assert.Equal(2, sites.Count);
        Assert.Equal(sites[0].Method, sites[1].Method);
        Assert.NotEqual(sites[0].Offset, sites[1].Offset);

        Assert.Throws<Xunit.Sdk.SingleException>(() =>
            AssertSoleProductionStoreComposition([typeof(LocalAuthoringPackageComposition), typeof(TwoStoreSitesFixture)]));
    }

    [Fact]
    public void PackageStaticGovernance_StringConstructorDecoy_CannotEstablishStoreComposition()
    {
        string previous = RuntimeMetadataInspection.DescribeType(typeof(StringStoreDecoyFixture));
        Assert.Equal(1, previous.Split("LocalAuthoringPackageStore..ctor", StringSplitOptions.None).Length - 1);
        Assert.Empty(FindStoreConstructionSites([typeof(StringStoreDecoyFixture)]));

        Assert.Throws<Xunit.Sdk.SingleException>(() =>
            AssertSoleProductionStoreComposition([typeof(StringStoreDecoyFixture)]));
    }

    [Fact]
    public void PackageStaticGovernance_OtherTypeConstructorDecoy_CannotEstablishStoreComposition()
    {
        string previous = RuntimeMetadataInspection.DescribeType(typeof(OtherStoreDecoyFixture));
        Assert.Equal(1, previous.Split("LocalAuthoringPackageStore..ctor", StringSplitOptions.None).Length - 1);
        IReadOnlyList<string> members = RuntimeMetadataInspection.DescribeDeclaredMemberReferencesInOrderContaining(
            typeof(OtherStoreDecoyFixture), "LocalAuthoringPackageStore..ctor");
        Assert.Contains(members, member => member.Contains(
            typeof(PackageStoreConstructorDecoy.LocalAuthoringPackageStore).FullName!, StringComparison.Ordinal));
        Assert.Empty(FindStoreConstructionSites([typeof(OtherStoreDecoyFixture)]));

        Assert.Throws<Xunit.Sdk.SingleException>(() =>
            AssertSoleProductionStoreComposition([typeof(OtherStoreDecoyFixture)]));
    }

    [Fact]
    public void PackageStaticGovernance_BenignDecoys_DoNotMultiplyRealProductionComposition()
    {
        Type[] roots =
        [
            typeof(LocalAuthoringPackageComposition),
            typeof(UncalledBenignFixture),
            typeof(StringStoreDecoyFixture),
            typeof(OtherStoreDecoyFixture)
        ];
        StoreConstructionSite site = Assert.Single(FindStoreConstructionSites(roots));
        Assert.Equal(typeof(LocalAuthoringPackageComposition), site.Method.DeclaringType);
        Assert.Equal(nameof(LocalAuthoringPackageComposition.Create), site.Method.Name);

        AssertNoRemotePackageAuthority(roots);
        AssertSoleProductionStoreComposition(roots);
    }

    private const BindingFlags PackageDeclaredMembers =
        BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;

    private static IEnumerable<Type> EnumeratePackageTypeTree(Type root)
    {
        yield return root;
        foreach (Type nested in root.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
        {
            foreach (Type descendant in EnumeratePackageTypeTree(nested))
            {
                yield return descendant;
            }
        }
    }

    private static void AssertNoRemotePackageAuthority(IEnumerable<Type> roots)
    {
        foreach (Type type in roots.SelectMany(EnumeratePackageTypeTree).Distinct())
        {
            string description = string.Join('\n', RuntimeMetadataInspection.DescribeType(type),
                RuntimeMetadataInspection.DescribeConstructors(type));
            Assert.DoesNotContain("HttpClient", description, StringComparison.Ordinal);
            Assert.DoesNotContain("Process.Start", description, StringComparison.Ordinal);
            Assert.DoesNotContain("Assembly.Load", description, StringComparison.Ordinal);
        }
    }

    private static void AssertSoleProductionStoreComposition(IEnumerable<Type> roots)
    {
        StoreConstructionSite site = Assert.Single(FindStoreConstructionSites(roots));
        MethodInfo create = typeof(LocalAuthoringPackageComposition).GetMethod(
            nameof(LocalAuthoringPackageComposition.Create), PackageDeclaredMembers,
            [typeof(string), typeof(AuthoringHostPlatform), typeof(IEnumerable<AuthoringPackagePublisherKey>),
                typeof(IEnumerable<AuthoringPackageArtifact>), typeof(TimeProvider)])!;
        Assert.NotNull(create);
        Assert.Equal(create, site.Method);
    }

    // Count only actual newobj instructions for the production constructor, once per
    // declared body. Text/literals and transitive descriptions cannot establish sites.
    private static IReadOnlyList<StoreConstructionSite> FindStoreConstructionSites(IEnumerable<Type> roots)
    {
        ConstructorInfo constructor = typeof(LocalAuthoringPackageStore).GetConstructor(
            [typeof(string), typeof(AuthoringPackageVerifier), typeof(AuthoringHostPlatform)])!;
        Assert.NotNull(constructor);
        Dictionary<ushort, OpCode> opCodes = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(field => field.FieldType == typeof(OpCode))
            .Select(field => (OpCode)field.GetValue(null)!)
            .GroupBy(code => unchecked((ushort)code.Value))
            .ToDictionary(group => group.Key, group => group.First());
        MethodBase[] bodies = roots.SelectMany(EnumeratePackageTypeTree).Distinct()
            .SelectMany(type => type.GetMethods(PackageDeclaredMembers).Cast<MethodBase>()
                .Concat(type.GetConstructors(PackageDeclaredMembers))
                .Concat(type.TypeInitializer is { } initializer ? [initializer] : []))
            .Distinct().ToArray();
        var sites = new List<StoreConstructionSite>();
        foreach (MethodBase method in bodies)
        {
            byte[]? il = method.GetMethodBody()?.GetILAsByteArray();
            if (il is null)
            {
                continue;
            }
            for (int offset = 0; offset < il.Length;)
            {
                int instructionOffset = offset;
                ushort value = il[offset++];
                if (value == 0xfe)
                {
                    Assert.True(offset < il.Length);
                    value = (ushort)(0xfe00 | il[offset++]);
                }
                Assert.True(opCodes.TryGetValue(value, out OpCode opCode));
                if (opCode.OperandType == OperandType.InlineSwitch)
                {
                    Assert.True(offset + 4 <= il.Length);
                    Assert.True(BitConverter.ToInt32(il, offset) >= 0);
                }
                int size = opCode.OperandType switch
                {
                    OperandType.InlineNone => 0,
                    OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                    OperandType.InlineVar => 2,
                    OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI or OperandType.InlineMethod
                        or OperandType.InlineSig or OperandType.InlineString or OperandType.InlineTok or OperandType.InlineType
                        or OperandType.ShortInlineR => 4,
                    OperandType.InlineI8 or OperandType.InlineR => 8,
                    OperandType.InlineSwitch when offset + 4 <= il.Length => checked(4 + BitConverter.ToInt32(il, offset) * 4),
                    _ => -1
                };
                Assert.True(size >= 0 && size <= il.Length - offset);
                if (opCode == OpCodes.Newobj)
                {
                    Assert.Equal(OperandType.InlineMethod, opCode.OperandType);
                    MethodBase? target = method.Module.ResolveMethod(BitConverter.ToInt32(il, offset),
                        method.DeclaringType?.IsGenericType == true ? method.DeclaringType.GetGenericArguments() : Type.EmptyTypes,
                        method.IsGenericMethod ? method.GetGenericArguments() : Type.EmptyTypes);
                    Assert.NotNull(target);
                    if (constructor.Equals(target))
                    {
                        sites.Add(new StoreConstructionSite(method, instructionOffset));
                    }
                }
                offset += size;
            }
        }
        return sites;
    }

    private sealed record StoreConstructionSite(MethodBase Method, int Offset);

    private static class UncalledHttpFixture
    {
        private static class Nested
        {
            public static object Create() => new System.Net.Http.HttpClient();
        }
    }

    private static class UncalledProcessFixture
    {
        private static class Nested
        {
            public static object? Create() => System.Diagnostics.Process.Start("unused-package-probe");
        }
    }

    private static class UncalledAssemblyFixture
    {
        private static class Nested
        {
            public static object Create() => Assembly.Load("unused-package-probe");
        }
    }

    private static class UncalledBenignFixture
    {
        private static class Nested
        {
            public static string Read() => "benign-package-body";
        }
    }

    private sealed class InstanceStoreFixture
    {
        public InstanceStoreFixture() => GC.KeepAlive(new LocalAuthoringPackageStore(
            "unused-package-probe", null!, AuthoringHostPlatform.ServerLinux));
    }

    private static class InitializedStoreFixture
    {
        static InitializedStoreFixture() => GC.KeepAlive(new LocalAuthoringPackageStore(
            "unused-package-probe", null!, AuthoringHostPlatform.ServerLinux));
    }

    private static class NestedStoreFixture
    {
        private static class Nested
        {
            public static LocalAuthoringPackageStore Create() => new(
                "unused-package-probe", null!, AuthoringHostPlatform.ServerLinux);
        }
    }

    private static class TwoStoreSitesFixture
    {
        public static LocalAuthoringPackageStore Create()
        {
            var first = new LocalAuthoringPackageStore("unused-package-probe", null!, AuthoringHostPlatform.ServerLinux);
            GC.KeepAlive(new LocalAuthoringPackageStore("unused-package-probe", null!, AuthoringHostPlatform.ServerLinux));
            return first;
        }
    }

    private static class StringStoreDecoyFixture
    {
        public static string Read() => "LocalAuthoringPackageStore..ctor";
    }

    private static class OtherStoreDecoyFixture
    {
        public static object Create() => new PackageStoreConstructorDecoy.LocalAuthoringPackageStore();
    }

    [Fact]
    public async Task Recover_UncommittedSwitch_RestoresExactPreviousPackageAndRecordsRollback()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture firstPackage = CreatePackage("1.0.0", "first payload");
        PackageFixture nextPackage = CreatePackage("2.0.0", "next payload");
        ProductionRuntime first = CreateRuntime(directory.Path, firstPackage.Trust);
        AuthoringPackageReceipt committed = await first.Activation.InstallOrUpdateAsync(firstPackage.Artifact);
        VerifiedAuthoringPackage next = await first.Verifier.VerifyAsync(
            nextPackage.Artifact,
            AuthoringHostPlatform.ServerLinux);
        await first.Store.StageAsync(next, default);
        await first.Store.ActivateAsync(next.Contract.Manifest.Id, next.PackageIdentity, default);

        ProductionRuntime fresh = CreateRuntime(directory.Path, firstPackage.Trust);
        VerifiedAuthoringPackage? recovered = await fresh.Activation.RecoverActiveAsync("acme.author-tools");

        Assert.NotNull(recovered);
        Assert.Equal(committed.PackageIdentity, recovered.PackageIdentity);
        AuthoringPackageReceipt? rollback = await fresh.Receipts.GetLastAsync(default);
        Assert.NotNull(rollback);
        Assert.Equal(AuthoringPackageOperation.Rollback, rollback.Operation);
        Assert.Equal(AuthoringPackageOutcome.RolledBack, rollback.Outcome);
        Assert.Equal(next.PackageIdentity, rollback.PackageIdentity);
        Assert.Equal(committed.PackageIdentity, rollback.PreviousPackageIdentity);
    }

    [Fact]
    public async Task Recover_EarlierExtensionAfterAnotherCommit_UsesItsOwnLatestReceipt()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture firstPackage = CreatePackage(
            "1.0.0",
            "first payload",
            extensionId: "acme.author-tools");
        PackageFixture secondPackage = CreatePackage(
            "1.0.0",
            "second payload",
            extensionId: "acme.review-tools");
        ProductionRuntime first = CreateRuntime(directory.Path, firstPackage.Trust);
        AuthoringPackageReceipt firstReceipt = await first.Activation.InstallOrUpdateAsync(firstPackage.Artifact);
        AuthoringPackageReceipt secondReceipt = await first.Activation.InstallOrUpdateAsync(secondPackage.Artifact);
        Assert.NotEqual(firstReceipt.ExtensionId, secondReceipt.ExtensionId);

        ProductionRuntime fresh = CreateRuntime(directory.Path, firstPackage.Trust);
        VerifiedAuthoringPackage? recovered = await fresh.Activation.RecoverActiveAsync("acme.author-tools");

        Assert.NotNull(recovered);
        Assert.Equal(firstReceipt.PackageIdentity, recovered.PackageIdentity);
        Assert.Equal(secondReceipt.ReceiptSha256, (await fresh.Receipts.GetLastAsync(default))?.ReceiptSha256);
    }

    [Fact]
    public async Task Recover_TamperedStoredArchive_FailsClosedAndDeactivatesInitialInstall()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime first = CreateRuntime(directory.Path, fixture.Trust);
        AuthoringPackageReceipt committed = await first.Activation.InstallOrUpdateAsync(fixture.Artifact);
        string archivePath = Path.Combine(
            directory.Path,
            "store",
            "packages",
            committed.PackageIdentity,
            "archive.fspkg");
        MakeWritable(archivePath);
        byte[] tampered = await File.ReadAllBytesAsync(archivePath);
        tampered[^1] ^= 0x01;
        await File.WriteAllBytesAsync(archivePath, tampered);

        ProductionRuntime fresh = CreateRuntime(directory.Path, fixture.Trust);
        VerifiedAuthoringPackage? recovered = await fresh.Activation.RecoverActiveAsync("acme.author-tools");

        Assert.Null(recovered);
        Assert.Null(await fresh.Store.GetActivationStateAsync("acme.author-tools", default));
        AuthoringPackageReceipt? rollback = await fresh.Receipts.GetLastAsync(default);
        Assert.Equal(AuthoringPackageOutcome.RolledBack, rollback?.Outcome);
        Assert.Equal(committed.PackageIdentity, rollback?.PackageIdentity);
    }

    [Fact]
    public async Task Recover_TamperedExtractedContent_FailsClosedAndDeactivatesInitialInstall()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime first = CreateRuntime(directory.Path, fixture.Trust);
        AuthoringPackageReceipt committed = await first.Activation.InstallOrUpdateAsync(fixture.Artifact);
        string contentPath = Path.Combine(
            directory.Path,
            "store",
            "packages",
            committed.PackageIdentity,
            "content",
            "worker",
            "main.wasm");
        MakeWritable(contentPath);
        await File.WriteAllTextAsync(contentPath, "tampered payload");

        ProductionRuntime fresh = CreateRuntime(directory.Path, fixture.Trust);
        VerifiedAuthoringPackage? recovered = await fresh.Activation.RecoverActiveAsync("acme.author-tools");

        Assert.Null(recovered);
        Assert.Null(await fresh.Store.GetActivationStateAsync("acme.author-tools", default));
        Assert.Equal(
            AuthoringPackageOutcome.RolledBack,
            (await fresh.Receipts.GetLastAsync(default))?.Outcome);
    }

    [Fact]
    public async Task Verifier_TamperedSignature_FailsClosed()
    {
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        var verifier = new AuthoringPackageVerifier(
            fixture.Trust,
            new ZipAuthoringPackageArchiveReader(),
            new FixedTimeProvider(s_now));
        AuthoringPackageArtifact tampered = fixture.Artifact with
        {
            Signature = [1, 2, 3]
        };

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await verifier.VerifyAsync(tampered, AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public async Task ReceiptStore_FreshInstanceDetectsTamperedAppend()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime runtime = CreateRuntime(directory.Path, fixture.Trust);
        _ = await runtime.Activation.InstallOrUpdateAsync(fixture.Artifact);
        string receiptPath = Assert.Single(Directory.EnumerateFiles(
            Path.Combine(directory.Path, "receipts"),
            "receipt-*.json"));
        MakeWritable(receiptPath);
        byte[] content = await File.ReadAllBytesAsync(receiptPath);
        content[^2] ^= 0x01;
        await File.WriteAllBytesAsync(receiptPath, content);

        var fresh = new LocalAuthoringPackageReceiptStore(Path.Combine(directory.Path, "receipts"));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fresh.GetLastAsync(default));
    }

    [Fact]
    public async Task ReceiptStore_MissingDefaultEnumField_FailsClosed()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime runtime = CreateRuntime(directory.Path, fixture.Trust);
        _ = await runtime.Activation.InstallOrUpdateAsync(fixture.Artifact);
        string receiptPath = Assert.Single(Directory.EnumerateFiles(
            Path.Combine(directory.Path, "receipts"),
            "receipt-*.json"));
        MakeWritable(receiptPath);
        JsonObject receipt = JsonNode.Parse(await File.ReadAllTextAsync(receiptPath))!.AsObject();
        Assert.True(receipt.Remove("operation"));
        await File.WriteAllTextAsync(receiptPath, receipt.ToJsonString());

        var fresh = new LocalAuthoringPackageReceiptStore(Path.Combine(directory.Path, "receipts"));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fresh.GetLastAsync(default));
    }

    [Fact]
    public async Task Store_DuplicateMetadataOrMissingDefaultTrustField_FailsClosed()
    {
        using var duplicateDirectory = new TemporaryDirectory();
        PackageFixture duplicateFixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime duplicateRuntime = CreateRuntime(duplicateDirectory.Path, duplicateFixture.Trust);
        AuthoringPackageReceipt duplicateReceipt = await duplicateRuntime.Activation.InstallOrUpdateAsync(
            duplicateFixture.Artifact);
        string metadataPath = Path.Combine(
            duplicateDirectory.Path,
            "store",
            "packages",
            duplicateReceipt.PackageIdentity,
            "metadata.json");
        MakeWritable(metadataPath);
        string metadata = await File.ReadAllTextAsync(metadataPath);
        await File.WriteAllTextAsync(metadataPath, metadata.Insert(metadata.Length - 1, ",\"schemaVersion\":1"));
        ProductionRuntime duplicateFresh = CreateRuntime(duplicateDirectory.Path, duplicateFixture.Trust);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await duplicateFresh.Store.ContainsAsync(duplicateReceipt.PackageIdentity, default));

        using var missingDirectory = new TemporaryDirectory();
        PackageFixture missingFixture = CreatePackage("1.0.0", "second payload");
        ProductionRuntime missingRuntime = CreateRuntime(missingDirectory.Path, missingFixture.Trust);
        _ = await missingRuntime.Activation.InstallOrUpdateAsync(missingFixture.Artifact);
        string activationPath = Path.Combine(
            missingDirectory.Path,
            "store",
            "active",
            "acme.author-tools.json");
        MakeWritable(activationPath);
        JsonObject activation = JsonNode.Parse(await File.ReadAllTextAsync(activationPath))!.AsObject();
        Assert.True(activation.Remove("currentTrustStatus"));
        await File.WriteAllTextAsync(activationPath, activation.ToJsonString());
        ProductionRuntime missingFresh = CreateRuntime(missingDirectory.Path, missingFixture.Trust);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await missingFresh.Store.GetActivationStateAsync("acme.author-tools", default));
    }

    [Theory]
    [InlineData("../worker/main.wasm")]
    [InlineData("worker\\main.wasm")]
    [InlineData("/worker/main.wasm")]
    [InlineData("worker//main.wasm")]
    public async Task ArchiveReader_NonCanonicalPaths_AreRejected(string path)
    {
        byte[] archive = CreateRawArchive(("manifest.json", "{}", 0), (path, "payload", 0));
        var reader = new ZipAuthoringPackageArchiveReader();

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await reader.ReadAsync(archive, default));
    }

    [Fact]
    public async Task ArchiveReader_DuplicateLinkPostInstallAndMalformedArchives_AreRejected()
    {
        var reader = new ZipAuthoringPackageArchiveReader();
        byte[] duplicate = CreateRawArchive(
            ("manifest.json", "{}", 0),
            ("worker/main.wasm", "one", 0),
            ("worker/main.wasm", "two", 0));
        byte[] link = CreateRawArchive(
            ("manifest.json", "{}", 0),
            ("worker/main.wasm", "target", unchecked((int)0xA0000000)));
        byte[] postInstall = CreateRawArchive(
            ("manifest.json", "{}", 0),
            ("tools/postinstall", "echo", 0));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await reader.ReadAsync(duplicate, default));
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await reader.ReadAsync(link, default));
        AuthoringPackageArchiveContents parsed = await reader.ReadAsync(postInstall, default);
        Assert.True(Assert.Single(parsed.Entries).IsPostInstallScript);
        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await reader.ReadAsync(new byte[] { 1, 2, 3, 4 }, default));
    }

    [Fact]
    public async Task Verifier_PostInstallArchiveEntry_IsRejectedBeforePersistence()
    {
        PackageFixture fixture = CreatePackage("1.0.0", "echo", path: "tools/postinstall");
        var verifier = new AuthoringPackageVerifier(
            fixture.Trust,
            new ZipAuthoringPackageArchiveReader(),
            new FixedTimeProvider(s_now));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await verifier.VerifyAsync(fixture.Artifact, AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public async Task ArchiveEncodingChanges_ProduceDistinctArchiveBoundPackageIdentities()
    {
        PackageFixture firstPackage = CreatePackage(
            "1.0.0",
            "same payload",
            new DateTimeOffset(2026, 9, 4, 12, 0, 0, TimeSpan.Zero));
        PackageFixture secondPackage = CreatePackage(
            "1.0.0",
            "same payload",
            new DateTimeOffset(2026, 9, 4, 12, 2, 0, TimeSpan.Zero));
        using var directory = new TemporaryDirectory();
        ProductionRuntime runtime = CreateRuntime(directory.Path, firstPackage.Trust);

        VerifiedAuthoringPackage first = await runtime.Verifier.VerifyAsync(
            firstPackage.Artifact,
            AuthoringHostPlatform.ServerLinux);
        VerifiedAuthoringPackage second = await runtime.Verifier.VerifyAsync(
            secondPackage.Artifact,
            AuthoringHostPlatform.ServerLinux);

        Assert.Equal(first.Contract.Manifest.PackageSha256, second.Contract.Manifest.PackageSha256);
        Assert.NotEqual(first.Artifact.ArchiveSha256, second.Artifact.ArchiveSha256);
        Assert.NotEqual(first.PackageIdentity, second.PackageIdentity);
    }

    [Fact]
    public async Task Store_CreatesUserOwnedDirectoriesAndReadOnlyContent_OnUnix()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime runtime = CreateRuntime(directory.Path, fixture.Trust);
        AuthoringPackageReceipt receipt = await runtime.Activation.InstallOrUpdateAsync(fixture.Artifact);
        string packagePath = Path.Combine(directory.Path, "store", "packages", receipt.PackageIdentity);

        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
            File.GetUnixFileMode(Path.Combine(directory.Path, "store", "packages")));
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserExecute,
            File.GetUnixFileMode(packagePath));
        Assert.Equal(
            UnixFileMode.UserRead,
            File.GetUnixFileMode(Path.Combine(packagePath, "archive.fspkg")));
        Assert.Equal(
            UnixFileMode.UserRead,
            File.GetUnixFileMode(Path.Combine(packagePath, "content", "worker", "main.wasm")));
    }

    [Fact]
    public async Task Store_FreshInstanceRejectsUnknownPackageArtifact()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        ProductionRuntime runtime = CreateRuntime(directory.Path, fixture.Trust);
        AuthoringPackageReceipt receipt = await runtime.Activation.InstallOrUpdateAsync(fixture.Artifact);
        string packagePath = Path.Combine(directory.Path, "store", "packages", receipt.PackageIdentity);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                packagePath,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        await File.WriteAllTextAsync(Path.Combine(packagePath, "unexpected.dll"), "not owned");
        ProductionRuntime fresh = CreateRuntime(directory.Path, fixture.Trust);

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await fresh.Store.ContainsAsync(receipt.PackageIdentity, default));
    }

    [Fact]
    public void ProductionActivation_SeparateRecoveryStoreAuthority_IsRejected()
    {
        using var directory = new TemporaryDirectory();
        PackageFixture fixture = CreatePackage("1.0.0", "first payload");
        var verifier = new AuthoringPackageVerifier(
            fixture.Trust,
            new ZipAuthoringPackageArchiveReader(),
            new FixedTimeProvider(s_now));
        var store = new LocalAuthoringPackageStore(
            Path.Combine(directory.Path, "store"),
            verifier,
            AuthoringHostPlatform.ServerLinux);
        var differentStoreInstance = new LocalAuthoringPackageStore(
            Path.Combine(directory.Path, "store"),
            verifier,
            AuthoringHostPlatform.ServerLinux);
        var receipts = new LocalAuthoringPackageReceiptStore(Path.Combine(directory.Path, "receipts"));
        var health = new AuthoringPackageIntegrityHealthProbe(verifier, AuthoringHostPlatform.ServerLinux);
        var coordinator = new AuthoringPackageActivationCoordinator(
            store,
            health,
            receipts,
            new FixedTimeProvider(s_now),
            new SchemaStableAuthoringPackageCompatibilityPrecheck());

        Assert.Throws<AuthoringExtensionContractException>(() =>
            new AuthoringPackageProductionActivation(
                verifier,
                coordinator,
                store,
                differentStoreInstance,
                receipts,
                health,
                new FixedTimeProvider(s_now),
                AuthoringHostPlatform.ServerLinux));
    }

    private static ProductionRuntime CreateRuntime(string root, LocalTrustVerifier trust)
    {
        var verifier = new AuthoringPackageVerifier(
            trust,
            new ZipAuthoringPackageArchiveReader(),
            new FixedTimeProvider(s_now));
        var store = new LocalAuthoringPackageStore(
            Path.Combine(root, "store"),
            verifier,
            AuthoringHostPlatform.ServerLinux);
        var receipts = new LocalAuthoringPackageReceiptStore(Path.Combine(root, "receipts"));
        var health = new AuthoringPackageIntegrityHealthProbe(verifier, AuthoringHostPlatform.ServerLinux);
        var coordinator = new AuthoringPackageActivationCoordinator(
            store,
            health,
            receipts,
            new FixedTimeProvider(s_now),
            new SchemaStableAuthoringPackageCompatibilityPrecheck());
        var activation = new AuthoringPackageProductionActivation(
            verifier,
            coordinator,
            store,
            store,
            receipts,
            health,
            new FixedTimeProvider(s_now),
            AuthoringHostPlatform.ServerLinux);
        return new ProductionRuntime(root, verifier, store, receipts, activation);
    }

    private static PackageFixture CreatePackage(
        string version,
        string payload,
        DateTimeOffset? entryTimestamp = null,
        string path = "worker/main.wasm",
        string extensionId = "acme.author-tools")
    {
        byte[] key = Encoding.UTF8.GetBytes("local-deterministic-publisher-key");
        var trust = new LocalTrustVerifier(key, s_now);
        byte[] payloadBytes = Encoding.UTF8.GetBytes(payload);
        var entry = new AuthoringPackageEntry(
            path,
            ImmutableArray.Create(payloadBytes),
            Digest(payloadBytes));
        ImmutableArray<AuthoringPackageEntry> entries = [entry];
        AuthoringExtensionManifest template = AuthoringExtensionContractsTests.CreateManifest();
        AuthoringExtensionManifest manifest = template with
        {
            Id = extensionId,
            Version = version,
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Contributions =
            [
                template.Contributions[0] with
                {
                    Entrypoint = template.Contributions[0].Entrypoint with
                    {
                        PathOrAdapterId = entry.Path,
                        ContentSha256 = entry.ContentSha256
                    }
                }
            ]
        };
        byte[] archive = CreateRawArchive(
            ("manifest.json", JsonSerializer.Serialize(manifest), 0),
            (entry.Path, payload, 0),
            entryTimestamp);
        byte[] signature = HMACSHA256.HashData(key, archive);
        var artifact = new AuthoringPackageArtifact(
            ImmutableArray.Create(archive),
            ImmutableArray.Create(signature),
            "acme",
            "key-1",
            "approved-source/catalog-1",
            "provenance/build-1",
            Digest(archive));
        return new PackageFixture(artifact, trust);
    }

    private static byte[] CreateRawArchive(params (string Path, string Content, int ExternalAttributes)[] entries) =>
        CreateRawArchive(entries, null);

    private static byte[] CreateRawArchive(
        (string Path, string Content, int ExternalAttributes) first,
        (string Path, string Content, int ExternalAttributes) second,
        DateTimeOffset? timestamp) =>
        CreateRawArchive(new[] { first, second }, timestamp);

    private static byte[] CreateRawArchive(
        (string Path, string Content, int ExternalAttributes)[] entries,
        DateTimeOffset? timestamp)
    {
        using var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach ((string path, string content, int attributes) in entries)
            {
                ZipArchiveEntry entry = archive.CreateEntry(path, CompressionLevel.NoCompression);
                entry.ExternalAttributes = attributes;
                if (timestamp.HasValue)
                {
                    entry.LastWriteTime = timestamp.Value;
                }

                using Stream destination = entry.Open();
                byte[] bytes = Encoding.UTF8.GetBytes(content);
                destination.Write(bytes);
            }
        }

        return stream.ToArray();
    }

    private static string Digest(ReadOnlySpan<byte> content) =>
        Convert.ToHexStringLower(SHA256.HashData(content));

    private static void MakeWritable(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    private sealed record PackageFixture(
        AuthoringPackageArtifact Artifact,
        LocalTrustVerifier Trust);

    private sealed record ProductionRuntime(
        string RootPath,
        AuthoringPackageVerifier Verifier,
        LocalAuthoringPackageStore Store,
        LocalAuthoringPackageReceiptStore Receipts,
        AuthoringPackageProductionActivation Activation);

    private sealed class LocalTrustVerifier(byte[] key, DateTimeOffset now) : IAuthoringPackageTrustVerifier
    {
        public ValueTask<AuthoringPackageTrustDecision> VerifyAsync(
            string publisher,
            string keyId,
            ReadOnlyMemory<byte> archive,
            ReadOnlyMemory<byte> signature,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            byte[] expected = HMACSHA256.HashData(key, archive.Span);
            AuthoringPackageTrustStatus status =
                string.Equals(publisher, "acme", StringComparison.Ordinal) &&
                string.Equals(keyId, "key-1", StringComparison.Ordinal) &&
                signature.Length == expected.Length &&
                CryptographicOperations.FixedTimeEquals(signature.Span, expected)
                    ? AuthoringPackageTrustStatus.Trusted
                    : AuthoringPackageTrustStatus.Untrusted;
            return ValueTask.FromResult(new AuthoringPackageTrustDecision(
                status,
                publisher,
                keyId,
                now,
                now.AddHours(1),
                new string('d', 64)));
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        public TemporaryDirectory()
            : this(System.IO.Path.Combine(
                System.IO.Path.GetTempPath(),
                $"fsus-authoring-package-{Guid.NewGuid():N}"))
        {
        }

        public TemporaryDirectory(string path)
        {
            Path = path;
            Directory.CreateDirectory(Path);
        }

        public string Path
        {
            get;
        }

        public void Dispose()
        {
            if (!Directory.Exists(Path))
            {
                return;
            }

            if (!OperatingSystem.IsWindows())
            {
                foreach (string directory in Directory.EnumerateDirectories(Path, "*", SearchOption.AllDirectories))
                {
                    File.SetUnixFileMode(
                        directory,
                        UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
                }
            }

            Directory.Delete(Path, recursive: true);
        }
    }
}

// A different top-level owner keeps the constructor outside the descriptor's
// same-owner call closure, just like the production store referenced by composition.
internal static class PackageStoreConstructorDecoy
{
    public sealed class LocalAuthoringPackageStore
    {
    }
}
