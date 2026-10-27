import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

const LauncherWheel = lazy(() => import('./components/LauncherWheel').then(module => ({ default: module.LauncherWheel })));
const isLauncher = new URLSearchParams(window.location.search).get('readxWindow') === 'launcher';
if (isLauncher) document.documentElement.classList.add('readx-launcher-window');

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 挂载点，index.html 被改坏了');

createRoot(container).render(
  <StrictMode>
    {isLauncher ? <Suspense fallback={null}><LauncherWheel /></Suspense> : <App />}
  </StrictMode>,
);
