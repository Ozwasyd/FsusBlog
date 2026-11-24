using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Xml.Linq;

namespace FsusBlog.V2.Core.Tests;

/// <summary>
/// Bounded static architecture guard for <c>FsusBlog.V2.Core</c>.
///
/// Checked scope:
/// 1. Project file (<c>FsusBlog.V2.Core.csproj</c>): rejects <c>ProjectReference</c> or linked <c>Compile Include</c>
///    entries targeting <c>Platform</c>, <c>Server</c>, <c>Cli</c>, or <c>PluginWorker</c>.
/// 2. Assembly references: rejects PE <c>AssemblyRef</c> entries targeting <c>FsusBlog.V2.Platform</c>,
///    <c>FsusBlog.V2.Server</c>, <c>FsusBlog.V2.Cli</c>, <c>FsusBlog.V2.PluginWorker</c>, <c>Npgsql</c>, <c>Jint</c>,
///    or <c>Microsoft.AspNetCore.*</c>.
/// 3. Native interop / P/Invoke: rejects <see cref="MethodAttributes.PinvokeImpl"/> declarations and
///    <c>DllImportAttribute</c> / <c>LibraryImportAttribute</c> / <c>UnmanagedCallersOnlyAttribute</c>.
/// 4. Type/member references, signatures, and IL method bodies (including private, internal, and compiler-generated
///    async/closure methods): rejects direct references to a curated denylist of filesystem, process, OS/environment,
///    native-handle, and network BCL types as well as any type in forbidden upper/platform namespaces.
///
/// Honest non-goals / limitations:
/// This is a finite static PE/IL and project-graph check, NOT a complete proof against arbitrary indirect I/O
/// (e.g., reflection-based <c>Type.GetType</c> / <c>Activator</c> invocation, caller-injected delegates or <see cref="Stream"/>
/// instances that perform I/O outside Core, wall-clock <see cref="TimeProvider"/>, or future BCL I/O APIs not in the denylist).
/// </summary>
internal static class CorePlatformBoundaryGuard
{
    internal sealed record BoundaryViolation(string Rule, string Subject, string Detail);

    private static readonly OpCode[] SingleByteOpCodes = BuildOpCodes(twoByte: false);
    private static readonly OpCode[] TwoByteOpCodes = BuildOpCodes(twoByte: true);

    private static readonly HashSet<string> ForbiddenAssemblies = new(StringComparer.OrdinalIgnoreCase)
    {
        "FsusBlog.V2.Platform",
        "FsusBlog.V2.Server",
        "FsusBlog.V2.Cli",
        "FsusBlog.V2.PluginWorker",
        "Npgsql",
        "Jint"
    };

    private static readonly string[] ForbiddenAssemblyPrefixes =
    [
        "Microsoft.AspNetCore."
    ];

    private static readonly string[] ForbiddenNamespacePrefixes =
    [
        "FsusBlog.V2.Platform",
        "FsusBlog.V2.Server",
        "FsusBlog.V2.Cli",
        "FsusBlog.V2.PluginWorker",
        "System.IO.Pipes",
        "System.IO.MemoryMappedFiles",
        "System.Net.Sockets",
        "System.Net.Http"
    ];

    private static readonly HashSet<string> ForbiddenExactTypes = new(StringComparer.Ordinal)
    {
        "System.IO.File",
        "System.IO.Directory",
        "System.IO.FileInfo",
        "System.IO.DirectoryInfo",
        "System.IO.FileStream",
        "System.IO.FileSystemInfo",
        "System.IO.DriveInfo",
        "System.IO.FileSystemWatcher",
        "System.IO.UnixFileMode",
        "System.IO.RandomAccess",
        "System.IO.FileOptions",
        "System.IO.FileMode",
        "System.IO.FileAccess",
        "System.IO.FileShare",
        "System.IO.FileStreamOptions",
        "System.IO.Path",
        "System.IO.StreamReader",
        "System.IO.StreamWriter",
        "Microsoft.Win32.SafeHandles.SafeFileHandle",
        "System.Diagnostics.Process",
        "System.Diagnostics.ProcessStartInfo",
        "System.Environment",
        "System.OperatingSystem",
        "System.Runtime.InteropServices.RuntimeInformation",
        "System.Runtime.InteropServices.Marshal",
        "System.Runtime.InteropServices.NativeLibrary",
        "System.Runtime.InteropServices.OSPlatform",
        "System.Net.Dns"
    };

    private static readonly HashSet<string> ForbiddenInteropAttributes = new(StringComparer.Ordinal)
    {
        "System.Runtime.InteropServices.DllImportAttribute",
        "System.Runtime.InteropServices.LibraryImportAttribute",
        "System.Runtime.InteropServices.UnmanagedCallersOnlyAttribute"
    };

    private static readonly string[] ForbiddenProjectPathSegments =
    [
        "Platform",
        "Server",
        "Cli",
        "PluginWorker"
    ];

    internal static IReadOnlyList<BoundaryViolation> InspectProjectXml(string xml, string projectName = "FsusBlog.V2.Core.csproj")
    {
        var violations = new List<BoundaryViolation>();
        var document = XDocument.Parse(xml);
        foreach (var reference in document.Descendants().Where(element => element.Name.LocalName == "ProjectReference"))
        {
            var include = reference.Attribute("Include")?.Value ?? "";
            if (TargetsForbiddenLayer(include))
                violations.Add(new("project-reference", projectName, include));
        }
        foreach (var compile in document.Descendants().Where(element => element.Name.LocalName == "Compile"))
        {
            var include = compile.Attribute("Include")?.Value ?? "";
            if (TargetsForbiddenLayer(include))
                violations.Add(new("linked-source", projectName, include));
        }
        return violations;
    }

    internal static IReadOnlyList<BoundaryViolation> InspectAssembly(string assemblyPath)
    {
        using var stream = File.OpenRead(assemblyPath);
        return InspectAssembly(stream);
    }

    internal static IReadOnlyList<BoundaryViolation> InspectAssembly(Stream peStream)
    {
        using var peReader = new PEReader(peStream, PEStreamOptions.LeaveOpen);
        var reader = peReader.GetMetadataReader();
        var violations = new List<BoundaryViolation>();
        var typeProvider = new NameSignatureTypeProvider();

        InspectAssemblyReferences(reader, violations);
        InspectInteropAttributes(reader, violations);
        InspectTypeReferences(reader, violations);
        InspectMemberReferences(reader, violations);
        InspectTypesAndMethods(peReader, reader, typeProvider, violations);

        return violations;
    }

    private static void InspectAssemblyReferences(MetadataReader reader, List<BoundaryViolation> violations)
    {
        var assemblyName = reader.GetString(reader.GetAssemblyDefinition().Name);
        foreach (var handle in reader.AssemblyReferences)
        {
            var reference = reader.GetAssemblyReference(handle);
            var name = reader.GetString(reference.Name);
            if (IsForbiddenAssembly(name))
                violations.Add(new("assembly-ref", assemblyName, name));
        }
    }

    private static void InspectInteropAttributes(MetadataReader reader, List<BoundaryViolation> violations)
    {
        foreach (var handle in reader.CustomAttributes)
        {
            var attribute = reader.GetCustomAttribute(handle);
            var attributeType = ResolveAttributeTypeName(reader, attribute.Constructor);
            if (attributeType is null || !ForbiddenInteropAttributes.Contains(attributeType))
                continue;
            var target = DescribeEntity(reader, attribute.Parent);
            violations.Add(new("interop-attribute", target, attributeType));
        }
    }

    private static void InspectTypeReferences(MetadataReader reader, List<BoundaryViolation> violations)
    {
        var assemblyName = reader.GetString(reader.GetAssemblyDefinition().Name);
        foreach (var handle in reader.TypeReferences)
        {
            var fullName = GetTypeReferenceName(reader, handle);
            if (IsForbiddenType(fullName))
                violations.Add(new("type-ref", assemblyName, fullName));
        }
    }

    private static void InspectMemberReferences(MetadataReader reader, List<BoundaryViolation> violations)
    {
        var assemblyName = reader.GetString(reader.GetAssemblyDefinition().Name);
        foreach (var handle in reader.MemberReferences)
        {
            var member = reader.GetMemberReference(handle);
            var parentName = DescribeEntity(reader, member.Parent);
            var memberName = reader.GetString(member.Name);
            if (ContainsForbiddenTypeName(parentName))
                violations.Add(new("member-ref", assemblyName, $"{parentName}.{memberName}"));
        }
    }

    private static void InspectTypesAndMethods(PEReader peReader, MetadataReader reader,
        NameSignatureTypeProvider typeProvider, List<BoundaryViolation> violations)
    {
        foreach (var typeHandle in reader.TypeDefinitions)
        {
            var typeDef = reader.GetTypeDefinition(typeHandle);
            var typeName = GetTypeDefinitionName(reader, typeHandle);

            foreach (var fieldHandle in typeDef.GetFields())
            {
                var field = reader.GetFieldDefinition(fieldHandle);
                var fieldType = field.DecodeSignature(typeProvider, null);
                if (ContainsForbiddenTypeName(fieldType))
                    violations.Add(new("field-signature", $"{typeName}.{reader.GetString(field.Name)}", fieldType));
            }

            foreach (var methodHandle in typeDef.GetMethods())
            {
                var method = reader.GetMethodDefinition(methodHandle);
                var methodName = $"{typeName}.{reader.GetString(method.Name)}";

                if ((method.Attributes & MethodAttributes.PinvokeImpl) != 0)
                {
                    var import = method.GetImport();
                    var module = import.Module.IsNil ? "<unknown>" : reader.GetString(reader.GetModuleReference(import.Module).Name);
                    var entry = import.Name.IsNil ? reader.GetString(method.Name) : reader.GetString(import.Name);
                    violations.Add(new("pinvoke-impl", methodName, $"{module}!{entry}"));
                }

                var signature = method.DecodeSignature(typeProvider, null);
                if (ContainsForbiddenTypeName(signature.ReturnType))
                    violations.Add(new("method-signature", methodName, $"return:{signature.ReturnType}"));
                foreach (var parameterType in signature.ParameterTypes)
                {
                    if (ContainsForbiddenTypeName(parameterType))
                        violations.Add(new("method-signature", methodName, $"param:{parameterType}"));
                }

                if (method.RelativeVirtualAddress == 0)
                    continue;

                var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
                if (!body.LocalSignature.IsNil)
                {
                    var localSignature = reader.GetStandaloneSignature(body.LocalSignature);
                    foreach (var localType in localSignature.DecodeLocalSignature(typeProvider, null))
                    {
                        if (ContainsForbiddenTypeName(localType))
                            violations.Add(new("local-variable", methodName, localType));
                    }
                }

                InspectMethodBodyIl(reader, methodName, body.GetILReader(), violations);
            }
        }
    }

    private static void InspectMethodBodyIl(MetadataReader reader, string methodName, BlobReader il,
        List<BoundaryViolation> violations)
    {
        var reported = new HashSet<string>(StringComparer.Ordinal);
        while (il.RemainingBytes > 0)
        {
            var first = il.ReadByte();
            var opCode = first == 0xFE ? TwoByteOpCodes[il.ReadByte()] : SingleByteOpCodes[first];
            switch (opCode.OperandType)
            {
                case OperandType.InlineNone:
                    break;
                case OperandType.ShortInlineBrTarget:
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar:
                    il.ReadByte();
                    break;
                case OperandType.InlineVar:
                    il.ReadUInt16();
                    break;
                case OperandType.InlineBrTarget:
                case OperandType.InlineI:
                case OperandType.ShortInlineR:
                case OperandType.InlineSig:
                case OperandType.InlineString:
                    il.ReadInt32();
                    break;
                case OperandType.InlineI8:
                case OperandType.InlineR:
                    il.ReadInt64();
                    break;
                case OperandType.InlineSwitch:
                    var count = il.ReadInt32();
                    il.Offset += count * 4;
                    break;
                case OperandType.InlineField:
                case OperandType.InlineMethod:
                case OperandType.InlineType:
                case OperandType.InlineTok:
                    var token = il.ReadInt32();
                    var resolved = ResolveToken(reader, token);
                    if (resolved is { IsForbidden: true } match && reported.Add(match.Description))
                        violations.Add(new("method-body-call", methodName, match.Description));
                    break;
                default:
                    throw new InvalidDataException($"Unsupported IL operand type {opCode.OperandType} in {methodName}.");
            }
        }
    }

    private static (bool IsForbidden, string Description)? ResolveToken(MetadataReader reader, int token)
    {
        var handle = MetadataTokens.EntityHandle(token);
        switch (handle.Kind)
        {
            case HandleKind.TypeReference:
            {
                var name = GetTypeReferenceName(reader, (TypeReferenceHandle)handle);
                return (IsForbiddenType(name), name);
            }
            case HandleKind.TypeSpecification:
            {
                var name = DecodeTypeSpec(reader, (TypeSpecificationHandle)handle);
                return (ContainsForbiddenTypeName(name), name);
            }
            case HandleKind.MemberReference:
            {
                var member = reader.GetMemberReference((MemberReferenceHandle)handle);
                var parent = DescribeEntity(reader, member.Parent);
                var name = reader.GetString(member.Name);
                return (ContainsForbiddenTypeName(parent), $"{parent}.{name}");
            }
            case HandleKind.MethodSpecification:
            {
                var spec = reader.GetMethodSpecification((MethodSpecificationHandle)handle);
                var args = spec.DecodeSignature(new NameSignatureTypeProvider(), null);
                var methodParentForbidden = spec.Method.Kind switch
                {
                    HandleKind.MemberReference => ContainsForbiddenTypeName(DescribeEntity(reader, reader.GetMemberReference((MemberReferenceHandle)spec.Method).Parent)),
                    HandleKind.MethodDefinition => ContainsForbiddenTypeName(GetTypeDefinitionName(reader, reader.GetMethodDefinition((MethodDefinitionHandle)spec.Method).GetDeclaringType())),
                    _ => false
                };
                var description = $"{DescribeEntity(reader, spec.Method)}<{string.Join(", ", args)}>";
                return (methodParentForbidden || args.Any(ContainsForbiddenTypeName), description);
            }
            default:
                return null;
        }
    }

    private static string DescribeMemberReference(MetadataReader reader, MemberReferenceHandle handle)
    {
        var member = reader.GetMemberReference(handle);
        return $"{DescribeEntity(reader, member.Parent)}.{reader.GetString(member.Name)}";
    }

    private static string? ResolveAttributeTypeName(MetadataReader reader, EntityHandle constructor) =>
        constructor.Kind switch
        {
            HandleKind.MemberReference => DescribeEntity(reader, reader.GetMemberReference((MemberReferenceHandle)constructor).Parent),
            HandleKind.MethodDefinition => GetTypeDefinitionName(reader, reader.GetMethodDefinition((MethodDefinitionHandle)constructor).GetDeclaringType()),
            _ => null
        };

    private static string DescribeEntity(MetadataReader reader, EntityHandle handle) =>
        handle.Kind switch
        {
            HandleKind.TypeReference => GetTypeReferenceName(reader, (TypeReferenceHandle)handle),
            HandleKind.TypeDefinition => GetTypeDefinitionName(reader, (TypeDefinitionHandle)handle),
            HandleKind.TypeSpecification => DecodeTypeSpec(reader, (TypeSpecificationHandle)handle),
            HandleKind.MemberReference => DescribeMemberReference(reader, (MemberReferenceHandle)handle),
            HandleKind.MethodDefinition => DescribeMethodDefinition(reader, (MethodDefinitionHandle)handle),
            HandleKind.AssemblyDefinition => reader.GetString(reader.GetAssemblyDefinition().Name),
            _ => handle.Kind.ToString()
        };

    private static string DescribeMethodDefinition(MetadataReader reader, MethodDefinitionHandle handle)
    {
        var method = reader.GetMethodDefinition(handle);
        return $"{GetTypeDefinitionName(reader, method.GetDeclaringType())}.{reader.GetString(method.Name)}";
    }

    private static string DecodeTypeSpec(MetadataReader reader, TypeSpecificationHandle handle)
    {
        var spec = reader.GetTypeSpecification(handle);
        return spec.DecodeSignature(new NameSignatureTypeProvider(), null);
    }

    private static string GetTypeReferenceName(MetadataReader reader, TypeReferenceHandle handle)
    {
        var typeRef = reader.GetTypeReference(handle);
        var name = reader.GetString(typeRef.Name);
        if (typeRef.ResolutionScope.Kind == HandleKind.TypeReference)
            return $"{GetTypeReferenceName(reader, (TypeReferenceHandle)typeRef.ResolutionScope)}+{name}";
        var ns = reader.GetString(typeRef.Namespace);
        return string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";
    }

    private static string GetTypeDefinitionName(MetadataReader reader, TypeDefinitionHandle handle)
    {
        var typeDef = reader.GetTypeDefinition(handle);
        var name = reader.GetString(typeDef.Name);
        var declaring = typeDef.GetDeclaringType();
        if (!declaring.IsNil)
            return $"{GetTypeDefinitionName(reader, declaring)}+{name}";
        var ns = reader.GetString(typeDef.Namespace);
        return string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";
    }

    private static bool IsForbiddenAssembly(string name) =>
        ForbiddenAssemblies.Contains(name) ||
        ForbiddenAssemblyPrefixes.Any(prefix => name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));

    private static bool TargetsForbiddenLayer(string includePath)
    {
        var normalized = includePath.Replace('\\', '/');
        var segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments.Any(segment => ForbiddenProjectPathSegments.Any(layer =>
            segment.Equals(layer, StringComparison.OrdinalIgnoreCase) ||
            segment.Equals($"FsusBlog.V2.{layer}.csproj", StringComparison.OrdinalIgnoreCase)));
    }

    private static bool IsForbiddenType(string fullTypeName)
    {
        if (ForbiddenExactTypes.Contains(fullTypeName))
            return true;
        var baseName = fullTypeName.Split('+')[0];
        if (ForbiddenExactTypes.Contains(baseName))
            return true;
        return ForbiddenNamespacePrefixes.Any(prefix =>
            baseName.Equals(prefix, StringComparison.Ordinal) ||
            baseName.StartsWith(prefix + ".", StringComparison.Ordinal));
    }

    private static bool ContainsForbiddenTypeName(string formatted)
    {
        foreach (var token in formatted.Split(['<', '>', ',', '[', ']', '&', '*', ' ', '(', ')'], StringSplitOptions.RemoveEmptyEntries))
        {
            if (IsForbiddenType(token))
                return true;
        }
        return false;
    }

    private static OpCode[] BuildOpCodes(bool twoByte)
    {
        var table = new OpCode[256];
        foreach (var field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            if (field.GetValue(null) is not OpCode opCode) continue;
            var value = unchecked((ushort)opCode.Value);
            if (twoByte && (value >> 8) == 0xFE) table[value & 0xFF] = opCode;
            else if (!twoByte && value < 256) table[value] = opCode;
        }
        return table;
    }

    private sealed class NameSignatureTypeProvider : ISignatureTypeProvider<string, object?>
    {
        public string GetPrimitiveType(PrimitiveTypeCode typeCode) => typeCode.ToString();
        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) =>
            GetTypeDefinitionName(reader, handle);
        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind) =>
            GetTypeReferenceName(reader, handle);
        public string GetTypeFromSpecification(MetadataReader reader, object? genericContext, TypeSpecificationHandle handle, byte rawTypeKind) =>
            DecodeTypeSpec(reader, handle);
        public string GetSZArrayType(string elementType) => elementType + "[]";
        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[]";
        public string GetByReferenceType(string elementType) => elementType + "&";
        public string GetPointerType(string elementType) => elementType + "*";
        public string GetPinnedType(string elementType) => elementType;
        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) =>
            $"{genericType}<{string.Join(", ", typeArguments)}>";
        public string GetGenericMethodParameter(object? genericContext, int index) => $"!!{index}";
        public string GetGenericTypeParameter(object? genericContext, int index) => $"!{index}";
        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;
        public string GetFunctionPointerType(MethodSignature<string> signature) =>
            $"fn({string.Join(", ", signature.ParameterTypes)})->{signature.ReturnType}";
    }
}
