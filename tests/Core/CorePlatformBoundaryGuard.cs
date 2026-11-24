using System.Reflection;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Xml.Linq;

namespace FsusBlog.V2.Core.Tests;

internal static class CorePlatformBoundaryGuard
{
    internal sealed record BoundaryViolation(string Rule, string Subject, string Detail);

    private static readonly OpCode[] SingleByteOpCodes = BuildOpCodes(twoByte: false);
    private static readonly OpCode[] TwoByteOpCodes = BuildOpCodes(twoByte: true);
    private static readonly NameSignatureTypeProvider TypeProvider = new();
    private static readonly string[] ForbiddenLayers = ["Platform", "Server", "Cli", "PluginWorker"];

    private static readonly HashSet<string> ForbiddenAssemblies = new(
        [.. ForbiddenLayers.Select(layer => $"FsusBlog.V2.{layer}"), "Npgsql", "Jint"], StringComparer.OrdinalIgnoreCase);

    private static readonly string[] ForbiddenNamespacePrefixes =
    [
        .. ForbiddenLayers.Select(layer => $"FsusBlog.V2.{layer}"),
        "System.IO.Pipes", "System.IO.MemoryMappedFiles", "System.Net.Sockets", "System.Net.Http"
    ];

    private static readonly HashSet<string> ForbiddenExactTypes = ExpandTypes(
        ("System.IO", ["File", "Directory", "FileInfo", "DirectoryInfo", "FileStream", "FileSystemInfo", "DriveInfo",
            "FileSystemWatcher", "UnixFileMode", "RandomAccess", "FileOptions", "FileMode", "FileAccess", "FileShare",
            "FileStreamOptions", "Path", "StreamReader", "StreamWriter"]),
        ("Microsoft.Win32.SafeHandles", ["SafeFileHandle"]),
        ("System.Diagnostics", ["Process", "ProcessStartInfo"]),
        ("System", ["Environment", "OperatingSystem"]),
        ("System.Runtime.InteropServices", ["RuntimeInformation", "Marshal", "NativeLibrary", "OSPlatform"]),
        ("System.Net", ["Dns"]));

    private static readonly HashSet<string> ForbiddenInteropAttributes = ExpandTypes(
        ("System.Runtime.InteropServices", ["DllImportAttribute", "LibraryImportAttribute", "UnmanagedCallersOnlyAttribute"]));

    private static HashSet<string> ExpandTypes(params (string Namespace, string[] Names)[] groups) =>
        new(groups.SelectMany(group => group.Names.Select(name => $"{group.Namespace}.{name}")), StringComparer.Ordinal);

    internal static IReadOnlyList<BoundaryViolation> InspectProjectXml(string xml, string projectName = "FsusBlog.V2.Core.csproj")
    {
        var violations = new List<BoundaryViolation>();
        var document = XDocument.Parse(xml);
        foreach (var (elementName, rule) in new[] { ("ProjectReference", "project-reference"), ("Compile", "linked-source") })
        {
            foreach (var element in document.Descendants().Where(element => element.Name.LocalName == elementName))
            {
                var include = element.Attribute("Include")?.Value ?? "";
                if (TargetsForbiddenLayer(include)) violations.Add(new(rule, projectName, include));
            }
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
        var assemblyName = reader.GetString(reader.GetAssemblyDefinition().Name);
        var violations = new List<BoundaryViolation>();

        foreach (var handle in reader.AssemblyReferences)
        {
            var name = reader.GetString(reader.GetAssemblyReference(handle).Name);
            if (ForbiddenAssemblies.Contains(name) || name.StartsWith("Microsoft.AspNetCore.", StringComparison.OrdinalIgnoreCase))
                violations.Add(new("assembly-ref", assemblyName, name));
        }

        foreach (var handle in reader.CustomAttributes)
        {
            var attribute = reader.GetCustomAttribute(handle);
            var attributeType = ResolveDeclaringType(reader, attribute.Constructor);
            if (attributeType is not null && ForbiddenInteropAttributes.Contains(attributeType))
                violations.Add(new("interop-attribute", DescribeEntity(reader, attribute.Parent), attributeType));
        }

        foreach (var handle in reader.TypeReferences)
        {
            var fullName = GetTypeReferenceName(reader, handle);
            if (IsForbiddenType(fullName)) violations.Add(new("type-ref", assemblyName, fullName));
        }

        foreach (var handle in reader.MemberReferences)
        {
            var member = reader.GetMemberReference(handle);
            var parentName = DescribeEntity(reader, member.Parent);
            if (ContainsForbiddenTypeName(parentName))
                violations.Add(new("member-ref", assemblyName, $"{parentName}.{reader.GetString(member.Name)}"));
        }

        InspectTypesAndMethods(peReader, reader, violations);
        return violations;
    }

    private static void InspectTypesAndMethods(PEReader peReader, MetadataReader reader, List<BoundaryViolation> violations)
    {
        foreach (var typeHandle in reader.TypeDefinitions)
        {
            var typeDef = reader.GetTypeDefinition(typeHandle);
            var typeName = GetTypeDefinitionName(reader, typeHandle);

            foreach (var fieldHandle in typeDef.GetFields())
            {
                var field = reader.GetFieldDefinition(fieldHandle);
                var fieldType = field.DecodeSignature(TypeProvider, null);
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

                var signature = method.DecodeSignature(TypeProvider, null);
                if (ContainsForbiddenTypeName(signature.ReturnType))
                    violations.Add(new("method-signature", methodName, $"return:{signature.ReturnType}"));
                foreach (var parameterType in signature.ParameterTypes)
                    if (ContainsForbiddenTypeName(parameterType))
                        violations.Add(new("method-signature", methodName, $"param:{parameterType}"));

                if (method.RelativeVirtualAddress == 0) continue;

                var body = peReader.GetMethodBody(method.RelativeVirtualAddress);
                if (!body.LocalSignature.IsNil)
                {
                    foreach (var localType in reader.GetStandaloneSignature(body.LocalSignature).DecodeLocalSignature(TypeProvider, null))
                        if (ContainsForbiddenTypeName(localType))
                            violations.Add(new("local-variable", methodName, localType));
                }

                InspectMethodBodyIl(reader, methodName, body.GetILReader(), violations);
            }
        }
    }

    private static void InspectMethodBodyIl(MetadataReader reader, string methodName, BlobReader il, List<BoundaryViolation> violations)
    {
        var reported = new HashSet<string>(StringComparer.Ordinal);
        while (il.RemainingBytes > 0)
        {
            var first = il.ReadByte();
            var operand = (first == 0xFE ? TwoByteOpCodes[il.ReadByte()] : SingleByteOpCodes[first]).OperandType;
            if (operand == OperandType.InlineSwitch) il.Offset += il.ReadInt32() * 4;
            else if (operand is OperandType.InlineField or OperandType.InlineMethod or OperandType.InlineType or OperandType.InlineTok)
            {
                if (ResolveToken(reader, il.ReadInt32()) is { IsForbidden: true } match && reported.Add(match.Description))
                    violations.Add(new("method-body-call", methodName, match.Description));
            }
            else il.Offset += operand switch
            {
                OperandType.InlineNone => 0,
                OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                OperandType.InlineVar => 2,
                OperandType.InlineBrTarget or OperandType.InlineI or OperandType.ShortInlineR or OperandType.InlineSig or OperandType.InlineString => 4,
                OperandType.InlineI8 or OperandType.InlineR => 8,
                _ => throw new InvalidDataException($"Unsupported IL operand type {operand} in {methodName}.")
            };
        }
    }

    private static (bool IsForbidden, string Description)? ResolveToken(MetadataReader reader, int token) =>
        MetadataTokens.EntityHandle(token) switch
        {
            { Kind: HandleKind.TypeReference } h => GetTypeReferenceName(reader, (TypeReferenceHandle)h) is var t ? (IsForbiddenType(t), t) : null,
            { Kind: HandleKind.TypeSpecification } h => reader.GetTypeSpecification((TypeSpecificationHandle)h).DecodeSignature(TypeProvider, null) is var s ? (ContainsForbiddenTypeName(s), s) : null,
            { Kind: HandleKind.MemberReference } h => reader.GetMemberReference((MemberReferenceHandle)h) is var m && DescribeEntity(reader, m.Parent) is var p
                ? (ContainsForbiddenTypeName(p), $"{p}.{reader.GetString(m.Name)}") : null,
            { Kind: HandleKind.MethodSpecification } h => reader.GetMethodSpecification((MethodSpecificationHandle)h) is var sp && sp.DecodeSignature(TypeProvider, null) is var args
                ? ((ResolveDeclaringType(reader, sp.Method) is { } d && ContainsForbiddenTypeName(d)) || args.Any(ContainsForbiddenTypeName),
                    $"{DescribeEntity(reader, sp.Method)}<{string.Join(", ", args)}>") : null,
            _ => null
        };

    private static string? ResolveDeclaringType(MetadataReader reader, EntityHandle member) => member.Kind switch
    {
        HandleKind.MemberReference => DescribeEntity(reader, reader.GetMemberReference((MemberReferenceHandle)member).Parent),
        HandleKind.MethodDefinition => GetTypeDefinitionName(reader, reader.GetMethodDefinition((MethodDefinitionHandle)member).GetDeclaringType()),
        _ => null
    };

    private static string DescribeEntity(MetadataReader reader, EntityHandle handle) => handle.Kind switch
    {
        HandleKind.TypeReference => GetTypeReferenceName(reader, (TypeReferenceHandle)handle),
        HandleKind.TypeDefinition => GetTypeDefinitionName(reader, (TypeDefinitionHandle)handle),
        HandleKind.TypeSpecification => reader.GetTypeSpecification((TypeSpecificationHandle)handle).DecodeSignature(TypeProvider, null),
        HandleKind.MemberReference => reader.GetMemberReference((MemberReferenceHandle)handle) is var m
            ? $"{DescribeEntity(reader, m.Parent)}.{reader.GetString(m.Name)}" : "",
        HandleKind.MethodDefinition => reader.GetMethodDefinition((MethodDefinitionHandle)handle) is var md
            ? $"{GetTypeDefinitionName(reader, md.GetDeclaringType())}.{reader.GetString(md.Name)}" : "",
        HandleKind.AssemblyDefinition => reader.GetString(reader.GetAssemblyDefinition().Name),
        _ => handle.Kind.ToString()
    };

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
        if (!declaring.IsNil) return $"{GetTypeDefinitionName(reader, declaring)}+{name}";
        var ns = reader.GetString(typeDef.Namespace);
        return string.IsNullOrEmpty(ns) ? name : $"{ns}.{name}";
    }

    private static bool TargetsForbiddenLayer(string includePath) =>
        includePath.Replace('\\', '/').Split('/', StringSplitOptions.RemoveEmptyEntries).Any(segment =>
            ForbiddenLayers.Any(layer => segment.Equals(layer, StringComparison.OrdinalIgnoreCase) ||
                segment.Equals($"FsusBlog.V2.{layer}.csproj", StringComparison.OrdinalIgnoreCase)));

    private static bool IsForbiddenType(string fullTypeName)
    {
        var baseName = fullTypeName.Split('+')[0];
        return ForbiddenExactTypes.Contains(fullTypeName) || ForbiddenExactTypes.Contains(baseName) ||
            ForbiddenNamespacePrefixes.Any(prefix => baseName.Equals(prefix, StringComparison.Ordinal) ||
                baseName.StartsWith(prefix + ".", StringComparison.Ordinal));
    }

    private static bool ContainsForbiddenTypeName(string formatted) =>
        formatted.Split(['<', '>', ',', '[', ']', '&', '*', ' ', '(', ')'], StringSplitOptions.RemoveEmptyEntries).Any(IsForbiddenType);

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
        public string GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind) => GetTypeDefinitionName(reader, handle);
        public string GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind) => GetTypeReferenceName(reader, handle);
        public string GetTypeFromSpecification(MetadataReader reader, object? genericContext, TypeSpecificationHandle handle, byte rawTypeKind) =>
            reader.GetTypeSpecification(handle).DecodeSignature(this, null);
        public string GetSZArrayType(string elementType) => elementType + "[]";
        public string GetArrayType(string elementType, ArrayShape shape) => elementType + "[]";
        public string GetByReferenceType(string elementType) => elementType + "&";
        public string GetPointerType(string elementType) => elementType + "*";
        public string GetPinnedType(string elementType) => elementType;
        public string GetGenericInstantiation(string genericType, ImmutableArray<string> typeArguments) => $"{genericType}<{string.Join(", ", typeArguments)}>";
        public string GetGenericMethodParameter(object? genericContext, int index) => $"!!{index}";
        public string GetGenericTypeParameter(object? genericContext, int index) => $"!{index}";
        public string GetModifiedType(string modifier, string unmodifiedType, bool isRequired) => unmodifiedType;
        public string GetFunctionPointerType(MethodSignature<string> signature) => $"fn({string.Join(", ", signature.ParameterTypes)})->{signature.ReturnType}";
    }
}
