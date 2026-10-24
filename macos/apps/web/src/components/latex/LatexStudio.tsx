import { useCallback, useState } from 'react';
import type { LatexProject } from '@cbct/shared';
import { LatexProjectList } from './LatexProjectList';
import { LatexWorkspace } from './LatexWorkspace';

/**
 * LaTeX Studio 工作区入口（与书库、PPT 平级）。
 *
 * 与其它工作区的关系是「并列且互不干扰」：它用自己的数据表与目录，
 * 不读也不写书库里的论文记录；这里不引入任何编译期依赖，编译能力在打开项目后按需加载。
 */
export function LatexStudio({ registerBeforeLeave }: {
  registerBeforeLeave?: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const [open, setOpen] = useState<LatexProject | null>(null);

  const handleOpen = useCallback((project: LatexProject) => setOpen(project), []);
  const handleClose = useCallback(() => setOpen(null), []);

  if (open) {
    return (
      <LatexWorkspace
        key={open.id}
        project={open}
        onClose={handleClose}
        onProjectChange={(updated) => setOpen(updated)}
        registerBeforeLeave={registerBeforeLeave}
      />
    );
  }
  return <LatexProjectList onOpen={handleOpen} />;
}
