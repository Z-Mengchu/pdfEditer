/** 可编辑文字块（来自 PDF 真实文字层） */
export interface SpanEdit {
  kind: 'span';
  id: string;
  pageIndex: number;
  /** 当前位置/尺寸，pt，左上角原点 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 基线到顶部的距离，pt */
  baseline: number;
  /** 原始位置（用于擦除原文） */
  ox: number;
  oy: number;
  owidth: number;
  oheight: number;
  originalText: string;
  text: string;
  fontSize: number;
  /** 原始字号（spanDirty 判断用） */
  ofontSize: number;
  /** 文字颜色 #rrggbb */
  color: string;
  /** 原始文字颜色（spanDirty 判断用） */
  ocolor: string;
  /** 擦除原文时使用的背景色（采样自原文周围） */
  bgColor: string;
  /** 原始背景色（spanDirty 判断用） */
  obgColor: string;
  bold: boolean;
  /** 解析 PDF 时识别出的原始加粗状态，用于判断 spanDirty */
  originalBold: boolean;
  /** 选用的字体（fonts.ts 的 fontId）；undefined = 默认 Helvetica/文泉驿 */
  fontId?: string;
  /** 解析 PDF 时识别出的原字体名（仅展示用） */
  originalFontName?: string;
  /** 从原文提取的内嵌字体 fontId（embedded:…）；未显式选字体时优先于内置库匹配 */
  embeddedFontId?: string;
  /** 原文字距 Tc（pt，默认 0）；非用户可编辑，不参与 spanDirty */
  charSpacing?: number;
  /** 原词距 Tw（pt，默认 0，仅对空格生效） */
  wordSpacing?: number;
  /** 原水平缩放 Tz（百分比，默认 100 = 无缩放） */
  hScale?: number;
  /** 原渲染模式 Tr（默认 0=填充；1/5=描边，2/6=填充+描边，3=不可见） */
  renderingMode?: number;
  /** 原描边色 #rrggbb（描边渲染模式下使用） */
  strokeColor?: string;
  /** 原描边线宽（pt） */
  strokeLineWidth?: number;
  /** 已删除 = 导出时仅擦除 */
  deleted: boolean;
}

/** 框选区域：涂抹底色 + 可选新文字（用于转曲文字/图标区域） */
export interface RegionEdit {
  kind: 'region';
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** 是否填充底色 */
  fill: boolean;
  fillColor: string;
  text: string;
  fontSize: number;
  color: string;
  bold: boolean;
  /** 选用的字体（fonts.ts 的 fontId）；undefined = 默认 Helvetica/文泉驿 */
  fontId?: string;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
}

/** 矢量元素（图标/转曲文字块/图片）上的编辑操作 */
export interface ElementEdit {
  elementId: string;
  pageIndex: number;
  /** 删除 = 涂抹该区域 */
  deleted: boolean;
  /** 位移（pt，左上角原点，仅路径元素支持） */
  dx: number;
  dy: number;
  /** 替换为图片 */
  replaceImage: { bytes: ArrayBuffer; mime: 'image/png' | 'image/jpeg'; name: string } | null;
  /** 涂抹底色 */
  bgColor: string;
}

export interface PageState {
  pageIndex: number;
  /** pt */
  width: number;
  height: number;
  spans: SpanEdit[];
  regions: RegionEdit[];
  /** 元素级编辑，key 为 elementId */
  elementEdits: Record<string, ElementEdit>;
}

export type EditItem = SpanEdit | RegionEdit;

export type Tool = 'select' | 'region' | 'text' | 'element';

export type Selection = {
  kind: 'span' | 'region' | 'element';
  id: string;
} | null;

export function isSpan(item: EditItem): item is SpanEdit {
  return item.kind === 'span';
}

/** 文字块是否被修改过（需要导出时重绘）；fontId 变化也视为修改（换字体需擦除重绘） */
export function spanDirty(s: SpanEdit): boolean {
  return (
    s.deleted ||
    s.fontId != null ||
    s.text !== s.originalText ||
    s.bold !== s.originalBold ||
    s.fontSize !== s.ofontSize ||
    s.color !== s.ocolor ||
    s.bgColor !== s.obgColor ||
    s.x !== s.ox ||
    s.y !== s.oy ||
    s.width !== s.owidth ||
    s.height !== s.oheight
  );
}

/** 元素编辑是否有实际效果（区别于仅选中时创建的占位记录） */
export function elementEditActive(e: ElementEdit): boolean {
  return e.deleted || e.dx !== 0 || e.dy !== 0 || !!e.replaceImage;
}
