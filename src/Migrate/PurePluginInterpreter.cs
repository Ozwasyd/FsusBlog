using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using FsusBlog.V2.Core.Extensions;
using Jint;
using Jint.Native;

namespace FsusBlogV2.Migrate;

internal static class PurePluginInterpreter
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly JsonSerializerOptions Protocol = new()
    {
        MaxDepth = 4, AllowDuplicateProperties = false, RespectNullableAnnotations = true,
        RespectRequiredConstructorParameters = true, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    private const int MaximumRequest = (PureRenderContract.MarkdownBytes + PureRenderContract.SourceBytes) * 6 + 4096;

    internal static async Task<int> RunAsync(Stream input, Stream output, CancellationToken ct)
    {
        try
        {
            var bytes = await ReadAsync(input, MaximumRequest, ct);
            var request = JsonSerializer.Deserialize<PurePluginRequest>(bytes, Protocol) ?? throw new InvalidDataException();
            if (request.Id is not { Length: > 0 and <= 128 } || request.Source is not { Length: > 0 } || request.Markdown is null ||
                Utf8.GetByteCount(request.Source) > PureRenderContract.SourceBytes ||
                Utf8.GetByteCount(request.Markdown) > PureRenderContract.MarkdownBytes || request.TimeoutMs is < 1 or > 250)
                throw new InvalidDataException();
            var deadline = TimeSpan.FromMilliseconds(request.TimeoutMs);
            var engine = new Engine(options =>
            {
                options.Strict();
                options.DisableStringCompilation();
                options.LimitMemory(8 * 1024 * 1024);
                options.MaxStatements(50_000);
                options.TimeoutInterval(deadline);
                options.CancellationToken(ct);
                options.LimitRecursion(32);
                options.Constraints.PromiseTimeout = deadline;
                options.Constraints.RegexTimeout = TimeSpan.FromMilliseconds(10);
                options.Constraints.MaxArraySize = 65_536;
                options.Interop.Enabled = false;
                options.Interop.AllowGetType = false;
                options.Interop.AllowSystemReflection = false;
                options.Interop.AllowWrite = false;
            });
            engine.SetValue("__fsusExpectedId", JsValue.FromObject(engine, request.Id));
            engine.SetValue("__fsusHook", JsValue.FromObject(engine, PureRenderContract.Hook));
            engine.Execute(Bootstrap);
            const string module = "fsusblog:pure-render";
            engine.Modules.Add(module, request.Source);
            var plugin = engine.Modules.Import(module).Get("default");
            var result = await engine.InvokeAsync("__fsusRun", ct, [plugin, JsValue.FromObject(engine, request.Markdown)]);
            if (!result.IsString() || Utf8.GetByteCount(result.AsString()) > PureRenderContract.MarkdownBytes || result.AsString().Contains('\0'))
                return 2;
            await output.WriteAsync(Utf8.GetBytes(result.AsString()), ct);
            return 0;
        }
        catch (Exception) { return 2; }
    }

    internal static async Task<byte[]> ReadAsync(Stream stream, int limit, CancellationToken ct)
    {
        var data = new byte[limit + 1];
        var size = 0;
        while (size < data.Length)
        {
            var read = await stream.ReadAsync(data.AsMemory(size), ct);
            if (read == 0) return data[..size];
            size += read;
        }
        throw new InvalidDataException("Plugin transport byte limit.");
    }

    // Host data crosses only as primitive JS values. The plugin receives no delegates or host objects.
    private const string Bootstrap = """
        (() => {
          const id = globalThis.__fsusExpectedId;
          const hook = globalThis.__fsusHook;
          const keys = Reflect.ownKeys;
          const own = Object.hasOwn;
          const freeze = Object.freeze;
          // A deterministic Hook sees no host clock, randomness or shared-memory waits.
          const fail = () => { throw new Error('unavailable'); };
          Object.defineProperty(Math, 'random', {value: fail, writable: false, configurable: false});
          for (const name of ['Date', 'Temporal', 'SharedArrayBuffer', 'Atomics'])
            Object.defineProperty(globalThis, name, {value: undefined, writable: false, configurable: false});
          if (typeof Intl === 'object')
            Object.defineProperty(Intl, 'DateTimeFormat', {value: undefined, writable: false, configurable: false});
          Object.defineProperty(globalThis, '__fsusRun', {value: async (definition, markdown) => {
            if (!definition || typeof definition !== 'object' || !own(definition, 'id') || definition.id !== id
                || !keys(definition).every(k => k === 'id' || k === 'hooks' || k === 'activate')) throw new Error('definition');
            let registered;
            const on = (name, handler) => {
              if (name !== hook || typeof handler !== 'function' || registered) throw new Error('registration');
              registered = handler;
            };
            if (own(definition, 'hooks')) {
              if (!definition.hooks || typeof definition.hooks !== 'object') throw new Error('hooks');
              for (const name of keys(definition.hooks)) on(name, definition.hooks[name]);
            }
            if (own(definition, 'activate')) {
              if (typeof definition.activate !== 'function') throw new Error('activation');
              await definition.activate(freeze({ hooks: freeze({ on }), config: freeze({}) }));
            }
            if (!registered) throw new Error('missing-handler');
            const next = (value = markdown) => ({ continue: true, value });
            const raw = await registered(freeze({ hookName: hook, payload: markdown, items: freeze({}),
              hooks: freeze({current:hook}), next }));
            if (raw === undefined) return markdown;
            if (typeof raw === 'string') return raw;
            if (!raw || typeof raw !== 'object' || raw.continue !== true || typeof raw.value !== 'string') throw new Error('result');
            return raw.value;
          }});
        })();
        """;
}

internal sealed record PurePluginRequest(string Id, string Source, string Markdown, int TimeoutMs);
