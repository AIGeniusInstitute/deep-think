import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { type RegistryTool } from '../../stores/mcp-registry';

interface Props {
  open: boolean;
  onClose: () => void;
  tool: RegistryTool | null;
  onTest: (id: string, args: Record<string, unknown>) => Promise<{ isError: boolean; content: { type: string; text: string }[] }>;
}

export function TestToolDialog({ open, onClose, tool, onTest }: Props) {
  const [argsText, setArgsText] = useState('{}');
  const [result, setResult] = useState<{ isError: boolean; text: string } | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    if (!tool) return;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsText);
    } catch {
      toast.error('arguments 不是合法 JSON');
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const r = await onTest(tool.id, args);
      setResult({ isError: r.isError, text: r.content.map((c) => c.text).join('\n') });
    } catch (e: any) {
      setResult({ isError: true, text: e?.message || '请求失败' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !running) { setResult(null); onClose(); } }}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>试调工具{tool ? ` · ${tool.mcpName}` : ''}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>arguments (JSON)</Label>
            <Textarea
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              rows={6}
              className="font-mono text-xs"
              placeholder='{"city":"北京"}'
            />
          </div>
          <Button onClick={run} disabled={running}>
            {running && <Loader2 size={16} className="animate-spin mr-1" />}
            执行
          </Button>
          {result && (
            <div className="space-y-2">
              <Label>结果{result.isError ? '（错误）' : ''}</Label>
              <pre
                className={`text-xs p-3 rounded-md border max-h-72 overflow-auto whitespace-pre-wrap break-all ${
                  result.isError
                    ? 'bg-error-bg/30 border-error/30 text-error'
                    : 'bg-muted border-border'
                }`}
              >
                {result.text}
              </pre>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
