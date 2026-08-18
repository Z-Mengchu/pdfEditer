import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Download,
  FileText,
  Loader2,
  MousePointer2,
  PaintBucket,
  Shapes,
  Type,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { loadPdf, renderPage, getPageViewport, extractSpans, type PdfDoc } from '@/lib/pdf/pdfjs';
import { clearEmbeddedFonts } from '@/lib/pdf/fonts';
import { exportEditedPdf } from '@/lib/pdf/exportPdf';
import { extractRawGraphics, clusterElements, type VectorElement } from '@/lib/pdf/elements';
import type { EditItem, ElementEdit, PageState, RegionEdit, Selection, SpanEdit, Tool } from '@/lib/pdf/types';
import { elementEditActive, spanDirty } from '@/lib/pdf/types';
import PageView from './PageView';
import PropertiesPanel from './PropertiesPanel';

interface Props {
  fileName: string;
  bytes: ArrayBuffer;
  onReset: () => void;
}

let regionSeq = 0;

function Thumb({ doc, pageIndex, active, onClick }: { doc: PdfDoc; pageIndex: number; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const vp = await getPageViewport(doc, pageIndex, 1);
      if (cancelled) return;
      const scale = 116 / vp.width;
      setSize({ w: vp.width * scale, h: vp.height * scale });
      if (ref.current) await renderPage(doc, pageIndex, ref.current, scale * 2);
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, pageIndex]);
  return (
    <button
      onClick={onClick}
      className={`block mx-auto rounded overflow-hidden border-2 transition-colors ${
        active ? 'border-blue-500 shadow-md' : 'border-transparent hover:border-slate-300'
      }`}
    >
      <canvas ref={ref} style={{ width: size?.w ?? 116, height: size?.h ?? 150, display: 'block' }} />
      <span className="block text-[10px] text-center py-0.5 bg-white text-muted-foreground">第 {pageIndex + 1} 页</span>
    </button>
  );
}

export default function PdfEditor({ fileName, bytes, onReset }: Props) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [pages, setPages] = useState<PageState[]>([]);
  const [pageElements, setPageElements] = useState<VectorElement[][]>([]);
  const [initMsg, setInitMsg] = useState('正在加载 PDF…');
  const [current, setCurrent] = useState(0);
  const [zoom, setZoom] = useState(1.5);
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  /* ---------- 初始化：解析所有页 ---------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        clearEmbeddedFonts(); // 新文档：清掉上一份 PDF 提取的内嵌字体
        const d = await loadPdf(bytes.slice(0));
        if (cancelled) return;
        setDoc(d);
        const states: PageState[] = [];
        const elsPerPage: VectorElement[][] = [];
        for (let i = 0; i < d.numPages; i++) {
          setInitMsg(`正在解析第 ${i + 1} / ${d.numPages} 页…`);
          const vp = await getPageViewport(d, i, 1);
          const off = document.createElement('canvas');
          await renderPage(d, i, off, 2);
          const spans = await extractSpans(d, i, off, 2);
          const pdfPage = await d.getPage(i + 1);
          const raw = await extractRawGraphics(pdfPage);
          elsPerPage.push(clusterElements(raw.paths, raw.images, i, vp.height));
          states.push({
            pageIndex: i,
            width: vp.width,
            height: vp.height,
            spans,
            regions: [],
            elementEdits: {},
          });
          if (cancelled) return;
        }
        setPages(states);
        setPageElements(elsPerPage);
        setZoom(Math.min(3, Math.max(0.8, 760 / (states[0]?.width ?? 600))));
        setInitMsg('');
      } catch (err) {
        console.error(err);
        toast.error('PDF 解析失败：' + (err instanceof Error ? err.message : String(err)));
        onReset();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bytes]);

  /* ---------- 编辑操作 ---------- */
  const updateSpan = useCallback((id: string, patch: Partial<SpanEdit>) => {
    setPages((ps) =>
      ps.map((p) => ({ ...p, spans: p.spans.map((s) => (s.id === id ? { ...s, ...patch } : s)) })),
    );
  }, []);

  const updateRegion = useCallback((id: string, patch: Partial<RegionEdit>) => {
    setPages((ps) =>
      ps.map((p) => ({ ...p, regions: p.regions.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
    );
  }, []);

  const addRegion = useCallback(
    (r: Omit<RegionEdit, 'id'>) => {
      const id = `r${Date.now()}-${regionSeq++}`;
      setPages((ps) => ps.map((p) => (p.pageIndex === r.pageIndex ? { ...p, regions: [...p.regions, { ...r, id }] } : p)));
      setSelection({ kind: 'region', id });
    },
    [],
  );

  const removeRegion = useCallback((id: string) => {
    setPages((ps) => ps.map((p) => ({ ...p, regions: p.regions.filter((r) => r.id !== id) })));
    setSelection(null);
  }, []);

  /* ---------- 矢量元素编辑 ---------- */
  const updateElement = useCallback((el: VectorElement, patch: Partial<ElementEdit>) => {
    setPages((ps) =>
      ps.map((p) => {
        if (p.pageIndex !== el.pageIndex) return p;
        const prev: ElementEdit =
          p.elementEdits[el.id] ?? {
            elementId: el.id,
            pageIndex: el.pageIndex,
            deleted: false,
            dx: 0,
            dy: 0,
            replaceImage: null,
            bgColor: '#ffffff',
          };
        return { ...p, elementEdits: { ...p.elementEdits, [el.id]: { ...prev, ...patch } } };
      }),
    );
  }, []);

  const clearElement = useCallback((el: VectorElement) => {
    setPages((ps) =>
      ps.map((p) => {
        if (p.pageIndex !== el.pageIndex) return p;
        const next = { ...p.elementEdits };
        delete next[el.id];
        return { ...p, elementEdits: next };
      }),
    );
  }, []);

  /** 元素模式框选多选产生的组合元素 */
  const addGroupElement = useCallback((el: VectorElement) => {
    setPageElements((prev) => prev.map((els, i) => (i === el.pageIndex ? [...els, el] : els)));
  }, []);

  const elementsById = useMemo(() => {
    const m = new Map<string, VectorElement>();
    for (const els of pageElements) for (const el of els) m.set(el.id, el);
    return m;
  }, [pageElements]);

  /* ---------- 键盘删除 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editingId) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
        e.preventDefault();
        if (selection.kind === 'span') updateSpan(selection.id, { deleted: true });
        else if (selection.kind === 'element') {
          const el = elementsById.get(selection.id);
          if (el) updateElement(el, { deleted: true });
        } else removeRegion(selection.id);
      }
      if (e.key === 'Escape') {
        setSelection(null);
        setEditingId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, editingId, updateSpan, removeRegion, elementsById, updateElement]);

  const selectedItem: EditItem | null = useMemo(() => {
    if (!selection) return null;
    for (const p of pages) {
      const found =
        selection.kind === 'span'
          ? p.spans.find((s) => s.id === selection.id)
          : p.regions.find((r) => r.id === selection.id);
      if (found) return found;
    }
    return null;
  }, [pages, selection]);

  const selectedElement = useMemo(
    () => (selection?.kind === 'element' ? elementsById.get(selection.id) ?? null : null),
    [selection, elementsById],
  );

  const selectedElementEdit = useMemo(() => {
    if (selection?.kind !== 'element') return null;
    for (const p of pages) {
      const e = p.elementEdits[selection.id];
      if (e) return e;
    }
    return null;
  }, [selection, pages]);

  const changeCount = useMemo(
    () =>
      pages.reduce(
        (n, p) =>
          n +
          p.spans.filter(spanDirty).length +
          p.regions.length +
          Object.values(p.elementEdits).filter(elementEditActive).length,
        0,
      ),
    [pages],
  );

  /* ---------- 重新选择文件 ---------- */
  const requestReset = useCallback(() => {
    if (changeCount > 0) {
      setResetDialogOpen(true);
    } else {
      onReset();
    }
  }, [changeCount, onReset]);

  const confirmReset = useCallback(() => {
    setResetDialogOpen(false);
    onReset();
  }, [onReset]);

  const cancelReset = useCallback(() => {
    setResetDialogOpen(false);
  }, []);

  /* ---------- 导出 ---------- */
  const doExport = async () => {
    if (pages.length === 0) return;
    setExporting(true);
    try {
      const { bytes: out, changed } = await exportEditedPdf(new Uint8Array(bytes.slice(0)), pages, elementsById);
      const blob = new Blob([out as BlobPart], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 立刻 revoke 会取消尚未开始的下载，延迟释放
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(changed ? '已导出编辑后的 PDF' : '未检测到修改，已导出原文件');
    } catch (err) {
      console.error(err);
      toast.error('导出失败：' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setExporting(false);
    }
  };

  if (!doc || pages.length === 0) {
    return (
      <div className="h-screen flex flex-col bg-slate-100 overflow-hidden">
        <header className="h-14 bg-white border-b flex items-center gap-2 px-3 shrink-0">
          <button
            onClick={requestReset}
            className="flex items-center gap-1.5 text-sm font-semibold mr-1 hover:text-blue-600"
          >
            <FileText className="w-5 h-5 text-blue-600" />
            <span className="hidden lg:inline">PDF 编辑器</span>
          </button>
          <Separator orientation="vertical" className="h-6" />
          <span className="text-sm text-muted-foreground truncate max-w-48" title={fileName}>
            {fileName}
          </span>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={requestReset} className="text-slate-600">
            <Upload className="w-4 h-4 mr-1.5" />
            <span className="hidden md:inline">重新选择文件</span>
          </Button>
        </header>
        <main className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          <p className="text-sm">{initMsg}</p>
        </main>
      </div>
    );
  }

  const page = pages[current];

  const toolBtn = (t: Tool, icon: React.ReactNode, label: string) => (
    <button
      onClick={() => setTool(t)}
      title={label}
      className={`flex items-center gap-1.5 px-3 h-9 rounded-md text-sm transition-colors ${
        tool === t ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {icon}
      <span className="hidden md:inline">{label}</span>
    </button>
  );

  return (
    <div className="h-screen flex flex-col bg-slate-100 overflow-hidden">
      {/* 工具栏 */}
      <header className="h-14 bg-white border-b flex items-center gap-2 px-3 shrink-0">
        <button
          onClick={requestReset}
          className="flex items-center gap-1.5 text-sm font-semibold mr-1 hover:text-blue-600"
          title="重新选择文件"
        >
          <FileText className="w-5 h-5 text-blue-600" />
          <span className="hidden lg:inline">PDF 编辑器</span>
        </button>
        <Separator orientation="vertical" className="h-6" />
        <span className="text-sm text-muted-foreground truncate max-w-48" title={fileName}>
          {fileName}
        </span>
        <Separator orientation="vertical" className="h-6" />
        <Button variant="ghost" size="sm" onClick={requestReset} className="text-slate-600">
          <Upload className="w-4 h-4 mr-1.5" />
          <span className="hidden md:inline">重新选择文件</span>
        </Button>
        <Separator orientation="vertical" className="h-6" />
        <div className="flex items-center gap-1">
          {toolBtn('select', <MousePointer2 className="w-4 h-4" />, '选择')}
          {toolBtn('element', <Shapes className="w-4 h-4" />, '元素')}
          {toolBtn('region', <PaintBucket className="w-4 h-4" />, '框选涂抹')}
          {toolBtn('text', <Type className="w-4 h-4" />, '文本框')}
        </div>
        <Separator orientation="vertical" className="h-6" />
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}>
            <ZoomOut className="w-4 h-4" />
          </Button>
          <span className="text-xs w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setZoom((z) => Math.min(4, z + 0.2))}>
            <ZoomIn className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground hidden md:inline">
          {changeCount > 0 ? `${changeCount} 处待导出修改` : '尚未修改'}
        </span>
        <Button onClick={doExport} disabled={exporting} className="bg-blue-600 hover:bg-blue-700">
          {exporting ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Download className="w-4 h-4 mr-1.5" />}
          导出 PDF
        </Button>
      </header>

      <div className="flex-1 flex min-h-0">
        {/* 页面缩略图 */}
        {pages.length > 1 && (
          <aside className="w-36 bg-white border-r overflow-y-auto py-3 space-y-3 shrink-0">
            {pages.map((p) => (
              <Thumb
                key={p.pageIndex}
                doc={doc}
                pageIndex={p.pageIndex}
                active={current === p.pageIndex}
                onClick={() => {
                  setCurrent(p.pageIndex);
                  setSelection(null);
                  setEditingId(null);
                }}
              />
            ))}
          </aside>
        )}

        {/* 主画布 */}
        <main className="flex-1 overflow-auto flex items-start justify-center p-8" onClick={() => setSelection(null)}>
          <div onClick={(e) => e.stopPropagation()}>
            <PageView
              doc={doc}
              page={page}
              elements={pageElements[current] ?? []}
              zoom={zoom}
              tool={tool}
              selection={selection}
              editingId={editingId}
              onSelect={setSelection}
              onStartEdit={setEditingId}
              onToolDone={() => setTool('select')}
              onUpdateSpan={updateSpan}
              onUpdateRegion={updateRegion}
              onAddRegion={addRegion}
              onUpdateElement={updateElement}
              onAddGroupElement={addGroupElement}
            />
            <p className="text-center text-xs text-muted-foreground mt-3">
              第 {current + 1} / {pages.length} 页 · {page.spans.length} 个可编辑文字块 ·{' '}
              {(pageElements[current] ?? []).length} 个矢量元素
            </p>
          </div>
        </main>

        {/* 属性面板 */}
        <aside className="w-72 bg-white border-l overflow-y-auto shrink-0">
          <PropertiesPanel
            item={selectedItem}
            selectedElement={selectedElement}
            elementEdit={selectedElementEdit}
            onUpdateSpan={updateSpan}
            onUpdateRegion={updateRegion}
            onRemoveRegion={removeRegion}
            onUpdateElement={updateElement}
            onClearElement={clearElement}
          />
        </aside>
      </div>

      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重新选择文件？</AlertDialogTitle>
            <AlertDialogDescription>
              当前有 {changeCount} 处修改尚未导出，重新选择文件将丢弃这些修改。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelReset}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmReset}>继续</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
