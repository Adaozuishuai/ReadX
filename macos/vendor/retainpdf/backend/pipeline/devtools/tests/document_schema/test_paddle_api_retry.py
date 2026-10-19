from __future__ import annotations


import pytest
import requests


from retainpdf_pipeline.ocr.ocr_provider import paddle_api
from retainpdf_pipeline.ocr.ocr_provider import paddle_markdown
from retainpdf_pipeline.ocr.mineru_provider import mineru_api
from retainpdf_pipeline.ocr import retry as network_retry


class _Response:
    def __init__(self, status_code: int, headers: dict[str, str] | None = None, payload: dict | None = None) -> None:
        self.status_code = status_code
        self.headers = headers or {}
        self.payload = payload or {}
        self.url = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs"
        self.reason = "error"

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Client Error", response=self)

    def json(self) -> dict:
        return self.payload


class _Session:
    def __init__(self, response: _Response | list[_Response]) -> None:
        self.responses = response if isinstance(response, list) else [response]
        self.calls = 0

    def request(self, *_args, **_kwargs):
        response = self.responses[min(self.calls, len(self.responses) - 1)]
        self.calls += 1
        return response


def test_paddle_request_retries_429_and_raises_rate_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _Session(_Response(429, headers={"Retry-After": "1"}))
    sleeps: list[float] = []

    monkeypatch.setattr(paddle_api, "_get_session", lambda: session)
    monkeypatch.setenv(paddle_api.PADDLE_RETRY_ATTEMPTS_ENV, "2")
    monkeypatch.setattr(paddle_api.time, "sleep", lambda seconds: sleeps.append(seconds))

    with pytest.raises(paddle_api.PaddleRateLimitError):
        paddle_api._request_with_retry("get", "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs", timeout=1)

    assert session.calls == 2
    assert sleeps == [1.0]


def test_paddle_request_does_not_retry_auth_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _Session(_Response(401))

    monkeypatch.setattr(paddle_api, "_get_session", lambda: session)
    monkeypatch.setenv(paddle_api.PADDLE_RETRY_ATTEMPTS_ENV, "3")

    with pytest.raises(requests.HTTPError):
        paddle_api._request_with_retry("get", "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs", timeout=1)

    assert session.calls == 1


def test_paddle_request_retries_http_400_queue_full_code(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _Session([
        _Response(400, payload={"traceId": "trace-queue", "code": 10010, "msg": "任务提交队列已满"}),
        _Response(200, payload={"code": 0, "data": {"jobId": "job-1"}}),
    ])
    sleeps: list[float] = []
    monkeypatch.setattr(paddle_api, "_get_session", lambda: session)
    monkeypatch.setenv(paddle_api.PADDLE_RETRY_ATTEMPTS_ENV, "2")
    monkeypatch.setattr(paddle_api.time, "sleep", lambda seconds: sleeps.append(seconds))
    monkeypatch.setattr(network_retry.random, "uniform", lambda *_: 0.0)

    response = paddle_api._request_with_retry(
        "post", "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs", timeout=1
    )

    assert response.status_code == 200
    assert session.calls == 2
    assert sleeps == [2.0]


@pytest.mark.parametrize("status", [200, 400])
def test_submit_waits_for_queue_recovery_beyond_network_retry_limit(monkeypatch, tmp_path, status):
    queue_full = _Response(status, payload={"code": 10010})
    session = _Session([queue_full] * 6 + [
        _Response(200, payload={"code": 0, "traceId": "trace-ok", "data": {"jobId": "job-ok"}}),
    ])
    now = [0.0]
    sleeps = []
    events = []

    def sleep(seconds):
        sleeps.append(seconds)
        now[0] += seconds

    monkeypatch.setattr(paddle_api, "_get_session", lambda: session)
    monkeypatch.setenv(paddle_api.PADDLE_RETRY_ATTEMPTS_ENV, "1")
    monkeypatch.setattr(network_retry.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(network_retry.time, "sleep", sleep)
    monkeypatch.setattr(paddle_api, "emit_stage_progress", lambda **event: events.append(event))
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-test-content")

    assert paddle_api.submit_local_file(
        token="test", file_path=source, model="PaddleOCR-VL", optional_payload={},
    ) == ("job-ok", "trace-ok")
    assert session.calls == 7
    assert sleeps == [15.0, 30.0, 30.0, 30.0, 30.0, 30.0]
    assert all(event["substage"] == "ocr_queue_wait" for event in events)
    assert events[-1]["retry_count"] == 6


def test_queue_wait_exhaustion_is_bounded_and_not_reported_as_network_failure(monkeypatch):
    session = _Session(_Response(400, payload={"code": 10010}))
    now = [0.0]
    sleeps = []

    def sleep(seconds):
        sleeps.append(seconds)
        now[0] += seconds

    monkeypatch.setattr(paddle_api, "_get_session", lambda: session)
    monkeypatch.setattr(network_retry.time, "monotonic", lambda: now[0])
    monkeypatch.setattr(network_retry.time, "sleep", sleep)

    with pytest.raises(paddle_api.PaddleRateLimitError, match="code 10010.*waiting 45s"):
        paddle_api._request_with_retry("post", "https://example.test/jobs", timeout=1, queue_wait_seconds=45)
    assert session.calls == 3
    assert sleeps == [15.0, 30.0]


def test_submission_auth_failure_does_not_enter_queue_wait(monkeypatch, tmp_path):
    session = _Session(_Response(401))
    monkeypatch.setattr(paddle_api, "_get_session", lambda: session)
    monkeypatch.setattr(network_retry.time, "sleep", lambda _: pytest.fail("auth errors must not wait"))
    source = tmp_path / "paper.pdf"
    source.write_bytes(b"%PDF-test-content")
    with pytest.raises(requests.HTTPError):
        paddle_api.submit_local_file(token="test", file_path=source, model="PaddleOCR-VL", optional_payload={})
    assert session.calls == 1


def test_http_success_with_provider_error_is_not_accepted_as_success():
    with pytest.raises(RuntimeError, match="code=11003"):
        paddle_api._check_envelope({"code": 11003, "msg": "OCR failed"}, stage="poll")


def test_paddle_optional_payload_sets_page_limit() -> None:
    payload = paddle_api.build_optional_payload("PaddleOCR-VL-1.5")
    assert payload["max_num_input_imgs"] == 999

    structure_payload = paddle_api.build_optional_payload("PP-StructureV3")
    assert structure_payload["max_num_input_imgs"] == 999


def test_paddle_model_defaults_and_aliases_use_shared_config() -> None:
    assert paddle_api.normalize_model_name("") == "PaddleOCR-VL-1.6"
    assert paddle_api.normalize_model_name("paddleocr-vl") == "PaddleOCR-VL-1.6"
    assert paddle_api.normalize_model_name("paddle-ocr-vl-1.6") == "PaddleOCR-VL-1.6"
    assert paddle_api.normalize_model_name("paddleocr-vl-1.5") == "PaddleOCR-VL-1.5"


def test_mineru_request_retries_429_and_raises_rate_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _Session(_Response(429, headers={"Retry-After": "1"}))
    sleeps: list[float] = []

    monkeypatch.setattr(mineru_api, "_get_session", lambda: session)
    monkeypatch.setenv(mineru_api.MINERU_RETRY_ATTEMPTS_ENV, "2")
    monkeypatch.setattr(mineru_api.time, "sleep", lambda seconds: sleeps.append(seconds))

    with pytest.raises(mineru_api.MinerURateLimitError):
        mineru_api.request_mineru("get", "https://mineru.net/api/v4/extract/task/test", timeout=1)

    assert session.calls == 2
    assert sleeps == [1.0]


def test_sanitize_url_for_log_strips_query_and_fragment() -> None:
    signed_url = "https://cdn.example.com/bundle.zip?X-Amz-Signature=super-secret&X-Amz-Expires=900#frag"
    sanitized = network_retry.sanitize_url_for_log(signed_url)
    assert sanitized.startswith("https://cdn.example.com/bundle.zip")
    assert "super-secret" not in sanitized
    assert "X-Amz-Signature" not in sanitized
    assert "frag" not in sanitized


def test_sanitize_url_for_log_leaves_url_without_query_untouched() -> None:
    plain_url = "https://cdn.example.com/bundle.zip"
    assert network_retry.sanitize_url_for_log(plain_url) == plain_url


def test_mineru_request_retry_print_redacts_query_string(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    session = _Session(_Response(429, headers={"Retry-After": "1"}))

    monkeypatch.setattr(mineru_api, "_get_session", lambda: session)
    monkeypatch.setenv(mineru_api.MINERU_RETRY_ATTEMPTS_ENV, "2")
    monkeypatch.setattr(mineru_api.time, "sleep", lambda seconds: None)

    signed_url = "https://mineru.net/api/v4/extract/task/test?token=SUPER-SECRET-TOKEN"
    with pytest.raises(mineru_api.MinerURateLimitError):
        mineru_api.request_mineru("get", signed_url, timeout=1)

    captured = capsys.readouterr()
    assert "SUPER-SECRET-TOKEN" not in captured.out
    assert "redacted" in captured.out


def test_paddle_markdown_remote_image_uses_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    class Response:
        content = b"image-bytes"

    calls: list[tuple[str, str]] = []

    def fake_request_with_retry(_session, method, url, **_kwargs):
        calls.append((method, url))
        return Response()

    monkeypatch.setattr(paddle_markdown, "request_with_retry", fake_request_with_retry)

    assert paddle_markdown.decode_paddle_markdown_image("https://example.test/image.png") == b"image-bytes"
    assert calls == [("get", "https://example.test/image.png")]
