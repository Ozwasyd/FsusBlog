import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const repoRoot = resolve(process.cwd(), '..', '..')

async function read(relativePath) {
  return await readFile(resolve(repoRoot, relativePath), 'utf8')
}

function assertIncludes(haystack, needle, message) {
  if (!haystack.includes(needle)) {
    throw new Error(message)
  }
}

const directoryBuildProps = await read('Directory.Build.props')
assertIncludes(directoryBuildProps, '<LangVersion>14.0</LangVersion>', 'C# LangVersion 14.0 is not locked in Directory.Build.props')
assertIncludes(directoryBuildProps, '<Nullable>enable</Nullable>', 'C# Nullable must stay enabled in Directory.Build.props')
assertIncludes(directoryBuildProps, '<AnalysisLevel>latest</AnalysisLevel>', 'C# AnalysisLevel latest must stay enabled in Directory.Build.props')

const powCmake = await read('src/frontend/wasm/pow/CMakeLists.txt')
assertIncludes(powCmake, 'set(CMAKE_CXX_STANDARD 23)', 'pow wasm target must use C++23')
assertIncludes(powCmake, '"-fno-exceptions"', 'pow wasm target must disable exceptions')

console.log('ok: modern language standards are locked')
