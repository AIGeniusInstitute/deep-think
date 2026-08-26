import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Server, Boxes, FileJson, FlaskConical, Pencil, Trash2, Power } from 'lucide-react';
import { SearchInput } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useMcpRegistryStore, type RegistryTool } from '../stores/mcp-registry';
import { AddServerDialog } from '../components/mcp-registry/AddServerDialog';
import { ToolEditorDialog } from '../components/mcp-registry/ToolEditorDialog';
import { OpenApiImportDialog } from '../components/mcp-registry/OpenApiImportDialog';
import { TestToolDialog } from '../components/mcp-registry/TestToolDialog';

export function McpRegistryPage() {
  const {
    servers, tools, selectedServerId,
    loading, loadingTools, error,
    loadServers, selectServer,
    addServer, updateServer, deleteServer,
    addTool, updateTool, deleteTool,
    testTool, previewOpenApi, confirmImport,
  } = useMcpRegistryStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [showAddServer, setShowAddServer] = useState(false);
  const [editingTool, setEditingTool] = useState<RegistryTool | null>(null);
  const [showToolEditor, setShowToolEditor] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [testToolState, setTestToolState] = useState<RegistryTool | null>(null);
  const [showTest, setShowTest] = useState(false);

  useEffect(() => { loadServers(); }, [loadServers]);

  const filtered = servers.filter((s) => {
    const q = searchQuery.toLowerCase();
    return !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q);
  });
  const selectedServer = servers.find((s) => s.id === selectedServerId) || null;

  const openNewTool = () => { setEditingTool(null); setShowToolEditor(true); };
  const openEditTool = (t: RegistryTool) => { setEditingTool(t); setShowToolEditor(true); };
  const openTest = (t: RegistryTool) => { setTestToolState(t); setShowTest(true); };

  const onSaveTool = async (payload: Parameters<typeof addTool>[1]) => {
    if (editingTool) {
      await updateTool(editingTool.id, payload);
    } else if (selectedServerId) {
      await addTool(selectedServerId, payload);
    }
  };

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-7xl mx-auto">
        <div className="bg-background border-b border-border px-6 py-4">
          <PageHeader
            title="MCP 注册中心"
            subtitle={`共 ${servers.length} 个服务分组 · Agent 通过 __registry MCP 挂载`}
            actions={
              <div className="flex items-center gap-3">
                <Button variant="outline" onClick={() => loadServers()} disabled={loading}>
                  <RefreshCw size={18} className={loading ? 'animate-spin' : ''} /> 刷新
                </Button>
                <Button onClick={() => setShowAddServer(true)}>
                  <Plus size={18} /> 新建分组
                </Button>
              </div>
            }
          />
        </div>

        <div className="flex gap-6 p-4">
          {/* Left: server list */}
          <div className="w-full lg:w-1/3 xl:w-2/6">
            <div className="mb-4">
              <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder="搜索服务分组" />
            </div>
            <div className="space-y-2">
              {loading && servers.length === 0 ? (
                <SkeletonCardList count={3} />
              ) : error ? (
                <Card className="border-error/20"><CardContent className="text-center text-error">{error}</CardContent></Card>
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={Boxes}
                  title={searchQuery ? '没有匹配的服务分组' : '暂无服务分组'}
                  description={searchQuery ? undefined : '新建一个分组，开始注册 HTTP 工具'}
                />
              ) : (
                filtered.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => selectServer(s.id)}
                    className={`w-full text-left p-3 rounded-lg border transition ${
                      selectedServerId === s.id
                        ? 'ring-2 ring-ring bg-brand-50 border-primary'
                        : 'border-border hover:bg-muted'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <Server size={16} className="text-muted-foreground shrink-0" />
                        <span className="font-medium truncate">{s.name}</span>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">{s.tool_count} 工具</span>
                    </div>
                    {s.description && (
                      <div className="text-xs text-muted-foreground mt-1 truncate">{s.description}</div>
                    )}
                    <div className="flex items-center justify-between mt-2">
                      <span className={`text-xs ${s.enabled ? 'text-success' : 'text-muted-foreground'}`}>
                        {s.enabled ? '启用' : '停用'}
                      </span>
                      <Switch
                        checked={s.enabled}
                        onCheckedChange={(v) => updateServer(s.id, { enabled: v })}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Right: tool list of selected server */}
          <div className="hidden lg:block lg:flex-1">
            {!selectedServer ? (
              <EmptyState
                icon={Boxes}
                title="未选择服务分组"
                description="在左侧选择或新建一个分组"
              />
            ) : (
              <div>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <h2 className="text-lg font-semibold">{selectedServer.name}</h2>
                    {selectedServer.description && (
                      <p className="text-sm text-muted-foreground">{selectedServer.description}</p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => setShowImport(true)}>
                      <FileJson size={16} /> OpenAPI 导入
                    </Button>
                    <Button size="sm" onClick={openNewTool}>
                      <Plus size={16} /> 新建工具
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (confirm(`删除分组「${selectedServer.name}」及其全部工具？`)) {
                          deleteServer(selectedServer.id);
                        }
                      }}
                    >
                      <Trash2 size={16} className="text-error" />
                    </Button>
                  </div>
                </div>

                {loadingTools ? (
                  <SkeletonCardList count={3} />
                ) : tools.length === 0 ? (
                  <EmptyState
                    icon={Power}
                    title="该分组暂无工具"
                    description="新建工具或从 OpenAPI 导入"
                  />
                ) : (
                  <div className="space-y-2">
                    {tools.map((t) => (
                      <Card key={t.id} className="border-border">
                        <CardContent className="p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-muted">{t.httpBinding.method}</span>
                                <span className="font-mono text-sm font-medium">{t.mcpName}</span>
                                {!t.enabled && (
                                  <span className="text-xs text-muted-foreground">（停用）</span>
                                )}
                              </div>
                              {t.description && (
                                <div className="text-sm text-muted-foreground mt-1">{t.description}</div>
                              )}
                              <div className="text-xs text-muted-foreground mt-1 font-mono truncate">
                                {t.httpBinding.url}
                              </div>
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <Button size="icon" variant="ghost" onClick={() => openTest(t)} title="试调">
                                <FlaskConical size={15} />
                              </Button>
                              <Button size="icon" variant="ghost" onClick={() => openEditTool(t)} title="编辑">
                                <Pencil size={15} />
                              </Button>
                              <Switch
                                checked={t.enabled}
                                onCheckedChange={(v) => updateTool(t.id, { enabled: v })}
                              />
                              <Button
                                size="icon"
                                variant="ghost"
                                onClick={() => {
                                  if (confirm(`删除工具「${t.name}」？`)) deleteTool(t.id);
                                }}
                              >
                                <Trash2 size={15} className="text-error" />
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <AddServerDialog open={showAddServer} onClose={() => setShowAddServer(false)} onAdd={addServer} />
      <ToolEditorDialog
        open={showToolEditor}
        onClose={() => setShowToolEditor(false)}
        onSave={onSaveTool}
        initial={editingTool}
        serverName={selectedServer?.name}
      />
      {selectedServer && (
        <OpenApiImportDialog
          open={showImport}
          onClose={() => setShowImport(false)}
          serverId={selectedServer.id}
          onImport={confirmImport}
          onPreview={previewOpenApi}
        />
      )}
      <TestToolDialog
        open={showTest}
        onClose={() => setShowTest(false)}
        tool={testToolState}
        onTest={testTool}
      />
    </div>
  );
}
