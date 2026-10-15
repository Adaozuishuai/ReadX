#!/bin/bash
set -euo pipefail

VENV="$HOME/Library/Application Support/CBCT每日精读/formula-ocr"
python3 -m venv "$VENV"
"$VENV/bin/python3" -m pip install --upgrade pip
"$VENV/bin/python3" -m pip install "pix2text==1.1.7"
# Pin the OpenCV wheel pair. New major OpenCV wheels have triggered an ARM
# NEON resize SIGSEGV in Pix2Text; both distributions expose the same cv2 API.
"$VENV/bin/python3" -m pip install --no-deps "opencv-python==4.10.0.84" "opencv-python-headless==4.10.0.84"
echo "本地公式 OCR 已安装。首次使用会下载识别模型；模型就绪后可离线识别。"
