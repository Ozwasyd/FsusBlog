using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Serialization;

using Xunit;
using Xunit.Runner.Common;
using Xunit.Sdk;

namespace FsusBlog.XunitReplayRunner;

internal static class Program
{
    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static async Task<int> Main(string[] args)
    {
        try
        {
            var command = CommandLine.Parse(args);
            return command.Name switch
            {
                "discover" => await DiscoverAsync(command),
                "run-slot" => await RunSlotAsync(command),
                _ => throw new InvalidOperationException($"unknown command: {command.Name}"),
            };
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception);
            return 2;
        }
    }

    private static async Task<int> DiscoverAsync(CommandLine command)
    {
        var assembly = command.RequiredPath("assembly");
        var output = command.RequiredPath("output", requireExisting: false);
        InstallAssemblyResolver(assembly);
        var projectAssembly = CreateProjectAssembly(assembly);
        await using var controller = XunitFrontController.Create(projectAssembly)
            ?? throw new InvalidOperationException("xUnit did not create a discovery front controller");
        using var complete = new ManualResetEventSlim();
        var tests = new List<DiscoveredTest>();
        var sink = new DiscoveryEventSink();
        sink.TestCaseDiscoveredEvent += message =>
        {
            var test = message.Message;
            tests.Add(new DiscoveredTest(
                test.AssemblyUniqueID,
                test.TestCollectionUniqueID,
                test.TestClassUniqueID ?? throw new InvalidOperationException("xUnit discovery omitted a class ID"),
                test.TestMethodUniqueID ?? throw new InvalidOperationException("xUnit discovery omitted a method ID"),
                test.TestCaseUniqueID,
                test.TestClassName,
                test.TestMethodName,
                test.TestMethodParameterTypesVSTest ?? [],
                test.TestCaseDisplayName,
                test.Serialization,
                test.SkipReason,
                test.Explicit,
                test.Traits.ToDictionary(
                    pair => pair.Key,
                    pair => pair.Value.Order(StringComparer.Ordinal).ToArray(),
                    StringComparer.Ordinal)));
        };
        sink.DiscoveryCompleteEvent += _ => complete.Set();

        var configuration = new TestAssemblyConfiguration
        {
            IncludeSourceInformation = false,
            PreEnumerateTheories = true,
            SynchronousMessageReporting = true,
        };
        controller.Find(sink, new FrontControllerFindSettings(
            TestFrameworkOptions.ForDiscovery(configuration),
            new XunitFilters()));
        if (!complete.Wait(TimeSpan.FromMinutes(5)))
            throw new TimeoutException("xUnit discovery did not complete within five minutes");

        var duplicateIds = tests.GroupBy(test => test.TestCaseUniqueId, StringComparer.Ordinal)
            .Where(group => group.Count() != 1)
            .Select(group => group.Key)
            .ToArray();
        if (duplicateIds.Length != 0)
            throw new InvalidOperationException($"xUnit discovery repeated test case IDs: {string.Join(", ", duplicateIds)}");

        WriteJson(output, new DiscoveryReceipt(
            "fsusblog.xunit-replay-discovery.v1",
            Path.GetFullPath(assembly),
            controller.TestAssemblyUniqueID,
            controller.TestFrameworkDisplayName,
            controller.TargetFramework,
            Environment.ProcessId,
            tests.OrderBy(test => test.TestCollectionUniqueId, StringComparer.Ordinal)
                .ThenBy(test => test.TestCaseUniqueId, StringComparer.Ordinal)
                .ToArray()));
        return 0;
    }

    private static async Task<int> RunSlotAsync(CommandLine command)
    {
        var assembly = command.RequiredPath("assembly");
        var queuePath = command.RequiredPath("queue");
        var output = command.RequiredPath("output", requireExisting: false);
        var queue = ReadJson<SlotQueue>(queuePath);
        InstallAssemblyResolver(assembly);
        if (queue.Schema != "fsusblog.xunit-replay-slot-queue.v1")
            throw new InvalidOperationException("slot queue has an invalid schema");
        if (queue.Collections.Count == 0)
            throw new InvalidOperationException("slot queue must contain at least one collection");

        var tests = queue.Collections.SelectMany(collection => collection.Tests).ToArray();
        var expectedCases = tests.Select(test => test.TestCaseUniqueId).ToHashSet(StringComparer.Ordinal);
        if (expectedCases.Count != tests.Length)
            throw new InvalidOperationException("slot queue repeats a test case ID");
        foreach (var collection in queue.Collections)
        {
            if (collection.Tests.Count == 0 || collection.Tests.Any(test => test.TestCollectionUniqueId != collection.TestCollectionUniqueId))
                throw new InvalidOperationException($"slot queue collection {collection.TestCollectionUniqueId} has invalid membership");
        }

        using var journal = SlotEventJournal.Open($"{output}.events.jsonl", queue.PlanDigest, queue.SlotId,
            tests.Length, queue.Collections.Count);
        try
        {
            var exitCode = await RunAdmittedSlotAsync(assembly, output, queue, tests, expectedCases, journal);
            journal.Record("runner-terminal", new
            {
                ExitCode = exitCode,
                Signal = (string?)null
            });
            return exitCode;
        }
        catch (Exception exception)
        {
            journal.Record("runner-terminal", new
            {
                ExitCode = 2,
                Signal = (string?)null,
                ExceptionType = exception.GetType().FullName
            });
            throw;
        }
    }

    private static async Task<int> RunAdmittedSlotAsync(string assembly, string output, SlotQueue queue,
        QueuedTest[] tests, HashSet<string> expectedCases, SlotEventJournal journal)
    {
        var projectAssembly = CreateProjectAssembly(assembly);
        await using var controller = XunitFrontController.Create(projectAssembly)
            ?? throw new InvalidOperationException("xUnit did not create an execution front controller");
        using var complete = new ManualResetEventSlim();
        var starts = new List<TestStart>();
        var outcomes = new List<TestOutcome>();
        var gate = new object();
        var sink = new ExecutionEventSink();
        sink.TestStartingEvent += message =>
        {
            var test = message.Message;
            lock (gate)
            {
                starts.Add(new TestStart(
                    test.TestUniqueID,
                    test.TestCaseUniqueID,
                    test.TestCollectionUniqueID,
                    test.TestDisplayName,
                    test.StartTime));
                journal.Record("test-started", starts[^1]);
            }
        };
        sink.TestPassedEvent += message => AddOutcome(outcomes, gate, journal, message.Message, "passed", null);
        sink.TestFailedEvent += message => AddOutcome(outcomes, gate, journal, message.Message, "failed", string.Join("\n", message.Message.Messages), message.Message);
        sink.TestSkippedEvent += message => AddOutcome(outcomes, gate, journal, message.Message, "skipped", message.Message.Reason);
        sink.TestNotRunEvent += message => AddOutcome(outcomes, gate, journal, message.Message, "not-run", null);
        sink.TestAssemblyFinishedEvent += _ =>
        {
            lock (gate)
            {
                journal.Record("assembly-finished", new
                {
                    StartedTests = starts.Count,
                    OutcomeTests = outcomes.Count
                });
                complete.Set();
            }
        };

        var admittedAt = DateTimeOffset.UtcNow;
        var admissions = queue.Collections.Select((collection, index) => new CollectionAdmission(
            index,
            collection.TestCollectionUniqueId,
            collection.Tests.Select(test => test.TestCaseUniqueId).ToArray(),
            admittedAt)).ToArray();
        foreach (var admission in admissions)
        {
            journal.Record("collection-admitted", admission);
        }
        var configuration = new TestAssemblyConfiguration
        {
            MaxParallelThreads = 1,
            ParallelizeTestCollections = false,
            PreEnumerateTheories = true,
            SynchronousMessageReporting = true,
        };
        controller.Run(sink, new FrontControllerRunSettings(
            TestFrameworkOptions.ForExecution(configuration),
            tests.Select(test => test.Serialization).ToArray()));
        if (!complete.Wait(TimeSpan.FromMinutes(30)))
            throw new TimeoutException("xUnit slot execution did not complete within thirty minutes");

        var actualCases = outcomes.Select(outcome => outcome.TestCaseUniqueId).ToArray();
        if (actualCases.Length != expectedCases.Count
            || actualCases.Distinct(StringComparer.Ordinal).Count() != actualCases.Length
            || actualCases.Any(testCaseId => !expectedCases.Contains(testCaseId)))
            throw new InvalidOperationException("xUnit slot outcome set does not exactly match its admitted test cases");
        if (starts.Count != outcomes.Count
            || starts.Any(start => !expectedCases.Contains(start.TestCaseUniqueId)))
            throw new InvalidOperationException("xUnit slot start set does not exactly match its admitted test cases");
        var expectedCollections = queue.Collections.Select(collection => collection.TestCollectionUniqueId).ToHashSet(StringComparer.Ordinal);
        if (starts.Any(start => !expectedCollections.Contains(start.TestCollectionUniqueId))
            || outcomes.Any(outcome => !expectedCollections.Contains(outcome.TestCollectionUniqueId)))
            throw new InvalidOperationException("xUnit emitted a collection outside the admitted queue");

        WriteJson(output, new SlotReceipt(
            "fsusblog.xunit-replay-slot-receipt.v1",
            queue.PlanDigest,
            queue.SlotId,
            Environment.ProcessId,
            admissions,
            starts.OrderBy(start => start.StartTime).ThenBy(start => start.TestUniqueId, StringComparer.Ordinal).ToArray(),
            outcomes.OrderBy(outcome => outcome.FinishTime).ThenBy(outcome => outcome.TestUniqueId, StringComparer.Ordinal).ToArray()));
        return outcomes.Any(outcome => outcome.Outcome is "failed" or "not-run") ? 1 : 0;
    }

    private static void AddOutcome(
        ICollection<TestOutcome> outcomes,
        object gate,
        SlotEventJournal journal,
        ITestResultMessage test,
        string outcome,
        string? detail,
        ITestFailed? failure = null)
    {
        lock (gate)
        {
            outcomes.Add(new TestOutcome(
                test.TestUniqueID,
                test.TestCaseUniqueID,
                test.TestCollectionUniqueID,
                outcome,
                test.ExecutionTime,
                test.FinishTime,
                detail));
            journal.Record("test-outcome", outcomes.Last());
            if (failure is not null)
            {
                journal.Record("test-failure", new
                {
                    TestUniqueId = failure.TestUniqueID,
                    TestCaseUniqueId = failure.TestCaseUniqueID,
                    TestCollectionUniqueId = failure.TestCollectionUniqueID,
                    failure.FinishTime,
                    Cause = failure.Cause.ToString(),
                    failure.ExceptionParentIndices,
                    failure.ExceptionTypes,
                    failure.Messages,
                    failure.StackTraces
                });
            }
        }
    }

    private static XunitProjectAssembly CreateProjectAssembly(string assembly)
    {
        var fullPath = Path.GetFullPath(assembly);
        var metadata = AssemblyUtility.GetAssemblyMetadata(fullPath)
            ?? throw new InvalidOperationException($"cannot read xUnit assembly metadata: {fullPath}");
        if (metadata.XunitVersion != 2)
            throw new InvalidOperationException($"expected an xUnit v2 assembly, found v{metadata.XunitVersion}: {fullPath}");
        return new XunitProjectAssembly(new XunitProject(), fullPath, metadata);
    }

    private static void InstallAssemblyResolver(string assembly)
    {
        var fullPath = Path.GetFullPath(assembly);
        var directory = Path.GetDirectoryName(fullPath)!;
        var dependencyResolver = new AssemblyDependencyResolver(fullPath);
        AssemblyLoadContext.Default.Resolving += (context, name) =>
        {
            var resolved = dependencyResolver.ResolveAssemblyToPath(name);
            if (resolved is null)
            {
                var adjacent = Path.Combine(directory, $"{name.Name}.dll");
                if (File.Exists(adjacent))
                    resolved = adjacent;
            }
            return resolved is null ? null : context.LoadFromAssemblyPath(resolved);
        };
    }

    private static T ReadJson<T>(string file)
        where T : class
    {
        using var stream = File.OpenRead(file);
        return JsonSerializer.Deserialize<T>(stream, s_jsonOptions)
            ?? throw new InvalidOperationException($"JSON document is empty: {file}");
    }

    private static void WriteJson<T>(string file, T value)
    {
        var fullPath = Path.GetFullPath(file);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        var temporary = $"{fullPath}.next-{Environment.ProcessId}";
        using (var stream = File.Create(temporary))
            JsonSerializer.Serialize(stream, value, s_jsonOptions);
        File.Move(temporary, fullPath, overwrite: true);
    }
}

internal sealed record DiscoveredTest(
    string AssemblyUniqueId,
    string TestCollectionUniqueId,
    string TestClassUniqueId,
    string TestMethodUniqueId,
    string TestCaseUniqueId,
    string? TestClassName,
    string? TestMethodName,
    IReadOnlyList<string> TestMethodParameterTypes,
    string TestCaseDisplayName,
    string Serialization,
    string? SkipReason,
    bool Explicit,
    IReadOnlyDictionary<string, string[]> Traits);

internal sealed record DiscoveryReceipt(
    string Schema,
    string Assembly,
    string AssemblyUniqueId,
    string Framework,
    string TargetFramework,
    int ProcessId,
    IReadOnlyList<DiscoveredTest> Tests);

internal sealed record SlotQueue(
    string Schema,
    string PlanDigest,
    string SlotId,
    IReadOnlyList<QueuedCollection> Collections);

internal sealed record QueuedCollection(
    string TestCollectionUniqueId,
    IReadOnlyList<QueuedTest> Tests);

internal sealed record QueuedTest(
    string TestCollectionUniqueId,
    string TestCaseUniqueId,
    string Serialization);

internal sealed record CollectionAdmission(
    int Ordinal,
    string TestCollectionUniqueId,
    IReadOnlyList<string> TestCaseUniqueIds,
    DateTimeOffset AdmittedAt);

internal sealed record TestStart(
    string TestUniqueId,
    string TestCaseUniqueId,
    string TestCollectionUniqueId,
    string TestDisplayName,
    DateTimeOffset StartTime);

internal sealed record TestOutcome(
    string TestUniqueId,
    string TestCaseUniqueId,
    string TestCollectionUniqueId,
    string Outcome,
    decimal ExecutionTime,
    DateTimeOffset FinishTime,
    string? Detail);

internal sealed record SlotReceipt(
    string Schema,
    string PlanDigest,
    string SlotId,
    int ProcessId,
    IReadOnlyList<CollectionAdmission> Admissions,
    IReadOnlyList<TestStart> Starts,
    IReadOnlyList<TestOutcome> Outcomes);

internal sealed class CommandLine
{
    private readonly IReadOnlyDictionary<string, string> _options;

    private CommandLine(string name, IReadOnlyDictionary<string, string> options)
    {
        Name = name;
        _options = options;
    }

    public string Name
    {
        get;
    }

    public static CommandLine Parse(string[] args)
    {
        if (args.Length == 0)
            throw new InvalidOperationException("usage: discover|run-slot --assembly <path> --output <path> [--queue <path>]");
        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = 1; index < args.Length; index += 2)
        {
            if (!args[index].StartsWith("--", StringComparison.Ordinal) || index + 1 >= args.Length)
                throw new InvalidOperationException($"invalid argument at position {index}: {args[index]}");
            var key = args[index][2..];
            if (!options.TryAdd(key, args[index + 1]))
                throw new InvalidOperationException($"duplicate option: --{key}");
        }
        return new CommandLine(args[0], options);
    }

    public string RequiredPath(string key, bool requireExisting = true)
    {
        if (!_options.TryGetValue(key, out var value) || string.IsNullOrWhiteSpace(value))
            throw new InvalidOperationException($"missing --{key}");
        var fullPath = Path.GetFullPath(value);
        if (requireExisting && !File.Exists(fullPath))
            throw new FileNotFoundException($"--{key} does not exist", fullPath);
        return fullPath;
    }
}
