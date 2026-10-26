from __future__ import annotations

import importlib.util
import json
import math
import sys
import types
from pathlib import Path


def _load_retain_paddle_normalizer(runtime_root: Path):
    provider_dir = runtime_root / "retainpdf_pipeline" / "ocr" / "ocr_provider"
    package_name = "retainpdf_pipeline.ocr.ocr_provider"
    package = types.ModuleType(package_name)
    package.__path__ = [str(provider_dir)]
    sys.modules[package_name] = package
    module_name = f"{package_name}.paddle_normalize"
    spec = importlib.util.spec_from_file_location(
        module_name, provider_dir / "paddle_normalize.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Lee Paddle normalize module is unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _rescale_document(document: dict, page_sizes: list[dict], paddle_normalizer) -> None:
    for page_index, page in enumerate(document.get("pages", []) or []):
        if page_index >= len(page_sizes):
            continue
        target = page_sizes[page_index] or {}
        target_width = float(target.get("width", 0) or 0)
        target_height = float(target.get("height", 0) or 0)
        source_width = float(page.get("width", 0) or 0)
        source_height = float(page.get("height", 0) or 0)
        if target_width <= 0 or target_height <= 0:
            continue
        if source_width <= 0 or source_height <= 0:
            page["width"] = target_width
            page["height"] = target_height
            page["unit"] = "pt"
            continue
        scale_x = target_width / source_width
        scale_y = target_height / source_height
        page["width"] = target_width
        page["height"] = target_height
        page["unit"] = "pt"
        for block in page.get("blocks", []) or []:
            block["bbox"] = paddle_normalizer.scale_bbox(
                block.get("bbox", []), scale_x, scale_y
            )
            geometry = block.get("geometry") or {}
            if geometry:
                geometry["bbox"] = paddle_normalizer.scale_bbox(
                    geometry.get("bbox", []), scale_x, scale_y
                )
            for line in block.get("lines", []) or []:
                line["bbox"] = paddle_normalizer.scale_bbox(
                    line.get("bbox", []), scale_x, scale_y
                )
                for span in line.get("spans", []) or []:
                    span["bbox"] = paddle_normalizer.scale_bbox(
                        span.get("bbox", []), scale_x, scale_y
                    )
            for segment in block.get("segments", []) or []:
                if isinstance(segment, dict):
                    segment["bbox"] = paddle_normalizer.scale_bbox(
                        segment.get("bbox", []), scale_x, scale_y
                    )
        page_metadata = page.setdefault("metadata", {})
        split_x = page_metadata.get("column_split_x")
        if isinstance(split_x, (int, float)):
            page_metadata["column_split_x"] = float(split_x) * scale_x
    document.setdefault("derived", {})["coordinate_space"] = "pdf_point"


def main() -> None:
    runtime_root = Path(__file__).resolve().parent
    sys.path.insert(0, str(runtime_root))
    from retainpdf_pipeline.ocr.document_schema import (
        PROVIDER_MINERU,
        PROVIDER_PADDLE,
        adapt_payload_to_document_v1_with_report,
        build_validation_report,
    )

    paddle_normalizer = _load_retain_paddle_normalizer(runtime_root)
    request = json.load(sys.stdin)
    provider = request.get("provider", "paddle")
    payload = {
        "layoutParsingResults": request.get("layoutParsingResults") or [],
        # The page adapter safely falls back to each prunedResult's own
        # dimensions when provider JSONL metadata is unavailable.
        "dataInfo": {},
        "_meta": {"source": "readx_paddle_layout_results"},
    }
    if provider == "mineru":
        payload = {"pdf_info": request.get("layoutParsingResults") or []}
    document, report = adapt_payload_to_document_v1_with_report(
        payload=payload,
        provider=PROVIDER_MINERU if provider == "mineru" else PROVIDER_PADDLE,
        document_id=str(request.get("documentId", "readx-ocr")),
        source_json_path=Path("<readx-paddle-result>"),
        provider_version=str(request.get("providerVersion", "")),
    )
    _rescale_document(document, request.get("pageSizes") or [], paddle_normalizer)
    if provider != "mineru":
        paddle_normalizer.post_rescale_rebuild_paddle_text_geometry(document)
    validation = build_validation_report(document)
    report["validation"] = validation
    report["coordinate_space"] = "pdf_point"
    print(json.dumps({"document": document, "report": report}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Lee Paddle normalization failed: {error}", file=sys.stderr)
        raise
