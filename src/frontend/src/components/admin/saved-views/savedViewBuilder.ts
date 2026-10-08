/**
 * An ephemeral editor projection of AuthorSavedViewContracts.cs, not a query
 * parser, dependency resolver or executor. Definitions come from the owner;
 * a successful local check still requires server validation and CAS.
 */
export interface SavedViewField {
    kind: number;
    identity: string;
}

export interface SavedViewCondition {
    field: SavedViewField;
    operatorId: string;
    values: string[];
    timeZoneId?: string | null;
}

export interface SavedViewQueryDraft {
    schemaVersion: number;
    conditions: SavedViewCondition[];
    sort: {
        field: SavedViewField;
        direction: number;
        nullPlacement: number;
        collation: string;
        stableTieBreaker: string;
        timeZoneId?: string | null;
    };
    projection: SavedViewField[];
    pageSize: number;
}

export interface SavedViewEditorOperator {
    id: string;
    label: string;
    /** Original owner cardinality: None=0, Single=1, MultipleSet=2, OrderedPair=3. */
    cardinality: number;
    /** Original owner value kind; AuthorityOwned=6 stays read-only here. */
    valueKind: number;
}

export interface SavedViewEditorField {
    field: SavedViewField;
    label: string;
    operators: SavedViewEditorOperator[];
    choices: { value: string; label: string; }[];
}

export interface SavedViewBuilderDefinitions {
    schemaVersion: number;
    maxConditions: number;
    maxValuesPerCondition: number;
    maxProjectionFields: number;
    maxPageSize: number;
    maxValueLength: number;
    fields: SavedViewEditorField[];
    timeZones: string[];
}

export interface SavedViewDraftIssue {
    conditionIndex?: number;
    reason: string;
}

export interface SavedViewDraftSubmission {
    viewId: string;
    expectedRevision: number;
    query: SavedViewQueryDraft;
}

/** Copy the draft without canonicalizing, filtering or dropping any condition. */
export function cloneSavedViewDraft(query: SavedViewQueryDraft): SavedViewQueryDraft
{
    return {
        ...query,
        conditions: query.conditions.map(condition => ({
            ...condition,
            field: { ...condition.field },
            values: [...condition.values]
        })),
        sort: { ...query.sort, field: { ...query.sort.field } },
        projection: query.projection.map(field => ({ ...field }))
    };
}

/** Compare the closed AST structurally, retaining operand and projection order. */
export function sameSavedViewDraft(left: SavedViewQueryDraft, right: SavedViewQueryDraft): boolean
{
    const snapshot = (query: SavedViewQueryDraft) => JSON.stringify([
        query.schemaVersion,
        query.conditions.map(condition => [
            condition.field.kind, condition.field.identity, condition.operatorId,
            condition.values, condition.timeZoneId ?? null
        ]),
        [
            query.sort.field.kind, query.sort.field.identity, query.sort.direction,
            query.sort.nullPlacement, query.sort.collation, query.sort.stableTieBreaker,
            query.sort.timeZoneId ?? null
        ],
        query.projection.map(field => [field.kind, field.identity]),
        query.pageSize
    ]);
    return snapshot(left) === snapshot(right);
}

export function savedViewFieldKey(field: SavedViewField): string
{
    return `${field.kind}:${field.identity}`;
}

/** Ambiguous or missing definitions are never repaired by a first match. */
export function findSavedViewEditorField(
    field: SavedViewField,
    definitions: SavedViewBuilderDefinitions | null
): SavedViewEditorField | null
{
    const matches = definitions?.fields.filter(candidate =>
        savedViewFieldKey(candidate.field) === savedViewFieldKey(field)
    ) ?? [];
    return matches.length === 1 ? matches[0] : null;
}

export function findSavedViewEditorOperator(
    condition: SavedViewCondition,
    definitions: SavedViewBuilderDefinitions | null
): SavedViewEditorOperator | null
{
    const matches = findSavedViewEditorField(condition.field, definitions)
        ?.operators.filter(operator => operator.id === condition.operatorId) ?? [];
    return matches.length === 1 ? matches[0] : null;
}

/** Bounded shape feedback only. It does not certify dependency or query validity. */
export function validateSavedViewDraft(
    query: SavedViewQueryDraft,
    definitions: SavedViewBuilderDefinitions | null
): SavedViewDraftIssue[]
{
    if (!definitions)
    {
        return [{ reason: '字段定义不可用，所有条件均已保留。' }];
    }
    if (query.schemaVersion !== definitions.schemaVersion)
    {
        return [{ reason: '查询版本不受支持，需要服务端迁移；所有条件均已保留。' }];
    }
    const issues: SavedViewDraftIssue[] = [];
    if (query.conditions.length > definitions.maxConditions)
    {
        issues.push({ reason: '条件数量超出服务端上限。' });
    }
    const keys = new Set<string>();
    query.conditions.slice(0, definitions.maxConditions).forEach((condition, conditionIndex) =>
    {
        const operator = findSavedViewEditorOperator(condition, definitions);
        const fail = (reason: string) => issues.push({ conditionIndex, reason });
        if (!operator)
        {
            fail('字段或操作符不可用；此条件未被移除。');
            return;
        }
        if (![0, 1, 2, 3].includes(operator.valueKind) || ![0, 1, 2, 3].includes(operator.cardinality))
        {
            fail('此条件需要原 owner 的类型化控件；此条件未被移除。');
            return;
        }
        const key = `${savedViewFieldKey(condition.field)}:${condition.operatorId}`;
        if (keys.has(key))
        {
            fail('同字段和操作符的条件重复，请使用同字段多选。');
        }
        keys.add(key);
        const count = condition.values.length;
        if (count > definitions.maxValuesPerCondition
            || (operator.cardinality === 0 && count !== 0)
            || (operator.cardinality === 1 && count !== 1)
            || (operator.cardinality === 2 && count < 1)
            || (operator.cardinality === 3 && count !== 2))
        {
            fail('条件值数量不符合操作符的服务端定义。');
        }
        if (condition.values.some(value => !value.trim()
            || value.length > definitions.maxValueLength
            || /\p{Cc}/u.test(value)))
        {
            fail('条件值为空、过长或含控制字符。');
        }
        if (operator.valueKind === 1)
        {
            const choices = findSavedViewEditorField(condition.field, definitions)!.choices;
            if (condition.values.some(value => !choices.some(choice => choice.value === value)))
            {
                fail('条件引用的值不在当前定义中；未自动替换。');
            }
        }
        if (operator.valueKind === 3
            && (!condition.timeZoneId || !definitions.timeZones.includes(condition.timeZoneId)))
        {
            fail('请选择服务端支持的日期时区。');
        }
    });
    if (!Number.isInteger(query.pageSize) || query.pageSize < 1
        || query.pageSize > definitions.maxPageSize)
    {
        issues.push({ reason: '每页数量超出服务端上限。' });
    }
    if (!findSavedViewEditorField(query.sort.field, definitions)
        || ![0, 1].includes(query.sort.direction)
        || ![0, 1].includes(query.sort.nullPlacement)
        || query.sort.stableTieBreaker !== 'article.id')
    {
        issues.push({ reason: '排序定义不可用或不受支持；未改写原排序。' });
    }
    if (query.projection.length < 1 || query.projection.length > definitions.maxProjectionFields
        || query.projection.some(field => !findSavedViewEditorField(field, definitions)))
    {
        issues.push({ reason: '显示字段不可用或超出服务端上限；所有显示字段均已保留。' });
    }
    return issues;
}
