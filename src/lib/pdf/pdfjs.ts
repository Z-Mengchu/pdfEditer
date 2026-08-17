import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { SpanEdit } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDoc = pdfjs.PDFDocumentProxy;

export async function loadPdf(data: ArrayBuffer): Promise<PdfDoc> {
  const doc = await pdfjs.getDocument({ data }).promise;
  return doc;
}

/** 渲染一页到 canvas，renderScale 为物理像素比例（pt * renderScale = 像素）。
 *  onTask 用于暴露 RenderTask 以便调用方取消（pdf.js 不允许同一 canvas 并发 render）。 */
export async function renderPage(
  doc: PdfDoc,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  renderScale: number,
  onTask?: (task: pdfjs.RenderTask) => void,
): Promise<void> {
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: renderScale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({ canvasContext: ctx, viewport, canvas });
  onTask?.(task);
  await task.promise;
}

export function getPageSize(viewport: { width: number; height: number }) {
  return { width: viewport.width, height: viewport.height };
}

export async function getPageViewport(doc: PdfDoc, pageIndex: number, scale = 1) {
  const page = await doc.getPage(pageIndex + 1);
  return page.getViewport({ scale });
}

/* ---------------- 颜色采样 ---------------- */

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function toHex(r: number, g: number, b: number) {
  const h = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

/** 采样某区域（pt 坐标，左上角原点）边框一圈的中位色作为背景色 */
export function sampleBackground(
  src: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): string {
  const ctx = src.getContext('2d', { willReadFrequently: true })!;
  const pad = 3;
  const px = Math.floor(x * scale);
  const py = Math.floor(y * scale);
  const pw = Math.ceil(w * scale);
  const ph = Math.ceil(h * scale);
  const fx = clamp(px - pad, 0, src.width - 1);
  const fy = clamp(py - pad, 0, src.height - 1);
  const fw = clamp(pw + pad * 2, 1, src.width - fx);
  const fh = clamp(ph + pad * 2, 1, src.height - fy);
  const img = ctx.getImageData(fx, fy, fw, fh);
  const ring: RGB[] = [];
  const innerX = px - fx;
  const innerY = py - fy;
  for (let j = 0; j < fh; j += 1) {
    for (let i = 0; i < fw; i += 1) {
      const inInner = i >= innerX && i < innerX + pw && j >= innerY && j < innerY + ph;
      if (inInner) continue;
      const o = (j * fw + i) * 4;
      ring.push({ r: img.data[o], g: img.data[o + 1], b: img.data[o + 2] });
    }
  }
  if (ring.length === 0) return '#ffffff';
  const med = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return toHex(med(ring.map((c) => c.r)), med(ring.map((c) => c.g)), med(ring.map((c) => c.b)));
}

function hexToRgb01(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** 采样区域内的文字颜色：取与背景差异最大的笔画核心像素的平均值（排除抗锯齿过渡像素） */
export function sampleTextColor(
  src: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  bgHex: string,
): string {
  const ctx = src.getContext('2d', { willReadFrequently: true })!;
  const px = clamp(Math.floor(x * scale), 0, src.width - 1);
  const py = clamp(Math.floor(y * scale), 0, src.height - 1);
  const pw = clamp(Math.ceil(w * scale), 1, src.width - px);
  const ph = clamp(Math.ceil(h * scale), 1, src.height - py);
  const img = ctx.getImageData(px, py, pw, ph);
  const bg = hexToRgb01(bgHex);
  const pixels: { c: RGB; dist: number }[] = [];
  for (let o = 0; o < img.data.length; o += 4) {
    const c = { r: img.data[o], g: img.data[o + 1], b: img.data[o + 2] };
    const dist = Math.abs(c.r - bg.r) + Math.abs(c.g - bg.g) + Math.abs(c.b - bg.b);
    pixels.push({ c, dist });
  }
  pixels.sort((a, b) => b.dist - a.dist);
  const top = pixels.slice(0, Math.max(4, Math.floor(pixels.length * 0.2)));
  const strong = top.filter((p) => p.dist > 60);
  if (strong.length === 0) return '#000000';
  // 只取与背景差异接近最大值的那批笔画核心像素求平均，
  // 避免抗锯齿边缘的过渡色（半灰像素）把颜色拉灰
  const maxDist = strong[0].dist;
  const core = strong.filter((p) => p.dist >= maxDist * 0.8);
  const avg = core.reduce(
    (acc, p) => ({ r: acc.r + p.c.r, g: acc.g + p.c.g, b: acc.b + p.c.b }),
    { r: 0, g: 0, b: 0 },
  );
  return toHex(avg.r / core.length, avg.g / core.length, avg.b / core.length);
}

/* ---------------- 精确文字填充色（operatorList） ---------------- */

function grayToHex(g: number): string {
  const v = clamp(Math.round(g * 255), 0, 255);
  return `#${v.toString(16).padStart(2, '0').repeat(3)}`;
}

function cmykToHex(c: number, m: number, y: number, k: number): string {
  const f = (v: number) => clamp(Math.round((1 - v) * (1 - k) * 255), 0, 255);
  return toHex(f(c), f(m), f(y));
}

/**
 * 每个文本显示算子处的图形状态快照（Tc/Tw/Tz/Tr/填充色/描边色/线宽）。
 * hScale 为百分比（100 = 无缩放），spacing 单位为 pt。
 */
export interface TextGraphicsState {
  fill: string;
  stroke: string;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  renderingMode: number;
  lineWidth: number;
}

const DEFAULT_TEXT_STATE: TextGraphicsState = {
  fill: '#000000',
  stroke: '#000000',
  charSpacing: 0,
  wordSpacing: 0,
  hScale: 100,
  renderingMode: 0,
  lineWidth: 1,
};

/**
 * 追踪内容流的文字相关图形状态，返回每个文本显示算子（Tj/TJ/'/"）处的状态快照。
 * 与 getTextContent 的 item 同源同序，可一一对应；
 * 数量对不上等异常情况返回 null，整体回退到像素采样/默认值。
 */
async function extractTextGraphicsState(
  page: pdfjs.PDFPageProxy,
  itemCount: number,
): Promise<TextGraphicsState[] | null> {
  try {
    const ol = await page.getOperatorList();
    const OPS = pdfjs.OPS;
    const states: TextGraphicsState[] = [];
    let cur: TextGraphicsState = { ...DEFAULT_TEXT_STATE };
    const stack: TextGraphicsState[] = [];
    for (let i = 0; i < ol.fnArray.length; i++) {
      const fn = ol.fnArray[i];
      const args = ol.argsArray[i];
      switch (fn) {
        case OPS.save:
          stack.push({ ...cur });
          break;
        case OPS.restore:
          cur = stack.pop() ?? cur;
          break;
        case OPS.setFillRGBColor:
          cur.fill = args[0]; // pdf.js 已转成 '#rrggbb' 字符串
          break;
        case OPS.setFillGray:
          cur.fill = grayToHex(args[0]);
          break;
        case OPS.setFillCMYKColor:
          cur.fill = cmykToHex(args[0], args[1], args[2], args[3]);
          break;
        case OPS.setStrokeRGBColor:
          cur.stroke = args[0];
          break;
        case OPS.setStrokeGray:
          cur.stroke = grayToHex(args[0]);
          break;
        case OPS.setStrokeCMYKColor:
          cur.stroke = cmykToHex(args[0], args[1], args[2], args[3]);
          break;
        case OPS.setCharSpacing:
          cur.charSpacing = args[0];
          break;
        case OPS.setWordSpacing:
          cur.wordSpacing = args[0];
          break;
        case OPS.setHScale:
          cur.hScale = args[0]; // PDF 操作数即百分比
          break;
        case OPS.setTextRenderingMode:
          cur.renderingMode = args[0];
          break;
        case OPS.setLineWidth:
          cur.lineWidth = args[0];
          break;
        case OPS.showText:
        case OPS.showSpacedText:
        case OPS.nextLineShowText:
        case OPS.nextLineSetSpacingShowText:
          states.push({ ...cur });
          break;
        default:
          break;
      }
    }
    return states.length === itemCount ? states : null;
  } catch {
    return null;
  }
}

/* ---------------- 文字提取 ---------------- */

/** 提取一页的真实文字层，坐标为 pt、左上角原点 */
export async function extractSpans(
  doc: PdfDoc,
  pageIndex: number,
  rendered: HTMLCanvasElement,
  renderScale: number,
): Promise<SpanEdit[]> {
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  // 含 str 的 item 与内容流中的文本显示算子一一对应，用序号对齐图形状态
  const strItems = tc.items.filter((it): it is Extract<(typeof tc.items)[number], { str: string }> => 'str' in it);
  const fillStates = await extractTextGraphicsState(page, strItems.length);
  const spans: SpanEdit[] = [];
  let n = 0;
  for (let idx = 0; idx < strItems.length; idx++) {
    const item = strItems[idx];
    const str = item.str;
    if (!str || !str.trim()) continue;
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    const angle = Math.atan2(tx[1], tx[0]);
    // 仅支持水平文字
    if (Math.abs(angle) > 0.01) continue;
    const fontSize = Math.hypot(tx[2], tx[3]);
    if (fontSize < 0.5) continue;
    const style = (tc.styles as Record<string, { ascent?: number; descent?: number; fontFamily?: string }>)[
      item.fontName
    ];
    const ascentR = style?.ascent && style.ascent > 0 && style.ascent < 2 ? style.ascent : 0.85;
    const descentR = style?.descent ? Math.abs(style.descent) : 0.25;
    const baseline = tx[5]; // 基线的 y（左上角原点）
    const x = tx[4];
    const y = baseline - fontSize * ascentR;
    const height = fontSize * (ascentR + descentR);
    const width = Math.max(item.width, fontSize * 0.3);
    const fontName = (item.fontName + ' ' + (style?.fontFamily ?? '')).toLowerCase();
    // semibold 已被 bold 子串覆盖，这里补 medium 字重
    const bold = /bold|black|heavy|demi|medium/.test(fontName);
    // 原字体名：优先取字体对象的 BaseFont（剥掉子集前缀 ABCDEF+），退化为 styles.fontFamily
    let originalFontName: string | undefined;
    try {
      const fontObj = page.commonObjs.get(item.fontName) as { name?: string } | null;
      originalFontName = fontObj?.name ?? style?.fontFamily;
    } catch {
      originalFontName = style?.fontFamily;
    }
    if (originalFontName) originalFontName = originalFontName.replace(/^[A-Z]{6}\+/, '') || undefined;
    const bgColor = sampleBackground(rendered, x, y, width, height, renderScale);
    // 优先用内容流算子里的精确图形状态，提取失败（数量对不上等）整体回退像素采样/默认值
    const gs = fillStates?.[idx];
    const color = gs?.fill ?? sampleTextColor(rendered, x, y, width, height, renderScale, bgColor);
    spans.push({
      kind: 'span',
      id: `s${pageIndex}-${n++}`,
      pageIndex,
      x,
      y,
      width,
      height,
      baseline: fontSize * ascentR,
      ox: x,
      oy: y,
      owidth: width,
      oheight: height,
      originalText: str,
      text: str,
      fontSize,
      ofontSize: fontSize,
      color,
      ocolor: color,
      bgColor,
      obgColor: bgColor,
      bold,
      originalBold: bold,
      originalFontName,
      charSpacing: gs?.charSpacing ?? 0,
      wordSpacing: gs?.wordSpacing ?? 0,
      hScale: gs?.hScale ?? 100,
      renderingMode: gs?.renderingMode ?? 0,
      strokeColor: gs?.stroke,
      strokeLineWidth: gs?.lineWidth,
      deleted: false,
    });
  }
  // Tr=3 为不可见文字（OCR 层），不创建可编辑 span；在 zip 对齐完成后过滤
  return spans.filter((s) => s.renderingMode !== 3);
}
