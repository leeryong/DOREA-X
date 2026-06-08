# Knowledge DB CRUD Routes

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from sqlalchemy import func as sa_func
from pydantic import BaseModel, Field
from typing import Optional, List, Literal
from datetime import datetime

from api.deps import get_current_user
from models.database import get_db, User, PDFFile, KnowledgeDB, FileEmbedding

router = APIRouter(prefix="/api/knowledge-dbs", tags=["KnowledgeDbs"])

DEFAULT_KB_NAME = "일반문서"
DEFAULT_KB_DESCRIPTION = "일반 문서를 모아두는 기본 지식베이스"
LEGACY_DEFAULT_KB_NAME = "default"
LEGACY_DEFAULT_KB_DESCRIPTION = "기본 지식DB"


# ========== Schemas ==========

class KnowledgeDBCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)


class KnowledgeDBUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=500)


class KnowledgeDBResponse(BaseModel):
    id: int
    name: str
    description: Optional[str]
    file_count: int = 0
    total_chunks: int = 0
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class KnowledgeDBFileResponse(BaseModel):
    file_id: str
    original_filename: str
    file_size: int
    status: str
    embedding_status: str
    embedding_chunks: int
    embedding_total_chunks: int = 0       # 임베딩 대상 총 청크 수
    embedding_processed_chunks: int = 0   # 현재까지 임베딩 완료된 청크 수
    embedding_error: Optional[str] = None
    embedding_model: Optional[str] = None
    embedding_at: Optional[datetime] = None
    content_version: Optional[str] = None
    total_pages: int = 0
    mime_type: Optional[str] = None
    uploaded_at: datetime
    current_kb_name: Optional[str] = None  # 현재 소속 KB명 (이동 UI용)
    enrichment_status: Optional[str] = None  # 멀티모달 보강 상태
    enrichment_error: Optional[str] = None


class KnowledgeDBAddFilesRequest(BaseModel):
    file_ids: List[str] = Field(..., min_length=1, max_length=50)


class KnowledgeDBBulkEmbedRequest(BaseModel):
    mode: Literal["missing", "all"] = Field(
        "missing",
        description="missing=미임베딩/실패 파일만, all=완료 파일 전체 재임베딩",
    )


# ========== Helpers ==========

def _get_kb_or_404(db: Session, kb_id: int, user_id: int) -> KnowledgeDB:
    kb = db.query(KnowledgeDB).filter(
        KnowledgeDB.id == kb_id,
        KnowledgeDB.user_id == user_id,
    ).first()
    if not kb:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "KB_NOT_FOUND", "message": "지식DB를 찾을 수 없습니다"},
        )
    return kb


def get_or_create_default_kb(db: Session, user_id: int) -> KnowledgeDB:
    """사용자의 기본 지식DB를 가져오거나, 없으면 자동 생성"""
    kb = db.query(KnowledgeDB).filter(
        KnowledgeDB.user_id == user_id,
        KnowledgeDB.name == DEFAULT_KB_NAME,
    ).order_by(KnowledgeDB.created_at.asc(), KnowledgeDB.id.asc()).first()
    if kb:
        return kb

    legacy_kb = db.query(KnowledgeDB).filter(
        KnowledgeDB.user_id == user_id,
        KnowledgeDB.name == LEGACY_DEFAULT_KB_NAME,
    ).order_by(KnowledgeDB.created_at.asc(), KnowledgeDB.id.asc()).first()
    if legacy_kb:
        legacy_kb.name = DEFAULT_KB_NAME
        if not legacy_kb.description or legacy_kb.description.strip() == LEGACY_DEFAULT_KB_DESCRIPTION:
            legacy_kb.description = DEFAULT_KB_DESCRIPTION
        legacy_kb.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(legacy_kb)
        return legacy_kb

    kb = KnowledgeDB(user_id=user_id, name=DEFAULT_KB_NAME, description=DEFAULT_KB_DESCRIPTION)
    db.add(kb)
    db.commit()
    db.refresh(kb)
    return kb


def _get_collection_name(user_id: int, kb_id: int) -> str:
    """KB용 ChromaDB 컬렉션 이름 (레거시 호환 — 삭제 cleanup용)"""
    # NOTE: 모델별 컬렉션 라우팅은 rag_indexer의 함수를 사용.
    # 이 함수는 KB 삭제 시 레거시 컬렉션 정리 + chunks 조회에만 사용.
    return f"rag_{user_id}_kb{kb_id}"


def _index_file_to_kb(file_id: str, user_id: int, kb_id: int):
    """파일을 KB 컬렉션에 인덱싱 (background task)"""
    from models.database import SessionLocal, PDFFile, FileEmbedding
    from services.rag_indexer import index_file as rag_index_file, _get_or_create_embedding
    from services.embedding_service import get_provider_info

    db = SessionLocal()
    try:
        file = db.query(PDFFile).filter(PDFFile.id == file_id).first()
        if not file or not file.segments_data:
            return

        # 현재 활성 모델의 FileEmbedding 행에 processing 상태 기록
        info = get_provider_info()
        emb = _get_or_create_embedding(db, file_id, info["provider"], info["model"])
        emb.status = "processing"
        emb.total_chunks = 0
        emb.processed_chunks = 0
        emb.error_message = None
        db.commit()

        try:
            chunk_count = rag_index_file(
                file_id=file_id,
                user_id=user_id,
                segments_data=file.segments_data,
                knowledge_db=f"kb{kb_id}",
                db=db,
            )
            print(f"[KnowledgeDB] Indexed file {file_id} to kb{kb_id} ({chunk_count} chunks)")
        except Exception as e:
            print(f"[KnowledgeDB] Indexing failed for {file_id}: {e}")
            # FileEmbedding 행에 실패 기록
            emb = db.query(FileEmbedding).filter(
                FileEmbedding.file_id == file_id,
                FileEmbedding.provider == info["provider"],
                FileEmbedding.model == info["model"],
            ).first()
            if emb:
                emb.status = "failed"
                emb.error_message = str(e)[:500]
            db.commit()
    finally:
        db.close()


def _reindex_file_to_kb(file_id: str, user_id: int, kb_id: int, embedding_model: str):
    """현재 모델 기준으로 기존 벡터를 지운 뒤 다시 인덱싱."""
    from services.rag_indexer import delete_file_chunks

    delete_file_chunks(
        file_id=file_id,
        user_id=user_id,
        knowledge_db=f"kb{kb_id}",
        embedding_model=embedding_model,
    )
    _index_file_to_kb(file_id, user_id, kb_id)


def _get_file_status_value(file: PDFFile) -> str:
    return file.status.value if hasattr(file.status, "value") else str(file.status)


def _mark_embedding_pending(db: Session, file: PDFFile, provider: str, model: str):
    from services.rag_indexer import _get_or_create_embedding

    emb = _get_or_create_embedding(db, file.id, provider, model)
    emb.status = "pending"
    emb.chunks = 0
    emb.total_chunks = 0
    emb.processed_chunks = 0
    emb.error_message = None
    emb.content_version = None
    emb.embedded_at = None

    file.embedding_status = "pending"
    file.embedding_chunks = 0
    file.embedding_total_chunks = 0
    file.embedding_processed_chunks = 0
    file.embedding_model = model
    file.embedding_at = None
    file.content_version = None

    return emb


def _remove_file_from_kb(file_id: str, user_id: int, kb_id: int, embedding_model: Optional[str] = None):
    """
    파일의 벡터를 KB 컬렉션에서 삭제.
    embedding_model이 주어지면 해당 모델 컬렉션에서만, 없으면 전수 삭제.
    """
    from services.rag_indexer import delete_file_chunks

    try:
        if embedding_model is not None:
            delete_file_chunks(
                file_id=file_id,
                user_id=user_id,
                knowledge_db=f"kb{kb_id}",
                embedding_model=embedding_model,
            )
        else:
            delete_file_chunks(
                file_id=file_id,
                user_id=user_id,
                knowledge_db=f"kb{kb_id}",
            )
        print(f"[KnowledgeDB] Removed file {file_id} from kb{kb_id} (model={embedding_model})")
    except Exception as e:
        print(f"[KnowledgeDB] Remove failed for {file_id}: {e}")


# ========== CRUD Endpoints ==========

@router.post("", response_model=KnowledgeDBResponse, status_code=201)
async def create_knowledge_db(
    payload: KnowledgeDBCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """DOREA-XP: 지식DB 추가는 비활성화. '일반문서' 기본 DB만 사용."""
    raise HTTPException(
        status_code=403,
        detail={
            "error_code": "KB_CREATE_DISABLED",
            "message": "DOREA-XP에서는 지식DB 추가가 비활성화되어 있습니다",
        },
    )


@router.get("", response_model=List[KnowledgeDBResponse])
async def list_knowledge_dbs(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """사용자의 지식DB 목록 조회 (파일 수, 현재 모델 기준 총 청크 수 포함)"""
    from services.embedding_service import get_provider_info

    # default KB가 없으면 자동 생성하여 목록 정합성 보장
    get_or_create_default_kb(db, current_user.id)

    info = get_provider_info()
    cur_provider = info["provider"]
    cur_model = info["model"]

    kbs = db.query(KnowledgeDB).filter(
        KnowledgeDB.user_id == current_user.id,
    ).order_by(KnowledgeDB.created_at.desc()).all()

    results = []
    for kb in kbs:
        file_count = db.query(sa_func.count(PDFFile.id)).filter(
            PDFFile.knowledge_db_id == kb.id,
        ).scalar() or 0

        # 현재 활성 모델 기준으로 total_chunks 집계
        total_chunks = db.query(sa_func.coalesce(sa_func.sum(FileEmbedding.chunks), 0)).join(
            PDFFile, FileEmbedding.file_id == PDFFile.id
        ).filter(
            PDFFile.knowledge_db_id == kb.id,
            FileEmbedding.provider == cur_provider,
            FileEmbedding.model == cur_model,
        ).scalar() or 0

        results.append(KnowledgeDBResponse(
            id=kb.id,
            name=kb.name,
            description=kb.description,
            file_count=file_count,
            total_chunks=int(total_chunks),
            created_at=kb.created_at,
            updated_at=kb.updated_at,
        ))

    return results


@router.get("/{kb_id}", response_model=KnowledgeDBResponse)
async def get_knowledge_db(
    kb_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """지식DB 상세 조회 (현재 모델 기준 총 청크 수)"""
    from services.embedding_service import get_provider_info

    kb = _get_kb_or_404(db, kb_id, current_user.id)

    info = get_provider_info()
    cur_provider = info["provider"]
    cur_model = info["model"]

    file_count = db.query(sa_func.count(PDFFile.id)).filter(
        PDFFile.knowledge_db_id == kb.id,
    ).scalar() or 0

    # 현재 활성 모델 기준으로 total_chunks 집계
    total_chunks = db.query(sa_func.coalesce(sa_func.sum(FileEmbedding.chunks), 0)).join(
        PDFFile, FileEmbedding.file_id == PDFFile.id
    ).filter(
        PDFFile.knowledge_db_id == kb.id,
        FileEmbedding.provider == cur_provider,
        FileEmbedding.model == cur_model,
    ).scalar() or 0

    return KnowledgeDBResponse(
        id=kb.id,
        name=kb.name,
        description=kb.description,
        file_count=file_count,
        total_chunks=int(total_chunks),
        created_at=kb.created_at,
        updated_at=kb.updated_at,
    )


@router.put("/{kb_id}", response_model=KnowledgeDBResponse)
async def update_knowledge_db(
    kb_id: int,
    payload: KnowledgeDBUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """지식DB 수정 (이름/설명)"""
    kb = _get_kb_or_404(db, kb_id, current_user.id)

    if payload.name is not None:
        name = payload.name.strip()
        # 같은 이름 중복 체크 (자기 자신 제외)
        dup = db.query(KnowledgeDB).filter(
            KnowledgeDB.user_id == current_user.id,
            KnowledgeDB.name == name,
            KnowledgeDB.id != kb_id,
        ).first()
        if dup:
            raise HTTPException(
                status_code=409,
                detail={"error_code": "KB_DUPLICATE_NAME", "message": f"이미 같은 이름의 지식DB가 있습니다: {name}"},
            )
        kb.name = name

    if payload.description is not None:
        kb.description = payload.description.strip() if payload.description else None

    kb.updated_at = datetime.utcnow()
    db.commit()

    return await get_knowledge_db(kb_id, db=db, current_user=current_user)


@router.delete("/{kb_id}", status_code=204)
async def delete_knowledge_db(
    kb_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """DOREA-XP: 지식DB 삭제는 비활성화. '일반문서' 기본 DB는 영구 보존."""
    raise HTTPException(
        status_code=403,
        detail={
            "error_code": "KB_DELETE_DISABLED",
            "message": "DOREA-XP에서는 지식DB 삭제가 비활성화되어 있습니다",
        },
    )


# ========== File Assignment Endpoints ==========

@router.get("/{kb_id}/files", response_model=List[KnowledgeDBFileResponse])
async def list_kb_files(
    kb_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """지식DB에 속한 파일 목록 (현재 활성 모델 기준 임베딩 상태 반영)"""
    from services.embedding_service import get_provider_info
    _get_kb_or_404(db, kb_id, current_user.id)

    info = get_provider_info()
    cur_provider = info["provider"]
    cur_model = info["model"]

    files = db.query(PDFFile).filter(
        PDFFile.knowledge_db_id == kb_id,
        PDFFile.user_id == current_user.id,
    ).order_by(PDFFile.uploaded_at.desc()).all()

    # 현재 모델의 FileEmbedding 행을 일괄 조회
    file_ids = [f.id for f in files]
    emb_map = {}
    if file_ids:
        embs = db.query(FileEmbedding).filter(
            FileEmbedding.file_id.in_(file_ids),
            FileEmbedding.provider == cur_provider,
            FileEmbedding.model == cur_model,
        ).all()
        emb_map = {e.file_id: e for e in embs}

    results = []
    for f in files:
        emb = emb_map.get(f.id)
        results.append(KnowledgeDBFileResponse(
            file_id=f.id,
            original_filename=f.original_filename,
            file_size=f.file_size,
            status=f.status.value if hasattr(f.status, 'value') else str(f.status),
            embedding_status=emb.status if emb else "none",
            embedding_chunks=emb.chunks if emb else 0,
            embedding_total_chunks=emb.total_chunks if emb else 0,
            embedding_processed_chunks=emb.processed_chunks if emb else 0,
            embedding_error=emb.error_message if emb and emb.status == "failed" else None,
            embedding_model=cur_model,
            embedding_at=emb.embedded_at if emb else None,
            content_version=emb.content_version if emb else None,
            total_pages=f.total_pages or 0,
            mime_type=f.mime_type,
            uploaded_at=f.uploaded_at,
            enrichment_status=getattr(f, 'enrichment_status', 'none'),
            enrichment_error=getattr(f, 'enrichment_error', None),
        ))
    return results


@router.post("/{kb_id}/files")
async def add_files_to_kb(
    kb_id: int,
    payload: KnowledgeDBAddFilesRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """파일을 지식DB에 추가 (인덱싱 트리거). DOREA-XP: 1개 DB당 최대 10개."""
    kb = _get_kb_or_404(db, kb_id, current_user.id)

    from config import settings as _xp_settings
    current_count = db.query(PDFFile).filter(PDFFile.knowledge_db_id == kb_id).count()
    remaining_slots = max(0, _xp_settings.knowledge_db_max_documents - current_count)
    if remaining_slots <= 0:
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "KB_LIMIT_REACHED",
                "message": f"지식DB는 최대 {_xp_settings.knowledge_db_max_documents}개 문서까지 담을 수 있습니다",
            },
        )
    if len(payload.file_ids) > remaining_slots:
        raise HTTPException(
            status_code=409,
            detail={
                "error_code": "KB_LIMIT_REACHED",
                "message": f"남은 슬롯이 {remaining_slots}개입니다 (요청 {len(payload.file_ids)}개)",
            },
        )

    added = []
    skipped = []
    for file_id in payload.file_ids:
        file = db.query(PDFFile).filter(
            PDFFile.id == file_id,
            PDFFile.user_id == current_user.id,
        ).first()

        if not file:
            skipped.append({"file_id": file_id, "reason": "파일을 찾을 수 없습니다"})
            continue

        if file.status.value != "completed" if hasattr(file.status, 'value') else str(file.status) != "completed":
            skipped.append({"file_id": file_id, "reason": "분석이 완료되지 않은 파일입니다"})
            continue

        # 이전 KB에서 제거 (다른 KB에 있었다면)
        old_kb_id = file.knowledge_db_id
        if old_kb_id and old_kb_id != kb_id:
            # 이전 KB의 모든 모델 컬렉션에서 벡터 삭제 (embedding_model=None → 전수 삭제)
            background_tasks.add_task(
                _remove_file_from_kb, file_id, current_user.id, old_kb_id,
                embedding_model=None,
            )

        file.knowledge_db_id = kb_id

        # FileEmbedding 행 전체 삭제 (새 KB에서 다시 임베딩해야 하므로)
        db.query(FileEmbedding).filter(FileEmbedding.file_id == file_id).delete()
        # 레거시 컬럼 리셋
        file.embedding_status = "none"
        file.embedding_chunks = 0
        file.embedding_total_chunks = 0
        file.embedding_processed_chunks = 0
        file.embedding_model = None
        file.embedding_at = None
        file.content_version = None
        added.append(file_id)

    db.commit()

    return {
        "added": added,
        "skipped": skipped,
        "message": f"{len(added)}개 파일이 '{kb.name}'에 추가되었습니다",
    }


@router.delete("/{kb_id}/files/{file_id}", status_code=204)
async def remove_file_from_kb(
    kb_id: int,
    file_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """파일을 지식DB에서 제거 (벡터 삭제)"""
    _get_kb_or_404(db, kb_id, current_user.id)

    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
        PDFFile.knowledge_db_id == kb_id,
    ).first()

    if not file:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "KB_FILE_NOT_FOUND", "message": "해당 지식DB에서 파일을 찾을 수 없습니다"},
        )

    # KB에서 파일 연결 해제
    file.knowledge_db_id = None
    # FileEmbedding 행은 background의 delete_file_chunks에서 전수 삭제됨 (embedding_model=None)
    # 레거시 컬럼도 delete_file_chunks에서 리셋됨
    db.commit()

    # 모든 모델 컬렉션 + 레거시에서 벡터 전수 삭제 (embedding_model=None)
    background_tasks.add_task(
        _remove_file_from_kb, file_id, current_user.id, kb_id,
        embedding_model=None,
    )


@router.post("/{kb_id}/files/{file_id}/embed")
async def embed_file_in_kb(
    kb_id: int,
    file_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """파일을 임베딩 (수동 트리거)"""
    _get_kb_or_404(db, kb_id, current_user.id)

    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
        PDFFile.knowledge_db_id == kb_id,
    ).first()

    if not file:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "KB_FILE_NOT_FOUND", "message": "해당 지식DB에서 파일을 찾을 수 없습니다"},
        )

    file_status = _get_file_status_value(file)
    if file_status != "completed":
        raise HTTPException(
            status_code=400,
            detail={"error_code": "FILE_NOT_READY", "message": "문서 분석이 완료되지 않았습니다"},
        )

    if not file.segments_data:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "FILE_NO_SEGMENTS", "message": "분석 데이터가 없습니다. 재분석을 시도해주세요."},
        )

    # 현재 활성 모델 기준으로 processing 상태 확인
    from services.embedding_service import get_provider_info
    from services.rag_indexer import _get_or_create_embedding
    info = get_provider_info()
    cur_emb = db.query(FileEmbedding).filter(
        FileEmbedding.file_id == file_id,
        FileEmbedding.provider == info["provider"],
        FileEmbedding.model == info["model"],
    ).first()
    if cur_emb and cur_emb.status == "processing":
        raise HTTPException(
            status_code=409,
            detail={"error_code": "EMBEDDING_IN_PROGRESS", "message": "이미 임베딩이 진행 중입니다"},
        )

    # FileEmbedding 행에 pending 상태 기록
    _mark_embedding_pending(db, file, info["provider"], info["model"])
    db.commit()

    background_tasks.add_task(_index_file_to_kb, file_id, current_user.id, kb_id)

    return {"message": "임베딩이 시작되었습니다", "file_id": file_id}


@router.post("/{kb_id}/embed")
async def embed_kb_files(
    kb_id: int,
    payload: KnowledgeDBBulkEmbedRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """현재 KB의 파일들을 일괄 임베딩/재임베딩."""
    from services.embedding_service import get_provider_info

    kb = _get_kb_or_404(db, kb_id, current_user.id)
    info = get_provider_info()

    files = db.query(PDFFile).filter(
        PDFFile.knowledge_db_id == kb_id,
        PDFFile.user_id == current_user.id,
    ).order_by(PDFFile.uploaded_at.desc()).all()

    file_ids = [f.id for f in files]
    emb_map = {}
    if file_ids:
        embs = db.query(FileEmbedding).filter(
            FileEmbedding.file_id.in_(file_ids),
            FileEmbedding.provider == info["provider"],
            FileEmbedding.model == info["model"],
        ).all()
        emb_map = {emb.file_id: emb for emb in embs}

    scheduled: list[str] = []
    skipped: list[dict[str, str]] = []

    for file in files:
        file_status = _get_file_status_value(file)
        emb = emb_map.get(file.id)
        emb_status = emb.status if emb else "none"

        if file_status != "completed":
            skipped.append({"file_id": file.id, "reason": "분석이 완료되지 않은 파일입니다"})
            continue

        enrichment_status = str(getattr(file, "enrichment_status", "") or "")
        if enrichment_status in {"queued", "running"}:
            skipped.append({"file_id": file.id, "reason": "문서 보강이 아직 진행 중입니다"})
            continue

        if not file.segments_data:
            skipped.append({"file_id": file.id, "reason": "분석 데이터가 없습니다"})
            continue

        if emb_status in {"pending", "processing"}:
            skipped.append({"file_id": file.id, "reason": "이미 임베딩이 진행 중입니다"})
            continue

        if payload.mode == "missing" and emb_status not in {"none", "failed"}:
            skipped.append({"file_id": file.id, "reason": "이미 임베딩 완료된 파일입니다"})
            continue

        _mark_embedding_pending(db, file, info["provider"], info["model"])

        if payload.mode == "all":
            background_tasks.add_task(_reindex_file_to_kb, file.id, current_user.id, kb_id, info["model"])
        else:
            background_tasks.add_task(_index_file_to_kb, file.id, current_user.id, kb_id)
        scheduled.append(file.id)

    db.commit()

    mode_label = "전체 재임베딩" if payload.mode == "all" else "미임베딩/실패 파일 임베딩"
    if scheduled:
        message = f"'{kb.name}'에서 {len(scheduled)}개 파일의 {mode_label}을 시작했습니다"
    else:
        message = f"'{kb.name}'에서 시작할 {mode_label} 대상 파일이 없습니다"

    return {
        "kb_id": kb_id,
        "mode": payload.mode,
        "model": info["model"],
        "scheduled": scheduled,
        "scheduled_count": len(scheduled),
        "skipped": skipped,
        "skipped_count": len(skipped),
        "message": message,
    }


@router.get("/{kb_id}/available-files", response_model=List[KnowledgeDBFileResponse])
async def list_available_files(
    kb_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """지식DB에 추가/이동 가능한 파일 목록 (분석 완료 + 현재 KB 소속이 아닌 파일)"""
    from services.embedding_service import get_provider_info
    _get_kb_or_404(db, kb_id, current_user.id)

    info = get_provider_info()
    cur_provider = info["provider"]
    cur_model = info["model"]

    # 현재 KB 소속이 아닌 모든 완료 파일 (미할당 + 다른 KB 소속)
    files = db.query(PDFFile).filter(
        PDFFile.user_id == current_user.id,
        PDFFile.knowledge_db_id != kb_id,
    ).order_by(PDFFile.uploaded_at.desc()).all()

    # 소속 KB명 조회를 위한 KB id→name 맵
    kb_ids = {f.knowledge_db_id for f in files if f.knowledge_db_id is not None}
    kb_map = {}
    if kb_ids:
        kbs = db.query(KnowledgeDB).filter(KnowledgeDB.id.in_(kb_ids)).all()
        kb_map = {kb.id: kb.name for kb in kbs}

    # 현재 모델의 FileEmbedding 일괄 조회
    completed_files = [f for f in files
                       if (f.status.value if hasattr(f.status, 'value') else str(f.status)) == "completed"]
    file_ids = [f.id for f in completed_files]
    emb_map = {}
    if file_ids:
        embs = db.query(FileEmbedding).filter(
            FileEmbedding.file_id.in_(file_ids),
            FileEmbedding.provider == cur_provider,
            FileEmbedding.model == cur_model,
        ).all()
        emb_map = {e.file_id: e for e in embs}

    return [
        KnowledgeDBFileResponse(
            file_id=f.id,
            original_filename=f.original_filename,
            file_size=f.file_size,
            status=f.status.value if hasattr(f.status, 'value') else str(f.status),
            embedding_status=emb_map[f.id].status if f.id in emb_map else "none",
            embedding_chunks=emb_map[f.id].chunks if f.id in emb_map else 0,
            embedding_total_chunks=emb_map[f.id].total_chunks if f.id in emb_map else 0,
            embedding_processed_chunks=emb_map[f.id].processed_chunks if f.id in emb_map else 0,
            embedding_model=cur_model,
            embedding_at=emb_map[f.id].embedded_at if f.id in emb_map else None,
            content_version=emb_map[f.id].content_version if f.id in emb_map else None,
            total_pages=f.total_pages or 0,
            mime_type=f.mime_type,
            uploaded_at=f.uploaded_at,
            current_kb_name=kb_map.get(f.knowledge_db_id),
            enrichment_status=getattr(f, 'enrichment_status', 'none'),
            enrichment_error=getattr(f, 'enrichment_error', None),
        )
        for f in completed_files
    ]


@router.get("/{kb_id}/files/{file_id}/chunks")
async def get_file_chunks(
    kb_id: int,
    file_id: str,
    limit: int = 100,
    offset: int = 0,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """임베딩된 파일의 청크 내용 조회 (현재 활성 모델 기준)"""
    from services.embedding_service import get_provider_info
    _get_kb_or_404(db, kb_id, current_user.id)

    file = db.query(PDFFile).filter(
        PDFFile.id == file_id,
        PDFFile.user_id == current_user.id,
        PDFFile.knowledge_db_id == kb_id,
    ).first()

    if not file:
        raise HTTPException(status_code=404, detail={"error_code": "KB_FILE_NOT_FOUND", "message": "파일을 찾을 수 없습니다"})

    # 현재 모델의 FileEmbedding 확인
    info = get_provider_info()
    cur_emb = db.query(FileEmbedding).filter(
        FileEmbedding.file_id == file_id,
        FileEmbedding.provider == info["provider"],
        FileEmbedding.model == info["model"],
    ).first()

    if not cur_emb or cur_emb.status != "completed" or not cur_emb.chunks:
        return {"chunks": [], "total": 0}

    try:
        from services.vector_store import get_or_create_collection, collection_exists
        from services.rag_indexer import _get_collection_name as rag_get_collection_name, _get_legacy_collection_name

        # 현재 활성 모델 컬렉션에서 조회 (fallback: 레거시)
        collection_name = None
        candidate = rag_get_collection_name(current_user.id, f"kb{kb_id}", provider=info["provider"], model=info["model"])
        if collection_exists(candidate):
            collection_name = candidate

        if not collection_name:
            legacy = _get_legacy_collection_name(current_user.id, f"kb{kb_id}")
            if collection_exists(legacy):
                collection_name = legacy

        if not collection_name:
            return {"chunks": [], "total": 0}

        collection = get_or_create_collection(collection_name)
        results = collection.get(
            where={"file_id": file_id},
            include=["documents", "metadatas"],
        )

        if not results or not results.get("ids"):
            return {"chunks": [], "total": 0}

        # Combine and sort by chunk_index
        items = []
        for i, doc_id in enumerate(results["ids"]):
            meta = results["metadatas"][i] if results["metadatas"] else {}
            items.append({
                "id": doc_id,
                "text": results["documents"][i] if results["documents"] else "",
                "page": meta.get("page"),
                "segment_type": meta.get("segment_type"),
                "chunk_index": meta.get("chunk_index", i),
            })

        items.sort(key=lambda x: x["chunk_index"])
        total = len(items)

        # Apply pagination
        capped_limit = min(limit, 100)
        items = items[offset:offset + capped_limit]

        return {"chunks": items, "total": total}

    except Exception as e:
        print(f"[KnowledgeDB] Chunk retrieval failed: {e}")
        return {"chunks": [], "total": 0}
