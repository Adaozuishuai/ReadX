# RetainPDF backend source

This directory vendors the RetainPDF backend source used by ReadX on Windows.

- Upstream repository: https://github.com/wxyhgk/retain-pdf
- Source revision: `1c13f72dccedab3b789ca39e28b87ed962514993`
- License: MIT; see [LICENSE](./LICENSE)
- Scope: Rust API/workers and Python OCR, document normalization, translation, and rendering pipeline.

The source was copied from the local `tmp/retain-pdf` clone with `git archive`; its
files were not edited during import. Keep this revision and the upstream license
notice with any redistributed builds.

The ReadX Windows desktop integration must launch the packaged RetainPDF backend
as a managed child process. The RetainPDF desktop application is not required.
