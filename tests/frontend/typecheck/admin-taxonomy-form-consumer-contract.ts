import type { FormItemRule, FormRules } from '@ozwasyd/element-plus';

import type {
    AdminTaxonomyManageState,
    TaxonomyFormRules
} from '../../../src/frontend/src/composables/useAdminTaxonomyManage';

type Assignable<Expected, Actual extends Expected> = Actual;
type Equal<Left, Right> =
    (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Expect<Value extends true> = Value;
type TaxonomyRule = TaxonomyFormRules['name'][number];

export type TaxonomyPublicFormConsumerContract = [
    Assignable<FormRules, AdminTaxonomyManageState['rules']>,
    Assignable<FormRules<'name' | 'description'>, TaxonomyFormRules>,
    Expect<Equal<AdminTaxonomyManageState['rules'], Pick<TaxonomyFormRules, keyof TaxonomyFormRules>>>,
    Expect<Equal<keyof TaxonomyFormRules, 'name' | 'description'>>,
    Expect<Equal<keyof AdminTaxonomyManageState['rules'], 'name' | 'description'>>,
    Expect<Equal<{} extends Pick<TaxonomyFormRules, 'name'> ? true : false, false>>,
    Expect<Equal<{} extends Pick<TaxonomyFormRules, 'description'> ? true : false, true>>,
    Expect<Equal<TaxonomyRule['validator'], FormItemRule['validator']>>,
    Expect<Equal<NonNullable<TaxonomyFormRules['description']>[number]['validator'], FormItemRule['validator']>>,
    Assignable<NonNullable<FormItemRule['validator']>, (_rule: unknown, _value: unknown) => void>
];

// @ts-expect-error Taxonomy schema rules still require the name field.
export type MissingNameRejected = Assignable<TaxonomyFormRules, {}>;

// @ts-expect-error Every taxonomy rule still requires its string trigger.
export type MissingTriggerRejected = Assignable<TaxonomyRule, {}>;

// @ts-expect-error Numeric rule bounds must not accept strings.
export type StringMinRejected = Assignable<TaxonomyRule, { trigger: 'blur'; min: '1'; }>;

// @ts-expect-error Public synchronous validator does not accept Promise<number>.
export type AsyncNumberValidatorRejected = Assignable<NonNullable<TaxonomyRule['validator']>, (_rule: unknown, _value: unknown) => Promise<number>>;

// @ts-expect-error Public synchronous validator does not accept Promise<void>.
export type AsyncVoidValidatorRejected = Assignable<NonNullable<TaxonomyRule['validator']>, (_rule: unknown, _value: unknown) => Promise<void>>;

// @ts-expect-error The consumer projection has no arbitrary string index signature.
export type UnexpectedConsumerFieldRejected = AdminTaxonomyManageState['rules']['unexpected'];
