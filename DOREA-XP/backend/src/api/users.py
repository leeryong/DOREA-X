
# User Management Routes

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from api.deps import get_current_user
from api.auth import get_password_hash
from models.database import get_db, User, UserRole, AccountStatus, UserSettings
from schemas.api_schemas import (
    UserResponse,
    AdminUserResponse,
    AdminUserListResponse,
    AdminUserCreateRequest,
    AdminUserUpdateRequest,
)

router = APIRouter(prefix="/api/users", tags=["Users"])


def _require_admin(user: User):
    if user.role not in (UserRole.ADMIN, UserRole.SUPER_ADMIN):
        raise HTTPException(
            status_code=403,
            detail={"error_code": "USERS_FORBIDDEN", "message": "관리자 권한이 필요합니다"},
        )


@router.get("/me", response_model=UserResponse)
async def get_current_user_profile(current_user: User = Depends(get_current_user)):
    """현재 사용자 정보 조회"""
    return UserResponse(
        id=current_user.id,
        public_id=current_user.public_id,
        username=current_user.username,
        email=current_user.email,
        role=current_user.role,
        status=current_user.status,
        display_name=current_user.display_name,
        avatar_url=current_user.avatar_url,
        created_at=current_user.created_at,
        user_level=getattr(current_user, 'user_level', None),
    )

def _status_from_level(level: int) -> AccountStatus:
    if level == 10:
        return AccountStatus.DEACTIVATED
    if level == 9:
        return AccountStatus.PENDING
    return AccountStatus.ACTIVE


def _level_from_status(status: AccountStatus, is_admin: bool) -> int:
    if status == AccountStatus.PENDING:
        return 9
    if status == AccountStatus.DEACTIVATED:
        return 10
    # ACTIVE
    return 0 if is_admin else 8



@router.put("/me")
async def update_current_user_profile(
    display_name: str = None,
    bio: str = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """현재 사용자 정보 수정"""
    if display_name is not None:
        current_user.display_name = display_name

    if bio is not None:
        current_user.bio = bio

    db.commit()

    return UserResponse(
        id=current_user.id,
        public_id=current_user.public_id,
        username=current_user.username,
        email=current_user.email,
        role=current_user.role,
        status=current_user.status,
        display_name=current_user.display_name,
        avatar_url=current_user.avatar_url,
        created_at=current_user.created_at,
        user_level=getattr(current_user, 'user_level', None),
    )


# ========== Admin User Management ==========

@router.get("/", response_model=AdminUserListResponse)
async def admin_list_users(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)

    q = db.query(User).filter(User.role == UserRole.USER)
    total = q.count()
    users = q.order_by(User.id.asc()).offset(skip).limit(limit).all()

    return AdminUserListResponse(
        users=[
            AdminUserResponse(
                id=u.id,
                public_id=u.public_id,
                username=u.username,
                email=u.email,
                role=u.role,
                status=u.status,
                user_level=(u.user_level if u.user_level is not None else 9),
                created_at=u.created_at,
            )
            for u in users
        ],
        total=total,
    )


@router.post("/", response_model=AdminUserResponse)
async def admin_create_user(
    payload: AdminUserCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)

    if payload.status == AccountStatus.SUSPENDED:
        raise HTTPException(status_code=400, detail={"error_code": "USERS_STATUS_NOT_ALLOWED", "message": "정지 상태는 사용할 수 없습니다"})

    # Apply coupling rules
    if payload.user_level == 10:
        payload.status = AccountStatus.DEACTIVATED
    elif payload.user_level == 9:
        payload.status = AccountStatus.PENDING
    elif payload.user_level == 0:
        payload.status = AccountStatus.ACTIVE
    else:
        payload.status = AccountStatus.ACTIVE

    if db.query(User).filter(User.username == payload.username).first():
        raise HTTPException(
            status_code=400,
            detail={"error_code": "USERS_USERNAME_EXISTS", "message": "이미 존재하는 사용자 이름입니다"},
        )
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(
            status_code=400,
            detail={"error_code": "USERS_EMAIL_EXISTS", "message": "이미 존재하는 이메일입니다"},
        )

    user = User(
        username=payload.username,
        email=payload.email,
        hashed_password=get_password_hash(payload.password),
        role=payload.role,
        status=payload.status,
        user_level=payload.user_level,
        is_email_verified=True if payload.status == AccountStatus.ACTIVE else False,
    )

    db.add(user)
    db.commit()
    db.refresh(user)

    return AdminUserResponse(
        id=user.id,
        public_id=user.public_id,
        username=user.username,
        email=user.email,
        role=user.role,
        status=user.status,
        user_level=(user.user_level if user.user_level is not None else 9),
        created_at=user.created_at,
    )


@router.patch("/{user_id}", response_model=AdminUserResponse)
async def admin_update_user(
    user_id: int,
    payload: AdminUserUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "USERS_NOT_FOUND", "message": "사용자를 찾을 수 없습니다"},
        )

    if user.role in (UserRole.ADMIN, UserRole.SUPER_ADMIN):
        raise HTTPException(
            status_code=400,
            detail={"error_code": "USERS_CANNOT_MODIFY_ADMIN", "message": "관리자 계정은 수정할 수 없습니다"},
        )


    if payload.email is not None:
        # unique check
        exists = db.query(User).filter(User.email == payload.email, User.id != user_id).first()
        if exists:
            raise HTTPException(
                status_code=400,
                detail={"error_code": "USERS_EMAIL_EXISTS", "message": "이미 존재하는 이메일입니다"},
            )
        user.email = payload.email
    # Status / level coupling rules
    is_admin_account = user.role in (UserRole.ADMIN, UserRole.SUPER_ADMIN)

    if payload.status is not None and payload.status == AccountStatus.SUSPENDED:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "USERS_STATUS_NOT_ALLOWED", "message": "정지 상태는 사용할 수 없습니다"},
        )

    if payload.user_level is not None:
        level = int(payload.user_level)
        if level < 0 or level > 10:
            raise HTTPException(
                status_code=400,
                detail={"error_code": "USERS_LEVEL_INVALID", "message": "등급은 0~10 범위여야 합니다"},
            )
        user.user_level = level
        user.status = _status_from_level(level)
    elif payload.status is not None:
        user.status = payload.status
        user.user_level = _level_from_status(payload.status, is_admin_account)

    db.commit()

    return AdminUserResponse(
        id=user.id,
        public_id=user.public_id,
        username=user.username,
        email=user.email,
        role=user.role,
        status=user.status,
        user_level=(user.user_level if user.user_level is not None else 9),
        created_at=user.created_at,
    )


@router.delete("/{user_id}")
async def admin_delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "USERS_NOT_FOUND", "message": "사용자를 찾을 수 없습니다"},
        )

    if user.role in (UserRole.ADMIN, UserRole.SUPER_ADMIN):
        raise HTTPException(
            status_code=400,
            detail={"error_code": "USERS_CANNOT_DELETE_ADMIN", "message": "관리자 계정은 삭제할 수 없습니다"},
        )


    # Prevent deleting yourself
    if user.id == current_user.id:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "USERS_CANNOT_DELETE_SELF", "message": "자기 자신은 삭제할 수 없습니다"},
        )

    db.delete(user)
    db.commit()

    return {"deleted": True, "user_id": user_id}


# ========== Admin: Read-Only User Personal Settings Inspection ==========

def _mask_api_key(key: str) -> str:
    """API 키를 마스킹 (앞 4자리 + ****)"""
    if not key or len(key) < 8:
        return "****" if key else ""
    return key[:4] + "****" + key[-4:]


class AdminUserSettingsResponse(BaseModel):
    user_id: int
    has_settings: bool = False
    default_model: Optional[str] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    personal_api_key_masked: Optional[str] = None  # 마스킹된 키
    has_personal_api_key: bool = False
    ocr_language: Optional[str] = None
    use_ocr: Optional[bool] = None


@router.get("/{user_id}/settings", response_model=AdminUserSettingsResponse)
async def admin_get_user_settings(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    관리자 전용: 사용자 개인 설정 읽기 전용 조회 (진단 목적)
    - API 키는 마스킹하여 반환
    - 수정 기능 없음 (읽기 전용)
    """
    _require_admin(current_user)
    
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "USERS_NOT_FOUND", "message": "사용자를 찾을 수 없습니다"},
        )
    
    settings = db.query(UserSettings).filter(UserSettings.user_id == user_id).first()
    if not settings:
        return AdminUserSettingsResponse(user_id=user_id, has_settings=False)
    
    print(f"[Telemetry] Admin {current_user.id} inspected personal settings for user {user_id}")
    
    return AdminUserSettingsResponse(
        user_id=user_id,
        has_settings=True,
        default_model=settings.default_model,
        max_tokens=settings.max_tokens,
        temperature=settings.temperature,
        personal_api_key_masked=_mask_api_key(settings.personal_api_key) if settings.personal_api_key else None,
        has_personal_api_key=bool(settings.personal_api_key),
        ocr_language=settings.ocr_language,
        use_ocr=settings.use_ocr,
    )


