/**
 * Unique ProseRenderRegistry: FactObservation → verification plan for one claim body.
 * Renders only. Never imports business source, extractors, tests, or LLM clients.
 */

import {
    ProseClaimErrorCode,
    makeProseClaimError
} from './errors.mjs';
import {
    PhraseRegistry,
    getPhrasePack,
    unitTokens
} from './phrases.mjs';

/** claimTypes admitted for prose verification (generated-section handled elsewhere). */
export const proseSupportedClaimTypes = Object.freeze([
    'scalar',
    'boolean',
    'failure-mode',
    'binary-relation',
    'implication',
    'preservation-rule',
    'rationale'
]);

/** Large tabular/set types must use generated sections — never free prose fuzzy compare. */
export const proseRejectedClaimTypes = Object.freeze([
    'enum-set',
    'ordered-set',
    'map',
    'transition-set'
]);

export const allowedProseRenders = Object.freeze([
    'integer-minutes',
    'integer-bytes',
    'integer-layers',
    'integer-count',
    'integer-scalar',
    'boolean-affirmed',
    'boolean-negated',
    'boolean-extends',
    'failure-mode-code',
    'failure-policy',
    'relation-subject-predicate-object',
    'implication-if-then',
    'preserves-fields',
    'revokes-only-scope',
    'rationale-prose'
]);

const claimTypeToRenders = Object.freeze({
    scalar: Object.freeze([
        'integer-minutes',
        'integer-bytes',
        'integer-layers',
        'integer-count',
        'integer-scalar'
    ]),
    boolean: Object.freeze([
        'boolean-affirmed',
        'boolean-negated',
        'boolean-extends'
    ]),
    'failure-mode': Object.freeze([
        'failure-mode-code',
        'failure-policy'
    ]),
    'binary-relation': Object.freeze([
        'relation-subject-predicate-object'
    ]),
    implication: Object.freeze([
        'implication-if-then'
    ]),
    'preservation-rule': Object.freeze([
        'preserves-fields',
        'revokes-only-scope'
    ]),
    rationale: Object.freeze([
        'rationale-prose'
    ])
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function failShape(render, message, details = {})
{
    throw makeProseClaimError(
        ProseClaimErrorCode.RENDER_SHAPE,
        `${render}: ${message}`,
        { render, ...details }
    );
}

function assertRenderMatchesClaimType(claimType, render)
{
    const allowed = claimTypeToRenders[claimType];
    if (!allowed)
    {
        throw makeProseClaimError(
            ProseClaimErrorCode.UNSUPPORTED_CLAIM_TYPE,
            `claimType ${claimType} is not admitted for prose verification`,
            { claimType, render }
        );
    }
    if (!allowed.includes(render))
    {
        throw makeProseClaimError(
            ProseClaimErrorCode.CLAIM_TYPE_RENDER_MISMATCH,
            `render ${render} is not registered for claimType ${claimType}`,
            { claimType, render }
        );
    }
}

/**
 * Resolve projection against an observation value.
 * Supports dotted projection paths and role aliases (default/maximum/minimum).
 */
export function applyProjection(value, projection)
{
    if (projection == null || projection === '')
    {
        return value;
    }
    if (!isPlainObject(value))
    {
        return value;
    }
    if (Object.hasOwn(value, projection))
    {
        return value[projection];
    }
    const aliases = {
        default: ['default', 'defaultValue', 'defaultFreshnessMinutes'],
        maximum: ['maximum', 'max', 'maxValue'],
        minimum: ['minimum', 'min', 'minValue']
    };
    const candidates = aliases[projection] ?? [projection];
    for (const key of candidates)
    {
        if (Object.hasOwn(value, key))
        {
            return value[key];
        }
    }
    const parts = String(projection).split('.');
    let current = value;
    for (const part of parts)
    {
        if (!isPlainObject(current) || !Object.hasOwn(current, part))
        {
            return undefined;
        }
        current = current[part];
    }
    return current;
}

function asQuantity(value, defaultUnit, render)
{
    if (typeof value === 'number' && Number.isFinite(value))
    {
        if (!defaultUnit)
        {
            failShape(render, 'numeric observation requires unit from render policy or {value,unit}');
        }
        return { value, unit: defaultUnit };
    }
    if (isPlainObject(value) && Object.hasOwn(value, 'value'))
    {
        const unit = value.unit ?? defaultUnit;
        if (unit == null || unit === '')
        {
            failShape(render, 'quantity object requires unit');
        }
        if (typeof value.value !== 'number' || !Number.isFinite(value.value))
        {
            failShape(render, 'quantity.value must be a finite number');
        }
        return {
            value: value.value,
            unit: String(unit),
            role: value.role ?? value.bound ?? null,
            inclusivity: value.inclusivity ?? null
        };
    }
    failShape(render, `expected number or {value,unit}, got ${typeof value}`);
}

function buildScalarPlan(render, quantity)
{
    const unitInfo = unitTokens(quantity.unit);
    const valueText = String(quantity.value);
    const requiredAnyOfGroups = [
        [valueText],
        [...unitInfo.tokens]
    ];
    const forbiddenTokens = [];
    const requiredPhraseIds = [];

    if (quantity.role === 'maximum' || quantity.role === 'max')
    {
        requiredPhraseIds.push('bound.maximum');
        requiredAnyOfGroups.push([...PhraseRegistry['bound.maximum'].anyOf]);
    }
    if (quantity.role === 'minimum' || quantity.role === 'min')
    {
        requiredPhraseIds.push('bound.minimum');
        requiredAnyOfGroups.push([...PhraseRegistry['bound.minimum'].anyOf]);
    }
    if (quantity.role === 'default')
    {
        requiredPhraseIds.push('bound.default');
        requiredAnyOfGroups.push([...PhraseRegistry['bound.default'].anyOf]);
    }
    if (quantity.inclusivity === 'inclusive')
    {
        requiredPhraseIds.push('inclusivity.inclusive');
        requiredAnyOfGroups.push([...PhraseRegistry['inclusivity.inclusive'].anyOf]);
        forbiddenTokens.push(...PhraseRegistry['inclusivity.inclusive'].forbidden);
    }
    if (quantity.inclusivity === 'exclusive')
    {
        requiredPhraseIds.push('inclusivity.exclusive');
        requiredAnyOfGroups.push([...PhraseRegistry['inclusivity.exclusive'].anyOf]);
        forbiddenTokens.push(...PhraseRegistry['inclusivity.exclusive'].forbidden);
    }

    return Object.freeze({
        kind: 'scalar',
        render,
        requiredAnyOfGroups: Object.freeze(requiredAnyOfGroups.map((group) => Object.freeze([...group]))),
        forbiddenTokens: Object.freeze([...new Set(forbiddenTokens)]),
        dimension: Object.freeze({
            id: unitInfo.dimension,
            expectedValue: quantity.value,
            unit: quantity.unit,
            // Interval projections must be explicit on the claim; otherwise other numbers of same dimension fail.
            allowInterval: false
        }),
        requiredPhraseIds: Object.freeze(requiredPhraseIds),
        quantity: Object.freeze({ ...quantity })
    });
}

function renderIntegerMinutes(value)
{
    return buildScalarPlan('integer-minutes', asQuantity(value, 'minutes', 'integer-minutes'));
}

function renderIntegerBytes(value)
{
    return buildScalarPlan('integer-bytes', asQuantity(value, 'bytes', 'integer-bytes'));
}

function renderIntegerLayers(value)
{
    return buildScalarPlan('integer-layers', asQuantity(value, 'layers', 'integer-layers'));
}

function renderIntegerCount(value)
{
    const quantity = asQuantity(value, 'count', 'integer-count');
    return buildScalarPlan('integer-count', quantity);
}

function renderIntegerScalar(value)
{
    // Unit must be present on observation; no silent unit default.
    return buildScalarPlan('integer-scalar', asQuantity(value, null, 'integer-scalar'));
}

function renderBooleanAffirmed(value)
{
    if (typeof value !== 'boolean')
    {
        failShape('boolean-affirmed', `expected boolean, got ${typeof value}`);
    }
    if (value !== true)
    {
        failShape('boolean-affirmed', 'observation is false but render requires affirmed true');
    }
    const pack = getPhrasePack('boolean.true');
    return Object.freeze({
        kind: 'boolean',
        render: 'boolean-affirmed',
        expected: true,
        requiredAnyOfGroups: Object.freeze([Object.freeze([...pack.anyOf])]),
        forbiddenTokens: Object.freeze([...pack.forbiddenWhenTrue]),
        conflictPair: Object.freeze({
            positive: Object.freeze([...pack.anyOf]),
            negative: Object.freeze([...pack.forbiddenWhenTrue])
        })
    });
}

function renderBooleanNegated(value)
{
    if (typeof value !== 'boolean')
    {
        failShape('boolean-negated', `expected boolean, got ${typeof value}`);
    }
    if (value !== false)
    {
        failShape('boolean-negated', 'observation is true but render requires negated false');
    }
    const pack = getPhrasePack('boolean.false');
    return Object.freeze({
        kind: 'boolean',
        render: 'boolean-negated',
        expected: false,
        requiredAnyOfGroups: Object.freeze([Object.freeze([...pack.anyOf])]),
        forbiddenTokens: Object.freeze([...pack.forbiddenWhenFalse]),
        conflictPair: Object.freeze({
            positive: Object.freeze([...pack.forbiddenWhenFalse]),
            negative: Object.freeze([...pack.anyOf])
        })
    });
}

function renderBooleanExtends(value)
{
    let flag = value;
    if (isPlainObject(value) && Object.hasOwn(value, 'extends'))
    {
        flag = value.extends;
    }
    if (typeof flag !== 'boolean')
    {
        failShape('boolean-extends', `expected boolean or {extends:boolean}, got ${typeof value}`);
    }
    const pack = getPhrasePack(flag ? 'boolean.extends.true' : 'boolean.extends.false');
    return Object.freeze({
        kind: 'boolean',
        render: 'boolean-extends',
        expected: flag,
        requiredAnyOfGroups: Object.freeze([Object.freeze([...pack.anyOf])]),
        forbiddenTokens: Object.freeze([...pack.forbidden]),
        conflictPair: Object.freeze({
            positive: Object.freeze([...getPhrasePack('boolean.extends.true').anyOf]),
            negative: Object.freeze([...getPhrasePack('boolean.extends.false').anyOf])
        })
    });
}

function renderFailureModeCode(value)
{
    let code;
    if (typeof value === 'string')
    {
        code = value;
    }
    else if (isPlainObject(value) && typeof value.code === 'string')
    {
        code = value.code;
    }
    else if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string')
    {
        code = value[0];
    }
    else
    {
        failShape('failure-mode-code', 'expected stable failure-mode code string (or single-element list)');
    }
    if (code.length === 0)
    {
        failShape('failure-mode-code', 'empty failure-mode code');
    }
    // Large failure-mode catalogs belong in generated sections; prose admits one stable code.
    return Object.freeze({
        kind: 'failure-mode',
        render: 'failure-mode-code',
        code,
        requiredAnyOfGroups: Object.freeze([Object.freeze([code, code.replaceAll('_', '-'), code.replaceAll('_', ' ')])]),
        forbiddenTokens: Object.freeze([])
    });
}

function renderFailurePolicy(value)
{
    let policy;
    if (typeof value === 'string')
    {
        policy = value;
    }
    else if (isPlainObject(value) && typeof value.policy === 'string')
    {
        policy = value.policy;
    }
    else
    {
        failShape('failure-policy', 'expected policy string or {policy}');
    }
    const normalized = policy.toLowerCase().replaceAll('_', '-');
    let packId;
    if (normalized === 'fail-closed' || normalized === 'failclosed')
    {
        packId = 'failure.fail-closed';
    }
    else if (normalized === 'fail-open' || normalized === 'failopen')
    {
        packId = 'failure.fail-open';
    }
    else if (normalized === 'required')
    {
        packId = 'policy.required';
    }
    else if (normalized === 'optional')
    {
        packId = 'policy.optional';
    }
    else
    {
        failShape('failure-policy', `unsupported policy ${policy}; register a controlled phrase pack`);
    }
    const pack = getPhrasePack(packId);
    return Object.freeze({
        kind: 'failure-mode',
        render: 'failure-policy',
        policy: normalized,
        requiredAnyOfGroups: Object.freeze([Object.freeze([...pack.anyOf])]),
        forbiddenTokens: Object.freeze([...(pack.forbidden ?? [])]),
        conflictPair: Object.freeze({
            positive: Object.freeze([...getPhrasePack('failure.fail-closed').anyOf]),
            negative: Object.freeze([...getPhrasePack('failure.fail-open').anyOf])
        })
    });
}

function normalizeRelation(value, render)
{
    if (!isPlainObject(value))
    {
        failShape(render, 'expected {subject,predicate,object}');
    }
    const subject = value.subject ?? value.from;
    const predicate = value.predicate ?? value.verb ?? value.effect;
    const object = value.object ?? value.to ?? value.target ?? value.scope;
    if (typeof subject !== 'string' || subject.length === 0
        || typeof predicate !== 'string' || predicate.length === 0
        || typeof object !== 'string' || object.length === 0)
    {
        failShape(render, 'subject, predicate, and object must be non-empty strings');
    }
    return {
        subject: subject.normalize('NFC'),
        predicate: predicate.normalize('NFC'),
        object: object.normalize('NFC'),
        relationId: typeof value.relationId === 'string' ? value.relationId.normalize('NFC') : null,
        condition: typeof value.condition === 'string' ? value.condition.normalize('NFC') : null,
        truthValue: value.truthValue ?? null,
        declaredDirection: value.direction ?? null,
        scope: isPlainObject(value.scope)
            ? Object.values(value.scope).filter((entry) => typeof entry === 'string' && entry.length > 0)
            : []
    };
}

function predicateTokens(predicate)
{
    const key = `predicate.${predicate.toLowerCase().replaceAll('_', '-')}`;
    const pack = getPhrasePack(key);
    if (pack)
    {
        return {
            anyOf: [...pack.anyOf],
            reverseHint: [...(pack.reverseHint ?? [])]
        };
    }
    // Fall back to the stable predicate id itself as the only admitted token.
    return {
        anyOf: [predicate, predicate.replaceAll('_', ' '), predicate.replaceAll('_', '-')],
        reverseHint: []
    };
}

function renderRelationSubjectPredicateObject(value)
{
    const triple = normalizeRelation(value, 'relation-subject-predicate-object');
    const pred = predicateTokens(triple.predicate);
    const requiredGroups = [
        [triple.subject, triple.subject.replaceAll('_', ' ')],
        [...pred.anyOf],
        [triple.object, triple.object.replaceAll('_', ' ')]
    ];
    const forbiddenTokens = [];
    if (triple.relationId)
    {
        requiredGroups.unshift([triple.relationId]);
    }
    if (triple.condition)
    {
        requiredGroups.push([triple.condition]);
    }
    for (const scope of triple.scope)
    {
        requiredGroups.push([scope, scope.replaceAll('_', ' ')]);
    }
    if (triple.truthValue === 'false')
    {
        requiredGroups.push(['false', 'does not', 'never', '不会', '不']);
        forbiddenTokens.push('true', 'affirmed');
    }
    else if (triple.truthValue === 'conditional')
    {
        requiredGroups.push(['conditional', 'condition', '条件']);
    }
    else if (!['true', null].includes(triple.truthValue))
    {
        failShape('relation-subject-predicate-object', `unsupported relation truthValue ${triple.truthValue}`);
    }
    if (triple.declaredDirection != null && triple.declaredDirection !== 'subject-to-object')
    {
        failShape('relation-subject-predicate-object', `unsupported relation direction ${triple.declaredDirection}`);
    }
    return Object.freeze({
        kind: 'binary-relation',
        render: 'relation-subject-predicate-object',
        relation: Object.freeze({ ...triple }),
        requiredAnyOfGroups: Object.freeze(requiredGroups.map((group) => Object.freeze(group))),
        forbiddenTokens: Object.freeze(forbiddenTokens),
        // Direction: subject must appear before object relative to a predicate token.
        direction: Object.freeze({
            subjectTokens: Object.freeze([triple.subject, triple.subject.replaceAll('_', ' ')]),
            predicateTokens: Object.freeze([...pred.anyOf]),
            objectTokens: Object.freeze([triple.object, triple.object.replaceAll('_', ' ')])
        })
    });
}

function renderImplicationIfThen(value)
{
    if (!isPlainObject(value))
    {
        failShape('implication-if-then', 'expected {antecedent|if, consequent|then}');
    }
    const antecedent = value.antecedent ?? value.if;
    const consequent = value.consequent ?? value.then;
    if (typeof antecedent !== 'string' || typeof consequent !== 'string'
        || antecedent.length === 0 || consequent.length === 0)
    {
        failShape('implication-if-then', 'antecedent and consequent must be non-empty strings');
    }
    const pred = predicateTokens('implies');
    return Object.freeze({
        kind: 'implication',
        render: 'implication-if-then',
        implication: Object.freeze({
            antecedent: antecedent.normalize('NFC'),
            consequent: consequent.normalize('NFC')
        }),
        requiredAnyOfGroups: Object.freeze([
            Object.freeze([antecedent, antecedent.replaceAll('_', ' ')]),
            Object.freeze([...pred.anyOf]),
            Object.freeze([consequent, consequent.replaceAll('_', ' ')])
        ]),
        forbiddenTokens: Object.freeze([]),
        direction: Object.freeze({
            subjectTokens: Object.freeze([antecedent, antecedent.replaceAll('_', ' ')]),
            predicateTokens: Object.freeze([...pred.anyOf]),
            objectTokens: Object.freeze([consequent, consequent.replaceAll('_', ' ')])
        })
    });
}

function renderPreservesFields(value)
{
    if (!isPlainObject(value))
    {
        failShape('preserves-fields', 'expected {preserves, doesNotPreserve?, mayUpdate?}');
    }
    const preserves = value.preserves;
    if (!Array.isArray(preserves) || preserves.length === 0
        || preserves.some((entry) => typeof entry !== 'string' || entry.length === 0))
    {
        failShape('preserves-fields', 'preserves must be a non-empty string list');
    }
    // Prose admits a bounded explicit field list; large catalogs must use generated sections.
    if (preserves.length > 8)
    {
        failShape(
            'preserves-fields',
            'preserves list too large for free prose; use generated-section'
        );
    }
    const doesNotPreserve = Array.isArray(value.doesNotPreserve) ? value.doesNotPreserve : [];
    const requiredGroups = preserves.map((field) => Object.freeze([field, field.replaceAll('_', ' ')]));
    requiredGroups.unshift(Object.freeze([...getPhrasePack('predicate.preserves').anyOf]));
    const forbidden = doesNotPreserve.flatMap((field) => [
        `保留 ${field}`,
        `preserves ${field}`,
        `preserve ${field}`
    ]);
    return Object.freeze({
        kind: 'preservation-rule',
        render: 'preserves-fields',
        preserves: Object.freeze([...preserves]),
        doesNotPreserve: Object.freeze([...doesNotPreserve]),
        requiredAnyOfGroups: Object.freeze(requiredGroups),
        forbiddenTokens: Object.freeze(forbidden)
    });
}

function renderRevokesOnlyScope(value)
{
    let scope;
    let subject;
    if (typeof value === 'string')
    {
        scope = value;
        subject = null;
    }
    else if (isPlainObject(value))
    {
        scope = value.scope ?? value.object ?? value.revokesOnly ?? value.target;
        subject = value.subject ?? value.actor ?? null;
    }
    else
    {
        failShape('revokes-only-scope', 'expected scope string or {subject?, scope|object|revokesOnly}');
    }
    if (typeof scope !== 'string' || scope.length === 0)
    {
        failShape('revokes-only-scope', 'scope must be a non-empty string');
    }
    const pack = getPhrasePack('scope.revokes-only');
    const groups = [
        Object.freeze([...pack.anyOf]),
        Object.freeze([scope, scope.replaceAll('_', ' ')])
    ];
    if (typeof subject === 'string' && subject.length > 0)
    {
        groups.unshift(Object.freeze([subject, subject.replaceAll('_', ' ')]));
    }
    return Object.freeze({
        kind: 'preservation-rule',
        render: 'revokes-only-scope',
        scope,
        subject,
        requiredAnyOfGroups: Object.freeze(groups),
        forbiddenTokens: Object.freeze([...pack.forbidden]),
        direction: subject
            ? Object.freeze({
                subjectTokens: Object.freeze([subject, subject.replaceAll('_', ' ')]),
                predicateTokens: Object.freeze([...getPhrasePack('predicate.revokes').anyOf, ...pack.anyOf]),
                objectTokens: Object.freeze([scope, scope.replaceAll('_', ' ')])
            })
            : null
    });
}

function renderRationaleProse()
{
    return Object.freeze({
        kind: 'rationale',
        render: 'rationale-prose',
        requiredAnyOfGroups: Object.freeze([]),
        forbiddenTokens: Object.freeze([])
    });
}

const rendererImplementations = Object.freeze({
    'integer-minutes': renderIntegerMinutes,
    'integer-bytes': renderIntegerBytes,
    'integer-layers': renderIntegerLayers,
    'integer-count': renderIntegerCount,
    'integer-scalar': renderIntegerScalar,
    'boolean-affirmed': renderBooleanAffirmed,
    'boolean-negated': renderBooleanNegated,
    'boolean-extends': renderBooleanExtends,
    'failure-mode-code': renderFailureModeCode,
    'failure-policy': renderFailurePolicy,
    'relation-subject-predicate-object': renderRelationSubjectPredicateObject,
    'implication-if-then': renderImplicationIfThen,
    'preserves-fields': renderPreservesFields,
    'revokes-only-scope': renderRevokesOnlyScope,
    'rationale-prose': renderRationaleProse
});

/**
 * Unique registry: one implementation per prose render kind.
 * No domain-private registries, feature flags, warning-only modes, or compat fallbacks.
 */
export const ProseRenderRegistry = Object.freeze({
    kinds: allowedProseRenders,
    has(kind)
    {
        return Object.hasOwn(rendererImplementations, kind);
    },
    get(kind)
    {
        if (!this.has(kind))
        {
            throw makeProseClaimError(
                ProseClaimErrorCode.UNKNOWN_RENDER,
                `unknown prose render ${kind}`
            );
        }
        return rendererImplementations[kind];
    },
    /**
     * Build a frozen verification plan from claimType + render + observation.
     */
    render(claimType, render, observationValue, options = {})
    {
        assertRenderMatchesClaimType(claimType, render);
        const projected = applyProjection(observationValue, options.projection);
        if (projected === undefined && claimType !== 'rationale')
        {
            throw makeProseClaimError(
                ProseClaimErrorCode.MISSING_OBSERVATION,
                `projection ${options.projection ?? '(none)'} missing on observation for render ${render}`,
                { render, projection: options.projection }
            );
        }
        const impl = this.get(render);
        return impl(projected, options);
    }
});

export function assertSingleProseRenderRegistry(sourceText, label = 'module')
{
    if (/\bcreateProseRenderRegistry\b|\blegacyProseRenderRegistry\b|\bdomainProseRenderRegistry\b/u.test(sourceText))
    {
        throw makeProseClaimError(
            ProseClaimErrorCode.SECOND_REGISTRY,
            `${label} must not define alternate prose render registries`
        );
    }
    if (/\bexport\s+const\s+\w*ProseRenderRegistry\b/u.test(sourceText)
        && !/\bexport\s+const\s+ProseRenderRegistry\b/u.test(sourceText))
    {
        throw makeProseClaimError(
            ProseClaimErrorCode.SECOND_REGISTRY,
            `${label} must not export a second ProseRenderRegistry`
        );
    }
    return true;
}
