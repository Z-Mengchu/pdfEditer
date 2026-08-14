import { OPS, type PDFPageProxy } from 'pdfjs-dist';

/**
 * 从 operatorList 解析矢量元素（路径 + 栅格图片），
 * 用于元素级点选（图标、转曲文字块、表格线、产品图）。
 */

export interface PathSeg {
  op: 'M' | 'L' | 'C' | 'Q' | 'Z';
  pts: number[]; // PDF 用户空间坐标（y 向上）
}

export type PaintKind = 'fill' | 'eoFill' | 'stroke' | 'fillStroke' | 'eoFillStroke';

/** 独立颜色/绘制方式的子路径组（用于多选组合保持各自颜色） */
export interface ElementPart {
  segs: PathSeg[];
  paints: PaintKind[];
  fillColor: string;
  strokeColor: string;
  lineWidth: number;
}

export interface VectorElement {
  id: string;
  pageIndex: number;
  /** 簇内成员（按绘制顺序） */
  segs: PathSeg[];
  paints: PaintKind[];
  fillColor: string;
  strokeColor: string;
  lineWidth: number;
  /** 组合元素的子部分（各自独立颜色）；单元素为空 */
  parts?: ElementPart[];
  /** bbox，左上角原点（pt） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 栅格图片对象 id（paintImageXObject），路径元素为 null */
  imageObjId: string | null;
  /** 元素在页面内容流中的最大序号（z 序） */
  order: number;
}

/** 返回元素的绘制部分列表（组合元素返回各部分，单元素返回自身） */
export function partsOf(el: VectorElement): ElementPart[] {
  return (
    el.parts ?? [
      {
        segs: el.segs,
        paints: el.paints,
        fillColor: el.fillColor,
        strokeColor: el.strokeColor,
        lineWidth: el.lineWidth,
      },
    ]
  );
}

const PAINT_MAP: Record<number, PaintKind> = {
  [OPS.stroke]: 'stroke',
  [OPS.closeStroke]: 'stroke',
  [OPS.fill]: 'fill',
  [OPS.eoFill]: 'eoFill',
  [OPS.fillStroke]: 'fillStroke',
  [OPS.eoFillStroke]: 'eoFillStroke',
  [OPS.closeFillStroke]: 'fillStroke',
  [OPS.closeEOFillStroke]: 'eoFillStroke',
};

type Mat = [number, number, number, number, number, number];

function matMul(m1: Mat, m2: Mat): Mat {
  const [a, b, c, d, e, f] = m1;
  const [g, h, i, j, k, l] = m2;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

function applyMat(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function grayToHex(g: number): string {
  const v = Math.round(Math.max(0, Math.min(1, g)) * 255);
  return `#${v.toString(16).padStart(2, '0').repeat(3)}`;
}

function cmykToHex(c: number, m: number, y: number, k: number): string {
  const f = (v: number) => Math.round(Math.max(0, Math.min(1, (1 - v) * (1 - k))) * 255);
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(f(c))}${h(f(m))}${h(f(y))}`;
}

interface RawPath {
  segs: PathSeg[];
  paint: PaintKind;
  fillColor: string;
  strokeColor: string;
  lineWidth: number;
  bbox: [number, number, number, number]; // x0,y0,x1,y1 PDF 用户空间
  order: number;
}

interface RawImage {
  objId: string;
  bbox: [number, number, number, number];
  order: number;
}

/** 解析一页的全部矢量路径与图片 */
export async function extractRawGraphics(
  page: PDFPageProxy,
): Promise<{ paths: RawPath[]; images: RawImage[] }> {
  const ol = await page.getOperatorList();
  const paths: RawPath[] = [];
  const images: RawImage[] = [];

  let ctm: Mat = [1, 0, 0, 1, 0, 0];
  let fillColor = '#000000';
  let strokeColor = '#000000';
  let lineWidth = 1;
  const stack: { ctm: Mat; fill: string; stroke: string; lw: number }[] = [];

  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const args = ol.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push({ ctm: [...ctm] as Mat, fill: fillColor, stroke: strokeColor, lw: lineWidth });
        break;
      case OPS.restore: {
        const s = stack.pop();
        if (s) {
          ctm = s.ctm;
          fillColor = s.fill;
          strokeColor = s.stroke;
          lineWidth = s.lw;
        }
        break;
      }
      case OPS.transform:
        ctm = matMul(ctm, args as Mat);
        break;
      case OPS.setFillRGBColor:
        fillColor = args[0];
        break;
      case OPS.setStrokeRGBColor:
        strokeColor = args[0];
        break;
      case OPS.setFillGray:
        fillColor = grayToHex(args[0]);
        break;
      case OPS.setStrokeGray:
        strokeColor = grayToHex(args[0]);
        break;
      case OPS.setFillCMYKColor:
        fillColor = cmykToHex(args[0], args[1], args[2], args[3]);
        break;
      case OPS.setStrokeCMYKColor:
        strokeColor = cmykToHex(args[0], args[1], args[2], args[3]);
        break;
      case OPS.setLineWidth:
        lineWidth = args[0];
        break;
      case OPS.constructPath: {
        const paint = PAINT_MAP[args[0] as number];
        if (!paint) break;
        const data: Float32Array = args[1][0];
        const segs: PathSeg[] = [];
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        const acc = (x: number, y: number) => {
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x > x1) x1 = x;
          if (y > y1) y1 = y;
        };
        for (let p = 0; p < data.length; ) {
          const op = data[p++];
          if (op === 0) {
            const [x, y] = applyMat(ctm, data[p], data[p + 1]);
            p += 2;
            segs.push({ op: 'M', pts: [x, y] });
            acc(x, y);
          } else if (op === 1) {
            const [x, y] = applyMat(ctm, data[p], data[p + 1]);
            p += 2;
            segs.push({ op: 'L', pts: [x, y] });
            acc(x, y);
          } else if (op === 2) {
            const pts: number[] = [];
            for (let k = 0; k < 3; k++) {
              const [x, y] = applyMat(ctm, data[p + k * 2], data[p + k * 2 + 1]);
              pts.push(x, y);
              acc(x, y);
            }
            p += 6;
            segs.push({ op: 'C', pts });
          } else if (op === 3) {
            const pts: number[] = [];
            for (let k = 0; k < 2; k++) {
              const [x, y] = applyMat(ctm, data[p + k * 2], data[p + k * 2 + 1]);
              pts.push(x, y);
              acc(x, y);
            }
            p += 4;
            segs.push({ op: 'Q', pts });
          } else if (op === 4) {
            segs.push({ op: 'Z', pts: [] });
          } else {
            break;
          }
        }
        if (x0 === Infinity || segs.length === 0) break;
        // 线宽随 CTM 缩放（近似）
        const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1;
        paths.push({
          segs,
          paint,
          fillColor,
          strokeColor,
          lineWidth: lineWidth * scale,
          bbox: [x0, y0, x1, y1],
          order: i,
        });
        break;
      }
      case OPS.paintImageXObject: {
        const objId = args[0] as string;
        const corners: [number, number][] = [
          applyMat(ctm, 0, 0),
          applyMat(ctm, 1, 0),
          applyMat(ctm, 0, 1),
          applyMat(ctm, 1, 1),
        ];
        const xs = corners.map((c) => c[0]);
        const ys = corners.map((c) => c[1]);
        images.push({
          objId,
          bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          order: i,
        });
        break;
      }
      default:
        break;
    }
  }
  return { paths, images };
}

/** 近邻聚簇：把间距小于 gap 的路径合并为一个可选中元素（字母→单词、图标部件→图标） */
export function clusterElements(
  paths: RawPath[],
  images: RawImage[],
  pageIndex: number,
  pageHeight: number,
  gap = 2.5,
): VectorElement[] {
  const n = paths.length;
  const parent = new Array<number>(n).fill(0).map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const near = (a: [number, number, number, number], b: [number, number, number, number]) =>
    a[0] - gap <= b[2] && b[0] - gap <= a[2] && a[1] - gap <= b[3] && b[1] - gap <= a[3];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (near(paths[i].bbox, paths[j].bbox)) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }

  const elements: VectorElement[] = [];
  let seq = 0;
  for (const members of groups.values()) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      order = 0;
    const segs: PathSeg[] = [];
    const paints: PaintKind[] = [];
    let fillColor = '#000000';
    let strokeColor = '#000000';
    let lineWidth = 1;
    for (const mi of members) {
      const p = paths[mi];
      segs.push(...p.segs);
      paints.push(p.paint);
      if (p.paint.includes('fill')) fillColor = p.fillColor;
      if (p.paint.includes('stroke')) {
        strokeColor = p.strokeColor;
        lineWidth = p.lineWidth;
      }
      x0 = Math.min(x0, p.bbox[0]);
      y0 = Math.min(y0, p.bbox[1]);
      x1 = Math.max(x1, p.bbox[2]);
      y1 = Math.max(y1, p.bbox[3]);
      order = Math.max(order, p.order);
    }
    elements.push({
      id: `e${pageIndex}-${seq++}`,
      pageIndex,
      segs,
      paints,
      fillColor,
      strokeColor,
      lineWidth,
      x: x0,
      y: pageHeight - y1,
      width: x1 - x0,
      height: y1 - y0,
      imageObjId: null,
      order,
    });
  }
  for (const img of images) {
    const [x0, y0, x1, y1] = img.bbox;
    elements.push({
      id: `e${pageIndex}-${seq++}`,
      pageIndex,
      segs: [],
      paints: [],
      fillColor: '#000000',
      strokeColor: '#000000',
      lineWidth: 0,
      x: x0,
      y: pageHeight - y1,
      width: x1 - x0,
      height: y1 - y0,
      imageObjId: img.objId,
      order: img.order,
    });
  }
  return elements;
}

/** 生成 SVG path 字符串（PDF 用户空间坐标，可带偏移；flipY 用于 pdf-lib drawSvgPath） */
export function segsToPathData(segs: PathSeg[], dx = 0, dy = 0, flipY = false): string {
  const r = (v: number) => Math.round(v * 100) / 100;
  return segs
    .map((s) => {
      if (s.op === 'Z') return 'Z';
      const pts = s.pts.map((v, i) => {
        const isX = i % 2 === 0;
        const off = v + (isX ? dx : dy);
        return r(!isX && flipY ? -off : off);
      });
      return `${s.op} ${pts.join(' ')}`;
    })
    .join(' ');
}

/* ---------- 命中测试 ---------- */

let hitCanvas: HTMLCanvasElement | null = null;

function getHitCtx(): CanvasRenderingContext2D {
  if (!hitCanvas) {
    hitCanvas = document.createElement('canvas');
    hitCanvas.width = 4;
    hitCanvas.height = 4;
  }
  return hitCanvas.getContext('2d', { willReadFrequently: true })!;
}

/**
 * 在元素数组中查找命中点（pt，左上角原点）的最上层元素。
 * pdfX/pdfY：同一点的 PDF 用户空间坐标（y 向上）。
 */
export function hitTestElements(
  elements: VectorElement[],
  x: number,
  y: number,
  pdfX: number,
  pdfY: number,
): VectorElement | null {
  const sorted = [...elements].sort((a, b) => b.order - a.order);
  const ctx = getHitCtx();
  const bboxHits: VectorElement[] = [];
  for (const el of sorted) {
    if (x < el.x - 1 || x > el.x + el.width + 1 || y < el.y - 1 || y > el.y + el.height + 1) continue;
    bboxHits.push(el);
    if (el.imageObjId) return el; // 图片：bbox 命中即可
    const d = segsToPathData(el.segs);
    const path = new Path2D(d);
    const hasFill = el.paints.some((p) => p.includes('fill'));
    const hasStroke = el.paints.some((p) => p.includes('stroke'));
    if (hasFill && ctx.isPointInPath(path, pdfX, pdfY)) return el;
    if (hasStroke) {
      ctx.lineWidth = Math.max(el.lineWidth, 1.5);
      if (ctx.isPointInStroke(path, pdfX, pdfY)) return el;
    }
    // 细路径兜底：bbox 命中也算（避免点不中细线）
    if (el.width < 3 || el.height < 3) return el;
  }
  // 精确命中失败（如点在字母镂空处）：返回面积最小的 bbox 命中元素
  if (bboxHits.length > 0) {
    bboxHits.sort((a, b) => a.width * a.height - b.width * b.height);
    return bboxHits[0];
  }
  return null;
}
