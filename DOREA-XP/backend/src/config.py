"""
Backend Configuration Manager
"""
from functools import lru_cache
from pydantic_settings import BaseSettings
from typing import Optional
import os


class Settings(BaseSettings):
    """애플리케이션 설정"""

    # Application
    app_name: str = "DOREA-XP (공개용)"
    app_version: str = "1.0.0"
    environment: str = "development"

    # Database (SQLite)
    db_path: str = "/app/DATABASE/dorea.db"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.db_path}"

    # ChromaDB
    chroma_path: str = "/app/DATABASE/chroma"

    # JWT Security
    jwt_secret_key: str = "change-this-in-production"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 30
    refresh_token_expire_days: int = 7

    # Admin Bootstrap
    admin_initial_password: Optional[str] = None

    # Services
    opendataloader_url: str = "http://opendataloader:8005"
    ollama_url: str = "http://ollama:11434"
    ollama_keepalive_interval_seconds: int = 120
    ollama_keepalive_duration: str = "10m"
    converter_url: str = "http://document-converter:8003"
    mcp_service_url: str = "http://dorea-x-mcp-service:8002"
    mcp_timeout_seconds: int = 30  # MCP service call timeout

    # Frontend
    frontend_url: str = "http://localhost:8000"

    # File Upload
    max_file_size: int = 524288000  # 500MB
    chunk_size: int = 10485760      # 10MB
    max_concurrent_uploads: int = 3

    # Document Processing
    max_concurrent_analysis: int = 2
    analysis_timeout: int = 1200    # 20분
    conversion_timeout: int = 120   # 2분
    opendataloader_processing_timeout: Optional[int] = 1800  # 30분 (대용량 PDF 처리)

    # DOREA-XP 정책 한계값
    knowledge_db_max_documents: int = 10  # 일반문서 지식DB 슬롯 max
    quick_menu_max_count: int = 3         # 빠른메뉴 max

    # Sidecar Runtime Orchestration
    auto_start_sidecars: bool = True
    sidecar_compose_project_name: str = "dorea-x"
    sidecar_compose_project_dir: str = "/workspace"
    sidecar_compose_mode: str = "auto"
    sidecar_base_compose_file: str = "docker-compose.yml"
    sidecar_gpu_compose_file: str = "docker-compose.gpu.yml"
    sidecar_compose_files: str = ""
    sidecar_start_timeout_seconds: int = 300
    sidecar_health_retry_interval_seconds: float = 2.0
    sidecar_gpu_probe_timeout_seconds: int = 8
    sidecar_gpu_probe_cache_seconds: int = 60
    keep_analysis_sidecars_warm: bool = True

    def get_processing_timeout_for_provider(self, analysis_provider: Optional[str] = None) -> int:
        # DOREA-XP: opendataloader 단일 분석기
        if self.opendataloader_processing_timeout is not None:
            return self.opendataloader_processing_timeout
        return max(self.analysis_timeout, self.conversion_timeout) + 60
    
    # CORS
    allowed_origins: list[str] = ["http://localhost:3000"]
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False


@lru_cache()
def get_settings() -> Settings:
    """설정 인스턴스 반환 (싱글톤)"""
    return Settings()


# 전역 설정 인스턴스
settings = get_settings()
