import { useEffect, useRef, useState } from 'react';
import type { PdfDoc } from '@/lib/pdf/pdfjs';
import { renderPage, sampleBackground } from '@/lib/pdf/pdfjs';
import type { ElementEdit, PageState, RegionEdit, Selection, SpanEdit, Tool } from '@/lib/pdf/types';
import { isSpan, spanDirty } from '@/lib/pdf/types';
import { hitTestElements, segsToPathData, partsOf, type VectorElement } from '@/lib/pdf/elements';
import { ensureDefaultCjkPreview, ensurePreviewFont, previewFontStack, resolveFontChoice } from '@/lib/pdf/fonts';

interface PageViewProps {
  doc: PdfDoc;
  page: PageState;
  elements: VectorElement[];
  zoom: number;
  tool: Tool;
  selection: Selection;
  editingId: string | null;
  onSelect: (sel: Selection | null) => void;
  onStartEdit: (id: string | null) => void;
  onToolDone: () => void;
  onUpdateSpan: (id: string, patch: Partial<SpanEdit>) => void;
  onUpdateRegion: (id: string, patch: Partial<RegionEdit>) => void;
  onAddRegion: (r: Omit<RegionEdit, 'id'>) => void;
  onUpdateElement: (el: VectorElement, patch: Partial<ElementEdit>) => void;
  onAddGroupElement: (el: VectorElement) => void;
}

interface DragState {
  kind: 'move' | 'resize' | 'draw' | 'moveElement' | 'marquee';
  id?: string;
  startX: number;
  startY: number; // pt
  origX: number;
  origY: number;
  origW: number;
  origH: number;
  origDx: number;
  origDy: number;
  moved: boolean;
}

const HATCH =
  'repeating-linear-gradient(45deg, rgba(248,113,113,0.75) 0 4px, rgba(255,255,255,0.75) 4px 8px)';

/** 替换图片预览的 objectURL 缓存，避免每次 render 重复创建 */
const previewUrlCache = new Map<string, string>();
function previewUrl(elId: string, bytes: ArrayBuffer): string {
  const key = `${elId}:${bytes.byteLength}`;
  let url = previewUrlCache.get(key);
  if (!url) {
    url = URL.createObjectURL(new Blob([bytes]));
    previewUrlCache.set(key, url);
  }
  return url;
}

/** 为带 fontId 的编辑项加载预览字体（FontFace），返回 fontId → CSS font-family */
function usePreviewFontFamilies(items: (SpanEdit | RegionEdit)[]): Record<string, string> {
  const [families, setFamilies] = useState<Record<string, string>>({});
  const [, setCjkReady] = useState(false);
  // 未显式选字体的 span 也走与导出一致的回退链（内嵌字体 → 原字体名匹配内置库）加载预览字体
  const idsKey = [
    ...new Set(
      items
        .map(
          (i) =>
            resolveFontChoice(i.fontId, isSpan(i) ? i.originalFontName : undefined, false, isSpan(i) ? i.embeddedFontId : undefined)
              .fontId,
        )
        .filter((x): x is string => !!x),
    ),
  ]
    .sort()
    .join(',');
  // 默认 CJK 字体也要注册（未选字体 / 自定义字体缺字时的预览回退，与导出一致）
  useEffect(() => {
    let cancelled = false;
    ensureDefaultCjkPreview()
      .then(() => {
        if (!cancelled) setCjkReady(true);
      })
      .catch(() => {
        // 加载失败：预览回退系统字体，导出时再统一报错
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!idsKey) return;
    let cancelled = false;
    (async () => {
      const entries: [string, string][] = [];
      for (const id of idsKey.split(',')) {
        try {
          entries.push([id, await ensurePreviewFont(id)]);
        } catch {
          // 预览加载失败：回退默认字体渲染，导出时再统一报错
        }
      }
      if (!cancelled && entries.length) {
        setFamilies((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idsKey]);
  return families;
}

export default function PageView({
  doc,
  page,
  elements,
  zoom,
  tool,
  selection,
  editingId,
  onSelect,
  onStartEdit,
  onToolDone,
  onUpdateSpan,
  onUpdateRegion,
  onAddRegion,
  onUpdateElement,
  onAddGroupElement,
}: PageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendering, setRendering] = useState(true);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [hoverElId, setHoverElId] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const cssW = page.width * zoom;
  const cssH = page.height * zoom;
  const fontFamilies = usePreviewFontFamilies([...page.spans, ...page.regions]);
  // 字体栈与导出回退链一致（选用字体 → Helvetica → 内置 CJK），预览即所得
  const familyOf = (fontId?: string) => previewFontStack(fontId ? fontFamilies[fontId] : undefined);

  useEffect(() => {
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    setRendering(true);
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 按设备像素比渲染：canvas 物理像素 = CSS 尺寸 × dpr，避免浏览器二次缩放导致模糊/偏色
    const dpr = window.devicePixelRatio || 1;
    renderPage(doc, page.pageIndex, canvas, Math.min(zoom * dpr, 8), (t) => {
      // StrictMode 下 effect 会先执行一次再清理重跑：若已清理则立即取消，释放 canvas 给下一次渲染
      if (cancelled) t.cancel();
      else task = t;
    })
      .then(() => {
        if (!cancelled) setRendering(false);
      })
      .catch(() => {
        // 渲染被取消或失败都要摘掉“渲染中”遮罩，否则会永久卡住
        if (!cancelled) setRendering(false);
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page.pageIndex, zoom]);

  useEffect(() => {
    setHoverElId(null);
  }, [tool, page.pageIndex]);

  const toPt = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / zoom, y: (e.clientY - rect.top) / zoom };
  };

  const pickElement = (p: { x: number; y: number }) =>
    hitTestElements(elements, p.x, p.y, p.x, page.height - p.y);

  /* ---------- 交互层事件 ---------- */
  const onLayerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (tool === 'select') {
      onSelect(null);
      return;
    }
    if (tool === 'element') {
      const p = toPt(e, e.currentTarget);
      const el = pickElement(p);
      if (!el) {
        // 空白处开始框选（多选）
        onSelect(null);
        dragRef.current = {
          kind: 'marquee',
          startX: p.x,
          startY: p.y,
          origX: p.x,
          origY: p.y,
          origW: 0,
          origH: 0,
          origDx: 0,
          origDy: 0,
          moved: false,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      onSelect({ kind: 'element', id: el.id });
      // 首次选中即创建编辑记录并采样涂抹底色（仅记录底色不算修改）
      if (!page.elementEdits[el.id]) {
        onUpdateElement(el, { bgColor: sampleElBg(el) });
      }
      // 路径元素（含已替换图片的元素）可拖动；原始栅格图片不支持拖动
      const edit = page.elementEdits[el.id];
      const movable = el.segs.length > 0 || !!edit?.replaceImage;
      if (movable && !edit?.deleted) {
        dragRef.current = {
          kind: 'moveElement',
          id: el.id,
          startX: p.x,
          startY: p.y,
          origX: 0,
          origY: 0,
          origW: 0,
          origH: 0,
          origDx: edit?.dx ?? 0,
          origDy: edit?.dy ?? 0,
          moved: false,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      return;
    }
    const p = toPt(e, e.currentTarget);
    dragRef.current = {
      kind: 'draw',
      startX: p.x,
      startY: p.y,
      origX: p.x,
      origY: p.y,
      origW: 0,
      origH: 0,
      origDx: 0,
      origDy: 0,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onLayerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const p = toPt(e, e.currentTarget);
    if (d?.kind === 'marquee') {
      setDraft({
        x: Math.min(d.startX, p.x),
        y: Math.min(d.startY, p.y),
        w: Math.abs(p.x - d.startX),
        h: Math.abs(p.y - d.startY),
      });
      d.moved = true;
      return;
    }
    if (d?.kind === 'draw') {
      setDraft({
        x: Math.min(d.startX, p.x),
        y: Math.min(d.startY, p.y),
        w: Math.abs(p.x - d.startX),
        h: Math.abs(p.y - d.startY),
      });
      d.moved = true;
      return;
    }
    if (d?.kind === 'moveElement' && d.id) {
      const dx = p.x - d.startX;
      const dy = p.y - d.startY;
      if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
      if (!d.moved) return;
      const el = elements.find((it) => it.id === d.id);
      if (el) onUpdateElement(el, { dx: d.origDx + dx, dy: d.origDy + dy });
      return;
    }
    if (tool === 'element' && !d) {
      const el = pickElement(p);
      setHoverElId(el?.id ?? null);
    }
  };

  const onLayerPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.kind === 'marquee') {
      if (draft && draft.w > 3 && draft.h > 3) {
        const hit = (el: VectorElement) =>
          el.x < draft.x + draft.w && el.x + el.width > draft.x && el.y < draft.y + draft.h && el.y + el.height > draft.y;
        const members = elements.filter((el) => !el.imageObjId && hit(el));
        const imgs = elements.filter((el) => !!el.imageObjId && hit(el));
        if (members.length <= 1) {
          const single = members[0] ?? imgs[0];
          if (single) {
            onSelect({ kind: 'element', id: single.id });
            if (!page.elementEdits[single.id]) onUpdateElement(single, { bgColor: sampleElBg(single) });
          }
        } else {
          // 组合多个元素为一个组（保持各部分颜色）
          const x0 = Math.min(...members.map((m) => m.x));
          const y0 = Math.min(...members.map((m) => m.y));
          const x1 = Math.max(...members.map((m) => m.x + m.width));
          const y1 = Math.max(...members.map((m) => m.y + m.height));
          const group: VectorElement = {
            id: `g${page.pageIndex}-${Date.now()}`,
            pageIndex: page.pageIndex,
            segs: members.flatMap((m) => m.segs),
            paints: members.flatMap((m) => m.paints),
            fillColor: '#000000',
            strokeColor: '#000000',
            lineWidth: 1,
            parts: members.map((m) => ({
              segs: m.segs,
              paints: m.paints,
              fillColor: m.fillColor,
              strokeColor: m.strokeColor,
              lineWidth: m.lineWidth,
            })),
            x: x0,
            y: y0,
            width: x1 - x0,
            height: y1 - y0,
            imageObjId: null,
            order: Math.max(...members.map((m) => m.order)),
          };
          onAddGroupElement(group);
          onUpdateElement(group, { bgColor: sampleElBg(group) });
          onSelect({ kind: 'element', id: group.id });
        }
      }
      setDraft(null);
      return;
    }
    if (d?.kind === 'draw' && draft && draft.w > 5 && draft.h > 5) {
      onAddRegion({
        kind: 'region',
        pageIndex: page.pageIndex,
        x: draft.x,
        y: draft.y,
        width: draft.w,
        height: draft.h,
        fill: tool === 'region',
        fillColor: '#ffffff',
        text: '',
        fontSize: Math.max(6, Math.min(24, draft.h * 0.55)),
        color: '#000000',
        bold: false,
        align: 'left',
        valign: tool === 'text' ? 'middle' : 'top',
      });
      onToolDone();
    }
    setDraft(null);
  };

  /* ---------- 元素覆盖层 ---------- */
  const sampleElBg = (el: VectorElement) => {
    const canvas = canvasRef.current;
    if (!canvas) return '#ffffff';
    return sampleBackground(canvas, el.x, el.y, el.width, el.height, canvas.width / page.width);
  };

  const editedElements = Object.values(page.elementEdits)
    .map((edit) => ({ edit, el: elements.find((e) => e.id === edit.elementId) }))
    .filter((x): x is { edit: ElementEdit; el: VectorElement } => !!x.el);

  const hoverEl = hoverElId ? elements.find((e) => e.id === hoverElId) : null;
  const selectedElId = selection?.kind === 'element' ? selection.id : null;

  /* ---------- 元素拖拽（span/region 用） ---------- */
  const onItemPointerDown = (e: React.PointerEvent, item: SpanEdit | RegionEdit, mode: 'move' | 'resize') => {
    if (editingId === item.id || tool !== 'select') return;
    e.stopPropagation();
    onSelect({ kind: item.kind, id: item.id });
    const container = (e.currentTarget as HTMLElement).parentElement!;
    const p = toPt(e, container);
    dragRef.current = {
      kind: mode,
      id: item.id,
      startX: p.x,
      startY: p.y,
      origX: item.x,
      origY: item.y,
      origW: item.width,
      origH: item.height,
      origDx: 0,
      origDy: 0,
      moved: false,
    };
    container.setPointerCapture(e.pointerId);
  };

  const onContainerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.kind === 'draw' || d.kind === 'moveElement' || !d.id) return;
    const p = toPt(e, e.currentTarget);
    const dx = p.x - d.startX;
    const dy = p.y - d.startY;
    if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
    if (!d.moved) return;
    const item = [...page.spans, ...page.regions].find((it) => it.id === d.id);
    if (!item) return;
    if (d.kind === 'move') {
      const patch = {
        x: Math.max(0, Math.min(page.width - 8, d.origX + dx)),
        y: Math.max(0, Math.min(page.height - 8, d.origY + dy)),
      };
      if (item.kind === 'span') onUpdateSpan(d.id, patch);
      else onUpdateRegion(d.id, patch);
    } else {
      const patch = {
        width: Math.max(8, d.origW + dx),
        height: Math.max(6, d.origH + dy),
      };
      if (item.kind === 'span') onUpdateSpan(d.id, patch);
      else onUpdateRegion(d.id, patch);
    }
  };

  /* ---------- 内联文本编辑（受控输入，边打字边提交，避免失焦时序问题） ---------- */
  const renderEditor = (item: SpanEdit | RegionEdit) => {
    const isRegion = item.kind === 'region';
    // span 走与导出一致的字体回退链（内嵌字体 → 原字体名匹配内置库 + 字重修正）
    const rf = isRegion
      ? { fontId: item.fontId, bold: item.bold }
      : resolveFontChoice(item.fontId, item.originalFontName, item.bold, item.embeddedFontId);
    const commit = (v: string) => {
      if (item.kind === 'span') onUpdateSpan(item.id, { text: v });
      else onUpdateRegion(item.id, { text: v });
    };
    return (
      <textarea
        autoFocus
        value={item.text}
        className="absolute bg-white/95 text-black outline-none ring-2 ring-blue-500 rounded-sm resize-none overflow-hidden p-0 m-0 z-30"
        style={{
          left: item.x * zoom,
          top: item.y * zoom,
          width: Math.max(item.width * zoom, 60),
          height: isRegion ? item.height * zoom : Math.max(item.height * zoom, item.fontSize * zoom * 1.6),
          fontSize: item.fontSize * zoom,
          lineHeight: 1.2,
          fontWeight: rf.bold ? 700 : 400,
          fontFamily: familyOf(rf.fontId),
          color: item.color,
        }}
        onChange={(e) => commit(e.currentTarget.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => onStartEdit(null)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onStartEdit(null);
          e.stopPropagation();
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
    );
  };

  const renderSpan = (s: SpanEdit) => {
    if (tool !== 'select' && tool !== 'region' && tool !== 'text') return null;
    if (editingId === s.id) return renderEditor(s);
    const dirty = spanDirty(s);
    const selected = selection?.kind === 'span' && selection.id === s.id;
    const rf = resolveFontChoice(s.fontId, s.originalFontName, s.bold, s.embeddedFontId);
    return (
      <div
        key={s.id}
        className={`absolute group ${selected ? 'ring-2 ring-blue-500 z-20' : 'hover:ring-1 hover:ring-blue-400/70 z-10'} ${
          s.deleted ? 'cursor-not-allowed' : 'cursor-move'
        }`}
        style={{ left: s.x * zoom, top: s.y * zoom, width: s.width * zoom, height: s.height * zoom }}
        title={s.deleted ? '已标记擦除（导出时涂抹该区域）' : '双击编辑文字，可拖动移动'}
        onPointerDown={(e) => onItemPointerDown(e, s, 'move')}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!s.deleted) {
            onSelect({ kind: 'span', id: s.id });
            onStartEdit(s.id);
          }
        }}
      >
        {s.deleted && <div className="absolute inset-0 opacity-70" style={{ background: HATCH }} />}
        {dirty && !s.deleted && (
          <div
            className="absolute overflow-hidden whitespace-pre"
            style={{
              left: 0,
              top: 0,
              backgroundColor: s.bgColor,
              color: s.color,
              fontSize: s.fontSize * zoom,
              lineHeight: 1.2,
              fontWeight: rf.bold ? 700 : 400,
              fontFamily: familyOf(rf.fontId),
              letterSpacing: s.charSpacing ? `${s.charSpacing * zoom}px` : undefined,
              ...(s.hScale != null && s.hScale !== 100
                ? { transform: `scaleX(${s.hScale / 100})`, transformOrigin: 'left top' }
                : {}),
              padding: 0,
              minWidth: '100%',
              minHeight: '100%',
            }}
          >
            {s.text}
          </div>
        )}
        {selected && (
          <div
            className="absolute w-2.5 h-2.5 bg-blue-500 rounded-full -right-1.5 -bottom-1.5 cursor-nwse-resize"
            onPointerDown={(e) => onItemPointerDown(e, s, 'resize')}
          />
        )}
      </div>
    );
  };

  const renderRegion = (r: RegionEdit) => {
    if (tool !== 'select' && tool !== 'region' && tool !== 'text') return null;
    if (editingId === r.id) return renderEditor(r);
    const selected = selection?.kind === 'region' && selection.id === r.id;
    return (
      <div
        key={r.id}
        className={`absolute cursor-move ${
          selected ? 'ring-2 ring-blue-500 z-20' : 'ring-1 ring-amber-500/80 ring-dashed z-10 hover:ring-amber-600'
        }`}
        style={{
          left: r.x * zoom,
          top: r.y * zoom,
          width: r.width * zoom,
          height: r.height * zoom,
          backgroundColor: r.fill ? `${r.fillColor}b3` : 'rgba(251,191,36,0.08)',
        }}
        title="框选区域：双击输入文字，可拖动/缩放"
        onPointerDown={(e) => onItemPointerDown(e, r, 'move')}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onSelect({ kind: 'region', id: r.id });
          onStartEdit(r.id);
        }}
      >
        {r.text && (
          <div
            className="absolute inset-0 overflow-hidden flex px-0.5"
            style={{
              flexDirection: 'column',
              justifyContent:
                r.valign === 'middle' ? 'center' : r.valign === 'bottom' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                width: '100%',
                textAlign: r.align,
                color: r.color,
                fontSize: r.fontSize * zoom,
                lineHeight: 1.25,
                fontWeight: r.bold ? 700 : 400,
                fontFamily: familyOf(r.fontId),
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}
            >
              {r.text}
            </div>
          </div>
        )}
        {selected && (
          <div
            className="absolute w-2.5 h-2.5 bg-blue-500 rounded-full -right-1.5 -bottom-1.5 cursor-nwse-resize"
            onPointerDown={(e) => onItemPointerDown(e, r, 'resize')}
          />
        )}
      </div>
    );
  };

  return (
    <div className="relative shadow-xl bg-white" style={{ width: cssW, height: cssH }}>
      <canvas ref={canvasRef} style={{ width: cssW, height: cssH, display: 'block' }} />
      {rendering && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/60 text-sm text-muted-foreground">
          渲染中…
        </div>
      )}
      <div
        className={`absolute inset-0 ${tool === 'region' || tool === 'text' ? 'cursor-crosshair' : ''} ${
          tool === 'element' ? 'cursor-default' : ''
        }`}
        style={{ touchAction: 'none' }}
        onPointerDown={onLayerPointerDown}
        onPointerMove={(e) => {
          onLayerPointerMove(e);
          onContainerPointerMove(e);
        }}
        onPointerUp={onLayerPointerUp}
      >
        {page.spans.map(renderSpan)}
        {page.regions.map(renderRegion)}

        {/* 元素模式：悬停高亮 */}
        {tool === 'element' && hoverEl && hoverElId !== selectedElId && !page.elementEdits[hoverEl.id]?.deleted && (
          <div
            className="absolute border-2 border-cyan-500 bg-cyan-300/20 pointer-events-none z-10"
            style={{
              left: hoverEl.x * zoom,
              top: hoverEl.y * zoom,
              width: hoverEl.width * zoom,
              height: hoverEl.height * zoom,
            }}
          />
        )}

        {/* 已编辑元素的覆盖层 */}
        {editedElements.map(({ edit, el }) => {
          const isSelected = selectedElId === el.id;
          const bx = (el.x + edit.dx) * zoom;
          const by = (el.y + edit.dy) * zoom;
          return (
            <div key={el.id}>
              {/* 原位置：已擦除提示 */}
              {(edit.deleted || edit.dx !== 0 || edit.dy !== 0 || edit.replaceImage) && (
                <div
                  className="absolute opacity-60 pointer-events-none z-10"
                  style={{
                    left: el.x * zoom,
                    top: el.y * zoom,
                    width: el.width * zoom,
                    height: el.height * zoom,
                    background: HATCH,
                  }}
                />
              )}
              {/* 选中框 */}
              {isSelected && (
                <div
                  className="absolute border-2 border-blue-500 pointer-events-none z-20"
                  style={{
                    left: edit.deleted ? el.x * zoom : bx,
                    top: edit.deleted ? el.y * zoom : by,
                    width: el.width * zoom,
                    height: el.height * zoom,
                  }}
                />
              )}
              {/* 替换图片预览 */}
              {edit.replaceImage && !edit.deleted && (
                <img
                  src={previewUrl(el.id, edit.replaceImage.bytes)}
                  alt=""
                  className="absolute pointer-events-none z-10 object-contain"
                  style={{ left: bx, top: by, width: el.width * zoom, height: el.height * zoom }}
                />
              )}
            </div>
          );
        })}

        {/* 移动后的路径矢量预览 */}
        <svg
          className="absolute inset-0 pointer-events-none z-10"
          width={cssW}
          height={cssH}
          viewBox={`0 0 ${page.width} ${page.height}`}
        >
          <g transform={`matrix(1 0 0 -1 0 ${page.height})`}>
            {editedElements
              .filter(({ edit, el }) => !edit.deleted && !edit.replaceImage && (edit.dx !== 0 || edit.dy !== 0) && el.segs.length > 0)
              .flatMap(({ edit, el }) =>
                partsOf(el).map((part, pi) => {
                  const hasFill = part.paints.some((pt) => pt.includes('fill'));
                  const hasStroke = part.paints.some((pt) => pt.includes('stroke'));
                  return (
                    <path
                      key={`${el.id}-${pi}`}
                      d={segsToPathData(part.segs, edit.dx, -edit.dy)}
                      fill={hasFill ? part.fillColor : 'none'}
                      stroke={hasStroke ? part.strokeColor : 'none'}
                      strokeWidth={hasStroke ? Math.max(part.lineWidth, 0.2) : 0}
                    />
                  );
                }),
              )}
          </g>
        </svg>

        {draft && (
          <div
            className={`absolute border-2 border-dashed pointer-events-none ${
              tool === 'element' ? 'border-cyan-500 bg-cyan-200/20' : 'border-amber-500 bg-amber-200/20'
            }`}
            style={{ left: draft.x * zoom, top: draft.y * zoom, width: draft.w * zoom, height: draft.h * zoom }}
          />
        )}
      </div>
    </div>
  );
}
