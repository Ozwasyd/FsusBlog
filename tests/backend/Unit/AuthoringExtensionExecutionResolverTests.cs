using System.Collections.Immutable;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Server.Tests.Unit;

namespace FsusBlog.Server.Tests;

public sealed class AuthoringExtensionExecutionResolverTests
{
    [Fact]
    public async Task ResolveAsync_ThirdPartyTrustedAdapter_FailsClosed()
    {
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.TrustedHostAdapter,
            AuthoringEntrypointFormat.HostAdapterIdentity,
            "fsusblog.authoring.adapter.command");
        var resolver = new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry([]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true));

        await Assert.ThrowsAsync<AuthoringExtensionContractException>(async () =>
            await resolver.ResolveAsync(package, "acme.command.format", AuthoringHostPlatform.ServerLinux));
    }

    [Fact]
    public async Task ResolveAsync_UnsupportedClass_ReturnsBlockedWithoutFallback()
    {
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.OutOfProcessService,
            AuthoringEntrypointFormat.ServiceExecutable,
            "service/main");
        AuthoringExtensionManifest browserManifest = package.Contract.Manifest with
        {
            SupportedPlatforms = [AuthoringHostPlatform.Browser]
        };
        package = package with
        {
            Contract = AuthoringExtensionContractValidator.Verify(browserManifest, AuthoringHostPlatform.Browser)
        };
        var resolver = new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry([]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true));

        AuthoringExecutionTarget result = await resolver.ResolveAsync(
            package,
            "acme.command.format",
            AuthoringHostPlatform.Browser);

        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedUnsupportedPlatform, result.Status);
        Assert.Equal(AuthoringExecutionClass.OutOfProcessService, result.ExecutionClass);
        Assert.Null(result.TrustedAdapterId);
    }

    [Fact]
    public async Task ResolveAsync_WorkerIdentityDrift_ReturnsStableBlockedResult()
    {
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.IsolatedWorkerWasm,
            AuthoringEntrypointFormat.WasmModule,
            "worker/main.wasm");
        var resolver = new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry([]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true));

        AuthoringExecutionTarget result = await resolver.ResolveAsync(
            package,
            "acme.command.format",
            AuthoringHostPlatform.ServerLinux,
            new string('0', 64));

        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedIdentityDrift, result.Status);
        Assert.Equal("runtime-identity-drift", result.BlockedReason);
    }

    [Fact]
    public async Task ResolveAsync_PackageNotActive_ReturnsStableBlockedResult()
    {
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.IsolatedWorkerWasm,
            AuthoringEntrypointFormat.WasmModule,
            "worker/main.wasm");
        var resolver = new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry([]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(false));

        AuthoringExecutionTarget result = await resolver.ResolveAsync(
            package,
            "acme.command.format",
            AuthoringHostPlatform.ServerLinux);

        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedPackageNotActive, result.Status);
        Assert.Equal("package-not-active", result.BlockedReason);
        Assert.Empty(result.RuntimeIdentity);
    }

    [Fact]
    public async Task ResolveAsync_OwnedAdapter_RequiresExactLoadedModule()
    {
        string digest = new string('c', 64);
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.TrustedHostAdapter,
            AuthoringEntrypointFormat.HostAdapterIdentity,
            "fsusblog.authoring.adapter.command",
            publisher: "fsusblog",
            entrypointDigest: digest);
        var descriptor = new TrustedAuthoringAdapterDescriptor(
            "fsusblog.authoring.adapter.command",
            "acme.command.format",
            AuthoringContributionKind.Command,
            1,
            "src/backend/Infrastructure/AuthoringExtensions/CommandAdapter.cs",
            digest,
            "FsusBlog.Server",
            new string('d', 64),
            "authoring-maintainers",
            [AuthoringHostPlatform.ServerLinux]);
        var registry = new ClosedTrustedAuthoringAdapterRegistry([descriptor]);

        AuthoringExecutionTarget mismatch = await new AuthoringExecutionResolver(
            registry,
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(false),
            new ExactInstalledPackageAuthority(true)).ResolveAsync(
                package,
                "acme.command.format",
                AuthoringHostPlatform.ServerLinux);
        AuthoringExecutionTarget ready = await new AuthoringExecutionResolver(
            registry,
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true)).ResolveAsync(
                package,
                "acme.command.format",
                AuthoringHostPlatform.ServerLinux);

        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedUnregisteredAdapter, mismatch.Status);
        Assert.Equal(AuthoringExecutionResolutionStatus.Ready, ready.Status);
        Assert.Equal(descriptor.AdapterId, ready.TrustedAdapterId);
        Assert.Matches("^[0-9a-f]{64}$", ready.TrustedAdapterIdentity);
    }

    [Fact]
    public async Task ResolveAsync_TrustedAdapterPlatformAndDescriptorDrift_FailClosed()
    {
        string digest = new string('c', 64);
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.TrustedHostAdapter,
            AuthoringEntrypointFormat.HostAdapterIdentity,
            "fsusblog.authoring.adapter.command",
            publisher: "fsusblog",
            entrypointDigest: digest,
            targetPlatform: AuthoringHostPlatform.Browser);
        TrustedAuthoringAdapterDescriptor descriptor = CreateDescriptor() with
        {
            SourceSha256 = digest,
            SupportedPlatforms = [AuthoringHostPlatform.ServerLinux]
        };
        var unsupported = new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry([descriptor]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true));

        AuthoringExecutionTarget blocked = await unsupported.ResolveAsync(
            package,
            "acme.command.format",
            AuthoringHostPlatform.Browser);
        Assert.Equal(AuthoringExecutionResolutionStatus.BlockedUnsupportedPlatform, blocked.Status);
        Assert.Equal("trusted-adapter-platform-unsupported", blocked.BlockedReason);

        TrustedAuthoringAdapterDescriptor browserDescriptor = descriptor with
        {
            SupportedPlatforms = [AuthoringHostPlatform.Browser]
        };
        AuthoringExecutionTarget original = await new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry([browserDescriptor]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true)).ResolveAsync(
                package,
                "acme.command.format",
                AuthoringHostPlatform.Browser);
        AuthoringExecutionTarget changed = await new AuthoringExecutionResolver(
            new ClosedTrustedAuthoringAdapterRegistry(
                [browserDescriptor with { ReviewOwner = "security-reviewers" }]),
            new ExactSourceVerifier(true),
            new ExactModuleVerifier(true),
            new ExactInstalledPackageAuthority(true)).ResolveAsync(
                package,
                "acme.command.format",
                AuthoringHostPlatform.Browser);

        Assert.Equal(AuthoringExecutionResolutionStatus.Ready, original.Status);
        Assert.Equal(AuthoringExecutionResolutionStatus.Ready, changed.Status);
        Assert.NotEqual(original.TrustedAdapterIdentity, changed.TrustedAdapterIdentity);
        Assert.NotEqual(original.RuntimeIdentity, changed.RuntimeIdentity);
    }

    [Fact]
    public async Task LoadedModuleVerifier_HashesActualLoadedAssemblyWithoutLoadingCode()
    {
        var assembly = typeof(AuthoringExecutionResolver).Assembly;
        string location = assembly.Location;
        Assert.False(string.IsNullOrWhiteSpace(location));
        string digest = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(location)));
        TrustedAuthoringAdapterDescriptor descriptor = CreateDescriptor() with
        {
            ModuleName = assembly.GetName().Name!,
            ModuleSha256 = digest
        };
        var verifier = new LoadedAssemblyTrustedAuthoringAdapterModuleVerifier();

        Assert.True(await verifier.IsLoadedModuleExactAsync(descriptor, default));
        Assert.False(await verifier.IsLoadedModuleExactAsync(
            descriptor with
            {
                ModuleSha256 = new string('0', 64)
            },
            default));
    }

    [Fact]
    public async Task CheckedInSourceVerifier_HashesActualOwnedSourceAndRejectsDrift()
    {
        const string RelativePath =
            "src/backend/Infrastructure/AuthoringExtensions/AuthoringExtensionExecutionResolver.cs";
        string sourcePath = Path.Combine(BackendTestPaths.RepositoryRoot, RelativePath);
        string digest = Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(sourcePath)));
        TrustedAuthoringAdapterDescriptor descriptor = CreateDescriptor() with
        {
            SourcePath = RelativePath,
            SourceSha256 = digest
        };
        var verifier = new CheckedInAuthoringAdapterSourceVerifier(BackendTestPaths.RepositoryRoot);

        Assert.True(await verifier.IsCheckedInSourceExactAsync(descriptor, default));
        Assert.False(await verifier.IsCheckedInSourceExactAsync(
            descriptor with
            {
                SourceSha256 = new string('0', 64)
            },
            default));
    }

    [Fact]
    public async Task InstalledPackageAuthority_BindsExactActivePackageIdentity()
    {
        VerifiedAuthoringPackage package = await CreateVerifiedPackageAsync(
            AuthoringExecutionClass.IsolatedWorkerWasm,
            AuthoringEntrypointFormat.WasmModule,
            "worker/main.wasm");
        var authority = new ActiveAuthoringInstalledPackageAuthority(new InstalledPackageStore(package));

        Assert.True(await authority.IsActiveExactAsync(package, default));
        Assert.False(await authority.IsActiveExactAsync(
            package with
            {
                PackageIdentity = new string('0', 64)
            },
            default));
    }

    [Fact]
    public void Registry_UnownedSourceOrDuplicateAdapter_FailsClosed()
    {
        TrustedAuthoringAdapterDescriptor descriptor = CreateDescriptor();

        Assert.Throws<AuthoringExtensionContractException>(() =>
            new ClosedTrustedAuthoringAdapterRegistry([descriptor with { SourcePath = "plugins/adapter.cs" }]));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            new ClosedTrustedAuthoringAdapterRegistry([descriptor with { SupportedPlatforms = [] }]));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            new ClosedTrustedAuthoringAdapterRegistry([descriptor, descriptor]));
    }

    [Theory]
    [InlineData(nameof(TrustedAuthoringAdapterDescriptor.SourcePath))]
    [InlineData(nameof(TrustedAuthoringAdapterDescriptor.ReviewOwner))]
    [InlineData(nameof(TrustedAuthoringAdapterDescriptor.ModuleName))]
    [InlineData(nameof(TrustedAuthoringAdapterDescriptor.SourceSha256))]
    [InlineData(nameof(TrustedAuthoringAdapterDescriptor.ModuleSha256))]
    public void Registry_CharacterRules_PreserveEveryUtf16CodeUnit(string field)
    {
        TrustedAuthoringAdapterDescriptor original = CreateDescriptor();
        for (int codeUnit = char.MinValue; codeUnit <= char.MaxValue; codeUnit++)
        {
            char character = (char)codeUnit;
            TrustedAuthoringAdapterDescriptor descriptor = field switch
            {
                nameof(TrustedAuthoringAdapterDescriptor.SourcePath) => original with
                {
                    SourcePath = $"src/backend/adapter-{character}cs"
                },
                nameof(TrustedAuthoringAdapterDescriptor.ReviewOwner) => original with
                {
                    ReviewOwner = $"review-{character}owner"
                },
                nameof(TrustedAuthoringAdapterDescriptor.ModuleName) => original with
                {
                    ModuleName = $"FsusBlog.{character}Server"
                },
                nameof(TrustedAuthoringAdapterDescriptor.SourceSha256) => original with
                {
                    SourceSha256 = new string('a', 63) + character
                },
                nameof(TrustedAuthoringAdapterDescriptor.ModuleSha256) => original with
                {
                    ModuleSha256 = new string('a', 63) + character
                },
                _ => throw new ArgumentOutOfRangeException(nameof(field))
            };
            bool shouldReject = field switch
            {
                nameof(TrustedAuthoringAdapterDescriptor.SourcePath) => char.IsControl(character) || character == '\\',
                nameof(TrustedAuthoringAdapterDescriptor.ReviewOwner) => char.IsControl(character),
                nameof(TrustedAuthoringAdapterDescriptor.ModuleName) =>
                    !char.IsAsciiLetterOrDigit(character) && character is not '.' and not '-',
                _ => !"0123456789abcdef".Contains(character)
            };
            Exception? exception = Record.Exception(() => new ClosedTrustedAuthoringAdapterRegistry([descriptor]));
            Assert.True(shouldReject ? exception is AuthoringExtensionContractException : exception is null,
                $"{field} U+{codeUnit:X4}");
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(63)]
    [InlineData(65)]
    [InlineData(128)]
    public void Registry_NonSha256Lengths_FailsClosed(int length)
    {
        TrustedAuthoringAdapterDescriptor descriptor = CreateDescriptor();
        Assert.Throws<AuthoringExtensionContractException>(() =>
            new ClosedTrustedAuthoringAdapterRegistry([descriptor with { SourceSha256 = new string('a', length) }]));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            new ClosedTrustedAuthoringAdapterRegistry([descriptor with { ModuleSha256 = new string('a', length) }]));
    }

    [Fact]
    public void Registry_PlatformSet_PreservesDefinedAndClosedMembers()
    {
        TrustedAuthoringAdapterDescriptor original = CreateDescriptor();
        foreach (AuthoringHostPlatform platform in Enum.GetValues<AuthoringHostPlatform>())
        {
            TrustedAuthoringAdapterDescriptor descriptor = original with
            {
                SupportedPlatforms = [platform]
            };
            Assert.Same(descriptor, new ClosedTrustedAuthoringAdapterRegistry([descriptor]).Find(descriptor.AdapterId));
            Assert.Throws<AuthoringExtensionContractException>(() =>
                new ClosedTrustedAuthoringAdapterRegistry([descriptor with
                {
                    SupportedPlatforms = [platform, platform]
                }]));
        }
        foreach (int value in new[] { int.MinValue, -1, 3, int.MaxValue })
        {
            Assert.Throws<AuthoringExtensionContractException>(() =>
                new ClosedTrustedAuthoringAdapterRegistry([original with
                {
                    SupportedPlatforms = [AuthoringHostPlatform.ServerLinux, (AuthoringHostPlatform)value]
                }]));
        }
        TrustedAuthoringAdapterDescriptor allPlatforms = original with
        {
            SupportedPlatforms = [.. Enum.GetValues<AuthoringHostPlatform>()]
        };
        Assert.Same(allPlatforms, new ClosedTrustedAuthoringAdapterRegistry([allPlatforms]).Find(allPlatforms.AdapterId));
        Assert.Throws<AuthoringExtensionContractException>(() =>
            new ClosedTrustedAuthoringAdapterRegistry([original with { SupportedPlatforms = default }]));
    }

    [Fact]
    public void ResolverSource_HasNoDynamicOrPrivateHostLoadingSurface()
    {
        Type[] resolverTypes =
        [
            typeof(AuthoringExecutionResolutionStatus),
            typeof(TrustedAuthoringAdapterDescriptor),
            typeof(AuthoringExecutionTarget),
            typeof(ITrustedAuthoringAdapterRegistry),
            typeof(ITrustedAuthoringAdapterModuleVerifier),
            typeof(ITrustedAuthoringAdapterSourceVerifier),
            typeof(CheckedInAuthoringAdapterSourceVerifier),
            typeof(IAuthoringInstalledPackageAuthority),
            typeof(IAuthoringInstalledPackageReadScope),
            typeof(IAuthoringInstalledPackageAsyncReadScope),
            typeof(IAuthoringPackageReadScopeStore),
            typeof(IAuthoringInstalledPackageReadScopeAuthority),
            typeof(ActiveAuthoringInstalledPackageAuthority),
            typeof(LoadedAssemblyTrustedAuthoringAdapterModuleVerifier),
            typeof(ClosedTrustedAuthoringAdapterRegistry),
            typeof(AuthoringExecutionResolver),
            typeof(AuthoringTerminalReadScopes)
        ];
        Assert.All(resolverTypes, AssertNoResolverSurface);
    }

    private static void AssertNoResolverSurface(Type rootType)
    {
        foreach (Type type in EnumerateResolverTypeTree(rootType))
        {
            AssertNoCompiledResolverSurface(type);
            AssertNoErasedResolverSurface(type);
        }
    }

    private static void AssertNoCompiledResolverSurface(Type type)
    {
        string compiled = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(type),
            RuntimeMetadataInspection.DescribeConstructors(type));
        Assert.DoesNotContain("Assembly.Load", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Activator.CreateInstance", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("editorRef", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Pinia", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("IServiceProvider", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("WebView", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("iframe", compiled, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Delegate", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("Microsoft.CSharp.RuntimeBinder", compiled, StringComparison.Ordinal);
        Assert.DoesNotContain("System.Runtime.CompilerServices.CallSite", compiled, StringComparison.Ordinal);
    }

    private static IEnumerable<Type> EnumerateResolverTypeTree(Type type)
    {
        yield return type;
        foreach (Type nested in type.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
        {
            foreach (Type descendant in EnumerateResolverTypeTree(nested))
            {
                yield return descendant;
            }
        }
    }

    private static void AssertNoErasedResolverSurface(Type type)
    {
        const BindingFlags Declared = BindingFlags.DeclaredOnly | BindingFlags.Public | BindingFlags.NonPublic |
            BindingFlags.Instance | BindingFlags.Static;
        AssertNoDynamicAttribute(type.CustomAttributes);
        foreach (MemberInfo member in type.GetMembers(Declared))
        {
            AssertNoDynamicAttribute(member.CustomAttributes);
            Type? valueType = member switch
            {
                FieldInfo field => field.FieldType,
                PropertyInfo property => property.PropertyType,
                EventInfo eventInfo => eventInfo.EventHandlerType,
                MethodInfo method => method.ReturnType,
                _ => null
            };
            if (valueType is not null)
            {
                Assert.False(IsFuncOrAction(valueType), $"{type.FullName}.{member.Name}: Func/Action");
                Assert.False(member.Name == "Payload" && IsObjectPayloadType(valueType),
                    $"{type.FullName}.{member.Name}: object Payload");
            }

            if (member is MethodInfo methodInfo)
            {
                AssertNoDynamicAttribute(methodInfo.ReturnParameter.CustomAttributes);
            }

            if (member is MethodBase methodBase)
            {
                foreach (ParameterInfo parameter in methodBase.GetParameters())
                {
                    AssertNoDynamicAttribute(parameter.CustomAttributes);
                    Assert.False(IsFuncOrAction(parameter.ParameterType),
                        $"{type.FullName}.{member.Name}({parameter.Name}): Func/Action");
                    Assert.False(parameter.Name == "Payload" && IsObjectPayloadType(parameter.ParameterType),
                        $"{type.FullName}.{member.Name}({parameter.Name}): object Payload");
                }
            }
        }
    }

    private static void AssertNoDynamicAttribute(IEnumerable<CustomAttributeData> attributes) =>
        Assert.DoesNotContain(attributes, attribute => attribute.AttributeType == typeof(DynamicAttribute));

    private static bool IsObjectPayloadType(Type type) =>
        type == typeof(object) || type.IsByRef && type.GetElementType() == typeof(object);

    private static bool IsFuncOrAction(Type type)
    {
        if (type.HasElementType)
        {
            return IsFuncOrAction(type.GetElementType()!);
        }

        return type.Namespace == "System" &&
               (type.Name == "Action" || type.Name.StartsWith("Action`", StringComparison.Ordinal) ||
                type.Name.StartsWith("Func`", StringComparison.Ordinal)) ||
               type.IsGenericType && type.GetGenericArguments().Any(IsFuncOrAction);
    }

    [Fact]
    public void ResolverSurface_RejectsUncalledNestedLiteral()
    {
        Type root = typeof(NestedTextFixture);
        Type nested = root.GetNestedType("Node", BindingFlags.NonPublic)!;
        Assert.NotNull(nested);
        Assert.Contains(nested, EnumerateResolverTypeTree(root));
        MethodInfo method = nested.GetMethod("Read")!;
        Assert.Equal(nested, method.DeclaringType);
        Assert.NotNull(method.GetMethodBody());
        string oldRoots = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(root),
            RuntimeMetadataInspection.DescribeConstructors(root));
        Assert.DoesNotContain("Pinia", oldRoots, StringComparison.Ordinal);
        string nestedBody = RuntimeMetadataInspection.DescribeMethods(nested, "Read");
        Assert.Contains("Pinia", nestedBody, StringComparison.Ordinal);
        AssertNoErasedResolverSurface(root);
        AssertNoErasedResolverSurface(nested);

        Xunit.Sdk.XunitException exception = Assert.ThrowsAny<Xunit.Sdk.XunitException>(() =>
            AssertNoResolverSurface(root));
        Assert.Contains("Pinia", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ResolverSurface_RejectsNestedErasedInput()
    {
        Type root = typeof(NestedInputFixture);
        Type nested = root.GetNestedType("Node", BindingFlags.NonPublic)!;
        Assert.NotNull(nested);
        MethodInfo method = nested.GetMethod("Read")!;
        Assert.Equal(nested, method.DeclaringType);
        ParameterInfo parameter = Assert.Single(method.GetParameters());
        Assert.Equal(typeof(object), parameter.ParameterType);
        Assert.Contains(parameter.CustomAttributes,
            attribute => attribute.AttributeType == typeof(DynamicAttribute));

        AssertNestedErasedFixtureRefusal(root, nested, "DynamicAttribute");
    }

    [Fact]
    public void ResolverSurface_RejectsNestedErasedOutput()
    {
        Type root = typeof(NestedOutputFixture);
        Type nested = root.GetNestedType("Node", BindingFlags.NonPublic)!;
        Assert.NotNull(nested);
        MethodInfo method = nested.GetMethod("Read")!;
        Assert.Equal(nested, method.DeclaringType);
        Assert.Equal(typeof(object), method.ReturnType);
        Assert.Contains(method.ReturnParameter.CustomAttributes,
            attribute => attribute.AttributeType == typeof(DynamicAttribute));

        AssertNestedErasedFixtureRefusal(root, nested, "DynamicAttribute");
    }

    [Fact]
    public void ResolverSurface_RejectsNestedFactorySignature()
    {
        Type root = typeof(NestedFactoryFixture);
        Type nested = root.GetNestedType("Node", BindingFlags.NonPublic)!;
        Assert.NotNull(nested);
        PropertyInfo property = nested.GetProperty("Factory")!;
        Assert.Equal(nested, property.DeclaringType);
        Assert.Equal(typeof(Func<int>), property.PropertyType);
        Assert.True(IsFuncOrAction(property.PropertyType));

        AssertNestedErasedFixtureRefusal(root, nested, "Func/Action");
    }

    [Fact]
    public void ResolverSurface_RejectsNestedHandlerSignature()
    {
        Type root = typeof(NestedHandlerFixture);
        Type nested = root.GetNestedType("Node", BindingFlags.NonPublic)!;
        Assert.NotNull(nested);
        PropertyInfo property = nested.GetProperty("Handler")!;
        Assert.Equal(nested, property.DeclaringType);
        Assert.Equal(typeof(Action<int>), property.PropertyType);
        Assert.True(IsFuncOrAction(property.PropertyType));

        AssertNestedErasedFixtureRefusal(root, nested, "Func/Action");
    }

    [Fact]
    public void ResolverSurface_RejectsNestedObjectPayload()
    {
        Type root = typeof(NestedValueFixture);
        Type nested = root.GetNestedType("Node", BindingFlags.NonPublic)!;
        Assert.NotNull(nested);
        PropertyInfo property = nested.GetProperty("Payload")!;
        Assert.Equal(nested, property.DeclaringType);
        Assert.Equal("Payload", property.Name);
        Assert.Equal(typeof(object), property.PropertyType);

        AssertNestedErasedFixtureRefusal(root, nested, "object Payload");
    }

    [Fact]
    public void ResolverSurface_AcceptsUnrelatedReferenceInputWithObjectShape()
    {
        Type root = typeof(ReferenceInputFixture);
        ParameterInfo parameter = Assert.Single(root.GetMethod("Read")!.GetParameters());
        Assert.Equal("payload", parameter.Name);
        Assert.True(parameter.ParameterType.IsByRef);
        Assert.NotEqual(typeof(object), parameter.ParameterType);
        Assert.Equal(typeof(object), parameter.ParameterType.GetElementType());
        Assert.True(IsObjectPayloadType(parameter.ParameterType));
        Assert.False(parameter.Name == "Payload" && IsObjectPayloadType(parameter.ParameterType));

        AssertNoCompiledResolverSurface(root);
        AssertNoResolverSurface(root);
    }

    [Fact]
    public void ResolverSurface_RejectsReferencePayloadOutput()
    {
        Type root = typeof(ReferenceOutputFixture);
        MethodInfo method = root.GetMethod("Payload")!;
        Assert.Equal("Payload", method.Name);
        Assert.True(method.ReturnType.IsByRef);
        Assert.NotEqual(typeof(object), method.ReturnType);
        Assert.Equal(typeof(object), method.ReturnType.GetElementType());

        AssertReferenceFixtureRefusal(root);
    }

    [Fact]
    public void ResolverSurface_RejectsReferencePayloadMember()
    {
        Type root = typeof(ReferenceMemberFixture);
        PropertyInfo property = root.GetProperty("Payload")!;
        Assert.Equal(root, property.DeclaringType);
        Assert.Equal("Payload", property.Name);
        Assert.True(property.PropertyType.IsByRef);
        Assert.NotEqual(typeof(object), property.PropertyType);
        Assert.Equal(typeof(object), property.PropertyType.GetElementType());

        AssertReferenceFixtureRefusal(root);
    }

    [Fact]
    public void ResolverSurface_AcceptsNestedUnrelatedObjectAndReference()
    {
        Type root = typeof(SafeTreeFixture);
        Type nested = root.GetNestedType("Node", BindingFlags.NonPublic)!;
        Assert.NotNull(nested);
        Assert.Contains(nested, EnumerateResolverTypeTree(root));
        MethodInfo method = nested.GetMethod("Read")!;
        Assert.Equal(nested, method.DeclaringType);
        Assert.NotNull(method.GetMethodBody());
        ParameterInfo parameter = Assert.Single(nested.GetMethod("Read")!.GetParameters());
        Assert.Equal("value", parameter.Name);
        Assert.Equal(typeof(object), parameter.ParameterType);
        PropertyInfo property = nested.GetProperty("Current")!;
        Assert.Equal("Current", property.Name);
        Assert.True(property.PropertyType.IsByRef);
        Assert.Equal(typeof(object), property.PropertyType.GetElementType());
        Assert.False(IsObjectPayloadType(typeof(object[])));
        string oldRoots = string.Join('\n',
            RuntimeMetadataInspection.DescribeType(root),
            RuntimeMetadataInspection.DescribeConstructors(root));
        Assert.DoesNotContain(".Read ", oldRoots, StringComparison.Ordinal);
        string nestedBody = RuntimeMetadataInspection.DescribeMethods(nested, "Read");
        Assert.Contains("closed-surface", nestedBody, StringComparison.Ordinal);

        AssertNoResolverSurface(root);
    }

    private static void AssertNestedErasedFixtureRefusal(Type root, Type nested, string diagnostic)
    {
        Assert.Contains(nested, EnumerateResolverTypeTree(root));
        AssertNoErasedResolverSurface(root);
        Assert.All(EnumerateResolverTypeTree(root), AssertNoCompiledResolverSurface);
        Xunit.Sdk.XunitException exception = Assert.ThrowsAny<Xunit.Sdk.XunitException>(() =>
            AssertNoResolverSurface(root));
        Assert.Contains(diagnostic, exception.Message, StringComparison.Ordinal);
    }

    private static void AssertReferenceFixtureRefusal(Type root)
    {
        Assert.Equal(root, Assert.Single(EnumerateResolverTypeTree(root)));
        AssertNoCompiledResolverSurface(root);
        Xunit.Sdk.XunitException exception = Assert.ThrowsAny<Xunit.Sdk.XunitException>(() =>
            AssertNoResolverSurface(root));
        Assert.Contains("object Payload", exception.Message, StringComparison.Ordinal);
    }

    private sealed class NestedTextFixture
    {
        private sealed class Node
        {
            public static string Read() => "Pinia";
        }
    }

    private sealed class NestedInputFixture
    {
        private sealed class Node
        {
            public static void Read(dynamic value)
            {
            }
        }
    }

    private sealed class NestedOutputFixture
    {
        private sealed class Node
        {
            public static dynamic Read() => new object();
        }
    }

    private sealed class NestedFactoryFixture
    {
        private sealed class Node
        {
            public Func<int>? Factory => null;
        }
    }

    private sealed class NestedHandlerFixture
    {
        private sealed class Node
        {
            public Action<int>? Handler => null;
        }
    }

    private sealed class NestedValueFixture
    {
        private sealed class Node
        {
            public object Payload => new();
        }
    }

    private sealed class ReferenceInputFixture
    {
        public static void Read(ref object payload)
        {
        }
    }

    private sealed class ReferenceOutputFixture
    {
        private static object s_value = new();

        public static ref object Payload() => ref s_value;
    }

    private sealed class ReferenceMemberFixture
    {
        private static object s_value = new();

        public static ref object Payload => ref s_value;
    }

    private sealed class SafeTreeFixture
    {
        private sealed class Node
        {
            private static object s_value = new();

            public static object Read(object value) => "closed-surface";

            public static ref object Current => ref s_value;
        }
    }

    private static TrustedAuthoringAdapterDescriptor CreateDescriptor() => new(
        "fsusblog.authoring.adapter.command",
        "acme.command.format",
        AuthoringContributionKind.Command,
        1,
        "src/backend/Infrastructure/AuthoringExtensions/CommandAdapter.cs",
        new string('c', 64),
        "FsusBlog.Server",
        new string('d', 64),
        "authoring-maintainers",
        [AuthoringHostPlatform.ServerLinux]);

    private static async ValueTask<VerifiedAuthoringPackage> CreateVerifiedPackageAsync(
        AuthoringExecutionClass executionClass,
        AuthoringEntrypointFormat format,
        string path,
        string publisher = "acme",
        string? entrypointDigest = null,
        AuthoringHostPlatform targetPlatform = AuthoringHostPlatform.ServerLinux)
    {
        byte[] archive = "archive"u8.ToArray();
        byte[] entryBytes = "entry"u8.ToArray();
        string entryDigest = entrypointDigest ?? Convert.ToHexStringLower(SHA256.HashData(entryBytes));
        ImmutableArray<AuthoringPackageEntry> entries = executionClass == AuthoringExecutionClass.TrustedHostAdapter
            ? [new AuthoringPackageEntry("content/data", ImmutableArray.Create(entryBytes), Convert.ToHexStringLower(SHA256.HashData(entryBytes)))]
            : [new AuthoringPackageEntry(path, ImmutableArray.Create(entryBytes), entryDigest)];
        AuthoringContributionDeclaration contribution = AuthoringExtensionContractsTests.CreateManifest().Contributions[0] with
        {
            ExecutionClass = executionClass,
            Entrypoint = new AuthoringEntrypointIdentity(format, path, entryDigest)
        };
        AuthoringExtensionManifest manifest = AuthoringExtensionContractsTests.CreateManifest() with
        {
            Publisher = publisher,
            SupportedPlatforms = [targetPlatform],
            PackageSha256 = AuthoringPackageVerifier.ComputePackageDigest(entries),
            ContentSha256 = AuthoringPackageVerifier.ComputeContentDigest(entries),
            Contributions = [contribution]
        };
        ImmutableArray<byte> manifestBytes = ImmutableArray.Create(JsonSerializer.SerializeToUtf8Bytes(manifest));
        var artifact = new AuthoringPackageArtifact(
            ImmutableArray.Create(archive),
            [1],
            publisher,
            "key-1",
            "approved-source/catalog-1",
            "provenance/build-1",
            Convert.ToHexStringLower(SHA256.HashData(archive)));
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var verifier = new AuthoringPackageVerifier(
            new TrustedVerifier(now),
            new ArchiveReader(new AuthoringPackageArchiveContents(manifestBytes, entries)),
            new FixedTimeProvider(now));
        return await verifier.VerifyAsync(artifact, targetPlatform);
    }

    private sealed class ExactModuleVerifier(bool exact) : ITrustedAuthoringAdapterModuleVerifier
    {
        public ValueTask<bool> IsLoadedModuleExactAsync(
            TrustedAuthoringAdapterDescriptor descriptor,
            CancellationToken cancellationToken) => ValueTask.FromResult(exact);
    }

    private sealed class ExactSourceVerifier(bool exact) : ITrustedAuthoringAdapterSourceVerifier
    {
        public ValueTask<bool> IsCheckedInSourceExactAsync(
            TrustedAuthoringAdapterDescriptor descriptor,
            CancellationToken cancellationToken) => ValueTask.FromResult(exact);
    }

    private sealed class ExactInstalledPackageAuthority(bool active) : IAuthoringInstalledPackageAuthority
    {
        public ValueTask<bool> IsActiveExactAsync(
            VerifiedAuthoringPackage package,
            CancellationToken cancellationToken) => ValueTask.FromResult(active);
    }

    private sealed class InstalledPackageStore(VerifiedAuthoringPackage active) : IAuthoringPackageStore
    {
        public ValueTask<VerifiedAuthoringPackage?> GetActiveAsync(
            string extensionId,
            CancellationToken cancellationToken) => ValueTask.FromResult<VerifiedAuthoringPackage?>(active);

        public ValueTask<bool> ContainsAsync(string packageIdentity, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask StageAsync(VerifiedAuthoringPackage package, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask ActivateAsync(
            string extensionId,
            string packageIdentity,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask DeactivateAsync(
            string extensionId,
            string expectedPackageIdentity,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public ValueTask RemoveStagedAsync(string packageIdentity, CancellationToken cancellationToken) =>
            throw new NotSupportedException();

        public ValueTask AssertContentUnchangedAsync(
            string packageIdentity,
            CancellationToken cancellationToken) => throw new NotSupportedException();
    }

    private sealed class TrustedVerifier(DateTimeOffset now) : IAuthoringPackageTrustVerifier
    {
        public ValueTask<AuthoringPackageTrustDecision> VerifyAsync(
            string publisher,
            string keyId,
            ReadOnlyMemory<byte> archive,
            ReadOnlyMemory<byte> signature,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(new AuthoringPackageTrustDecision(
                AuthoringPackageTrustStatus.Trusted,
                publisher,
                keyId,
                now,
                now.AddMinutes(5),
                new string('d', 64)));
    }

    private sealed class ArchiveReader(AuthoringPackageArchiveContents contents) : IAuthoringPackageArchiveReader
    {
        public ValueTask<AuthoringPackageArchiveContents> ReadAsync(
            ReadOnlyMemory<byte> canonicalArchive,
            CancellationToken cancellationToken) => ValueTask.FromResult(contents);
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
