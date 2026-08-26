import { useState, useEffect } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  type RegistryHttpBinding,
  type RegistryInputSchema,
  type RegistryTool,
} from '../../stores/mcp-registry';

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (tool: {
    name: string;
    description?: string;
    inputSchema: RegistryInputSchema;
    httpBinding: RegistryHttpBinding;
    enabled?: boolean;
  }) => Promise<void>;
  initial?: RegistryTool | null;
  serverName?: string;
}

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

type KV = { key: string; value: string };

function toKVs(obj: Record<string, string> | undefined): KV[] {
  if (!obj) return [];
  return Object.entries(obj).map(([key, value]) => ({ key, value }));
}
function fromKVs(kvs: KV[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const { key, value } of kvs) {
    if (key.trim()) out[key.trim()] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function ToolEditorDialog({ open, onClose, onSave, initial, serverName }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [method, setMethod] = useState<RegistryHttpBinding['method']>('GET');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<KV[]>([]);
  const [pathMap, setPathMap] = useState<KV[]>([]);
  const [queryMap, setQueryMap] = useState<KV[]>([]);
  const [headerMap, setHeaderMap] = useState<KV[]>([]);
  const [bodyMap, setBodyMap] = useState<KV[]>([]);
  const [bodyTemplate, setBodyTemplate] = useState('');
  const [extract, setExtract] = useState('');
  const [toText, setToText] = useState('');
  const [timeoutMs, setTimeoutMs] = useState('15000');
  const [authHeaderName, setAuthHeaderName] = useState('');
  const [authHeaderValue, setAuthHeaderValue] = useState('');
  const [inputSchema, setInputSchema] = useState('{\n  "type": "object",\n  "properties": {},\n  "required": []\n}');
  const [enabled, setEnabled] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setDescription(initial.description);
      setMethod(initial.httpBinding.method);
      setUrl(initial.httpBinding.url);
      setHeaders(toKVs(initial.httpBinding.headers));
      setPathMap(toKVs(initial.httpBinding.paramMapping?.path));
      setQueryMap(toKVs(initial.httpBinding.paramMapping?.query));
      setHeaderMap(toKVs(initial.httpBinding.paramMapping?.header));
      setBodyMap(toKVs(initial.httpBinding.paramMapping?.body));
      setBodyTemplate(
        initial.httpBinding.bodyTemplate ? JSON.stringify(initial.httpBinding.bodyTemplate, null, 2) : '',
      );
      setExtract(initial.httpBinding.responseMapping?.extract ?? '');
      setToText(initial.httpBinding.responseMapping?.toText ?? '');
      setTimeoutMs(String(initial.httpBinding.timeoutMs ?? 15000));
      setAuthHeaderName(initial.httpBinding.authHeader?.name ?? '');
      setAuthHeaderValue(initial.httpBinding.authHeader?.value ?? '');
      setInputSchema(JSON.stringify(initial.inputSchema, null, 2));
      setEnabled(initial.enabled);
    } else {
      setName('');
      setDescription('');
      setMethod('GET');
      setUrl('');
      setHeaders([]);
      setPathMap([]);
      setQueryMap([]);
      setHeaderMap([]);
      setBodyMap([]);
      setBodyTemplate('');
      setExtract('');
      setToText('');
      setTimeoutMs('15000');
      setAuthHeaderName('');
      setAuthHeaderValue('');
      setInputSchema('{\n  "type": "object",\n  "properties": {},\n  "required": []\n}');
      setEnabled(true);
    }
  }, [open, initial]);

  const validate = (): string | null => {
    if (!name.trim()) return '工具名不能为空';
    if (!NAME_RE.test(name.trim())) return '工具名须匹配 /^[a-zA-Z_][a-zA-Z0-9_]*$/';
    if (!url.trim()) return 'URL 不能为空';
    if (!/^https?:\/\//i.test(url.trim())) return 'URL 必须是 http(s) 地址';
    try { JSON.parse(inputSchema); } catch { return 'inputSchema 不是合法 JSON'; }
    if (bodyTemplate.trim()) {
      try { JSON.parse(bodyTemplate); } catch { return 'bodyTemplate 不是合法 JSON'; }
    }
    const t = Number(timeoutMs);
    if (!Number.isFinite(t) || t < 500 || t > 60000) return '超时须为 500–60000 毫秒';
    return null;
  };

  const submit = async () => {
    const err = validate();
    if (err) { toast.error(err); return; }
    let parsedSchema: RegistryInputSchema;
    try { parsedSchema = JSON.parse(inputSchema); } catch { return; }
    const hb: RegistryHttpBinding = {
      method,
      url: url.trim(),
      ...(fromKVs(headers) ? { headers: fromKVSafe(headers) } : {}),
      paramMapping: {
        ...(fromKVs(pathMap) ? { path: fromKVSafe(pathMap) } : {}),
        ...(fromKVs(queryMap) ? { query: fromKVSafe(queryMap) } : {}),
        ...(fromKVs(headerMap) ? { header: fromKVSafe(headerMap) } : {}),
        ...(fromKVs(bodyMap) ? { body: fromKVSafe(bodyMap) } : {}),
      },
      ...(bodyTemplate.trim() ? { bodyTemplate: JSON.parse(bodyTemplate) } : {}),
      ...(authHeaderName.trim() && authHeaderValue
        ? { authHeader: { name: authHeaderName.trim(), value: authHeaderValue } }
        : {}),
      responseMapping: {
        ...(extract.trim() ? { extract: extract.trim() } : {}),
        ...(toText.trim() ? { toText: toText.trim() } : {}),
      },
      timeoutMs: Number(timeoutMs),
    };
    // 去空 paramMapping
    if (Object.keys(hb.paramMapping!).length === 0) delete hb.paramMapping;
    setSubmitting(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || undefined,
        inputSchema: parsedSchema,
        httpBinding: hb,
        enabled,
      });
      toast.success(initial ? '工具已更新' : '工具已创建');
      onClose();
    } catch (e: any) {
      toast.error(e?.message || '保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑工具' : '新建工具'}{serverName ? ` · ${serverName}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>工具名 *</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="get_weather" />
            </div>
            <div className="space-y-2">
              <Label>超时(ms)</Label>
              <Input value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} type="number" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>描述</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="查询指定城市的天气" />
          </div>
          <div className="space-y-2">
            <Label>inputSchema (JSON Schema object)</Label>
            <Textarea value={inputSchema} onChange={(e) => setInputSchema(e.target.value)} rows={6} className="font-mono text-xs" />
          </div>

          <div className="border-t pt-4 space-y-3">
            <h4 className="text-sm font-semibold">HTTP 绑定</h4>
            <div className="grid grid-cols-[120px_1fr] gap-3">
              <div className="space-y-2">
                <Label>方法</Label>
                <Select value={method} onValueChange={(v) => setMethod(v as RegistryHttpBinding['method'])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>URL *</Label>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/v1/current" />
              </div>
            </div>
          </div>

          <KVEditor label="静态 Headers" kvs={headers} setKvs={setHeaders} keyHint="header 名" />
          <KVEditor label="Path 映射 (arg→占位)" kvs={pathMap} setKvs={setPathMap} keyHint="argName" valHint="url 占位名" />
          <KVEditor label="Query 映射 (arg→参数)" kvs={queryMap} setKvs={setQueryMap} keyHint="argName" valHint="query 名" />
          <KVEditor label="Header 映射 (arg→请求头)" kvs={headerMap} setKvs={setHeaderMap} keyHint="argName" valHint="header 名" />
          <KVEditor label="Body 映射 (arg→字段)" kvs={bodyMap} setKvs={setBodyMap} keyHint="argName" valHint="字段名" />

          <div className="space-y-2">
            <Label>Body 模板 (静态 JSON，可选)</Label>
            <Textarea value={bodyTemplate} onChange={(e) => setBodyTemplate(e.target.value)} rows={3} className="font-mono text-xs" placeholder='{"format":"json"}' />
          </div>

          <div className="border-t pt-4 space-y-3">
            <h4 className="text-sm font-semibold">凭证（不透传 Agent）</h4>
            <div className="grid grid-cols-[1fr_2fr] gap-3">
              <div className="space-y-2">
                <Label>Header 名</Label>
                <Input value={authHeaderName} onChange={(e) => setAuthHeaderName(e.target.value)} placeholder="X-API-Key" />
              </div>
              <div className="space-y-2">
                <Label>Header 值</Label>
                <Input value={authHeaderValue} onChange={(e) => setAuthHeaderValue(e.target.value)} placeholder="sk-..." type="password" />
              </div>
            </div>
          </div>

          <div className="border-t pt-4 space-y-3">
            <h4 className="text-sm font-semibold">响应映射</h4>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>提取路径</Label>
                <Input value={extract} onChange={(e) => setExtract(e.target.value)} placeholder="data.current" />
              </div>
              <div className="space-y-2">
                <Label>文本模板</Label>
                <Input value={toText} onChange={(e) => setToText(e.target.value)} placeholder="{{temperature}}° / {{condition}}" />
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            启用
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={submitting}>取消</Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting && <Loader2 size={16} className="animate-spin mr-1" />}
              {initial ? '保存' : '创建'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function fromKVSafe(kvs: KV[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of kvs) if (key.trim()) out[key.trim()] = value;
  return out;
}

function KVEditor({
  label, kvs, setKvs, keyHint, valHint,
}: {
  label: string;
  kvs: KV[];
  setKvs: (v: KV[]) => void;
  keyHint?: string;
  valHint?: string;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="space-y-1">
        {kvs.map((kv, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_32px] gap-2">
            <Input
              value={kv.key}
              placeholder={keyHint}
              onChange={(e) => {
                const next = [...kvs];
                next[i] = { ...next[i], key: e.target.value };
                setKvs(next);
              }}
            />
            <Input
              value={kv.value}
              placeholder={valHint}
              onChange={(e) => {
                const next = [...kvs];
                next[i] = { ...next[i], value: e.target.value };
                setKvs(next);
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setKvs(kvs.filter((_, j) => j !== i))}
            >
              <X size={14} />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setKvs([...kvs, { key: '', value: '' }])}>
          <Plus size={14} className="mr-1" /> 添加
        </Button>
      </div>
    </div>
  );
}
