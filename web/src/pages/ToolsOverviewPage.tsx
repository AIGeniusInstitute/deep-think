/**
 * ToolsOverviewPage — unified overview of the platform's invokable surface:
 * Skills (with version count) + MCP servers/tools + quick links.
 *
 * Single grid so an operator can see, at a glance, what the Agent can call.
 * Data: skills store (/api/skills) + per-skill version count
 * (/api/skills/:id/versions) — the version badge is the v58 integration point.
 */
import { useEffect, useState } from 'react';
import { useSkillsStore } from '../stores/skills';
import { api } from '../api/client';

export function ToolsOverviewPage() {
  const skills = useSkillsStore((s) => s.skills);
  const loadSkills = useSkillsStore((s) => s.loadSkills);
  const loading = useSkillsStore((s) => s.loading);
  const [versionCounts, setVersionCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    void loadSkills();
  }, []);

  // Fetch version counts for enabled skills (bounded — one call per skill, but
  // skills lists are small). Failed counts silently drop to 0.
  useEffect(() => {
    let cancelled = false;
    const counts: Record<string, number> = {};
    Promise.all(
      skills.map(async (s) => {
        try {
          const data = await api.get<{ versions: unknown[] }>(
            `/api/skills/${encodeURIComponent(s.id)}/versions`,
          );
          counts[s.id] = Array.isArray(data.versions) ? data.versions.length : 0;
        } catch {
          counts[s.id] = 0;
        }
      }),
    ).then(() => {
      if (!cancelled) setVersionCounts(counts);
    });
    return () => {
      cancelled = true;
    };
  }, [skills]);

  const enabled = skills.filter((s) => s.enabled);
  const disabled = skills.filter((s) => !s.enabled);

  return (
    <div className="p-4 overflow-y-auto h-full">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold">工具总览</h1>
          <p className="text-xs text-gray-500 mt-1">
            Skills · MCP 工具 · 可调用面统一视图
          </p>
        </div>
        <a
          href="/mcp-servers"
          className="px-3 py-1.5 bg-gray-100 rounded text-sm hover:bg-gray-200"
        >
          MCP 服务器 →
        </a>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Card title="启用 Skills" value={String(enabled.length)} />
        <Card title="禁用 Skills" value={String(disabled.length)} />
        <Card title="版本快照总数" value={String(Object.values(versionCounts).reduce((a, b) => a + b, 0))} />
      </div>

      {loading && <div className="text-gray-400 text-sm">加载中…</div>}

      {/* Skills grid */}
      <h2 className="text-sm font-medium mb-2 text-gray-700">Skills</h2>
      {skills.length === 0 && !loading && (
        <div className="text-gray-400 text-xs">暂无已安装 Skill。</div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
        {skills.map((s) => (
          <div
            key={s.id}
            className="border rounded p-3 bg-white hover:shadow-sm transition-shadow"
          >
            <div className="flex items-center justify-between">
              <code className="text-xs text-gray-700 font-medium truncate">{s.id}</code>
              <div className="flex gap-1">
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded ${
                    s.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {s.enabled ? '启用' : '禁用'}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600">
                  {s.source}
                </span>
              </div>
            </div>
            <p className="text-xs text-gray-500 mt-1 line-clamp-2 min-h-[2.4em]">
              {s.description || '（无描述）'}
            </p>
            <div className="flex items-center justify-between mt-2 text-[10px] text-gray-400">
              <span>{s.allowedTools.length} tools</span>
              <span
                className={versionCounts[s.id] ? 'text-blue-600' : 'text-gray-400'}
                title="版本快照数（v58 skill_versions）"
              >
                {versionCounts[s.id] ?? '…'} 版本
              </span>
            </div>
            {s.userInvocable && s.argumentHint && (
              <div className="mt-1 text-[10px] text-gray-400 font-mono truncate">
                /{s.id} {s.argumentHint}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <div className="border rounded p-3 bg-white">
      <div className="text-[10px] text-gray-500 uppercase">{title}</div>
      <div className="text-lg font-bold mt-1">{value}</div>
    </div>
  );
}
