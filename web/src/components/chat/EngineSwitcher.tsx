import { useEffect, useState } from 'react';
import { Box } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { api } from '../../api/client';
import type { GroupInfo } from '../../types';

interface EngineSwitcherProps {
  groupJid: string;
  group: GroupInfo | undefined;
}

type EngineKey = 'claude' | 'atomcode' | 'codex' | 'opencode' | 'pi';

const ENGINES: Array<{ key: EngineKey; label: string }> = [
  { key: 'claude', label: 'Claude' },
  { key: 'atomcode', label: 'AtomCode' },
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'pi', label: 'pi' },
];

interface EngineAvailability {
  atomcode?: boolean;
  codex?: boolean;
  opencode?: boolean;
  pi?: boolean;
}

export function EngineSwitcher({ groupJid, group }: EngineSwitcherProps) {
  const switchEngine = useChatStore((s) => s.switchEngine);
  const [busy, setBusy] = useState(false);
  const [availability, setAvailability] = useState<EngineAvailability>({});

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<{ enabled?: boolean }>('/api/config/atomcode').catch(() => null),
      api.get<{ enabled?: boolean }>('/api/config/codex').catch(() => null),
      api.get<{ enabled?: boolean }>('/api/config/opencode').catch(() => null),
      api.get<{ enabled?: boolean }>('/api/config/pi').catch(() => null),
    ]).then(([a, c, o, p]) => {
      if (cancelled) return;
      setAvailability({
        atomcode: a?.enabled === true,
        codex: c?.enabled === true,
        opencode: o?.enabled === true,
        pi: p?.enabled === true,
      });
    });
    return () => { cancelled = true; };
  }, []);

  const current = (group?.engine ?? 'claude') as EngineKey;

  if (!group) return null;

  const handleSwitch = async (engine: EngineKey) => {
    if (engine === current || busy) return;
    if (engine !== 'claude' && !availability[engine]) return;
    setBusy(true);
    try {
      await switchEngine(groupJid, engine);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hidden lg:flex items-center gap-1 p-1 rounded-lg bg-muted/60 border border-border">
      <Box className="w-3.5 h-3.5 text-muted-foreground ml-1.5" />
      {ENGINES.map((e) => {
        const active = e.key === current;
        const enabled = e.key === 'claude' || availability[e.key] === true;
        const disabled = busy || !enabled;
        return (
          <button
            key={e.key}
            onClick={() => handleSwitch(e.key)}
            disabled={disabled}
            className={`px-2 py-1 text-xs rounded-md transition-colors ${
              active
                ? 'bg-primary text-white font-medium'
                : enabled
                  ? 'text-muted-foreground hover:bg-muted hover:text-foreground'
                  : 'text-muted-foreground/40 cursor-not-allowed'
            } ${busy ? 'opacity-60 cursor-not-allowed' : ''}`}
            title={
              enabled
                ? `切换到 ${e.label} 引擎（新会话生效）`
                : `${e.label} 引擎未启用，请到设置页配置`
            }
          >
            {e.label}
          </button>
        );
      })}
    </div>
  );
}
