import { useState } from 'react';
import { Square } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { useAutonomousStore } from '../../stores/autonomous';
import { cn } from '@/lib/utils';
import { showToast } from '../../utils/toast';

interface Props {
  chatJid: string;
}

/**
 * Urgent-stop button: shows only when this chat is currently streaming/waiting
 * AND is in autonomous mode. Calls POST /api/groups/:jid/stop which interrupts
 * the active agent runner — same route as the existing stopGroup store action.
 *
 * Why only show in autonomous mode: in normal mode, the regular interrupt
 * button is sufficient. The stop button here is a hard-stop for runaway
 * autonomous runs that the user wants to abort before hard brakes fire.
 */
export function AutonomousStopButton({ chatJid }: Props) {
  const isWaiting = useChatStore((s) => !!s.waiting[chatJid]);
  const streaming = useChatStore((s) => s.streaming[chatJid]);
  const stopGroup = useChatStore((s) => s.stopGroup);
  const autonomous = useAutonomousStore((s) => s.chatEnabled[chatJid] ?? false);
  const [stopping, setStopping] = useState(false);

  const active = isWaiting || !!streaming;
  const visible = autonomous && active;
  if (!visible) return null;

  const handleStop = async () => {
    if (!confirm('确定要立即停止当前任务吗？正在执行的 Agent 会被强制中断。')) return;
    setStopping(true);
    const ok = await stopGroup(chatJid);
    setStopping(false);
    if (ok) showToast('已发送停止信号');
    else showToast('停止失败，请重试');
  };

  return (
    <button
      onClick={handleStop}
      disabled={stopping}
      title="立即停止（强制中断当前 Agent 运行）"
      className={cn(
        'hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-lg',
        'bg-red-600 hover:bg-red-700 text-white transition-colors cursor-pointer',
        'disabled:opacity-50 disabled:cursor-not-allowed',
      )}
      aria-label="立即停止"
    >
      <Square className="w-4 h-4" />
      <span className="text-xs font-medium">{stopping ? '停止中…' : '停止'}</span>
    </button>
  );
}
