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

type Slide = {
  eyebrow: string;
  title: string[];
  description: string;
  image: string;
  tag?: string;
};

const slideLength = 144;
const step = 120;
const slides: Slide[] = [
  {
    eyebrow: 'READX · PAPER READING WORKSPACE',
    title: ['读论文、做标注，', '写想法，也都在一处'],
    description: '从论文入库到逐页阅读、精读与汇报，让研究过程自然连起来。',
    image: 'library-cover.png',
  },
  {
    eyebrow: '01  ·  文献库',
    title: ['一个课题一个书库，', '读到哪儿一目了然'],
    description: '论文集中管理，阅读状态、标签与阅读计划都能随时查看。',
    image: 'library.png',
    tag: '搜索 · 分类 · 阅读状态',
  },
  {
    eyebrow: '02  ·  导入论文',
    title: ['把论文放进来，', '阅读从这里开始'],
    description: '导入 PDF 或 EPUB，识别内容后即可加入你的阅读书库。',
    image: 'document-import.png',
    tag: 'PDF · EPUB',
  },
  {
    eyebrow: '03  ·  处理进度',
    title: ['每一步处理进度，', '都清楚看得见'],
    description: 'OCR、翻译、渲染与论文记忆状态分开展示，处理过程更明白。',
    image: 'processing.png',
    tag: '识别 · 翻译 · 渲染',
  },
  {
    eyebrow: '04  ·  双语阅读',
    title: ['原文译文并排，', '逐页对照着读'],
    description: '双栏论文也按原文版面阅读，翻译内容与页面位置对应。',
    image: 'bilingual.png',
    tag: '原文 · 译文',
  },
  {
    eyebrow: '05  ·  高亮与批注',
    title: ['选中一段或一个公式，', '标注后就能继续问'],
    description: '高亮论文内容，直接翻译整段，或带着上下文询问 AI 助教。',
    image: 'highlight.png',
    tag: '高亮 · 公式 · 助教',
  },
  {
    eyebrow: '06  ·  AI 助教',
    title: ['围绕论文上下文，', '继续问到真正弄懂'],
    description: '回答结合当前论文与页码线索，帮助你沿着研究问题深入阅读。',
    image: 'assistant-answer.png',
    tag: '论文上下文问答',
  },
  {
    eyebrow: '07  ·  精读五重奏',
    title: ['把精读拆成五步，', '逐项梳理研究脉络'],
    description: '从实验动机、方法公式到结果分析与代码复现，分节推进。',
    image: 'quintet.png',
    tag: '五个独立分析章节',
  },
  {
    eyebrow: '08  ·  论文演示稿',
    title: ['从论文到汇报，', '边生成边预览'],
    description: '选择书库论文，生成结构清晰、可继续编辑的学术演示文稿。',
    image: 'ppt-studio.png',
    tag: '论文 · 模板 · 实时预览',
  },
  {
    eyebrow: '09  ·  AI 助手设置',
    title: ['连接你常用的模型，', '按自己的方式阅读'],
    description: '配置模型与推理强度，让论文问答和精读流程适配你的工作习惯。',
    image: 'assistant-settings.png',
    tag: '多模型 · 本地优先',
  },
];

const colors = {
  paper: '#fbfaf8',
  ink: '#1d1b25',
  muted: '#6d6875',
  green: '#2f6f59',
  sage: '#e8f1eb',
  yellow: '#f0ce50',
};

const EditorialBackground: React.FC = () => (
  <AbsoluteFill style={{background: colors.paper}}>
    <div style={{position: 'absolute', left: 0, top: 0, bottom: 0, width: 740, background: colors.paper}} />
    <div style={{position: 'absolute', left: 740, top: 0, bottom: 0, right: 0, background: 'linear-gradient(145deg,#edf5ef 0%,#e0ece4 100%)'}} />
    <div style={{position: 'absolute', left: 740, right: 0, top: 0, bottom: 0, opacity: 0.2, backgroundImage: 'linear-gradient(rgba(47,111,89,.12) 1px,transparent 1px)', backgroundSize: '100% 62px'}} />
    <div style={{position: 'absolute', left: 950, top: 130, width: 590, height: 590, border: '1px solid rgba(47,111,89,.12)', borderRadius: '50%'}} />
    <div style={{position: 'absolute', left: 1060, top: 240, width: 380, height: 380, border: '1px solid rgba(47,111,89,.09)', borderRadius: '50%'}} />
  </AbsoluteFill>
);

const HighlightedTitle: React.FC<{lines: string[]; progress: number}> = ({lines, progress}) => (
  <div style={{display: 'flex', flexDirection: 'column', gap: 2}}>
    {lines.map((line, index) => {
      const emphasis = line.includes('都在一处') ? '都在一处'
        : line.includes('一目了然') ? '一目了然'
          : line.includes('开始') ? '开始'
            : line.includes('看得见') ? '看得见'
              : line.includes('逐页对照着读') ? '逐页对照着读'
                : line.includes('继续问') ? '标注后就能继续问'
                  : line.includes('弄懂') ? '真正弄懂'
                    : line.includes('研究脉络') ? '逐项梳理研究脉络'
                      : line.includes('边生成边预览') ? '边生成边预览'
                        : line.includes('工作习惯') ? '按自己的方式阅读' : '';
      const splitAt = emphasis ? line.lastIndexOf(emphasis) : -1;
      return (
        <div key={`${line}-${index}`} style={{position: 'relative', width: 'fit-content', maxWidth: 610}}>
          {splitAt >= 0 && (
            <div style={{position: 'absolute', left: Math.max(0, splitAt * 0.48), bottom: 8, width: `${Math.min(590, emphasis.length * 66)}px`, height: 16, background: colors.yellow, transform: `scaleX(${progress})`, transformOrigin: 'left', opacity: 0.9}} />
          )}
          <div style={{position: 'relative', fontFamily: 'SimSun, Songti SC, STSong, serif', fontSize: 62, lineHeight: 1.34, fontWeight: 700, letterSpacing: 1.5, color: colors.ink}}>{line}</div>
        </div>
      );
    })}
  </div>
);

const SlideContent: React.FC<{slide: Slide; index: number}> = ({slide, index}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame: frame - 4, fps, config: {damping: 22, stiffness: 75}});
  const fade = interpolate(frame, [0, 12, slideLength - 12, slideLength], [0, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const leftY = interpolate(enter, [0, 1], [35, 0]);
  const imageX = interpolate(frame, [0, slideLength], [60, 0]);
  const zoom = interpolate(frame, [0, slideLength], [0.99, 1.015]);
  const marker = interpolate(frame, [16, 34], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});

  return (
    <AbsoluteFill style={{opacity: fade}}>
      <EditorialBackground />
      <div style={{position: 'absolute', left: 100, top: 72, display: 'flex', alignItems: 'center', gap: 14, opacity: interpolate(frame, [0, 15], [0, 1], {extrapolateRight: 'clamp'})}}>
        <Img src={staticFile('readx-icon.png')} style={{width: 52, height: 52, objectFit: 'contain', borderRadius: 13}} />
        <span style={{fontFamily: 'Georgia, serif', fontSize: 33, fontWeight: 700, color: colors.ink, letterSpacing: -0.5}}>ReadX</span>
      </div>

      <div style={{position: 'absolute', left: 100, top: 285, width: 610, transform: `translateY(${leftY}px)`, opacity: enter}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 18, marginBottom: 34, color: colors.green, fontSize: 24, letterSpacing: 2.5, fontWeight: 700, fontFamily: 'Arial, sans-serif'}}>
          <span>{slide.eyebrow}</span><span style={{width: 44, height: 3, background: colors.yellow}} />
        </div>
        <HighlightedTitle lines={slide.title} progress={marker} />
        <div style={{marginTop: 33, maxWidth: 595, color: colors.muted, fontFamily: 'Arial, SimSun, sans-serif', fontSize: 28, lineHeight: 1.75, letterSpacing: 0.5, opacity: interpolate(frame, [12, 28], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>
          {slide.description}
        </div>
        {slide.tag && <div style={{display: 'inline-flex', marginTop: 27, padding: '9px 18px', borderRadius: 26, border: '1px solid rgba(47,111,89,.25)', color: colors.green, fontFamily: 'Arial, SimSun, sans-serif', fontSize: 18, letterSpacing: 0.5}}>{slide.tag}</div>}
      </div>

      <div style={{position: 'absolute', left: 770 + imageX, top: 218, width: 1110, height: 666, borderRadius: 26, background: 'rgba(255,255,255,.94)', padding: 14, boxSizing: 'border-box', boxShadow: '0 28px 75px rgba(38,82,63,.19), 0 5px 18px rgba(38,82,63,.1)', transform: `scale(${zoom})`, opacity: interpolate(frame, [5, 22], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}), overflow: 'hidden'}}>
        <div style={{height: 28, display: 'flex', alignItems: 'center', gap: 7, padding: '0 8px 8px'}}>
          {['#d9d6df', '#ddd8c8', '#c9ddcf'].map((color, i) => <span key={i} style={{width: 10, height: 10, borderRadius: '50%', background: color}} />)}
          <span style={{margin: '0 auto', color: '#918b9b', fontFamily: 'Arial, sans-serif', fontSize: 12, letterSpacing: 1.2}}>READX  /  {slide.eyebrow.split('·').at(-1)?.trim()}</span>
        </div>
        <Img src={staticFile(`screens/${slide.image}`)} style={{display: 'block', width: '100%', height: 610, objectFit: 'contain', objectPosition: 'center', borderRadius: 13, background: '#fff'}} />
      </div>

      <div style={{position: 'absolute', left: 100, bottom: 68, display: 'flex', alignItems: 'center', gap: 10}}>
        {slides.map((_, dot) => <span key={dot} style={{width: dot === index ? 34 : 12, height: 12, borderRadius: 8, background: dot === index ? colors.green : '#c9dbce', transform: `scaleX(${dot === index ? interpolate(frame, [0, 15], [0.6, 1], {extrapolateRight: 'clamp'}) : 1})`}} />)}
      </div>
      <div style={{position: 'absolute', right: 82, bottom: 60, fontFamily: 'Georgia, serif', color: 'rgba(47,111,89,.52)', fontSize: 15, letterSpacing: 2}}>{String(index + 1).padStart(2, '0')} / {String(slides.length).padStart(2, '0')}</div>
    </AbsoluteFill>
  );
};

export const ScholiaStylePromo: React.FC = () => {
  const frame = useCurrentFrame();
  const musicVolume = (f: number) => interpolate(f, [0, 25, 1110, 1223], [0, 0.48, 0.48, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill>
      <EditorialBackground />
      {slides.map((slide, index) => (
        <Sequence key={`${index}-${slide.image}`} from={index * step} durationInFrames={slideLength}>
          <SlideContent slide={slide} index={index} />
        </Sequence>
      ))}
      <Audio src={staticFile('ambient.wav')} volume={musicVolume} />
      <div style={{position: 'absolute', top: 0, left: 0, width: '100%', height: 3, background: 'rgba(47,111,89,.08)'}}>
        <div style={{height: '100%', width: `${(frame / 1224) * 100}%`, background: colors.yellow}} />
      </div>
    </AbsoluteFill>
  );
};
