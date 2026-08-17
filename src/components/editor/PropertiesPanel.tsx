import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Check,
  ChevronsUpDown,
  Download,
  Eraser,
  ImagePlus,
  Loader2,
  MousePointer2,
  PaintBucket,
  RotateCcw,
  Shapes,
  Trash2,
  Type,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import type { EditItem, ElementEdit, RegionEdit, SpanEdit } from '@/lib/pdf/types';
import { isSpan, spanDirty } from '@/lib/pdf/types';
import type { VectorElement } from '@/lib/pdf/elements';
import {
  BUILTIN_FONTS,
  isLocalFontAccessSupported,
  listLocalFonts,
  type LocalFontInfo,
} from '@/lib/pdf/fonts';

interface Props {
  item: EditItem | null;
  selectedElement: VectorElement | null;
  elementEdit: ElementEdit | null;
  onUpdateSpan: (id: string, patch: Partial<SpanEdit>) => void;
  onUpdateRegion: (id: string, patch: Partial<RegionEdit>) => void;
  onRemoveRegion: (id: string) => void;
  onUpdateElement: (el: VectorElement, patch: Partial<ElementEdit>) => void;
  onClearElement: (el: VectorElement) => void;
}

function NumberField({
  label,
  value,
  onChange,
  min = 0.5,
  max = 500,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  // 输入过程中用本地草稿，避免每次击键就被 min/max 钳制（否则 3.9 永远输不进去）
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs text-muted-foreground shrink-0">{label}</Label>
      <input
        type="number"
        className="w-20 h-8 rounded-md border border-input bg-transparent px-2 text-sm"
        value={draft ?? String(Math.round(value * 100) / 100)}
        min={min}
        max={max}
        step={0.5}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs text-muted-foreground shrink-0">{label}</Label>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-mono">{value}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-8 h-8 rounded cursor-pointer border border-input bg-transparent"
        />
      </div>
    </div>
  );
}

const DEFAULT_FONT_LABEL = '默认（Helvetica / 文泉驿）';

/** 字体选择器：内置字体即点即用；本机字体需 Chromium 授权（TTC 置灰） */
function FontSelector({
  value,
  originalFontName,
  onChange,
}: {
  value?: string;
  originalFontName?: string;
  onChange: (fontId: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [locals, setLocals] = useState<LocalFontInfo[] | null>(null);
  const [loadingLocals, setLoadingLocals] = useState(false);

  const label = useMemo(() => {
    if (!value) return DEFAULT_FONT_LABEL;
    const b = BUILTIN_FONTS.find((f) => f.id === value);
    if (b) return b.name;
    const l = locals?.find((f) => f.id === value);
    return l ? l.fullName : value.replace(/^local:/, '');
  }, [value, locals]);

  const loadLocals = async () => {
    setLoadingLocals(true);
    try {
      setLocals(await listLocalFonts());
    } catch (err) {
      toast.error('本机字体加载失败：' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoadingLocals(false);
    }
  };

  const pick = (fontId: string | undefined) => {
    onChange(fontId);
    setOpen(false);
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-muted-foreground shrink-0">字体</Label>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button className="flex items-center justify-between gap-1 w-44 h-8 rounded-md border border-input bg-transparent px-2 text-sm hover:bg-accent/50">
              <span className="truncate">{label}</span>
              <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-60 p-0" align="end">
            <Command>
              <CommandInput placeholder="搜索字体…" />
              <CommandList>
                <CommandEmpty>无匹配字体</CommandEmpty>
                <CommandGroup heading="默认">
                  <CommandItem onSelect={() => pick(undefined)}>
                    <Check className={cn('w-4 h-4 mr-1', value == null ? 'opacity-100' : 'opacity-0')} />
                    {DEFAULT_FONT_LABEL}
                  </CommandItem>
                </CommandGroup>
                <CommandGroup heading="内置字体">
                  {BUILTIN_FONTS.filter((f) => !f.variantOnly).map((f) => (
                    <CommandItem key={f.id} onSelect={() => pick(f.id)}>
                      <Check className={cn('w-4 h-4 mr-1', value === f.id ? 'opacity-100' : 'opacity-0')} />
                      {f.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
                {isLocalFontAccessSupported() && (
                  <CommandGroup heading="本机字体">
                    {!locals && (
                      <CommandItem disabled={loadingLocals} onSelect={loadLocals}>
                        {loadingLocals ? (
                          <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                        ) : (
                          <Download className="w-4 h-4 mr-1" />
                        )}
                        {loadingLocals ? '正在枚举本机字体…' : '加载本机字体…（需授权）'}
                      </CommandItem>
                    )}
                    {locals?.map((f) => (
                      <CommandItem
                        key={f.id}
                        disabled={f.unsupported}
                        onSelect={() => {
                          if (!f.unsupported) pick(f.id);
                        }}
                      >
                        <Check className={cn('w-4 h-4 mr-1', value === f.id ? 'opacity-100' : 'opacity-0')} />
                        <span className="truncate">
                          {f.fullName}
                          {f.style && f.style !== 'Regular' ? ` ${f.style}` : ''}
                          {f.unsupported ? '（TTC 暂不支持）' : ''}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
      {originalFontName && <p className="text-[11px] text-muted-foreground text-right">原字体：{originalFontName}</p>}
    </div>
  );
}

function ElementPanel({
  el,
  edit,
  onUpdateElement,
  onClearElement,
}: {
  el: VectorElement;
  edit: ElementEdit | null;
  onUpdateElement: (el: VectorElement, patch: Partial<ElementEdit>) => void;
  onClearElement: (el: VectorElement) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const deleted = edit?.deleted ?? false;
  const replaced = !!edit?.replaceImage;
  const isImage = !!el.imageObjId && el.segs.length === 0;
  const hasChanges = !!edit && (edit.deleted || edit.dx !== 0 || edit.dy !== 0 || !!edit.replaceImage);

  const onPickImage = async (f: File) => {
    const bytes = await f.arrayBuffer();
    const mime = f.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    onUpdateElement(el, { replaceImage: { bytes, mime, name: f.name }, deleted: false });
  };

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium flex items-center gap-1.5">
          <Shapes className="w-4 h-4 text-cyan-600" /> {isImage ? '图片元素' : '矢量元素'}
        </span>
        {hasChanges && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onClearElement(el)}>
            <RotateCcw className="w-3.5 h-3.5 mr-1" /> 撤销修改
          </Button>
        )}
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        <p>
          尺寸：{el.width.toFixed(1)} × {el.height.toFixed(1)} pt
          {!isImage && ` · ${el.segs.length} 段路径`}
        </p>
        {!isImage && (
          <p className="flex items-center gap-2">
            颜色：
            {el.paints.some((p) => p.includes('fill')) && (
              <span className="inline-flex items-center gap-1">
                <i className="w-3 h-3 rounded-sm border inline-block" style={{ backgroundColor: el.fillColor }} />
                填充
              </span>
            )}
            {el.paints.some((p) => p.includes('stroke')) && (
              <span className="inline-flex items-center gap-1">
                <i className="w-3 h-3 rounded-sm border inline-block" style={{ backgroundColor: el.strokeColor }} />
                描边
              </span>
            )}
          </p>
        )}
        <p>{isImage ? '图片可删除或替换；暂不支持直接拖动。' : '可直接在页面上拖动该元素。'}</p>
      </div>
      <ColorField
        label="涂抹底色"
        value={edit?.bgColor ?? '#ffffff'}
        onChange={(v) => onUpdateElement(el, { bgColor: v })}
      />
      <Separator />
      <Button
        variant={deleted ? 'outline' : 'destructive'}
        size="sm"
        className="w-full"
        onClick={() => onUpdateElement(el, { deleted: !deleted })}
      >
        <Eraser className="w-4 h-4 mr-1.5" />
        {deleted ? '取消删除' : '删除该元素'}
      </Button>
      <Button variant="outline" size="sm" className="w-full" onClick={() => fileRef.current?.click()}>
        <ImagePlus className="w-4 h-4 mr-1.5" />
        {replaced ? '重新选择替换图片' : '替换为图片…'}
      </Button>
      {replaced && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-xs"
          onClick={() => onUpdateElement(el, { replaceImage: null })}
        >
          清除替换图片
        </Button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPickImage(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

export default function PropertiesPanel({
  item,
  selectedElement,
  elementEdit,
  onUpdateSpan,
  onUpdateRegion,
  onRemoveRegion,
  onUpdateElement,
  onClearElement,
}: Props) {
  if (selectedElement) {
    return (
      <ElementPanel el={selectedElement} edit={elementEdit} onUpdateElement={onUpdateElement} onClearElement={onClearElement} />
    );
  }
  if (!item) {
    return (
      <div className="p-4 text-sm text-muted-foreground space-y-4">
        <div className="flex items-center gap-2 text-foreground font-medium">
          <MousePointer2 className="w-4 h-4" /> 使用说明
        </div>
        <ul className="space-y-2.5 text-xs leading-5">
          <li className="flex gap-2">
            <Type className="w-4 h-4 shrink-0 text-blue-500" />
            <span>
              <b>编辑文字</b>：双击页面上的文字直接修改；也可点选后在右侧面板编辑。文字块可拖动移位。
            </span>
          </li>
          <li className="flex gap-2">
            <PaintBucket className="w-4 h-4 shrink-0 text-amber-500" />
            <span>
              <b>框选涂抹</b>：切换到「框选涂抹」工具，拖出矩形覆盖转曲文字/图标，可填入新文字。
            </span>
          </li>
          <li className="flex gap-2">
            <Shapes className="w-4 h-4 shrink-0 text-cyan-600" />
            <span>
              <b>元素选择</b>：切换到「元素」工具，可点选图标、转曲文字块、图片，进行删除、移动或替换为图片。
            </span>
          </li>
          <li className="flex gap-2">
            <Eraser className="w-4 h-4 shrink-0 text-red-500" />
            <span>
              <b>删除文字</b>：选中文字块后按 Delete，或在面板中点「擦除」。
            </span>
          </li>
        </ul>
        <Separator />
        <p className="text-xs">修改完成后点击右上角「导出 PDF」。</p>
      </div>
    );
  }

  if (isSpan(item)) {
    const s = item;
    return (
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium flex items-center gap-1.5">
            <Type className="w-4 h-4 text-blue-500" /> 文字块
          </span>
          {spanDirty(s) && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() =>
                onUpdateSpan(s.id, {
                  text: s.originalText,
                  x: s.ox,
                  y: s.oy,
                  width: s.owidth,
                  height: s.oheight,
                  fontSize: s.ofontSize,
                  color: s.ocolor,
                  bgColor: s.obgColor,
                  bold: s.originalBold,
                  fontId: undefined,
                  deleted: false,
                })
              }
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1" /> 还原
            </Button>
          )}
        </div>
        <Textarea
          value={s.text}
          disabled={s.deleted}
          rows={3}
          className="text-sm"
          placeholder="输入替换文字"
          onChange={(e) => onUpdateSpan(s.id, { text: e.target.value })}
        />
        <FontSelector
          value={s.fontId}
          originalFontName={s.originalFontName}
          onChange={(fontId) => onUpdateSpan(s.id, { fontId })}
        />
        <NumberField label="字号 (pt)" value={s.fontSize} onChange={(v) => onUpdateSpan(s.id, { fontSize: v })} />
        <ColorField label="文字颜色" value={s.color} onChange={(v) => onUpdateSpan(s.id, { color: v })} />
        <ColorField label="涂抹底色" value={s.bgColor} onChange={(v) => onUpdateSpan(s.id, { bgColor: v })} />
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">加粗</Label>
          <Switch checked={s.bold} onCheckedChange={(v) => onUpdateSpan(s.id, { bold: v })} />
        </div>
        <Separator />
        <Button
          variant={s.deleted ? 'outline' : 'destructive'}
          size="sm"
          className="w-full"
          onClick={() => onUpdateSpan(s.id, { deleted: !s.deleted })}
        >
          <Eraser className="w-4 h-4 mr-1.5" />
          {s.deleted ? '取消擦除' : '擦除该文字'}
        </Button>
      </div>
    );
  }

  const r = item;
  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium flex items-center gap-1.5">
          <PaintBucket className="w-4 h-4 text-amber-500" /> 框选区域
        </span>
        <Button variant="ghost" size="sm" className="h-7 text-xs text-red-600" onClick={() => onRemoveRegion(r.id)}>
          <Trash2 className="w-3.5 h-3.5 mr-1" /> 移除
        </Button>
      </div>
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">填充底色（涂抹遮盖）</Label>
        <Switch checked={r.fill} onCheckedChange={(v) => onUpdateRegion(r.id, { fill: v })} />
      </div>
      {r.fill && <ColorField label="底色" value={r.fillColor} onChange={(v) => onUpdateRegion(r.id, { fillColor: v })} />}
      <Textarea
        value={r.text}
        rows={4}
        className="text-sm"
        placeholder="在区域内写入文字（可留空仅涂抹）"
        onChange={(e) => onUpdateRegion(r.id, { text: e.target.value })}
      />
      <FontSelector value={r.fontId} onChange={(fontId) => onUpdateRegion(r.id, { fontId })} />
      <NumberField label="字号 (pt)" value={r.fontSize} onChange={(v) => onUpdateRegion(r.id, { fontSize: v })} />
      <ColorField label="文字颜色" value={r.color} onChange={(v) => onUpdateRegion(r.id, { color: v })} />
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">加粗</Label>
        <Switch checked={r.bold} onCheckedChange={(v) => onUpdateRegion(r.id, { bold: v })} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-muted-foreground shrink-0">对齐</Label>
        <div className="flex rounded-md border border-input overflow-hidden">
          {(
            [
              ['left', AlignLeft],
              ['center', AlignCenter],
              ['right', AlignRight],
            ] as const
          ).map(([v, Icon]) => (
            <button
              key={v}
              className={`p-1.5 ${r.align === v ? 'bg-blue-100 text-blue-700' : 'text-muted-foreground hover:bg-accent'}`}
              onClick={() => onUpdateRegion(r.id, { align: v })}
            >
              <Icon className="w-4 h-4" />
            </button>
          ))}
        </div>
        <div className="flex rounded-md border border-input overflow-hidden">
          {(
            [
              ['top', '上'],
              ['middle', '中'],
              ['bottom', '下'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              className={`px-2 py-1.5 text-xs ${r.valign === v ? 'bg-blue-100 text-blue-700' : 'text-muted-foreground hover:bg-accent'}`}
              onClick={() => onUpdateRegion(r.id, { valign: v })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
