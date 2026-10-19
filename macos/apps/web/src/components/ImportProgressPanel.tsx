import { useCallback, useState } from 'react';
import type { ImportProgress, ImportStreamEvent } from '../api/client';

type Activity = ImportProgress & { at: number };

export function useImportProgress() {
  const [current, setCurrent] = useState<Activity | null>(null);
  const [jobKey, setJobKey] = useState('');
  const update = useCallback((progress: ImportProgress) => {
    if (progress.jobKey) setJobKey(progress.jobKey);
    setCurrent({ ...progress, at: Date.now() });
  }, []);
  const begin = useCallback((stage: string, message: string) => {
    setJobKey('');
    update({ stage, message, completed: 0, total: 0 });
  }, [update]);
  const receive = useCallback((event: ImportStreamEvent) => {
    if (event.progress) update(event.progress);
  }, [update]);
  return { current, jobKey, update, begin, receive };
}
