import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { PageState, RegionEdit, SpanEdit } from './types';
import { spanDirty } from './types';
import { segsToPathData, partsOf, type VectorElement } from './elements';
import { boldVariantIdOf, fontCovers, loadFontById, resolveFontChoice } from './fonts';
import { applyTextRedaction } from './redact';

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** WinAnsi（CP1252）之外的字符需要用嵌入 CJK 字体绘制 */
function needsCjk(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return c > 0xff || (c >= 0x80 && c <= 0x9f);
}

interface Fonts {
  latin: PDFFont;
  latinBold: PDFFont;
  cjk: PDFFont | null;
}

/** 用户选用的字体：覆盖的字符用它绘制，未覆盖的回退到默认分流 */
interface CustomFont {
  font: PDFFont;
  covers: (ch: string) => boolean;
  /** 真加粗变体（可选） */
  bold?: PDFFont;
  boldCovers?: (ch: string) => boolean;
}

function fontFor(ch: string, bold: boolean, fonts: Fonts, custom?: CustomFont): PDFFont {
  if (custom?.covers(ch)) {
    if (bold && custom.bold && custom.boldCovers?.(ch)) return custom.bold;
    return custom.font;
  }
  if (needsCjk(ch)) {
    if (!fonts.cjk) throw new Error(`字符 "${ch}" 需要中文字体，但字体未加载`);
    return fonts.cjk;
  }
  return bold ? fonts.latinBold : fonts.latin;
}

function textWidth(text: string, size: number, bold: boolean, fonts: Fonts, custom?: CustomFont): number {
  let w = 0;
  for (const ch of text) {
    w += fontFor(ch, bold, fonts, custom).widthOfTextAtSize(ch, size);
  }
  return w;
}

/** 逐字符 advance 补偿：Tc 字距、Tw 词距（仅空格）、Tz 水平缩放、残差摊分 pad */
interface TrackOpts {
  cs: number;
  ws: number;
  /** 百分比，100 = 无缩放 */
  hs: number;
  pad: number;
}

const NO_TRACK: TrackOpts = { cs: 0, ws: 0, hs: 100, pad: 0 };

/** 单个字符的绘制字体与伪加粗标记（drawMixed 与宽度测量共用） */
function charMetrics(ch: string, bold: boolean, fonts: Fonts, custom?: CustomFont) {
  const usedCustom = !!custom?.covers(ch);
  const font = fontFor(ch, bold, fonts, custom);
  // 中文字体和自定义字体无粗体字重时，双绘模拟加粗；有真粗体变体则跳过伪加粗
  const realBold = bold && usedCustom && !!custom?.bold && !!custom.boldCovers?.(ch);
  const faux = bold && !realBold && (usedCustom || needsCjk(ch));
  return { font, faux };
}

function advanceOf(font: PDFFont, faux: boolean, ch: string, size: number, t: TrackOpts): number {
  return (
    font.widthOfTextAtSize(ch, size) * (t.hs / 100) +
    t.cs +
    t.pad +
    (ch === ' ' ? t.ws : 0) +
    (faux ? size * 0.028 : 0)
  );
}

/** 与 drawMixed 相同口径的宽度测量（用于残差摊分） */
function trackedWidth(
  text: string,
  size: number,
  bold: boolean,
  fonts: Fonts,
  custom: CustomFont | undefined,
  t: TrackOpts,
): number {
  let w = 0;
  for (const ch of text) {
    if (ch === '\n') continue;
    const { font, faux } = charMetrics(ch, bold, fonts, custom);
    w += advanceOf(font, faux, ch, size, t);
  }
  return w;
}

/** 按 run 拆分（拉丁 / 非拉丁），逐段绘制，支持 faux-bold */
function drawMixed(
  page: PDFPage,
  text: string,
  x: number,
  baselineY: number,
  size: number,
  color: RGB,
  bold: boolean,
  fonts: Fonts,
  custom?: CustomFont,
  t: TrackOpts = NO_TRACK,
): number {
  let cx = x;
  for (const ch of text) {
    if (ch === '\n') continue;
    const { font, faux } = charMetrics(ch, bold, fonts, custom);
    page.drawText(ch, { x: cx, y: baselineY, size, font, color });
    if (faux) {
      page.drawText(ch, { x: cx + size * 0.028, y: baselineY, size, font, color });
    }
    cx += advanceOf(font, faux, ch, size, t);
  }
  return cx - x;
}

/** 把文本拆成可断行 token：连续拉丁字母/数字为一个 token，CJK 逐字 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  for (const ch of text) {
    if (needsCjk(ch) || ch === ' ') {
      if (buf) tokens.push(buf);
      buf = '';
      tokens.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

/** 在 maxWidth 内贪心换行，返回行数组（保留手动换行） */
function wrapText(text: string, maxWidth: number, size: number, bold: boolean, fonts: Fonts, custom?: CustomFont): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    const tokens = tokenize(rawLine);
    let line = '';
    for (const tok of tokens) {
      const candidate = line + tok;
      if (line && textWidth(candidate, size, bold, fonts, custom) > maxWidth && tok !== ' ') {
        lines.push(line.trimEnd());
        line = tok === ' ' ? '' : tok;
        // 单 token 超宽则按字符硬拆
        while (textWidth(line, size, bold, fonts, custom) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && textWidth(line.slice(0, cut), size, bold, fonts, custom) > maxWidth) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        line = candidate;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

const ERASE_PAD = 0.8;

function erase(page: PDFPage, pageH: number, x: number, y: number, w: number, h: number, color: string) {
  page.drawRectangle({
    x: x - ERASE_PAD,
    y: pageH - (y + h) - ERASE_PAD,
    width: w + ERASE_PAD * 2,
    height: h + ERASE_PAD * 2,
    color: hexToRgb(color),
  });
}

function drawSpanText(page: PDFPage, pageH: number, s: SpanEdit, fonts: Fonts, custom?: CustomFont) {
  const color = hexToRgb(s.color);
  const lineHeight = s.fontSize * 1.2;
  const t: TrackOpts = {
    cs: s.charSpacing ?? 0,
    ws: s.wordSpacing ?? 0,
    hs: s.hScale ?? 100,
    pad: 0,
  };
  // 纯改样式（文字未变）时，字体度量差异导致的残差按比例摊到逐字符 advance，
  // 使重绘总宽精确等于原宽，与擦除矩形对齐；残差过大则放弃摊分防止异常拉伸
  if (s.text === s.originalText && !s.text.includes('\n')) {
    const chars = [...s.text];
    if (chars.length > 0) {
      const base = trackedWidth(s.text, s.fontSize, s.bold, fonts, custom, t);
      const residual = s.width - base;
      if (Math.abs(residual) <= s.width * 0.5) t.pad = residual / chars.length;
    }
  }
  // 描边渲染模式（Tr=1/2/5/6，原文伪粗体）：描边色在下层四方向微偏移画光晕，填充色盖上面
  const rm = s.renderingMode ?? 0;
  const strokeOnly = rm === 1 || rm === 5;
  const fillAndStroke = rm === 2 || rm === 6;
  const strokeRgb = hexToRgb(s.strokeColor ?? s.color);
  const strokeOff = (s.strokeLineWidth ?? s.fontSize * 0.03) / 2;
  s.text.split('\n').forEach((line, i) => {
    if (!line) return;
    const baselineY = pageH - (s.y + s.baseline + i * lineHeight);
    if (fillAndStroke) {
      for (const [dx, dy] of [
        [-strokeOff, 0],
        [strokeOff, 0],
        [0, -strokeOff],
        [0, strokeOff],
      ]) {
        drawMixed(page, line, s.x + dx, baselineY + dy, s.fontSize, strokeRgb, s.bold, fonts, custom, t);
      }
    }
    drawMixed(
      page,
      line,
      s.x,
      baselineY,
      s.fontSize,
      strokeOnly ? strokeRgb : color,
      s.bold,
      fonts,
      custom,
      t,
    );
  });
}

function drawRegionFill(page: PDFPage, pageH: number, r: RegionEdit) {
  if (!r.fill) return;
  page.drawRectangle({
    x: r.x,
    y: pageH - (r.y + r.height),
    width: r.width,
    height: r.height,
    color: hexToRgb(r.fillColor),
  });
}

function drawRegionText(page: PDFPage, pageH: number, r: RegionEdit, fonts: Fonts, custom?: CustomFont) {
  if (!r.text.trim()) return;
  const inset = 2;
  const maxW = Math.max(4, r.width - inset * 2);
  const lines = wrapText(r.text, maxW, r.fontSize, r.bold, fonts, custom);
  const lineHeight = r.fontSize * 1.25;
  const blockH = lines.length * lineHeight;
  let startTop: number;
  if (r.valign === 'middle') startTop = r.y + (r.height - blockH) / 2;
  else if (r.valign === 'bottom') startTop = r.y + r.height - blockH;
  else startTop = r.y + inset;
  const color = hexToRgb(r.color);
  lines.forEach((line, i) => {
    if (!line) return;
    const w = textWidth(line, r.fontSize, r.bold, fonts, custom);
    let lx = r.x + inset;
    if (r.align === 'center') lx = r.x + (r.width - w) / 2;
    else if (r.align === 'right') lx = r.x + r.width - inset - w;
    const baselineY = pageH - (startTop + r.fontSize * 0.85 + i * lineHeight);
    drawMixed(page, line, lx, baselineY, r.fontSize, color, r.bold, fonts, custom);
  });
}

export interface ExportResult {
  bytes: Uint8Array;
  /** 是否有内容被修改 */
  changed: boolean;
}

/**
 * fontkit 的子集编码在 nextTick 回调里抛错时会逃逸成未捕获异常
 * （不 reject、stream 也不 emit error），导致 pdf-lib 的 save() 永远 pending，
 * 表现为导出按钮一直转圈。这里把全局 error 事件转成 rejection，交给上层降级重试。
 */
async function saveDoc(doc: PDFDocument): Promise<Uint8Array> {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return doc.save();
  }
  let onError: ((e: ErrorEvent) => void) | null = null;
  const trap = new Promise<never>((_, reject) => {
    onError = (e: ErrorEvent) => reject(e.error instanceof Error ? e.error : new Error(e.message));
    window.addEventListener('error', onError);
  });
  try {
    return await Promise.race([doc.save(), trap]);
  } finally {
    if (onError) window.removeEventListener('error', onError);
  }
}

/** 把所有编辑应用到原 PDF 并导出 */
export async function exportEditedPdf(
  originalBytes: Uint8Array,
  pages: PageState[],
  elementsById?: Map<string, VectorElement>,
): Promise<ExportResult> {
  try {
    return await applyEdits(originalBytes, pages, elementsById, true);
  } catch (err) {
    // fontkit 对部分字体/字符（如 CFF 字体含康熙部首 U+2F00 段字符）子集化会崩溃，
    // 关闭子集化（整体嵌入，产物更大）重试一次，保证导出一定完成
    console.warn('[导出] 子集化导出失败，改为整体嵌入字体后重试：', err);
    return applyEdits(originalBytes, pages, elementsById, false);
  }
}

async function applyEdits(
  originalBytes: Uint8Array,
  pages: PageState[],
  elementsById: Map<string, VectorElement> | undefined,
  useSubset: boolean,
): Promise<ExportResult> {
  const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
  doc.registerFontkit(fontkit);
  const pdfPages = doc.getPages();

  // 优先把被修改/删除文字的原始算子从内容流中真正移除（不破坏背景）；
  // 返回成功的 spanId 集合，未命中的 span 仍走下面的底色遮盖降级路径
  let redactedSpans = new Set<string>();
  try {
    redactedSpans = applyTextRedaction(doc, pages);
  } catch (err) {
    console.warn('[导出] 内容流改写失败，全部降级为底色遮盖：', err);
  }

  let changed = false;
  let cjkNeeded = false;
  for (const p of pages) {
    for (const s of p.spans) {
      if (spanDirty(s)) {
        changed = true;
        if (!s.deleted && [...s.text].some(needsCjk)) cjkNeeded = true;
      }
    }
    for (const r of p.regions) {
      changed = true;
      if ([...r.text].some(needsCjk)) cjkNeeded = true;
    }
    if (Object.keys(p.elementEdits).length > 0) changed = true;
  }

  const fonts: Fonts = {
    latin: await doc.embedFont(StandardFonts.Helvetica),
    latinBold: await doc.embedFont(StandardFonts.HelveticaBold),
    cjk: null,
  };
  if (cjkNeeded) {
    const resp = await fetch('/fonts/cjk.ttf');
    if (!resp.ok) throw new Error('中文字体加载失败，请检查 /fonts/cjk.ttf');
    // 注意：该字体已做预子集，直接整体嵌入（不可再用 pdf-lib 二次子集）
    fonts.cjk = await doc.embedFont(new Uint8Array(await resp.arrayBuffer()));
  }

  // 收集各编辑项选用的字体并嵌入；加载失败直接中止（不悄悄回退）。
  // 未显式选字体的 span 按原字体名自动匹配内置字体库（如 D-DIN PRO），保持与原文观感一致
  const customById = new Map<string, CustomFont>();
  const usedFontIds = new Set<string>();
  for (const p of pages) {
    for (const s of p.spans) {
      if (!spanDirty(s) || s.deleted || !s.text.trim()) continue;
      const fid = resolveFontChoice(s.fontId, s.originalFontName, s.bold, s.embeddedFontId).fontId;
      if (fid) usedFontIds.add(fid);
    }
    for (const r of p.regions) {
      if (r.text.trim() && r.fontId) usedFontIds.add(r.fontId);
    }
  }
  for (const id of usedFontIds) {
    const lf = await loadFontById(id);
    const pdfFont = await doc.embedFont(lf.bytes, { subset: useSubset && lf.subsettable });
    const entry: CustomFont = { font: pdfFont, covers: (ch) => fontCovers(lf, ch) };
    const boldId = boldVariantIdOf(id);
    if (boldId) {
      try {
        const blf = await loadFontById(boldId);
        entry.bold = await doc.embedFont(blf.bytes, { subset: useSubset && blf.subsettable });
        entry.boldCovers = (ch) => fontCovers(blf, ch);
      } catch {
        // 加粗变体缺失/损坏时静默降级为伪加粗，不影响导出流程
      }
    }
    customById.set(id, entry);
  }
  const customFor = (fontId?: string) => (fontId ? customById.get(fontId) : undefined);

  const imageCache = new Map<string, PDFImage>();

  for (const p of pages) {
    const page = pdfPages[p.pageIndex];
    if (!page) continue;
    const pageH = p.height;
    // 分层绘制，避免后画的擦除矩形盖住先画的文字：
    // 1) 所有擦除 → 2) 区域底色 → 3) 文字 → 4) 元素替换/移动重绘
    for (const s of p.spans) {
      if (!spanDirty(s)) continue;
      if (redactedSpans.has(s.id)) continue; // 原文已从内容流移除，无需遮盖
      erase(page, pageH, s.ox, s.oy, s.owidth, s.oheight, s.bgColor);
    }
    for (const edit of Object.values(p.elementEdits)) {
      const el = elementsById?.get(edit.elementId);
      if (!el) continue;
      const moved = edit.dx !== 0 || edit.dy !== 0;
      if (edit.deleted || moved || edit.replaceImage) {
        erase(page, pageH, el.x, el.y, el.width, el.height, edit.bgColor);
      }
    }
    for (const r of p.regions) drawRegionFill(page, pageH, r);
    for (const s of p.spans) {
      if (spanDirty(s) && !s.deleted && s.text.trim()) {
        const rf = resolveFontChoice(s.fontId, s.originalFontName, s.bold, s.embeddedFontId);
        drawSpanText(page, pageH, { ...s, bold: rf.bold }, fonts, customFor(rf.fontId));
      }
    }
    for (const r of p.regions) drawRegionText(page, pageH, r, fonts, customFor(r.fontId));
    for (const edit of Object.values(p.elementEdits)) {
      const el = elementsById?.get(edit.elementId);
      if (!el) continue;
      if (edit.deleted) continue;
      const moved = edit.dx !== 0 || edit.dy !== 0;
      if (edit.replaceImage) {
        const key = edit.replaceImage.name + edit.replaceImage.bytes.byteLength;
        let img = imageCache.get(key);
        if (!img) {
          const bytes = new Uint8Array(edit.replaceImage.bytes);
          img =
            edit.replaceImage.mime === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          imageCache.set(key, img);
        }
        // 等比缩放居中放入原 bbox（含位移）
        const scale = Math.min(el.width / img.width, el.height / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        const ix = el.x + edit.dx + (el.width - w) / 2;
        const iyTop = el.y + edit.dy + (el.height - h) / 2;
        page.drawImage(img, { x: ix, y: pageH - iyTop - h, width: w, height: h });
      } else if (moved && el.segs.length > 0) {
        // 重绘路径（屏幕位移 dx,dy → PDF y 向上取反），组合元素逐部分保持原色
        for (const part of partsOf(el)) {
          // pdf-lib drawSvgPath 内部自带 scale(1,-1)，路径数据需预先 y 取反
          const d = segsToPathData(part.segs, 0, 0, true);
          const hasFill = part.paints.some((pt) => pt.includes('fill'));
          const hasStroke = part.paints.some((pt) => pt.includes('stroke'));
          page.drawSvgPath(d, {
            x: edit.dx,
            y: -edit.dy,
            color: hasFill ? hexToRgb(part.fillColor) : undefined,
            borderColor: hasStroke ? hexToRgb(part.strokeColor) : undefined,
            borderWidth: hasStroke ? Math.max(part.lineWidth, 0.2) : undefined,
          });
        }
      }
    }
  }

  const bytes = await saveDoc(doc);
  return { bytes, changed };
}
