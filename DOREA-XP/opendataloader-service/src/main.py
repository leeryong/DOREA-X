"""
opendataloader-pdf 기반 PDF 파싱 서비스.

POST /analyze — docling-service와 동일한 인터페이스.
opendataloader-pdf Python API로 파싱하고, PyMuPDF로 페이지 크기 추출.
"""
import asyncio
import io
import json
import logging
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import fitz  # PyMuPDF
import httpx
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

app = FastAPI(title="opendataloader-pdf service", version="0.1.0")

# -- 진행 상태 추적 --
_progress_lock = threading.Lock()
_progress: dict = {
    "status": "idle",       # idle | processing | done | error
    "total_pages": 0,
    "java_pages": 0,
    "backend_pages": 0,
    "phase": "",            # triage | java | backend | normalizing
    "message": "",
    "started_at": 0.0,
    "phase_started_at": 0.0,  # 현재 phase 시작 시각
}


def _reset_progress(total_pages: int = 0):
    with _progress_lock:
        _progress.update({
            "status": "processing",
            "total_pages": total_pages,
            "java_pages": 0,
            "backend_pages": 0,
            "phase": "triage",
            "message": f"PDF 분석 시작 ({total_pages}페이지)",
            "started_at": time.time(),
        })


def _update_progress(**kwargs):
    with _progress_lock:
        _progress.update(kwargs)


def _get_progress() -> dict:
    with _progress_lock:
        p = dict(_progress)
    now = time.time()
    if p["started_at"] > 0:
        p["elapsed_sec"] = round(now - p["started_at"], 1)
    # backend phase일 때 경과 시간 표시
    if p.get("phase") == "backend" and p.get("backend_pages", 0) > 0:
        phase_elapsed = int(now - p.get("phase_started_at", p["started_at"]))
        p["message"] = f"AI 분석 중: {p['backend_pages']}페이지 처리 중 ({phase_elapsed}s 경과)"
    return p


def _get_page_dimensions(pdf_bytes: bytes) -> dict[str, dict[str, float]]:
    """PyMuPDF로 각 페이지의 width/height(pt) 추출."""
    dims: dict[str, dict[str, float]] = {}
    with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
        for i, page in enumerate(doc, start=1):
            rect = page.rect
            dims[str(i)] = {"width": rect.width, "height": rect.height}
    return dims


def _parse_java_log_line(line: str) -> None:
    """Java stdout 로그를 파싱하여 _progress를 업데이트."""
    # "Triage summary: JAVA=0, BACKEND=14"
    m = re.search(r"Triage summary: JAVA=(\d+), BACKEND=(\d+)", line)
    if m:
        java_n, backend_n = int(m.group(1)), int(m.group(2))
        total = java_n + backend_n
        _update_progress(
            java_pages=java_n,
            backend_pages=backend_n,
            phase="routing",
            message=f"페이지 분류 완료: 일반 {java_n}p, AI분석 {backend_n}p (총 {total}p)",
        )
        return

    # "Routing: 0 pages to Java, 14 pages to Backend"
    if "Processing" in line and "pages via" in line:
        m2 = re.search(r"Processing (\d+) pages via (.+)", line)
        if m2:
            n, backend_type = int(m2.group(1)), m2.group(2).strip()
            _update_progress(
                phase="backend",
                phase_started_at=time.time(),
                message=f"AI 분석 시작 ({n}페이지, {backend_type})...",
            )
        return

    # "Falling back to Java processing"
    if "Falling back to Java" in line:
        _update_progress(phase="java-fallback", message="AI 백엔드 실패, Java fallback 처리 중...")
        return

    # "Created /tmp/.../filename.json"
    if "Created" in line and ".json" in line:
        _update_progress(phase="writing", message="JSON 출력 생성 완료")
        return


def _run_jar_with_progress(pdf_path: str, output_dir: str | None = None) -> dict | None:
    """Java JAR를 직접 Popen으로 실행하며 stdout을 실시간 파싱."""
    try:
        from importlib import resources as pkg_resources
        jar_ref = pkg_resources.files("opendataloader_pdf").joinpath("jar")
        jar_files = [f for f in jar_ref.iterdir() if f.name.endswith(".jar")]
        if not jar_files:
            logger.error("opendataloader-pdf JAR 파일을 찾을 수 없음")
            return None

        import locale
        with pkg_resources.as_file(jar_files[0]) as jar_path:
            cmd = [
                "java", "-jar", str(jar_path), pdf_path,
                "--hybrid", "docling-fast",
                "--hybrid-url", "http://localhost:5002",
                "--hybrid-timeout", "1800000",
                "--hybrid-fallback",
            ]
            if output_dir:
                cmd.extend(["-o", output_dir])

            logger.info("[jar] 실행: %s", " ".join(cmd))

            with subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding=locale.getpreferredencoding(False),
            ) as proc:
                for line in proc.stdout:
                    line = line.rstrip()
                    if line:
                        logger.info("[java] %s", line)
                        _parse_java_log_line(line)

                ret = proc.wait()
                logger.info("[jar] 종료 코드: %d", ret)
                if ret != 0:
                    logger.error("Java JAR 비정상 종료: %d", ret)
                    return None

        # JSON 출력 파일 찾기
        json_path = Path(pdf_path).with_suffix(".json")
        if json_path.exists():
            logger.info("[jar] JSON 발견: %s (%d bytes)", json_path, json_path.stat().st_size)
            with open(json_path) as f:
                return json.load(f)

        if output_dir:
            out_path = Path(output_dir)
            json_files = list(out_path.glob("*.json"))
            logger.info("[jar] output_dir JSON 파일: %s", [f.name for f in json_files])
            if json_files:
                logger.info("[jar] JSON 발견: %s (%d bytes)", json_files[0], json_files[0].stat().st_size)
                with open(json_files[0]) as f:
                    return json.load(f)

        logger.error("JSON 출력 파일을 찾을 수 없음")
        return None

    except Exception as e:
        logger.error("Java JAR 실행 실패: %s", e, exc_info=True)
        return None


HYBRID_BACKEND_URL = "http://localhost:5002"


async def _wait_for_hybrid_backend_ready(timeout_seconds: float = 180.0, interval_seconds: float = 1.0) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(f"{HYBRID_BACKEND_URL}/health")
            if resp.status_code == 200:
                return True
        except Exception:
            pass
        await asyncio.sleep(interval_seconds)
    return False


async def _call_docling_backend(pdf_bytes: bytes) -> dict | None:
    """docling-fast 백엔드에 직접 PDF를 보내서 파싱. JAR 결과가 비어있을 때 fallback용."""
    try:
        async with httpx.AsyncClient(timeout=1800.0) as client:
            resp = await client.post(
                f"{HYBRID_BACKEND_URL}/v1/convert/file",
                files={"files": ("input.pdf", pdf_bytes, "application/pdf")},
            )
            resp.raise_for_status()
            data = resp.json()
        # docling 응답에서 elements 추출
        doc = data.get("document") or data
        elements = doc.get("texts") or doc.get("elements") or []
        if not elements:
            logger.warning("docling-fast fallback도 빈 결과")
            return None
        # docling 텍스트를 element 형태로 변환
        visual_raw_types = {"table", "image", "picture", "figure", "formula", "equation"}
        result_elements = []
        for item in elements:
            raw_type = str(item.get("type", "text"))
            raw_type_norm = raw_type.strip().lower().replace("-", "").replace("_", "")
            text = (item.get("text") or item.get("content") or "").strip()
            if not text and raw_type_norm not in visual_raw_types:
                continue
            page_no = None
            prov = item.get("prov") or []
            if prov and isinstance(prov, list):
                page_no = prov[0].get("page_no") or prov[0].get("page")
            result_elements.append({
                "type": raw_type,
                "content": text,
                "page_number": page_no,
                "bounding_box": None,
            })
        return {"elements": result_elements} if result_elements else None
    except Exception as e:
        logger.error("docling-fast fallback 실패: %s", e)
        return None


@app.get("/health")
async def health():
    hybrid_available = False
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{HYBRID_BACKEND_URL}/health")
            hybrid_available = resp.status_code == 200
    except Exception:
        pass
    return {
        "status": "ok",
        "provider": "opendataloader-pdf",
        "hybrid_available": hybrid_available,
    }


@app.get("/progress")
async def progress():
    """현재 파싱 작업의 진행 상태 반환."""
    return _get_progress()


@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    ocr_enabled: str = Form("true"),
    ocr_language: str = Form("ko"),
):
    """PDF 파싱 엔드포인트. docling-service와 동일 인터페이스."""
    pdf_bytes = await file.read()

    # 페이지 크기 추출
    try:
        page_dimensions = _get_page_dimensions(pdf_bytes)
    except Exception as e:
        logger.error("페이지 크기 추출 실패: %s", e)
        page_dimensions = {}

    total_pages = len(page_dimensions)
    _reset_progress(total_pages)

    _update_progress(phase="backend-ready-check", message="docling-fast 백엔드 준비 상태 확인 중...")
    backend_ready = await _wait_for_hybrid_backend_ready()
    if not backend_ready:
        _update_progress(status="error", phase="", message="docling-fast 백엔드 준비 실패")
        return JSONResponse(
            status_code=503,
            content={
                "status": "error",
                "provider": "opendataloader-pdf",
                "message": "docling-fast backend is not ready. Please retry shortly.",
            },
        )

    # 임시 파일에 PDF 저장
    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path = str(Path(tmpdir) / (file.filename or "input.pdf"))
        with open(pdf_path, "wb") as f:
            f.write(pdf_bytes)

        output_dir = str(Path(tmpdir) / "output")
        Path(output_dir).mkdir()

        _update_progress(phase="hybrid", message=f"hybrid 파싱 시작 ({total_pages}페이지)...")

        # Java JAR를 직접 실행하며 stdout 실시간 파싱으로 progress 업데이트
        # to_thread로 실행하여 이벤트 루프 블로킹 방지 (/progress 응답 가능)
        document = await asyncio.to_thread(_run_jar_with_progress, pdf_path, output_dir)

    if document is None:
        _update_progress(status="error", phase="", message="파싱 실패")
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "provider": "opendataloader-pdf",
                "message": "PDF 파싱 실패: Python API와 CLI 모두 실패",
            },
        )

    _update_progress(phase="normalizing", message="결과 정규화 중...")

    # opendataloader-pdf JSON 구조 정규화:
    # 원본은 "kids" 배열, 백엔드 파서는 "elements" 배열을 기대
    elements = document.get("kids") or document.get("elements") or document.get("blocks")
    logger.info("JAR document keys=%s, elements count=%d",
                list(document.keys()), len(elements) if elements else 0)
    normalized_doc = {"elements": _normalize_kids(elements, page_dimensions) if elements else []}
    logger.info("정규화 후 elements: %d개", len(normalized_doc["elements"]))

    # Java triage가 이미지 페이지를 텍스트로 오판하면 빈 결과가 나옴
    # -> docling-fast 백엔드에 직접 PDF를 보내서 재시도
    if not normalized_doc["elements"]:
        logger.info("JAR 결과 비어있음 -> docling-fast 백엔드 직접 호출 시도")
        _update_progress(phase="backend-fallback",
                         message=f"Java 결과 없음, AI 백엔드 직접 분석 중 ({total_pages}페이지)...")
        fallback_doc = await _call_docling_backend(pdf_bytes)
        if fallback_doc and fallback_doc.get("elements"):
            normalized_doc = fallback_doc
            logger.info("docling-fast fallback 성공: %d개 요소", len(normalized_doc["elements"]))

    elem_count = len(normalized_doc["elements"])
    _update_progress(status="done", phase="", message=f"완료: {elem_count}개 요소 추출")

    return {
        "status": "success",
        "provider": "opendataloader-pdf",
        "document": normalized_doc,
        "page_dimensions": page_dimensions,
    }


def _normalize_kids(
    kids: list[dict], page_dims: dict[str, dict[str, float]]
) -> list[dict]:
    """opendataloader-pdf 최상위 'kids'를 의미 단위 elements로 변환.

    최상위 kid 단위로 하위 리프들의 텍스트를 합치고 bbox를 union.
    페이지가 걸치는 경우 페이지별로 분리하여 별도 element 생성.
    """
    elements: list[dict] = []
    visual_kid_types = {"table", "image", "picture", "figure", "formula", "equation"}

    for kid in kids:
        kid_type = kid.get("type", "")
        kid_type_norm = str(kid_type).strip().lower().replace("-", "").replace("_", "")
        # 이 최상위 kid의 모든 리프 노드 수집
        leaves: list[dict] = []
        _collect_leaves(kid, leaves)

        if not leaves:
            if kid_type_norm not in visual_kid_types:
                continue

            page_raw = kid.get("page number") or kid.get("page_number") or kid.get("page")
            page_no = None
            try:
                if page_raw is not None:
                    page_no = int(page_raw)
            except Exception:
                page_no = None

            bbox_raw = kid.get("bounding box") or kid.get("bounding_box") or kid.get("bbox")
            if page_no is None and not bbox_raw:
                continue

            leaves = [{
                "content": "",
                "page_number": page_no,
                "bounding_box": bbox_raw,
            }]

        # 페이지별 그룹핑
        page_groups: dict[int | None, list[dict]] = {}
        for leaf in leaves:
            pg = leaf.get("page_number")
            page_groups.setdefault(pg, []).append(leaf)

        # 페이지 순서대로 element 생성
        for pg in sorted(page_groups.keys(), key=lambda x: (x is None, x or 0)):
            group = page_groups[pg]
            texts = [lf["content"] for lf in group if lf["content"]]
            if not texts and kid_type_norm not in visual_kid_types:
                continue

            # bbox union 계산
            union_bbox = _union_bbox([lf["bounding_box"] for lf in group])

            elements.append({
                "type": kid_type,
                "content": "\n".join(texts),
                "page_number": pg,
                "bounding_box": union_bbox,
            })

    return elements


def _collect_leaves(node: dict, out: list[dict]) -> None:
    """노드를 재귀 탐색하여 content가 있는 리프를 수집."""
    content = (node.get("content") or "").strip()
    children = (
        node.get("kids")
        or node.get("list items")
        or node.get("table rows")
        or node.get("table cells")
        or node.get("children")
    )

    if content:
        out.append({
            "content": content,
            "page_number": node.get("page number"),
            "bounding_box": node.get("bounding box"),
        })

    if children and isinstance(children, list):
        for child in children:
            _collect_leaves(child, out)


def _union_bbox(bboxes: list) -> list[float] | None:
    """여러 bbox [l, b, r, t]의 union 계산."""
    ul, ub, ur, ut = None, None, None, None
    for bb in bboxes:
        if not bb or len(bb) < 4:
            continue
        l, b, r, t = bb[0], bb[1], bb[2], bb[3]
        ul = min(ul, l) if ul is not None else l
        ub = min(ub, b) if ub is not None else b
        ur = max(ur, r) if ur is not None else r
        ut = max(ut, t) if ut is not None else t
    if ul is None:
        return None
    return [ul, ub, ur, ut]
