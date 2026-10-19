from __future__ import annotations

import os
import random
import time
from typing import Any
from typing import Callable
from urllib.parse import urlsplit
from urllib.parse import urlunsplit

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


RETRY_STATUS_CODES = {408, 429, 500, 502, 503, 504}
DEFAULT_RETRY_ATTEMPTS_ENV = "RETAIN_HTTP_RETRY_ATTEMPTS"
DEFAULT_RETRY_BACKOFF_ENV = "RETAIN_HTTP_RETRY_BACKOFF_SECONDS"
RATE_LIMIT_WAIT_MAX_SECONDS = 300
POLL_INTERVAL_CAP_SECONDS = 30.0


def stepped_poll_interval(
    elapsed_seconds: float,
    base_interval: float,
    *,
    cap_seconds: float = POLL_INTERVAL_CAP_SECONDS,
) -> float:
    """Poll interval that widens as a provider job keeps running.

    Long OCR jobs don't finish in the first minute; polling a slow job at the
    base interval for 30 minutes is hundreds of pointless requests. Keep the
    base interval early (fast jobs stay responsive), then step up.
    """
    base = max(1.0, float(base_interval))
    if elapsed_seconds < 60:
        interval = base
    elif elapsed_seconds < 300:
        interval = base * 3
    else:
        interval = base * 6
    return min(interval, max(base, float(cap_seconds)))


def sanitize_url_for_log(url: str) -> str:
    """Strip query/fragment from a URL before it goes to stdout or a log file.

    Presigned/signed URLs (MinerU CDN bundle URLs, upload URLs, Paddle result
    URLs, ...) carry short-lived auth in the query string. stdout is mirrored
    to a per-job log file on disk, so printing the full URL persists those
    credentials as an artifact. Scheme + host + path are enough to identify
    the request in logs.
    """
    try:
        parts = urlsplit(url)
    except ValueError:
        return "<invalid-url>"
    had_query_or_fragment = bool(parts.query or parts.fragment)
    sanitized = urlunsplit((parts.scheme, parts.netloc.rsplit("@", 1)[-1], parts.path, "", ""))
    if had_query_or_fragment:
        sanitized = f"{sanitized}?…redacted…"
    return sanitized


class RetainNetworkError(RuntimeError):
    pass


class RetainRateLimitError(RetainNetworkError):
    pass


def retry_attempts(env_var: str = DEFAULT_RETRY_ATTEMPTS_ENV, default: int = 3) -> int:
    raw = os.environ.get(env_var, "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        value = default
    return max(1, value)


def retry_backoff_seconds(env_var: str = DEFAULT_RETRY_BACKOFF_ENV, default: float = 0.5) -> float:
    raw = os.environ.get(env_var, "").strip()
    try:
        value = float(raw) if raw else default
    except ValueError:
        value = default
    return max(0.1, value)


def direct_session(*, pool_connections: int = 8, pool_maxsize: int = 8) -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    session.proxies.clear()
    adapter = HTTPAdapter(
        max_retries=Retry(total=0, connect=0, read=0, redirect=0, status=0, backoff_factor=0),
        pool_connections=pool_connections,
        pool_maxsize=pool_maxsize,
    )
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def request_with_retry(
    session: requests.Session,
    method: str,
    url: str,
    *,
    timeout: int,
    attempts: int,
    backoff_seconds: float,
    label: str,
    retryable_response: Callable[[requests.Response], bool] | None = None,
    provider_queue_wait_seconds: float = 0,
    on_provider_queue_wait: Callable[[int, float, float], None] | None = None,
    **kwargs: Any,
) -> requests.Response:
    last_summary: str | None = None
    terminal_error: Exception | None = None
    status_code: int | None = None
    retryable_provider_response = False
    accumulated_rate_limit_wait = 0.0
    queue_started_at: float | None = None
    queue_retries = 0
    for attempt in range(1, attempts + 1):
        try:
            while True:
                response = session.request(method, url, timeout=timeout, **kwargs)
                if not (
                    provider_queue_wait_seconds > 0
                    and retryable_response is not None
                    and retryable_response(response)
                ):
                    break
                # An explicit queue-full response means the job was rejected,
                # so it is safe to resubmit. Network failures still use the
                # short retry policy below rather than this queue-wait budget.
                now = time.monotonic()
                if queue_started_at is None:
                    queue_started_at = now
                elapsed = now - queue_started_at
                remaining = provider_queue_wait_seconds - elapsed
                close = getattr(response, "close", None)
                if callable(close):
                    close()
                if remaining <= 0:
                    raise RetainRateLimitError(
                        f"{label} provider queue full (code 10010) after waiting "
                        f"{elapsed:.0f}s: {sanitize_url_for_log(url)}"
                    ) from None
                retry_after = str(response.headers.get("Retry-After", "") or "").strip()
                delay = min(30.0, 15.0 * (2 ** min(queue_retries, 1)))
                if retry_after.isdigit():
                    delay = max(delay, float(retry_after))
                delay = min(delay, remaining)
                queue_retries += 1
                if on_provider_queue_wait is not None:
                    on_provider_queue_wait(queue_retries, delay, elapsed)
                else:
                    print(f"{label} queue full; waiting {delay:.0f}s before retry {queue_retries}", flush=True)
                time.sleep(delay)
            response.raise_for_status()
            return response
        except (requests.Timeout, requests.ConnectionError, requests.RequestException) as err:
            status_code = (
                err.response.status_code
                if isinstance(err, requests.HTTPError) and err.response is not None
                else None
            )
            # requests exception messages can include signed URLs, response
            # bodies or proxy credentials. Never include their original text.
            last_summary = (
                f"{type(err).__name__} status={status_code or ''} "
                f"method={method.upper()} url={sanitize_url_for_log(url)}"
            )
            retryable = status_code in RETRY_STATUS_CODES or isinstance(
                err,
                (requests.Timeout, requests.ConnectionError),
            )
            retryable_provider_response = False
            if isinstance(err, requests.HTTPError) and err.response is not None and retryable_response is not None:
                try:
                    retryable_provider_response = retryable_response(err.response)
                except Exception:
                    retryable_provider_response = False
                retryable = retryable or retryable_provider_response
            if not retryable:
                # Preserve callers' exception/status classification, but raise
                # outside this handler so no raw exception context survives.
                terminal_error = type(err)(
                    last_summary, request=err.request, response=err.response
                )
                break
            if attempt >= attempts:
                break
            retry_after = ""
            if isinstance(err, requests.HTTPError) and err.response is not None:
                retry_after = str(err.response.headers.get("Retry-After", "") or "").strip()
            if retry_after.isdigit():
                sleep_seconds = float(max(1, int(retry_after)))
            else:
                sleep_seconds = min(30.0, backoff_seconds * (2 ** max(0, attempt - 1)))
                if retryable_provider_response:
                    # Paddle's HTTP 400 / provider code 10010 means its job
                    # submission queue is full. Give the queue time to drain.
                    sleep_seconds = min(30.0, max(2.0, sleep_seconds))
                sleep_seconds += random.uniform(0.0, max(0.1, sleep_seconds * 0.25))
            if status_code == 429 or retryable_provider_response:
                accumulated_rate_limit_wait += sleep_seconds
                if accumulated_rate_limit_wait > RATE_LIMIT_WAIT_MAX_SECONDS:
                    terminal_error = RetainRateLimitError(
                        f"{label} retry budget exceeded for {sanitize_url_for_log(url)}"
                    )
                    break
            print(
                f"{label} request retry {attempt}/{attempts} method={method.upper()} url={sanitize_url_for_log(url)} "
                f"error={last_summary}; sleep={sleep_seconds:.2f}s",
                flush=True,
            )
            time.sleep(sleep_seconds)
    if terminal_error is not None:
        raise terminal_error from None
    assert last_summary is not None
    if status_code == 429 or retryable_provider_response:
        reason = "provider queue full (code 10010)" if retryable_provider_response else "rate limited"
        raise RetainRateLimitError(
            f"{label} {reason} after {attempts} attempts: {sanitize_url_for_log(url)}"
        ) from None
    raise RetainNetworkError(
        f"{label} network request failed after {attempts} attempts: {last_summary}"
    ) from None
