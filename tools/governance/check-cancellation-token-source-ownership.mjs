import fs from 'node:fs'
import path from 'node:path'

const forbidden = [
    { pattern: /new\s+CancellationTokenSource\s*\((?:(?!;).)*?\)\s*\.Token/su, message: 'CTS timeout token discards its owner' },
    { pattern: /CancellationTokenSource\.CreateLinkedTokenSource\s*\((?:(?!;).)*?\)\s*\.Token/su, message: 'linked CTS token discards its owner' },
    { pattern: /static\s+[^;=]+CancellationToken\s+\w+\s*=\s*new\s+CancellationTokenSource/u, message: 'static delayed CTS cleanup is forbidden' },
    { pattern: /static\s+[^;=\n]*(?:List|ConcurrentBag|ConcurrentQueue)\s*<\s*CancellationTokenSource\s*>/u, message: 'static delayed CTS owner collection is forbidden' }
]

export function validateCancellationTokenSourceOwnership(source, file = '<source>') {
    return forbidden.flatMap(({ pattern, message }) => pattern.test(source) ? [`${file}: ${message}`] : [])
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const root = path.resolve(process.argv[2] ?? 'src')
    const files = []
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name)
            if (entry.isDirectory()) visit(target)
            else if (entry.isFile() && target.endsWith('.cs')) files.push(target)
        }
    }
    visit(root)
    const failures = files.flatMap((file) => validateCancellationTokenSourceOwnership(fs.readFileSync(file, 'utf8'), file))
    if (failures.length) throw new Error(failures.join('\n'))
}
