import { useCallback, useState } from 'react';
import { Toaster } from 'sonner';
import UploadZone from '@/components/UploadZone';
import PdfEditor from '@/components/editor/PdfEditor';

interface PdfFile {
  name: string;
  bytes: ArrayBuffer;
}

export default function Home() {
  const [file, setFile] = useState<PdfFile | null>(null);
  const [loading, setLoading] = useState(false);

  const onFile = useCallback(async (f: File) => {
    setLoading(true);
    try {
      const bytes = await f.arrayBuffer();
      setFile({ name: f.name, bytes });
    } finally {
      setLoading(false);
    }
  }, []);

  const onSample = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch('/sample.pdf');
      const bytes = await resp.arrayBuffer();
      setFile({ name: 'Air_Blower（示例）.pdf', bytes });
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <>
      <Toaster position="top-center" richColors />
      {file ? (
        <PdfEditor fileName={file.name} bytes={file.bytes} onReset={() => setFile(null)} />
      ) : (
        <UploadZone onFile={onFile} onSample={onSample} loading={loading} />
      )}
    </>
  );
}
