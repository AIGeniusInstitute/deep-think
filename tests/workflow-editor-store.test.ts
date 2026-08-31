import { beforeEach, describe, expect, test, vi } from 'vitest';

const workflowsApiMock = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../web/src/api/workflows', () => ({
  workflowsApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: workflowsApiMock.create,
    update: workflowsApiMock.update,
    autobuild: vi.fn(),
  },
}));

vi.mock('../web/src/stores/groups', () => ({
  useGroupsStore: {
    getState: () => ({ groups: {} }),
  },
}));

import { useWorkflowEditorStore } from '../web/src/stores/workflow-editor';

describe('workflow editor persistence', () => {
  beforeEach(() => {
    workflowsApiMock.create.mockReset();
    workflowsApiMock.update.mockReset();
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

  test('rejects a cyclic draft before sending a save request', async () => {
    useWorkflowEditorStore.getState().loadDefinitionIntoEditor({
      id: 'workflow-cycle',
      version: 1,
      name: '有环工作流',
      nodes: [
        {
          id: 'A',
          type: 'agent',
          title: 'A',
          prompt: '执行 A',
          position: { x: 80, y: 80 },
        },
        {
          id: 'B',
          type: 'agent',
          title: 'B',
          prompt: '执行 B',
          position: { x: 300, y: 80 },
        },
      ],
      edges: [
        { id: 'A-B', from: 'A', to: 'B', type: 'data' },
        { id: 'B-A', from: 'B', to: 'A', type: 'data' },
      ],
    });

    await expect(useWorkflowEditorStore.getState().save()).resolves.toBeNull();
    expect(useWorkflowEditorStore.getState().saveError).toContain('存在环');
    expect(useWorkflowEditorStore.getState().saving).toBe(false);
    expect(workflowsApiMock.create).not.toHaveBeenCalled();
    expect(workflowsApiMock.update).not.toHaveBeenCalled();
  });

  test('allows saving an unbound Agent because it is a warning, not an error', async () => {
    workflowsApiMock.create.mockResolvedValue({
      ok: true,
      id: 'workflow-warning',
      version: 1,
      hash: 'hash',
    });
    useWorkflowEditorStore.setState({
      name: '未绑定 Agent 工作流',
      nodes: [
        {
          id: 'agent',
          type: 'workflowNode',
          position: { x: 80, y: 80 },
          data: {
            id: 'agent',
            type: 'agent',
            title: 'Agent',
            prompt: '执行任务',
          },
        },
      ],
      edges: [],
    });

    await expect(useWorkflowEditorStore.getState().save()).resolves.toEqual({
      id: 'workflow-warning',
      version: 1,
    });
    expect(workflowsApiMock.create).toHaveBeenCalledOnce();
    expect(useWorkflowEditorStore.getState().saveError).toBeNull();
  });
});
