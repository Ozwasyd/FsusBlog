// Use the same exact accessible-name matching for selectors on pages and nested locators.
export function roleWithExactName(scope, role, name) {
  return scope.getByRole(role, { name, exact: true })
}

export function exactButton(scope, name) {
  return roleWithExactName(scope, 'button', name)
}
