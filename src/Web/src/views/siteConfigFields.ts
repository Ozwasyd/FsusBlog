import type { AdminSiteConfigCommand } from '../../../Contracts/admin-site-config'
import type { MessageKey } from '../siteLocale'

export type FieldKey = Exclude<keyof AdminSiteConfigCommand, 'expectedRevision' | 'expectedDigest' | 'complianceEnabled' | 'regionMode'>
export type SiteConfigField = {
  key: FieldKey
  hint?: MessageKey
  hintId?: string
  placeholder?: string
  type?: 'email' | 'textarea'
  autosize?: { minRows: number; maxRows: number }
  required?: boolean
  identifier?: boolean
  autocomplete?: string
  inputmode?: string
}

export type SiteConfigFieldControls = {
  values: Readonly<Record<FieldKey, string>>
  disabled: boolean
  error: (key: FieldKey) => string
  change: (key: FieldKey, value: string) => void
  input: (key: FieldKey) => void
  blur: (key: FieldKey) => void
}

export const fieldLabel = (key: FieldKey): MessageKey => key === 'title' ? 'admin.siteConfig.siteTitle' : `admin.siteConfig.${key}`
export const fieldId = (kind: 'field' | 'hint' | 'error', key: FieldKey) => `site-config-${kind}-${key}`

export function fieldInputAttrs(
  key: FieldKey, invalid: boolean,
  { hintId, identifier, required, autocomplete, inputmode }: Omit<SiteConfigField, 'key'>,
): Record<string, unknown> {
  const ids = [hintId, invalid ? fieldId('error', key) : undefined].filter(Boolean)
  return {
    name: key,
    'aria-invalid': invalid ? 'true' : 'false',
    ...(ids.length ? { 'aria-describedby': ids.join(' ') } : {}),
    ...(required ? { required: true } : {}),
    ...(autocomplete ? { autocomplete } : {}),
    ...(inputmode ? { inputmode } : {}),
    ...(identifier ? { autocorrect: 'off', autocapitalize: 'none', spellcheck: false } : {}),
  }
}
