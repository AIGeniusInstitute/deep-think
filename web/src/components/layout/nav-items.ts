import { MessageCircle, Puzzle, User, BookOpen, Bot, Server, KeyRound } from 'lucide-react';

export const baseNavItems = [
  { path: '/chat', icon: MessageCircle, label: '工作台' },
  { path: '/agents', icon: Bot, label: 'Agent' },
  { path: '/skills', icon: Puzzle, label: 'Skill' },
  { path: '/mcp-servers', icon: Server, label: 'MCP' },
  { path: '/knowledge-bases', icon: BookOpen, label: '知识库' },
  { path: '/open-platform', icon: KeyRound, label: '开放平台' },
  { path: '/settings', icon: User, label: '设置' },
];

export function filterNavItems(billingEnabled: boolean) {
  return baseNavItems.filter((item) => {
    if ((item as { requiresBilling?: boolean }).requiresBilling && !billingEnabled) return false;
    return true;
  });
}
