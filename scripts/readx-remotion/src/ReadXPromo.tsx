import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

type Scene = {
  name: string;
  eyebrow: string;
  title: string;
  image: string;
  start: number;
  duration: number;
  zoomFrom: number;
  zoomTo: number;
  xFrom?: number;
  xTo?: number;
  yFrom?: number;
  yTo?: number;
};

const sceneDuration = 74;
const scenes: Scene[] = [
  {name: 'library', eyebrow: 'PERSONAL LIBRARY', title: '论文，汇成你的书库', image: 'library.png', start: 60, duration: sceneDuration, zoomFrom: 1, zoomTo: 1.026},
  {name: 'document-import', eyebrow: 'BUILD YOUR LIBRARY', title: '导入论文，加入阅读书库', image: 'document-import.png', start: 134, duration: sceneDuration, zoomFrom: 1, zoomTo: 1.03},
  {name: 'processing', eyebrow: 'OCR · TRANSLATION', title: '处理步骤与进度，一目了然', image: 'processing.png', start: 208, duration: sceneDuration, zoomFrom: 1, zoomTo: 1.026},
  {name: 'bilingual', eyebrow: 'BILINGUAL READING', title: '原文与译文，逐页对应', image: 'bilingual.png', start: 282, duration: sceneDuration, zoomFrom: 1, zoomTo: 1.026},
  {name: 'highlight', eyebrow: 'HIGHLIGHT · ASK', title: '高亮公式，直接向助教提问', image: 'highlight.png', start: 356, duration: sceneDuration, zoomFrom: 1, zoomTo: 1.03},
  {name: 'assistant-answer', eyebrow: 'AI RESEARCH ASSISTANT', title: '沿着论文内容，继续追问', image: 'assistant-answer.png', start: 430, duration: sceneDuration, zoomFrom: 1, zoomTo: 1.026},
  {name: 'quintet', eyebrow: 'PAPER WORKBOOK', title: '精读五重奏，分节解析论文', image: 'quintet.png', start: 504, duration: sceneDuration, zoomFrom: 1, zoomTo: 1.03},
  {name: 'ppt', eyebrow: 'PRESENTATION STUDIO', title: '从论文生成演示文稿', image: 'ppt-studio.png', start: 578, duration: sceneDuration, zoomFrom: 1, zoomTo: 1.026},
  {name: 'assistant-settings', eyebrow: 'YOUR AI WORKSPACE', title: '选择模型，配置阅读助手', image: 'assistant-settings.png', start: 652, duration: sceneDuration, zoomFrom: 1, zoomTo: 1.026},
];

const palette = {
  green: '#164a37',
  cream: '#f5f0e4',
  muted: '#d8cba9',
  gold: '#d9b47a',
};

const Background: React.FC = () => (
  <AbsoluteFill style={{background: 'radial-gradient(ellipse at 50% 42%, #2c7555 0%, #1c583f 48%, #123d2d 100%)'}}>
    <AbsoluteFill style={{boxShadow: 'inset 0 0 190px rgba(5,28,20,0.38)'}} />
    <AbsoluteFill style={{opacity: 0.12, background: 'linear-gradient(135deg, rgba(236,229,205,0.14), transparent 42%, rgba(4,27,20,0.28))'}} />
  </AbsoluteFill>
);

const Brand: React.FC<{ending?: boolean}> = ({ending = false}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const entrance = spring({frame, fps, config: {damping: 19, stiffness: 90}});
  const opacity = ending
    ? interpolate(frame, [0, 17], [0, 1], {extrapolateRight: 'clamp'})
    : interpolate(frame, [0, 13, 49, 60], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{alignItems: 'center', justifyContent: 'center', opacity}}>
      <div style={{transform: `scale(${interpolate(entrance, [0, 1], [0.88, 1])})`, textAlign: 'center'}}>
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 28}}>
          <Img src={staticFile('readx-icon.png')} style={{width: 132, height: 132, borderRadius: 30, boxShadow: '0 16px 36px rgba(3,26,18,0.35)'}} />
          <span style={{fontFamily: 'Georgia, serif', fontSize: 112, color: palette.cream, letterSpacing: -5}}>ReadX</span>
        </div>
        <div style={{marginTop: 40, fontFamily: 'SimSun, serif', fontSize: 40, fontWeight: 700, color: palette.cream, letterSpacing: 7}}>
          {ending ? '逐句读懂每一篇论文' : '让阅读，走向理解'}
        </div>
        {ending && (
          <div style={{marginTop: 42, fontFamily: 'Georgia, serif', fontSize: 18, color: palette.muted, letterSpacing: 7}}>
            READ  ·  TRANSLATE  ·  THINK
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};

const FeatureScene: React.FC<{scene: Scene}> = ({scene}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 10, scene.duration - 11, scene.duration], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const titleOpacity = interpolate(frame, [4, 17, scene.duration - 12, scene.duration], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const titleY = interpolate(frame, [0, 20], [18, 0], {extrapolateRight: 'clamp'});
  const zoom = interpolate(frame, [0, scene.duration], [scene.zoomFrom, scene.zoomTo]);
  const x = interpolate(frame, [0, scene.duration], [scene.xFrom ?? 0, scene.xTo ?? 0]);
  const y = interpolate(frame, [0, scene.duration], [scene.yFrom ?? 0, scene.yTo ?? 0]);

  return (
    <AbsoluteFill style={{opacity}}>
      <div style={{
        position: 'absolute', left: 160, top: 160, width: 1600, height: 900,
        borderRadius: 18, overflow: 'hidden', backgroundColor: '#f7f7f3',
        boxShadow: '0 34px 74px rgba(3,25,17,0.46), 0 5px 18px rgba(3,25,17,0.25)',
        border: '1px solid rgba(238,230,205,0.34)',
      }}>
        <Img
          src={staticFile(`screens/${scene.image}`)}
          style={{
            width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center',
            transform: `translate(${x}px, ${y}px) scale(${zoom})`,
          }}
        />
      </div>
      <div style={{
        position: 'absolute', left: 0, top: 0, width: '100%', height: 164,
        background: 'linear-gradient(to bottom, #1a543d 0%, rgba(26,84,61,0.94) 55%, rgba(26,84,61,0) 100%)',
      }} />
      <div style={{
        position: 'absolute', width: '100%', top: 22, textAlign: 'center',
        opacity: titleOpacity, transform: `translateY(${titleY}px)`,
      }}>
        <div style={{fontFamily: 'Georgia, serif', color: palette.gold, fontSize: 17, fontWeight: 700, letterSpacing: 7}}>
          {scene.eyebrow}
        </div>
        <div style={{marginTop: 5, fontFamily: 'SimSun, serif', fontWeight: 700, color: palette.cream, fontSize: 48, letterSpacing: 4}}>
          {scene.title}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const ReadXPromo: React.FC = () => (
  <AbsoluteFill>
    <Background />
    <Sequence from={0} durationInFrames={60}><Brand /></Sequence>
    {scenes.map((scene) => (
      <Sequence key={scene.name} from={scene.start} durationInFrames={scene.duration}>
        <FeatureScene scene={scene} />
      </Sequence>
    ))}
    <Sequence from={726} durationInFrames={102}><Brand ending /></Sequence>
    <Audio
      src={staticFile('ambient.wav')}
      volume={(f) => interpolate(f, [0, 35, 767, 827], [0, 0.8, 0.8, 0], {
        extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
      })}
    />
  </AbsoluteFill>
);
