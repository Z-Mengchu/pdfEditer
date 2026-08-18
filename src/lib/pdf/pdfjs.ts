import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { SpanEdit } from './types';
import { registerEmbeddedFont } from './fonts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDoc = pdfjs.PDFDocumentProxy;

export async function loadPdf(data: ArrayBuffer): Promise<PdfDoc> {
  const doc = await pdfjs.getDocument({
    data,
    // 保留内嵌字体程序字节：pdf.js 默认在字体绑定完成后清空 font.data，
    // 该选项使其保留，extractSpans 才能提取原字体供预览/导出嵌入
    fontExtraProperties: true,
  }).promise;
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
 * fill/stroke 的两个哨兵值：
 * - 'transparent'：该绘制不可见（对应 pdf.js 的 setFillTransparent/setStrokeTransparent）；
 * - ''：图案（Pattern）填充/描边，无法表示为纯色，调用方应回退像素采样。
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

/** 一个文本显示算子的记录：状态快照 + 该算子解码出的文本（glyph unicode 拼接） */
interface TextOpRecord {
  st: TextGraphicsState;
  s: string;
}

/** showText 系列算子的 args[0] 是 glyph 数组（数字为 TJ 间距），拼出其 unicode 文本 */
function decodeShownText(args: unknown[]): string {
  const glyphs = args?.[0];
  if (typeof glyphs === 'string') return glyphs;
  if (!Array.isArray(glyphs)) return '';
  let s = '';
  for (const g of glyphs) {
    if (g && typeof g === 'object' && typeof (g as { unicode?: unknown }).unicode === 'string') {
      s += (g as { unicode: string }).unicode;
    }
  }
  return s;
}

/** 对齐匹配用的归一化：NFKC（连字 ﬁ→fi、全角→半角等，与 pdf.js normalizeUnicode 同向）+ 去空白
 *  （getTextContent 会插入假空格，算子解码文本没有，比较前都去掉） */
function normForMatch(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '');
}

/**
 * 把每个文本显示算子的状态对齐到 getTextContent 的 item。
 * 两边不是一一对应：getTextContent 会把多个连续 Tj 合并成一个 item，
 * 也会因大字距/EOL 把一个 TJ 拆成多个 item，纯空白 item 更是 pdf.js 插入的假空格。
 * 因此按解码文本做流式匹配：逐个 item 消费算子文本，前缀吻合即对齐成功，
 * 取贡献该 item 第一个字符的算子状态；对不上的 item 置 null（调用方按 span 回退像素采样），
 * 失步后在后续算子中扫描重同步，彻底失败则剩余 item 全部为 null。
 */
function alignStatesToItems(ops: TextOpRecord[], items: { str: string }[]): (TextGraphicsState | null)[] {
  const out: (TextGraphicsState | null)[] = new Array(items.length).fill(null);
  let oi = 0; // 下一个待消费算子的下标
  let rest = ''; // 已消费算子中尚未被 item 覆盖的剩余文本
  let restState: TextGraphicsState | null = null;
  let desynced = false;
  for (let i = 0; i < items.length; i++) {
    const want = normForMatch(items[i].str);
    if (!want) continue; // 假空格 item，不消费算子
    if (desynced) {
      let found = -1;
      for (let j = oi; j < Math.min(ops.length, oi + 500); j++) {
        const opN = normForMatch(ops[j].s);
        if (opN && (opN.startsWith(want) || want.startsWith(opN))) {
          found = j;
          break;
        }
      }
      if (found === -1) break; // 无法重同步，剩余 item 保持 null
      oi = found;
      rest = '';
      restState = null;
      desynced = false;
    }
    let acc = rest;
    let firstState = rest ? restState : null;
    while (acc.length < want.length && oi < ops.length) {
      if (!firstState) firstState = ops[oi].st;
      acc += normForMatch(ops[oi].s);
      restState = ops[oi].st;
      oi++;
    }
    if (acc.startsWith(want) && firstState) {
      out[i] = firstState;
      rest = acc.slice(want.length);
    } else {
      desynced = true;
      rest = '';
      restState = null;
    }
  }
  return out;
}

/**
 * 追踪内容流的文字相关图形状态，按 getTextContent 的 item 返回状态快照（对齐失败的 item 为 null）。
 * 与 getTextContent 的 str item 一一对应；整体异常时返回 null，全部回退像素采样/默认值。
 *
 * 注：pdf.js 5.x 在 worker 侧已把所有 sc/scn/g/rg/k 统一转成 setFillRGBColor/setStrokeRGBColor
 * （'#rrggbb' 字符串，含 ICC/CMYK/灰度的转换），主线程算子流里只剩 RGBColor、
 * ColorN（图案）和 Transparent 三类，Gray/CMYKColor 分支保留仅作防御。
 */
export async function extractTextGraphicsState(
  page: pdfjs.PDFPageProxy,
  items: { str: string }[],
): Promise<(TextGraphicsState | null)[] | null> {
  try {
    const ol = await page.getOperatorList();
    const OPS = pdfjs.OPS;
    const ops: TextOpRecord[] = [];
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
        case OPS.setFillColorN:
          cur.fill = ''; // 图案填充，无纯色表示
          break;
        case OPS.setFillTransparent:
          cur.fill = 'transparent';
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
        case OPS.setStrokeColorN:
          cur.stroke = '';
          break;
        case OPS.setStrokeTransparent:
          cur.stroke = 'transparent';
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
          ops.push({ st: { ...cur }, s: decodeShownText(args) });
          break;
        default:
          break;
      }
    }
    return alignStatesToItems(ops, items);
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
  const fillStates = await extractTextGraphicsState(page, strItems);
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
    let embeddedFontId: string | undefined;
    try {
      const fontObj = page.commonObjs.get(item.fontName) as {
        name?: string;
        data?: Uint8Array | null;
        isType3Font?: boolean;
        missingFile?: boolean;
        disableFontFace?: boolean;
      } | null;
      originalFontName = fontObj?.name ?? style?.fontFamily;
      // 提取真实内嵌字体程序（pdf.js 已转译为 OTF/TTF）；Type3/缺文件/系统替代字体无可用程序
      if (fontObj?.data && !fontObj.isType3Font && !fontObj.missingFile && !fontObj.disableFontFace) {
        embeddedFontId = registerEmbeddedFont(
          item.fontName,
          (fontObj.name ?? item.fontName).replace(/^[A-Z]{6}\+/, ''),
          fontObj.data,
        );
      }
    } catch {
      originalFontName = style?.fontFamily;
    }
    if (originalFontName) originalFontName = originalFontName.replace(/^[A-Z]{6}\+/, '') || undefined;
    const bgColor = sampleBackground(rendered, x, y, width, height, renderScale);
    // 优先用内容流算子里的精确图形状态；对齐失败/图案填充（空串）的 span 各自回退像素采样
    const gs = fillStates?.[idx];
    if (gs?.fill === 'transparent') continue; // 透明填充：不可见文字，同 Tr=3 不建 span
    const color = gs?.fill ? gs.fill : sampleTextColor(rendered, x, y, width, height, renderScale, bgColor);
    // 描边色同样过滤哨兵值：'transparent' 和 ''（图案）都不作为纯色描边
    const strokeColor = gs?.stroke && gs.stroke !== 'transparent' ? gs.stroke : undefined;
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
      embeddedFontId,
      charSpacing: gs?.charSpacing ?? 0,
      wordSpacing: gs?.wordSpacing ?? 0,
      hScale: gs?.hScale ?? 100,
      renderingMode: gs?.renderingMode ?? 0,
      strokeColor,
      strokeLineWidth: gs?.lineWidth,
      deleted: false,
    });
  }
  // Tr=3 为不可见文字（OCR 层），不创建可编辑 span（透明填充的已在上面跳过）
  return spans.filter((s) => s.renderingMode !== 3);
}
