import { Rocket } from 'lucide-react';
import { useAutonomousStore } from '../../stores/autonomous';
import { cn } from '@/lib/utils';

interface Props {
  chatJid: string;
}

/**
 * Persistent amber banner shown below the chat header when autonomous mode is
 * enabled for the current chat. Visible on all breakpoints (mobile + desktop)
 * so users always know the agent will not stop mid-task to ask questions.
 *
 * Pulses subtly while the agent is active to signal "still running autonomously".
 */
export function AutonomousBanner({ chatJid }: Props) {
  const enabled = useAutonomousStore((s) => s.chatEnabled[chatJid] ?? false);
  if (!enabled) return null;
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-1.5',
        'bg-amber-50 dark:bg-amber-950/40',
        'border-b border-amber-200 dark:border-amber-800',
        'text-amber-800 dark:text-amber-300',
      )}
    >
      <span className="relative flex h-2 w-2 flex-shrink-0">
        <span className="absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-600" />
      </span>
      <Rocket className="w-3.5 h-3.5 flex-shrink-0" />
      <span className="text-xs font-medium">全托管运行中</span>
      <span className="text-[11px] text-amber-700/80 dark:text-amber-400/80 truncate">
        · Agent 不会中途停下询问，遇到风险自动刹车
      </span>
    </div>
  );
}
