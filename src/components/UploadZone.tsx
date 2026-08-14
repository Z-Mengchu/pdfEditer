import { useCallback, useRef, useState } from 'react';
import { FileUp, FileText, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  onFile: (file: File) => void;
  onSample: () => void;
  loading: boolean;
}

export default function UploadZone({ onFile, onSample, loading }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f && (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))) onFile(f);
    },
    [onFile],
  );

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-slate-50 to-slate-100">
      <header className="px-8 py-5 flex items-center gap-2">
        <FileText className="w-6 h-6 text-blue-600" />
        <span className="font-semibold text-lg">PDF 在线编辑器</span>
      </header>
      <main className="flex-1 flex items-center justify-center px-6 pb-24">
        <div className="w-full max-w-2xl">
          <h1 className="text-3xl font-bold text-center mb-3">编辑 PDF 里的文字</h1>
          <p className="text-center text-muted-foreground mb-8">
            上传 PDF，直接在页面上修改文字、框选涂抹转曲文字并替换，然后重新导出 PDF。
          </p>
          <div
            className={`border-2 border-dashed rounded-2xl bg-white p-14 text-center transition-colors cursor-pointer ${
              dragOver ? 'border-blue-500 bg-blue-50' : 'border-slate-300 hover:border-blue-400'
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
          >
            {loading ? (
              <Loader2 className="w-12 h-12 mx-auto mb-4 text-blue-500 animate-spin" />
            ) : (
              <FileUp className="w-12 h-12 mx-auto mb-4 text-blue-500" />
            )}
            <p className="text-lg font-medium mb-1">{loading ? '正在解析 PDF…' : '拖拽 PDF 到这里，或点击选择文件'}</p>
            <p className="text-sm text-muted-foreground">支持多页 PDF，所有处理均在浏览器本地完成</p>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFile(f);
                e.target.value = '';
              }}
            />
          </div>
          <div className="flex items-center justify-center gap-4 mt-6">
            <Button variant="outline" onClick={onSample} disabled={loading}>
              使用示例文件试试
            </Button>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" /> 文件不会上传到服务器
            </span>
          </div>
        </div>
      </main>
    </div>
  );
}
