// F6 part 1 — pure unit tests for agent-node prompt composition, including
// downstream-gate failure feedback injection (orchestrator resets the upstream
// agent node and writes gate_feedback_<nodeId> into state when a gate fails).

import { describe, expect, test } from 'vitest';
import { composeAgentPrompt } from '../../src/graph-engineering/graph-runner.js';
import type { GraphNode, GraphState } from '../../src/graph-engineering/graph-types.js';

const baseNode = (over: Partial<GraphNode> = {}): GraphNode =>
  ({
    id: 'agent-1',
    type: 'agent',
    title: '实现登录页',
    prompt: '写一个登录表单',
    ...over,
  }) as GraphNode;

describe('composeAgentPrompt — F6 gate-feedback injection (AC6.1.3)', () => {
  test('no goalAnchor + no feedback → base prompt', () => {
    const p = composeAgentPrompt(baseNode(), {});
    expect(p).toBe('写一个登录表单');
  });

  test('goalAnchor prepended before base prompt', () => {
    const node = baseNode({ goalAnchor: '【目标】交付登录页' });
    expect(composeAgentPrompt(node, {})).toBe('【目标】交付登录页\n\n---\n\n写一个登录表单');
  });

  test('gate feedback prepended before goalAnchor + base (F6 re-run path)', () => {
    const node = baseNode({ goalAnchor: '【目标】交付登录页' });
    const state: GraphState = {
      'gate_feedback_agent-1': '【上游 Gate "校验" 第 1 次评审失败】断言未通过',
    };
    const p = composeAgentPrompt(node, state);
    expect(p.startsWith('【上游 Gate')).toBe(true);
    expect(p).toContain('断言未通过');
    expect(p).toContain('【目标】交付登录页');
    expect(p).toContain('写一个登录表单');
    // order: feedback → goalAnchor → base
    const fbIdx = p.indexOf('【上游 Gate');
    const anchorIdx = p.indexOf('【目标】交付登录页');
    const baseIdx = p.indexOf('写一个登录表单');
    expect(fbIdx).toBeLessThan(anchorIdx);
    expect(anchorIdx).toBeLessThan(baseIdx);
  });

  test('non-string feedback entry is ignored (no crash)', () => {
    const node = baseNode();
    const state: GraphState = { 'gate_feedback_agent-1': 42 };
    expect(composeAgentPrompt(node, state)).toBe('写一个登录表单');
  });

  test('feedback for a different node id is not injected', () => {
    const node = baseNode({ id: 'agent-1' });
    const state: GraphState = { 'gate_feedback_agent-2': '别的节点的反馈' };
    expect(composeAgentPrompt(node, state)).toBe('写一个登录表单');
  });
});
