# Authentication Routes

from fastapi import APIRouter, HTTPException, Depends, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from passlib.context import CryptContext
from jose import jwt, JWTError
from datetime import datetime, timedelta
import hashlib
from typing import Optional

from models.database import get_db, User, UserSettings, UserRole, AccountStatus
from schemas.api_schemas import (
    UserRegisterRequest, UserLoginRequest, TokenResponse,
    UserResponse, UserSettingsResponse, UserSettingsUpdateRequest
)
from config import settings
from api.deps import get_current_user

router = APIRouter(prefix="/api/auth", tags=["authentication"])
security = HTTPBearer()

# Password hashing
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


# ========== JWT Utilities ==========

def verify_password(plain: str, hashed: str) -> bool:
    """비밀번호 검증"""
    return pwd_context.verify(plain, hashed)


def get_password_hash(password: str) -> str:
    """비밀번호 해싱"""
    return pwd_context.hash(password)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """JWT 액세스 토큰 생성"""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(hours=24)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    return encoded_jwt


# ========== Authentication ==========

@router.get("/check-username")
async def check_username(username: str, db: Session = Depends(get_db)):
    """아이디 중복 확인"""
    if not username or len(username.strip()) < 3:
        raise HTTPException(status_code=400, detail={"error_code": "AUTH_USERNAME_INVALID", "message": "아이디는 3자 이상이어야 합니다"})
    
    # 예약된 아이디 체크
    reserved = ['admin', 'administrator', 'root', 'system']
    if username.strip().lower() in reserved:
        return {"available": False, "message": "예약된 아이디입니다"}
    
    # DB에서 중복 확인
    exists = db.query(User).filter(User.username == username.strip()).first()
    
    return {
        "available": not exists,
        "message": "사용 가능한 아이디입니다" if not exists else "이미 사용 중인 아이디입니다"
    }


@router.post("/register", response_model=UserResponse)
async def register(request: UserRegisterRequest, db: Session = Depends(get_db)):
    """회원가입"""
    # Reserved usernames
    if request.username.strip().lower() == 'admin':
        raise HTTPException(status_code=400, detail={"error_code": "AUTH_USERNAME_RESERVED", "message": "예약된 사용자 이름입니다"})

    # 중복 확인
    if db.query(User).filter(User.username == request.username).first():
        raise HTTPException(status_code=400, detail={"error_code": "AUTH_USERNAME_EXISTS", "message": "이미 존재하는 사용자 이름입니다"})
    
    if db.query(User).filter(User.email == request.email).first():
        raise HTTPException(status_code=400, detail={"error_code": "AUTH_EMAIL_EXISTS", "message": "이미 존재하는 이메일입니다"})
    
    # 사용자 생성
    hashed_password = get_password_hash(request.password)
    new_user = User(
        username=request.username,
        email=request.email,
        hashed_password=hashed_password,
        role=UserRole.USER,
        status=AccountStatus.PENDING,
            user_level=9,
        phone=request.phone,
        company_name=request.company_name,
        department=request.department
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    # 기본 설정 생성
    user_settings = UserSettings(user_id=new_user.id)
    db.add(user_settings)
    db.commit()
    
    return UserResponse(
        id=new_user.id,
        public_id=new_user.public_id,
        username=new_user.username,
        email=new_user.email,
        role=new_user.role,
        status=new_user.status,
        created_at=new_user.created_at
    )


@router.post("/login", response_model=TokenResponse)
async def login(request: UserLoginRequest, db: Session = Depends(get_db)):
    """로그인 (아이디/이메일 + 비밀번호)"""
    # 사용자 조회 (username 또는 email)
    user = db.query(User).filter(
        (User.username == request.username_or_email) |
        (User.email == request.username_or_email)
    ).first()
    
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error_code": "AUTH_INVALID_CREDENTIALS", "message": "잘못된 사용자 이름 또는 비밀번호입니다"}
        )
    
    if not verify_password(request.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error_code": "AUTH_INVALID_CREDENTIALS", "message": "잘못된 사용자 이름 또는 비밀번호입니다"}
        )
    
    # 계정 상태 확인
    if user.status != AccountStatus.ACTIVE:
        raise HTTPException(status_code=403, detail={"error_code": "AUTH_ACCOUNT_INACTIVE", "message": "계정이 활성화되지 않았습니다"})
    
    # JWT 토큰 생성
    access_token = create_access_token(data={"sub": user.username})
    
    # 마지막 로그인 업데이트
    user.last_login_at = datetime.utcnow()
    db.commit()
    
    return TokenResponse(
        access_token=access_token,
        token_type="bearer",
        expires_in=86400
    )


# ========== Current User Info ==========

@router.get("/me", response_model=UserResponse)
async def get_me(current_user: User = Depends(get_current_user)):
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
        created_at=current_user.created_at
    )


@router.get("/me/settings", response_model=UserSettingsResponse)
async def get_my_settings(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """현재 사용자 설정 조회"""
    settings_obj = db.query(UserSettings).filter(UserSettings.user_id == current_user.id).first()
    
    if not settings_obj:
        # 기본 설정 생성
        settings_obj = UserSettings(user_id=current_user.id)
        db.add(settings_obj)
        db.commit()
    
    return UserSettingsResponse(
        default_model=settings_obj.default_model,
        max_tokens=settings_obj.max_tokens,
        temperature=settings_obj.temperature,
        ocr_language=settings_obj.ocr_language,
        use_ocr=settings_obj.use_ocr,
        persona_custom_markdown=(settings_obj.persona_custom_markdown or "").strip(),
    )


@router.put("/me/settings", response_model=UserSettingsResponse)
async def update_my_settings(
    payload: UserSettingsUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """현재 사용자 설정 업데이트"""
    settings_obj = db.query(UserSettings).filter(UserSettings.user_id == current_user.id).first()

    if not settings_obj:
        settings_obj = UserSettings(user_id=current_user.id)
        db.add(settings_obj)
        db.commit()

    if payload.default_model is not None:
        settings_obj.default_model = payload.default_model
    if payload.max_tokens is not None:
        settings_obj.max_tokens = payload.max_tokens
    if payload.temperature is not None:
        settings_obj.temperature = payload.temperature
    if payload.ocr_language is not None:
        settings_obj.ocr_language = payload.ocr_language
    if payload.use_ocr is not None:
        settings_obj.use_ocr = payload.use_ocr
    if payload.persona_custom_markdown is not None:
        settings_obj.persona_custom_markdown = payload.persona_custom_markdown.strip()

    db.commit()

    return UserSettingsResponse(
        default_model=settings_obj.default_model,
        max_tokens=settings_obj.max_tokens,
        temperature=settings_obj.temperature,
        ocr_language=settings_obj.ocr_language,
        use_ocr=settings_obj.use_ocr,
        persona_custom_markdown=(settings_obj.persona_custom_markdown or "").strip(),
    )
