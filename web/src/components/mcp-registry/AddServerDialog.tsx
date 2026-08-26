import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  open: boolean;
  onClose: () => void;
  onAdd: (input: { name: string; description?: string }) => Promise<void>;
}

export function AddServerDialog({ open, onClose, onAdd }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      toast.error('名称不能为空');
      return;
    }
    setSubmitting(true);
    try {
      await onAdd({ name: name.trim(), description: description.trim() || undefined });
      toast.success('已创建服务分组');
      onClose();
    } catch (err: any) {
      toast.error(err?.message || '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !submitting && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建服务分组</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>名称 *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 weather-service"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label>描述</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="该分组的用途说明"
              rows={2}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={submitting}>
              取消
            </Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting && <Loader2 size={16} className="animate-spin mr-1" />}
              创建
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
