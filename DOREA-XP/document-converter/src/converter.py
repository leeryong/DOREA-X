from __future__ import annotations

import shutil
import subprocess
import tempfile
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


SUPPORTED_EXTENSIONS = {
    ".pdf",
    ".hwp",
    ".hwpx",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".txt",
    ".csv",
    ".md",
    ".html",
}


class ConversionError(Exception):
    def __init__(self, message: str, *, exit_code: int = 1):
        super().__init__(message)
        self.exit_code = exit_code


@dataclass
class ConversionResult:
    output_pdf: Path
    stdout: str
    stderr: str
    duration_seconds: float
    profile_uri: str


def _normalize_extension(path: Path) -> str:
    return path.suffix.lower()


def _ensure_supported(path: Path, allowed_extensions: Iterable[str]) -> None:
    ext = _normalize_extension(path)
    allowed = {x.lower() for x in allowed_extensions}
    if ext not in allowed:
        raise ConversionError(
            f"Unsupported extension '{ext}'. Supported: {', '.join(sorted(allowed))}",
            exit_code=2,
        )


def _validate_pdf_output(path: Path) -> None:
    if not path.exists():
        raise ConversionError(f"Output PDF not found: {path}", exit_code=5)

    size = path.stat().st_size
    if size <= 0:
        raise ConversionError(f"Output PDF is empty: {path}", exit_code=5)

    with open(path, "rb") as handle:
        signature = handle.read(5)
    if signature != b"%PDF-":
        raise ConversionError(f"Output is not a valid PDF signature: {path}", exit_code=5)


def _copy_pdf_passthrough(input_path: Path, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / f"{input_path.stem}.pdf"
    if input_path.resolve() == target.resolve():
        _validate_pdf_output(target)
        return target

    shutil.copy2(input_path, target)
    _validate_pdf_output(target)
    return target


def convert_to_pdf(
    input_path: Path,
    output_dir: Path,
    *,
    timeout_seconds: float = 120.0,
    allowed_extensions: Iterable[str] = SUPPORTED_EXTENSIONS,
    soffice_bin: str = "soffice",
) -> ConversionResult:
    input_path = input_path.expanduser().resolve()
    output_dir = output_dir.expanduser().resolve()

    if not input_path.exists() or not input_path.is_file():
        raise ConversionError(f"Input file not found: {input_path}", exit_code=4)

    _ensure_supported(input_path, allowed_extensions)
    output_dir.mkdir(parents=True, exist_ok=True)

    if _normalize_extension(input_path) == ".pdf":
        start = time.monotonic()
        output_pdf = _copy_pdf_passthrough(input_path, output_dir)
        duration = time.monotonic() - start
        return ConversionResult(
            output_pdf=output_pdf,
            stdout="passthrough",
            stderr="",
            duration_seconds=duration,
            profile_uri="",
        )

    existing = {p.resolve() for p in output_dir.glob("*.pdf") if p.is_file()}
    profile_path = Path(tempfile.mkdtemp(prefix=f"lo-profile-{uuid.uuid4().hex[:8]}-", dir="/tmp"))
    profile_uri = profile_path.resolve().as_uri()
    start = time.monotonic()

    cmd = [
        soffice_bin,
        "--headless",
        "--nologo",
        "--nodefault",
        "--norestore",
        f"-env:UserInstallation={profile_uri}",
        "--convert-to",
        "pdf:writer_pdf_Export",
        "--outdir",
        str(output_dir),
        str(input_path),
    ]

    try:
        completed = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise ConversionError(
            f"LibreOffice conversion timed out after {timeout_seconds}s for {input_path.name}",
            exit_code=4,
        ) from exc
    except Exception as exc:
        raise ConversionError(f"Failed to execute LibreOffice: {exc}", exit_code=3) from exc
    finally:
        shutil.rmtree(profile_path, ignore_errors=True)

    duration = time.monotonic() - start
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""

    if completed.returncode != 0:
        reason = stderr.strip() or stdout.strip() or "unknown LibreOffice error"
        raise ConversionError(
            f"LibreOffice failed with exit code {completed.returncode}: {reason}",
            exit_code=3,
        )

    expected = output_dir / f"{input_path.stem}.pdf"
    if expected.exists():
        _validate_pdf_output(expected)
        return ConversionResult(
            output_pdf=expected,
            stdout=stdout,
            stderr=stderr,
            duration_seconds=duration,
            profile_uri=profile_uri,
        )

    produced = [p.resolve() for p in output_dir.glob("*.pdf") if p.is_file()]
    new_files = [p for p in produced if p not in existing]
    if new_files:
        newest = max(new_files, key=lambda p: p.stat().st_mtime)
        _validate_pdf_output(newest)
        return ConversionResult(
            output_pdf=newest,
            stdout=stdout,
            stderr=stderr,
            duration_seconds=duration,
            profile_uri=profile_uri,
        )

    reason = stderr.strip() or stdout.strip() or "no output PDF produced"
    raise ConversionError(
        f"LibreOffice finished but output PDF was not found: {reason}",
        exit_code=5,
    )
