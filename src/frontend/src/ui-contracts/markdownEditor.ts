import type { Component } from 'vue'

export type MarkdownEditorMode = 'write' | 'split' | 'preview'
export type MarkdownEditorCommandGroup = 'text' | 'structure' | 'code' | 'media' | 'action'
export type MarkdownEditorCommandKey =
  | 'undo'
  | 'redo'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bold'
  | 'italic'
  | 'quote'
  | 'ul'
  | 'ol'
  | 'task'
  | 'link'
  | 'code'
  | 'block'
  | 'latex'
  | 'mermaid'
  | 'table'
  | 'hr'
  | 'image'
  | 'save'

export type MarkdownEditorCommand = Readonly<{
  key: MarkdownEditorCommandKey
  label: string
  ariaLabel?: string
  shortcut?: string
  group: MarkdownEditorCommandGroup
}>

export type MarkdownEditorProviderContract = Readonly<{
  id: string
  label: string
  editorComponent: Component
  previewComponent: Component
  defaultMode: MarkdownEditorMode
  defaultToolbarsExclude: readonly string[]
}>
