import { useEffect, useRef, useState } from 'react';
import { RefreshCw, ArrowLeft, Camera, MousePointerClick } from 'lucide-react';
import { useSandboxStore } from '../../stores/sandbox';
import { wsManager } from '../../api/ws';
import { sandboxApi } from '../../api/sandbox';
import { showToast } from '../../utils/toast';

interface BrowserViewProps {
  sessionId: string;
}

export function BrowserView({ sessionId }: BrowserViewProps) {
  const frame = useSandboxStore((s) => s.browserFrames[sessionId] ?? null);
  const started = useSandboxStore((s) => s.browserStartedSessions.has(sessionId));
  const requestBrowserStart = useSandboxStore((s) => s.startBrowser);
  const [fps, setFps] = useState(0);
  const [url, setUrl] = useState('');
  const [interactMode, setInteractMode] = useState(false);
  const frameCountRef = useRef(0);
  const imgWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const offFrame = wsManager.on('sandbox_browser_frame', (data: any) => {
      if (data?.sessionId === sessionId) {
        frameCountRef.current += 1;
      }
    });
    const offErr = wsManager.on('sandbox_error', (data: any) => {
      if (data?.sessionId === sessionId) console.error('[sandbox browser]', data.error);
    });

    return () => {
      offFrame();
      offErr();
    };
  }, [sessionId]);

  useEffect(() => {
    if (!started) {
      frameCountRef.current = 0;
      setFps(0);
      return;
    }
    const fpsTimer = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);

    return () => {
      clearInterval(fpsTimer);
    };
  }, [started]);

  useEffect(() => () => {
    useSandboxStore.getState().unsubscribeBrowser(sessionId);
  }, [sessionId]);

  // 同步当前 URL（启动后取一次）
  useEffect(() => {
    if (!started) return;
    sandboxApi.browserScreenshot(sessionId).then((r) => {
      if (r?.url) setUrl(r.url);
    }).catch(() => {});
  }, [started, sessionId]);

  const navigate = async (target: string) => {
    if (!target) return;
    try {
      await sandboxApi.browserNavigate(sessionId, target);
      setUrl(target);
    } catch (e: any) {
      showToast('导航失败', e?.message ?? '');
    }
  };

  const onNavigate = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      let target = url.trim();
      if (!target) return;
      if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
      navigate(target);
    }
  };

  const onFrameClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!interactMode) return;
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const naturalW = img.naturalWidth || rect.width;
    const naturalH = img.naturalHeight || rect.height;
    // 换算到页面坐标（截图即页面视口）
    const x = Math.round(((e.clientX - rect.left) / rect.width) * naturalW);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * naturalH);
    try {
      await sandboxApi.browserClickAt(sessionId, x, y);
    } catch (err: any) {
      showToast('点击失败', err?.message ?? '');
    }
  };

  const onWheel = async (e: React.WheelEvent<HTMLImageElement>) => {
    if (!interactMode) return;
    try {
      await sandboxApi.browserScroll(sessionId, 0, Math.round(e.deltaY));
    } catch {
      /* ignore */
    }
  };

  const refresh = async () => {
    try {
      await sandboxApi.browserEvaluate(sessionId, 'location.reload()');
    } catch (e: any) {
      showToast('刷新失败', e?.message ?? '');
    }
  };

  const back = async () => {
    try {
      await sandboxApi.browserEvaluate(sessionId, 'history.back()');
    } catch {
      /* ignore */
    }
  };

  const screenshot = async () => {
    try {
      const r = await sandboxApi.browserScreenshot(sessionId);
      if (r?.screenshot) {
        const w = window.open();
        w?.document.write(`<img src="${r.screenshot}" style="max-width:100%">`);
      }
    } catch (e: any) {
      showToast('截图失败', e?.message ?? '');
    }
  };

  const startBrowser = async () => {
    try {
      await requestBrowserStart(sessionId);
    } catch (e: any) {
      showToast('启动浏览器失败', e?.message ?? '');
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#0f0f14]">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 bg-[#1a1b26] border-b border-[#2a2b36]">
        <button onClick={back} title="后退" className="p-1.5 rounded hover:bg-[#2a2b36] text-neutral-400 hover:text-neutral-200">
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button onClick={refresh} title="刷新" className="p-1.5 rounded hover:bg-[#2a2b36] text-neutral-400 hover:text-neutral-200">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={onNavigate}
          placeholder="输入地址回车导航"
          className="flex-1 min-w-0 px-2 py-1 text-xs bg-[#0f0f14] border border-[#2a2b36] rounded text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-emerald-500/50"
        />
        <button onClick={screenshot} title="截图" className="p-1.5 rounded hover:bg-[#2a2b36] text-neutral-400 hover:text-neutral-200">
          <Camera className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setInteractMode((v) => !v)}
          title="交互模式：开启后可在帧上点击/滚动"
          className={`p-1.5 rounded ${interactMode ? 'bg-emerald-600/30 text-emerald-400 border border-emerald-500/40' : 'hover:bg-[#2a2b36] text-neutral-400 hover:text-neutral-200 border border-transparent'}`}
        >
          <MousePointerClick className="w-3.5 h-3.5" />
        </button>
        <div className="flex items-center gap-1.5 ml-1">
          <span className={`inline-block w-2 h-2 rounded-full ${started ? 'bg-green-400' : 'bg-neutral-500'}`} />
          <span className="text-[10px] text-neutral-500">{started ? `${fps}fps` : '未启动'}</span>
        </div>
      </div>

      {/* Frame */}
      <div ref={imgWrapRef} className="flex-1 min-h-0 flex items-center justify-center overflow-hidden relative">
        {frame ? (
          <img
            src={frame}
            alt="sandbox browser"
            onClick={onFrameClick}
            onWheel={onWheel}
            className={`max-w-full max-h-full object-contain ${interactMode ? 'cursor-pointer' : ''}`}
            draggable={false}
          />
        ) : started ? (
          <div className="text-neutral-500 text-sm">等待首帧...</div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-neutral-500">
            <div className="text-sm">浏览器尚未启动</div>
            <button
              onClick={startBrowser}
              className="px-3 py-1.5 rounded bg-emerald-600 text-white text-xs hover:bg-emerald-500"
            >
              启动浏览器
            </button>
            <div className="text-[11px] text-neutral-600 text-center max-w-xs">
              点击上方按钮启动；启动后可在工具栏输入网址回车导航，或在右侧 Browser Use Agent 输入任务自动操作。
            </div>
          </div>
        )}
        {interactMode && (
          <div className="absolute top-2 right-2 text-[10px] px-2 py-1 rounded bg-emerald-600/20 border border-emerald-500/40 text-emerald-300">
            交互模式：点击/滚动转发到浏览器
          </div>
        )}
      </div>
    </div>
  );
}
