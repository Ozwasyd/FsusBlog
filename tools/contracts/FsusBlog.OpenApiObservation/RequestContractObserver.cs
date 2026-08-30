using System.ComponentModel.DataAnnotations;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace FsusBlog.OpenApiObservation;

internal static partial class RequestContractObserver
{
    private static readonly NullabilityInfoContext s_nullability = new();
    private static readonly JsonSerializerOptions s_canonicalJson = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
    };
    private static readonly RequestBoundContract s_unbounded = new(null, null, null, null, null, null, null, null);

    public static OperationRequestContract Build(
        string? requestFrame,
        string operationId,
        IReadOnlyList<RouteParameterContract> parameters,
        IReadOnlyList<ObservedRequestType> observedTypes)
    {
        if (requestFrame is null)
        {
            return new OperationRequestContract(
                "none",
                null,
                "none",
                false,
                false,
                [],
                parameters,
                new SortedDictionary<string, RequestPropertyContract>(StringComparer.Ordinal),
                new SortedDictionary<string, RequestSchemaDefinition>(StringComparer.Ordinal),
                [],
                null,
                new SortedDictionary<string, RequestBoundContract>(StringComparer.Ordinal),
                "not-applicable",
                "not-applicable",
                "not-applicable",
                null,
                [],
                []);
        }

        IReadOnlyList<ObservedRequestType> selected = SelectTypes(requestFrame, observedTypes);
        if (selected.Count == 0)
        {
            if (string.Equals(requestFrame, "PluginPackageInstallRequest", StringComparison.Ordinal))
            {
                return BuildPackageRequest(operationId, parameters);
            }

            throw new InvalidOperationException(
                $"{operationId} request frame {requestFrame} has no compiled request type");
        }

        string[] encodings = selected.Select(static item => item.Encoding).Distinct(StringComparer.Ordinal).ToArray();
        if (encodings.Length != 1)
        {
            throw new InvalidOperationException(
                $"{operationId} request frame {requestFrame} has conflicting encodings: {string.Join(',', encodings)}");
        }

        string encoding = encodings[0];
        Type[] sourceTypes = selected.Select(static item => item.Type).Distinct().ToArray();
        if (sourceTypes.Length != 1)
        {
            throw new InvalidOperationException(
                $"{operationId} request frame {requestFrame} has ambiguous compiled request types: "
                + string.Join(',', sourceTypes.Select(static type => type.FullName)));
        }

        Type sourceType = sourceTypes[0];
        SortedDictionary<string, RequestPropertyContract> properties = ObserveProperties(sourceType, encoding);
        if (properties.Count == 0)
        {
            throw new InvalidOperationException(
                $"{operationId} request frame {requestFrame} produced an empty typed field set from {sourceType.FullName}");
        }

        string[] requiredFields = properties.Values
            .Where(static property => property.Required)
            .Select(static property => property.Name)
            .OrderBy(static name => name, StringComparer.Ordinal)
            .ToArray();
        SortedDictionary<string, RequestBoundContract> bounds = PropertiesWithBounds(properties);

        JsonPolymorphicAttribute? polymorphic = sourceType.GetCustomAttribute<JsonPolymorphicAttribute>();
        string[] oneOf = sourceType.GetCustomAttributes<JsonDerivedTypeAttribute>()
            .Select(static attribute => TypeIdentity(attribute.DerivedType))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();
        string? discriminator = oneOf.Length == 0
            ? null
            : polymorphic?.TypeDiscriminatorPropertyName ?? "$type";
        SortedDictionary<string, RequestSchemaDefinition> definitions = ObserveDefinitions(sourceType, encoding);
        string schemaRef = $"aeds://request-schema/{operationId}";
        string[] typeIdentities = [TypeIdentity(sourceType)];
        string[] readerIdentities = selected.Select(static item => item.ReaderIdentity)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static value => value, StringComparer.Ordinal)
            .ToArray();
        string schemaDigest = Digest(new
        {
            schemaRef,
            requestFrame,
            encoding,
            requiredFields,
            properties,
            definitions,
            oneOf,
            discriminator,
            bounds,
            sourceTypes = typeIdentities,
            readerIdentities
        });

        return new OperationRequestContract(
            "aeds-frame-body",
            schemaRef,
            encoding,
            true,
            false,
            requiredFields,
            parameters,
            properties,
            definitions,
            oneOf,
            discriminator,
            bounds,
            "closed",
            "closed",
            oneOf.Length == 0 ? "none" : "one-of",
            schemaDigest,
            typeIdentities,
            readerIdentities);
    }

    private static OperationRequestContract BuildPackageRequest(
        string operationId,
        IReadOnlyList<RouteParameterContract> parameters)
    {
        var packageBounds = new RequestBoundContract(null, null, 1, 32 * 1024 * 1024, null, null, null, null);
        var property = new RequestPropertyContract(
            "packageBytes",
            "binary",
            true,
            false,
            "plugin-package",
            null,
            null,
            null,
            [],
            packageBounds);
        var properties = new SortedDictionary<string, RequestPropertyContract>(StringComparer.Ordinal)
        {
            [property.Name] = property
        };
        var bounds = new SortedDictionary<string, RequestBoundContract>(StringComparer.Ordinal)
        {
            [property.Name] = packageBounds
        };
        var definitions = new SortedDictionary<string, RequestSchemaDefinition>(StringComparer.Ordinal);
        string schemaRef = $"aeds://request-schema/{operationId}";
        string[] requiredFields = [property.Name];
        string[] sourceTypes = ["FsusBlog.Server.Infrastructure.Plugins.PluginAdminService.InstallAsync(Stream)"];
        string[] readerIdentities = ["FsusBlog.Server.Infrastructure.Binary.IBinaryEndpointRequestContext.ReadFrameAsync"];
        string schemaDigest = Digest(new
        {
            schemaRef,
            requestFrame = "PluginPackageInstallRequest",
            encoding = "binary-package",
            requiredFields,
            properties,
            definitions,
            oneOf = Array.Empty<string>(),
            discriminator = (string?)null,
            bounds,
            sourceTypes,
            readerIdentities
        });
        return new OperationRequestContract(
            "aeds-frame-body",
            schemaRef,
            "binary-package",
            true,
            false,
            requiredFields,
            parameters,
            properties,
            definitions,
            [],
            null,
            bounds,
            "closed",
            "closed",
            "none",
            schemaDigest,
            sourceTypes,
            readerIdentities);
    }

    private static SortedDictionary<string, RequestSchemaDefinition> ObserveDefinitions(Type rootType, string encoding)
    {
        var definitions = new SortedDictionary<string, RequestSchemaDefinition>(StringComparer.Ordinal);
        var pending = new Queue<Type>(ReferencedTypes(rootType));
        var visited = new HashSet<Type> { rootType };
        while (pending.TryDequeue(out Type? candidate))
        {
            Type type = Nullable.GetUnderlyingType(candidate) ?? candidate;
            if (!IsDefinitionType(type) || !visited.Add(type))
            {
                continue;
            }

            SortedDictionary<string, RequestPropertyContract> properties = ObserveProperties(type, encoding);
            string[] requiredFields = properties.Values
                .Where(static property => property.Required)
                .Select(static property => property.Name)
                .OrderBy(static name => name, StringComparer.Ordinal)
                .ToArray();
            SortedDictionary<string, RequestBoundContract> bounds = PropertiesWithBounds(properties);
            string[] oneOf = type.GetCustomAttributes<JsonDerivedTypeAttribute>()
                .Select(static attribute => TypeIdentity(attribute.DerivedType))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(static identity => identity, StringComparer.Ordinal)
                .ToArray();
            string? discriminator = oneOf.Length == 0
                ? null
                : type.GetCustomAttribute<JsonPolymorphicAttribute>()?.TypeDiscriminatorPropertyName ?? "$type";
            string identity = TypeIdentity(type);
            definitions[identity] = new RequestSchemaDefinition(
                identity,
                requiredFields,
                properties,
                oneOf,
                discriminator,
                bounds);
            foreach (Type referenced in ReferencedTypes(type))
            {
                pending.Enqueue(referenced);
            }
        }
        return definitions;
    }

    private static IEnumerable<Type> ReferencedTypes(Type type)
    {
        foreach (PropertyInfo property in type.GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Where(static property => property.GetIndexParameters().Length == 0)
            .Where(static property => property.GetCustomAttribute<JsonIgnoreAttribute>() is null))
        {
            Type actual = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
            Type? itemType = DictionaryValue(actual) ?? CollectionItem(actual);
            if (itemType is not null)
            {
                yield return Nullable.GetUnderlyingType(itemType) ?? itemType;
            }
            else
            {
                yield return actual;
            }
        }
        foreach (JsonDerivedTypeAttribute derived in type.GetCustomAttributes<JsonDerivedTypeAttribute>())
        {
            yield return derived.DerivedType;
        }
    }

    private static bool IsDefinitionType(Type type)
        => JsonType(type) == "object"
            && type != typeof(object)
            && (type.Namespace?.StartsWith("FsusBlog", StringComparison.Ordinal) ?? false);

    private static SortedDictionary<string, RequestBoundContract> PropertiesWithBounds(
        IReadOnlyDictionary<string, RequestPropertyContract> properties)
    {
        var bounds = new SortedDictionary<string, RequestBoundContract>(StringComparer.Ordinal);
        foreach ((string name, RequestPropertyContract property) in properties)
        {
            if (HasBound(property.Bounds))
            {
                bounds[name] = property.Bounds;
            }
        }
        return bounds;
    }

    private static IReadOnlyList<ObservedRequestType> SelectTypes(
        string requestFrame,
        IReadOnlyList<ObservedRequestType> observedTypes)
    {
        List<ObservedRequestType> candidates = observedTypes
            .Where(static item => !item.Type.IsGenericParameter)
            .Where(static item => item.Type.FullName != "FsusBlog.Server.Infrastructure.Binary.BinaryRequestPayload")
            .GroupBy(static item => item.Type)
            .Select(static group => group.OrderByDescending(static item => item.Encoding == "utf8-json").First())
            .ToList();

        List<ObservedRequestType> nonStrings = candidates.Where(static item => item.Type != typeof(string)).ToList();
        if (nonStrings.Count > 0)
        {
            candidates = nonStrings;
        }

        List<ObservedRequestType> coreModels = candidates
            .Where(static item => item.Type.Namespace == "FsusBlog.Core.Mapping.Models")
            .ToList();
        if (coreModels.Count > 0)
        {
            candidates = coreModels;
        }

        List<ObservedRequestType> sharedBinaryModels = candidates
            .Where(static item => item.Type.Namespace?.StartsWith("FsusBlog.Shared.Contracts", StringComparison.Ordinal) == true)
            .ToList();
        if (sharedBinaryModels.Count > 0)
        {
            candidates = sharedBinaryModels;
        }

        if (candidates.Count == 0)
        {
            Type? fallback = ResolveFrameType(requestFrame);
            if (fallback is not null)
            {
                candidates.Add(new ObservedRequestType(
                    fallback,
                    "binary-layout",
                    $"compiled-frame-type:{fallback.FullName}"));
            }
        }

        return candidates;
    }

    private static Type? ResolveFrameType(string requestFrame)
    {
        string[] candidateNames =
        [
            requestFrame + "CoreModel",
            requestFrame + "BinaryRequest",
            requestFrame,
            requestFrame + "Pod",
            requestFrame + "Dto"
        ];
        Type[] types = AppDomain.CurrentDomain.GetAssemblies()
            .Where(static assembly => assembly.GetName().Name?.StartsWith("FsusBlog", StringComparison.Ordinal) == true)
            .SelectMany(GetTypes)
            .Where(type => candidateNames.Contains(type.Name, StringComparer.Ordinal))
            .ToArray();
        return types
            .OrderBy(type => Array.IndexOf(candidateNames, type.Name))
            .ThenBy(static type => TypePriority(type))
            .ThenBy(static type => type.FullName, StringComparer.Ordinal)
            .FirstOrDefault();
    }

    private static IEnumerable<Type> GetTypes(Assembly assembly)
    {
        try
        {
            return assembly.GetTypes();
        }
        catch (ReflectionTypeLoadException exception)
        {
            return exception.Types.OfType<Type>();
        }
    }

    private static int TypePriority(Type type)
    {
        string ns = type.Namespace ?? string.Empty;
        if (ns == "FsusBlog.Core.Mapping.Models")
            return 0;
        if (ns.StartsWith("FsusBlog.Shared.Contracts", StringComparison.Ordinal))
            return 1;
        if (ns.StartsWith("FsusBlog.Server.Models", StringComparison.Ordinal))
            return 2;
        return 3;
    }

    private static SortedDictionary<string, RequestPropertyContract> ObserveProperties(Type type, string encoding)
    {
        if (type == typeof(string))
        {
            return new SortedDictionary<string, RequestPropertyContract>(StringComparer.Ordinal)
            {
                ["value"] = new RequestPropertyContract(
                    "value", "string", true, false, "utf8", null, null, null, [], s_unbounded)
            };
        }

        var properties = new SortedDictionary<string, RequestPropertyContract>(StringComparer.Ordinal);
        ConstructorInfo? constructor = type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
            .OrderByDescending(static candidate => candidate.GetParameters().Length)
            .FirstOrDefault();
        IReadOnlyDictionary<string, ParameterInfo> parameters = constructor?.GetParameters()
            .ToDictionary(static parameter => parameter.Name ?? string.Empty, StringComparer.OrdinalIgnoreCase)
            ?? new Dictionary<string, ParameterInfo>(StringComparer.OrdinalIgnoreCase);

        foreach (PropertyInfo property in type.GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Where(static property => property.GetIndexParameters().Length == 0)
            .Where(static property => property.GetCustomAttribute<JsonIgnoreAttribute>() is null)
            .OrderBy(static property => property.Name, StringComparer.Ordinal))
        {
            string name = property.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name
                ?? JsonNamingPolicy.CamelCase.ConvertName(property.Name);
            parameters.TryGetValue(property.Name, out ParameterInfo? parameter);
            bool nullable = IsNullable(property.PropertyType, s_nullability.Create(property).ReadState);
            bool required = IsRequired(property, parameter, nullable, encoding);
            properties[name] = Describe(name, property.PropertyType, required, nullable, property.GetCustomAttributes());
        }

        if (properties.Count == 0)
        {
            foreach (FieldInfo field in type.GetFields(BindingFlags.Instance | BindingFlags.Public)
                .OrderBy(static field => field.Name, StringComparer.Ordinal))
            {
                string name = JsonNamingPolicy.CamelCase.ConvertName(field.Name);
                bool nullable = IsNullable(field.FieldType, s_nullability.Create(field).ReadState);
                properties[name] = Describe(
                    name,
                    field.FieldType,
                    required: true,
                    nullable,
                    field.GetCustomAttributes());
            }
        }
        return properties;
    }

    private static bool IsRequired(
        PropertyInfo property,
        ParameterInfo? parameter,
        bool nullable,
        string encoding)
    {
        if (encoding != "utf8-json")
            return true;
        if (property.GetCustomAttribute<RequiredAttribute>() is not null
            || property.GetCustomAttribute<JsonRequiredAttribute>() is not null
            || property.GetCustomAttribute<RequiredMemberAttribute>() is not null)
        {
            return true;
        }
        return !nullable && parameter?.HasDefaultValue != true;
    }

    private static RequestPropertyContract Describe(
        string name,
        Type declaredType,
        bool required,
        bool nullable,
        IEnumerable<Attribute> attributes)
    {
        Type type = Nullable.GetUnderlyingType(declaredType) ?? declaredType;
        Attribute[] attributeArray = attributes.ToArray();
        string valueType = JsonType(type);
        string? format = Format(type);
        Type? itemType = DictionaryValue(type) ?? CollectionItem(type);
        string? schemaRef = IsDefinitionType(type) ? $"clr://{TypeIdentity(type)}" : null;
        string? itemSchemaRef = itemType is not null && IsDefinitionType(itemType)
            ? $"clr://{TypeIdentity(itemType)}"
            : null;
        string[] enumValues = type.IsEnum
            ? Enum.GetNames(type).OrderBy(static value => value, StringComparer.Ordinal).ToArray()
            : [];
        RequestBoundContract bounds = Bounds(type, attributeArray);
        return new RequestPropertyContract(
            name,
            valueType,
            required,
            nullable,
            format,
            schemaRef,
            itemType is null ? null : JsonType(itemType),
            itemSchemaRef,
            enumValues,
            bounds);
    }

    private static RequestBoundContract Bounds(Type type, IReadOnlyList<Attribute> attributes)
    {
        RangeAttribute? range = attributes.OfType<RangeAttribute>().SingleOrDefault();
        MinLengthAttribute? minLength = attributes.OfType<MinLengthAttribute>().SingleOrDefault();
        MaxLengthAttribute? maxLength = attributes.OfType<MaxLengthAttribute>().SingleOrDefault();
        StringLengthAttribute? stringLength = attributes.OfType<StringLengthAttribute>().SingleOrDefault();
        string? minimum = InvariantText(range?.Minimum);
        string? maximum = InvariantText(range?.Maximum);
        int? minimumLength = minLength?.Length;
        int? maximumLength = maxLength?.Length ?? stringLength?.MaximumLength;
        if (stringLength?.MinimumLength > 0)
        {
            minimumLength = stringLength.MinimumLength;
        }

        Match fixedUtf8 = FixedUtf8Type().Match(type.Name);
        if (fixedUtf8.Success)
        {
            maximumLength = int.Parse(fixedUtf8.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
        }
        NumericBounds(type, ref minimum, ref maximum);
        bool dictionary = DictionaryValue(type) is not null;
        bool collection = !dictionary && CollectionItem(type) is not null;
        return new RequestBoundContract(
            minimum,
            maximum,
            collection ? null : minimumLength,
            collection ? null : maximumLength,
            collection ? minimumLength : null,
            collection ? maximumLength : null,
            dictionary ? minimumLength : null,
            dictionary ? maximumLength : null);
    }

    private static void NumericBounds(Type type, ref string? minimum, ref string? maximum)
    {
        if (minimum is not null || maximum is not null)
            return;
        (minimum, maximum) = Type.GetTypeCode(type) switch
        {
            TypeCode.Byte => (NumericText(byte.MinValue), NumericText(byte.MaxValue)),
            TypeCode.SByte => (NumericText(sbyte.MinValue), NumericText(sbyte.MaxValue)),
            TypeCode.Int16 => (NumericText(short.MinValue), NumericText(short.MaxValue)),
            TypeCode.UInt16 => (NumericText(ushort.MinValue), NumericText(ushort.MaxValue)),
            TypeCode.Int32 => (NumericText(int.MinValue), NumericText(int.MaxValue)),
            TypeCode.UInt32 => (NumericText(uint.MinValue), NumericText(uint.MaxValue)),
            TypeCode.Int64 => (NumericText(long.MinValue), NumericText(long.MaxValue)),
            TypeCode.UInt64 => (NumericText(ulong.MinValue), NumericText(ulong.MaxValue)),
            _ => (null, null)
        };
    }

    private static string NumericText(IFormattable value)
        => value.ToString(null, System.Globalization.CultureInfo.InvariantCulture);

    private static string? InvariantText(object? value)
        => value is null ? null : Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);

    private static bool IsNullable(Type type, NullabilityState state)
        => Nullable.GetUnderlyingType(type) is not null
            || (!type.IsValueType && state != NullabilityState.NotNull);

    private static string JsonType(Type type)
    {
        Type actual = Nullable.GetUnderlyingType(type) ?? type;
        if (actual == typeof(string) || actual == typeof(char) || FixedUtf8Type().IsMatch(actual.Name))
            return "string";
        if (actual == typeof(Guid) || actual == typeof(DateTime) || actual == typeof(DateTimeOffset)
            || actual == typeof(DateOnly) || actual == typeof(TimeOnly) || actual == typeof(TimeSpan))
            return "string";
        if (actual == typeof(bool))
            return "boolean";
        if (actual == typeof(byte[]) || actual == typeof(ReadOnlyMemory<byte>) || actual == typeof(Memory<byte>))
            return "binary";
        if (actual.IsEnum)
            return "enum";
        if (actual == typeof(float) || actual == typeof(double) || actual == typeof(decimal))
            return "number";
        if (actual.IsPrimitive || actual == typeof(long) || actual == typeof(ulong))
            return "integer";
        if (DictionaryValue(actual) is not null)
            return "object";
        if (CollectionItem(actual) is not null)
            return "array";
        return "object";
    }

    private static string? Format(Type type)
    {
        Type actual = Nullable.GetUnderlyingType(type) ?? type;
        if (actual == typeof(Guid))
            return "uuid";
        if (actual == typeof(DateTime) || actual == typeof(DateTimeOffset))
            return "date-time";
        if (actual == typeof(TimeSpan))
            return "duration";
        if (DictionaryValue(actual) is not null)
            return "string-keyed-map";
        if (actual == typeof(byte[]) || actual == typeof(ReadOnlyMemory<byte>) || actual == typeof(Memory<byte>))
            return "bytes";
        Match fixedUtf8 = FixedUtf8Type().Match(actual.Name);
        return fixedUtf8.Success ? $"utf8-fixed-{fixedUtf8.Groups[1].Value}" : null;
    }

    private static Type? CollectionItem(Type type)
    {
        if (type == typeof(string) || type == typeof(byte[]))
            return null;
        if (type.IsArray)
            return type.GetElementType();
        Type? enumerable = type.GetInterfaces()
            .Append(type)
            .FirstOrDefault(static candidate => candidate.IsGenericType
                && candidate.GetGenericTypeDefinition() == typeof(IEnumerable<>));
        return enumerable?.GetGenericArguments()[0];
    }

    private static Type? DictionaryValue(Type type)
    {
        Type? dictionary = type.GetInterfaces()
            .Append(type)
            .FirstOrDefault(static candidate => candidate.IsGenericType
                && candidate.GetGenericTypeDefinition() == typeof(IReadOnlyDictionary<,>))
            ?? type.GetInterfaces()
                .Append(type)
                .FirstOrDefault(static candidate => candidate.IsGenericType
                    && candidate.GetGenericTypeDefinition() == typeof(IDictionary<,>));
        if (dictionary is null || dictionary.GetGenericArguments()[0] != typeof(string))
            return null;
        return dictionary.GetGenericArguments()[1];
    }

    private static bool HasBound(RequestBoundContract value)
        => value.Minimum is not null || value.Maximum is not null
            || value.MinLength is not null || value.MaxLength is not null
            || value.MinItems is not null || value.MaxItems is not null
            || value.MinProperties is not null || value.MaxProperties is not null;

    private static string Digest(object value)
        => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, s_canonicalJson)))
            .ToLowerInvariant();

    private static string TypeIdentity(Type type)
        => type.FullName ?? type.Name;

    [GeneratedRegex("^Utf8Fixed([0-9]+)$", RegexOptions.CultureInvariant)]
    private static partial Regex FixedUtf8Type();
}
