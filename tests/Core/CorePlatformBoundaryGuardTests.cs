using System.Diagnostics;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;

namespace FsusBlog.V2.Core.Tests;

public sealed class CorePlatformBoundaryGuardTests
{
    [Fact]
    public void CoreProjectAndCompiledAssemblySatisfyBoundaryGuard()
    {
        var repositoryRoot = LocateRepositoryRoot();
        var projectPath = Path.Combine(repositoryRoot, "src", "Core", "FsusBlog.V2.Core.csproj");
        Assert.True(File.Exists(projectPath), $"Expected Core project file at {projectPath}");

        var projectViolations = CorePlatformBoundaryGuard.InspectProjectXml(File.ReadAllText(projectPath));
        Assert.Empty(projectViolations);

        var assemblyPath = typeof(Publishing).Assembly.Location;
        Assert.False(string.IsNullOrWhiteSpace(assemblyPath));
        var assemblyViolations = CorePlatformBoundaryGuard.InspectAssembly(assemblyPath);
        Assert.Empty(assemblyViolations);
    }

    [Fact]
    public void RejectsProjectReferenceOrLinkedSourceFromPlatformOrUpperLayers()
    {
        const string badProject = """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <ProjectReference Include="../Platform/FsusBlog.V2.Platform.csproj" />
                <Compile Include="../Platform/NativeUnixFile.cs" Link="NativeUnixFile.cs" />
              </ItemGroup>
            </Project>
            """;

        var violations = CorePlatformBoundaryGuard.InspectProjectXml(badProject);
        Assert.Contains(violations, item => item.Rule == "project-reference" && item.Detail.Contains("Platform", StringComparison.Ordinal));
        Assert.Contains(violations, item => item.Rule == "linked-source" && item.Detail.Contains("NativeUnixFile.cs", StringComparison.Ordinal));
    }

    [Fact]
    public void RejectsPInvokeDeclarationInCompiledAssembly()
    {
        using var pe = EmitAssembly("Synthetic.PInvoke", module =>
        {
            var type = module.DefineType("Synthetic.NativeProbe", TypeAttributes.Class | TypeAttributes.Abstract | TypeAttributes.Sealed);
            type.DefinePInvokeMethod(
                "open",
                "libc",
                MethodAttributes.Private | MethodAttributes.Static | MethodAttributes.PinvokeImpl,
                CallingConventions.Standard,
                typeof(int),
                [typeof(string), typeof(int)],
                CallingConvention.Winapi,
                CharSet.Ansi);
            type.CreateType();
        });

        var violations = CorePlatformBoundaryGuard.InspectAssembly(pe);
        Assert.Contains(violations, item => item.Rule == "pinvoke-impl" && item.Detail == "libc!open");
    }

    [Fact]
    public void RejectsMethodBodyFileIoCallEvenWithoutAnyAttributes()
    {
        using var pe = EmitAssembly("Synthetic.MethodBodyFileIo", module =>
        {
            var type = module.DefineType("Synthetic.HiddenReader", TypeAttributes.Class | TypeAttributes.Sealed);
            var method = type.DefineMethod("ReadSecret", MethodAttributes.Private | MethodAttributes.Static, typeof(byte[]), [typeof(string)]);
            var il = method.GetILGenerator();
            il.Emit(OpCodes.Ldarg_0);
            il.Emit(OpCodes.Call, typeof(File).GetMethod(nameof(File.ReadAllBytes), [typeof(string)])!);
            il.Emit(OpCodes.Ret);
            type.CreateType();
        });

        var violations = CorePlatformBoundaryGuard.InspectAssembly(pe);
        Assert.Contains(violations, item =>
            item.Rule == "method-body-call" &&
            item.Subject == "Synthetic.HiddenReader.ReadSecret" &&
            item.Detail == "System.IO.File.ReadAllBytes");
    }

    [Fact]
    public void RejectsMethodBodyFileStreamDirectoryInfoAndProcessCalls()
    {
        using var pe = EmitAssembly("Synthetic.SystemCalls", module =>
        {
            var type = module.DefineType("Synthetic.SystemLeaker", TypeAttributes.Class | TypeAttributes.Sealed);

            var openMethod = type.DefineMethod("OpenStream", MethodAttributes.Private | MethodAttributes.Static, typeof(void), [typeof(string)]);
            var openIl = openMethod.GetILGenerator();
            openIl.Emit(OpCodes.Ldarg_0);
            openIl.Emit(OpCodes.Newobj, typeof(DirectoryInfo).GetConstructor([typeof(string)])!);
            openIl.Emit(OpCodes.Pop);
            openIl.Emit(OpCodes.Ldarg_0);
            openIl.Emit(OpCodes.Ldc_I4, (int)FileMode.Open);
            openIl.Emit(OpCodes.Newobj, typeof(FileStream).GetConstructor([typeof(string), typeof(FileMode)])!);
            openIl.Emit(OpCodes.Pop);
            openIl.Emit(OpCodes.Ret);

            var procMethod = type.DefineMethod("Spawn", MethodAttributes.Private | MethodAttributes.Static, typeof(void), []);
            var procIl = procMethod.GetILGenerator();
            procIl.Emit(OpCodes.Ldstr, "FSUSBLOG_TEST");
            procIl.Emit(OpCodes.Call, typeof(Environment).GetMethod(nameof(Environment.GetEnvironmentVariable), [typeof(string)])!);
            procIl.Emit(OpCodes.Newobj, typeof(ProcessStartInfo).GetConstructor([typeof(string)])!);
            procIl.Emit(OpCodes.Call, typeof(Process).GetMethod(nameof(Process.Start), [typeof(ProcessStartInfo)])!);
            procIl.Emit(OpCodes.Pop);
            procIl.Emit(OpCodes.Ret);

            type.CreateType();
        });

        var violations = CorePlatformBoundaryGuard.InspectAssembly(pe);
        Assert.Contains(violations, item => item.Rule == "method-body-call" && item.Detail == "System.IO.DirectoryInfo..ctor");
        Assert.Contains(violations, item => item.Rule == "method-body-call" && item.Detail == "System.IO.FileStream..ctor");
        Assert.Contains(violations, item => item.Rule == "method-body-call" && item.Detail == "System.Environment.GetEnvironmentVariable");
        Assert.Contains(violations, item => item.Rule == "method-body-call" && item.Detail == "System.Diagnostics.Process.Start");
    }

    [Fact]
    public void RejectsDirectAssemblyReferenceToPlatform()
    {
        // Build a synthetic assembly named FsusBlog.V2.Platform and reference a type from it inside a synthetic Core assembly.
        var platformBuilder = new PersistedAssemblyBuilder(new AssemblyName("FsusBlog.V2.Platform"), typeof(object).Assembly);
        var platformModule = platformBuilder.DefineDynamicModule("FsusBlog.V2.Platform");
        var platformType = platformModule.DefineType("FsusBlog.V2.Platform.NativeUnixFile", TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed);
        var platformMethod = platformType.DefineMethod("Supported", MethodAttributes.Public | MethodAttributes.Static, typeof(bool), []);
        var platformIl = platformMethod.GetILGenerator();
        platformIl.Emit(OpCodes.Ldc_I4_1);
        platformIl.Emit(OpCodes.Ret);
        var createdPlatformType = platformType.CreateType();

        using var pe = EmitAssembly("Synthetic.CoreBackflow", module =>
        {
            var type = module.DefineType("Synthetic.CoreCaller", TypeAttributes.Public | TypeAttributes.Sealed);
            var method = type.DefineMethod("Check", MethodAttributes.Public | MethodAttributes.Static, typeof(bool), []);
            var il = method.GetILGenerator();
            il.Emit(OpCodes.Call, createdPlatformType.GetMethod("Supported")!);
            il.Emit(OpCodes.Ret);
            type.CreateType();
        });

        var violations = CorePlatformBoundaryGuard.InspectAssembly(pe);
        Assert.Contains(violations, item => item.Rule == "assembly-ref" && item.Detail == "FsusBlog.V2.Platform");
        Assert.Contains(violations, item => item.Rule == "method-body-call" && item.Detail == "FsusBlog.V2.Platform.NativeUnixFile.Supported");
    }

    [Fact]
    public void AllowsCleanPureDomainAssemblyUsingInMemoryStreamAndCryptography()
    {
        using var pe = EmitAssembly("Synthetic.PureDomain", module =>
        {
            var type = module.DefineType("Synthetic.PureDigest", TypeAttributes.Public | TypeAttributes.Sealed);
            var method = type.DefineMethod("Hash", MethodAttributes.Public | MethodAttributes.Static, typeof(byte[]), [typeof(byte[])]);
            var il = method.GetILGenerator();
            il.Emit(OpCodes.Ldarg_0);
            il.Emit(OpCodes.Newobj, typeof(MemoryStream).GetConstructor([typeof(byte[])])!);
            il.Emit(OpCodes.Call, typeof(SHA256).GetMethod(nameof(SHA256.HashData), [typeof(Stream)])!);
            il.Emit(OpCodes.Ret);
            type.CreateType();
        });

        var violations = CorePlatformBoundaryGuard.InspectAssembly(pe);
        Assert.Empty(violations);
    }

    private static MemoryStream EmitAssembly(string name, Action<ModuleBuilder> build)
    {
        var assembly = new PersistedAssemblyBuilder(new AssemblyName(name), typeof(object).Assembly);
        var module = assembly.DefineDynamicModule(name);
        build(module);
        var stream = new MemoryStream();
        assembly.Save(stream);
        stream.Position = 0;
        return stream;
    }

    private static string LocateRepositoryRoot()
    {
        for (var current = new DirectoryInfo(AppContext.BaseDirectory); current is not null; current = current.Parent)
        {
            if (File.Exists(Path.Combine(current.FullName, "FsusBlog.V2.slnx")))
                return current.FullName;
        }
        throw new InvalidOperationException("Could not locate repository root containing FsusBlog.V2.slnx.");
    }
}
