import {spawnSync} from 'node:child_process';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const frames = resolve(root, 'render-frames');
const output = resolve(root, '..', '..', 'output', 'ReadX-宣传片-绿色版-Remotion.mp4');
mkdirSync(frames, {recursive: true});
mkdirSync(resolve(root, '..', '..', 'output'), {recursive: true});

const run = (command, args) => {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};

// Remotion renders every frame; FFmpeg packages those frames with the original soundtrack.
// This avoids a Windows compositor pipe error seen with direct Remotion video encoding.
run(process.execPath, [
  resolve(root, 'node_modules', '@remotion', 'cli', 'remotion-cli.js'),
  'render', 'src/index.ts', 'ReadXPromo', frames,
  '--sequence', '--image-format=jpeg', '--jpeg-quality=94', '--concurrency=2', '--log=error',
]);

run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error',
  '-framerate', '30', '-i', resolve(frames, 'element-%03d.jpeg'),
  '-i', resolve(root, 'public', 'ambient.wav'),
  '-t', '27.6', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k',
  '-af', 'afade=t=in:st=0:d=1,afade=t=out:st=25.6:d=2',
  '-movflags', '+faststart', '-y', output,
]);

console.log(output);
