import type { EditableProperty, PropertyReadValue } from '../../../Contracts/property-values'

export function showPropertyValue(field: EditableProperty, stored: PropertyReadValue = field.value): string {
  function optionsLabel(optionIds: string[]) {
    const labels = field.options.filter(option => optionIds.includes(option.id)).map(option => option.label)
    return labels.length ? labels.join(', ') : 'None selected'
  }
  switch (stored.kind) {
    case 'missing': return 'Unset'
    case 'null': return 'Null'
    case 'unavailable': return 'Unavailable reference'
    case 'boolean': return stored.value ? 'True' : 'False'
    case 'article-reference': return stored.value.map(id => `Article #${id}`).join(', ')
    case 'single-select': return optionsLabel([stored.value])
    case 'multi-select': return optionsLabel(stored.value)
    default: return stored.value || 'Blank'
  }
}
