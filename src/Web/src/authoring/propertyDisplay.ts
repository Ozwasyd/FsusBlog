import { t } from '../siteLocale'
import type { EditableProperty, PropertyReadValue } from '../../../Contracts/property-values'

export function showPropertyValue(field: EditableProperty, stored: PropertyReadValue = field.value): string {
  function optionsLabel(optionIds: string[]) {
    const labels = field.options.filter(option => optionIds.includes(option.id)).map(option => option.label)
    return labels.length ? labels.join(', ') : t('author.helper.none')
  }
  switch (stored.kind) {
    case 'missing': return t('author.helper.unset')
    case 'null': return t('author.helper.null')
    case 'unavailable': return t('author.helper.unavailable')
    case 'boolean': return stored.value ? t('author.helper.true') : t('author.helper.false')
    case 'article-reference': return stored.value.map(id => t('author.helper.article', { id })).join(', ')
    case 'single-select': return optionsLabel([stored.value])
    case 'multi-select': return optionsLabel(stored.value)
    default: return stored.value || t('author.helper.blank')
  }
}
