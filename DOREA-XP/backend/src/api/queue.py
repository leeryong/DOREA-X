# User Queue Status API (non-admin, summary only)

from datetime import datetime
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List

from api.deps import get_current_user
from models.database import get_db, User, PDFFile
from services.processing_queue import processing_queue
from services.sidecar_runtime import analysis_provider_uses_gpu

router = APIRouter(prefix="/api/queue", tags=["Queue"])


class QueueStatusResponse(BaseModel):
    total_queued: int
    active_users: int
    avg_processing_time: float
    server_time: datetime


class MyQueueItemResponse(BaseModel):
    file_id: str
    filename: str
    position: int          # 전체 큐 내 순번 (1-based)
    eta_seconds: float     # 예상 대기시간 (초)
    enqueued_at: datetime
    analysis_provider: str
    uses_gpu: Optional[bool] = None
    status: str            # "processing" | "queued"


class MyQueueResponse(BaseModel):
    current: Optional[MyQueueItemResponse] = None   # 내 파일이 현재 처리 중이면
    queued: List[MyQueueItemResponse] = []           # 내 대기열 항목
    server_time: datetime


def _resolve_uses_gpu(analysis_provider: Optional[str]) -> Optional[bool]:
    return analysis_provider_uses_gpu(analysis_provider)


@router.get("/status", response_model=QueueStatusResponse)
async def get_queue_status(
    current_user: User = Depends(get_current_user),
):
    """
    인증 사용자용 큐 요약 API (admin 불필요)
    - 대기 건수, 활성 사용자 수, 평균 처리시간만 반환
    - 타 사용자 파일명/user_id 등 상세 정보 비노출
    """
    stats = await processing_queue.get_queue_stats()
    avg_time = processing_queue.get_avg_processing_time()

    return QueueStatusResponse(
        total_queued=stats["total_queued"],
        active_users=stats["active_users"],
        avg_processing_time=round(avg_time, 1),
        server_time=datetime.utcnow(),
    )


@router.get("/my-items", response_model=MyQueueResponse)
async def get_my_queue_items(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    본인의 큐 항목만 반환 (진행중 + 대기열)
    - 타 사용자 정보 비노출 (user_id, username 포함 안 함)
    - position/ETA는 전체 큐 기준으로 정확히 계산
    """
    user_id = current_user.id
    avg_time = processing_queue.get_avg_processing_time()

    # 1) 현재 처리 중인 아이템이 내 것인지 확인
    current = None
    current_info = processing_queue.get_current_item()
    if current_info:
        item, started_at = current_info
        if item.user_id == user_id:
            file_obj = db.query(PDFFile).filter(PDFFile.id == item.file_id).first()
            current = MyQueueItemResponse(
                file_id=item.file_id,
                filename=file_obj.original_filename if file_obj else "(알 수 없음)",
                position=0,
                eta_seconds=0,
                enqueued_at=item.enqueued_at,
                analysis_provider=item.analysis_provider,
                uses_gpu=_resolve_uses_gpu(item.analysis_provider),
                status="processing",
            )

    # 2) 대기열에서 내 항목 필터
    snapshot = await processing_queue.get_queue_snapshot()
    my_queued = []
    # file_id 일괄 조회용 수집
    my_file_ids = [fid for _, fid, uid, _, _ in snapshot if uid == user_id]
    files_map = {}
    if my_file_ids:
        files = db.query(PDFFile).filter(PDFFile.id.in_(my_file_ids)).all()
        files_map = {f.id: f for f in files}

    for position, file_id, uid, enqueued_at, analysis_provider in snapshot:
        if uid != user_id:
            continue
        file_obj = files_map.get(file_id)
        my_queued.append(MyQueueItemResponse(
            file_id=file_id,
            filename=file_obj.original_filename if file_obj else "(알 수 없음)",
            position=position,
            eta_seconds=round(position * avg_time, 1),
            enqueued_at=enqueued_at,
            analysis_provider=analysis_provider,
            uses_gpu=_resolve_uses_gpu(analysis_provider),
            status="queued",
        ))

    return MyQueueResponse(
        current=current,
        queued=my_queued,
        server_time=datetime.utcnow(),
    )
