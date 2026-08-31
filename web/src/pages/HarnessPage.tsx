import { useEffect, useState } from 'react';
import {
  useHarnessStore,
  type HarnessManifest,
  type HarnessProposal,
  type HarnessVersion,
  type VersionDiff,
} from '../stores/harness';
import { EvalDashboard } from '../components/harness/EvalDashboard';

const STATUS_COLORS: Record<string, string> = {
  experimental: 'bg-yellow-100 text-yellow-700',
  promoted: 'bg-green-100 text-green-700',
  archived: 'bg-gray-200 text-gray-600',
  rolled_back: 'bg-red-100 text-red-700',
};

const VERDICT_COLORS: Record<string, string> = {
  improved: 'bg-green-100 text-green-700',
  regressed: 'bg-red-100 text-red-700',
  neutral: 'bg-gray-100 text-gray-700',
  inconclusive: 'bg-yellow-100 text-yellow-700',
};

export function HarnessPage() {
  const [tab, setTab] = useState<'harness' | 'dashboard'>('harness');
  const {
    versions,
    promotedId,
    proposals,
    fetchVersions,
    fetchProposals,
    selectedVersionId,
    selectVersion,
    snapshot,
  } = useHarnessStore();

  useEffect(() => {
    fetchVersions();
    fetchProposals();
    const interval = setInterval(() => {
      fetchVersions();
      fetchProposals();
    }, 15_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar (v58 评测看板) */}
      <div className="flex border-b bg-white">
        <button
          onClick={() => setTab('harness')}
          className={`px-4 py-2 text-sm border-b-2 ${
            tab === 'harness' ? 'border-teal-500 text-teal-600 font-medium' : 'border-transparent text-gray-500'
          }`}
        >
          Self-Evolving Harness
        </button>
        <button
          onClick={() => setTab('dashboard')}
          className={`px-4 py-2 text-sm border-b-2 ${
            tab === 'dashboard' ? 'border-teal-500 text-teal-600 font-medium' : 'border-transparent text-gray-500'
          }`}
        >
          评测看板
        </button>
      </div>

      {tab === 'dashboard' ? (
        <EvalDashboard />
      ) : (
  <div className="flex h-full">
      <div className="w-1/2 border-r overflow-y-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold">Self-Evolving Harness</h1>
            <p className="text-xs text-gray-500 mt-1">
              版本档案库 · 行为证据评估 · 可证伪契约 · promote/rollback
            </p>
          </div>
          <button
            onClick={() => snapshot({ source: 'manual', status: 'experimental' })}
            className="px-3 py-1.5 bg-teal-600 text-white rounded text-sm hover:bg-teal-700"
          >
            打快照
          </button>
        </div>

        <div className="space-y-2">
          {versions.length === 0 && (
            <div className="text-gray-500 text-sm">
              暂无 harness 版本。点击「打快照」捕获当前 harness（system prompt + subagents + 工具签名 + skills + CLAUDE.md 哈希）。
            </div>
          )}
          {versions.map((v) => (
            <VersionCard
              key={v.id}
              version={v}
              isPromoted={promotedId === v.id}
              selected={selectedVersionId === v.id}
              onSelect={() => selectVersion(v.id)}
            />
          ))}
        </div>

        <div className="mt-6">
          <h2 className="text-sm font-medium mb-2 text-gray-700">提案历史（Proposals）</h2>
          <div className="space-y-1">
            {proposals.length === 0 && (
              <div className="text-gray-400 text-xs">暂无提案。在右侧面板提交一个 mutation 提案以触发 Meta-Loop。</div>
            )}
            {proposals.map((p) => (
              <ProposalCard key={p.id} proposal={p} versions={versions} />
            ))}
          </div>
        </div>
      </div>

      <div className="w-1/2 overflow-y-auto p-4">
        {selectedVersionId ? (
          <VersionDetailPanel versionId={selectedVersionId} />
        ) : (
          <ProposalFormPanel />
        )}
      </div>
    </div>
      )}
    </div>
  );
}

function VersionCard({
  version,
  isPromoted,
  selected,
  onSelect,
}: {
  version: HarnessVersion;
  isPromoted: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`border rounded p-3 cursor-pointer hover:bg-gray-50 ${
        selected ? 'ring-2 ring-teal-400' : ''
      }`}
    >
      <div className="flex items-center justify-between">
        <code className="text-xs text-gray-600">{version.id.slice(0, 20)}…</code>
        <div className="flex gap-1">
          {isPromoted && (
            <span className="text-xs px-2 py-0.5 rounded bg-teal-100 text-teal-700">当前线上</span>
          )}
          <span className={`text-xs px-2 py-0.5 rounded ${STATUS_COLORS[version.status] ?? 'bg-gray-100'}`}>
            {version.status}
          </span>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
        <span>source: {version.source}</span>
        <span>{new Date(version.created_at).toLocaleString()}</span>
      </div>
      <div className="mt-1 text-xs text-gray-400 font-mono">hash: {version.hash.slice(0, 16)}…</div>
      {version.notes && <div className="mt-1 text-xs text-gray-600 line-clamp-1">{version.notes}</div>}
    </div>
  );
}

function ProposalCard({ proposal, versions }: { proposal: HarnessProposal; versions: HarnessVersion[] }) {
  const baseline = versions.find((v) => v.id === proposal.baseline_version_id);
  const proposed = versions.find((v) => v.id === proposal.proposed_version_id);
  return (
    <div className="border rounded p-2 text-xs">
      <div className="flex items-center justify-between">
        <code className="text-gray-600">{proposal.id.slice(0, 20)}…</code>
        {proposal.verdict && (
          <span className={`text-xs px-1.5 py-0.5 rounded ${VERDICT_COLORS[proposal.verdict] ?? 'bg-gray-100'}`}>
            {proposal.verdict}
          </span>
        )}
      </div>
      <div className="mt-1 text-gray-700 line-clamp-1">{proposal.hypothesis}</div>
      <div className="mt-1 text-gray-500">
        base → prop: {baseline?.hash.slice(0, 8)} → {proposed?.hash.slice(0, 8)}
      </div>
    </div>
  );
}

function VersionDetailPanel({ versionId }: { versionId: string }) {
  const [detail, setDetail] = useState<{ version: HarnessVersion; manifest: HarnessManifest | null } | null>(null);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [loading, setLoading] = useState(true);
  const { promote, rollback, getDetail, getDiff, promotedId } = useHarnessStore();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const d = await getDetail(versionId);
        if (cancelled) return;
        setDetail(d);
        // diff against promoted (if different)
        if (promotedId && promotedId !== versionId) {
          const df = await getDiff(promotedId, versionId);
          if (!cancelled) setDiff(df);
        } else {
          setDiff(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
  }, [versionId, promotedId]);

  if (loading && !detail) return <div className="text-gray-500">加载中…</div>;
  if (!detail) return <div className="text-red-600">版本不存在</div>;
  const v = detail.version;
  const isPromoted = promotedId === v.id;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold">版本详情</h2>
        <div className="flex gap-2">
          {!isPromoted && (
            <>
              <button
                onClick={() => promote(v.id)}
                className="px-2 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700"
              >
                promote
              </button>
              <button
                onClick={() => rollback(v.id)}
                className="px-2 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700"
              >
                rollback 到此版本
              </button>
            </>
          )}
          {isPromoted && <span className="text-xs text-teal-700">当前线上版本</span>}
        </div>
      </div>

      <div className="text-xs text-gray-600 space-y-1 mb-4">
        <div>ID: <code className="bg-gray-100 px-1">{v.id}</code></div>
        <div>hash: <code className="bg-gray-100 px-1">{v.hash}</code></div>
        <div>parent: <code className="bg-gray-100 px-1">{v.parent_id ?? '(root)'}</code></div>
        <div>status: <code className="bg-gray-100 px-1">{v.status}</code> · source: {v.source}</div>
        <div>created: {new Date(v.created_at).toLocaleString()}</div>
        {v.promoted_at && <div>promoted: {new Date(v.promoted_at).toLocaleString()}</div>}
      </div>

      {diff && (diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0) && (
        <div className="mb-4">
          <h3 className="font-medium text-sm mb-2">与当前线上版本的 diff</h3>
          <div className="space-y-1 text-xs">
            {diff.added.map((a) => (
              <div key={a} className="text-green-700">+ {a}</div>
            ))}
            {diff.removed.map((a) => (
              <div key={a} className="text-red-700">- {a}</div>
            ))}
            {diff.changed.map((c) => (
              <div key={c.field} className="text-yellow-700">
                ~ {c.field}<br />
                <span className="text-gray-500">  from: {c.from_preview}…</span><br />
                <span className="text-gray-500">  to:   {c.to_preview}…</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.manifest && (
        <div>
          <h3 className="font-medium text-sm mb-2">Manifest</h3>
          <div className="text-xs space-y-2">
            <div>
              <div className="text-gray-700 font-medium">Subagents ({Object.keys(detail.manifest.subagents).length})</div>
              <ul className="ml-3 list-disc">
                {Object.entries(detail.manifest.subagents).map(([k, s]) => (
                  <li key={k}>
                    <code className="bg-gray-100 px-1">{k}</code> — {s.description.slice(0, 60)}…
                    <div className="text-gray-400 ml-2">tools: {s.tools.join(', ') || '(none)'}</div>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-gray-700 font-medium">Tools ({detail.manifest.tool_signatures.length})</div>
              <div className="text-gray-500 ml-3">
                {detail.manifest.tool_signatures.map((t) => t.name).join(', ')}
              </div>
            </div>
            <div>
              <div className="text-gray-700 font-medium">Skills ({detail.manifest.skill_ids.length})</div>
              <div className="text-gray-500 ml-3">{detail.manifest.skill_ids.join(', ') || '(none)'}</div>
            </div>
            <div>
              <div className="text-gray-700 font-medium">CLAUDE.md hash</div>
              <code className="bg-gray-100 px-1 text-gray-500">{detail.manifest.claude_md_hash.slice(0, 24)}…</code>
            </div>
            <div>
              <div className="text-gray-700 font-medium">System prompt (前 400 字)</div>
              <pre className="bg-gray-50 p-2 rounded text-xs whitespace-pre-wrap max-h-48 overflow-y-auto">
                {detail.manifest.system_prompt.slice(0, 400)}…
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProposalFormPanel() {
  const { submitProposal, versions, promotedId } = useHarnessStore();
  const [hypothesis, setHypothesis] = useState('');
  const [expectedBehavior, setExpectedBehavior] = useState('');
  const [mutationPatch, setMutationPatch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const baselineId = promotedId ?? versions[0]?.id ?? '';

  const submit = async () => {
    if (!hypothesis || !expectedBehavior || !mutationPatch) {
      setError('hypothesis / expected_behavior / mutation_patch 必填');
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const r = await submitProposal({
        hypothesis,
        expected_behavior: expectedBehavior,
        mutation_patch: mutationPatch,
        baseline_version_id: baselineId || undefined,
      });
      setResult(r);
      setHypothesis('');
      setExpectedBehavior('');
      setMutationPatch('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h2 className="text-lg font-bold mb-2">提交 Harness 变异提案</h2>
      <p className="text-xs text-gray-600 mb-4">
        Meta-Loop 会：① 把当前 harness 注册为 proposed 版本 → ② 对 baseline + proposed 跑 eval →
        ③ 仅当 proposed **严格改进且无新增 fail** 才 promote，否则 rollback（保留为垫脚石）。
        判定**只看行为证据**，不看本提案的论证文本。
      </p>
      {!baselineId && (
        <div className="text-xs text-yellow-700 mb-3">
          ⚠ 尚无 baseline 版本。请先点击「打快照」并把它 promote 作为 baseline。
        </div>
      )}
      <div className="space-y-3">
        <div>
          <label className="text-xs text-gray-700">hypothesis（假设：改什么、为什么）</label>
          <textarea
            value={hypothesis}
            onChange={(e) => setHypothesis(e.target.value)}
            rows={2}
            className="w-full border rounded p-2 text-sm"
            placeholder="例：在 system prompt 末尾加一句'先思考再编码'，预期提高 code-generation case 的 pass 率"
          />
        </div>
        <div>
          <label className="text-xs text-gray-700">expected_behavior（预期行为）</label>
          <textarea
            value={expectedBehavior}
            onChange={(e) => setExpectedBehavior(e.target.value)}
            rows={2}
            className="w-full border rounded p-2 text-sm"
            placeholder="例：code-generation 的 def add 断言通过；不引入新的 fail"
          />
        </div>
        <div>
          <label className="text-xs text-gray-700">mutation_patch（变异 patch，文本形式记录意图）</label>
          <textarea
            value={mutationPatch}
            onChange={(e) => setMutationPatch(e.target.value)}
            rows={6}
            className="w-full border rounded p-2 text-sm font-mono"
            placeholder={'--- CLAUDE.md\n+++ CLAUDE.md\n@@ -1,3 +1,4 @@\n+先思考再编码。'}
          />
        </div>
        <button
          onClick={submit}
          disabled={submitting || !baselineId}
          className="px-3 py-1.5 bg-teal-600 text-white rounded text-sm hover:bg-teal-700 disabled:opacity-50"
        >
          {submitting ? '评估中…' : '提交并运行 Meta-Loop'}
        </button>
        {error && <div className="text-red-600 text-xs">{error}</div>}
        {result && (
          <div className="border rounded p-3 text-xs bg-gray-50">
            <div className="flex items-center gap-2 mb-2">
              <span className="font-medium">verdict:</span>
              <span className={`px-2 py-0.5 rounded ${VERDICT_COLORS[result.verdict] ?? 'bg-gray-100'}`}>
                {result.verdict}
              </span>
            </div>
            <div className="text-gray-600">
              baseline: {result.baselineAggregate.passed}/{result.baselineAggregate.total} ·
              proposed: {result.proposedAggregate.passed}/{result.proposedAggregate.total}
            </div>
            <pre className="mt-2 text-xs whitespace-pre-wrap text-gray-700 max-h-64 overflow-y-auto">
              {result.traceSummary}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
