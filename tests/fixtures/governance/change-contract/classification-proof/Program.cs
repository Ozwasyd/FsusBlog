using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;

using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!).Split(Path.PathSeparator)
    .Select(path => MetadataReference.CreateFromFile(path)).ToArray();
var options = new CSharpParseOptions(LanguageVersion.CSharp14, DocumentationMode.Diagnose);
var report = new Dictionary<string, object?>();
report["qualification"] = false;
report["scope"] = "compiled counterexamples and manual Roslyn comparison; never a classification authority";

SyntaxTree Parse(string source, string path = "Fixture.cs") => CSharpSyntaxTree.ParseText(source, options, path);
string Tokens(string source) => string.Join("\n", Parse(source).GetRoot().DescendantTokens()
    .Select(token => $"{token.RawKind}:{token.Text}:{token.ValueText}"));
byte[] Emit(IEnumerable<SyntaxTree> trees, string name = "Fixture", bool generator = false)
{
    Compilation compilation = CSharpCompilation.Create(name, trees, references,
        new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release,
            allowUnsafe: true, deterministic: true));
    if (generator)
    {
        GeneratorDriver driver = CSharpGeneratorDriver.Create(new[] { new DocumentationGenerator() }, parseOptions: options);
        driver.RunGeneratorsAndUpdateCompilation(compilation, out compilation, out var diagnostics);
        if (diagnostics.Any(item => item.Severity == DiagnosticSeverity.Error))
            throw new Exception("generator diagnostic");
    }
    using var stream = new MemoryStream();
    var result = compilation.Emit(stream);
    if (!result.Success)
        throw new Exception(string.Join("\n", result.Diagnostics.Where(item => item.Severity == DiagnosticSeverity.Error)));
    return stream.ToArray();
}
object? Run(byte[] assembly, string type, string method)
{
    var context = new AssemblyLoadContext(Guid.NewGuid().ToString(), isCollectible: true);
    try
    {
        using var stream = new MemoryStream(assembly);
        return context.LoadFromStream(stream).GetType(type)!.GetMethod(method)!.Invoke(null, null);
    }
    finally
    {
        context.Unload();
    }
}
object Counterexample(string before, string after, string type = "Fixture", bool generator = false)
{
    var first = Emit(new[] { Parse(before) }, generator: generator);
    var second = Emit(new[] { Parse(after) }, generator: generator);
    return new
    {
        tokensEqual = Tokens(before) == Tokens(after),
        beforeResult = Run(first, type, "Read"),
        afterResult = Run(second, type, "Read"),
        peEqual = first.SequenceEqual(second)
    };
}

const string positiveDocs = "public static class Fixture { public static int Read() => 7; }";
report["documentationWithoutConsumers"] = Counterexample(positiveDocs,
    "/// <summary>Read the immutable fixture value.</summary>\n" + positiveDocs);
const string positiveField = "public static class Fixture { private sealed class ContractObserver { internal static readonly int SnapshotTime = 1; } public static int Read() => ContractObserver.SnapshotTime; }";
report["privateFieldWithoutConsumers"] = Counterexample(positiveField, positiveField.Replace("SnapshotTime", "s_snapshotTime"));
const string callerLine = "using System.Runtime.CompilerServices;\npublic static class Fixture {\n static int Capture([CallerLineNumber] int line = 0) => line;\n public static int Read() => Capture();\n}\n";
report["xmlCommentCallerLineNumber"] = Counterexample(callerLine,
    callerLine.Replace(" public static int Read()", " /// <summary>Read the current line.</summary>\n public static int Read()"));
const string generatorBefore = "/// <summary>Before.</summary>\npublic sealed class Source { }\n";
report["xmlCommentSourceGenerator"] = Counterexample(generatorBefore,
    generatorBefore.Replace("Before.", "After."), "GeneratedFixture", true);
const string callerExpression = "using System.Runtime.CompilerServices; public static class Fixture { private sealed class ContractObserver { internal static readonly int SnapshotTime = 1; } static string Capture(int value, [CallerArgumentExpression(\"value\")] string expression = \"\") => expression; public static string Read() => Capture(ContractObserver.SnapshotTime); }";
report["privateStaticFieldCallerArgumentExpression"] = Counterexample(callerExpression,
    callerExpression.Replace("SnapshotTime", "s_snapshotTime"));
const string reflection = "using System.Reflection; public static class Fixture { private sealed class ContractObserver { internal static readonly int SnapshotTime = 1; } public static bool Read() => typeof(ContractObserver).GetField(\"SnapshotTime\", BindingFlags.Static | BindingFlags.NonPublic) != null; }";
report["privateStaticFieldReflection"] = Counterexample(reflection,
    reflection.Replace("int SnapshotTime =", "int s_snapshotTime ="));
const string rawString = "public static class Fixture { public static string Read() => \"\"\"\n/// Before.\n\"\"\"; }";
report["rawStringDocumentationLookalike"] = Counterexample(rawString, rawString.Replace("Before.", "After."));
const string namedField = "public static class Fixture { private sealed class ContractObserver { internal static readonly int SnapshotTime = 1; } public static string Read() => nameof(ContractObserver.SnapshotTime); }";
report["privateFieldNameof"] = Counterexample(namedField, namedField.Replace("SnapshotTime", "s_snapshotTime"));

if (args.Length == 2)
{
    string[] targets = ["Contracts/ArticleRelations/ArticleRelationContractValidator.cs",
        "Contracts/Schema/CurrentSchemaCanonicalAuthority.cs", "Contracts/Schema/CurrentSchemaModel.cs"];
    report["exact4698TokenProof"] = targets.Select(path =>
    {
        string before = File.ReadAllText(Path.Combine(args[0], path));
        string after = File.ReadAllText(Path.Combine(args[1], path));
        string Strip(string text) => string.Concat(text.Split('\n').Where(line => !line.TrimStart().StartsWith("///", StringComparison.Ordinal)).Select(line => line + "\n"));
        return new
        {
            path,
            beforeTokens = Parse(before).GetRoot().DescendantTokens().Count(),
            afterTokens = Parse(after).GetRoot().DescendantTokens().Count(),
            tokensEqual = Tokens(before) == Tokens(after),
            allNonXmlBytesEqual = Strip(before) == Strip(after)
        };
    }).ToArray();
    foreach (var directory in args)
    {
        try
        {
            var trees = Directory.GetFiles(directory, "*.cs", SearchOption.AllDirectories).Order()
                .Select(path => Parse(File.ReadAllText(path), Path.GetRelativePath(directory, path))).ToList();
            trees.Add(Parse("global using System; global using System.Collections.Generic; global using System.IO; global using System.Linq; global using System.Net.Http; global using System.Threading; global using System.Threading.Tasks;", "GlobalUsings.g.cs"));
            byte[] assembly = Emit(trees, "SharedProof");
            using var pe = new PEReader(new MemoryStream(assembly));
            var reader = pe.GetMetadataReader();
            var methods = reader.MethodDefinitions.Select(handle =>
            {
                var method = reader.GetMethodDefinition(handle);
                byte[]? il = method.RelativeVirtualAddress == 0 ? null : pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes();
                return new
                {
                    name = reader.GetString(method.Name),
                    signature = Convert.ToHexString(reader.GetBlobBytes(method.Signature)),
                    il = il is null ? null : Convert.ToHexString(il)
                };
            }).ToArray();
            var serialized = JsonSerializer.SerializeToUtf8Bytes(methods);
            report["sharedManualCompilation:" + Path.GetFileName(directory)] = new
            {
                sourceCount = trees.Count,
                methodCount = methods.Length,
                methodProjectionSha256 = Convert.ToHexString(SHA256.HashData(serialized)),
                peSha256 = Convert.ToHexString(SHA256.HashData(assembly))
            };
        }
        catch (Exception error)
        {
            report["sharedManualCompilation:" + Path.GetFileName(directory)] = new
            {
                failure = error.Message
            };
        }
    }
}
Console.WriteLine(JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));

sealed class DocumentationGenerator : ISourceGenerator
{
    public void Initialize(GeneratorInitializationContext context)
    {
    }
    public void Execute(GeneratorExecutionContext context)
    {
        bool before = context.Compilation.SyntaxTrees.Any(tree => tree.GetText().ToString().Contains("Before.", StringComparison.Ordinal));
        context.AddSource("GeneratedFixture.g.cs", "public static class GeneratedFixture { public static int Read() => " + (before ? "1" : "2") + "; }");
    }
}
