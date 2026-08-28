import { MessageCircle, Clock4, Puzzle, Wallet, User, Repeat, GitBranch, Bot, BookOpen, ShoppingBag, Boxes, Server, BrainCircuit, Cpu, ShieldCheck, Users, Building2, Workflow } from 'lucide-react';

export const baseNavItems = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/team', icon: Users, label: '团队' },
  { path: '/opc', icon: Building2, label: 'OPC' },
  { path: '/agents', icon: Bot, label: 'Agent' },
  { path: '/workflows', icon: Workflow, label: '工作流' },
  { path: '/skills', icon: Puzzle, label: 'Skill' },
  { path: '/knowledge-bases', icon: BookOpen, label: '知识库' },
  { path: '/marketplace', icon: ShoppingBag, label: '市场' },
  { path: '/mcp-servers', icon: Server, label: 'MCP' },
  { path: '/memory', icon: BrainCircuit, label: '记忆管理' },
  { path: '/engines', icon: Cpu, label: '引擎' },
  { path: '/sandbox', icon: Boxes, label: '沙箱' },
  { path: '/tasks', icon: Clock4, label: '任务' },
  { path: '/loops', icon: Repeat, label: '循环' },
  { path: '/supervisor', icon: ShieldCheck, label: '监督者' },
  { path: '/harness', icon: GitBranch, label: 'Harness' },
  { path: '/billing', icon: Wallet, label: '账单', requiresBilling: true },
  { path: '/settings', icon: User, label: '设置' },
];

export function filterNavItems(billingEnabled: boolean) {
  return baseNavItems.filter((item) => {
    if (item.requiresBilling && !billingEnabled) return false;
    return true;
  });
}
