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
        var projectPath = Path.Combine(LocateRepositoryRoot(), "src", "Core", "FsusBlog.V2.Core.csproj");
        Assert.True(File.Exists(projectPath), $"Expected Core project file at {projectPath}");
        Assert.Empty(CorePlatformBoundaryGuard.InspectProjectXml(File.ReadAllText(projectPath)));

        var assemblyPath = typeof(Publishing).Assembly.Location;
        Assert.False(string.IsNullOrWhiteSpace(assemblyPath));
        Assert.Empty(CorePlatformBoundaryGuard.InspectAssembly(assemblyPath));
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
        using var pe = EmitType("Synthetic.PInvoke", "Synthetic.NativeProbe", TypeAttributes.Class | TypeAttributes.Abstract | TypeAttributes.Sealed, type =>
            type.DefinePInvokeMethod("open", "libc", MethodAttributes.Private | MethodAttributes.Static | MethodAttributes.PinvokeImpl,
                CallingConventions.Standard, typeof(int), [typeof(string), typeof(int)], CallingConvention.Winapi, CharSet.Ansi));

        AssertViolation(CorePlatformBoundaryGuard.InspectAssembly(pe), "pinvoke-impl", "libc!open");
    }

    [Fact]
    public void RejectsMethodBodyFileIoCallEvenWithoutAnyAttributes()
    {
        using var pe = EmitSingleMethod("Synthetic.MethodBodyFileIo", "Synthetic.HiddenReader", "ReadSecret", typeof(byte[]), [typeof(string)], il =>
        {
            il.Emit(OpCodes.Ldarg_0);
            il.Emit(OpCodes.Call, typeof(File).GetMethod(nameof(File.ReadAllBytes), [typeof(string)])!);
            il.Emit(OpCodes.Ret);
        });

        AssertViolation(CorePlatformBoundaryGuard.InspectAssembly(pe), "method-body-call", "System.IO.File.ReadAllBytes", "Synthetic.HiddenReader.ReadSecret");
    }

    [Fact]
    public void RejectsMethodBodyFileStreamDirectoryInfoAndProcessCalls()
    {
        using var pe = EmitType("Synthetic.SystemCalls", "Synthetic.SystemLeaker", TypeAttributes.Class | TypeAttributes.Sealed, type =>
        {
            EmitMethod(type, "OpenStream", typeof(void), [typeof(string)], il =>
            {
                il.Emit(OpCodes.Ldarg_0);
                il.Emit(OpCodes.Newobj, typeof(DirectoryInfo).GetConstructor([typeof(string)])!);
                il.Emit(OpCodes.Pop);
                il.Emit(OpCodes.Ldarg_0);
                il.Emit(OpCodes.Ldc_I4, (int)FileMode.Open);
                il.Emit(OpCodes.Newobj, typeof(FileStream).GetConstructor([typeof(string), typeof(FileMode)])!);
                il.Emit(OpCodes.Pop);
                il.Emit(OpCodes.Ret);
            });
            EmitMethod(type, "Spawn", typeof(void), [], il =>
            {
                il.Emit(OpCodes.Ldstr, "FSUSBLOG_TEST");
                il.Emit(OpCodes.Call, typeof(Environment).GetMethod(nameof(Environment.GetEnvironmentVariable), [typeof(string)])!);
                il.Emit(OpCodes.Newobj, typeof(ProcessStartInfo).GetConstructor([typeof(string)])!);
                il.Emit(OpCodes.Call, typeof(Process).GetMethod(nameof(Process.Start), [typeof(ProcessStartInfo)])!);
                il.Emit(OpCodes.Pop);
                il.Emit(OpCodes.Ret);
            });
        });

        var violations = CorePlatformBoundaryGuard.InspectAssembly(pe);
        foreach (var detail in new[] { "System.IO.DirectoryInfo..ctor", "System.IO.FileStream..ctor", "System.Environment.GetEnvironmentVariable", "System.Diagnostics.Process.Start" })
            AssertViolation(violations, "method-body-call", detail);
    }

    [Fact]
    public void RejectsDirectAssemblyReferenceToPlatform()
    {
        var platformBuilder = new PersistedAssemblyBuilder(new AssemblyName("FsusBlog.V2.Platform"), typeof(object).Assembly);
        var platformType = platformBuilder.DefineDynamicModule("FsusBlog.V2.Platform")
            .DefineType("FsusBlog.V2.Platform.NativeUnixFile", TypeAttributes.Public | TypeAttributes.Abstract | TypeAttributes.Sealed);
        EmitMethod(platformType, "Supported", typeof(bool), [], il => { il.Emit(OpCodes.Ldc_I4_1); il.Emit(OpCodes.Ret); }, MethodAttributes.Public | MethodAttributes.Static);
        var createdPlatformType = platformType.CreateType();

        using var pe = EmitSingleMethod("Synthetic.CoreBackflow", "Synthetic.CoreCaller", "Check", typeof(bool), [], il =>
        {
            il.Emit(OpCodes.Call, createdPlatformType.GetMethod("Supported")!);
            il.Emit(OpCodes.Ret);
        });

        var violations = CorePlatformBoundaryGuard.InspectAssembly(pe);
        AssertViolation(violations, "assembly-ref", "FsusBlog.V2.Platform");
        AssertViolation(violations, "method-body-call", "FsusBlog.V2.Platform.NativeUnixFile.Supported");
    }

    [Fact]
    public void AllowsCleanPureDomainAssemblyUsingInMemoryStreamAndCryptography()
    {
        using var pe = EmitSingleMethod("Synthetic.PureDomain", "Synthetic.PureDigest", "Hash", typeof(byte[]), [typeof(byte[])], il =>
        {
            il.Emit(OpCodes.Ldarg_0);
            il.Emit(OpCodes.Newobj, typeof(MemoryStream).GetConstructor([typeof(byte[])])!);
            il.Emit(OpCodes.Call, typeof(SHA256).GetMethod(nameof(SHA256.HashData), [typeof(Stream)])!);
            il.Emit(OpCodes.Ret);
        });

        Assert.Empty(CorePlatformBoundaryGuard.InspectAssembly(pe));
    }

    private static void AssertViolation(IReadOnlyList<CorePlatformBoundaryGuard.BoundaryViolation> violations, string rule, string detail, string? subject = null) =>
        Assert.Contains(violations, item => item.Rule == rule && item.Detail == detail && (subject is null || item.Subject == subject));

    private static MemoryStream EmitSingleMethod(string assembly, string typeName, string methodName, Type returnType, Type[] parameterTypes, Action<ILGenerator> emit) =>
        EmitType(assembly, typeName, TypeAttributes.Public | TypeAttributes.Sealed, type => EmitMethod(type, methodName, returnType, parameterTypes, emit));

    private static void EmitMethod(TypeBuilder type, string name, Type returnType, Type[] parameterTypes, Action<ILGenerator> emit,
        MethodAttributes attributes = MethodAttributes.Private | MethodAttributes.Static) =>
        emit(type.DefineMethod(name, attributes, returnType, parameterTypes).GetILGenerator());

    private static MemoryStream EmitType(string assemblyName, string typeName, TypeAttributes attributes, Action<TypeBuilder> build)
    {
        var assembly = new PersistedAssemblyBuilder(new AssemblyName(assemblyName), typeof(object).Assembly);
        var type = assembly.DefineDynamicModule(assemblyName).DefineType(typeName, attributes);
        build(type);
        type.CreateType();
        var stream = new MemoryStream();
        assembly.Save(stream);
        stream.Position = 0;
        return stream;
    }

    private static string LocateRepositoryRoot()
    {
        for (var current = new DirectoryInfo(AppContext.BaseDirectory); current is not null; current = current.Parent)
            if (File.Exists(Path.Combine(current.FullName, "FsusBlog.V2.slnx"))) return current.FullName;
        throw new InvalidOperationException("Could not locate repository root containing FsusBlog.V2.slnx.");
    }
}
