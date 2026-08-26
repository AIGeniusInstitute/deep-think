import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  type CandidateTool,
} from '../../stores/mcp-registry';

interface Props {
  open: boolean;
  onClose: () => void;
  serverId: string;
  onImport: (serverId: string, tools: CandidateTool[]) => Promise<{ created: number; errors: { index: number; error: string }[] }>;
  onPreview: (serverId: string, source: 'json' | 'url', content: string, includePaths?: string[], baseUrl?: string) => Promise<CandidateTool[]>;
}

export function OpenApiImportDialog({ open, onClose, serverId, onImport, onPreview }: Props) {
  const [source, setSource] = useState<'json' | 'url'>('json');
  const [content, setContent] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [includePaths, setIncludePaths] = useState('');
  const [candidates, setCandidates] = useState<CandidateTool[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  const reset = () => {
    setContent('');
    setBaseUrl('');
    setIncludePaths('');
    setCandidates([]);
    setSelected(new Set());
  };

  const doPreview = async () => {
    if (!content.trim()) { toast.error('请填写 OpenAPI 文档或 URL'); return; }
    setLoading(true);
    try {
      const paths = includePaths.trim()
        ? includePaths.split(/[,\s]+/).filter(Boolean)
        : undefined;
      const list = await onPreview(serverId, source, content.trim(), paths, baseUrl.trim() || undefined);
      setCandidates(list);
      setSelected(new Set(list.map((_, i) => i)));
      toast.success(`解析到 ${list.length} 个候选工具`);
    } catch (e: any) {
      toast.error(e?.message || '解析失败');
    } finally {
      setLoading(false);
    }
  };

  const toggle = (i: number) => {
    const next = new Set(selected);
    if (next.has(i)) next.delete(i); else next.add(i);
    setSelected(next);
  };

  const doConfirm = async () => {
    const picks = candidates.filter((_, i) => selected.has(i));
    if (picks.length === 0) { toast.error('请至少选择一个工具'); return; }
    setImporting(true);
    try {
      const r = await onImport(serverId, picks);
      toast.success(`已导入 ${r.created} 个工具${r.errors.length ? `，${r.errors.length} 个失败` : ''}`);
      reset();
      onClose();
    } catch (e: any) {
      toast.error(e?.message || '导入失败');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !loading && !importing) { reset(); onClose(); } }}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>从 OpenAPI 导入</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="flex gap-2">
            <Button size="sm" variant={source === 'json' ? 'default' : 'outline'} onClick={() => setSource('json')}>粘贴 JSON</Button>
            <Button size="sm" variant={source === 'url' ? 'default' : 'outline'} onClick={() => setSource('url')}>URL 拉取</Button>
          </div>
          {source === 'json' ? (
            <div className="space-y-2">
              <Label>OpenAPI / Swagger JSON</Label>
              <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={8} className="font-mono text-xs" placeholder='{"openapi":"3.0.0",...}' />
            </div>
          ) : (
            <div className="space-y-2">
              <Label>OpenAPI 文档 URL</Label>
              <Input value={content} onChange={(e) => setContent(e.target.value)} placeholder="https://api.example.com/openapi.json" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>基础 URL（可选，覆盖 servers）</Label>
              <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com" />
            </div>
            <div className="space-y-2">
              <Label>仅导入路径（逗号分隔，可选）</Label>
              <Input value={includePaths} onChange={(e) => setIncludePaths(e.target.value)} placeholder="/v1/current, /v1/forecast" />
            </div>
          </div>
          <Button onClick={doPreview} disabled={loading} variant="outline">
            {loading && <Loader2 size={16} className="animate-spin mr-1" />}
            解析预览
          </Button>

          {candidates.length > 0 && (
            <div className="border rounded-md">
              <div className="px-3 py-2 border-b text-sm font-medium flex items-center justify-between">
                <span>候选工具 ({candidates.length})</span>
                <span className="text-muted-foreground">已选 {selected.size}</span>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {candidates.map((t, i) => (
                  <label key={i} className="flex items-start gap-3 px-3 py-2 border-b last:border-0 hover:bg-muted/50 cursor-pointer">
                    <Checkbox
                      checked={selected.has(i)}
                      onCheckedChange={() => toggle(i)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-mono">
                        <span className="text-muted-foreground mr-2">{t.httpBinding.method}</span>
                        {t.name}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{t.description}</div>
                      <div className="text-xs text-muted-foreground truncate font-mono">{t.httpBinding.url}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => { reset(); onClose(); }} disabled={importing}>取消</Button>
            <Button onClick={doConfirm} disabled={importing || candidates.length === 0}>
              {importing && <Loader2 size={16} className="animate-spin mr-1" />}
              导入选中 ({selected.size})
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
