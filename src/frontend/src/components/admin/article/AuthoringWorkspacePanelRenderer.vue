<template>
    <ul class="authoring-workspace-panel-renderer">
        <li
            v-for="node in nodes ?? []"
            :key="node.Id"
        >
            <dl v-if="node.Kind === 1">
                <dt>{{ node.Text }}</dt>
                <dd>{{ node.Value }}</dd>
            </dl>
            <ElTag
                v-else-if="node.Kind === 2"
                :type="node.Tone === 0 ? 'info' : node.Tone === 1 ? 'warning' : 'danger'"
            >
                {{ node.Text }}
            </ElTag>
            <ElButton
                v-else-if="node.Kind === 3"
                native-type="button"
                :disabled="disabled || commandsEnabled !== true"
                @click="RequestCommand(node)"
            >
                {{ node.Text }}
            </ElButton>
            <span v-else>{{ node.Text }}</span>
        </li>
    </ul>
</template>

<script setup lang="ts">
import { ElButton, ElTag } from '@ozwasyd/element-plus';

import type {
    AuthoringWorkspacePanelCommandIntent,
    AuthoringWorkspacePanelPresentationNode
} from './authoringWorkspacePanelPresentation';

defineOptions({ inheritAttrs: false });

const props = defineProps<{
    nodes?: readonly AuthoringWorkspacePanelPresentationNode[] | null;
    commandsEnabled?: boolean;
    disabled?: boolean;
}>();

const emit = defineEmits<{
    commandIntent: [intent: AuthoringWorkspacePanelCommandIntent];
}>();

function RequestCommand(node: AuthoringWorkspacePanelPresentationNode)
{
    if (props.commandsEnabled !== true || props.disabled || node.Kind !== 3 || !props.nodes?.includes(node))
    {
        return;
    }
    emit('commandIntent', Object.freeze({ nodeId: node.Id, commandId: node.CommandId }));
}
</script>

<style scoped>
.authoring-workspace-panel-renderer
{
    display: grid;
    gap: var(--fsus-space-2);
    padding: 0;
    margin: 0;
    overflow-wrap: anywhere;
    list-style: none;
}

.authoring-workspace-panel-renderer dl
{
    margin: 0;
}

.authoring-workspace-panel-renderer li
{
    min-inline-size: 0;
    overflow-x: auto;
}

.authoring-workspace-panel-renderer dd
{
    margin-inline-start: 0;
}
</style>
