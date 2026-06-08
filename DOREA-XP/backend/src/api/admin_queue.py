# Admin Queue Monitoring API

from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

from api.deps import get_current_user
from models.database import get_db, User, UserRole, PDFFile, FileStatus, FileDomain
from services.processing_queue import processing_queue
from services.sidecar_runtime import analysis_provider_uses_gpu

router = APIRouter(prefix="/api/admin", tags=["Admin"])


def _require_admin(user: User):
    if user.role not in (UserRole.ADMIN, UserRole.SUPER_ADMIN):
        raise HTTPException(
            status_code=403,
            detail={"error_code": "ADMIN_FORBIDDEN", "message": "관리자 권한이 필요합니다"},
        )


class QueueItemResponse(BaseModel):
    position: int
    file_id: str
    filename: str
    user_id: int
    username: str
    analysis_provider: str
    uses_gpu: Optional[bool] = None
    enqueued_at: datetime
    eta_seconds: float


class CurrentItemResponse(BaseModel):
    file_id: str
    filename: str
    user_id: int
    username: str
    analysis_provider: str
    uses_gpu: Optional[bool] = None
    started_at: datetime
    elapsed_seconds: float
    status: str


class QueueStatsResponse(BaseModel):
    total_queued: int
    active_users: int
    avg_processing_time: float
    stale_processing_count: int = 0      # DB상 ANALYZING/CONVERTING인데 큐에 없는 파일 수
    oldest_processing_seconds: Optional[float] = None  # 가장 오래된 처리 중 파일의 경과 시간(초)


class HistoryItemResponse(BaseModel):
    file_id: str
    filename: str
    user_id: int
    username: str
    analysis_provider: Optional[str] = None
    uses_gpu: Optional[bool] = None
    processing_started_at: Optional[datetime] = None
    converted_at: Optional[datetime] = None
    processing_completed_at: Optional[datetime] = None
    processing_duration_seconds: Optional[float] = None
    status: str


class AdminQueueResponse(BaseModel):
    stats: QueueStatsResponse
    current: Optional[CurrentItemResponse] = None
    queue: List[QueueItemResponse]
    history: List[HistoryItemResponse] = []
    server_time: datetime


def _resolve_uses_gpu(analysis_provider: Optional[str]) -> Optional[bool]:
    return analysis_provider_uses_gpu(analysis_provider)


def _normalize_history_since(history_since: Optional[datetime]) -> Optional[datetime]:
    if history_since is None:
        return None
    if history_since.tzinfo is None:
        return history_since
    return history_since.astimezone(timezone.utc).replace(tzinfo=None)


@router.get("/queue", response_model=AdminQueueResponse)
async def get_admin_queue(
    history_since: Optional[datetime] = Query(None),
    history_limit: int = Query(200, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    관리자용 큐 모니터링 API
    - 현재 큐 통계
    - 현재 처리 중인 아이템
    - 대기 중인 아이템 목록 (라운드로빈 순서)
    """
    _require_admin(current_user)
    
    # 큐 통계
    stats = await processing_queue.get_queue_stats()
    avg_time = processing_queue.get_avg_processing_time()
    
    # Stale processing diagnostics: DB상 ANALYZING/CONVERTING인데 큐 워커가 모르는 고아 파일
    stale_files = db.query(PDFFile).filter(
        PDFFile.status.in_([FileStatus.ANALYZING, FileStatus.CONVERTING])
    ).all()
    
    # 현재 워커가 처리 중인 파일은 stale이 아님
    current_info_for_stale = processing_queue.get_current_item()
    current_file_id = current_info_for_stale[0].file_id if current_info_for_stale else None
    
    stale_count = 0
    oldest_seconds = None
    now = datetime.utcnow()
    for sf in stale_files:
        if sf.id == current_file_id:
            continue  # 현재 처리 중 — stale 아님
        stale_count += 1
        # converted_at를 ANALYZING 시작 프록시로 사용 (Metis 지침)
        start_proxy = sf.converted_at or sf.enqueued_at or sf.uploaded_at
        if start_proxy:
            age = (now - start_proxy).total_seconds()
            if oldest_seconds is None or age > oldest_seconds:
                oldest_seconds = age
    
    # 현재 처리 중인 아이템
    current = None
    current_info = processing_queue.get_current_item()
    if current_info:
        item, started_at = current_info
        elapsed = (datetime.utcnow() - started_at).total_seconds()
        
        # DB에서 파일/유저 정보 조회
        file_obj = db.query(PDFFile).filter(PDFFile.id == item.file_id).first()
        user_obj = db.query(User).filter(User.id == item.user_id).first()
        
        current = CurrentItemResponse(
            file_id=item.file_id,
            filename=file_obj.original_filename if file_obj else "(알 수 없음)",
            user_id=item.user_id,
            username=user_obj.username if user_obj else "(알 수 없음)",
            analysis_provider=item.analysis_provider,
            uses_gpu=_resolve_uses_gpu(item.analysis_provider),
            started_at=started_at,
            elapsed_seconds=round(elapsed, 1),
            status=file_obj.status.value if file_obj else "unknown",
        )
    
    # 대기 목록 (라운드로빈 순서)
    snapshot = await processing_queue.get_queue_snapshot()
    queue_items = []
    
    # 파일 ID / 유저 ID 수집
    file_ids = [fid for _, fid, _, _, _ in snapshot]
    user_ids = list(set(uid for _, _, uid, _, _ in snapshot))
    
    # 일괄 조회
    files_map = {}
    if file_ids:
        files = db.query(PDFFile).filter(PDFFile.id.in_(file_ids)).all()
        files_map = {f.id: f for f in files}
    
    users_map = {}
    if user_ids:
        users = db.query(User).filter(User.id.in_(user_ids)).all()
        users_map = {u.id: u for u in users}
    
    for position, file_id, user_id, enqueued_at, analysis_provider in snapshot:
        file_obj = files_map.get(file_id)
        user_obj = users_map.get(user_id)
        
        queue_items.append(QueueItemResponse(
            position=position,
            file_id=file_id,
            filename=file_obj.original_filename if file_obj else "(알 수 없음)",
            user_id=user_id,
            username=user_obj.username if user_obj else "(알 수 없음)",
            analysis_provider=analysis_provider,
            uses_gpu=_resolve_uses_gpu(analysis_provider),
            enqueued_at=enqueued_at,
            eta_seconds=round(position * avg_time, 1),
        ))
    
    normalized_history_since = _normalize_history_since(history_since)
    history_items: list[HistoryItemResponse] = []
    if normalized_history_since is not None:
        recent_files = db.query(PDFFile, User).join(User, User.id == PDFFile.user_id).filter(
            or_(PDFFile.domain == FileDomain.ANALYSIS, PDFFile.domain.is_(None)),
            PDFFile.status.in_([FileStatus.COMPLETED, FileStatus.FAILED]),
            PDFFile.processing_completed_at.isnot(None),
            PDFFile.processing_completed_at >= normalized_history_since,
        ).order_by(PDFFile.processing_completed_at.desc()).limit(history_limit).all()

        history_items = [
            HistoryItemResponse(
                file_id=file_obj.id,
                filename=file_obj.original_filename,
                user_id=file_obj.user_id,
                username=user_obj.username if user_obj else "(알 수 없음)",
                analysis_provider=getattr(file_obj, "analysis_provider", None),
                uses_gpu=getattr(file_obj, "processing_uses_gpu", None),
                processing_started_at=getattr(file_obj, "processing_started_at", None),
                converted_at=file_obj.converted_at,
                processing_completed_at=getattr(file_obj, "processing_completed_at", None),
                processing_duration_seconds=getattr(file_obj, "processing_duration_seconds", None),
                status=file_obj.status.value if file_obj.status else "unknown",
            )
            for file_obj, user_obj in recent_files
        ]

    return AdminQueueResponse(
        stats=QueueStatsResponse(
            total_queued=stats["total_queued"],
            active_users=stats["active_users"],
            avg_processing_time=round(stats["avg_processing_time"], 1),
            stale_processing_count=stale_count,
            oldest_processing_seconds=round(oldest_seconds, 1) if oldest_seconds is not None else None,
        ),
        current=current,
        queue=queue_items,
        history=history_items,
        server_time=datetime.utcnow(),
    )
