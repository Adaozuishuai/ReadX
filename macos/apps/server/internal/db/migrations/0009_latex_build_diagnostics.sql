-- 编译诊断落库：计数（error_count / warning_count）与列表必须同源。
--
-- 之前只在读取时重新解析最后一趟的日志，而计数是多趟合并的结果，
-- 于是界面上出现「28 个警告」却只列得出一条（真实 CVPR 模板上就是这个现象）。
ALTER TABLE latex_builds ADD COLUMN diagnostics TEXT NOT NULL DEFAULT '[]';