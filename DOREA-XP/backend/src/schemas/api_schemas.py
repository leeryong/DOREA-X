# Pydantic Schemas for API Request/Response

from pydantic import BaseModel, EmailStr, Field, HttpUrl
from typing import Optional, List, Dict, Any, Literal
from datetime import datetime
from models.database import UserRole, AccountStatus, FileStatus

# ========== Auth Schemas ==========

class UserRegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    email: EmailStr
    password: str = Field(..., min_length=8)
    phone: Optional[str] = Field(None, max_length=20)  # 연락처 (선택)
    # 추후 확장 필드
    company_name: Optional[str] = Field(None, max_length=100)  # 회사명
    department: Optional[str] = Field(None, max_length=100)    # 부서명

class UserLoginRequest(BaseModel):
    username_or_email: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int = 86400
    refresh_token: Optional[str] = None

class UserResponse(BaseModel):
    id: int
    public_id: str
    username: str
    email: str
    role: UserRole
    status: AccountStatus
    display_name: Optional[str] = None
    avatar_url: Optional[str] = None
    created_at: datetime
    user_level: int | None = None

class UserSettingsResponse(BaseModel):
    default_model: str
    max_tokens: int
    temperature: float
    ocr_language: str
    use_ocr: bool
    persona_custom_markdown: str = ""


class UserSettingsUpdateRequest(BaseModel):
    default_model: Optional[str] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    ocr_language: Optional[str] = None
    use_ocr: Optional[bool] = None
    persona_custom_markdown: Optional[str] = Field(None, max_length=4000)
# ========== File Schemas ==========

class AdminUserResponse(BaseModel):
    id: int
    public_id: str
    username: str
    email: str
    role: UserRole
    status: AccountStatus
    user_level: int
    created_at: datetime


class AdminUserListResponse(BaseModel):
    users: List[AdminUserResponse]
    total: int


class AdminUserCreateRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    email: EmailStr
    password: str = Field(..., min_length=8)
    status: AccountStatus = AccountStatus.PENDING
    role: UserRole = UserRole.USER
    user_level: int = Field(9, ge=0, le=10)


class AdminUserUpdateRequest(BaseModel):
    email: EmailStr | None = None
    status: AccountStatus | None = None
    role: UserRole | None = None
    user_level: int | None = Field(None, ge=0, le=10)


class FileUploadResponse(BaseModel):
    file_id: str
    filename: str
    file_size: int
    status: FileStatus
    queue_position: Optional[int] = None  # 대기열 순서 (1-based)
    eta_seconds: Optional[float] = None   # 예상 완료 시간 (초)

class FileResponse(BaseModel):
    id: str
    filename: str
    file_size: int
    status: FileStatus
    total_pages: int
    mime_type: str
    uploaded_at: datetime
    converted_at: Optional[datetime] = None
    analyzed_at: Optional[datetime] = None
    # 큐 관련 정보 (status가 QUEUED/CONVERTING/ANALYZING일 때만 의미 있음)
    queue_position: Optional[int] = None  # 대기열 순서 (1-based, 0=현재 처리중)
    eta_seconds: Optional[float] = None   # 예상 완료 시간 (초)
    error_code: Optional[str] = None       # 실패 유형 분류 코드 (e.g. FILES_CONVERSION_FAILED)
    error_message: Optional[str] = None   # 실패 시 에러 메시지
    # Enrichment (멀티모달 보강)
    enrichment_status: Optional[str] = None  # none, completed, failed, skipped_unconfigured
    enrichment_error: Optional[str] = None

class FileListResponse(BaseModel):
    files: List[FileResponse]
    total: int
    queue_stats: Optional[dict] = None  # 전체 큐 통계 (선택)

# ========== Folder Schemas ==========

class FolderCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    parent_id: Optional[int] = None

class FolderResponse(BaseModel):
    id: int
    name: str
    description: Optional[str] = None
    parent_id: Optional[int] = None
    created_at: datetime
    user_level: int | None = None
    files: List[FileResponse] = []

# ========== Chat Schemas ==========

class ChatSessionCreateRequest(BaseModel):
    file_id: Optional[str] = None  # 문서 없이도 채팅 가능
    session_name: Optional[str] = None

class ChatSessionResponse(BaseModel):
    id: int
    file_id: Optional[str] = None
    session_name: Optional[str]
    created_at: datetime
    user_level: int | None = None


class ChatModelSelection(BaseModel):
    provider: Literal["openai", "claude", "ollama"]
    model: str = Field(..., min_length=1)

class ChatMessageRequest(BaseModel):
    content: str = Field(..., min_length=1)
    selected_segments: Optional[List[Dict[str, Any]]] = None
    knowledge_db: Optional[str] = None  # "none" | "default" | "{user-db}" — RAG 검색 범위
    mcp_skills: Optional[List[Dict[str, Any]]] = None  # [{id, name, display_name, server_type, description}, ...]
    model_override: Optional[ChatModelSelection] = None

    # ========== Editor Command Context (optional, backward compatible) ==========
    editor_command: Optional[Dict[str, Any]] = None  # {type: 'insert'|'rewrite'|'style'|'replace', target_range?, anchor?, revision_hash?, risk_tier?}

class ChatMessageResponse(BaseModel):
    id: int
    content: str
    is_user: bool
    selected_segments: Optional[List[Dict[str, Any]]] = None
    model_used: Optional[str] = None
    tokens_used: Optional[int] = None
    created_at: datetime
    user_level: int | None = None

# ========== AI Query Schemas ==========

class AIQueryRequest(BaseModel):
    query: str = Field(..., min_length=1)
    segments: Optional[List[Dict[str, Any]]] = None
    model: Optional[str] = None
    max_tokens: Optional[int] = None
    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)

class AIQueryResponse(BaseModel):
    content: str
    model_used: str
    tokens_used: Optional[int] = None

# ========== Error Schemas ==========

class ErrorResponse(BaseModel):
    error: str
    detail: Optional[str] = None


