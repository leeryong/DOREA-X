# File Management Routes

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import JSONResponse, FileResponse as FastAPIFileResponse, Response as FastAPIResponse, StreamingResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session
from typing import List, Any
import uuid
import asyncio
import json
import traceback
import shutil
import re
import io
import zipfile
import httpx
import pdfplumber
from pathlib import Path
from enum import Enum as PyEnum
from pypdf import PdfReader

from models.database import get_db, PDFFile, User, Folder, FileStatus, FileDomain, ChatSession, ChatMessage, KnowledgeDB, SystemSetting, FileEmbedding
from schemas.api_schemas import FileUploadResponse
from api.deps import get_current_user
from api.knowledge_dbs import get_or_create_default_kb
from services.processing_queue import processing_queue
from datetime import datetime
from typing import Optional, Literal, cast
from pydantic import BaseModel
from config import settings

router = APIRouter(prefix="/api/files", tags=["Files"])

# ========== Upload Policy Constants ==========
MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024  # 100MB
MAX_QUEUED_FILES_PER_USER = 100  # 동시 처리 대기 최대 수

# 허용 확장자 → MIME 매핑 (확장자 allowlist + MIME 일관성 검증)
# 지원 파일: 문서 12종 (PDF, Office, HWP, 텍스트)
ALLOWED_EXTENSIONS = {
    ".pdf": {"application/pdf"},
    ".doc": {"application/msword"},
    ".docx": {"application/vnd.openxmlformats-officedocument.wordprocessingml.document"},
    ".xls": {"application/vnd.ms-excel"},
    ".xlsx": {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
    ".ppt": {"application/vnd.ms-powerpoint"},
    ".pptx": {"application/vnd.openxmlformats-officedocument.presentationml.presentation"},
    ".hwp": {"application/x-hwp", "application/haansofthwp", "application/octet-stream"},
    ".hwpx": {"application/x-hwpx", "application/haansofthwpx", "application/octet-stream", "application/zip"},
    ".txt": {"text/plain"},
    ".csv": {"text/csv", "application/csv"},
    ".md": {"text/markdown", "text/plain", "application/octet-stream"},
}

# ========== Authored Asset Constants ==========
MAX_AUTHORED_ASSET_SIZE_BYTES = 5 * 1024 * 1024  # 5MB
ALLOWED_AUTHORED_ASSET_MIMES = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"}
MIME_TO_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
DRAFTS_ROOT_DIRNAME = "drafts"
EXT_TO_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
}

# 파일명 sanitize 패턴: 위험 문자 제거, 공백 정규화
_UNSAFE_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_MULTI_SPACE_RE = re.compile(r'\s+')
_ASSET_SLUG_RE = re.compile(r"[^a-z0-9]+")
_AUTHORED_ASSET_REF_RE = re.compile(r"\.\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)")

FILE_DOMAIN_ANALYSIS = "analysis"
FILE_DOMAIN_MY_DOCUMENTS = "my_documents"
ALLOWED_FILE_DOMAINS = {FILE_DOMAIN_ANALYSIS, FILE_DOMAIN_MY_DOCUMENTS}


class ContractFileResponse(BaseModel):
    id: str
    filename: str
    file_size: int
    status: FileStatus
    domain: Literal["analysis", "my_documents"]
    total_pages: int
    mime_type: str
    uploaded_at: datetime
    processing_started_at: Optional[datetime] = None
    converted_at: Optional[datetime] = None
    analyzed_at: Optional[datetime] = None
    processing_completed_at: Optional[datetime] = None
    processing_duration_seconds: Optional[float] = None
    processing_uses_gpu: Optional[bool] = None
    queue_position: Optional[int] = None
    eta_seconds: Optional[float] = None
    analysis_provider: Optional[str] = None
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    analysis_generation: int = 1
    enrichment_status: Optional[str] = None
    enrichment_error: Optional[str] = None
    enrichment_generation: int = 0
    enrichment_total_targets: int = 0
    enrichment_processed_targets: int = 0
    enrichment_model_provider: Optional[str] = None
    enrichment_model_name: Optional[str] = None
    enrichment_enqueued_at: Optional[datetime] = None
    enrichment_started_at: Optional[datetime] = None
    enrichment_completed_at: Optional[datetime] = None


class ContractFileListResponse(BaseModel):
    files: List[ContractFileResponse]
    total: int
    queue_stats: Optional[dict[str, Any]] = None


class PromoteMyDocumentRequest(BaseModel):
    knowledge_db_id: Optional[int] = None
    analysis_provider: Optional[str] = None


class ReprocessFileRequest(BaseModel):
    analysis_provider: Optional[str] = None


def _build_contract_file_response(
    file: PDFFile,
    *,
    resolved_domain: Literal["analysis", "my_documents"],
    resolved_status: FileStatus,
    queue_position: Optional[int] = None,
    eta_seconds: Optional[float] = None,
) -> ContractFileResponse:
    return ContractFileResponse(
        id=file.id,
        filename=file.original_filename,
        file_size=file.file_size,
        status=resolved_status,
        domain=resolved_domain,
        total_pages=file.total_pages,
        mime_type=file.mime_type,
        uploaded_at=file.uploaded_at,
        processing_started_at=getattr(file, "processing_started_at", None),
        converted_at=file.converted_at,
        analyzed_at=file.analyzed_at,
        processing_completed_at=getattr(file, "processing_completed_at", None),
        processing_duration_seconds=getattr(file, "processing_duration_seconds", None),
        processing_uses_gpu=getattr(file, "processing_uses_gpu", None),
        queue_position=queue_position,
        eta_seconds=eta_seconds,
        analysis_provider=getattr(file, "analysis_provider", None),
        error_code=file.error_code,
        error_message=file.error_message,
        analysis_generation=max(int(getattr(file, "analysis_generation", 1) or 1), 1),
        enrichment_status=getattr(file, "enrichment_status", "none"),
        enrichment_error=getattr(file, "enrichment_error", None),
        enrichment_generation=max(int(getattr(file, "enrichment_generation", 0) or 0), 0),
        enrichment_total_targets=max(int(getattr(file, "enrichment_total_targets", 0) or 0), 0),
        enrichment_processed_targets=max(int(getattr(file, "enrichment_processed_targets", 0) or 0), 0),
        enrichment_model_provider=getattr(file, "enrichment_model_provider", None),
        enrichment_model_name=getattr(file, "enrichment_model_name", None),
        enrichment_enqueued_at=getattr(file, "enrichment_enqueued_at", None),
        enrichment_started_at=getattr(file, "enrichment_started_at", None),
        enrichment_completed_at=getattr(file, "enrichment_completed_at", None),
    )


def _normalize_file_domain(raw_domain: Optional[object]) -> Literal["analysis", "my_documents"]:
    if isinstance(raw_domain, PyEnum):
        domain_value = str(raw_domain.value).strip().lower()
    elif raw_domain is None:
        domain_value = FILE_DOMAIN_ANALYSIS
    else:
        domain_value = str(raw_domain).strip().lower()

    if domain_value not in ALLOWED_FILE_DOMAINS:
        return FILE_DOMAIN_ANALYSIS
    return cast(Literal["analysis", "my_documents"], domain_value)


def _normalize_file_status(file_obj: PDFFile, resolved_domain: Optional[str] = None) -> FileStatus:
    raw_status = getattr(file_obj, "status", None)
    if isinstance(raw_status, PyEnum):
        status_value = str(raw_status.value).strip().lower()
    elif raw_status is None:
        status_value = ""
    else:
        status_value = str(raw_status).strip().lower()

    normalized_domain = resolved_domain or _normalize_file_domain(getattr(file_obj, "domain", None))
    if normalized_domain == FILE_DOMAIN_MY_DOCUMENTS and status_value in {"", FileStatus.UPLOADING.value, FileStatus.STORED.value}:
        return FileStatus.STORED

    try:
        return FileStatus(status_value)
    except ValueError:
        return FileStatus.COMPLETED


def _ensure_analysis_domain(file_obj: PDFFile) -> None:
    resolved_domain = _normalize_file_domain(getattr(file_obj, "domain", None))
    if resolved_domain == FILE_DOMAIN_MY_DOCUMENTS:
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": "FILES_WRONG_DOMAIN",
                "message": "my_documents 파일에는 사용할 수 없는 분석 전용 API입니다.",
            },
        )


def _cleanup_analysis_generated_files(file_dir: Path) -> list[str]:
    cleanup_errors: list[str] = []

    for target in ["document.pdf", "document.ocr.pdf", "document.preocr.pdf"]:
        target_path = file_dir / target
        if target_path.exists():
            try:
                target_path.unlink()
            except Exception as e:
                cleanup_errors.append(f"{target}: {e}")

    analysis_dir = file_dir / "analysis"
    if analysis_dir.exists():
        try:
            shutil.rmtree(analysis_dir)
        except Exception as e:
            cleanup_errors.append(f"analysis/: {e}")

    for marker in ["base-opendataloader.txt"]:
        marker_path = file_dir / marker
        if marker_path.exists():
            try:
                marker_path.unlink()
            except Exception as e:
                cleanup_errors.append(f"{marker}: {e}")

    return cleanup_errors


def _reset_analysis_file_state(
    file: PDFFile,
    *,
    error_code: Optional[str],
    error_message: Optional[str],
    clear_processing_history: bool = True,
) -> None:
    file.status = FileStatus.FAILED if error_code else FileStatus.QUEUED
    file.segments_data = None
    file.total_pages = 0
    file.error_code = error_code
    file.error_message = error_message
    file.analysis_generation = max(int(getattr(file, "analysis_generation", 1) or 1), 1) + 1
    file.converted_at = None
    file.analyzed_at = None
    file.enqueued_at = None
    if clear_processing_history:
        file.processing_started_at = None
        file.processing_completed_at = None
        file.processing_duration_seconds = None
        file.processing_uses_gpu = None
    file.embedding_status = "none"
    file.embedding_chunks = 0
    file.embedding_model = None
    file.embedding_total_chunks = 0
    file.embedding_processed_chunks = 0
    file.embedding_at = None
    file.content_version = None
    file.enrichment_status = "none"
    file.enrichment_error = None
    file.analysis_generation = max(int(getattr(file, "analysis_generation", 1) or 1), 1)
    file.enrichment_generation = 0
    file.enrichment_total_targets = 0
    file.enrichment_processed_targets = 0
    file.enrichment_model_provider = None
    file.enrichment_model_name = None
    file.enrichment_enqueued_at = None
    file.enrichment_started_at = None
    file.enrichment_completed_at = None


def _preserve_processing_history_for_terminal_state(file: PDFFile) -> None:
    completed_at = getattr(file, "processing_completed_at", None)
    started_at = getattr(file, "processing_started_at", None)
    if completed_at is None:
        completed_at = datetime.utcnow()
        file.processing_completed_at = completed_at

    duration = getattr(file, "processing_duration_seconds", None)
    if duration is None and started_at is not None:
        try:
            file.processing_duration_seconds = round(max((completed_at - started_at).total_seconds(), 0.0), 1)
        except Exception:
            pass


def _resolve_my_document_source_path(file_obj: PDFFile, user_id: int, file_id: str) -> Optional[Path]:
    raw_path = getattr(file_obj, "file_path", None)
    if raw_path:
        candidate = Path(raw_path)
        if candidate.exists() and candidate.is_file():
            return candidate
        if candidate.exists() and candidate.is_dir():
            for path in sorted(candidate.glob("source.*")):
                if path.is_file():
                    return path

    fallback_dir = Path(f"/app/DATABASE/myfiles/users/{user_id}/{file_id}")
    if fallback_dir.exists() and fallback_dir.is_dir():
        for path in sorted(fallback_dir.glob("source.*")):
            if path.is_file():
                return path

    return None


def _should_prebuild_my_document_preview(source_path: Path, mime_type: Optional[str]) -> bool:
    suffix = source_path.suffix.lower()
    mime = str(mime_type or "").lower()
    return suffix in {".hwp", ".hwpx"} or mime in {"application/x-hwp", "application/x-hwpx"}


def _preview_metadata_path(preview_path: Path) -> Path:
    return preview_path.parent / "document.preview.metadata.json"


def _read_preview_metadata(preview_path: Path) -> dict[str, Any]:
    metadata_path = _preview_metadata_path(preview_path)
    if not metadata_path.exists():
        return {}
    try:
        data = json.loads(metadata_path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_preview_metadata(preview_path: Path, *, fallback_used: bool, strict_preview: bool) -> None:
    _preview_metadata_path(preview_path).write_text(
        json.dumps(
            {
                "fallback_used": fallback_used,
                "strict_preview": strict_preview,
                "generated_at": datetime.utcnow().isoformat() + "Z",
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def _strict_preview_fallback_error() -> HTTPException:
    return HTTPException(
        status_code=502,
        detail={
            "error_code": "FILES_CONVERSION_FALLBACK_USED",
            "message": "생성된 HWPX 문서의 미리보기가 안전한 변환 경로로 생성되지 않았습니다.",
        },
    )


def _read_generation_strict_preview(file_dir: Path) -> Optional[bool]:
    generation_path = file_dir / "generation.json"
    if not generation_path.exists():
        return None
    try:
        metadata = json.loads(generation_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(metadata, dict):
        return None
    strict_preview = metadata.get("strict_preview")
    return strict_preview if isinstance(strict_preview, bool) else None


def _is_strict_generated_preview(file_obj: PDFFile, file_dir: Path) -> bool:
    strict_preview = _read_generation_strict_preview(file_dir)
    if strict_preview is not None:
        return strict_preview
    return getattr(file_obj, "origin", None) == "template_generated"


async def _ensure_my_document_preview_pdf(
    source_path: Path,
    mime_type: Optional[str],
    original_filename: str,
    *,
    strict_preview: bool = False,
) -> Optional[Path]:
    preview_path = source_path.parent / "document.preview.pdf"
    if preview_path.exists() and preview_path.is_file():
        if not strict_preview:
            return preview_path
        metadata = _read_preview_metadata(preview_path)
        if metadata.get("fallback_used") is False:
            return preview_path
        preview_path.unlink(missing_ok=True)
        _preview_metadata_path(preview_path).unlink(missing_ok=True)

    converted_pdf, fallback_used = await _convert_source_to_pdf_bytes(source_path, mime_type, original_filename)
    if strict_preview and fallback_used:
        raise _strict_preview_fallback_error()

    preview_path.write_bytes(converted_pdf)
    _write_preview_metadata(preview_path, fallback_used=fallback_used, strict_preview=strict_preview)
    return preview_path


async def _maybe_prebuild_my_document_preview(
    source_path: Path,
    mime_type: Optional[str],
    original_filename: str,
    *,
    strict_preview: bool = False,
) -> None:
    if not _should_prebuild_my_document_preview(source_path, mime_type):
        return
    try:
        await _ensure_my_document_preview_pdf(
            source_path,
            mime_type,
            original_filename,
            strict_preview=strict_preview,
        )
    except Exception as preview_error:
        if strict_preview:
            raise
        print(f"[MyDocsPreviewWarmup] preview generation skipped for {original_filename}: {preview_error}")


def _normalize_pdf_filter_names(raw_filter: Any) -> list[str]:
    if raw_filter is None:
        return []
    if isinstance(raw_filter, (list, tuple)):
        names: list[str] = []
        for item in raw_filter:
            names.extend(_normalize_pdf_filter_names(item))
        return names
    return [str(raw_filter).strip()]


def _collect_pdf_xobject_filters(resources: Any, seen: set[Any]) -> list[str]:
    if not resources:
        return []

    try:
        xobjects_ref = resources.get("/XObject")
    except Exception:
        return []

    if not xobjects_ref:
        return []

    try:
        xobjects = xobjects_ref.get_object()
    except Exception:
        return []

    filters: list[str] = []
    for raw_obj in xobjects.values():
        try:
            obj = raw_obj.get_object()
        except Exception:
            continue

        ref = getattr(raw_obj, "indirect_reference", None) or getattr(obj, "indirect_reference", None)
        ref_key = (
            getattr(ref, "idnum", None),
            getattr(ref, "generation", None),
        ) if ref is not None else id(obj)
        if ref_key in seen:
            continue
        seen.add(ref_key)

        subtype = str(obj.get("/Subtype", "") or "")
        if subtype == "/Image":
            filters.extend(_normalize_pdf_filter_names(obj.get("/Filter")))
            continue

        if subtype == "/Form":
            filters.extend(_collect_pdf_xobject_filters(obj.get("/Resources"), seen))

    return filters


def _build_pdf_viewer_profile(pdf_path: Path, max_pages: int = 3) -> dict[str, Any]:
    profile: dict[str, Any] = {
        "prefer_page_images": False,
        "reason": None,
        "checked_pages": 0,
        "detected_filters": [],
    }

    if not pdf_path.exists() or not pdf_path.is_file():
        profile["reason"] = "pdf_not_found"
        return profile

    try:
        reader = PdfReader(str(pdf_path))
        filters_found: set[str] = set()
        checked_pages = min(len(reader.pages), max_pages)

        for page_index in range(checked_pages):
            page = reader.pages[page_index]
            filters = _collect_pdf_xobject_filters(page.get("/Resources"), set())
            filters_found.update(filters)

            if any(filter_name == "/JPXDecode" for filter_name in filters):
                profile["prefer_page_images"] = True
                profile["reason"] = "jpx_images_detected"
                break

        profile["checked_pages"] = checked_pages
        profile["detected_filters"] = sorted(filters_found)
        return profile
    except Exception as exc:
        profile["reason"] = f"profile_detection_failed:{exc.__class__.__name__}"
        return profile


def _render_pdf_page_png_bytes(pdf_path: Path, page_num: int) -> Optional[bytes]:
    try:
        if not pdf_path.exists() or not pdf_path.is_file():
            return None

        cache_dir = pdf_path.parent / "viewer-pages"
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path = cache_dir / f"page-{page_num:04d}.png"

        pdf_mtime = pdf_path.stat().st_mtime
        if cache_path.exists() and cache_path.stat().st_mtime >= pdf_mtime:
            return cache_path.read_bytes()

        with pdfplumber.open(str(pdf_path)) as pdf:
            if page_num < 1 or page_num > len(pdf.pages):
                return None

            page = pdf.pages[page_num - 1]
            page_image = page.to_image(resolution=160)
            pil = page_image.original
            buf = io.BytesIO()
            pil.save(buf, format="PNG")
            png_bytes = buf.getvalue()

        cache_path.write_bytes(png_bytes)
        return png_bytes
    except Exception:
        return None


async def _resolve_my_document_pdf_path(file: PDFFile, user_id: int, file_id: str) -> Path:
    source_path = _resolve_my_document_source_path(file, user_id, file_id)
    if not source_path:
        raise HTTPException(
            status_code=404,
            detail={
                "error_code": "FILES_SOURCE_NOT_FOUND",
                "message": "원본 문서 경로를 찾을 수 없습니다.",
            },
        )

    source_suffix = source_path.suffix.lower()
    file_mime = str(getattr(file, "mime_type", "") or "").lower()

    if source_suffix == ".pdf" or file_mime == "application/pdf":
        return source_path

    strict_preview = _is_strict_generated_preview(file, source_path.parent)
    preview_path = source_path.parent / "document.preview.pdf"
    if preview_path.exists() and preview_path.is_file() and not strict_preview:
        return preview_path

    built_preview_path = await _ensure_my_document_preview_pdf(
        source_path,
        getattr(file, "mime_type", None),
        file.original_filename,
        strict_preview=strict_preview,
    )
    if not built_preview_path:
        raise HTTPException(
            status_code=404,
            detail={
                "error_code": "FILES_PDF_NOT_READY",
                "message": "PDF 파일이 아직 준비되지 않았습니다",
            },
        )
    return built_preview_path


def _get_analysis_provider_snapshot(db: Session) -> str:
    return "opendataloader"


def _resolve_analysis_provider(db: Session, requested_provider: Optional[str] = None) -> str:
    return "opendataloader"


def _render_segment_crop_png_bytes(pdf_path: Path, seg: dict[str, Any]) -> Optional[bytes]:
    """
    segment bbox를 document.pdf에서 crop하여 PNG bytes 반환.
    """
    try:
        if not pdf_path.exists() or not pdf_path.is_file():
            return None

        page_num = int(seg.get("page", 1) or 1)
        bbox = seg.get("bbox") or {}

        left = float(bbox.get("left", 0) or 0)
        top = float(bbox.get("top", 0) or 0)
        width = float(bbox.get("width", 0) or 0)
        height = float(bbox.get("height", 0) or 0)
        base_page_w = float(bbox.get("page_width", 0) or 0)
        base_page_h = float(bbox.get("page_height", 0) or 0)

        if width <= 1 or height <= 1:
            return None

        with pdfplumber.open(str(pdf_path)) as pdf:
            if page_num < 1 or page_num > len(pdf.pages):
                return None

            page = pdf.pages[page_num - 1]
            page_image = page.to_image(resolution=180)
            pil = page_image.original

            if base_page_w > 0 and base_page_h > 0:
                sx = pil.width / base_page_w
                sy = pil.height / base_page_h
            else:
                sx = pil.width / float(page.width or pil.width)
                sy = pil.height / float(page.height or pil.height)

            x1 = int(max(0, left * sx))
            y1 = int(max(0, top * sy))
            x2 = int(min(pil.width, (left + width) * sx))
            y2 = int(min(pil.height, (top + height) * sy))

            pad = 8
            x1 = max(0, x1 - pad)
            y1 = max(0, y1 - pad)
            x2 = min(pil.width, x2 + pad)
            y2 = min(pil.height, y2 + pad)

            if x2 - x1 < 4 or y2 - y1 < 4:
                return None

            crop = pil.crop((x1, y1, x2, y2))
            buf = io.BytesIO()
            crop.save(buf, format="PNG")
            return buf.getvalue()
    except Exception:
        return None

async def _convert_source_to_pdf_bytes(source_path: Path, mime_type: Optional[str], original_filename: str) -> tuple[bytes, bool]:
    timeout = httpx.Timeout(
        connect=10.0,
        read=settings.conversion_timeout,
        write=300.0,
        pool=10.0,
    )

    safe_suffix = source_path.suffix or Path(original_filename).suffix or ".bin"
    safe_filename = f"document{safe_suffix}"
    content_type = str(mime_type or "application/octet-stream")

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            with open(source_path, "rb") as handle:
                files = {"file": (safe_filename, handle, content_type)}
                response = await client.post(f"{settings.converter_url}/convert", files=files)

        if response.status_code != 200:
            raise HTTPException(
                status_code=502,
                detail={
                    "error_code": "FILES_CONVERSION_FAILED",
                    "message": "문서 뷰어용 PDF 변환에 실패했습니다.",
                },
            )

        fallback_used = response.headers.get("X-Fallback-Used", "false").strip().lower() == "true"
        return response.content, fallback_used
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504,
            detail={
                "error_code": "FILES_CONVERSION_TIMEOUT",
                "message": "문서 뷰어용 PDF 변환 시간이 초과되었습니다.",
            },
        )
    except (httpx.ConnectError, httpx.NetworkError, OSError):
        raise HTTPException(
            status_code=503,
            detail={
                "error_code": "FILES_CONVERSION_SERVICE_UNAVAILABLE",
                "message": "문서 변환 서비스에 연결할 수 없습니다.",
            },
        )


def _sanitize_filename(raw: str) -> str:
    """파일명을 표시용으로 정리 (서버 저장명은 UUID 기반이므로 보안 무관)"""
    name = raw.strip()
    name = _UNSAFE_FILENAME_RE.sub('_', name)
    name = _MULTI_SPACE_RE.sub(' ', name)
    # 경로 구분자 제거 (directory traversal 방지)
    name = name.replace('..', '_')
    # 최대 길이 제한
    if len(name) > 255:
        stem = Path(name).stem[:200]
        ext = Path(name).suffix
        name = stem + ext
    return name or "unnamed"


def _sanitize_asset_slug(original_filename: str) -> str:
    stem = Path((original_filename or "").strip()).stem.lower()
    ascii_stem = stem.encode("ascii", "ignore").decode("ascii")
    slug = _ASSET_SLUG_RE.sub("-", ascii_stem).strip("-")
    return slug or "pasted-image"


def _normalize_authored_asset_mime(content_type: Optional[str]) -> str:
    return (content_type or "").lower().split(";")[0].strip()


def _is_allowed_authored_asset_mime(content_type: Optional[str]) -> bool:
    return _normalize_authored_asset_mime(content_type) in ALLOWED_AUTHORED_ASSET_MIMES


def _is_invalid_authored_asset_name(asset_name: str) -> bool:
    lowered = (asset_name or "").lower()
    return (
        ".." in asset_name
        or "/" in asset_name
        or "\\" in asset_name
        or "%2e" in lowered
        or "%2f" in lowered
        or "%5c" in lowered
    )


def _generate_asset_name(original_filename: str) -> str:
    slug = _sanitize_asset_slug(original_filename)
    timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    short_id = uuid.uuid4().hex[:8]
    ext = Path((original_filename or "").strip()).suffix.lower()
    if not ext or not re.fullmatch(r"\.[a-z0-9]+", ext):
        ext = ".bin"
    return f"{slug}-{timestamp}-{short_id}{ext}"


def _get_database_root() -> Path:
    return Path(settings.db_path).resolve().parent


def _get_user_drafts_root(user_id: int) -> Path:
    return _get_database_root() / DRAFTS_ROOT_DIRNAME / "users" / str(user_id)


def _get_user_my_documents_root(user_id: int) -> Path:
    return _get_database_root() / "myfiles" / "users" / str(user_id)


def _get_my_document_dir(user_id: int, file_id: str) -> Path:
    return _get_user_my_documents_root(user_id) / str(file_id)


def _resolve_my_document_dir(file_obj: PDFFile, user_id: int, file_id: str) -> Path:
    raw_path = getattr(file_obj, "file_path", None)
    if raw_path:
        candidate = Path(raw_path)
        if candidate.suffix:
            return candidate.parent
        return candidate
    return _get_my_document_dir(user_id, file_id)


def _get_authored_markdown_path(file_dir: Path) -> Path:
    return file_dir / "source.md"


def _get_authored_assets_dir(file_dir: Path) -> Path:
    return file_dir / "assets"


def _get_legacy_authored_assets_dir(file_dir: Path) -> Path:
    return file_dir / "authored" / "assets"


def _build_authored_zip_download_name(file_dir: Path) -> str:
    return f"{file_dir.name}.zip"


def _build_authored_folder_zip_bytes(file_dir: Path) -> bytes:
    archive_buffer = io.BytesIO()
    root_dir_name = file_dir.name

    with zipfile.ZipFile(archive_buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(file_dir.rglob("*")):
            if not path.is_file():
                continue
            relative_path = path.relative_to(file_dir)
            archive.write(path, arcname=str(Path(root_dir_name) / relative_path))

    archive_buffer.seek(0)
    return archive_buffer.getvalue()


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp_path.write_text(content, encoding="utf-8")
    tmp_path.replace(path)


def _extract_authored_asset_names(markdown: str) -> set[str]:
    asset_names: set[str] = set()
    for match in _AUTHORED_ASSET_REF_RE.finditer(markdown or ""):
        asset_name = match.group(1)
        if asset_name and not _is_invalid_authored_asset_name(asset_name):
            asset_names.add(asset_name)
    return asset_names


def _normalize_authored_asset_markdown(markdown: str) -> str:
    if not markdown:
        return ""

    normalized = re.sub(
        r"https?://[^\s\)\"']+/assets/([A-Za-z0-9][A-Za-z0-9._-]*)",
        r"./assets/\1",
        markdown,
    )
    normalized = re.sub(
        r"(?<!\.)/assets/([A-Za-z0-9][A-Za-z0-9._-]*)",
        r"./assets/\1",
        normalized,
    )
    return normalized


def _cleanup_empty_authored_legacy_dir(file_dir: Path) -> None:
    legacy_assets_dir = _get_legacy_authored_assets_dir(file_dir)
    legacy_root = legacy_assets_dir.parent
    if legacy_assets_dir.exists() and not any(legacy_assets_dir.iterdir()):
        legacy_assets_dir.rmdir()
    if legacy_root.exists() and not any(legacy_root.iterdir()):
        legacy_root.rmdir()


def _migrate_legacy_authored_assets(file_dir: Path) -> None:
    legacy_assets_dir = _get_legacy_authored_assets_dir(file_dir)
    if not legacy_assets_dir.exists() or not legacy_assets_dir.is_dir():
        return

    target_assets_dir = _get_authored_assets_dir(file_dir)
    target_assets_dir.mkdir(parents=True, exist_ok=True)

    for asset_path in legacy_assets_dir.iterdir():
        if not asset_path.is_file():
            continue
        target_path = target_assets_dir / asset_path.name
        if target_path.exists():
            target_path = target_assets_dir / f"{asset_path.stem}-{uuid.uuid4().hex[:8]}{asset_path.suffix}"
        shutil.move(str(asset_path), str(target_path))

    _cleanup_empty_authored_legacy_dir(file_dir)


def _sync_authored_assets(file_dir: Path, markdown: str) -> dict[str, Any]:
    _migrate_legacy_authored_assets(file_dir)

    assets_dir = _get_authored_assets_dir(file_dir)
    if not assets_dir.exists() or not assets_dir.is_dir():
        return {"deleted_assets": [], "referenced_assets": sorted(_extract_authored_asset_names(markdown))}

    referenced_assets = _extract_authored_asset_names(markdown)
    deleted_assets: list[str] = []
    for asset_path in list(assets_dir.iterdir()):
        if not asset_path.is_file():
            continue
        if asset_path.name in referenced_assets:
            continue
        asset_path.unlink(missing_ok=True)
        deleted_assets.append(asset_path.name)

    if not any(assets_dir.iterdir()):
        assets_dir.rmdir()

    return {
        "deleted_assets": sorted(deleted_assets),
        "referenced_assets": sorted(referenced_assets),
    }


def _normalize_draft_id(raw_draft_id: str) -> str:
    try:
        return str(uuid.UUID(str(raw_draft_id)))
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "DRAFT_INVALID_ID", "message": "잘못된 draft ID입니다."},
        ) from exc


def _get_draft_dir(user_id: int, draft_id: str, *, ensure_exists: bool = False) -> Path:
    normalized = _normalize_draft_id(draft_id)
    draft_dir = _get_user_drafts_root(user_id) / normalized
    if ensure_exists and not draft_dir.exists():
        raise HTTPException(
            status_code=404,
            detail={"error_code": "DRAFT_NOT_FOUND", "message": "draft를 찾을 수 없습니다."},
        )
    return draft_dir


def _build_authored_create_response(file_obj: PDFFile) -> dict[str, Any]:
    return {
        'file_id': file_obj.id,
        'filename': file_obj.filename,
        'file_size': file_obj.file_size,
        'status': FileStatus.STORED.value,
        'domain': FILE_DOMAIN_MY_DOCUMENTS,
        'origin': 'authored',
        'message': 'Document created'
    }


def _create_authored_document_record(*, db: Session, current_user: User, content: str, display_name: str) -> PDFFile:
    new_id = str(uuid.uuid4())
    file_dir = _get_my_document_dir(current_user.id, new_id)
    file_dir.mkdir(parents=True, exist_ok=True)

    normalized_content = _normalize_authored_asset_markdown(content)
    md_path = _get_authored_markdown_path(file_dir)
    _atomic_write_text(md_path, normalized_content)

    new_file = PDFFile(
        id=new_id,
        user_id=current_user.id,
        original_filename=display_name,
        filename=display_name,
        file_path=str(file_dir),
        file_size=len(normalized_content.encode('utf-8')),
        mime_type='text/markdown',
        status=FileStatus.STORED,
        total_pages=0,
        origin='authored',
        domain=FileDomain.MY_DOCUMENTS,
    )
    db.add(new_file)
    db.commit()
    db.refresh(new_file)
    return new_file


async def _store_authored_image_asset(file: UploadFile, assets_dir: Path) -> dict[str, Any]:
    mime_type = _normalize_authored_asset_mime(file.content_type)
    if not _is_allowed_authored_asset_mime(mime_type):
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": "AUTHORED_ASSET_INVALID_MIME",
                "message": "이미지 파일만 업로드할 수 있습니다.",
                "allowed_mimes": sorted(ALLOWED_AUTHORED_ASSET_MIMES),
            }
        )

    ext = MIME_TO_EXT[mime_type]
    original_name = (file.filename or "pasted-image").strip()
    filename_with_mapped_ext = f"{Path(original_name).stem or 'pasted-image'}{ext}"
    asset_name = _generate_asset_name(filename_with_mapped_ext)

    assets_dir.mkdir(parents=True, exist_ok=True)
    asset_path = assets_dir / asset_name

    total_size = 0
    chunk_size = 1024 * 1024
    try:
        with open(asset_path, "wb") as out:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                out.write(chunk)
                total_size += len(chunk)
                if total_size > MAX_AUTHORED_ASSET_SIZE_BYTES:
                    raise HTTPException(
                        status_code=413,
                        detail={
                            "error_code": "AUTHORED_ASSET_TOO_LARGE",
                            "message": "이미지 파일 크기가 5MB를 초과합니다.",
                        }
                    )
    except HTTPException:
        try:
            asset_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise

    return {
        "asset_name": asset_name,
        "markdown": f"![image](./assets/{asset_name})",
        "size": total_size,
        "mime_type": mime_type,
    }


def _cleanup_user_drafts(user_id: int) -> int:
    drafts_root = _get_user_drafts_root(user_id)
    if not drafts_root.exists():
        return 0

    deleted_count = sum(1 for entry in drafts_root.iterdir() if entry.is_dir())
    shutil.rmtree(drafts_root, ignore_errors=True)
    return deleted_count


def _assert_kb_capacity(
    db: Session,
    user_id: int,
    knowledge_db_id: int,
    incoming: int = 1,
) -> None:
    """
    DOREA-XP 정책: 지식DB(일반문서)에 보관 가능한 문서 최대치는 10개.
    incoming(이번 호출에서 추가할 파일 수)을 더한 결과가 한도를 넘으면 거절.
    upload 와 move-to-KB (promote_my_document_to_analysis) 양쪽에서 사용.
    """
    from config import settings as _xp_settings
    current_count = db.query(PDFFile).filter(
        PDFFile.user_id == user_id,
        PDFFile.knowledge_db_id == knowledge_db_id,
    ).count()
    max_docs = _xp_settings.knowledge_db_max_documents
    if current_count + incoming > max_docs:
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "KB_LIMIT_REACHED",
                "message": (
                    f"지식DB는 최대 {max_docs}개 문서까지 보관할 수 있습니다. "
                    f"현재 {current_count}개, 추가 시도 {incoming}개 → 한도 초과."
                ),
                "current_count": current_count,
                "max_documents": max_docs,
                "incoming": incoming,
            },
        )


def _validate_upload(
    file: UploadFile,
    request: Request,
    user_id: int,
    db: Session,
    enforce_queue_limit: bool = True,
):
    """
    업로드 사전 검증 (enqueue 전에 실행).
    실패 시 HTTPException raise.
    """
    request_id = getattr(getattr(request, "state", None), "request_id", None)
    filename = getattr(file, "filename", None) or "unknown"

    # 1. 파일명 존재 확인
    if not filename or filename.strip() == "":
        print(f"[UploadReject] request_id={request_id} user_id={user_id} reason=EMPTY_FILENAME")
        raise HTTPException(
            status_code=400,
            detail={"error_code": "FILES_INVALID_FILENAME", "message": "파일 이름이 비어있습니다."}
        )

    # 2. 확장자 allowlist 검증
    ext = Path(filename).suffix.lower()
    if not ext or ext not in ALLOWED_EXTENSIONS:
        allowed_list = ", ".join(sorted(ALLOWED_EXTENSIONS.keys()))
        print(f"[UploadReject] request_id={request_id} user_id={user_id} filename={filename} ext={ext} reason=INVALID_EXTENSION")
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": "FILES_INVALID_EXTENSION",
                "message": f"지원하지 않는 파일 형식입니다: {ext}",
                "allowed_extensions": sorted(ALLOWED_EXTENSIONS.keys()),
            }
        )

    # 3. MIME 일관성 검증 (클라이언트가 보낸 Content-Type과 확장자 매핑 비교)
    content_type = (file.content_type or "application/octet-stream").lower().split(";")[0].strip()
    expected_mimes = ALLOWED_EXTENSIONS[ext]
    # application/octet-stream은 브라우저가 모르는 타입일 때 보내므로 허용
    if content_type != "application/octet-stream" and content_type not in expected_mimes:
        print(f"[UploadReject] request_id={request_id} user_id={user_id} filename={filename} "
              f"mime={content_type} expected={expected_mimes} reason=MIME_MISMATCH")
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": "FILES_MIME_MISMATCH",
                "message": f"파일 확장자({ext})와 MIME 타입({content_type})이 일치하지 않습니다.",
            }
        )

    if enforce_queue_limit:
        queued_count = db.query(PDFFile).filter(
            PDFFile.user_id == user_id,
            PDFFile.status.in_([FileStatus.QUEUED, FileStatus.CONVERTING, FileStatus.ANALYZING])
        ).count()
        if queued_count >= MAX_QUEUED_FILES_PER_USER:
            print(f"[UploadReject] request_id={request_id} user_id={user_id} queued={queued_count} reason=TOO_MANY_QUEUED")
            raise HTTPException(
                status_code=429,
                detail={
                    "error_code": "FILES_TOO_MANY_QUEUED",
                    "message": f"처리 대기 중인 파일이 너무 많습니다 (최대 {MAX_QUEUED_FILES_PER_USER}개). 기존 파일 처리 완료 후 다시 시도해주세요.",
                }
            )


@router.post("/upload", response_model=FileUploadResponse)
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    knowledge_db_id: Optional[int] = Form(None),
    analysis_provider: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    파일 업로드 (PDF 및 기타 문서 지원)
    업로드 완료 후 자동으로 변환/분석 시작
    
    업로드 정책:
    - 최대 파일 크기: 100MB
    - 허용 확장자: PDF, Office, HWP, ODF, 이미지 등
    - MIME 타입 일관성 검증
    - 사용자당 동시 처리 대기 최대 100개
    """
    try:
        # ========== 사전 검증 (enqueue 전) ==========
        _validate_upload(file, request, current_user.id, db)

        # DOREA-XP 정책: 일반문서(KB) 최대 10건. KB 미지정이면 기본 KB로 자동 매핑되니
        # 항상 이 시점에 cap 체크 (저장소 my-documents 경로는 별도, 여기는 분석/KB 업로드만)
        effective_kb_id = knowledge_db_id
        if effective_kb_id is None:
            from models.database import KnowledgeDB as _KB
            default_kb = db.query(_KB).filter(
                _KB.user_id == current_user.id,
                _KB.name == "일반문서",
            ).first()
            if default_kb:
                effective_kb_id = default_kb.id
        if effective_kb_id is not None:
            _assert_kb_capacity(db, current_user.id, effective_kb_id, incoming=1)

        raw_filename = file.filename or "unnamed"
        sanitized_filename = _sanitize_filename(raw_filename)

        # 파일 ID 생성
        file_id = str(uuid.uuid4())
        
        # 사용자 파일 디렉토리 생성
        user_dir = Path(f"/app/DATABASE/files/users/{current_user.id}/{file_id}")
        user_dir.mkdir(parents=True, exist_ok=True)
        
        # 파일 저장 (source.{ext} 형식) - streaming 저장으로 메모리 안정화
        ext = Path(sanitized_filename).suffix or ".bin"
        source_path = user_dir / f"source{ext}"
        file_size = 0
        chunk_size = 1024 * 1024  # 1MB chunks
        request_id = getattr(getattr(request, "state", None), "request_id", None)
        
        with open(source_path, 'wb') as f:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                file_size += len(chunk)
                
                # 스트리밍 중 크기 초과 검사 (조기 중단)
                if file_size > MAX_UPLOAD_SIZE_BYTES:
                    # 이미 쓴 파일 정리
                    try:
                        source_path.unlink(missing_ok=True)
                        user_dir.rmdir()
                    except Exception:
                        pass
                    max_mb = MAX_UPLOAD_SIZE_BYTES // (1024 * 1024)
                    print(f"[UploadReject] request_id={request_id} user_id={current_user.id} "
                          f"filename={sanitized_filename} size>{max_mb}MB reason=TOO_LARGE")
                    raise HTTPException(
                        status_code=413,
                        detail={
                            "error_code": "FILES_TOO_LARGE",
                            "message": f"파일 크기가 {max_mb}MB를 초과합니다.",
                        }
                    )
        
        # 지식DB 결정: 지정된 KB가 있으면 검증, 없으면 default KB 자동 할당
        if knowledge_db_id is not None:
            kb = db.query(KnowledgeDB).filter(
                KnowledgeDB.id == knowledge_db_id,
                KnowledgeDB.user_id == current_user.id,
            ).first()
            if not kb:
                raise HTTPException(
                    status_code=404,
                    detail={"error_code": "KB_NOT_FOUND", "message": "지정된 지식DB를 찾을 수 없습니다"},
                )
        else:
            kb = get_or_create_default_kb(db, current_user.id)
            knowledge_db_id = kb.id

        resolved_analysis_provider = _resolve_analysis_provider(db, analysis_provider)
        
        # DB에 파일 정보 저장
        new_file = PDFFile(
            id=file_id,
            user_id=current_user.id,
            original_filename=sanitized_filename,
            filename=sanitized_filename,
            file_path=str(source_path),
            file_size=file_size,
            mime_type=file.content_type or "application/octet-stream",
            status=FileStatus.QUEUED,
            enqueued_at=datetime.utcnow(),
            knowledge_db_id=knowledge_db_id,
            analysis_provider=resolved_analysis_provider,
            domain=FileDomain.ANALYSIS,
        )
        db.add(new_file)
        db.commit()
        
        # 전역 처리 큐에 등록 (라운드로빈)
        queue_position = await processing_queue.enqueue(file_id, current_user.id, resolved_analysis_provider)
        eta_seconds = queue_position * processing_queue.get_avg_processing_time()
        
        return FileUploadResponse(
            file_id=file_id,
            filename=sanitized_filename,
            file_size=new_file.file_size,
            status=new_file.status,
            queue_position=queue_position,
            eta_seconds=eta_seconds
        )
        
    except HTTPException:
        raise  # 검증 에러는 그대로 전파
    except Exception as e:
        request_id = getattr(getattr(request, "state", None), "request_id", None)
        print(f"[UploadError] request_id={request_id} filename={getattr(file, 'filename', None)} error={e}")
        try:
            traceback.print_exception(type(e), e, e.__traceback__)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail={"error_code": "FILES_UPLOAD_FAILED", "message": "파일 업로드에 실패했습니다"})


@router.post("/my-documents/upload", response_model=FileUploadResponse)
async def upload_my_document(
    request: Request,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    try:
        _validate_upload(file, request, current_user.id, db, enforce_queue_limit=False)

        raw_filename = file.filename or "unnamed"
        sanitized_filename = _sanitize_filename(raw_filename)

        file_id = str(uuid.uuid4())
        user_dir = Path(f"/app/DATABASE/myfiles/users/{current_user.id}/{file_id}")
        user_dir.mkdir(parents=True, exist_ok=True)

        ext = Path(sanitized_filename).suffix or ".bin"
        source_path = user_dir / f"source{ext}"
        file_size = 0
        chunk_size = 1024 * 1024
        request_id = getattr(getattr(request, "state", None), "request_id", None)

        with open(source_path, "wb") as f:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
                file_size += len(chunk)

                if file_size > MAX_UPLOAD_SIZE_BYTES:
                    try:
                        source_path.unlink(missing_ok=True)
                        user_dir.rmdir()
                    except Exception:
                        pass
                    max_mb = MAX_UPLOAD_SIZE_BYTES // (1024 * 1024)
                    print(f"[MyDocsUploadReject] request_id={request_id} user_id={current_user.id} "
                          f"filename={sanitized_filename} size>{max_mb}MB reason=TOO_LARGE")
                    raise HTTPException(
                        status_code=413,
                        detail={
                            "error_code": "FILES_TOO_LARGE",
                            "message": f"파일 크기가 {max_mb}MB를 초과합니다.",
                        }
                    )

        new_file = PDFFile(
            id=file_id,
            user_id=current_user.id,
            original_filename=sanitized_filename,
            filename=sanitized_filename,
            file_path=str(source_path),
            file_size=file_size,
            mime_type=file.content_type or "application/octet-stream",
            status=FileStatus.STORED,
            domain=FileDomain.MY_DOCUMENTS,
        )
        db.add(new_file)
        db.commit()

        await _maybe_prebuild_my_document_preview(
            source_path=source_path,
            mime_type=new_file.mime_type,
            original_filename=sanitized_filename,
        )

        return FileUploadResponse(
            file_id=file_id,
            filename=sanitized_filename,
            file_size=new_file.file_size,
            status=FileStatus.STORED,
            queue_position=None,
            eta_seconds=None,
        )

    except HTTPException:
        raise
    except Exception as e:
        request_id = getattr(getattr(request, "state", None), "request_id", None)
        print(f"[MyDocsUploadError] request_id={request_id} filename={getattr(file, 'filename', None)} error={e}")
        try:
            traceback.print_exception(type(e), e, e.__traceback__)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail={"error_code": "FILES_UPLOAD_FAILED", "message": "파일 업로드에 실패했습니다"})


@router.get("/my-documents/", response_model=ContractFileListResponse)
async def list_my_documents(
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    files = db.query(PDFFile).filter(
        PDFFile.user_id == current_user.id,
        PDFFile.domain == FileDomain.MY_DOCUMENTS,
    ).order_by(PDFFile.uploaded_at.desc()).offset(skip).limit(limit).all()

    file_responses = []
    for f in files:
        resolved_domain = _normalize_file_domain(getattr(f, "domain", None))
        resolved_status = _normalize_file_status(f, resolved_domain)
        file_responses.append(_build_contract_file_response(f, resolved_domain=resolved_domain, resolved_status=resolved_status))

    total = db.query(PDFFile).filter(
        PDFFile.user_id == current_user.id,
        PDFFile.domain == FileDomain.MY_DOCUMENTS,
    ).count()

    return ContractFileListResponse(files=file_responses, total=total, queue_stats=None)


@router.get("/my-documents/{file_id}", response_model=ContractFileResponse)
async def get_my_document(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
        PDFFile.domain == FileDomain.MY_DOCUMENTS,
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    resolved_domain = _normalize_file_domain(getattr(file, "domain", None))
    resolved_status = _normalize_file_status(file, resolved_domain)

    return _build_contract_file_response(file, resolved_domain=resolved_domain, resolved_status=resolved_status)


@router.delete("/my-documents/{file_id}")
async def delete_my_document(
    file_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
        PDFFile.domain == FileDomain.MY_DOCUMENTS,
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    linked_session_ids = set(
        s.id for s in db.query(ChatSession).filter(ChatSession.file_id == file_id).all()
    )
    segment_ref_session_ids = _get_sessions_referencing_file_segments(db, file_id)

    user_session_ids = set(
        s.id for s in db.query(ChatSession).filter(ChatSession.user_id == current_user.id).all()
    )
    segment_ref_session_ids = segment_ref_session_ids & user_session_ids
    sessions_to_delete_manually = segment_ref_session_ids - linked_session_ids
    total_sessions_to_delete = len(linked_session_ids | segment_ref_session_ids)

    source_path = _resolve_my_document_source_path(file, current_user.id, file_id)
    file_dir = source_path.parent if source_path else Path(f"/app/DATABASE/myfiles/users/{current_user.id}/{file_id}")
    if file_dir.exists():
        try:
            shutil.rmtree(file_dir)
        except Exception as e:
            request_id = getattr(getattr(request, "state", None), "request_id", None)
            print(f"[DeleteMyDocumentError] request_id={request_id} file_id={file_id} folder_delete_failed={e}")
            raise HTTPException(
                status_code=500,
                detail={"error_code": "FILES_DELETE_FOLDER_FAILED", "message": "파일 폴더 삭제에 실패했습니다. 다시 시도해주세요."},
            )

    if sessions_to_delete_manually:
        sessions_to_delete = db.query(ChatSession).filter(ChatSession.id.in_(sessions_to_delete_manually)).all()
        for session in sessions_to_delete:
            db.delete(session)

    db.delete(file)
    db.commit()

    return {
        "message": "내 문서가 삭제되었습니다",
        "deleted_sessions": total_sessions_to_delete,
    }


@router.get("/my-documents/{file_id}/document.pdf")
async def get_my_document_pdf(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
        PDFFile.domain == FileDomain.MY_DOCUMENTS,
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    filename_stem = Path(file.original_filename).stem

    pdf_path = await _resolve_my_document_pdf_path(file, current_user.id, file_id)
    return FastAPIFileResponse(
        path=str(pdf_path),
        media_type="application/pdf",
        filename=f"{filename_stem}.pdf",
    )


@router.get("/my-documents/{file_id}/viewer-profile")
async def get_my_document_viewer_profile(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
        PDFFile.domain == FileDomain.MY_DOCUMENTS,
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    pdf_path = await _resolve_my_document_pdf_path(file, current_user.id, file_id)
    return _build_pdf_viewer_profile(pdf_path)


@router.get("/my-documents/{file_id}/pages/{page_num}/preview")
async def get_my_document_page_preview(
    file_id: str,
    page_num: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
        PDFFile.domain == FileDomain.MY_DOCUMENTS,
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    pdf_path = await _resolve_my_document_pdf_path(file, current_user.id, file_id)
    png_bytes = _render_pdf_page_png_bytes(pdf_path, page_num)
    if not png_bytes:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_PAGE_PREVIEW_NOT_AVAILABLE", "message": "페이지 미리보기를 생성할 수 없습니다"})

    return FastAPIResponse(content=png_bytes, media_type="image/png")


@router.get("/my-documents/{file_id}/download")
async def download_my_document_original(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
        PDFFile.domain == FileDomain.MY_DOCUMENTS,
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    source_path = _resolve_my_document_source_path(file, current_user.id, file_id)
    if not source_path:
        raise HTTPException(
            status_code=404,
            detail={
                "error_code": "FILES_SOURCE_NOT_FOUND",
                "message": "원본 문서를 찾을 수 없습니다.",
            },
        )

    file_dir = _resolve_my_document_dir(file, current_user.id, file_id)
    if getattr(file, "origin", None) == "authored" and source_path.name == "source.md" and file_dir.exists():
        zip_bytes = _build_authored_folder_zip_bytes(file_dir)
        download_name = _build_authored_zip_download_name(file_dir)
        return StreamingResponse(
            io.BytesIO(zip_bytes),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
        )

    media_type = str(getattr(file, "mime_type", None) or "application/octet-stream")
    return FastAPIFileResponse(
        path=str(source_path),
        media_type=media_type,
        filename=file.original_filename,
    )


@router.post("/my-documents/{file_id}/analyze")
async def promote_my_document_to_analysis(
    file_id: str,
    request: Request,
    payload: Optional[PromoteMyDocumentRequest] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    resolved_domain = _normalize_file_domain(getattr(file, "domain", None))
    if resolved_domain != FILE_DOMAIN_MY_DOCUMENTS:
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": "FILES_WRONG_DOMAIN",
                "message": "my_documents 도메인 파일만 문서분석으로 이동할 수 있습니다.",
            },
        )

    queued_count = db.query(PDFFile).filter(
        PDFFile.user_id == current_user.id,
        PDFFile.status.in_([FileStatus.QUEUED, FileStatus.CONVERTING, FileStatus.ANALYZING])
    ).count()
    if queued_count >= MAX_QUEUED_FILES_PER_USER:
        request_id = getattr(getattr(request, "state", None), "request_id", None)
        print(f"[PromoteReject] request_id={request_id} user_id={current_user.id} queued={queued_count} reason=TOO_MANY_QUEUED")
        raise HTTPException(
            status_code=429,
            detail={
                "error_code": "FILES_TOO_MANY_QUEUED",
                "message": f"처리 대기 중인 파일이 너무 많습니다 (최대 {MAX_QUEUED_FILES_PER_USER}개). 기존 파일 처리 완료 후 다시 시도해주세요.",
            }
        )

    knowledge_db_id = payload.knowledge_db_id if payload else None
    if knowledge_db_id is not None:
        kb = db.query(KnowledgeDB).filter(
            KnowledgeDB.id == knowledge_db_id,
            KnowledgeDB.user_id == current_user.id,
        ).first()
        if not kb:
            raise HTTPException(
                status_code=404,
                detail={"error_code": "KB_NOT_FOUND", "message": "지정된 지식DB를 찾을 수 없습니다"},
            )
    else:
        kb = get_or_create_default_kb(db, current_user.id)
        knowledge_db_id = kb.id

    # DOREA-XP: 지식DB 10개 cap (저장소→KB 이동 시점에도 동일하게 적용)
    _assert_kb_capacity(db, current_user.id, knowledge_db_id, incoming=1)

    source_dir = Path(f"/app/DATABASE/myfiles/users/{current_user.id}/{file_id}")
    destination_dir = Path(f"/app/DATABASE/files/users/{current_user.id}/{file_id}")

    if destination_dir.exists():
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "FILES_DESTINATION_CONFLICT",
                "message": "대상 경로에 이미 문서가 존재합니다.",
            },
        )

    if not source_dir.exists() or not source_dir.is_dir():
        raise HTTPException(
            status_code=404,
            detail={
                "error_code": "FILES_SOURCE_NOT_FOUND",
                "message": "원본 문서 경로를 찾을 수 없습니다.",
            },
        )

    destination_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source_dir), str(destination_dir))

    analysis_provider = _resolve_analysis_provider(db, payload.analysis_provider if payload else None)
    file.domain = FileDomain.ANALYSIS
    file.status = FileStatus.QUEUED
    file.knowledge_db_id = knowledge_db_id
    file.file_path = str(destination_dir)
    file.enqueued_at = datetime.utcnow()
    file.analysis_provider = analysis_provider
    db.commit()

    queue_position = await processing_queue.enqueue(file_id, current_user.id, analysis_provider)

    return {
        "file_id": file.id,
        "status": file.status.value,
        "domain": _normalize_file_domain(getattr(file, "domain", None)),
        "knowledge_db_id": file.knowledge_db_id,
        "queue_position": queue_position,
        "message": "문서분석 큐에 등록되었습니다",
    }


@router.post("/{file_id}/move-to-my-documents")
async def move_analysis_file_to_my_documents(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    resolved_domain = _normalize_file_domain(getattr(file, "domain", None))
    if resolved_domain != FILE_DOMAIN_ANALYSIS:
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": "FILES_WRONG_DOMAIN",
                "message": "analysis 도메인 파일만 내문서로 이동할 수 있습니다.",
            },
        )

    if file.status in (FileStatus.QUEUED, FileStatus.CONVERTING, FileStatus.ANALYZING):
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "FILES_STILL_PROCESSING",
                "message": "처리 중인 파일은 내문서로 이동할 수 없습니다.",
            },
        )

    source_dir = Path(f"/app/DATABASE/files/users/{current_user.id}/{file_id}")
    destination_dir = Path(f"/app/DATABASE/myfiles/users/{current_user.id}/{file_id}")

    if destination_dir.exists():
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "FILES_DESTINATION_CONFLICT",
                "message": "대상 경로에 이미 문서가 존재합니다.",
            },
        )

    if not source_dir.exists() or not source_dir.is_dir():
        raise HTTPException(
            status_code=404,
            detail={
                "error_code": "FILES_SOURCE_NOT_FOUND",
                "message": "원본 문서 경로를 찾을 수 없습니다.",
            },
        )

    destination_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source_dir), str(destination_dir))

    cleanup_errors = []
    for target in ["document.pdf", "document.ocr.pdf", "document.preocr.pdf"]:
        target_path = destination_dir / target
        if target_path.exists():
            try:
                target_path.unlink()
            except Exception as e:
                cleanup_errors.append(f"{target}: {e}")

    analysis_dir = destination_dir / "analysis"
    if analysis_dir.exists():
        try:
            shutil.rmtree(analysis_dir)
        except Exception as e:
            cleanup_errors.append(f"analysis/: {e}")

    for marker in ["base-opendataloader.txt"]:
        marker_path = destination_dir / marker
        if marker_path.exists():
            try:
                marker_path.unlink()
            except Exception as e:
                cleanup_errors.append(f"{marker}: {e}")

    if cleanup_errors:
        rollback_errors = []
        try:
            source_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(destination_dir), str(source_dir))
        except Exception as rollback_err:
            rollback_errors.append(str(rollback_err))

        detail_msg = "; ".join(cleanup_errors)
        rollback_msg = "; ".join(rollback_errors)
        print(f"[MoveToMyDocuments] Cleanup failed for {file_id}: {detail_msg}; rollback={rollback_msg or 'ok'}")
        raise HTTPException(
            status_code=500,
            detail={
                "error_code": "FILES_CLEANUP_FAILED",
                "message": f"분석 산출물 삭제에 실패했습니다: {detail_msg}",
            },
        )

    kb_name = f"kb{file.knowledge_db_id}" if file.knowledge_db_id else "default"
    try:
        from services.rag_indexer import delete_file_chunks
        delete_file_chunks(file_id=file_id, user_id=current_user.id, knowledge_db=kb_name, db=db)
    except Exception as rag_err:
        print(f"[MoveToMyDocuments] RAG chunk cleanup failed (non-blocking): {rag_err}")

    db.query(FileEmbedding).filter(FileEmbedding.file_id == file_id).delete()

    file.domain = FileDomain.MY_DOCUMENTS
    file.status = FileStatus.STORED
    file.knowledge_db_id = None
    file.file_path = str(destination_dir)
    file.segments_data = None
    file.total_pages = 0
    file.error_code = None
    file.error_message = None
    file.converted_at = None
    file.analyzed_at = None
    file.enqueued_at = None
    file.processing_started_at = None
    file.processing_completed_at = None
    file.processing_duration_seconds = None
    file.processing_uses_gpu = None
    file.embedding_status = "none"
    file.embedding_chunks = 0
    file.embedding_model = None
    file.embedding_total_chunks = 0
    file.embedding_processed_chunks = 0
    file.embedding_at = None
    file.content_version = None
    db.commit()

    return {
        "file_id": file.id,
        "status": file.status.value,
        "domain": _normalize_file_domain(getattr(file, "domain", None)),
        "message": "문서가 내문서로 이동되었습니다",
    }


@router.post("/{file_id}/cancel-analysis")
async def cancel_analysis_file(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    _ensure_analysis_domain(file)

    if file.status != FileStatus.ANALYZING:
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "FILES_NOT_ANALYZING",
                "message": "분석 중인 파일만 중단할 수 있습니다.",
            },
        )

    cancel_result = await processing_queue.cancel(file_id)

    file_dir = Path(f"/app/DATABASE/files/users/{current_user.id}/{file_id}")
    cleanup_errors = _cleanup_analysis_generated_files(file_dir)
    if cleanup_errors:
        detail_msg = "; ".join(cleanup_errors)
        print(f"[CancelAnalysis] Cleanup failed for {file_id}: {detail_msg}")
        raise HTTPException(
            status_code=500,
            detail={
                "error_code": "FILES_CLEANUP_FAILED",
                "message": f"분석 산출물 삭제에 실패했습니다: {detail_msg}",
            },
        )

    kb_name = f"kb{file.knowledge_db_id}" if file.knowledge_db_id else "default"
    try:
        from services.rag_indexer import delete_file_chunks
        delete_file_chunks(file_id=file_id, user_id=current_user.id, knowledge_db=kb_name, db=db)
    except Exception as rag_err:
        print(f"[CancelAnalysis] RAG chunk cleanup failed (non-blocking): {rag_err}")

    db.query(FileEmbedding).filter(FileEmbedding.file_id == file_id).delete()
    _preserve_processing_history_for_terminal_state(file)
    _reset_analysis_file_state(
        file,
        error_code="FILES_ANALYSIS_CANCELLED",
        error_message="사용자 요청으로 문서분석이 중단되었습니다.",
        clear_processing_history=False,
    )
    db.commit()

    return {
        "file_id": file.id,
        "status": file.status.value,
        "domain": _normalize_file_domain(getattr(file, "domain", None)),
        "message": "문서분석이 중단되고 초기화되었습니다",
        "cancel_result": cancel_result,
    }


@router.get("/", response_model=ContractFileListResponse)
async def list_files(
    skip: int = 0,
    limit: int = 50,
    knowledge_db_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    파일 목록 조회 (큐 position/ETA 포함)
    """
    base_query = db.query(PDFFile).filter(
        PDFFile.user_id == current_user.id,
        or_(PDFFile.domain == FileDomain.ANALYSIS, PDFFile.domain.is_(None))
    )

    if knowledge_db_id is not None:
        base_query = base_query.filter(PDFFile.knowledge_db_id == knowledge_db_id)

    files = base_query.order_by(PDFFile.uploaded_at.desc()).offset(skip).limit(limit).all()
    
    # 현재 큐 상태 조회 (position 계산용)
    all_positions = await processing_queue.get_all_positions()
    position_map = {fid: pos for fid, uid, pos in all_positions}
    avg_time = processing_queue.get_avg_processing_time()
    
    file_responses = []
    for f in files:
        resolved_domain = _normalize_file_domain(getattr(f, "domain", None))
        resolved_status = _normalize_file_status(f, resolved_domain)

        # 큐 position/ETA 계산
        queue_position = None
        eta_seconds = None

        if resolved_status in [FileStatus.QUEUED, FileStatus.CONVERTING, FileStatus.ANALYZING]:
            pos = position_map.get(f.id, 0)
            if pos > 0:
                queue_position = pos
                eta_seconds = pos * avg_time
            elif resolved_status in [FileStatus.CONVERTING, FileStatus.ANALYZING]:
                # 현재 처리 중 (큐에서 빠졌지만 아직 완료 안 됨)
                queue_position = 0
                eta_seconds = avg_time * 0.5  # 대략 절반 남음으로 추정

        file_responses.append(
            _build_contract_file_response(
                f,
                resolved_domain=resolved_domain,
                resolved_status=resolved_status,
                queue_position=queue_position,
                eta_seconds=eta_seconds,
            )
        )
    
    total = base_query.count()
    queue_stats = await processing_queue.get_queue_stats()
    
    return ContractFileListResponse(files=file_responses, total=total, queue_stats=queue_stats)


# ========== Helper function for segment reference detection ==========

def _get_sessions_referencing_file_segments(db: Session, file_id: str) -> set[int]:
    """
    chat_messages.selected_segments JSON 안에 해당 file_id가 있는 세션 ID들을 반환
    """
    session_ids: set[int] = set()
    
    # 모든 메시지 조회 (NULL 체크 없이) - SQLite JSON 호환성
    all_messages = db.query(ChatMessage).all()
    messages_with_segments = [m for m in all_messages if m.selected_segments]
    
    for msg in messages_with_segments:
        segments = msg.selected_segments
        if not isinstance(segments, list):
            continue
        for seg in segments:
            if isinstance(seg, dict) and seg.get("file_id") == file_id:
                session_ids.add(msg.session_id)
                break
    return session_ids


# ========== Routes with path parameters - ORDER MATTERS! ==========
# More specific routes (/{file_id}/xxx) must come BEFORE generic routes (/{file_id})


@router.get("/{file_id}/embedding-status")
async def get_embedding_status(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    파일의 임베딩 상태 조회 (stale 여부 포함)
    
    stale 조건: 세그먼트 데이터가 변경되었지만 임베딩이 이전 버전인 경우
    """
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id
    ).first()
    
    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    _ensure_analysis_domain(file)

    # stale 판단: segments_data가 있고 content_version이 다르면 stale
    is_stale = False
    current_version = None
    if file.segments_data:
        from services.rag_indexer import _compute_content_version
        current_version = _compute_content_version(file.segments_data)
        if file.content_version and file.content_version != current_version:
            is_stale = True
        elif not file.content_version and file.embedding_status != "completed":
            is_stale = True
    
    return {
        "file_id": file_id,
        "embedding_status": file.embedding_status or "none",
        "embedding_chunks": file.embedding_chunks or 0,
        "embedding_model": file.embedding_model,
        "embedding_at": file.embedding_at.isoformat() if file.embedding_at else None,
        "content_version": file.content_version,
        "current_content_version": current_version,
        "is_stale": is_stale,
    }


@router.get("/{file_id}/delete-impact")
async def get_delete_impact(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    파일 삭제 시 영향받는 대화 세션 수 조회
    - linked_sessions_count: file_id로 직접 연결된 세션 수
    - segment_referenced_sessions_count: selected_segments에서 참조하는 세션 수 (linked 제외)
    - total_sessions_to_delete: 합계
    """
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id
    ).first()
    
    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    _ensure_analysis_domain(file)

    # 1) file_id로 직접 연결된 세션 (현재 사용자 소유만)
    linked_session_ids = set(
        s.id for s in db.query(ChatSession).filter(
            ChatSession.file_id == file_id,
            ChatSession.user_id == current_user.id
        ).all()
    )
    
    # 2) selected_segments에서 참조하는 세션 (현재 사용자 소유만)
    segment_ref_session_ids = _get_sessions_referencing_file_segments(db, file_id)
    
    # 소유권 필터링: 현재 사용자 세션만
    user_session_ids = set(
        s.id for s in db.query(ChatSession).filter(ChatSession.user_id == current_user.id).all()
    )
    segment_ref_session_ids = segment_ref_session_ids & user_session_ids
    
    # 합집합
    all_to_delete = linked_session_ids | segment_ref_session_ids
    
    return {
        "linked_sessions_count": len(linked_session_ids),
        "segment_referenced_sessions_count": len(segment_ref_session_ids - linked_session_ids),
        "total_sessions_to_delete": len(all_to_delete)
    }


@router.get("/{file_id}/document.pdf")
async def get_document_pdf(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    뷰어용 PDF 파일 스트리밍
    """
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id
    ).first()
    
    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    _ensure_analysis_domain(file)

    pdf_path = Path(f"/app/DATABASE/files/users/{current_user.id}/{file_id}/document.pdf")
    
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail={"error_code": "FILES_PDF_NOT_READY", "message": "PDF 파일이 아직 준비되지 않았습니다"})
    
    return FastAPIFileResponse(
        path=str(pdf_path),
        media_type="application/pdf",
        filename=f"{Path(file.original_filename).stem}.pdf"
    )


@router.get("/{file_id}/viewer-profile")
async def get_document_viewer_profile(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    _ensure_analysis_domain(file)

    pdf_path = Path(f"/app/DATABASE/files/users/{current_user.id}/{file_id}/document.pdf")
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail={"error_code": "FILES_PDF_NOT_READY", "message": "PDF 파일이 아직 준비되지 않았습니다"})

    return _build_pdf_viewer_profile(pdf_path)


@router.get("/{file_id}/pages/{page_num}/preview")
async def get_document_page_preview(
    file_id: str,
    page_num: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    _ensure_analysis_domain(file)

    pdf_path = Path(f"/app/DATABASE/files/users/{current_user.id}/{file_id}/document.pdf")
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail={"error_code": "FILES_PDF_NOT_READY", "message": "PDF 파일이 아직 준비되지 않았습니다"})

    png_bytes = _render_pdf_page_png_bytes(pdf_path, page_num)
    if not png_bytes:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_PAGE_PREVIEW_NOT_AVAILABLE", "message": "페이지 미리보기를 생성할 수 없습니다"})

    return FastAPIResponse(content=png_bytes, media_type="image/png")


@router.get("/{file_id}/segments")
async def get_segments(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    분석된 세그먼트 정보 조회
    """
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id
    ).first()
    
    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    _ensure_analysis_domain(file)

    # DB에 캐시된 데이터 먼저 확인
    if file.segments_data:
        return file.segments_data
    
    # 파일에서 직접 읽기
    segments_path = Path(f"/app/DATABASE/files/users/{current_user.id}/{file_id}/analysis/segments.json")
    
    if not segments_path.exists():
        raise HTTPException(status_code=404, detail={"error_code": "FILES_SEGMENTS_NOT_READY", "message": "세그먼트 분석이 아직 완료되지 않았습니다"})
    
    with open(segments_path, "r", encoding="utf-8") as f:
        return json.load(f)


@router.get("/{file_id}/segments/{segment_id}/preview")
async def get_segment_preview(
    file_id: str,
    segment_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    세그먼트 bbox 영역을 실제 이미지(PNG)로 반환.
    """
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    _ensure_analysis_domain(file)

    segments_payload = file.segments_data
    if not segments_payload:
        segments_path = Path(f"/app/DATABASE/files/users/{current_user.id}/{file_id}/analysis/segments.json")
        if not segments_path.exists():
            raise HTTPException(status_code=404, detail={"error_code": "FILES_SEGMENTS_NOT_READY", "message": "세그먼트 분석이 아직 완료되지 않았습니다"})
        with open(segments_path, "r", encoding="utf-8") as f:
            segments_payload = json.load(f)

    segments = (segments_payload or {}).get("segments", []) if isinstance(segments_payload, dict) else []
    target = next((seg for seg in segments if str(seg.get("id", "")) == segment_id), None)
    if not target:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_SEGMENT_NOT_FOUND", "message": "요청한 세그먼트를 찾을 수 없습니다"})

    pdf_path = Path(f"/app/DATABASE/files/users/{current_user.id}/{file_id}/document.pdf")
    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail={"error_code": "FILES_PDF_NOT_READY", "message": "PDF 파일이 아직 준비되지 않았습니다"})

    png_bytes = _render_segment_crop_png_bytes(pdf_path, target)
    if not png_bytes:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_SEGMENT_PREVIEW_NOT_AVAILABLE", "message": "세그먼트 미리보기를 생성할 수 없습니다"})

    return FastAPIResponse(content=png_bytes, media_type="image/png")


@router.post("/{file_id}/reprocess")
async def reprocess_file(
    file_id: str,
    payload: Optional[ReprocessFileRequest] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    실패한 파일 재분석 (변환부터 전체 파이프라인 재시작)
    
    - 상태가 failed인 파일만 재처리 가능
    - 상태가 queued/uploading/converting/analyzing이면 409 반환 (이미 처리 중)
    - 기존 산출물(document.pdf, analysis/) 삭제 후 재시작
    """
    import shutil
    
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id
    ).first()
    
    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    _ensure_analysis_domain(file)

    # 상태 가드: 이미 처리 중인 경우
    # UPLOADING/QUEUED는 항상 차단 (정상 파이프라인 진행 중)
    # CONVERTING/ANALYZING는 워커가 실제 처리 중이면 차단, 아니면 고아이므로 허용
    if file.status in (FileStatus.UPLOADING, FileStatus.QUEUED):
        raise HTTPException(
            status_code=409,
            detail={"error_code": "FILES_ALREADY_PROCESSING", "message": "파일이 이미 처리 중입니다"}
        )
    if file.status in (FileStatus.CONVERTING, FileStatus.ANALYZING):
        current_info = processing_queue.get_current_item()
        if current_info and current_info[0].file_id == file_id:
            raise HTTPException(
                status_code=409,
                detail={"error_code": "FILES_ALREADY_PROCESSING", "message": "파일이 현재 처리 중입니다. 완료 후 다시 시도하세요."}
            )
        # 워커가 처리 중이 아닌 ANALYZING/CONVERTING = 고아 → 재처리 허용
    
    # 파일 디렉토리
    file_dir = Path(f"/app/DATABASE/files/users/{current_user.id}/{file_id}")
    
    # 기존 산출물 삭제 (source.* 유지) — fail-closed: 삭제 실패 시 재처리 중단
    cleanup_errors = []
    for target in ["document.pdf", "document.ocr.pdf", "document.preocr.pdf"]:
        target_path = file_dir / target
        if target_path.exists():
            try:
                target_path.unlink()
            except Exception as e:
                cleanup_errors.append(f"{target}: {e}")
    
    analysis_dir = file_dir / "analysis"
    if analysis_dir.exists():
        try:
            shutil.rmtree(analysis_dir)
        except Exception as e:
            cleanup_errors.append(f"analysis/: {e}")
    
    # provider marker 삭제 (base-opendataloader.txt)
    for marker in ["base-opendataloader.txt"]:
        marker_path = file_dir / marker
        if marker_path.exists():
            try:
                marker_path.unlink()
            except Exception as e:
                cleanup_errors.append(f"{marker}: {e}")
    
    if cleanup_errors:
        detail_msg = "; ".join(cleanup_errors)
        print(f"[Reprocess] Cleanup failed for {file_id}: {detail_msg}")
        raise HTTPException(
            status_code=500,
            detail={
                "error_code": "FILES_CLEANUP_FAILED",
                "message": f"이전 산출물 삭제에 실패했습니다: {detail_msg}"
            }
        )
    
    # 삭제 후 검증: analysis/ 디렉터리가 남아 있으면 차단
    if analysis_dir.exists():
        print(f"[Reprocess] Stale analysis dir remains after cleanup for {file_id}")
        raise HTTPException(
            status_code=500,
            detail={
                "error_code": "FILES_CLEANUP_FAILED",
                "message": "이전 분석 산출물이 완전히 삭제되지 않았습니다. 수동 확인이 필요합니다."
            }
        )
    
    # RAG 임베딩 청크 삭제 (재처리 전 정리, fail-open)
    # embedding_model을 전달하지 않으면 모든 모델 컬렉션 + 레거시에서 삭제 (재처리이므로 전수 삭제)
    try:
        from services.rag_indexer import delete_file_chunks
        kb_name = f"kb{file.knowledge_db_id}" if file.knowledge_db_id else "default"
        delete_file_chunks(file_id=file_id, user_id=current_user.id, knowledge_db=kb_name, db=db)
    except Exception as rag_err:
        print(f"[Reprocess] RAG chunk cleanup failed (non-blocking): {rag_err}")
    
    # FileEmbedding 행 전수 삭제 (delete_file_chunks가 fail-open이므로 safety net)
    from models.database import FileEmbedding
    db.query(FileEmbedding).filter(FileEmbedding.file_id == file_id).delete()

    # DB 초기화 (실패 흔적 제거) - 큐에 등록
    file.status = FileStatus.QUEUED
    file.enqueued_at = datetime.utcnow()
    file.error_code = None
    file.error_message = None
    file.segments_data = None
    file.total_pages = 0
    file.converted_at = None
    file.analyzed_at = None
    file.processing_started_at = None
    file.processing_completed_at = None
    file.processing_duration_seconds = None
    file.processing_uses_gpu = None
    file.embedding_status = "none"
    file.embedding_chunks = 0
    file.embedding_model = None
    file.embedding_at = None
    file.content_version = None
    db.commit()
    
    # 재분석: 요청별 provider override가 있으면 우선 사용, 없으면 현재 시스템 기본값 사용
    requeue_provider = _resolve_analysis_provider(db, payload.analysis_provider if payload else None)
    file.analysis_provider = requeue_provider
    db.commit()
    queue_position = await processing_queue.enqueue(file_id, current_user.id, requeue_provider)
    
    return {
        "file_id": file_id,
        "status": file.status.value,
        "domain": _normalize_file_domain(getattr(file, "domain", None)),
        "queue_position": queue_position,
        "analysis_provider": requeue_provider,
        "message": "재분석을 시작했습니다"
    }


# ========== Authored Document (Editor) Endpoints ==========

class AuthoredDocSaveRequest(BaseModel):
    content: str
    filename: Optional[str] = None  # display name; defaults to 'Untitled.md'


class DraftCommitRequest(BaseModel):
    content: str
    filename: Optional[str] = None


@router.delete("/drafts")
async def cleanup_drafts(
    current_user: User = Depends(get_current_user)
):
    deleted_count = _cleanup_user_drafts(current_user.id)
    return {
        "deleted_drafts": deleted_count,
        "message": "Draft cleanup completed",
    }


@router.post("/drafts")
async def create_draft(
    current_user: User = Depends(get_current_user)
):
    draft_id = str(uuid.uuid4())
    draft_dir = _get_draft_dir(current_user.id, draft_id)
    (draft_dir / "assets").mkdir(parents=True, exist_ok=True)
    return {
        "draft_id": draft_id,
        "message": "Draft created",
    }


@router.post("/drafts/{draft_id}/assets")
async def upload_draft_asset(
    draft_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user)
):
    draft_dir = _get_draft_dir(current_user.id, draft_id, ensure_exists=True)
    return await _store_authored_image_asset(file, draft_dir / "assets")


class AuthoredAssetSyncRequest(BaseModel):
    content: str


@router.get("/drafts/{draft_id}/assets/{asset_name}")
async def get_draft_asset(
    draft_id: str,
    asset_name: str,
    current_user: User = Depends(get_current_user)
):
    if _is_invalid_authored_asset_name(asset_name):
        raise HTTPException(
            status_code=400,
            detail={"error_code": "AUTHORED_ASSET_INVALID_NAME", "message": "잘못된 asset 이름입니다."}
        )

    draft_dir = _get_draft_dir(current_user.id, draft_id, ensure_exists=True)
    asset_path = draft_dir / "assets" / asset_name
    if not asset_path.exists() or not asset_path.is_file():
        raise HTTPException(status_code=404, detail={"error_code": "AUTHORED_ASSET_NOT_FOUND", "message": "asset을 찾을 수 없습니다."})

    media_type = EXT_TO_MIME.get(asset_path.suffix.lower(), "application/octet-stream")
    return FastAPIFileResponse(path=str(asset_path), media_type=media_type, filename=asset_name)


@router.post("/drafts/{draft_id}/commit")
async def commit_draft(
    draft_id: str,
    request: DraftCommitRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    display_name = (request.filename or 'Untitled').strip()
    if not display_name.endswith('.md'):
        display_name += '.md'

    normalized_content = _normalize_authored_asset_markdown(request.content)

    draft_dir = _get_draft_dir(current_user.id, draft_id, ensure_exists=True)
    new_file: Optional[PDFFile] = None
    try:
        new_file = _create_authored_document_record(
            db=db,
            current_user=current_user,
            content=normalized_content,
            display_name=display_name,
        )

        draft_assets_dir = draft_dir / "assets"
        if draft_assets_dir.exists() and any(draft_assets_dir.iterdir()):
            target_assets_dir = _get_authored_assets_dir(Path(new_file.file_path))
            target_assets_dir.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(draft_assets_dir), str(target_assets_dir))

        _sync_authored_assets(Path(new_file.file_path), normalized_content)

        shutil.rmtree(draft_dir, ignore_errors=True)
    except Exception as exc:
        if new_file is not None:
            try:
                db.delete(new_file)
                db.commit()
            except Exception:
                db.rollback()
            try:
                shutil.rmtree(Path(new_file.file_path), ignore_errors=True)
            except Exception:
                pass
        raise HTTPException(
            status_code=500,
            detail={"error_code": "DRAFT_COMMIT_FAILED", "message": "draft 저장 중 오류가 발생했습니다."},
        ) from exc

    return {
        **_build_authored_create_response(new_file),
        "draft_id": draft_id,
        "message": "Draft committed",
    }


@router.post("/authored")
async def save_authored_document(
    request: AuthoredDocSaveRequest,
    file_id: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    Save or update an authored markdown document.
    - If file_id is provided and belongs to user, update existing.
    - Otherwise, create new file record with origin='authored'.
    """
    display_name = (request.filename or 'Untitled').strip()
    if not display_name.endswith('.md'):
        display_name += '.md'

    normalized_content = _normalize_authored_asset_markdown(request.content)

    if file_id:
        # Update existing authored document
        existing = db.query(PDFFile).filter(
            PDFFile.id == file_id,
            PDFFile.user_id == current_user.id
        ).first()
        if not existing:
            raise HTTPException(status_code=404, detail={'error_code': 'FILES_NOT_FOUND', 'message': 'Document not found'})

        file_dir = _resolve_my_document_dir(existing, current_user.id, existing.id)
        md_path = _get_authored_markdown_path(file_dir)
        _atomic_write_text(md_path, normalized_content)
        _sync_authored_assets(file_dir, normalized_content)

        # Update metadata
        existing.file_size = len(normalized_content.encode('utf-8'))
        existing.filename = display_name
        existing.original_filename = display_name
        existing.file_path = str(file_dir)
        db.commit()
        db.refresh(existing)

        resolved_domain = _normalize_file_domain(getattr(existing, "domain", None))
        resolved_status = _normalize_file_status(existing, resolved_domain)

        return {
            'file_id': existing.id,
            'filename': existing.filename,
            'file_size': existing.file_size,
            'status': resolved_status.value,
            'domain': resolved_domain,
            'origin': getattr(existing, 'origin', 'authored'),
            'message': 'Document updated'
        }

    new_file = _create_authored_document_record(
        db=db,
        current_user=current_user,
        content=normalized_content,
        display_name=display_name,
    )

    return _build_authored_create_response(new_file)


@router.get("/authored/{file_id}/content")
async def get_authored_document_content(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Get the markdown content of an authored document."""

    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id
    ).first()
    if not file:
        raise HTTPException(status_code=404, detail={'error_code': 'FILES_NOT_FOUND', 'message': 'Document not found'})

    file_dir = _resolve_my_document_dir(file, current_user.id, file.id)
    _migrate_legacy_authored_assets(file_dir)
    md_path = _get_authored_markdown_path(file_dir)
    if not md_path.exists():
        return {
            'file_id': file_id,
            'content': '',
            'filename': file.filename,
            'domain': _normalize_file_domain(getattr(file, 'domain', None)),
        }

    content = md_path.read_text(encoding='utf-8')

    return {
        'file_id': file_id,
        'content': content,
        'filename': file.filename,
        'domain': _normalize_file_domain(getattr(file, 'domain', None)),
        'origin': getattr(file, 'origin', 'uploaded'),
    }


@router.post("/authored/{file_id}/assets")
async def upload_authored_asset(
    file_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    authored_file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id
    ).first()
    if not authored_file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    file_dir = _resolve_my_document_dir(authored_file, current_user.id, authored_file.id)
    _migrate_legacy_authored_assets(file_dir)
    return await _store_authored_image_asset(file, _get_authored_assets_dir(file_dir))


@router.post("/authored/{file_id}/assets/sync")
async def sync_authored_assets(
    file_id: str,
    request: AuthoredAssetSyncRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    authored_file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id
    ).first()
    if not authored_file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    file_dir = _resolve_my_document_dir(authored_file, current_user.id, authored_file.id)
    sync_result = _sync_authored_assets(file_dir, request.content)
    return {
        "file_id": file_id,
        "deleted_assets": sync_result["deleted_assets"],
        "referenced_assets": sync_result["referenced_assets"],
    }


@router.get("/authored/{file_id}/assets/{asset_name}")
async def get_authored_asset(
    file_id: str,
    asset_name: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    authored_file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id
    ).first()
    if not authored_file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    if _is_invalid_authored_asset_name(asset_name):
        raise HTTPException(
            status_code=400,
            detail={"error_code": "AUTHORED_ASSET_INVALID_NAME", "message": "잘못된 asset 이름입니다."}
        )

    file_dir = _resolve_my_document_dir(authored_file, current_user.id, authored_file.id)
    asset_path = _get_authored_assets_dir(file_dir) / asset_name
    if not asset_path.exists() or not asset_path.is_file():
        legacy_asset_path = _get_legacy_authored_assets_dir(file_dir) / asset_name
        asset_path = legacy_asset_path
    if not asset_path.exists() or not asset_path.is_file():
        raise HTTPException(status_code=404, detail={"error_code": "AUTHORED_ASSET_NOT_FOUND", "message": "asset을 찾을 수 없습니다."})

    media_type = EXT_TO_MIME.get(asset_path.suffix.lower(), "application/octet-stream")
    return FastAPIFileResponse(path=str(asset_path), media_type=media_type, filename=asset_name)


# ========== Generic routes (/{file_id}) - must come AFTER specific routes ==========


@router.get("/{file_id}", response_model=ContractFileResponse)
async def get_file(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    파일 상세 정보 조회
    """
    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    resolved_domain = _normalize_file_domain(getattr(file, "domain", None))
    resolved_status = _normalize_file_status(file, resolved_domain)

    return _build_contract_file_response(file, resolved_domain=resolved_domain, resolved_status=resolved_status)


@router.delete("/{file_id}")
async def delete_file(
    file_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    파일 삭제
    - 폴더 삭제를 먼저 시도하고, 실패 시 DB도 유지 (재시도 가능)
    - 연관된 채팅 세션도 함께 삭제 (cascade + segment 참조)
    """
    import shutil

    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "FILES_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    _ensure_analysis_domain(file)

    # 1) segment 참조 세션 조회 (cascade 대상이 아닌 것들)
    linked_session_ids = set(
        s.id for s in db.query(ChatSession).filter(ChatSession.file_id == file_id).all()
    )
    segment_ref_session_ids = _get_sessions_referencing_file_segments(db, file_id)

    # 소유권 필터링
    user_session_ids = set(
        s.id for s in db.query(ChatSession).filter(ChatSession.user_id == current_user.id).all()
    )
    segment_ref_session_ids = segment_ref_session_ids & user_session_ids

    # cascade로 삭제되지 않는 세션들 (segment 참조만 있는 것들)
    sessions_to_delete_manually = segment_ref_session_ids - linked_session_ids

    total_sessions_to_delete = len(linked_session_ids | segment_ref_session_ids)

    # 1.5) RAG 임베딩 청크 삭제 (fail-open)
    # 파일 삭제이므로 모든 모델 컬렉션 + 레거시에서 전수 삭제 (embedding_model=None)
    try:
        from services.rag_indexer import delete_file_chunks
        kb_name = f"kb{file.knowledge_db_id}" if file.knowledge_db_id else "default"
        delete_file_chunks(file_id=file_id, user_id=current_user.id, knowledge_db=kb_name, db=db)
    except Exception as rag_err:
        print(f"[DeleteFile] RAG chunk cleanup failed (non-blocking): {rag_err}")

    # 2) 파일 폴더 먼저 삭제 시도
    file_dir = Path(f"/app/DATABASE/files/users/{current_user.id}/{file_id}")
    if file_dir.exists():
        try:
            shutil.rmtree(file_dir)
        except Exception as e:
            request_id = getattr(getattr(request, "state", None), "request_id", None)
            print(f"[DeleteError] request_id={request_id} file_id={file_id} folder_delete_failed={e}")
            raise HTTPException(
                status_code=500,
                detail={"error_code": "FILES_DELETE_FOLDER_FAILED", "message": "파일 폴더 삭제에 실패했습니다. 다시 시도해주세요."}
            )

    # 3) segment 참조 세션 명시적 삭제 (cascade 대상 아님)
    # 주의: bulk delete는 cascade가 작동하지 않으므로, 객체를 로드한 후 삭제해야 함
    if sessions_to_delete_manually:
        sessions_to_delete = db.query(ChatSession).filter(ChatSession.id.in_(sessions_to_delete_manually)).all()
        for session in sessions_to_delete:
            db.delete(session)  # cascade로 ChatMessage도 삭제됨

    # 4) 파일 삭제 (linked sessions는 cascade로 자동 삭제)
    db.delete(file)
    db.commit()

    return {
        "message": "파일이 삭제되었습니다",
        "deleted_sessions": total_sessions_to_delete
    }
