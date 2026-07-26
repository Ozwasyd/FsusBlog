#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { parseMatrix } from './parse-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const matrixFile = path.join(root, 'tests/matrix.yml')
const contractFile = path.join(root, 'tests/fixtures/test-matrix/execution-dependency-contract.json')

function digest(value) {
    return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0
}

function commandDependencyGraph(commandGroups) {
    const flatten = (groupId, commands) => commands.flatMap((command) => [
        { groupId, id: command.id, dependsOn: command.dependsOn ?? [] },
        ...flatten(groupId, command.localCommands ?? [])
    ])
    return Object.entries(commandGroups)
        .flatMap(([groupId, group]) => flatten(groupId, group.commands ?? []))
        .sort((left, right) => compareText(`${left.groupId}/${left.id}`, `${right.groupId}/${right.id}`))
}

export function buildExecutionDependencyContract(matrix) {
    const tierGraph = matrix.tiers
        .map((tier) => ({ id: tier.id, executionDependsOn: tier.executionDependsOn }))
        .sort((left, right) => compareText(left.id, right.id))
    const commandGraph = commandDependencyGraph(matrix.commandGroups)
    return {
        schema: 'fsusblog.test-matrix-execution-dependency-contract.v1',
        source: 'tests/matrix.yml',
        producer: 'node tools/test-matrix/execution-dependency-contract.mjs --write',
        tierCount: tierGraph.length,
        executionEdgeCount: tierGraph.reduce((count, tier) => count + tier.executionDependsOn.length, 0),
        tierGraphDigest: digest(tierGraph),
        commandCount: commandGraph.length,
        commandEdgeCount: commandGraph.reduce((count, command) => count + command.dependsOn.length, 0),
        commandGroupGraphDigest: digest(commandGraph)
    }
}

export function serializeExecutionDependencyContract(contract) {
    return `${JSON.stringify(contract, null, 4)}\n`
}

function main() {
    const mode = process.argv[2] ?? '--check'
    if (!['--check', '--write'].includes(mode) || process.argv.length > 3) {
        throw new Error('usage: node tools/test-matrix/execution-dependency-contract.mjs [--check|--write]')
    }
    const matrix = parseMatrix(fs.readFileSync(matrixFile, 'utf8'))
    const expected = serializeExecutionDependencyContract(buildExecutionDependencyContract(matrix))
    if (mode === '--write') {
        fs.mkdirSync(path.dirname(contractFile), { recursive: true })
        fs.writeFileSync(contractFile, expected)
        console.log(
            '[execution-dependency-contract] wrote tests/fixtures/test-matrix/execution-dependency-contract.json'
        )
        return
    }
    if (!fs.existsSync(contractFile) || fs.readFileSync(contractFile, 'utf8') !== expected) {
        throw new Error(
            'execution dependency contract is stale; '
            + 'run node tools/test-matrix/execution-dependency-contract.mjs --write'
        )
    }
    console.log('[execution-dependency-contract] ok')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main()
}
