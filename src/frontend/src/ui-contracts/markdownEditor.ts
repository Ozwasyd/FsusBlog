import type { Component } from 'vue';

export type MarkdownEditorChrome = 'framed' | 'embedded' | 'minimal';
export type MarkdownEditorStatusDensity = 'none' | 'minimal' | 'detailed';
export type MarkdownEditorMode = 'source' | 'live' | 'split' | 'preview';
export type MarkdownEditorCommandGroup = 'text' | 'structure' | 'code' | 'media' | 'action' | 'format' | 'block' | 'insert';
export type MarkdownEditorCommandKey =
  | 'undo'
  | 'redo'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
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
  | 'save';

export type MarkdownEditorCommand = Readonly<{
    key: MarkdownEditorCommandKey;
    label: string;
    ariaLabel?: string;
    shortcut?: string;
    group: MarkdownEditorCommandGroup;
}>;

export type MarkdownEditorProviderContract = Readonly<{
    id: string;
    label: string;
    editorComponent: Component;
    previewComponent: Component;
    defaultMode: MarkdownEditorMode;
    defaultToolbarsExclude: readonly string[];
}>;
