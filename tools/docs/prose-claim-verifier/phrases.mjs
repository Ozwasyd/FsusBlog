/**
 * Unique controlled phrase registry for boolean / failure / relation semantics.
 * Display copy may be Chinese or English; phrase IDs and templates are owned here only.
 * No document-local phrase registries and no free-form synonym expansion.
 */

/** Normalize for token search: NFC, collapse whitespace, lowercase Latin. */
export function normalizeBody(text)
{
    return String(text ?? '')
        .normalize('NFC')
        .replace(/\s+/gu, ' ')
        .trim()
}

/**
 * Token presence with light Chinese/English safeguards:
 * - Latin uses case-insensitive substring match with optional word edges for short tokens
 * - Chinese negation prefixes (不/未/非/无) immediately before a token do not count as a positive hit
 */
export function bodyIncludesToken(body, token)
{
    if (!token) return false
    const haystack = normalizeBody(body)
    const needle = normalizeBody(token)
    if (!needle) return false
    const lowerHay = haystack.toLowerCase()
    const lowerNeedle = needle.toLowerCase()
    let from = 0
    while (from <= lowerHay.length)
    {
        const index = lowerHay.indexOf(lowerNeedle, from)
        if (index < 0) return false
        const before = haystack.slice(Math.max(0, index - 2), index)
        // Reject positive hit when immediately preceded by Chinese negation.
        if (/(?:不|未|非|无)$/u.test(before) || /不会$/u.test(haystack.slice(Math.max(0, index - 2), index)))
        {
            from = index + lowerNeedle.length
            continue
        }
        // Reject when negation char precedes with connector/space gap (e.g. "不是 optional").
        const beforeExtended = haystack.slice(Math.max(0, index - 4), index)
        if (/(?:不|未|非|无)[是为会]?\s*$/u.test(beforeExtended))
        {
            from = index + lowerNeedle.length
            continue
        }
        // Also reject when the match is the tail of a longer negative phrase token site.
        const windowStart = Math.max(0, index - 4)
        const window = haystack.slice(windowStart, index + lowerNeedle.length)
        if (new RegExp(`不会${escapeRegExp(needle)}`, 'u').test(window)
            || new RegExp(`不${escapeRegExp(needle)}`, 'u').test(window))
        {
            from = index + lowerNeedle.length
            continue
        }
        return true
    }
    return false
}

function escapeRegExp(value)
{
    return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Semantic phrase packs. Keys are stable IDs; values are required-any / forbidden tokens.
 */
export const PhraseRegistry = Object.freeze({
    'boolean.true': Object.freeze({
        anyOf: Object.freeze(['true', '是', '会', '启用', '开启', '允许', 'extends', 'affirmed']),
        forbiddenWhenTrue: Object.freeze(['false', '不会', '永不', '禁止', '关闭', '禁用', 'does not', 'doesnot', 'negated'])
    }),
    'boolean.false': Object.freeze({
        anyOf: Object.freeze(['false', '不会', '不', '否', '关闭', '禁用', '禁止', 'does not', 'doesnot', 'negated', 'never']),
        forbiddenWhenFalse: Object.freeze(['true', '会延长', '启用', '开启', '允许', 'affirmed'])
    }),
    'boolean.extends.true': Object.freeze({
        anyOf: Object.freeze(['会延长', 'extends', 'extend']),
        forbidden: Object.freeze(['不会延长', '不延长', 'does not extend', 'does not prolong', 'never extends'])
    }),
    'boolean.extends.false': Object.freeze({
        anyOf: Object.freeze(['不会延长', '不延长', 'does not extend', 'does not prolong', 'never extends']),
        forbidden: Object.freeze(['会延长', 'extends the', 'extend the'])
    }),
    'failure.fail-closed': Object.freeze({
        anyOf: Object.freeze(['fail closed', 'fail-closed', 'failclosed', '失败关闭', '失败即拒绝', '关闭失败']),
        forbidden: Object.freeze(['fail open', 'fail-open', 'failopen', '失败时继续', '失败继续', '失败放行'])
    }),
    'failure.fail-open': Object.freeze({
        anyOf: Object.freeze(['fail open', 'fail-open', 'failopen', '失败时继续', '失败继续', '失败放行']),
        forbidden: Object.freeze(['fail closed', 'fail-closed', 'failclosed', '失败关闭', '失败即拒绝'])
    }),
    'policy.required': Object.freeze({
        anyOf: Object.freeze(['required', '必须', '必需']),
        forbidden: Object.freeze(['optional', '可选', '非必须'])
    }),
    'policy.optional': Object.freeze({
        anyOf: Object.freeze(['optional', '可选']),
        forbidden: Object.freeze(['required', '必须', '必需'])
    }),
    'predicate.revokes': Object.freeze({
        anyOf: Object.freeze(['撤销', 'revokes', 'revoke']),
        reverseHint: Object.freeze(['被撤销', 'revoked by'])
    }),
    'predicate.preserves': Object.freeze({
        anyOf: Object.freeze(['保留', '保持', 'preserves', 'preserve']),
        reverseHint: Object.freeze([])
    }),
    'predicate.implies': Object.freeze({
        anyOf: Object.freeze(['意味着', '蕴含', 'implies', 'implies that', '则', 'then']),
        reverseHint: Object.freeze([])
    }),
    'scope.revokes-only': Object.freeze({
        anyOf: Object.freeze(['只撤销', '仅撤销', 'only revokes', 'revokes only']),
        forbidden: Object.freeze(['撤销所有', 'revokes all', '全局撤销'])
    }),
    'bound.maximum': Object.freeze({
        anyOf: Object.freeze(['最大', '最多', '上限', 'maximum', 'max', 'at most', 'no more than']),
        forbidden: Object.freeze([])
    }),
    'bound.minimum': Object.freeze({
        anyOf: Object.freeze(['最小', '最少', '下限', 'minimum', 'min', 'at least', 'no fewer than']),
        forbidden: Object.freeze([])
    }),
    'bound.default': Object.freeze({
        anyOf: Object.freeze(['默认', '缺省', 'default']),
        forbidden: Object.freeze([])
    }),
    'inclusivity.inclusive': Object.freeze({
        anyOf: Object.freeze(['含', 'inclusive', 'included', '闭区间']),
        forbidden: Object.freeze(['不含', 'exclusive', '开区间'])
    }),
    'inclusivity.exclusive': Object.freeze({
        anyOf: Object.freeze(['不含', 'exclusive', '开区间']),
        forbidden: Object.freeze(['含端点', 'inclusive', '闭区间'])
    })
})

export function getPhrasePack(phraseId)
{
    if (!Object.hasOwn(PhraseRegistry, phraseId))
    {
        return null
    }
    return PhraseRegistry[phraseId]
}

/** Unit display tokens fixed by renderer policy — never converted by the parser. */
export const UnitTokenRegistry = Object.freeze({
    minutes: Object.freeze({ tokens: Object.freeze(['分钟', 'minutes', 'minute']), dimension: 'duration-minutes' }),
    minute: Object.freeze({ tokens: Object.freeze(['分钟', 'minutes', 'minute']), dimension: 'duration-minutes' }),
    seconds: Object.freeze({ tokens: Object.freeze(['秒', '秒钟', 'seconds', 'second']), dimension: 'duration-seconds' }),
    second: Object.freeze({ tokens: Object.freeze(['秒', '秒钟', 'seconds', 'second']), dimension: 'duration-seconds' }),
    hours: Object.freeze({ tokens: Object.freeze(['小时', 'hours', 'hour']), dimension: 'duration-hours' }),
    hour: Object.freeze({ tokens: Object.freeze(['小时', 'hours', 'hour']), dimension: 'duration-hours' }),
    days: Object.freeze({ tokens: Object.freeze(['天', 'days', 'day']), dimension: 'duration-days' }),
    day: Object.freeze({ tokens: Object.freeze(['天', 'days', 'day']), dimension: 'duration-days' }),
    ms: Object.freeze({ tokens: Object.freeze(['毫秒', 'ms', 'milliseconds', 'millisecond']), dimension: 'duration-ms' }),
    bytes: Object.freeze({ tokens: Object.freeze(['字节', 'bytes', 'byte']), dimension: 'size-bytes' }),
    byte: Object.freeze({ tokens: Object.freeze(['字节', 'bytes', 'byte']), dimension: 'size-bytes' }),
    layers: Object.freeze({ tokens: Object.freeze(['层', 'layers', 'layer']), dimension: 'count-layers' }),
    layer: Object.freeze({ tokens: Object.freeze(['层', 'layers', 'layer']), dimension: 'count-layers' }),
    count: Object.freeze({ tokens: Object.freeze(['次', '个', '项', 'count', 'counts']), dimension: 'count-generic' })
})

export function unitTokens(unit)
{
    const key = String(unit ?? '').toLowerCase()
    if (Object.hasOwn(UnitTokenRegistry, key))
    {
        return UnitTokenRegistry[key]
    }
    // Unknown unit: require exact unit string only; dimension is unit-specific.
    return {
        tokens: Object.freeze([String(unit)]),
        dimension: `unit:${key}`
    }
}
