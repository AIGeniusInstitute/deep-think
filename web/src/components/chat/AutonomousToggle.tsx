import { useEffect, useState } from 'react';
import { Rocket } from 'lucide-react';
import { useAutonomousStore } from '../../stores/autonomous';
import { cn } from '@/lib/utils';
import { showToast } from '../../utils/toast';

interface Props {
  chatJid: string;
}

/**
 * Per-chat autonomous-mode toggle. When enabled, every subsequent message in
 * this chat is dispatched with autonomous=true (no Supervisor clarify, agent
 * does not stop mid-task to ask, hard brakes enforced).
 *
 * Mirror of SupervisorToggle UX: desktop-only icon button in chat header.
 */
export function AutonomousToggle({ chatJid }: Props) {
  const enabled = useAutonomousStore((s) => s.chatEnabled[chatJid] ?? false);
  const toggleChat = useAutonomousStore((s) => s.toggleChat);
  const loadChat = useAutonomousStore((s) => s.loadChat);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void loadChat(chatJid);
  }, [chatJid, loadChat]);

  const toggle = async () => {
    setLoading(true);
    const next = !enabled;
    const ok = await toggleChat(chatJid, next);
    setLoading(false);
    if (ok) {
      showToast(
        next
          ? '全托管已开启：DeepThink 将连续推进任务直到完成或触发硬刹车'
          : '全托管已关闭',
      );
    } else {
      showToast('切换失败，请重试');
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={loading}
      title={
        enabled
          ? '全托管已开启（点击关闭）'
          : '开启全托管（连续推进直到任务完成或硬刹车）'
      }
      className={cn(
        'p-2 rounded-lg transition-colors cursor-pointer',
        enabled
          ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
          : 'hover:bg-accent text-muted-foreground',
      )}
      aria-label={enabled ? '关闭全托管' : '开启全托管'}
    >
      <Rocket className={cn('w-5 h-5', enabled && 'animate-pulse')} />
    </button>
  );
}
