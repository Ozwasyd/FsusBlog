using Microsoft.CodeAnalysis;

internal static partial class XunitAdapterProgram
{
    private static (List<Trait> Traits, string? Fixture) ClassMetadata(
        INamedTypeSymbol classSymbol,
        SemanticModel semanticModel,
        string file,
        List<string> unresolved)
    {
        var traits = new List<Trait>();
        string? fixture = null;
        foreach (AttributeData attribute in classSymbol.GetAttributes())
        {
            if (IsAttributeType(attribute, "TraitAttribute"))
            {
                Trait? trait = ReadTrait(attribute, semanticModel, file, unresolved);
                if (trait is not null)
                    traits.Add(trait);
            }
        }
        for (INamedTypeSymbol? current = classSymbol; current is not null; current = current.BaseType)
        {
            foreach (INamedTypeSymbol iface in current.Interfaces)
            {
                string name = iface.ToDisplayString();
                if (name.StartsWith("Xunit.IClassFixture<", StringComparison.Ordinal)
                    || name.StartsWith("Xunit.ICollectionFixture<", StringComparison.Ordinal))
                {
                    string inner = name["Xunit.IClassFixture<".Length..];
                    if (inner.EndsWith(">", StringComparison.Ordinal))
                        inner = inner[..^1];
                    fixture = inner;
                }
            }
        }
        return (traits, fixture);
    }

    private static Trait? ReadTrait(AttributeData attribute, SemanticModel semanticModel, string file, List<string> unresolved)
    {
        var args = attribute.ConstructorArguments;
        if (args.Length < 2 || args[0].Value is null || args[1].Value is null)
        {
            return null;
        }
        return new Trait
        {
            Name = args[0].Value?.ToString() ?? "",
            Value = args[1].Value?.ToString() ?? ""
        };
    }

    private static (List<Trait> Traits, string? SkipReason, bool Explicit, int? TimeoutMs, string? DisplayName) MethodMetadata(
        IMethodSymbol method,
        AttributeData testAttribute,
        SemanticModel semanticModel,
        string file,
        List<string> unresolved)
    {
        var traits = new List<Trait>();
        string? skipReason = null;
        bool explicitFlag = false;
        int? timeoutMs = null;
        string? displayName = null;
        foreach (AttributeData attribute in method.GetAttributes())
        {
            if (IsAttributeType(attribute, "TraitAttribute"))
            {
                Trait? trait = ReadTrait(attribute, semanticModel, file, unresolved);
                if (trait is not null)
                    traits.Add(trait);
            }
            else if (IsAttributeType(attribute, "FactAttribute") || IsAttributeType(attribute, "TheoryAttribute"))
            {
                foreach (KeyValuePair<string, TypedConstant> named in attribute.NamedArguments)
                {
                    switch (named.Key)
                    {
                        case "Skip":
                            skipReason = named.Value.Value?.ToString();
                            break;
                        case "Explicit":
                            explicitFlag = named.Value.Value is true;
                            break;
                        case "Timeout":
                            if (named.Value.Value is int timeout)
                                timeoutMs = timeout;
                            break;
                        case "DisplayName":
                            displayName = named.Value.Value?.ToString();
                            break;
                    }
                }
            }
        }
        return (traits, skipReason, explicitFlag, timeoutMs, displayName);
    }

    private static List<Trait> MergeTraits(List<Trait> classTraits, List<Trait> methodTraits)
    {
        var merged = new List<Trait>();
        var methodNames = new HashSet<string>(methodTraits.Select(item => item.Name), StringComparer.Ordinal);
        merged.AddRange(classTraits.Where(item => !methodNames.Contains(item.Name)));
        merged.AddRange(methodTraits);
        return merged
            .GroupBy(item => item.Name, StringComparer.Ordinal)
            .Select(group => group.Last())
            .OrderBy(item => item.Name, StringComparer.Ordinal)
            .ThenBy(item => item.Value, StringComparer.Ordinal)
            .ToList();
    }

    private static string? TraitValue(List<Trait> traits, string name)
    {
        return traits.LastOrDefault(item => item.Name == name)?.Value;
    }

    private static string InlineDataLabel(AttributeData attribute)
    {
        var labels = new List<string>();
        foreach (TypedConstant argument in attribute.ConstructorArguments)
        {
            labels.Add(ConstantLabel(argument));
        }
        return labels.Count == 0 ? "no-arguments" : string.Join(", ", labels);
    }

    private static string ConstantLabel(TypedConstant constant)
    {
        if (constant.Kind == TypedConstantKind.Array)
        {
            if (constant.Values.IsDefault)
                return "[]";
            return "[" + string.Join(", ", constant.Values.Select(ConstantLabel)) + "]";
        }
        if (constant.Kind == TypedConstantKind.Primitive || constant.Kind == TypedConstantKind.Enum)
        {
            if (constant.Value is null)
                return "null";
            if (constant.Value is string value)
                return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
            if (constant.Value is bool boolean)
                return boolean ? "true" : "false";
            if (constant.Value is char character)
                return "'" + character + "'";
            return Convert.ToString(constant.Value, System.Globalization.CultureInfo.InvariantCulture) ?? "null";
        }
        if (constant.Kind == TypedConstantKind.Type)
        {
            return constant.Value?.ToString() ?? "typeof(?)";
        }
        return constant.Value?.ToString() ?? "null";
    }

    private static string? MemberDataGenerationLocation(AttributeData attribute)
    {
        if (attribute.ConstructorArguments.Length == 0)
            return null;
        TypedConstant first = attribute.ConstructorArguments[0];
        if (first.Value is string memberName)
            return $"member-data:{memberName}";
        if (first.Value is INamedTypeSymbol type)
            return $"member-data:{type.Name}";
        return "member-data";
    }

    private static string? ClassDataGenerationLocation(AttributeData attribute)
    {
        if (attribute.ConstructorArguments.Length == 0)
            return null;
        TypedConstant first = attribute.ConstructorArguments[0];
        if (first.Value is INamedTypeSymbol type)
            return $"class-data:{type.ToDisplayString()}";
        return "class-data";
    }

    private static string StableCaseId(string file, string ownerSuite, string methodName, string discriminator)
    {
        string stableOwner = ownerSuite.Replace("+", ".");
        return $"xunit:{file}#{stableOwner}.{methodName}#{discriminator}";
    }

}
