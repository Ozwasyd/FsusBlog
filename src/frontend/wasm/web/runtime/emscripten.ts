export type EmscriptenModuleFactory<TModule> = (options?: {
    locateFile?: (path: string) => string;
    print?: (message: string) => void;
    printErr?: (message: string) => void;
    wasmBinary?: Uint8Array;
    instantiateWasm?: (
        imports: WebAssembly.Imports,
        receiveInstance: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
    ) => WebAssembly.Exports;
}) => Promise<TModule>;

export interface EmscriptenLoadMetrics {
    downloadMs: number;
    compileMs: number;
    instantiateMs: number;
    moduleBytes: number;
    wasmBytes: number;
    compiledModuleCacheHit: boolean;
}

const compiledModuleCache = new Map<string, Promise<WebAssembly.Module>>();

export class WasmRuntimeError extends Error
{
    readonly code: string;

    constructor(code: string)
    {
        super(code);
        this.name = 'WasmRuntimeError';
        this.code = code;
    }
}

interface ModuleNamespace<TModule> {
    default?: EmscriptenModuleFactory<TModule>;
    [key: string]: unknown;
}

export async function loadEmscriptenModule<TModule>(
    moduleUrl: string,
    exportName: string,
    wasmUrl: string,
    options?: {
        print?: (message: string) => void;
        printErr?: (message: string) => void;
        compiledModuleCacheKey?: string;
        expectedModuleSha256?: string;
        expectedWasmSha256?: string;
        requireCompiledModule?: boolean;
        onMetrics?: (metrics: EmscriptenLoadMetrics) => void;
    }
): Promise<TModule | null>
{
    const resolvedModuleUrl = await resolveRuntimeUrl(moduleUrl);
    const resolvedWasmUrl = await resolveRuntimeUrl(wasmUrl);
    const moduleImportUrl = withIntegrityIdentity(resolvedModuleUrl, options?.expectedModuleSha256);
    const nodeDirname = resolveNodeDirname(moduleImportUrl);
    const downloadStartedAt = now();
    const [moduleBinary, wasmBinary] = await Promise.all([
    options?.expectedModuleSha256
        ? readNodeRuntimeBinary(moduleImportUrl) ?? readBrowserRuntimeBinary(moduleImportUrl)
        : Promise.resolve(undefined),
    readNodeRuntimeBinary(resolvedWasmUrl) ?? readBrowserRuntimeBinary(resolvedWasmUrl)
    ]);
    const downloadMs = now() - downloadStartedAt;
    if (options?.expectedModuleSha256)
    {
        if (!moduleBinary)
        {
            throw new WasmRuntimeError('module_binary_unavailable_for_hash');
        }
        const actualHash = await sha256Hex(moduleBinary, 'module_hash_verifier_unavailable');
        if (actualHash !== normalizeSha256(options.expectedModuleSha256))
        {
            throw new WasmRuntimeError('module_hash_mismatch');
        }
    }
    if (wasmBinary && options?.expectedWasmSha256)
    {
        const actualHash = await sha256Hex(wasmBinary, 'wasm_hash_verifier_unavailable');
        if (actualHash !== normalizeSha256(options.expectedWasmSha256))
        {
            throw new WasmRuntimeError('wasm_hash_mismatch');
        }
    }
    const moduleRef = await import(/* @vite-ignore */ moduleImportUrl) as ModuleNamespace<TModule>;
    const factory = (moduleRef.default ?? moduleRef[exportName]) as EmscriptenModuleFactory<TModule> | undefined;
    if (typeof factory !== 'function')
    {
        return null;
    }
    const cacheKey = options?.compiledModuleCacheKey;
    const cacheHit = Boolean(cacheKey && compiledModuleCache.has(cacheKey));
    let compiledModule: WebAssembly.Module | undefined;
    let compileMs = 0;
    if (cacheKey && wasmBinary)
    {
        const compileStartedAt = now();
        compiledModule = await getCompiledModule(cacheKey, wasmBinary);
        compileMs = now() - compileStartedAt;
    }
    else if (options?.requireCompiledModule)
    {
        throw new WasmRuntimeError('wasm_binary_unavailable_for_compiled_cache');
    }
    const globals = globalThis as { __dirname?: string; };
    const savedDirname = globals.__dirname;
    if (nodeDirname)
    {
        globals.__dirname = nodeDirname;
    }

    try
    {
        let instantiateMs = 0;
        const instance = await factory({
            locateFile: (path) => path.endsWith('.wasm') ? resolvedWasmUrl : path,
            print: options?.print,
            printErr: options?.printErr,
            wasmBinary,
            ...(compiledModule ? {
        instantiateWasm: (imports, receiveInstance) =>
{
          const instantiateStartedAt = now();
          const wasmInstance = new WebAssembly.Instance(compiledModule, imports);
          instantiateMs += now() - instantiateStartedAt;
          receiveInstance(wasmInstance, compiledModule);
          return wasmInstance.exports;
        }
      } : {})
        });
        options?.onMetrics?.({
            downloadMs,
            compileMs,
            instantiateMs,
            moduleBytes: moduleBinary?.byteLength ?? 0,
            wasmBytes: wasmBinary?.byteLength ?? 0,
            compiledModuleCacheHit: cacheHit
        });
        return instance;
    }
    finally
    {
        if (nodeDirname)
        {
            if (savedDirname === undefined)
            {
                delete globals.__dirname;
            }
            else
            {
                globals.__dirname = savedDirname;
            }
        }
    }
}

async function getCompiledModule(cacheKey: string, binary: Uint8Array): Promise<WebAssembly.Module>
{
    let pending = compiledModuleCache.get(cacheKey);
    if (!pending)
    {
        pending = WebAssembly.compile(binary as BufferSource);
        compiledModuleCache.set(cacheKey, pending);
        pending.catch(() => compiledModuleCache.delete(cacheKey));
    }
    return await pending;
}

function now(): number
{
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function clearCompiledWasmModuleCacheForTests(): void
{
    compiledModuleCache.clear();
}

async function sha256Hex(bytes: Uint8Array, unavailableCode: string): Promise<string>
{
    const subtle = globalThis.crypto?.subtle;
    if (!subtle)
    {
        throw new WasmRuntimeError(unavailableCode);
    }
    const digest = await subtle.digest('SHA-256', bytes as BufferSource);
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function resolveNodeDirname(moduleUrl: string): string | null
{
    if (!moduleUrl.startsWith('file://'))
    {
        return null;
    }

    const pathname = new URL('.', moduleUrl).pathname.replace(/\/+$/, '');
    return decodeURIComponent(pathname);
}

function readNodeRuntimeBinary(runtimeUrl: string): Uint8Array | undefined
{
    if (!runtimeUrl.startsWith('file://'))
    {
        return undefined;
    }

    const nodeProcess = (globalThis as {
        process?: {
            getBuiltinModule?: (name: string) => { readFileSync?: (path: string) => Uint8Array; } | undefined;
        };
    }).process;
    const fs = nodeProcess?.getBuiltinModule?.('fs');
    if (typeof fs?.readFileSync !== 'function')
    {
        return undefined;
    }

    return fs.readFileSync(fileUrlToPath(runtimeUrl));
}

async function readBrowserRuntimeBinary(runtimeUrl: string): Promise<Uint8Array | undefined>
{
    if (runtimeUrl.startsWith('file://') || typeof fetch !== 'function')
    {
        return undefined;
    }

    try
    {
        const response = await fetch(runtimeUrl, { credentials: 'same-origin' });
        if (!response.ok)
        {
            return undefined;
        }

        return new Uint8Array(await response.arrayBuffer());
    }
    catch
    {
        return undefined;
    }
}

function normalizeSha256(value: string): string
{
    return value.replace(/^sha256:/u, '').toLowerCase();
}

function withIntegrityIdentity(moduleUrl: string, expectedSha256?: string): string
{
    if (!expectedSha256)
    {
        return moduleUrl;
    }
    const url = new URL(moduleUrl);
    url.searchParams.set('integrity', normalizeSha256(expectedSha256));
    return url.href;
}

function fileUrlToPath(fileUrl: string): string
{
    const url = new URL(fileUrl);
    return decodeURIComponent(url.pathname);
}

async function resolveRuntimeUrl(url: string): Promise<string>
{
    if (!url.startsWith('/'))
    {
        return url;
    }

    if (typeof window !== 'undefined' && window.location?.origin)
    {
        return new URL(url, window.location.origin).href;
    }

    if (typeof self !== 'undefined' && 'location' in self)
    {
        const location = (self as { location?: Location; }).location;
        if (location?.origin)
        {
            return new URL(url, location.origin).href;
        }
    }

    const nodeProcess = (globalThis as { process?: { cwd(): string; }; }).process;
    if (nodeProcess)
    {
        const fileName = url.split('/').filter(Boolean).pop();
        if (fileName)
        {
            const cwd = nodeProcess.cwd().replace(/\\/g, '/').replace(/\/+$/, '');
            return `file://${cwd}/public/wasm/${fileName}`;
        }
    }

    return url;
}
