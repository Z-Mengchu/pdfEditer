import fontkit from '@pdf-lib/fontkit';

/* ---------------- 类型 ---------------- */

/** 内置字体定义（打包在 /public/fonts 下，免授权即点即用） */
export interface BuiltinFontDef {
  id: string;
  /** 下拉列表显示名 */
  name: string;
  url: string;
  /** 是否允许 pdf-lib 导出时子集嵌入（全集字体为 true，可减小产物体积） */
  subsettable: boolean;
}

/** 本机字体条目（Local Font Access API） */
export interface LocalFontInfo {
  /** fontId，形如 local:PostScriptName */
  id: string;
  postscriptName: string;
  fullName: string;
  family: string;
  style: string;
  /** TTC 合集无法嵌入 PDF，列表中置灰 */
  unsupported: boolean;
}

/** 已加载到内存的字体 */
export interface LoadedFont {
  id: string;
  name: string;
  bytes: Uint8Array;
  /** fontkit 解析结果，用于字符覆盖检查 */
  font: fontkit.Font;
  subsettable: boolean;
}

/** Local Font Access API 返回的原始结构（TS 标准库尚无此声明） */
interface FontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  blob: () => Promise<Blob>;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<FontData[]>;
  }
}

/* ---------------- 内置字体清单 ---------------- */

export const BUILTIN_FONTS: BuiltinFontDef[] = [
  { id: 'noto-sans-sc', name: '思源黑体', url: '/fonts/NotoSansSC-Regular.otf', subsettable: true },
  { id: 'noto-serif-sc', name: '思源宋体', url: '/fonts/NotoSerifSC-Regular.otf', subsettable: true },
  { id: 'ddin', name: 'D-DIN', url: '/fonts/D-DIN.ttf', subsettable: true },
  { id: 'ddin-bold', name: 'D-DIN Bold', url: '/fonts/D-DIN-Bold.ttf', subsettable: true },
  { id: 'ddin-pro-regular', name: 'D-DIN PRO', url: '/fonts/D-DIN-PRO-Regular.otf', subsettable: true },
  { id: 'ddin-pro-semibold', name: 'D-DIN PRO SemiBold', url: '/fonts/D-DIN-PRO-SemiBold.otf', subsettable: true },
  { id: 'ddin-pro-heavy', name: 'D-DIN PRO Heavy', url: '/fonts/D-DIN-PRO-Heavy.otf', subsettable: true },
];

const builtinById = new Map(BUILTIN_FONTS.map((f) => [f.id, f]));

/* ---------------- 本机字体枚举 ---------------- */

export function isLocalFontAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.queryLocalFonts === 'function';
}

/** 已枚举的本机字体（会话内缓存；key 为 postscriptName） */
let localFonts: LocalFontInfo[] | null = null;
const localFontDataByPs = new Map<string, FontData>();

function isTtcHeader(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x74 && head[1] === 0x74 && head[2] === 0x63 && head[3] === 0x66; // 'ttcf'
}

/**
 * 请求授权并枚举本机字体（首次调用触发浏览器权限框）。
 * 枚举后扫描各字体文件头，把 TTC 合集标记为 unsupported（列表置灰）。
 * @throws 用户拒绝授权或 API 不可用时抛错
 */
export async function listLocalFonts(): Promise<LocalFontInfo[]> {
  if (localFonts) return localFonts;
  if (!window.queryLocalFonts) throw new Error('当前浏览器不支持访问本机字体');
  const data = await window.queryLocalFonts();
  const list: LocalFontInfo[] = data.map((d) => {
    localFontDataByPs.set(d.postscriptName, d);
    return {
      id: `local:${d.postscriptName}`,
      postscriptName: d.postscriptName,
      fullName: d.fullName,
      family: d.family,
      style: d.style,
      unsupported: false,
    };
  });
  list.sort((a, b) => a.fullName.localeCompare(b.fullName));

  // 读每个字体文件头 4 字节检测 TTC（'ttcf'），限流并发避免同时打开几百个文件
  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      const f = list[cursor++];
      try {
        const d = localFontDataByPs.get(f.postscriptName);
        if (!d) continue;
        const head = new Uint8Array(await (await d.blob()).slice(0, 4).arrayBuffer());
        if (isTtcHeader(head)) f.unsupported = true;
      } catch {
        // 单个字体读取失败不影响整体
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  localFonts = list;
  return list;
}

/* ---------------- 字体加载（bytes + fontkit 解析 + 缓存） ---------------- */

const loadCache = new Map<string, Promise<LoadedFont>>();

async function doLoad(id: string): Promise<LoadedFont> {
  let bytes: Uint8Array;
  let name: string;
  let subsettable = true;

  const builtin = builtinById.get(id);
  if (builtin) {
    const resp = await fetch(builtin.url);
    if (!resp.ok) throw new Error(`内置字体 ${builtin.name} 加载失败（${resp.status}）`);
    bytes = new Uint8Array(await resp.arrayBuffer());
    name = builtin.name;
    subsettable = builtin.subsettable;
  } else if (id.startsWith('local:')) {
    const ps = id.slice('local:'.length);
    const d = localFontDataByPs.get(ps);
    if (!d) throw new Error('本机字体列表已失效，请重新加载');
    const blob = await d.blob();
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (isTtcHeader(head)) throw new Error(`「${d.fullName}」是 TTC 字体合集，暂不支持`);
    bytes = new Uint8Array(await blob.arrayBuffer());
    name = d.fullName;
  } else {
    throw new Error(`未知字体：${id}`);
  }

  const font = fontkit.create(bytes as unknown as Parameters<typeof fontkit.create>[0]) as fontkit.Font & {
    fonts?: fontkit.Font[];
  };
  if (font.fonts) throw new Error(`「${name}」是 TTC 字体合集，暂不支持`);
  return { id, name, bytes, font: font as fontkit.Font, subsettable };
}

/** 按 fontId 加载字体（内置 fetch / 本机 blob），会话内缓存 */
export function loadFontById(id: string): Promise<LoadedFont> {
  let p = loadCache.get(id);
  if (!p) {
    p = doLoad(id);
    p.catch(() => loadCache.delete(id)); // 失败不留缓存，允许重试
    loadCache.set(id, p);
  }
  return p;
}

/** 字符覆盖检查：该字体是否包含指定字符的字形 */
export function fontCovers(lf: LoadedFont, ch: string): boolean {
  return lf.font.hasGlyphForCodePoint(ch.codePointAt(0)!);
}

/* ---------------- 预览：FontFace 注册 ---------------- */

const registeredFaces = new Set<string>();

function cssFamilyFor(id: string): string {
  return `pdfe-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/**
 * 确保字体已注册为 FontFace（供预览 DOM 的 fontFamily 使用）。
 * 返回 CSS font-family 名。加载/注册过程与 loadFontById 共享缓存。
 */
export async function ensurePreviewFont(id: string): Promise<string> {
  const family = cssFamilyFor(id);
  if (registeredFaces.has(family)) return family;
  const lf = await loadFontById(id);
  const face = new FontFace(family, lf.bytes as unknown as ArrayBuffer);
  await face.load();
  document.fonts.add(face);
  registeredFaces.add(family);
  return family;
}

/* ---------------- 预览：默认字体（与导出回退链对齐） ---------------- */

/** 导出时默认 CJK 字体（/fonts/cjk.ttf）的预览 FontFace 名 */
const DEFAULT_CJK_FAMILY = 'pdfe-default-cjk';

let defaultCjkPromise: Promise<void> | null = null;

/** 注册导出默认中文体的预览 FontFace，保证未选字体时预览与导出一致 */
export function ensureDefaultCjkPreview(): Promise<void> {
  if (!defaultCjkPromise) {
    defaultCjkPromise = (async () => {
      const resp = await fetch('/fonts/cjk.ttf');
      if (!resp.ok) throw new Error(`默认中文字体加载失败（${resp.status}）`);
      const face = new FontFace(DEFAULT_CJK_FAMILY, await resp.arrayBuffer());
      await face.load();
      document.fonts.add(face);
    })();
    defaultCjkPromise.catch(() => {
      defaultCjkPromise = null; // 失败不留缓存，允许重试
    });
  }
  return defaultCjkPromise;
}

/**
 * 与 exportPdf.ts 的 fontFor() 回退链一致的 CSS font-family 栈：
 * 自定义字体 → Helvetica（拉丁默认）→ 内置 CJK（中文默认）。
 * 浏览器按字符逐个回退，预览效果即导出效果。
 */
export function previewFontStack(customFamily?: string): string {
  const base = `Helvetica, "${DEFAULT_CJK_FAMILY}", sans-serif`;
  return customFamily ? `"${customFamily}", ${base}` : base;
}
