using System.Diagnostics;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

internal sealed record CurrentSchemaProducerFile(string RelativePath, long Bytes, string Sha256);

internal sealed record CurrentSchemaProducerExecution(
    string AssemblyPath,
    string SourceRevision,
    string DotnetHostPath,
    string DotnetHostSha256,
    IReadOnlyList<CurrentSchemaProducerFile> ProducerFiles,
    string EvidenceDirectory,
    string ArtifactPath,
    string ArtifactSha256,
    int ExitCode);

// Only an actual successful invocation can construct this capability. A caller JSON,
// a claimed producer identity or a matching hash alone cannot create it.
internal sealed class OwnedCurrentSchemaTarget
{
    private readonly CurrentSchemaOwnedTargetArtifact _artifact;

    private OwnedCurrentSchemaTarget(CurrentSchemaOwnedTargetArtifact artifact, CurrentSchemaProducerExecution execution)
    {
        _artifact = artifact;
        Execution = execution;
    }

    internal CurrentSchemaProducerExecution Execution
    {
        get;
    }

    internal CurrentSchemaIdentity Target => _artifact.Target;

    internal CurrentSchemaCompletePhysicalProjection ProjectExpectedPhysicalTarget(SchemaProviderKind provider)
    {
        ValidateArtifact(_artifact, _artifact.Input.Producer);
        return CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(ReadBoundInput(), provider);
    }

    internal CompiledCurrentSchemaBootstrap Compile(SchemaProviderKind provider)
    {
        ValidateArtifact(_artifact, _artifact.Input.Producer);
        return CurrentSchemaBootstrapCompiler.Compile(
            _artifact.Input, _artifact.Input.Producer, provider, _artifact.InputSha256);
    }

    internal CurrentSchemaBootstrapInput ReadBoundInput()
    {
        ValidateArtifact(_artifact, _artifact.Input.Producer);
        // The consumer gets its own copy; mutating it cannot mutate the retained capability.
        return JsonSerializer.Deserialize<CurrentSchemaBootstrapInput>(JsonSerializer.SerializeToUtf8Bytes(_artifact.Input), s_json)!;
    }

    internal async Task RevalidateRetainedArtifactAsync(CancellationToken cancellationToken)
    {
        if (await HashFileAsync(Execution.AssemblyPath, cancellationToken).ConfigureAwait(false) != _artifact.Input.Producer.ProducerAssemblySha256
            || await HashFileAsync(typeof(CurrentSchemaCanonicalAuthority).Assembly.Location, cancellationToken).ConfigureAwait(false) != _artifact.Input.Producer.ContractAssemblySha256)
        {
            throw new InvalidOperationException("current_schema_owned_retained_compiled_input_changed");
        }
        (byte[] bytes, string digest) = await ReadOriginalBytesAsync(Execution.ArtifactPath, cancellationToken).ConfigureAwait(false);
        if (digest != Execution.ArtifactSha256)
        {
            throw new InvalidOperationException("current_schema_owned_retained_artifact_changed");
        }
        CurrentSchemaOwnedTargetArtifact retained = ReadArtifact(bytes, _artifact.Input.Producer);
        ValidateArtifact(retained, _artifact.Input.Producer);
        if (retained.InputSha256 != _artifact.InputSha256 || retained.Target != _artifact.Target)
        {
            throw new InvalidOperationException("current_schema_owned_retained_input_changed");
        }
    }

    internal static async Task<OwnedCurrentSchemaTarget> InvokeOriginalOwnerAsync(
        string producerAssemblyPath, string expectedSourceRevision, string taskOutputRoot,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string assemblyPath = Path.GetFullPath(producerAssemblyPath);
        string producerRoot = Path.GetDirectoryName(assemblyPath)!;
        string outputRoot = Path.GetFullPath(taskOutputRoot);
        if (Path.GetFileName(assemblyPath) != "FsusBlog.Server.dll" || !Directory.Exists(outputRoot)
            || outputRoot == producerRoot || outputRoot.StartsWith(producerRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || !IsSourceRevision(expectedSourceRevision))
        {
            throw new InvalidOperationException("current_schema_owned_producer_configuration_invalid");
        }
        RequireRegularPath(assemblyPath);
        RequireRegularPath(outputRoot);
        string revision = ReadOriginalOwnerSourceRevision(assemblyPath, cancellationToken);
        if (revision != expectedSourceRevision)
        {
            throw new InvalidOperationException("current_schema_owned_producer_source_mismatch");
        }
        string sharedPath = Path.Combine(producerRoot, Path.GetFileName(typeof(CurrentSchemaCanonicalAuthority).Assembly.Location));
        RequireRegularPath(sharedPath);
        string contractDigest = await HashFileAsync(typeof(CurrentSchemaCanonicalAuthority).Assembly.Location, cancellationToken).ConfigureAwait(false);
        if (await HashFileAsync(sharedPath, cancellationToken).ConfigureAwait(false) != contractDigest)
        {
            throw new InvalidOperationException("current_schema_owned_producer_contract_mismatch");
        }
        RequireRegularPath(Path.ChangeExtension(assemblyPath, ".runtimeconfig.json"));
        RequireRegularPath(Path.ChangeExtension(assemblyPath, ".deps.json"));
        string dotnetHost = Path.GetFullPath(Path.Combine(RuntimeEnvironment.GetRuntimeDirectory(), "..", "..", "..",
            OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet"));
        RequireRegularPath(dotnetHost);
        string hostDigest = await HashFileAsync(dotnetHost, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<CurrentSchemaProducerFile> before = await SnapshotProducerAsync(producerRoot, cancellationToken).ConfigureAwait(false);
        var expectedProducer = new CurrentSchemaProducerIdentity(revision, "fsusblog.current-schema-owned-projection.v1",
            await HashFileAsync(assemblyPath, cancellationToken).ConfigureAwait(false), contractDigest);

        string evidenceDirectory = Path.Combine(outputRoot, "current-schema-owned-export-" + Guid.NewGuid().ToString("N"));
        if (Directory.Exists(evidenceDirectory) || File.Exists(evidenceDirectory))
        {
            throw new InvalidOperationException("current_schema_owned_export_evidence_already_exists");
        }
        Directory.CreateDirectory(evidenceDirectory);
        string artifactPath = Path.Combine(evidenceDirectory, "current-owned-target.json");
        await WriteNewJsonAsync(Path.Combine(evidenceDirectory, "producer-before.json"), before, cancellationToken).ConfigureAwait(false);
        try
        {
            int exitCode = await InvokeAsync(dotnetHost, assemblyPath, artifactPath, evidenceDirectory, cancellationToken).ConfigureAwait(false);
            IReadOnlyList<CurrentSchemaProducerFile> after = await SnapshotProducerAsync(producerRoot, cancellationToken).ConfigureAwait(false);
            await WriteNewJsonAsync(Path.Combine(evidenceDirectory, "producer-after.json"), after, cancellationToken).ConfigureAwait(false);
            if (!before.SequenceEqual(after) || await HashFileAsync(dotnetHost, cancellationToken).ConfigureAwait(false) != hostDigest
                || await HashFileAsync(typeof(CurrentSchemaCanonicalAuthority).Assembly.Location, cancellationToken).ConfigureAwait(false) != contractDigest)
            {
                throw new InvalidOperationException("current_schema_owned_producer_changed_during_export");
            }
            if (exitCode != 0)
            {
                throw new InvalidOperationException($"current_schema_owned_producer_failed:{exitCode}");
            }
            RequireRegularPath(artifactPath);
            (byte[] bytes, string digest) = await ReadOriginalBytesAsync(artifactPath, cancellationToken).ConfigureAwait(false);
            CurrentSchemaOwnedTargetArtifact artifact = ReadArtifact(bytes, expectedProducer);
            var execution = new CurrentSchemaProducerExecution(assemblyPath, revision, dotnetHost, hostDigest,
                before, evidenceDirectory, artifactPath, digest, exitCode);
            await WriteNewJsonAsync(Path.Combine(evidenceDirectory, "execution.json"), execution, cancellationToken).ConfigureAwait(false);
            await WriteNewJsonAsync(Path.Combine(evidenceDirectory, "result.json"), new
            {
                successfulProducerInvocation = true,
                artifactPath,
                rawStdout = Path.Combine(evidenceDirectory, "stdout.log"),
                rawStderr = Path.Combine(evidenceDirectory, "stderr.log")
            }, cancellationToken).ConfigureAwait(false);
            return new OwnedCurrentSchemaTarget(artifact, execution);
        }
        catch (Exception exception)
        {
            string failureCode = exception is OperationCanceledException ? "current_schema_owned_export_cancelled"
                : exception.Message.Split(':', 2)[0];
            // Retain actual raw output even when export/validation is rejected. This is
            // producer evidence, not apply admission or a completed native operation.
            using var evidenceCancellation = new CancellationTokenSource();
            try
            {
                await WriteNewJsonAsync(Path.Combine(evidenceDirectory, "rejection.json"), new
                {
                    successfulProducerInvocation = false,
                    failureCode,
                    artifactPath,
                    rawStdout = Path.Combine(evidenceDirectory, "stdout.log"),
                    rawStderr = Path.Combine(evidenceDirectory, "stderr.log")
                }, evidenceCancellation.Token).ConfigureAwait(false);
            }
            catch (Exception retentionFailure)
            {
                throw new AggregateException("current_schema_owned_export_failure_evidence_unsealed", exception, retentionFailure);
            }
            throw;
        }
    }

    internal static CurrentSchemaOwnedTargetArtifact ReadArtifact(byte[] bytes, CurrentSchemaProducerIdentity expectedProducer)
    {
        RejectDuplicateProperties(bytes);
        CurrentSchemaOwnedTargetArtifact artifact = JsonSerializer.Deserialize<CurrentSchemaOwnedTargetArtifact>(bytes, s_json)
            ?? throw new InvalidOperationException("current_schema_owned_artifact_empty");
        ValidateArtifact(artifact, expectedProducer);
        return artifact;
    }

    internal static async Task<RetainedMigrationToolObservation> ReadRetainedMigrationToolAsync(
        RetainedMigrationToolReadConfiguration configuration, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!OperatingSystem.IsLinux())
        {
            throw new InvalidOperationException("migration_retained_original_node_platform_unsupported");
        }
        // This is the system Node used by the original production entry, never a
        // CLI-selected executable, argument list, checker or caller JSON callback.
        const string node = "/usr/bin/node";
        string script = Path.Combine(configuration.SourceRoot, "tools/ci/migration-retained-inputs.mjs");
        string[] inputs =
        [
            node, script,
            Path.Combine(configuration.SourceRoot, "tools/ci/production-build-artifacts.mjs"),
            Path.Combine(configuration.SourceRoot, "tools/fact-extractors/identity.mjs"),
            Path.Combine(configuration.SourceRoot, "tools/fact-extractors/lib/canonicalize.mjs")
        ];
        foreach (string input in inputs)
        {
            RequireRegularPath(input);
        }
        IReadOnlyList<CurrentSchemaProducerFile> before = await SnapshotRetainedReaderInputsAsync(inputs,
            cancellationToken).ConfigureAwait(false);
        // A stable caller checkout is not an approved reader. These exact original
        // source bytes were compiled into the actual executing Migration DLL.
        // Derive their identities here; never accept hashes from caller JSON.
        var compiledSources = new List<string>();
        foreach (CurrentSchemaProducerFile input in before.Skip(1))
        {
            string relative = Path.GetRelativePath(configuration.SourceRoot, input.RelativePath).Replace(Path.DirectorySeparatorChar, '.');
            await using Stream compiled = typeof(OwnedCurrentSchemaTarget).Assembly.GetManifestResourceStream(
                "FsusBlog.Migration.RetainedReader." + relative)
                ?? throw new InvalidOperationException("migration_retained_compiled_reader_input_missing");
            using var bytes = new MemoryStream();
            await compiled.CopyToAsync(bytes, cancellationToken).ConfigureAwait(false);
            byte[] source = bytes.ToArray();
            string encoded = Convert.ToBase64String(source);
            if (encoded.Length >= 128 * 1024)
            {
                throw new InvalidOperationException("migration_retained_compiled_reader_argument_too_large");
            }
            string digest = Convert.ToHexString(SHA256.HashData(source)).ToLowerInvariant();
            if (digest != input.Sha256)
            {
                throw new InvalidOperationException("migration_retained_compiled_reader_input_changed");
            }
            compiledSources.Add(encoded);
        }
        string evidence = Path.Combine(configuration.EvidenceRoot, "migration-retained-read-" + Guid.NewGuid().ToString("N"));
        RequireRegularPath(configuration.EvidenceRoot);
        Directory.CreateDirectory(evidence);
        await WriteNewJsonAsync(Path.Combine(evidence, "producer-before.json"), before, cancellationToken).ConfigureAwait(false);
        int exit = await InvokeArgumentsAsync(node, configuration.SourceRoot,
            ["--experimental-vm-modules", "--input-type=module", "--eval", s_retainedCompiledReaderBootstrap, "--",
                configuration.SourceRoot, configuration.ArtifactRoot, configuration.SdkRoot, .. compiledSources],
            evidence, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<CurrentSchemaProducerFile> after = await SnapshotRetainedReaderInputsAsync(inputs,
            cancellationToken).ConfigureAwait(false);
        await WriteNewJsonAsync(Path.Combine(evidence, "producer-after.json"), after, cancellationToken).ConfigureAwait(false);
        if (exit != 0 || !before.SequenceEqual(after))
        {
            throw new InvalidOperationException("migration_retained_original_reader_failed_or_changed");
        }
        var stdoutRead = await ReadOriginalBytesAsync(Path.Combine(evidence, "stdout.log"), cancellationToken).ConfigureAwait(false);
        byte[] stdout = stdoutRead.Bytes;
        using JsonDocument document = JsonDocument.Parse(stdout);
        RejectDuplicateProperties(document.RootElement);
        RetainedMigrationToolObservation observation = JsonSerializer.Deserialize<RetainedMigrationToolObservation>(stdout, s_json)
            ?? throw new InvalidOperationException("migration_retained_original_reader_empty");
        ValidateRetainedMigrationObservation(observation, configuration);
        // The actual assembly executing this code is the retained Migration tool,
        // not another DLL selected by a report. Both PE provenance and whole bytes
        // must agree with the original production owner and its sealed domain.
        string executing = typeof(OwnedCurrentSchemaTarget).Assembly.Location;
        string revision = ReadOriginalOwnerSourceRevision(executing, cancellationToken, "FsusBlog.Migration");
        if (revision != observation.Identity.SourceRevision
            || await HashFileAsync(executing, cancellationToken).ConfigureAwait(false) != observation.AssemblySha256
            || await HashFileAsync(observation.AssemblyPath, cancellationToken).ConfigureAwait(false) != observation.AssemblySha256
            || await HashFileAsync(observation.ReceiptPath, cancellationToken).ConfigureAwait(false) != observation.ReceiptSha256)
        {
            throw new InvalidOperationException("migration_retained_executing_tool_or_receipt_changed");
        }
        if (observation.CurrentTargetProducer is { } producer)
        {
            foreach ((string file, string digest) in new[]
            {
                (producer.AssemblyPath, producer.AssemblySha256),
                (producer.SharedAssemblyPath, producer.SharedAssemblySha256),
                (producer.RuntimeConfigurationPath, producer.RuntimeConfigurationSha256),
                (producer.DependenciesPath, producer.DependenciesSha256)
            })
            {
                if (await HashFileAsync(file, cancellationToken).ConfigureAwait(false) != digest)
                {
                    throw new InvalidOperationException("migration_retained_original_current_target_input_changed");
                }
            }
            if (ReadOriginalOwnerSourceRevision(producer.AssemblyPath, cancellationToken) != observation.Identity.SourceRevision
                || await HashFileAsync(typeof(CurrentSchemaCanonicalAuthority).Assembly.Location, cancellationToken).ConfigureAwait(false)
                    != producer.SharedAssemblySha256)
            {
                throw new InvalidOperationException("migration_retained_original_current_target_source_or_contract_mismatch");
            }
        }
        cancellationToken.ThrowIfCancellationRequested();
        return observation;
    }

    // Only original compiled resource bytes execute. Identifiers preserve the
    // original import.meta/defaultRoot semantics but never authorize a disk read.
    // Keep this one fixed loader with the sole process owner, not a caller plugin.
    private const string s_retainedCompiledReaderBootstrap = """
        import vm from 'node:vm';
        import path from 'node:path';
        import { pathToFileURL } from 'node:url';
        const args = process.argv.slice(1);
        if (args.length !== 7) throw new Error('migration_retained_compiled_reader_input_count');
        const [root, artifactRoot, sdkRoot, ...encoded] = args;
        const names = ['tools/ci/migration-retained-inputs.mjs', 'tools/ci/production-build-artifacts.mjs',
            'tools/fact-extractors/identity.mjs', 'tools/fact-extractors/lib/canonicalize.mjs'];
        const builtins = new Set(['node:fs', 'node:path', 'node:url', 'node:crypto', 'node:child_process', 'node:process']);
        const modules = new Map();
        let total = 0;
        for (let index = 0; index < names.length; ++index) {
            const value = encoded[index];
            if (!value || value.length >= 131072 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))
                throw new Error('migration_retained_compiled_reader_encoding');
            const bytes = Buffer.from(value, 'base64');
            total += bytes.length;
            if (total >= 4 * 96 * 1024 || bytes.toString('base64') !== value)
                throw new Error('migration_retained_compiled_reader_byte_bound');
            const identifier = pathToFileURL(path.join(root, names[index])).href;
            modules.set(identifier, new vm.SourceTextModule(new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
                identifier, initializeImportMeta(meta) { meta.url = identifier; },
                importModuleDynamically() { throw new Error('migration_retained_compiled_reader_dynamic_import'); }
            }));
        }
        const builtinModules = new Map();
        async function link(specifier, referencing) {
            if (builtins.has(specifier)) {
                if (!builtinModules.has(specifier)) {
                    const namespace = await import(specifier);
                    const exports = Object.keys(namespace);
                    builtinModules.set(specifier, new vm.SyntheticModule(exports, function () {
                        for (const name of exports) this.setExport(name, namespace[name]);
                    }, { identifier: specifier }));
                }
                return builtinModules.get(specifier);
            }
            if (!specifier.startsWith('./') && !specifier.startsWith('../'))
                throw new Error('migration_retained_compiled_reader_unknown_import');
            const resolved = new URL(specifier, referencing.identifier).href;
            if (!modules.has(resolved)) throw new Error('migration_retained_compiled_reader_unbound_import');
            return modules.get(resolved);
        }
        const original = modules.get(pathToFileURL(path.join(root, names[0])).href);
        await original.link(link);
        await original.evaluate();
        if ([...modules.values()].some(module => module.status !== 'evaluated'))
            throw new Error('migration_retained_compiled_reader_incomplete_closure');
        const observation = original.namespace.readProductionRetainedMigrationTool({ root, artifactRoot, sdkRoot });
        process.stdout.write(JSON.stringify(observation) + '\n');
        """;

    private static async Task<IReadOnlyList<CurrentSchemaProducerFile>> SnapshotRetainedReaderInputsAsync(
        IEnumerable<string> inputs, CancellationToken cancellationToken)
    {
        var records = new List<CurrentSchemaProducerFile>();
        foreach (string input in inputs)
        {
            records.Add(new(input, new FileInfo(input).Length,
                await HashFileAsync(input, cancellationToken).ConfigureAwait(false)));
        }
        return records;
    }

    private static void ValidateRetainedMigrationObservation(RetainedMigrationToolObservation observation,
        RetainedMigrationToolReadConfiguration configuration)
    {
        if (observation.Identity is null || observation.Identity.SourceRevision is not string revision || !IsSourceRevision(revision)
            || observation.AssemblyPath != Path.Combine(configuration.ArtifactRoot, "payload/migration-runtime/FsusBlog.Migration.dll")
            || observation.ReceiptPath != Path.Combine(configuration.ArtifactRoot, "receipt.json"))
        {
            throw new InvalidOperationException("migration_retained_original_reader_binding_invalid");
        }
        foreach (string digest in new[] { observation.Identity.WorktreeDigest, observation.Identity.ToolchainDigest,
            observation.Identity.ConfigurationDigest, observation.AssemblySha256, observation.ReceiptSha256 })
        {
            OfflineMigrationPlanValidation.RequireDigest(digest, "migration_retained_original_reader_digest_invalid");
        }
        if (observation.CurrentTargetProducer is { } producer)
        {
            string backend = Path.Combine(configuration.ArtifactRoot, "payload/backend-runtime");
            foreach ((string file, string expected, string digest) in new[]
            {
                (producer.AssemblyPath, "FsusBlog.Server.dll", producer.AssemblySha256),
                (producer.SharedAssemblyPath, "FsusBlog.Shared.dll", producer.SharedAssemblySha256),
                (producer.RuntimeConfigurationPath, "FsusBlog.Server.runtimeconfig.json", producer.RuntimeConfigurationSha256),
                (producer.DependenciesPath, "FsusBlog.Server.deps.json", producer.DependenciesSha256)
            })
            {
                if (file != Path.Combine(backend, expected))
                {
                    throw new InvalidOperationException("migration_retained_original_current_target_input_path_invalid");
                }
                OfflineMigrationPlanValidation.RequireDigest(digest, "migration_retained_original_current_target_digest_invalid");
            }
        }
    }

    private static void ValidateArtifact(CurrentSchemaOwnedTargetArtifact artifact, CurrentSchemaProducerIdentity expectedProducer)
    {
        if (artifact.SchemaVersion != CurrentSchemaOwnedTargetProjection.ArtifactSchemaVersion
            || artifact.Input.Producer != expectedProducer
            || artifact.InputSha256 != CurrentSchemaOwnedTargetProjection.ComputeInputDigest(artifact.Input)
            || artifact.Target != CurrentSchemaOwnedTargetProjection.Observe(artifact.Input))
        {
            throw new InvalidOperationException("current_schema_owned_artifact_binding_invalid");
        }
    }

    private static readonly JsonSerializerOptions s_json = new()
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    private static void RejectDuplicateProperties(ReadOnlySpan<byte> bytes)
    {
        // Reject the first actual duplicate before parsing later nested values.
        // The strict reader/deserializer still reject malformed/trailing input;
        // duplicate precedence does not permit a second interpretation.
        var reader = new Utf8JsonReader(bytes);
        var objects = new Stack<HashSet<string>?>();
        while (reader.Read())
        {
            switch (reader.TokenType)
            {
                case JsonTokenType.StartObject:
                    objects.Push(new HashSet<string>(StringComparer.Ordinal));
                    break;
                case JsonTokenType.StartArray:
                    objects.Push(null);
                    break;
                case JsonTokenType.EndObject:
                case JsonTokenType.EndArray:
                    objects.Pop();
                    break;
                case JsonTokenType.PropertyName:
                    if (objects.Peek() is not HashSet<string> keys || !keys.Add(reader.GetString()!))
                        throw new InvalidOperationException("current_schema_owned_artifact_duplicate_property");
                    break;
            }
        }
    }

    private static void RejectDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!keys.Add(property.Name))
                {
                    throw new InvalidOperationException("current_schema_owned_artifact_duplicate_property");
                }
                RejectDuplicateProperties(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicateProperties(item);
            }
        }
    }

    private static Task<int> InvokeAsync(string host, string assembly, string output, string evidence, CancellationToken cancellationToken)
        => InvokeArgumentsAsync(host, Path.GetDirectoryName(assembly)!,
            [assembly, "export-current-schema-owned-target", "--output", output], evidence, cancellationToken);

    private static async Task<int> InvokeArgumentsAsync(string host, string workingDirectory,
        IReadOnlyList<string> arguments, string evidence, CancellationToken cancellationToken)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo(host)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = workingDirectory
            }
        };
        foreach (string argument in arguments)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }
        if (host == "/usr/bin/node")
        {
            // Do not allow ambient JavaScript preloads or alternate module roots
            // to execute before the fixed, compiled-bound original reader.
            process.StartInfo.Environment.Remove("NODE_OPTIONS");
            process.StartInfo.Environment.Remove("NODE_PATH");
        }
        await using var stdout = new FileStream(Path.Combine(evidence, "stdout.log"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        await using var stderr = new FileStream(Path.Combine(evidence, "stderr.log"), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        cancellationToken.ThrowIfCancellationRequested();
        if (!process.Start())
        {
            throw new InvalidOperationException("current_schema_owned_export_start_failed");
        }
        using var pipeCancellation = new CancellationTokenSource();
        Task outputTask = process.StandardOutput.BaseStream.CopyToAsync(stdout, pipeCancellation.Token);
        Task errorTask = process.StandardError.BaseStream.CopyToAsync(stderr, pipeCancellation.Token);
        Exception? failure = null;
        try
        {
            Task exitTask = process.WaitForExitAsync(cancellationToken);
            Task rawTask = Task.WhenAll(outputTask, errorTask);
            Task completed = await Task.WhenAny(exitTask, rawTask).ConfigureAwait(false);
            if (completed == rawTask)
            {
                await rawTask.ConfigureAwait(false);
            }
            await exitTask.ConfigureAwait(false);
            await Task.WhenAll(outputTask, errorTask).WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            failure = exception;
            using var terminalDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
                await process.WaitForExitAsync(terminalDeadline.Token).ConfigureAwait(false);
                await Task.WhenAll(outputTask, errorTask).WaitAsync(terminalDeadline.Token).ConfigureAwait(false);
            }
            catch (Exception cleanupFailure)
            {
                failure = new AggregateException("current_schema_owned_export_terminal_unproven", exception, cleanupFailure);
                // The original terminal deadline is a failure, not permission to
                // dispose destinations while background copy tasks still own them.
                // Close/cancel the actual pipe reads and await their real terminal
                // states before leaving this sole resource owner. This does not
                // prove a physical descendant process group has terminated.
                try
                {
                    pipeCancellation.Cancel();
                }
                catch (Exception cancellationFailure)
                {
                    failure = new AggregateException("current_schema_owned_export_terminal_unproven", failure, cancellationFailure);
                }
                foreach (Stream pipe in new[] { process.StandardOutput.BaseStream, process.StandardError.BaseStream })
                {
                    try
                    {
                        pipe.Dispose();
                    }
                    catch (Exception closeFailure)
                    {
                        failure = new AggregateException("current_schema_owned_export_terminal_unproven", failure, closeFailure);
                    }
                }
                try
                {
                    await Task.WhenAll(outputTask, errorTask).ConfigureAwait(false);
                }
                catch (Exception pipeFailure)
                {
                    failure = new AggregateException("current_schema_owned_export_terminal_unproven", failure, pipeFailure);
                }
            }
        }
        try
        {
            stdout.Flush(flushToDisk: true);
            stderr.Flush(flushToDisk: true);
            using var evidenceCancellation = new CancellationTokenSource();
            await WriteNewJsonAsync(Path.Combine(evidence, "child-terminal.json"), new
            {
                processId = process.Id,
                childTerminalObserved = process.HasExited,
                childExitCode = process.HasExited ? process.ExitCode : (int?)null,
                stdoutCopyTerminalObserved = outputTask.IsCompleted,
                stderrCopyTerminalObserved = errorTask.IsCompleted,
                stdoutEndOfFileObserved = outputTask.IsCompletedSuccessfully,
                stderrEndOfFileObserved = errorTask.IsCompletedSuccessfully,
                taskTreeQualification = false
            }, evidenceCancellation.Token).ConfigureAwait(false);
        }
        catch (Exception retentionFailure)
        {
            failure = failure is null ? retentionFailure
                : new AggregateException("current_schema_owned_export_terminal_evidence_unsealed", failure, retentionFailure);
        }
        if (failure is not null)
        {
            ExceptionDispatchInfo.Capture(failure).Throw();
        }
        return process.ExitCode;
    }

    private static async Task<IReadOnlyList<CurrentSchemaProducerFile>> SnapshotProducerAsync(string root, CancellationToken cancellationToken)
    {
        var result = new List<CurrentSchemaProducerFile>();
        foreach (string entry in Directory.EnumerateFileSystemEntries(root).Order(StringComparer.Ordinal))
        {
            RequireRegularPath(entry);
            if (Directory.Exists(entry))
            {
                foreach (CurrentSchemaProducerFile child in await SnapshotProducerAsync(entry, cancellationToken).ConfigureAwait(false))
                {
                    result.Add(child with
                    {
                        RelativePath = Path.Combine(Path.GetFileName(entry), child.RelativePath)
                    });
                }
            }
            else
            {
                result.Add(new CurrentSchemaProducerFile(Path.GetFileName(entry), new FileInfo(entry).Length,
                    await HashFileAsync(entry, cancellationToken).ConfigureAwait(false)));
            }
        }
        return result;
    }

    private static string ReadOriginalOwnerSourceRevision(string assemblyPath, CancellationToken cancellationToken,
        string expectedAssemblyName = "FsusBlog.Server")
    {
        using var originalHandle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(assemblyPath, cancellationToken);
        var initial = OfflineMigrationCurrentSchemaArtifactReader.CaptureOriginalRegularFileIdentity(assemblyPath, originalHandle, cancellationToken);
        using var stream = new FileStream(originalHandle, FileAccess.Read, 4096);
        using var pe = new PEReader(stream);
        MetadataReader reader = pe.GetMetadataReader();
        AssemblyDefinition assembly = reader.GetAssemblyDefinition();
        if (reader.GetString(assembly.Name) != expectedAssemblyName)
        {
            throw new InvalidOperationException("current_schema_owned_producer_assembly_invalid");
        }
        var revisions = new List<string>();
        foreach (CustomAttributeHandle handle in assembly.GetCustomAttributes())
        {
            CustomAttribute attribute = reader.GetCustomAttribute(handle);
            if (attribute.Constructor.Kind != HandleKind.MemberReference)
            {
                continue;
            }
            MemberReference constructor = reader.GetMemberReference((MemberReferenceHandle)attribute.Constructor);
            if (constructor.Parent.Kind != HandleKind.TypeReference)
            {
                continue;
            }
            TypeReference type = reader.GetTypeReference((TypeReferenceHandle)constructor.Parent);
            if (reader.GetString(type.Namespace) != "System.Reflection" || reader.GetString(type.Name) != "AssemblyMetadataAttribute")
            {
                continue;
            }
            BlobReader value = reader.GetBlobReader(attribute.Value);
            if (value.ReadUInt16() != 1)
            {
                throw new InvalidOperationException("current_schema_owned_producer_metadata_invalid");
            }
            string? key = value.ReadSerializedString();
            string? metadata = value.ReadSerializedString();
            if (key == "FsusBlog.SourceCommit")
            {
                if (metadata is null || !IsSourceRevision(metadata))
                {
                    throw new InvalidOperationException("current_schema_owned_producer_source_missing");
                }
                revisions.Add(metadata);
            }
        }
        if (revisions.Count != 1)
            throw new InvalidOperationException("current_schema_owned_producer_source_missing");
        OfflineMigrationCurrentSchemaArtifactReader.ValidateOriginalRegularFileUnchanged(assemblyPath, originalHandle, initial, cancellationToken);
        return revisions[0];
    }

    private static bool IsSourceRevision(string value)
        => value.Length == 40 && value.Any(static character => character != '0')
            && value.All(static character => character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static void RequireRegularPath(string path)
    {
        string full = Path.GetFullPath(path);
        for (string? cursor = full; cursor is not null; cursor = Path.GetDirectoryName(cursor))
        {
            if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException("current_schema_owned_producer_symbolic_path");
            }
        }
    }

    private static async Task<string> HashFileAsync(string path, CancellationToken cancellationToken)
    {
        string originalPath = Path.GetFullPath(path);
        using var handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(originalPath, cancellationToken);
        var initial = OfflineMigrationCurrentSchemaArtifactReader.CaptureOriginalRegularFileIdentity(originalPath, handle, cancellationToken);
        await using var stream = new FileStream(handle, FileAccess.Read, 4096);
        string digest = Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken).ConfigureAwait(false)).ToLowerInvariant();
        OfflineMigrationCurrentSchemaArtifactReader.ValidateOriginalRegularFileUnchanged(originalPath, handle, initial, cancellationToken);
        return digest;
    }

    private static async Task<(byte[] Bytes, string Sha256)> ReadOriginalBytesAsync(string path, CancellationToken cancellationToken)
    {
        using var handle = OfflineMigrationCurrentSchemaArtifactReader.OpenOriginalRegularFile(path, cancellationToken);
        var initial = OfflineMigrationCurrentSchemaArtifactReader.CaptureOriginalRegularFileIdentity(path, handle, cancellationToken);
        await using var stream = new FileStream(handle, FileAccess.Read, 4096);
        byte[] bytes = new byte[checked((int)stream.Length)];
        await stream.ReadExactlyAsync(bytes, cancellationToken).ConfigureAwait(false);
        if (await stream.ReadAsync(new byte[1], cancellationToken).ConfigureAwait(false) != 0)
        {
            throw new InvalidOperationException("current_schema_owned_artifact_changed_during_read");
        }
        string digest = Hash(bytes);
        OfflineMigrationCurrentSchemaArtifactReader.ValidateOriginalRegularFileUnchanged(path, handle, initial, cancellationToken);
        return (bytes, digest);
    }

    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static async Task WriteNewJsonAsync<T>(string path, T value, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read,
            4096, FileOptions.Asynchronous | FileOptions.WriteThrough);
        await JsonSerializer.SerializeAsync(stream, value, cancellationToken: cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        stream.Flush(flushToDisk: true);
    }
}
