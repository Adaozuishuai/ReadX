import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const frames = resolve(root, 'render-frames-editorial');
const outputDir = resolve(root, '..', '..', 'output');
const output = resolve(outputDir, 'ReadX-宣传片-编辑风格.mp4');
const frameDigits = String(1224 - 1).length;
const frameSequence = `element-%0${frameDigits}d.jpeg`;
mkdirSync(frames, {recursive: true});
mkdirSync(outputDir, {recursive: true});

const run = (command, args) => {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};

run(process.execPath, [
  resolve(root, 'node_modules', '@remotion', 'cli', 'remotion-cli.js'),
  'render', 'src/index.ts', 'ReadXEditorialPromo', frames,
  '--sequence', '--image-format=jpeg', '--jpeg-quality=94', '--concurrency=2', '--log=error',
]);

run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error',
  '-framerate', '30', '-i', resolve(frames, frameSequence),
  '-i', resolve(root, 'public', 'ambient.wav'),
  '-t', '40.8', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k',
  '-af', 'afade=t=in:st=0:d=1,afade=t=out:st=38.8:d=2',
  '-movflags', '+faststart', '-y', output,
]);

console.log(output);
