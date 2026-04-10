export type EmscriptenModuleFactory<TModule> = (options?: {
  locateFile?: (path: string) => string;
  print?: (message: string) => void;
  printErr?: (message: string) => void;
}) => Promise<TModule>;

type ModuleNamespace<TModule> = {
  default?: EmscriptenModuleFactory<TModule>;
  [key: string]: unknown;
};

export async function loadEmscriptenModule<TModule>(
  moduleUrl: string,
  exportName: string,
  wasmUrl: string,
  options?: {
    print?: (message: string) => void;
    printErr?: (message: string) => void;
  }
): Promise<TModule | null> {
  const resolvedModuleUrl = await resolveRuntimeUrl(moduleUrl);
  const resolvedWasmUrl = await resolveRuntimeUrl(wasmUrl);
  const moduleRef = await import(/* @vite-ignore */ resolvedModuleUrl) as ModuleNamespace<TModule>;
  const factory = (moduleRef.default ?? moduleRef[exportName]) as EmscriptenModuleFactory<TModule> | undefined;
  if (typeof factory !== 'function') {
    return null;
  }

  return await factory({
    locateFile: (path) => path.endsWith('.wasm') ? resolvedWasmUrl : path,
    print: options?.print,
    printErr: options?.printErr
  });
}

async function resolveRuntimeUrl(url: string): Promise<string> {
  if (!url.startsWith('/')) {
    return url;
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return new URL(url, window.location.origin).href;
  }

  if (typeof self !== 'undefined' && 'location' in self) {
    const location = (self as { location?: Location }).location;
    if (location?.origin) {
      return new URL(url, location.origin).href;
    }
  }

  const nodeProcess = (globalThis as { process?: { cwd(): string } }).process
  if (nodeProcess) {
    const fileName = url.split('/').filter(Boolean).pop()
    if (fileName) {
      const cwd = nodeProcess.cwd().replace(/\\/g, '/').replace(/\/+$/, '')
      return `file://${cwd}/public/wasm/${fileName}`
    }
  }

  return url;
}
