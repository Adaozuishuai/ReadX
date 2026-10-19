"""Markdown 图片地址：新地址和旧对话记录里的旧地址都认，别的一律不认。"""

from retainpdf_ai.agent_evidence import _is_job_markdown_image_url


def test_new_and_legacy_markdown_image_urls_are_accepted():
    assert _is_job_markdown_image_url("/api/v1/jobs/j1/files/output/ocr/images/page-1/a.png")
    assert _is_job_markdown_image_url("/api/v1/jobs/j1/markdown/images/page-1/a.png?doc=d")


def test_other_urls_are_rejected():
    for url in (
        "https://example.com/markdown/images/a.png",
        "/api/v1/jobs/j1/files/internal/translation-requests.jsonl",
        "/api/v1/jobs/j1/files/output/translated.pdf",
        "",
    ):
        assert not _is_job_markdown_image_url(url)
