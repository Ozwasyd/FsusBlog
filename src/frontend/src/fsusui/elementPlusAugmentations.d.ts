import type { Component } from 'vue'

// Temporary compatibility shim for the lockfile package.
// Cleanup condition: remove this declaration after @ozwasyd/element-plus is
// updated to a package build whose root .d.ts exports ElEmptyState directly.
declare module '@ozwasyd/element-plus' {
  export const ElEmptyState: Component
  export const ElSiteHeader: Component
}
