import { streamLatexChat, type ChatChunk } from '../../api/client';

/** Send edit proposals into their conversation turn; writing requires approval. */
export async function runLatexChat(
  request: Parameters<typeof streamLatexChat>[0],
  onChunk: (chunk: ChatChunk) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  let terminal: ChatChunk = {};
  let failed = false;
  await streamLatexChat(request, (chunk) => {
    if (chunk.done) terminal = chunk;
    else {
      if (chunk.error) failed = true;
      onChunk(chunk);
    }
  }, signal);
  if (failed) return;
  signal?.throwIfAborted();
  if (!terminal.done) throw new Error('未收到完整的 LaTeX 助手回答，未保存文件。');
  const edit = terminal.edit;
  if (!edit) {
    onChunk(terminal);
    return;
  }
  if (edit.content === edit.original) {
    onChunk({ done: true, text: `AI 未生成实际改动：${edit.filePath}，文件未改写。` });
    return;
  }
  onChunk({ done: true, edit, text: '修改已准备好，请确认下面的请求。' });
}
