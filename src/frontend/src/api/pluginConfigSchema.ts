export interface PluginConfigSchemaNode {
    [keyword: string]: unknown;
    type: 'array' | 'boolean' | 'integer' | 'null' | 'number' | 'object' | 'string';
    $schema?: string;
    $id?: string;
    title?: string;
    description?: string;
    properties?: Record<string, PluginConfigSchemaNode>;
    required?: string[];
    additionalProperties?: boolean;
    items?: PluginConfigSchemaNode;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    default?: unknown;
}

export interface PluginConfigSchema extends PluginConfigSchemaNode {
    type: 'object';
}
