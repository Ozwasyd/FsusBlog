import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalTestDeclarationProducer, canonicalTestDeclarationBindingFile, canonicalTestDeclarationModules, canonicalTestDeclarationReadOnlyInputs } from './canonical-test-declaration-inputs.mjs';


const { prepareLocalFsusUiTypecheckProject } = await import(
    new URL('../../src/frontend/scripts/run-local-fsusui-typecheck.mjs', import.meta.url)
);
const { resolveLocalFsusUiRepositoryRoot } = await import(
    new URL('../../src/frontend/scripts/fsusui-root.mjs', import.meta.url)
);

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const producer = canonicalTestDeclarationProducer;
const bindingFile = canonicalTestDeclarationBindingFile;
const modules = canonicalTestDeclarationModules;
const readOnlyInputs = canonicalTestDeclarationReadOnlyInputs;
const inputOwner = 'tools/frontend/canonical-test-declaration-inputs.mjs';

function digest(bytes)
{
    return createHash('sha256').update(bytes).digest('hex');
}

export function generateCanonicalTestDeclarations({ repositoryRoot = defaultRoot, typescript, localRoot, inMemoryConfiguration = false, onConfiguration, readProvenanceInput } = {})
{
    const root = path.resolve(repositoryRoot);
    const frontendRoot = path.join(root, 'src/frontend');
    const require = createRequire(path.join(frontendRoot, 'package.json'));
    const ts = typescript ?? require('typescript');
    const resolvedLocalRoot = localRoot ?? resolveLocalFsusUiRepositoryRoot({
        repositoryRoot: root,
        override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT
    });
    if (!resolvedLocalRoot)
    {
        throw new Error('canonical declarations require the real local FsusUI source');
    }
    let virtualConfiguration = null;
    const configuration = prepareLocalFsusUiTypecheckProject({
        repositoryRoot: root,
        localRoot: resolvedLocalRoot,
        fullTests: true,
        typescript: ts,
        ...(inMemoryConfiguration ? {
            configurationWriter: (file, content) =>
            {
                virtualConfiguration = { file, content };
                onConfiguration?.(file, content);
            }
        } : {})
    });
    if (inMemoryConfiguration && (virtualConfiguration?.file !== configuration
        || typeof virtualConfiguration.content !== 'string'))
    {
        throw new Error('original test-project configuration was not supplied by its source owner');
    }
    const original = ts.getParsedCommandLineOfConfigFile(configuration, {}, {
        ...ts.sys,
        ...(inMemoryConfiguration ? {
            readFile: file => file === configuration ? virtualConfiguration.content : ts.sys.readFile(file)
        } : {}),
        onUnRecoverableConfigFileDiagnostic(diagnostic)
        {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        }
    });
    if (!original || original.errors.length > 0)
    {
        throw new Error('original complete test configuration is invalid');
    }
    // This separate emit consumes the original resolver. It does not replace,
    // narrow or edit either complete no-emit typecheck program.
    const options = {
        ...original.options,
        allowJs: true,
        declaration: true,
        declarationMap: false,
        emitDeclarationOnly: true,
        noEmit: false,
        incremental: false,
        composite: false,
        rootDir: root,
        outDir: path.join(root, '.tmp/canonical-test-declarations')
    };
    const program = ts.createProgram(modules.map((file) => path.join(root, file)), options);
    const outputs = new Map();
    const diagnostics = [...program.getOptionsDiagnostics()];
    for (const file of modules)
    {
        const source = program.getSourceFile(path.join(root, file));
        if (!source)
        {
            throw new Error(`declaration source is missing: ${file}`);
        }
        diagnostics.push(...program.getSyntacticDiagnostics(source));
        const result = program.emit(source, (emittedFile, text) =>
        {
            const relative = path.relative(options.outDir, emittedFile).replaceAll(path.sep, '/');
            const expected = file.replace(/\.mjs$/u, '.d.mts');
            if (relative !== expected || outputs.has(relative))
            {
                throw new Error(`unexpected declaration output: ${relative}`);
            }
            const declaration = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
            const visit = (node) =>
            {
                if (node.kind === ts.SyntaxKind.AnyKeyword)
                {
                    throw new Error(`implicit or explicit any escaped from ${file}`);
                }
                ts.forEachChild(node, visit);
            };
            visit(declaration);
            const header = `// Generated by ${producer}; TypeScript ${ts.version}.\n// Source: ${file}. Run with --write; do not edit this declaration.\n`;
            const shebangEnd = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
            const content = `${text.slice(0, shebangEnd)}${header}${text.slice(shebangEnd)}`;
            const parsed = ts.createSourceFile(relative, content, ts.ScriptTarget.Latest, true);
            if (parsed.parseDiagnostics.length > 0)
            {
                throw new Error(`invalid generated declaration syntax: ${relative}`);
            }
            outputs.set(relative, content);
        });
        diagnostics.push(...result.diagnostics);
        if (result.emitSkipped)
        {
            throw new Error(`declaration emit skipped: ${file}`);
        }
    }
    if (diagnostics.length > 0)
    {
        throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
            getCanonicalFileName: (file) => file,
            getCurrentDirectory: () => root,
            getNewLine: () => '\n'
        }));
    }
    if (outputs.size !== modules.length)
    {
        throw new Error('incomplete canonical declaration output roster');
    }
    // Check the emitted API itself even when the original consuming project
    // skips library checking. Other files keep their original program options.
    const declarations = new Map([...outputs].map(([file, text]) => [path.join(root, file), text]));
    const declarationOptions = { ...original.options, skipLibCheck: false };
    const host = ts.createCompilerHost(declarationOptions);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.readFile = (file) => declarations.get(file) ?? readFile(file);
    host.fileExists = (file) => declarations.has(file) || fileExists(file);
    const declarationProgram = ts.createProgram(
        [...original.fileNames, ...declarations.keys()],
        declarationOptions,
        host
    );
    const declarationDiagnostics = [];
    for (const file of declarations.keys())
    {
        const source = declarationProgram.getSourceFile(file);
        declarationDiagnostics.push(
            ...declarationProgram.getSyntacticDiagnostics(source),
            ...declarationProgram.getSemanticDiagnostics(source)
        );
    }
    if (declarationDiagnostics.length > 0)
    {
        throw new Error(ts.formatDiagnosticsWithColorAndContext(declarationDiagnostics, {
            getCanonicalFileName: (file) => file,
            getCurrentDirectory: () => root,
            getNewLine: () => '\n'
        }));
    }
    const binding = {
        schema: 'fsusblog.generated-output-binding.v1',
        command: `node ${producer} --write`,
        compilerVersion: ts.version,
        sources: [producer, inputOwner, ...modules],
        sourceProvenance: [producer, inputOwner, ...modules, ...readOnlyInputs].map((file) => ({
            path: file,
            sha256: digest(readProvenanceInput ? readProvenanceInput(file) : readFileSync(path.join(root, file)))
        })),
        outputs: [...outputs].map(([file, text]) => ({ path: file, sha256: digest(text) }))
    };
    outputs.set(bindingFile, `${JSON.stringify(binding, null, 4)}\n`);
    return outputs;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
{
    const root = defaultRoot;
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--write', '--check'].includes(args[0]))
    {
        throw new Error(`usage: node ${producer} --write | --check`);
    }
    const outputs = generateCanonicalTestDeclarations();
    const drift = [];
    for (const [file, text] of outputs)
    {
        const absolute = path.join(root, file);
        if (args[0] === '--write')
        {
            writeFileSync(absolute, text);
        }
        else if (!existsSync(absolute) || readFileSync(absolute, 'utf8') !== text)
        {
            drift.push(file);
        }
    }
    if (drift.length > 0)
    {
        throw new Error(`canonical declaration drift:\n${drift.join('\n')}`);
    }
    console.log(`[canonical-test-declarations] ok mode=${args[0]} modules=${modules.length} outputs=${outputs.size - 1}`);
}
