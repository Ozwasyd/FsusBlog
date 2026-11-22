// Use the same exact accessible-name matching for selectors on pages and nested locators.
export function roleWithExactName(scope, role, name) {
  return scope.getByRole(role, { name, exact: true })
}

export function exactButton(scope, name) {
  return roleWithExactName(scope, 'button', name)
}

export function exactText(scope, text) {
  return scope.getByText(text, { exact: true })
}

export function exactLabel(scope, label) {
  return scope.getByLabel(label, { exact: true })
}
