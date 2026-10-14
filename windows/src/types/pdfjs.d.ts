// pdfjs-dist 只发布 ESM，没有随包的 .d.ts 路径映射；这里给本项目用到的入口做最小声明。
// 渲染层只用 getDocument / GlobalWorkerOptions，避免为整个库引入类型依赖。
declare module 'pdfjs-dist/build/pdf.mjs' {
  export const GlobalWorkerOptions: { workerSrc: string };
  export function getDocument(src: { data: Uint8Array; isEvalSupported?: boolean; disableFontFace?: boolean }): { promise: Promise<any> };
}

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export function getDocument(src: any): { promise: Promise<any> };
}
