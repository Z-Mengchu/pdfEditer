import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { SpanEdit } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDoc = pdfjs.PDFDocumentProxy;

export async function loadPdf(data: ArrayBuffer): Promise<PdfDoc> {
  const doc = await pdfjs.getDocument({ data }).promise;
  return doc;
}

/** 渲染一页到 canvas，renderScale 为物理像素比例（pt * renderScale = 像素） */
export async function renderPage(
  doc: PdfDoc,
  pageIndex: number,
  canvas: HTMLCanvasElement,
  renderScale: number,
): Promise<void> {
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale: renderScale });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
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

/** 采样区域内的文字颜色：取与背景差异最大的那批像素的平均值 */
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
  const avg = strong.reduce(
    (acc, p) => ({ r: acc.r + p.c.r, g: acc.g + p.c.g, b: acc.b + p.c.b }),
    { r: 0, g: 0, b: 0 },
  );
  return toHex(avg.r / strong.length, avg.g / strong.length, avg.b / strong.length);
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
  const spans: SpanEdit[] = [];
  let n = 0;
  for (const item of tc.items) {
    if (!('str' in item)) continue;
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
    const bold = /bold|black|heavy|demi/.test(fontName);
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
    const color = sampleTextColor(rendered, x, y, width, height, renderScale, bgColor);
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
      color,
      bgColor,
      bold,
      originalFontName,
      deleted: false,
    });
  }
  return spans;
}
