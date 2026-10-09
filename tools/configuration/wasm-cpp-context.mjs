import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const within = (root, file) => file.startsWith(`${root}${path.sep}`);

function observe(file)
{
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file)
    {
        throw new Error(`Wasm context requires a regular physical input: ${file}`);
    }
    return { path: file, digest: digest(fs.readFileSync(file)) };
}

// Read the original CMake producer's File API, never a synthesized TU or argv.
export function inspectWasmBuildContext(root, directory, cache, bind)
{
    const home = path.join(root, 'src/frontend/wasm');
    const variant = path.basename(directory);
    if (!['build-basic', 'build-simd'].includes(variant) || path.dirname(directory) !== home
        || !cache.includes(`CMAKE_HOME_DIRECTORY:INTERNAL=${home}\n`)
        || !cache.includes('CMAKE_PROJECT_NAME:STATIC=FsusBlogWasm\n')
        || !cache.includes('CMAKE_BUILD_TYPE:STRING=Release\n')
        || !cache.includes('FSUSBLOG_WASM_IMAGE_CODEC_ENABLE:BOOL=OFF\n')
        || !/^CMAKE_EXPORT_COMPILE_COMMANDS:(?:BOOL|UNINITIALIZED)=ON$/mu.test(cache)
        || !cache.includes(`WASM_SIMD:BOOL=${variant === 'build-basic' ? 'OFF' : 'ON'}\n`))
    {
        throw new Error('unsupported Wasm CMake project/variant context');
    }
    const reply = path.join(directory, '.cmake/api/v1/reply');
    const indices = fs.readdirSync(reply).filter(file => /^index-[A-Za-z0-9_-]+\.json$/u.test(file));
    if (indices.length !== 1)
    {
        throw new Error('Wasm CMake File API requires exactly one current index');
    }
    const records = [];
    const read = name =>
    {
        if (!/^[A-Za-z0-9_.-]+\.json$/u.test(name))
        {
            throw new Error('unsupported Wasm CMake reply path');
        }
        const file = path.join(reply, name);
        records.push(observe(file));
        return JSON.parse(fs.readFileSync(file));
    };
    const index = read(indices[0]);
    const object = (kind, major) =>
    {
        const matches = index.objects?.filter(value => value.kind === kind && value.version?.major === major);
        if (matches?.length !== 1)
        {
            throw new Error(`Wasm CMake File API missing exact ${kind} contract`);
        }
        return read(matches[0].jsonFile);
    };
    const cmakeFiles = object('cmakeFiles', 1);
    const toolchains = object('toolchains', 1);
    const model = object('codemodel', 2);
    for (const value of [cmakeFiles, model])
    {
        if (value.paths?.source !== home || value.paths?.build !== directory)
        {
            throw new Error('Wasm File API differs from its actual project/home');
        }
    }
    const chains = toolchains.toolchains?.filter(value => value.language === 'CXX');
    const compiler = chains?.[0]?.compiler;
    if (chains?.length !== 1 || compiler?.id !== 'Clang' || !/^\d+\.\d+\.\d+$/u.test(compiler.version)
        || path.basename(compiler.path ?? '') !== 'em++' || !path.isAbsolute(compiler.path))
    {
        throw new Error('Wasm context requires its actual Emscripten/Clang compiler');
    }
    const sdk = path.dirname(compiler.path);
    const toolchain = path.join(sdk, 'cmake/Modules/Platform/Emscripten.cmake');
    if (!cache.includes(`CMAKE_TOOLCHAIN_FILE:FILEPATH=${toolchain}\n`))
    {
        throw new Error('Wasm CMake toolchain differs from its compiler');
    }
    const cmakeRoot = index.cmake?.paths?.root;
    if (!path.isAbsolute(cmakeRoot ?? ''))
    {
        throw new Error('Wasm CMake installation identity missing');
    }
    const configuration = model.configurations;
    if (configuration?.length !== 1 || configuration[0].projects?.[0]?.name !== 'FsusBlogWasm')
    {
        throw new Error('unsupported Wasm CMake configuration');
    }
    const buildInputs = [bind(root, 'src/frontend/wasm/build.sh')];
    const externalInputs = [];
    for (const input of cmakeFiles.inputs ?? [])
    {
        const absolute = path.resolve(home, input.path);
        if (input.isGenerated)
        {
            if (!within(directory, absolute))
            {
                throw new Error('Wasm generated CMake input escapes the actual build');
            }
            records.push(observe(absolute));
        }
        else if (input.isExternal)
        {
            if (!within(sdk, absolute) && !within(cmakeRoot, absolute))
            {
                throw new Error('unsupported external Wasm CMake input');
            }
            externalInputs.push(observe(absolute));
        }
        else
        {
            if (!within(home, absolute))
            {
                throw new Error('Wasm CMake source input escapes the original project');
            }
            buildInputs.push(bind(root, path.relative(root, absolute).split(path.sep).join('/')));
        }
    }
    for (const item of configuration[0].directories ?? [])
    {
        const file = path.relative(root, path.resolve(home, item.source, 'CMakeLists.txt')).split(path.sep).join('/');
        if (!buildInputs.some(input => input.file === file))
        {
            throw new Error(`Wasm CMake input closure omits ${file}`);
        }
    }
    if (!externalInputs.some(input => input.path === toolchain))
    {
        throw new Error('Wasm CMake input closure omits its Emscripten toolchain');
    }
    const targets = configuration[0].targets.map(target => read(target.jsonFile));
    const expected = targets.flatMap(target => (target.sources ?? []).filter(source => source.compileGroupIndex !== undefined).map(source =>
    {
        const group = target.compileGroups[source.compileGroupIndex];
        if (group.language !== 'CXX' || group.languageStandard?.standard !== '23')
        {
            throw new Error('Wasm source context requires C++23 compile groups');
        }
        const file = path.resolve(home, source.path);
        const output = path.join(directory, target.paths.build, 'CMakeFiles', `${target.name}.dir`,
            `${path.relative(path.resolve(home, target.paths.source), file)}.o`);
        const flags = [...(group.defines ?? []).map(value => `-D${value.define}`),
            ...(group.includes ?? []).map(value =>
            {
                if (value.isSystem)
                {
                    throw new Error('unsupported explicit Wasm system include override');
                }
                return `-I${value.path}`;
            }), ...(group.compileCommandFragments ?? []).flatMap(value => value.fragment.split(/ +/u))];
        return { file, output, flags };
    }));
    if (!expected.length || expected.length > 64)
    {
        throw new Error('unsupported or empty Wasm CMake source roster');
    }
    if (!['Ninja', 'Unix Makefiles'].includes(index.cmake?.generator?.name))
    {
        throw new Error('unsupported Wasm CMake generator');
    }
    return { compiler, sdk, home, directory, variant, cmakeRoot, records, buildInputs, externalInputs, expected,
        inputPaths: [...new Set(cmakeFiles.inputs.filter(input => !input.isGenerated)
            .map(input => path.resolve(home, input.path)))].sort(), generator: index.cmake.generator.name,
        cmake: { ...observe(index.cmake.paths.cmake), version: index.cmake.version.string } };
}

export function replayWasmBuildContext(context, entries, run, bind, root)
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-wasm-context-'));
    try
    {
        const version = run(context.cmake.path, ['--version'], temporary);
        if (!version.stdout.startsWith(`cmake version ${context.cmake.version}\n`))
        {
            throw new Error('actual CMake version differs from the original Wasm context');
        }
        const query = path.join(temporary, '.cmake/api/v1/query');
        fs.mkdirSync(query, { recursive: true });
        fs.writeFileSync(path.join(query, 'cmakeFiles-v1'), '');
        const emcmake = observe(path.join(context.sdk, 'emcmake'));
        const emcmakeModule = observe(path.join(context.sdk, 'emcmake.py'));
        const configuration = run(emcmake.path, [context.cmake.path, '-S', context.home, '-B', temporary,
            '-G', context.generator, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_EXPORT_COMPILE_COMMANDS:BOOL=ON',
            `-DWASM_SIMD:BOOL=${context.variant === 'build-basic' ? 'OFF' : 'ON'}`,
            '-DFSUSBLOG_WASM_IMAGE_CODEC_ENABLE:BOOL=OFF', `-DFSUSBLOG_WASM_OUTPUT_DIR=${temporary}/output`], temporary);
        const actualBytes = fs.readFileSync(path.join(temporary, 'compile_commands.json'));
        const actual = JSON.parse(actualBytes);
        const signature = (entry, directory) =>
        {
            const argv = entry.arguments ?? entry.command.trim().split(/ +/u);
            return JSON.stringify(argv.map((value, index) => argv[index - 1] === '-o'
                ? path.relative(directory, path.resolve(directory, value)) : value));
        };
        if (JSON.stringify(entries.map(entry => signature(entry, context.directory)).sort())
            !== JSON.stringify(actual.map(entry => signature(entry, temporary)).sort()))
        {
            throw new Error('Wasm original CMake replay differs from the current complete compiler argv roster');
        }
        const reply = path.join(temporary, '.cmake/api/v1/reply');
        const indices = fs.readdirSync(reply).filter(file => /^index-[A-Za-z0-9_-]+\.json$/u.test(file));
        if (indices.length !== 1)
        {
            throw new Error('Wasm replay requires exactly one actual CMake index');
        }
        const index = JSON.parse(fs.readFileSync(path.join(reply, indices[0])));
        const objects = index.objects.filter(value => value.kind === 'cmakeFiles' && value.version.major === 1);
        if (objects.length !== 1 || !/^[A-Za-z0-9_.-]+\.json$/u.test(objects[0].jsonFile))
        {
            throw new Error('Wasm replay lacks its actual CMake input closure');
        }
        const inputBytes = fs.readFileSync(path.join(reply, objects[0].jsonFile));
        const inputs = JSON.parse(inputBytes).inputs;
        const paths = [...new Set(inputs.filter(input => !input.isGenerated)
            .map(input => path.resolve(context.home, input.path)))].sort();
        if (JSON.stringify(paths) !== JSON.stringify(context.inputPaths)
            || context.buildInputs.some(input => bind(root, input.file).digest !== input.digest)
            || context.externalInputs.some(input => observe(input.path).digest !== input.digest))
        {
            throw new Error('Wasm original CMake replay input closure differs from the bound context');
        }
        return { emcmake, emcmakeModule, version, configuration, databaseDigest: digest(actualBytes),
            cmakeInputDigest: digest(inputBytes), sourceBindings: context.buildInputs, qualificationEligible: false };
    }
    finally
    {
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}

export function observeWasmCompiler(context, run, commandPath)
{
    for (const name of ['EMCC_CFLAGS', 'EMMAKEN_CFLAGS', 'EM_COMPILER_WRAPPER', '_EMCC_CCACHE',
        'EM_LLVM_ROOT', 'EM_BINARYEN_ROOT', 'EMCC_FORCE_STDLIBS', 'CFLAGS', 'CXXFLAGS',
        'CPPFLAGS', 'LDFLAGS', 'CC', 'CXX'])
    {
        if (process.env[name])
        {
            throw new Error(`unsupported implicit Wasm compiler context: ${name}`);
        }
    }
    const compiler = context.compiler.path;
    const selected = commandPath('em++');
    if (!selected || fs.realpathSync(selected) !== compiler)
    {
        throw new Error('Wasm compiler differs from the actual installed tool selection');
    }
    const config = process.env.EM_CONFIG ?? path.resolve(context.sdk, '../../.emscripten');
    if (!within(path.resolve(context.sdk, '../..'), config))
    {
        throw new Error('unsupported external Wasm SDK configuration');
    }
    const configBinding = observe(config);
    const python = process.env.EMSDK_PYTHON ?? commandPath('python3');
    if (!python || !fs.existsSync(python))
    {
        throw new Error('Wasm Python interpreter unavailable');
    }
    const pythonBinding = observe(fs.realpathSync(python));
    const wrapper = observe(compiler);
    const version = run(compiler, ['--version'], context.sdk);
    if (!version.stdout.includes('Emscripten'))
    {
        throw new Error('actual Wasm compiler identity is not Emscripten');
    }
    const cflags = run(compiler, ['--cflags'], context.sdk);
    const args = cflags.stdout.trim().split(/ +/u);
    const sysroots = args.filter(value => value.startsWith('--sysroot=')).map(value => value.slice(10));
    if (args[args.indexOf('-target') + 1] !== 'wasm32-unknown-emscripten' || sysroots.length !== 1
        || !path.isAbsolute(sysroots[0]) || !fs.statSync(sysroots[0]).isDirectory()
        || !context.compiler.implicit?.includeDirectories?.length
        || context.compiler.implicit.includeDirectories.some(file => !within(sysroots[0], file) || !fs.statSync(file).isDirectory()))
    {
        throw new Error('actual Wasm target/sysroot differs from the CMake compiler context');
    }
    const search = run(compiler, ['--print-search-dirs'], context.sdk);
    const programs = search.stdout.match(/^programs: =(.+)$/mu)?.[1];
    if (!programs || path.resolve(programs) !== path.resolve(context.sdk, '../bin'))
    {
        throw new Error('unsupported actual Wasm Clang installation');
    }
    const clang = fs.realpathSync(path.join(programs, 'clang++'));
    const clangBinding = observe(clang);
    const clangVersion = run(clang, ['--version'], context.sdk);
    if (!clangVersion.stdout.includes(`clang version ${context.compiler.version}`))
    {
        throw new Error('actual Clang version differs from CMake');
    }
    const resource = run(clang, ['-print-resource-dir'], context.sdk).stdout.trim();
    if (!within(path.resolve(context.sdk, '..'), resource) || !fs.statSync(resource).isDirectory())
    {
        throw new Error('unsupported actual Clang resource directory');
    }
    const sdkInputs = [observe(path.join(context.sdk, 'em++.py')), observe(path.join(context.sdk, 'emcc.py'))];
    for (const entry of fs.readdirSync(path.join(context.sdk, 'tools'), { recursive: true, withFileTypes: true }))
    {
        if (entry.isSymbolicLink())
        {
            throw new Error('unsupported linked Wasm SDK source input');
        }
        if (entry.isFile() && entry.name.endsWith('.py'))
        {
            sdkInputs.push(observe(path.join(entry.parentPath, entry.name)));
        }
    }
    return { wrapper, version, cflags, search, clang: clangBinding, clangVersion,
        sysroot: sysroots[0], resource, sdkInputs, config: configBinding,
        python: pythonBinding, qualificationEligible: false };
}
