import { createHash } from 'node:crypto';

const schema = 'fsusblog.execution-failure-diagnostic.v1';
const maximumMessageBytes = 1024;
const maximumCauses = 4;
const diagnostics = new WeakMap();
const failureOwners = new WeakMap();
const sensitiveNamePattern = /(?:AUTH|COOKIE|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/iu;

function diagnosticControl(character)
{
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
}

function sensitiveMessage(value)
{
    return sensitiveNamePattern.test(value) || /\bBearer\s+\S+/iu.test(value)
        || /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/]*@/u.test(value);
}

function dataProperty(value, name)
{
    try
    {
        let current = value;
        for (let depth = 0; current != null && depth < 4; depth += 1)
        {
            const descriptor = Object.getOwnPropertyDescriptor(current, name);
            if (descriptor)
            {
                return Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
            }
            current = Object.getPrototypeOf(current);
        }
    }
    catch
    {
        // Diagnostic inspection never invokes accessors or changes the failure.
    }
    return undefined;
}

function identifier(value, fallback = null)
{
    return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value)
        ? value : fallback;
}

function errorRecord(error)
{
    const raw = dataProperty(error, 'message');
    const text = typeof raw === 'string' ? raw
        : typeof error === 'string' ? error : 'execution failed without a string diagnostic';
    // The physical owner already records the command separately. Do not copy
    // its opaque argv into a cause record or CLI diagnostic.
    const withoutCommand = text.replace(/^(command failed \((?:exit|signal) [^\n)]*\)):[\s\S]*$/u, '$1');
    const bytes = Buffer.from(withoutCommand);
    let bounded = bytes.subarray(0, maximumMessageBytes).toString('utf8');
    while (Buffer.byteLength(bounded) > maximumMessageBytes)
    {
        bounded = bounded.slice(0, -1);
    }
    const redacted = sensitiveMessage(bounded);
    const exitCode = dataProperty(error, 'exitCode');
    return Object.freeze({
        name: identifier(dataProperty(error, 'name'), 'Error'),
        message: redacted ? '[redacted sensitive diagnostic]'
            : bounded.replace(/[\s\S]/gu, (character) => diagnosticControl(character) ? ' ' : character),
        messageDigest: createHash('sha256').update(bytes.subarray(0, maximumMessageBytes)).digest('hex'),
        truncated: bytes.length > maximumMessageBytes,
        redacted,
        code: identifier(dataProperty(error, 'code')),
        exitCode: Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null,
        signal: identifier(dataProperty(error, 'signal'))
    });
}

function diagnostic(error, secondary = null, secondaryPresent = secondary !== null && secondary !== undefined)
{
    const causes = [];
    const seen = new Set([error]);
    let cause = dataProperty(error, 'cause');
    while (cause != null && causes.length < maximumCauses && !seen.has(cause))
    {
        seen.add(cause);
        causes.push(errorRecord(cause));
        cause = dataProperty(cause, 'cause');
    }
    return Object.freeze({
        schema,
        primary: errorRecord(error),
        secondary: !secondaryPresent ? null : errorRecord(secondary),
        causes: Object.freeze(causes),
        causesTruncated: cause != null
    });
}

function preserveDiagnostic(value, finalizationError, present = finalizationError !== null && finalizationError !== undefined)
{
    if (!present)
    {
        return value;
    }
    const refusal = errorRecord(finalizationError);
    if (value.secondary === null)
    {
        return Object.freeze({ ...value, secondary: refusal });
    }
    const serialized = JSON.stringify(refusal);
    if (JSON.stringify(value.secondary) === serialized
        || value.causes.some((cause) => JSON.stringify(cause) === serialized))
    {
        return value;
    }
    // Cached failures have sealed cause records, not reconstructed Error.cause.
    // Keep those records in order; a new refusal cannot evict an earlier cause.
    const room = value.causes.length < maximumCauses;
    return Object.freeze({
        ...value,
        causes: room ? Object.freeze([...value.causes, refusal]) : value.causes,
        causesTruncated: value.causesTruncated || !room
    });
}

/** Diagnostic compatibility only; never invoke an accessor or decide ownership from it. */
export function executionFailureDataProperty(value, name)
{
    return dataProperty(value, name);
}

export function retainExecutionFailureCompatibility(reason, name, value)
{
    if (reason === null || !['object', 'function'].includes(typeof reason)) return;
    try
    {
        const descriptor = Object.getOwnPropertyDescriptor(reason, name);
        if (!descriptor && Object.isExtensible(reason))
            Object.defineProperty(reason, name, { value, writable: true, configurable: true, enumerable: true });
    }
    catch { /* Compatibility is never an ownership or failure-presence test. */ }
}

/** Per invocation, ordinary non-wire observations. This does not issue execution authority. */
export function createExecutionFailureOwner()
{
    const owner = Object.freeze({});
    failureOwners.set(owner, { failed: false, reason: undefined, diagnostic: null,
        recoveryObligation: null, secondaryFailures: Object.freeze([]) });
    return owner;
}

function failureState(owner)
{
    const state = failureOwners.get(owner);
    if (!state) throw new Error('execution failure owner is foreign');
    return state;
}

export function observeExecutionFailure(owner)
{
    return Object.freeze({ ...failureState(owner) });
}

export function retainExecutionFailure(owner, reason)
{
    const state = failureState(owner);
    if (!state.failed)
    {
        state.failed = true;
        state.reason = reason;
        state.diagnostic = executionFailureDiagnostic(reason) ?? diagnostic(reason);
    }
    else if (state.reason !== reason)
    {
        state.diagnostic = preserveDiagnostic(state.diagnostic, reason, true);
        if (state.secondaryFailures.length < maximumCauses)
            state.secondaryFailures = Object.freeze([...state.secondaryFailures, reason]);
    }
    if (state.reason !== null && ['object', 'function'].includes(typeof state.reason))
        diagnostics.set(state.reason, state.diagnostic);
    return state.reason;
}


export function retainExecutionRecovery(owner, value)
{
    failureState(owner).recoveryObligation = Object.freeze({ ...value });
}

export function throwExecutionFailure(owner)
{
    const state = failureState(owner);
    if (state.failed) throw state.reason;
}

/** Select the earlier execution failure without waiving a postflight refusal. */
export function selectExecutionFailure({ executionError, finalizationError, physicalExecution,
    executionFailed = executionError !== null && executionError !== undefined,
    finalizationFailed = finalizationError !== null && finalizationError !== undefined })
{
    if (!executionFailed && !finalizationFailed) return null;
    const first = executionFailed ? executionError : finalizationError;
    if (!executionFailed) retainExecutionFailureCompatibility(first, 'physicalExecution', physicalExecution);
    if (first !== null && ['object', 'function'].includes(typeof first))
    {
        const previous = diagnostics.get(first);
        diagnostics.set(first, previous
            ? (executionFailed && finalizationFailed ? preserveDiagnostic(previous, finalizationError, true) : previous)
            : diagnostic(first, executionFailed && finalizationFailed ? finalizationError : null,
                executionFailed && finalizationFailed));
    }
    return first;
}

export function executionFailureDiagnostic(error)
{
    return error != null && typeof error === 'object' ? diagnostics.get(error) ?? null : null;
}

/** Restore only the closed, bounded diagnostic from a sealed failure receipt. */
export function restoreExecutionFailureDiagnostic(error, value)
{
    if (value == null)
    {
        return;
    }
    const keys = (item, expected) => item != null && typeof item === 'object'
        && Object.keys(item).sort().join('\0') === [...expected].sort().join('\0');
    const validRecord = (item) => keys(item, ['name', 'message', 'messageDigest', 'truncated', 'redacted', 'code', 'exitCode', 'signal'])
        && identifier(item.name) !== null && typeof item.message === 'string'
        && Buffer.byteLength(item.message) <= maximumMessageBytes
        && !Array.from(item.message).some(diagnosticControl)
        && (item.redacted ? item.message === '[redacted sensitive diagnostic]'
            : !sensitiveMessage(item.message))
        && /^[a-f0-9]{64}$/u.test(item.messageDigest)
        && typeof item.truncated === 'boolean' && typeof item.redacted === 'boolean'
        && (item.code === null || identifier(item.code) !== null)
        && (item.signal === null || identifier(item.signal) !== null)
        && (item.exitCode === null || (Number.isInteger(item.exitCode) && item.exitCode >= 0 && item.exitCode <= 255));
    if (!keys(value, ['schema', 'primary', 'secondary', 'causes', 'causesTruncated'])
        || value.schema !== schema || !validRecord(value.primary)
        || (value.secondary !== null && !validRecord(value.secondary))
        || !Array.isArray(value.causes) || value.causes.length > maximumCauses
        || !value.causes.every(validRecord) || typeof value.causesTruncated !== 'boolean')
    {
        throw new Error('run-bound failure diagnostic is invalid');
    }
    diagnostics.set(error, Object.freeze({
        ...value,
        primary: Object.freeze({ ...value.primary }),
        secondary: value.secondary === null ? null : Object.freeze({ ...value.secondary }),
        causes: Object.freeze(value.causes.map((cause) => Object.freeze({ ...cause })))
    }));
}

export function formatExecutionFailure(error, owner = null)
{
    const value = (owner === null ? null : observeExecutionFailure(owner).diagnostic)
        ?? executionFailureDiagnostic(error) ?? diagnostic(error);
    return `${value.primary.message}\n[execution-failure-diagnostic] ${JSON.stringify(value)}`;
}
