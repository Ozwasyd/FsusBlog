import { createHash } from 'node:crypto'

export const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function stable(value)
{
    if (Array.isArray(value))
    {
        return value.map(stable)
    }
    if (isPlainObject(value))
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    }
    return value
}

export const canonicalize = (value) => JSON.stringify(stable(value))

export const digestValue = (value) => createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')

export const digestText = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

export const digestBuffer = (buffer) => createHash('sha256').update(buffer).digest('hex')
