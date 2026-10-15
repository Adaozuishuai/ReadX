#!/usr/bin/env python3
"""Local-only equation transcription bridge for the macOS app.

Reads one PNG from stdin and emits JSON on stdout. Pix2Text model files are
downloaded by the library on first use; image bytes and recognized text stay local.
"""
import json
import sys
from contextlib import redirect_stdout


def emit(payload, status=0):
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(status)


try:
    # Keep the bridge protocol machine-readable. Pix2Text and its model stack
    # print progress and runtime diagnostics to stdout during imports/inference.
    with redirect_stdout(sys.stderr):
        import cv2
        # OpenCV's ARM NEON parallel resize path can segfault on some Apple
        # Silicon/Pix2Text combinations while shrinking full-page crops. OCR is
        # already CPU-bound; the portable scalar path is stable for these inputs.
        cv2.setNumThreads(1)
        cv2.setUseOptimized(False)
        from PIL import Image
        from pix2text import Pix2Text
except ImportError as exc:
    emit({"error": "missing_dependency", "message": str(exc)}, 3)

try:
    image = Image.open(sys.stdin.buffer).convert("RGB")
    with redirect_stdout(sys.stderr):
        reader = Pix2Text.from_config(enable_formula=True, enable_table=False, device="cpu")
        blocks = reader.recognize_text_formula(image, return_text=False, resized_shape=1600)
    formulas = []
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        kind = str(block.get("type", "")).lower()
        text = str(block.get("text", "")).strip()
        if kind in {"isolated", "embedding", "formula", "display", "math"} and text:
            formulas.append({"kind": kind, "latex": text})
    emit({"formulas": formulas})
except SystemExit:
    raise
except Exception as exc:
    emit({"error": "recognition_failed", "message": str(exc)}, 1)
