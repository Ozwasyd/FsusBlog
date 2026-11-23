declare module 'vue' {
  export interface HTMLAttributes {
    'data-testid'?: string
  }
}

declare module '@vue/runtime-dom' {
  export interface HTMLAttributes {
    'data-testid'?: string
  }
}

export {}
