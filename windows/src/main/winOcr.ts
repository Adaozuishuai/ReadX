// 扫描版 PDF 的 OCR：调用 Windows 内置 OCR 引擎（Windows.Media.Ocr）。
//
// 为什么不用 Tesseract.js：它需要在运行时下载语言模型，与本应用「离线、CSP 禁止外联」的
// 约束冲突。Windows 自带 WinRT OCR，中文系统已带 zh-Hans 识别器，无需下载任何模型。
//
// 注意（与 macOS 版同一口径）：OCR 文本来自机器识别，摘录校验可能失效，写入的缓存
// 必须带 OCR 标记，界面据此提示人工核对。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

/** 供 PowerShell 调用的 WinRT OCR 脚本（内联，避免外部文件依赖）。
 *  注意：`IAsyncOperation\`1` 里的反引号是 PowerShell 转义符，在 TS 模板串里必须写成 \`，
 *  否则会被当成字符串结束符，导致 GetMethods() 过滤条件失去反引号而返回 NullArray。 */
const OCR_SCRIPT = [
  'param([string]$ImagePath)',
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  '$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq \'AsTask\' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq \'IAsyncOperation`1\' })[0]',
  'function Await($op, $t) { $m = $asTask.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(); $task.Result }',
  '[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null',
  '[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null',
  '[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime] | Out-Null',
  '$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])',
  '$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])',
  '$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])',
  '$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])',
  '$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()',
  "if ($null -eq $engine) { Write-Error 'no OCR engine'; exit 2 }",
  '$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])',
  '# 按行输出，保留版式（OCR 的逐行结果比整段更适合后续表格/公式恢复）',
  'foreach ($line in $result.Lines) { Write-Output $line.Text }',
  '',
].join('\n');

export interface OcrResult { ok: boolean; text?: string; error?: string }

/**
 * 对一张图片（dataURL）做 OCR。图片写到临时文件后交给 WinRT OCR，用完即删。
 * @param dataURL data:image/png;base64,…（不发出本地路径）
 */
export async function ocrImage(dataURL: string): Promise<OcrResult> {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(dataURL ?? '');
  if (!m) return { ok: false, error: '图像数据格式无效（需要 data:image/png;base64,…）。' };
  const ext = m[1] === 'jpg' || m[1] === 'jpeg' ? 'jpg' : 'png';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbct-ocr-'));
  const imgPath = path.join(tmpDir, `page.${ext}`);
  const psPath = path.join(tmpDir, 'ocr.ps1');
  fs.writeFileSync(imgPath, Buffer.from(m[2], 'base64'));
  // 必须写 UTF-8 **带 BOM**：Windows PowerShell 5.1 对无 BOM 的 .ps1 按 ANSI 解码，
  // 脚本里的中文注释字节会被曲解，导致整段脚本静默产生空输出（实测）。
  fs.writeFileSync(psPath, '\uFEFF' + OCR_SCRIPT, 'utf8');

  try {
    const text = await runPowerShell(psPath, imgPath);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
  }
}

function runPowerShell(script: string, imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ImagePath', imagePath],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) { reject(new Error('Windows OCR 调用失败：' + (stderr || err.message).slice(0, 300))); return; }
        // 逐行输出；保留行结构
        resolve(String(stdout).replace(/\r\n/g, '\n').replace(/\n+$/, ''));
      },
    );
  });
}

/** Windows OCR 是否可用（供界面决定是否显示 OCR 入口）。 */
export async function ocrAvailable(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbct-ocrchk-'));
  const psPath = path.join(tmpDir, 'check.ps1');
  fs.writeFileSync(psPath, "try { $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]; if ([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages.Count -gt 0) { 'yes' } else { 'no' } } catch { 'no' }", 'utf8');
  try {
    const out = await new Promise<string>((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath], { timeout: 20_000, windowsHide: true }, (_e, stdout) => resolve(String(stdout).trim()));
    });
    return out.includes('yes');
  } catch { return false; } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
