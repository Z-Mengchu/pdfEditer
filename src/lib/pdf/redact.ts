import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
  type PDFObject,
  type PDFPage,
} from 'pdf-lib';
import type { PageState, SpanEdit } from './types';
import { spanDirty } from './types';

/**
 * 内容流改写：把被修改/删除 span 的原始文本显示算子（Tj/TJ/'/"）从内容流中真正
 * 移除（或包成 Tr=3 不可见），取代「底色矩形遮盖」，背景（线条/图片/渐变）不受破坏。
 *
 * 对齐原理：pdf.js 提取阶段已把 getTextContent 的 item 与算子流中的显示算子做了
 * 流式文本对齐（见 pdfjs.ts alignStatesToItems），span 携带贡献算子序号 textOps；
 * 这里用 pdf-lib 重新解析原始内容流，按相同规则（含 Form XObject 递归展开）得到
 * 同序的算子序列，按序号一一对应，再用「原点校验」确认对齐没有错位（算子原点须与
 * 提取时记录的 opOrigins 一致）。任何一步失败 → 该 span 返回 false，调用方降级遮盖。
 *
 * 不追踪字形步进：显示算子不更新 Tlm，且本模块只在「定位算子之后」的 checkpoint
 * 算子处使用原点（此时 Tm 被绝对重置，无需字宽即可精确计算）。
 */

/* ---------------- 矩阵（与 elements.ts 同一约定：列向量，ctm = matMul(ctm, m)） ---------------- */

type Mat = [number, number, number, number, number, number];
const IDENT: Mat = [1, 0, 0, 1, 0, 0];

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

/* ---------------- 内容流 tokenizer ---------------- */

const isWs = (b: number) => b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
const isDelim = (b: number) =>
  b === 40 || b === 41 || b === 60 || b === 62 || b === 91 || b === 93 || b === 123 || b === 125 || b === 47 || b === 37;

interface Token {
  kind: 'num' | 'name' | 'str' | 'word';
  start: number;
  end: number; // 不含
  num?: number;
  text?: string; // name（已解码 #xx）或 word 原文
}

class Scanner {
  pos = 0;
  bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  private skipWsComments() {
    const b = this.bytes;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (isWs(c)) {
        this.pos++;
      } else if (c === 37) {
        // % 注释到行尾
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  next(): Token | null {
    this.skipWsComments();
    const b = this.bytes;
    if (this.pos >= b.length) return null;
    const start = this.pos;
    const c = b[this.pos];
    // 字面串：平衡括号 + 反斜杠转义
    if (c === 40) {
      let i = this.pos + 1;
      let depth = 1;
      while (i < b.length && depth > 0) {
        const ch = b[i];
        if (ch === 92) i += 2; // 转义（含行延续），整体跳过
        else if (ch === 40) {
          depth++;
          i++;
        } else if (ch === 41) {
          depth--;
          i++;
        } else i++;
      }
      this.pos = i;
      return { kind: 'str', start, end: i };
    }
    // < 十六进制串 / << 字典开
    if (c === 60) {
      if (b[this.pos + 1] === 60) {
        this.pos += 2;
        return { kind: 'word', start, end: this.pos, text: '<<' };
      }
      let i = this.pos + 1;
      while (i < b.length && b[i] !== 62) i++;
      this.pos = Math.min(i + 1, b.length);
      return { kind: 'str', start, end: this.pos };
    }
    if (c === 62 && b[this.pos + 1] === 62) {
      this.pos += 2;
      return { kind: 'word', start, end: this.pos, text: '>>' };
    }
    if (c === 91 || c === 93 || c === 123 || c === 125 || c === 62) {
      this.pos++;
      return { kind: 'word', start, end: this.pos, text: String.fromCharCode(c) };
    }
    // 名字：/ 到分隔符/空白，解码 #xx
    if (c === 47) {
      let i = this.pos + 1;
      while (i < b.length && !isWs(b[i]) && !isDelim(b[i])) i++;
      const raw = String.fromCharCode(...b.subarray(this.pos + 1, i));
      this.pos = i;
      return { kind: 'name', start, end: i, text: raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    // 普通词：数字或算子
    let i = this.pos;
    while (i < b.length && !isWs(b[i]) && !isDelim(b[i])) i++;
    const w = String.fromCharCode(...b.subarray(this.pos, i));
    this.pos = i;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return { kind: 'num', start, end: i, num: parseFloat(w) };
    return { kind: 'word', start, end: i, text: w };
  }

  /** 跳过内联图像 BI…ID…EI（ID 后原始字节可能形似算子，必须整体跳过） */
  skipInlineImage() {
    const b = this.bytes;
    // 读键值对直到 ID
    for (;;) {
      const t = this.next();
      if (!t) return;
      if (t.kind === 'word' && t.text === 'ID') break;
    }
    if (this.pos < b.length && isWs(b[this.pos])) this.pos++;
    const dataStart = this.pos;
    // 找 \s EI \s（或 EOF/分隔符），并验证其后能正常切出算子，防止数据内误命中
    for (let i = dataStart; i + 1 < b.length; i++) {
      if (b[i] !== 69 || b[i + 1] !== 73) continue; // E I
      if (i > 0 && !isWs(b[i - 1])) continue;
      const after = i + 2;
      if (after < b.length && !isWs(b[after]) && !isDelim(b[after])) continue;
      // 验证：EI 之后应能切出一个像样的算子/结构词
      const probe = new Scanner(b);
      probe.pos = after;
      const t = probe.next();
      if (!t || (t.kind === 'word' && /^[A-Za-z*'"[\]{}<>]+$/.test(t.text ?? ''))) {
        this.pos = after;
        return;
      }
    }
    this.pos = b.length; // 没找到：放弃本流剩余部分（校验阶段会因算子数不符而降级）
  }
}

/* ---------------- 解析结果结构 ---------------- */

interface RawShowOp {
  seq: number;
  stream: PDFRawStream;
  /** 操作数起点（含）到算子终点（不含），解码后字节偏移 */
  start: number;
  end: number;
  /** 用户空间原点（y 向上）；仅 checkpoint 时精确 */
  ox: number;
  oy: number;
  /** 原点是否精确（算子紧跟 BT/Td/TD/Tm/T*，Tm 被绝对重置） */
  checkpoint: boolean;
  /** 该处的文本渲染模式 Tr（Tr=3 包裹后恢复用） */
  tr: number;
  /** ' / " 算子自带 T* 换行，不能整体删除（会丢换行），只能 Tr 包裹 */
  forceWrap: boolean;
}

type Ev = { t: 'show'; op: RawShowOp } | { t: 'pos' } | { t: 'bt' } | { t: 'et' };

interface ParsedPage {
  ops: RawShowOp[];
  events: Map<PDFRawStream, Ev[]>;
  bytes: Map<PDFRawStream, Uint8Array>;
  refs: PDFRef[];
}

/** 图形状态（q/Q 保存的范围里与本解析相关的部分；文字状态 Tc/Tw/Tz/Tf 不影响原点，忽略） */
interface GState {
  ctm: Mat;
  tr: number;
  tl: number;
}

function asDict(doc: PDFDocument, obj: PDFObject | undefined): PDFDict | undefined {
  const o = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return o instanceof PDFDict ? o : undefined;
}

/** Resources 可继承自 Pages 祖先节点 */
function findResources(doc: PDFDocument, node: PDFDict): PDFDict | undefined {
  let cur: PDFDict | undefined = node;
  for (let hops = 0; cur && hops < 32; hops++) {
    const res = asDict(doc, cur.get(PDFName.of('Resources')));
    if (res) return res;
    cur = asDict(doc, cur.get(PDFName.of('Parent')));
  }
  return undefined;
}

function formMatrix(dict: PDFDict): Mat {
  const m = dict.get(PDFName.of('Matrix'));
  if (m instanceof PDFArray && m.size() === 6) {
    const n = (i: number, d: number) => {
      const v = m.get(i);
      return v instanceof PDFNumber ? v.asNumber() : d;
    };
    return [n(0, 1), n(1, 0), n(2, 0), n(3, 1), n(4, 0), n(5, 0)];
  }
  return IDENT;
}

/** 解析单个内容流，把显示算子追加到 out；遇到 Form XObject 递归展开（与 pdf.js 同序） */
function parseStreamInto(
  doc: PDFDocument,
  out: ParsedPage,
  stream: PDFRawStream,
  resources: PDFDict | undefined,
  st: GState,
  depth: number,
) {
  const bytes = decodePDFRawStream(stream).decode();
  out.bytes.set(stream, bytes);
  const events: Ev[] = [];
  out.events.set(stream, events);
  const sc = new Scanner(bytes);
  const stack: GState[] = [];
  let { ctm, tr, tl } = st;
  // 文本对象状态（BT/ET 管理，q/Q 不保存）：BT 重置 Tm/Tlm
  let tm: Mat = IDENT;
  let tlm: Mat = IDENT;
  let inText = false;
  // 上一个事件是否为绝对定位（BT/Td/TD/Tm/T*）：其后第一个显示算子的原点无需字宽即精确
  let positioned = true;
  let operands: Token[] = [];

  const num = (i: number) => (operands[i]?.kind === 'num' ? operands[i].num! : 0);

  for (;;) {
    const tok = sc.next();
    if (!tok) break;
    if (tok.kind !== 'word') {
      operands.push(tok);
      continue;
    }
    const w = tok.text!;
    if (w === '[' || w === '<<') {
      // 数组/字典作为一个操作数，按平衡括号跳过（字符串已被 tokenizer 视为整体）
      const close = w === '[' ? ']' : '>>';
      const open = w;
      let d = 1;
      let last = tok;
      for (;;) {
        const t = sc.next();
        if (!t) break;
        last = t;
        if (t.kind === 'word') {
          if (t.text === open) d++;
          else if (t.text === close) {
            d--;
            if (d === 0) break;
          }
        }
      }
      operands.push({ kind: 'str', start: tok.start, end: last.end });
      continue;
    }
    if (w === ']' || w === '>>' || w === '}' || w === '{') continue; // 孤立闭括号，忽略
    if (w === 'true' || w === 'false' || w === 'null') {
      operands.push(tok);
      continue;
    }

    // 以下是算子
    const opStart = operands.length > 0 ? operands[0].start : tok.start;
    const opEnd = tok.end;
    switch (w) {
      case 'q':
        stack.push({ ctm, tr, tl });
        break;
      case 'Q': {
        const s = stack.pop();
        if (s) ({ ctm, tr, tl } = s);
        break;
      }
      case 'cm':
        ctm = matMul(ctm, [num(0), num(1), num(2), num(3), num(4), num(5)]);
        break;
      case 'BT':
        inText = true;
        tm = IDENT;
        tlm = IDENT;
        positioned = true;
        events.push({ t: 'bt' });
        break;
      case 'ET':
        inText = false;
        events.push({ t: 'et' });
        break;
      case 'Td':
      case 'TD': {
        if (w === 'TD') tl = -num(1);
        tlm = matMul(tlm, [1, 0, 0, 1, num(0), num(1)]);
        tm = tlm;
        positioned = true;
        events.push({ t: 'pos' });
        break;
      }
      case 'Tm':
        tlm = tm = [num(0), num(1), num(2), num(3), num(4), num(5)];
        positioned = true;
        events.push({ t: 'pos' });
        break;
      case 'TL':
        tl = num(0);
        break;
      case 'T*':
        tlm = matMul(tlm, [1, 0, 0, 1, 0, -tl]);
        tm = tlm;
        positioned = true;
        events.push({ t: 'pos' });
        break;
      case 'Tr':
        tr = num(0);
        break;
      case "'":
      case '"':
      case 'Tj':
      case 'TJ': {
        if (w === "'" || w === '"') {
          // ' / " 先执行 T* 再显示
          tlm = matMul(tlm, [1, 0, 0, 1, 0, -tl]);
          tm = tlm;
          positioned = true;
          events.push({ t: 'pos' });
        }
        const [ox, oy] = applyMat(ctm, tm[4], tm[5]);
        const op: RawShowOp = {
          seq: out.ops.length,
          stream,
          start: opStart,
          end: opEnd,
          ox,
          oy,
          checkpoint: positioned && inText,
          tr,
          forceWrap: w === "'" || w === '"',
        };
        out.ops.push(op);
        events.push({ t: 'show', op });
        positioned = false;
        break;
      }
      case 'Do': {
        if (depth < 8 && resources) {
          const nameTok = operands[0];
          if (nameTok?.kind === 'name') {
            const xobjDict = asDict(doc, resources.get(PDFName.of('XObject')));
            const entry = xobjDict?.get(PDFName.of(nameTok.text!));
            const ref = entry instanceof PDFRef ? entry : null;
            const target = ref ? doc.context.lookup(ref) : entry;
            if (target instanceof PDFRawStream) {
              const sub = target.dict.get(PDFName.of('Subtype'));
              if (sub instanceof PDFName && sub.decodeText() === 'Form') {
                if (ref && !out.refs.includes(ref)) out.refs.push(ref);
                const formRes = asDict(doc, target.dict.get(PDFName.of('Resources'))) ?? resources;
                // pdf.js 对 form 隐式 q/Q：递归用副本，状态不回流
                parseStreamInto(
                  doc,
                  out,
                  target,
                  formRes,
                  { ctm: matMul(ctm, formMatrix(target.dict)), tr, tl },
                  depth + 1,
                );
              }
            }
          }
        }
        break;
      }
      case 'BI':
        sc.skipInlineImage();
        break;
      default:
        break;
    }
    operands = [];
  }
}

/** 解析一页的全部显示算子（内容流数组按序拼接，Form XObject 递归展开） */
function parsePage(doc: PDFDocument, page: PDFPage): ParsedPage | null {
  const out: ParsedPage = { ops: [], events: new Map(), bytes: new Map(), refs: [] };
  const contents = page.node.Contents();
  if (!contents) return null;
  const streams: PDFRawStream[] = [];
  const pushStream = (obj: PDFObject | undefined) => {
    const ref = obj instanceof PDFRef ? obj : null;
    const o = ref ? doc.context.lookup(ref) : obj;
    if (o instanceof PDFRawStream) {
      streams.push(o);
      if (ref && !out.refs.includes(ref)) out.refs.push(ref);
    }
  };
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) pushStream(contents.get(i));
  } else {
    pushStream(contents);
  }
  if (streams.length === 0) return null;
  const resources = findResources(doc, page.node);
  // 同一页的拼接内容流共享图形状态（状态跨流延续）
  const st: GState = { ctm: IDENT, tr: 0, tl: 0 };
  for (const s of streams) parseStreamInto(doc, out, s, resources, st, 0);
  return out;
}

/* ---------------- 字节改写 ---------------- */

interface ByteEdit {
  pos: number;
  del: number;
  ins: string;
}

const encoder = new TextEncoder();

function spliceBytes(src: Uint8Array, edits: ByteEdit[]): Uint8Array {
  // 去重（同一 form 被多次 Do 且都算隐藏时产生相同编辑）
  const uniq = new Map<string, ByteEdit>();
  for (const e of edits) uniq.set(`${e.pos}:${e.del}:${e.ins}`, e);
  const sorted = [...uniq.values()].sort((a, b) => a.pos - b.pos || a.del - b.del);
  const parts: Uint8Array[] = [];
  let cur = 0;
  for (const e of sorted) {
    if (e.pos < cur) continue; // 与前序编辑重叠：跳过（保守）
    parts.push(src.subarray(cur, e.pos));
    if (e.ins) parts.push(encoder.encode(e.ins));
    cur = e.pos + e.del;
  }
  parts.push(src.subarray(cur));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 决定每个待隐藏算子的处理方式并生成字节编辑：能整体删除就删除，否则 Tr=3 包裹保步进 */
function planStreamEdits(events: Ev[], hidden: Set<RawShowOp>): ByteEdit[] {
  const edits: ByteEdit[] = [];
  let pending: RawShowOp[] = []; // 上一个定位边界以来累计的待隐藏算子
  const flush = (canDelete: boolean) => {
    for (const op of pending) {
      if (canDelete && !op.forceWrap) {
        edits.push({ pos: op.start, del: op.end - op.start, ins: '' });
      } else {
        edits.push({ pos: op.start, del: 0, ins: '3 Tr ' });
        edits.push({ pos: op.end, del: 0, ins: ` ${op.tr} Tr ` });
      }
    }
    pending = [];
  };
  for (const ev of events) {
    if (ev.t === 'show') {
      if (hidden.has(ev.op)) pending.push(ev.op);
      else flush(false); // 后续保留算子依赖其步进 → 只能包裹
    } else {
      flush(true); // 定位边界（pos/bt/et）：后续算子绝对定位 → 可整体删除
    }
  }
  flush(true);
  return edits;
}

/** 同一字节区间被多个算子共享（form 多次 Do）：只有全部隐藏才允许改写，否则放弃其中待隐藏的 */
function resolveSharedRanges(parsed: ParsedPage, hidden: Set<RawShowOp>): Set<RawShowOp> {
  // 按流分组再按字节区间分组
  const perStream = new Map<PDFRawStream, Map<string, RawShowOp[]>>();
  for (const op of parsed.ops) {
    let m = perStream.get(op.stream);
    if (!m) perStream.set(op.stream, (m = new Map()));
    const key = `${op.start}:${op.end}`;
    const arr = m.get(key);
    if (arr) arr.push(op);
    else m.set(key, [op]);
  }
  const drop = new Set<RawShowOp>();
  for (const m of perStream.values()) {
    for (const group of m.values()) {
      if (group.length < 2) continue;
      const someHidden = group.some((op) => hidden.has(op));
      const someKept = group.some((op) => !hidden.has(op));
      if (someHidden && someKept) {
        for (const op of group) if (hidden.has(op)) drop.add(op);
      }
    }
  }
  return drop;
}

/**
 * 把 pages 中被修改/删除的 span 的原始文字从 PDF 内容流中移除。
 * 返回成功改写的 spanId 集合；未命中的 span 由调用方走「底色遮盖」降级路径。
 */
export function applyTextRedaction(doc: PDFDocument, pages: PageState[]): Set<string> {
  const redacted = new Set<string>();
  const claimed = new Set<PDFRef>(); // 已被某页改写声明的流对象（防跨页共享内容流互相干扰）
  const pdfPages = doc.getPages();

  for (const p of pages) {
    const dirtySpans = p.spans.filter(spanDirty);
    if (dirtySpans.length === 0) continue;

    let parsed: ParsedPage | null = null;
    try {
      const page = pdfPages[p.pageIndex];
      if (page) parsed = parsePage(doc, page);
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    // 算子总数必须与提取时一致，否则序号对不上，整页降级
    if (parsed.ops.length !== p.textOpCount) continue;
    // 流对象跨页共享 → 本页放弃（改它会波及其它页）
    if (parsed.refs.some((r) => claimed.has(r))) continue;

    // 页级几何校验：提取时记录的原点 vs 本次解析的原点（仅 checkpoint 算子精确可比）
    let checked = 0;
    let aligned = true;
    for (const [k, o] of Object.entries(p.opOrigins ?? {})) {
      const op = parsed.ops[+k];
      if (!op) {
        aligned = false;
        break;
      }
      if (!op.checkpoint) continue;
      const yTop = p.height - op.oy;
      if (Math.abs(op.ox - o.x) > 1.5 || Math.abs(yTop - o.y) > 1.5) {
        aligned = false;
        break;
      }
      checked++;
    }
    if (!aligned || checked === 0) continue;

    // 算子 → span 归属（含未修改 span，用于共享检测：一个 TJ 被 pdf.js 拆成多个 item 时，
    // 只改其中一个 span 不能整块移除该算子）
    const owners = new Map<number, SpanEdit[]>();
    for (const s of p.spans) {
      for (const i of s.textOps ?? []) {
        const arr = owners.get(i);
        if (arr) arr.push(s);
        else owners.set(i, [s]);
      }
    }

    const hidden = new Set<RawShowOp>();
    const spanOps = new Map<SpanEdit, RawShowOp[]>();
    for (const s of dirtySpans) {
      if (!s.textOps || s.textOps.length === 0) continue;
      const ops: RawShowOp[] = [];
      let ok = true;
      for (const i of s.textOps) {
        const op = parsed.ops[i];
        if (!op) {
          ok = false;
          break;
        }
        if ((owners.get(i) ?? []).some((o) => o !== s && !spanDirty(o))) {
          ok = false; // 与未修改 span 共享算子
          break;
        }
        ops.push(op);
      }
      if (!ok) continue;
      // span 级几何复核：checkpoint 算子的基线 y 必须与 span 基线吻合（±2pt）；
      // x 只做宽松检查（算子前导空白被 pdf.js 跳过时 item 原点右移，算子原点会左偏）
      for (const op of ops) {
        if (!op.checkpoint) continue;
        const yTop = p.height - op.oy;
        const baseY = s.oy + s.baseline;
        if (Math.abs(yTop - baseY) > 2 || op.ox > s.ox + s.owidth + 2 || op.ox < s.ox - Math.max(s.owidth, 24)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      spanOps.set(s, ops);
      for (const op of ops) hidden.add(op);
    }
    if (spanOps.size === 0) continue;

    // 字节区间共享冲突（同一 form 多次 Do，只编辑了其中一处实例）→ 相关 span 放弃；
    // 放弃 span 会连带取消其其它算子的隐藏，可能产生新的混合区间 → 迭代到不动点
    for (;;) {
      const drop = resolveSharedRanges(parsed, hidden);
      if (drop.size === 0) break;
      for (const op of drop) hidden.delete(op);
      for (const [s, ops] of [...spanOps]) {
        if (ops.some((op) => drop.has(op))) {
          spanOps.delete(s);
          for (const o2 of ops) {
            if (![...spanOps.values()].some((os) => os.includes(o2))) hidden.delete(o2);
          }
        }
      }
    }
    if (spanOps.size === 0) continue;

    // 生成并应用字节编辑
    for (const [stream, events] of parsed.events) {
      const edits = planStreamEdits(events, hidden);
      if (edits.length === 0) continue;
      const src = parsed.bytes.get(stream);
      if (!src) continue;
      const next = spliceBytes(src, edits);
      // 原地替换流内容（对象引用关系不变；Length 由 pdf-lib 保存时自动更新）。
      // 新内容未压缩，删掉 Filter/DecodeParms 避免读取方再次解码。
      (stream as { contents: Uint8Array }).contents = next;
      stream.dict.delete(PDFName.of('Filter'));
      stream.dict.delete(PDFName.of('DecodeParms'));
    }
    for (const r of parsed.refs) claimed.add(r);
    for (const s of spanOps.keys()) redacted.add(s.id);
  }

  return redacted;
}
