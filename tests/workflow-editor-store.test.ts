import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../web/src/stores/groups', () => ({
  useGroupsStore: {
    getState: () => ({ groups: {} }),
  },
}));

import { useWorkflowEditorStore } from '../web/src/stores/workflow-editor';

describe('workflow editor persistence', () => {
  beforeEach(() => {
    useWorkflowEditorStore.getState().newWorkflow();
  });

  test('keeps manually saved positions when a workflow is reopened', () => {
    useWorkflowEditorStore.getState().loadDefinitionIntoEditor({
      id: 'workflow-positioned',
      version: 3,
      name: '非标准布局',
      description: '位置不应被自动布局覆盖',
      nodes: [
        { id: 'start', type: 'start', title: '开始', position: { x: 410, y: 70 } },
        { id: 'agent', type: 'agent', title: '执行', position: { x: 35, y: 460 } },
        { id: 'end', type: 'end', title: '结束', position: { x: 760, y: 310 } },
      ],
      edges: [
        { id: 'start-agent', from: 'start', to: 'agent', type: 'data' },
        { id: 'agent-end', from: 'agent', to: 'end', type: 'data' },
      ],
    });

    const state = useWorkflowEditorStore.getState();
    expect(state.nodes.map((node) => node.position)).toEqual([
      { x: 410, y: 70 },
      { x: 35, y: 460 },
      { x: 760, y: 310 },
    ]);
    expect(state.name).toBe('非标准布局');
    expect(state.description).toBe('位置不应被自动布局覆盖');
  });

  test('auto-layouts legacy definitions that do not contain positions', () => {
    useWorkflowEditorStore.getState().loadDefinitionIntoEditor({
      id: 'workflow-legacy',
      version: 1,
      name: '旧工作流',
      nodes: [
        { id: 'start', type: 'start', title: '开始' },
        { id: 'agent', type: 'agent', title: '执行' },
        { id: 'end', type: 'end', title: '结束' },
      ],
      edges: [
        { id: 'start-agent', from: 'start', to: 'agent', type: 'data' },
        { id: 'agent-end', from: 'agent', to: 'end', type: 'data' },
      ],
    });

    expect(useWorkflowEditorStore.getState().nodes.map((node) => node.position)).toEqual([
      { x: 80, y: 80 },
      { x: 300, y: 80 },
      { x: 520, y: 80 },
    ]);
  });

  test('updates editable workflow name and description metadata', () => {
    const store = useWorkflowEditorStore.getState();
    store.setName('画布人工验收-0829');
    store.setDescription('用于验收工作流画布保存与恢复');

    expect(useWorkflowEditorStore.getState()).toMatchObject({
      name: '画布人工验收-0829',
      description: '用于验收工作流画布保存与恢复',
    });
  });
});
