import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, Settings, Check, X } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '../api/client';

type EngineKey = 'claude' | 'atomcode' | 'codex' | 'opencode' | 'pi';

interface EngineDef {
  key: EngineKey;
  label: string;
  description: string;
  settingsTab: string;
  alwaysOn: boolean;
}

const ENGINES: EngineDef[] = [
  {
    key: 'claude',
    label: 'Claude Code',
    description: '默认引擎,基于 Claude 模型的 Code Agent,通常无需额外配置即可使用。',
    settingsTab: 'claude',
    alwaysOn: true,
  },
  {
    key: 'atomcode',
    label: 'AtomCode',
    description: '本地化部署的代码引擎,适合自托管与离线场景。',
    settingsTab: 'atomcode',
    alwaysOn: false,
  },
  {
    key: 'codex',
    label: 'Codex',
    description: 'OpenAI Codex 代码引擎,需在配置页填入凭据后启用。',
    settingsTab: 'codex',
    alwaysOn: false,
  },
  {
    key: 'opencode',
    label: 'OpenCode',
    description: '开源代码引擎,可灵活对接多种后端模型。',
    settingsTab: 'opencode',
    alwaysOn: false,
  },
  {
    key: 'pi',
    label: 'pi',
    description: 'self-extensible coding agent harness,通过 RPC 模式 (stdio JSONL) 接入,支持 20+ provider。',
    settingsTab: 'pi',
    alwaysOn: false,
  },
];

type EngineAvailability = Partial<Record<EngineKey, boolean>>;

export function EnginesPage() {
  const navigate = useNavigate();
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

  const openSettings = (tab: string) => navigate(`/settings?tab=${tab}`);

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-7xl mx-auto">
        <div className="bg-background border-b border-border px-6 py-4">
          <PageHeader
            title="引擎"
            subtitle="管理可用引擎: Claude Code / AtomCode / Codex / OpenCode"
          />
        </div>

        <div className="p-4 lg:p-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            {ENGINES.map((engine) => {
              const enabled = engine.alwaysOn || availability[engine.key] === true;
              return (
                <Card key={engine.key}>
                  <CardContent>
                    <div className="flex items-start justify-between mb-3">
                      <div className="p-2 bg-brand-100 rounded-lg">
                        <Cpu className="w-5 h-5 text-primary" />
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border ${
                          enabled
                            ? 'border-success/30 bg-success-bg text-success'
                            : 'border-border bg-muted text-muted-foreground'
                        }`}
                      >
                        {enabled ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                        {enabled ? '可用' : '未启用'}
                      </span>
                    </div>

                    <h3 className="text-base font-semibold text-foreground">{engine.label}</h3>
                    <p className="mt-1 text-sm text-muted-foreground min-h-[3.5rem]">
                      {engine.description}
                    </p>

                    <Button
                      variant="outline"
                      className="w-full mt-3"
                      onClick={() => openSettings(engine.settingsTab)}
                    >
                      <Settings className="w-4 h-4" />
                      配置
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
