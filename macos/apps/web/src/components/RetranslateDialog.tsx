import { useEffect, useRef, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { api } from '../api/client';
import { DocumentJobDialog } from './DocumentJobDialog';

export function RetranslateDialog({
  document,
  onClose,
  onComplete,
  onOpenReader,
}: {
  document: DocumentSummary;
  onClose: () => void;
  onComplete: () => void;
  onOpenReader: () => void;
}) {
  const controller = useRef<AbortController | null>(null);
  const [jobKey, setJobKey] = useState<string | null>(null);
  const [coverFile, setCoverFile] = useState<File>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    void (async () => {
      try {
        const previous = await api.documentJob(document.key, request.signal);
        if (request.signal.aborted) return;
        if (previous.job?.status === 'running') {
          setJobKey(document.key);
          setBusy(false);
          return;
        }

        const data = await api.file(document.key, request.signal);
        if (request.signal.aborted) return;
        const fileTitle = (document.title || 'paper').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').trim().slice(0, 140) || 'paper';
        const file = new File([data], `${fileTitle}.pdf`, { type: 'application/pdf' });
        setCoverFile(file);
        const result = await api.retranslate(document.key, request.signal);
        if (request.signal.aborted) return;
        setJobKey(result.jobKey);
        setBusy(false);
        onComplete();
      } catch (cause) {
        if (request.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setBusy(false);
        onComplete();
      }
    })();
    return () => {
      request.abort();
      if (controller.current === request) controller.current = null;
    };
  }, [document, onComplete]);

  return (
    <DocumentJobDialog
      document={document}
      fileKey={document.key}
      jobKey={jobKey}
      coverFile={coverFile}
      importing={busy}
      pending={busy && !jobKey}
      errorMessage={error}
      onClose={() => {
        controller.current?.abort();
        onClose();
      }}
      onOpenReader={onOpenReader}
    />
  );
}
