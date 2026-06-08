# Database Models

from sqlalchemy import create_engine, Column, Integer, String, DateTime, Text, JSON, ForeignKey, Boolean, Enum, Float, event, UniqueConstraint
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from sqlalchemy.sql import func
from enum import Enum as PyEnum
import uuid
import os
from config import settings

Base = declarative_base()

# SQLite 디렉토리 생성
os.makedirs(os.path.dirname(settings.db_path), exist_ok=True)

# ========== Enum Definitions ==========

class UserRole(PyEnum):
    SUPER_ADMIN = "super_admin"
    ADMIN = "admin"
    USER = "user"

class AccountStatus(PyEnum):
    ACTIVE = "active"
    SUSPENDED = "suspended"
    PENDING = "pending"
    DEACTIVATED = "deactivated"

class FileStatus(PyEnum):
    UPLOADING = "uploading"
    QUEUED = "queued"          # 처리 대기열에 등록됨
    CONVERTING = "converting"
    ANALYZING = "analyzing"
    STORED = "stored"
    COMPLETED = "completed"
    FAILED = "failed"


class FileDomain(PyEnum):
    ANALYSIS = "analysis"
    MY_DOCUMENTS = "my_documents"

# ========== User Model ==========

class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    public_id = Column(String(36), unique=True, default=lambda: str(uuid.uuid4()))
    
    # Authentication
    username = Column(String(50), unique=True, index=True, nullable=False)
    email = Column(String(255), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    
    # Role & Status
    role = Column(Enum(UserRole), default=UserRole.USER)
    status = Column(Enum(AccountStatus), default=AccountStatus.ACTIVE)

    # Membership Level (0=admin, 9=default user)
    user_level = Column(Integer, default=9)
    
    # Security
    is_email_verified = Column(Boolean, default=False)
    last_login_at = Column(DateTime, nullable=True)
    last_login_ip = Column(String(45), nullable=True)
    failed_login_attempts = Column(Integer, default=0)
    locked_until = Column(DateTime, nullable=True)
    
    # Personal Info
    display_name = Column(String(100), nullable=True)
    avatar_url = Column(String(500), nullable=True)
    bio = Column(Text, nullable=True)
    phone = Column(String(20), nullable=True)  # 연락처
    
    # Organization Info (확장용)
    company_name = Column(String(100), nullable=True)  # 회사명
    department = Column(String(100), nullable=True)    # 부서명
    
    # Timestamps
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    
    # Relationships
    files = relationship("PDFFile", back_populates="user", cascade="all, delete-orphan")
    folders = relationship("Folder", back_populates="user", cascade="all, delete-orphan")
    chat_sessions = relationship("ChatSession", back_populates="user", cascade="all, delete-orphan")
    settings = relationship("UserSettings", back_populates="user", uselist=False, cascade="all, delete-orphan")
    knowledge_dbs = relationship("KnowledgeDB", back_populates="user", cascade="all, delete-orphan")

# ========== User Settings Model ==========

class UserSettings(Base):
    __tablename__ = "user_settings"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, unique=True, index=True)
    
    # AI Model Settings
    default_model = Column(String(50), default="gpt-4o")
    max_tokens = Column(Integer, default=4000)
    temperature = Column(Float, default=0.7)
    
    # OpenAI API Key (Personal fallback)
    personal_api_key = Column(String(255), nullable=True)
    
    # OCR Settings
    ocr_language = Column(String(10), default="ko")
    use_ocr = Column(Boolean, default=True)
    
    # Memory Settings
    memory_enabled = Column(Boolean, default=True)
    
    # Persona Settings
    persona_custom_markdown = Column(Text, default="")
    
    # Timestamps
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    
    # Relationships
    user = relationship("User", back_populates="settings")


# ========== Knowledge DB Model ==========

class KnowledgeDB(Base):
    __tablename__ = "knowledge_dbs"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    name = Column(String(100), nullable=False)
    description = Column(Text, nullable=True)
    
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    
    # Relationships
    user = relationship("User", back_populates="knowledge_dbs")
    files = relationship("PDFFile", back_populates="knowledge_db")

# ========== Folder Model ==========

class Folder(Base):
    __tablename__ = "folders"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    parent_id = Column(Integer, ForeignKey("folders.id"), nullable=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    
    # Relationships
    user = relationship("User", back_populates="folders")
    parent = relationship("Folder", remote_side=[id], back_populates="children")
    children = relationship("Folder", back_populates="parent")
    files = relationship("PDFFile", back_populates="folder")

# ========== PDF File Model ==========

class PDFFile(Base):
    __tablename__ = "files"
    
    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    folder_id = Column(Integer, ForeignKey("folders.id"), nullable=True, index=True)
    knowledge_db_id = Column(Integer, ForeignKey("knowledge_dbs.id", ondelete="SET NULL"), nullable=True, index=True)
    
    # File Info
    original_filename = Column(String(255), nullable=False)
    filename = Column(String(255), nullable=False)
    file_path = Column(String(500), nullable=False)
    file_size = Column(Integer, nullable=False)
    mime_type = Column(String(100), default="application/pdf")
    origin = Column(String(20), default='uploaded')  # 'uploaded' | 'authored'
    domain = Column(Enum(FileDomain), nullable=True, default=FileDomain.ANALYSIS)
    
    # Processing Status
    status = Column(Enum(FileStatus), default=FileStatus.UPLOADING)
    error_code = Column(String(60), nullable=True)     # 실패 유형 분류 코드 (e.g. FILES_CONVERSION_FAILED)
    error_message = Column(Text, nullable=True)
    
    # Document Analysis
    analysis_provider = Column(String(20), default="opendataloader")
    analysis_generation = Column(Integer, default=1)
    segments_data = Column(JSON, nullable=True)
    total_pages = Column(Integer, default=0)
    
    # Embeddings (RAG)
    embedding_status = Column(String(20), default="none")  # none, processing, completed, failed
    embedding_chunks = Column(Integer, default=0)
    embedding_model = Column(String(100), nullable=True)
    content_version = Column(String(64), nullable=True)  # 재인덱싱 추적용 해시
    embedding_total_chunks = Column(Integer, default=0)      # 임베딩 대상 총 청크 수
    embedding_processed_chunks = Column(Integer, default=0)  # 현재까지 임베딩 완료된 청크 수
    
    # Timestamps
    uploaded_at = Column(DateTime, default=func.now())
    enqueued_at = Column(DateTime, nullable=True)  # 처리 대기열 등록 시각
    processing_started_at = Column(DateTime, nullable=True)
    converted_at = Column(DateTime, nullable=True)
    analyzed_at = Column(DateTime, nullable=True)
    processing_completed_at = Column(DateTime, nullable=True)
    processing_duration_seconds = Column(Float, nullable=True)
    processing_uses_gpu = Column(Boolean, nullable=True)
    embedding_at = Column(DateTime, nullable=True)
    
    # Enrichment (멀티모달 보강)
    enrichment_status = Column(String(30), default="none")  # none, queued, running, completed, failed, skipped_unconfigured
    enrichment_error = Column(Text, nullable=True)
    enrichment_generation = Column(Integer, default=0)
    enrichment_total_targets = Column(Integer, default=0)
    enrichment_processed_targets = Column(Integer, default=0)
    enrichment_model_provider = Column(String(20), nullable=True)
    enrichment_model_name = Column(String(100), nullable=True)
    enrichment_enqueued_at = Column(DateTime, nullable=True)
    enrichment_started_at = Column(DateTime, nullable=True)
    enrichment_completed_at = Column(DateTime, nullable=True)
    
    # Relationships
    user = relationship("User", back_populates="files")
    folder = relationship("Folder", back_populates="files")
    knowledge_db = relationship("KnowledgeDB", back_populates="files")
    chat_sessions = relationship("ChatSession", back_populates="file", cascade="all, delete-orphan")
    embeddings = relationship("FileEmbedding", back_populates="file", cascade="all, delete-orphan")


# ========== File Embedding Model (per-model embedding state) ==========

class FileEmbedding(Base):
    __tablename__ = "file_embeddings"
    __table_args__ = (
        UniqueConstraint('file_id', 'provider', 'model', name='uq_file_provider_model'),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    file_id = Column(String(36), ForeignKey("files.id", ondelete="CASCADE"), nullable=False, index=True)
    provider = Column(String(20), nullable=False)       # "openai" / "ollama"
    model = Column(String(100), nullable=False)          # "text-embedding-3-small" / "bge-m3"
    status = Column(String(20), default="none")          # none / pending / processing / completed / failed
    chunks = Column(Integer, default=0)
    total_chunks = Column(Integer, default=0)
    processed_chunks = Column(Integer, default=0)
    content_version = Column(String(64), nullable=True)
    error_message = Column(Text, nullable=True)
    embedded_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    file = relationship("PDFFile", back_populates="embeddings")


# ========== Chat Session Model ==========

class ChatSession(Base):
    __tablename__ = "chat_sessions"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    file_id = Column(String(36), ForeignKey("files.id"), nullable=True)  # 문서 없이도 채팅 가능
    session_name = Column(String(200), nullable=True)
    is_title_user_edited = Column(Boolean, default=False, nullable=False)
    
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())
    
    # Relationships
    user = relationship("User", back_populates="chat_sessions")
    file = relationship("PDFFile", back_populates="chat_sessions")
    messages = relationship("ChatMessage", back_populates="session", cascade="all, delete-orphan")

# ========== Chat Message Model ==========

class ChatMessage(Base):
    __tablename__ = "chat_messages"
    
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("chat_sessions.id"), nullable=False)
    content = Column(Text, nullable=False)
    is_user = Column(Boolean, nullable=False)
    
    # Context
    selected_segments = Column(JSON, nullable=True)
    
    # Attachments (파일 경로 목록)
    attachments = Column(JSON, nullable=True)  # [{filename, path, size, mime_type}]
    
    # AI Response Info (legacy - kept for backward compatibility)
    model_used = Column(String(100), nullable=True)
    tokens_used = Column(Integer, nullable=True)
    
    # AI Model Metadata (detailed info for both user and assistant messages)
    # Format: {"requested": {"provider": "...", "model": "...", "temperature": ..., "max_tokens": ...},
    #          "used": {"provider": "...", "model": "...", "temperature": ..., "max_tokens": ...},
    #          "tokens_used": ..., "latency_ms": ...}
    model_metadata = Column(JSON, nullable=True)
    
    created_at = Column(DateTime, default=func.now())
    
    # Relationships
    session = relationship("ChatSession", back_populates="messages")

# ========== System Settings Model ==========

class SystemSetting(Base):
    __tablename__ = "system_settings"
    
    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=False)
    description = Column(String(500), nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

# ========== MCP Models ==========

class McpServer(Base):
    __tablename__ = "mcp_servers"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False, unique=True)
    display_name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    server_type = Column(String(20), nullable=False, default="mcp")
    icon = Column(String(100), nullable=True)

    # Connection config (for MCP type only, nullable for skills)
    transport = Column(String(50), nullable=True)
    endpoint_url = Column(String(500), nullable=True)

    # Admin control
    enabled = Column(Boolean, default=True)
    is_default = Column(Boolean, default=False)
    sort_order = Column(Integer, default=0)

    # Metadata
    config_json = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    # Relationships
    user_preferences = relationship("UserMcpPreference", back_populates="mcp_server", cascade="all, delete-orphan")
    skill_package = relationship("SkillPackage", back_populates="mcp_server", uselist=False, cascade="all, delete-orphan")


class SkillPackage(Base):
    """Imported skill bundle metadata — linked 1:1 to McpServer(server_type='skill')"""
    __tablename__ = "skill_packages"

    id = Column(Integer, primary_key=True, index=True)
    mcp_server_id = Column(Integer, ForeignKey("mcp_servers.id", ondelete="CASCADE"), nullable=False, unique=True, index=True)

    # Manifest (parsed from SKILL.md YAML front matter)
    skill_name = Column(String(200), nullable=False, unique=True)   # normalized slug
    description = Column(Text, nullable=True)
    version = Column(String(50), nullable=True)
    author = Column(String(200), nullable=True)
    license = Column(String(100), nullable=True)
    manifest_json = Column(JSON, nullable=True)   # full parsed front matter

    # Source
    source_type = Column(String(10), nullable=False)  # 'md' or 'zip'
    original_filename = Column(String(500), nullable=False)
    storage_path = Column(String(1000), nullable=False)  # /app/DATABASE/skills/{slug}/{hash}/
    bundle_hash = Column(String(64), nullable=False)      # SHA-256

    # Skill body (instruction text extracted from SKILL.md)
    instruction_body = Column(Text, nullable=True)

    # Status
    import_status = Column(String(20), default="active")  # active, disabled, error

    # Timestamps
    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    # Relationships
    mcp_server = relationship("McpServer", back_populates="skill_package")


class UserMcpPreference(Base):
    __tablename__ = "user_mcp_preferences"
    __table_args__ = (UniqueConstraint("user_id", "mcp_server_id", name="uq_user_mcp_pref"),)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    mcp_server_id = Column(Integer, ForeignKey("mcp_servers.id", ondelete="CASCADE"), nullable=False, index=True)
    enabled = Column(Boolean, default=True)

    created_at = Column(DateTime, default=func.now())
    updated_at = Column(DateTime, default=func.now(), onupdate=func.now())

    # Relationships
    user = relationship("User")
    mcp_server = relationship("McpServer", back_populates="user_preferences")

# ========== Database Utilities ==========

def get_engine():
    """데이터베이스 엔진 반환 (SQLite)"""
    engine = create_engine(
        settings.database_url,
        echo=settings.environment == "development",
        connect_args={"check_same_thread": False}  # SQLite 멀티스레드 허용
    )
    
    # SQLite 외래키 활성화
    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()
    
    return engine

def get_session_local():
    """세션 팩토리 반환"""
    engine = get_engine()
    return sessionmaker(
        bind=engine,
        autocommit=False,
        autoflush=False
    )





def run_sqlite_migrations(engine):
    """Run idempotent SQLite migrations (dev-friendly).

    Uses a `schema_migrations` table to track applied migrations.
    """

    if engine.dialect.name != 'sqlite':
        return

    migrations = []

    def add_migration(migration_id, fn):
        migrations.append((migration_id, fn))

    def m20260116_01_add_chat_message_attachments(conn):
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('chat_messages')").fetchall()]
        if 'attachments' not in cols:
            conn.exec_driver_sql('ALTER TABLE chat_messages ADD COLUMN attachments JSON')

    def m20260116_02_normalize_files_status(conn):
        # Legacy rows stored lowercase status strings; normalize to Enum names.
        conn.exec_driver_sql("UPDATE files SET status='UPLOADING' WHERE status='uploading'")
        conn.exec_driver_sql("UPDATE files SET status='CONVERTING' WHERE status='converting'")
        conn.exec_driver_sql("UPDATE files SET status='ANALYZING' WHERE status='analyzing'")
        conn.exec_driver_sql("UPDATE files SET status='COMPLETED' WHERE status='completed'")
        conn.exec_driver_sql("UPDATE files SET status='FAILED' WHERE status='failed'")

    def m20260118_01_add_user_level(conn):
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('users')").fetchall()]
        if 'user_level' not in cols:
            conn.exec_driver_sql('ALTER TABLE users ADD COLUMN user_level INTEGER')
        conn.exec_driver_sql('UPDATE users SET user_level=9 WHERE user_level IS NULL')
        conn.exec_driver_sql("UPDATE users SET user_level=0 WHERE role IN ('SUPER_ADMIN','ADMIN','super_admin','admin')")

    def m20260123_01_add_chat_message_model_metadata(conn):
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('chat_messages')").fetchall()]
        if 'model_metadata' not in cols:
            conn.exec_driver_sql('ALTER TABLE chat_messages ADD COLUMN model_metadata JSON')

    def m20260126_01_add_files_enqueued_at(conn):
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('files')").fetchall()]
        if 'enqueued_at' not in cols:
            conn.exec_driver_sql('ALTER TABLE files ADD COLUMN enqueued_at DATETIME')

    def m20260212_01_add_files_content_version(conn):
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('files')").fetchall()]
        if 'content_version' not in cols:
            conn.exec_driver_sql('ALTER TABLE files ADD COLUMN content_version VARCHAR(64)')

    def m20260212_02_add_files_embedding_cols(conn):
        """embedding 관련 컬럼이 없을 경우 추가 (기존 테이블 호환)"""
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('files')").fetchall()]
        if 'embedding_status' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN embedding_status VARCHAR(20) DEFAULT 'none'")
        if 'embedding_chunks' not in cols:
            conn.exec_driver_sql('ALTER TABLE files ADD COLUMN embedding_chunks INTEGER DEFAULT 0')
        if 'embedding_model' not in cols:
            conn.exec_driver_sql('ALTER TABLE files ADD COLUMN embedding_model VARCHAR(100)')
        if 'embedding_at' not in cols:
            conn.exec_driver_sql('ALTER TABLE files ADD COLUMN embedding_at DATETIME')

    add_migration('20260116_01_add_chat_messages_attachments', m20260116_01_add_chat_message_attachments)
    add_migration('20260116_02_normalize_files_status', m20260116_02_normalize_files_status)
    add_migration('20260118_01_add_user_level', m20260118_01_add_user_level)
    add_migration('20260123_01_add_chat_message_model_metadata', m20260123_01_add_chat_message_model_metadata)
    add_migration('20260126_01_add_files_enqueued_at', m20260126_01_add_files_enqueued_at)
    def m20260212_03_create_knowledge_dbs(conn):
        """knowledge_dbs 테이블 생성"""
        tables = [row[0] for row in conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]
        if 'knowledge_dbs' not in tables:
            conn.exec_driver_sql('''
                CREATE TABLE knowledge_dbs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id),
                    name VARCHAR(100) NOT NULL,
                    description TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            conn.exec_driver_sql('CREATE INDEX ix_knowledge_dbs_user_id ON knowledge_dbs(user_id)')

    def m20260212_04_add_files_knowledge_db_id(conn):
        """files 테이블에 knowledge_db_id 컬럼 추가"""
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('files')").fetchall()]
        if 'knowledge_db_id' not in cols:
            conn.exec_driver_sql('ALTER TABLE files ADD COLUMN knowledge_db_id INTEGER REFERENCES knowledge_dbs(id)')

    def m20260213_01_add_files_embedding_progress(conn):
        """임베딩 진행률 추적용 컬럼 추가"""
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('files')").fetchall()]
        if 'embedding_total_chunks' not in cols:
            conn.exec_driver_sql('ALTER TABLE files ADD COLUMN embedding_total_chunks INTEGER DEFAULT 0')
        if 'embedding_processed_chunks' not in cols:
            conn.exec_driver_sql('ALTER TABLE files ADD COLUMN embedding_processed_chunks INTEGER DEFAULT 0')

    add_migration('20260212_01_add_files_content_version', m20260212_01_add_files_content_version)
    add_migration('20260212_02_add_files_embedding_cols', m20260212_02_add_files_embedding_cols)
    add_migration('20260212_03_create_knowledge_dbs', m20260212_03_create_knowledge_dbs)
    add_migration('20260212_04_add_files_knowledge_db_id', m20260212_04_add_files_knowledge_db_id)
    add_migration('20260213_01_add_files_embedding_progress', m20260213_01_add_files_embedding_progress)

    def m20260213_02_create_file_embeddings(conn):
        """file_embeddings 테이블 생성 (테이블이 이미 존재할 수 있음 — Base.metadata.create_all 호환)"""
        tables = [row[0] for row in conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]
        if 'file_embeddings' not in tables:
            conn.exec_driver_sql('''
                CREATE TABLE file_embeddings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    file_id VARCHAR(36) NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                    provider VARCHAR(20) NOT NULL,
                    model VARCHAR(100) NOT NULL,
                    status VARCHAR(20) DEFAULT 'none',
                    chunks INTEGER DEFAULT 0,
                    total_chunks INTEGER DEFAULT 0,
                    processed_chunks INTEGER DEFAULT 0,
                    content_version VARCHAR(64),
                    error_message TEXT,
                    embedded_at DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(file_id, provider, model)
                )
            ''')
            conn.exec_driver_sql('CREATE INDEX IF NOT EXISTS ix_file_embeddings_file_id ON file_embeddings(file_id)')
            conn.exec_driver_sql('CREATE INDEX IF NOT EXISTS ix_file_embeddings_status ON file_embeddings(status)')

    add_migration('20260213_02_create_file_embeddings', m20260213_02_create_file_embeddings)

    def m20260213_03_migrate_file_embeddings_data(conn):
        """기존 files 테이블의 임베딩 데이터를 file_embeddings로 마이그레이션
        (테이블이 Base.metadata.create_all로 먼저 생성된 경우에도 동작)"""
        # 이미 데이터가 있으면 스킵 (중복 방지)
        count = conn.exec_driver_sql('SELECT COUNT(*) FROM file_embeddings').fetchone()[0]
        if count > 0:
            return
        conn.exec_driver_sql('''
            INSERT INTO file_embeddings (file_id, provider, model, status, chunks, total_chunks, processed_chunks, content_version, embedded_at)
            SELECT
                id,
                CASE WHEN embedding_model LIKE 'text-embedding%' THEN 'openai' ELSE 'ollama' END,
                COALESCE(embedding_model, 'bge-m3'),
                COALESCE(embedding_status, 'none'),
                COALESCE(embedding_chunks, 0),
                COALESCE(embedding_total_chunks, 0),
                COALESCE(embedding_processed_chunks, 0),
                content_version,
                embedding_at
            FROM files
            WHERE embedding_status IS NOT NULL AND embedding_status NOT IN ('none', '')
        ''')

    add_migration('20260213_03_migrate_file_embeddings_data', m20260213_03_migrate_file_embeddings_data)

    def m20260218_01_add_error_code_to_files(conn):
        """files 테이블에 error_code 컬럼 추가 (실패 유형 분류)"""
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(files)").fetchall()]
        if 'error_code' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN error_code VARCHAR(60)")

    add_migration('20260218_01_add_error_code_to_files', m20260218_01_add_error_code_to_files)

    def m20260225_01_add_memory_enabled_to_user_settings(conn):
        """user_settings 테이블에 memory_enabled 컬럼 추가"""
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('user_settings')").fetchall()]
        if 'memory_enabled' not in cols:
            conn.exec_driver_sql("ALTER TABLE user_settings ADD COLUMN memory_enabled BOOLEAN DEFAULT 1")
        conn.exec_driver_sql('UPDATE user_settings SET memory_enabled=1 WHERE memory_enabled IS NULL')

    add_migration('20260225_01_add_memory_enabled_to_user_settings', m20260225_01_add_memory_enabled_to_user_settings)

    def m20260303_01_add_enrichment_columns_to_files(conn):
        """files 테이블에 enrichment_status, enrichment_error 컨럼 추가"""
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('files')").fetchall()]
        if 'enrichment_status' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN enrichment_status TEXT DEFAULT 'none'")
        if 'enrichment_error' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN enrichment_error TEXT")
        conn.exec_driver_sql("UPDATE files SET enrichment_status='none' WHERE enrichment_status IS NULL")

    add_migration('20260303_01_add_enrichment_columns_to_files', m20260303_01_add_enrichment_columns_to_files)

    def m20260304_01_create_mcp_tables(conn):
        """mcp_servers, user_mcp_preferences 테이블 생성"""
        tables = [row[0] for row in conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]

        if 'mcp_servers' not in tables:
            conn.exec_driver_sql('''
                CREATE TABLE mcp_servers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name VARCHAR(100) NOT NULL UNIQUE,
                    display_name VARCHAR(200) NOT NULL,
                    description TEXT,
                    server_type VARCHAR(20) NOT NULL DEFAULT 'mcp',
                    icon VARCHAR(100),
                    transport VARCHAR(50),
                    endpoint_url VARCHAR(500),
                    enabled BOOLEAN DEFAULT 1,
                    is_default BOOLEAN DEFAULT 0,
                    sort_order INTEGER DEFAULT 0,
                    config_json JSON,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            conn.exec_driver_sql('CREATE INDEX ix_mcp_servers_server_type ON mcp_servers(server_type)')

        if 'user_mcp_preferences' not in tables:
            conn.exec_driver_sql('''
                CREATE TABLE user_mcp_preferences (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    mcp_server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
                    enabled BOOLEAN DEFAULT 1,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT uq_user_mcp_pref UNIQUE (user_id, mcp_server_id)
                )
            ''')
            conn.exec_driver_sql('CREATE INDEX ix_user_mcp_preferences_user_id ON user_mcp_preferences(user_id)')
            conn.exec_driver_sql('CREATE INDEX ix_user_mcp_preferences_mcp_server_id ON user_mcp_preferences(mcp_server_id)')

    add_migration('20260304_01_create_mcp_tables', m20260304_01_create_mcp_tables)

    def m20260309_01_add_files_analysis_provider(conn):
         """files 테이블에 analysis_provider 컬럼 추가 (업로드 시점 provider 스냅샷)"""
         cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('files')").fetchall()]
         if 'analysis_provider' not in cols:
             conn.exec_driver_sql("ALTER TABLE files ADD COLUMN analysis_provider VARCHAR(20) DEFAULT 'opendataloader'")
         conn.exec_driver_sql(
             "UPDATE files SET analysis_provider='opendataloader'"
         )

    add_migration('20260309_01_add_files_analysis_provider', m20260309_01_add_files_analysis_provider)

    def m20260316_01_add_persona_custom_markdown_to_user_settings(conn):
        """user_settings 테이블에 persona_custom_markdown 컬럼 추가"""
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('user_settings')").fetchall()]
        if 'persona_custom_markdown' not in cols:
            conn.exec_driver_sql("ALTER TABLE user_settings ADD COLUMN persona_custom_markdown TEXT DEFAULT ''")
        conn.exec_driver_sql("UPDATE user_settings SET persona_custom_markdown='' WHERE persona_custom_markdown IS NULL")

    add_migration('20260316_01_add_persona_custom_markdown_to_user_settings', m20260316_01_add_persona_custom_markdown_to_user_settings)

    def m20260320_01_create_skill_packages_table(conn):
        """skill_packages 테이블 생성 — imported skill bundle metadata"""
        tables = [row[0] for row in conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]

        if 'skill_packages' not in tables:
            conn.exec_driver_sql('''
                CREATE TABLE skill_packages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    mcp_server_id INTEGER NOT NULL UNIQUE REFERENCES mcp_servers(id) ON DELETE CASCADE,
                    skill_name VARCHAR(200) NOT NULL UNIQUE,
                    description TEXT,
                    version VARCHAR(50),
                    author VARCHAR(200),
                    license VARCHAR(100),
                    manifest_json JSON,
                    source_type VARCHAR(10) NOT NULL,
                    original_filename VARCHAR(500) NOT NULL,
                    storage_path VARCHAR(1000) NOT NULL,
                    bundle_hash VARCHAR(64) NOT NULL,
                    instruction_body TEXT,
                    import_status VARCHAR(20) DEFAULT 'active',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            conn.exec_driver_sql('CREATE INDEX ix_skill_packages_mcp_server_id ON skill_packages(mcp_server_id)')
            conn.exec_driver_sql('CREATE UNIQUE INDEX ix_skill_packages_skill_name ON skill_packages(skill_name)')

    add_migration('20260320_01_create_skill_packages_table', m20260320_01_create_skill_packages_table)

    def m20260323_01_create_speech_jobs_table(conn):
        """Deprecated: speech feature removed (2026-05-12). No-op for fresh installs."""
        pass

    add_migration('20260323_01_create_speech_jobs_table', m20260323_01_create_speech_jobs_table)

    def m20260512_01_drop_speech_jobs_table(conn):
        """speech feature 제거: speech_jobs 테이블 폐기"""
        tables = [row[0] for row in conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]
        if 'speech_jobs' in tables:
            conn.exec_driver_sql('DROP TABLE speech_jobs')

    add_migration('20260512_01_drop_speech_jobs_table', m20260512_01_drop_speech_jobs_table)

    def m20260401_01_add_chat_session_title_edit_flag(conn):
        """chat_sessions 테이블에 사용자 수동 제목 수정 플래그 컬럼 추가"""
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('chat_sessions')").fetchall()]
        if 'is_title_user_edited' not in cols:
            conn.exec_driver_sql("ALTER TABLE chat_sessions ADD COLUMN is_title_user_edited BOOLEAN DEFAULT 0")
        conn.exec_driver_sql(
            "UPDATE chat_sessions SET is_title_user_edited=0 WHERE is_title_user_edited IS NULL"
        )

    add_migration('20260401_01_add_chat_session_title_edit_flag', m20260401_01_add_chat_session_title_edit_flag)

    def m20260414_01_add_analysis_enrichment_generation_fields(conn):
        """files 테이블에 analysis/enrichment 세대 및 진행률 컬럼 추가"""
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('files')").fetchall()]
        if 'analysis_generation' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN analysis_generation INTEGER DEFAULT 1")
        if 'enrichment_generation' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN enrichment_generation INTEGER DEFAULT 0")
        if 'enrichment_total_targets' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN enrichment_total_targets INTEGER DEFAULT 0")
        if 'enrichment_processed_targets' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN enrichment_processed_targets INTEGER DEFAULT 0")
        if 'enrichment_model_provider' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN enrichment_model_provider VARCHAR(20)")
        if 'enrichment_model_name' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN enrichment_model_name VARCHAR(100)")
        if 'enrichment_enqueued_at' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN enrichment_enqueued_at DATETIME")
        if 'enrichment_started_at' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN enrichment_started_at DATETIME")
        if 'enrichment_completed_at' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN enrichment_completed_at DATETIME")

        conn.exec_driver_sql("UPDATE files SET analysis_generation=1 WHERE analysis_generation IS NULL OR analysis_generation < 1")
        conn.exec_driver_sql("UPDATE files SET enrichment_generation=0 WHERE enrichment_generation IS NULL")
        conn.exec_driver_sql("UPDATE files SET enrichment_total_targets=0 WHERE enrichment_total_targets IS NULL")
        conn.exec_driver_sql("UPDATE files SET enrichment_processed_targets=0 WHERE enrichment_processed_targets IS NULL")

    add_migration('20260414_01_add_analysis_enrichment_generation_fields', m20260414_01_add_analysis_enrichment_generation_fields)

    def m20260420_01_add_processing_history_fields(conn):
        """files 테이블에 처리 이력 추적 컬럼 추가"""
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info('files')").fetchall()]
        if 'processing_started_at' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN processing_started_at DATETIME")
        if 'processing_completed_at' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN processing_completed_at DATETIME")
        if 'processing_duration_seconds' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN processing_duration_seconds FLOAT")
        if 'processing_uses_gpu' not in cols:
            conn.exec_driver_sql("ALTER TABLE files ADD COLUMN processing_uses_gpu BOOLEAN")

    add_migration('20260420_01_add_processing_history_fields', m20260420_01_add_processing_history_fields)

    def m20260420_02_rename_default_knowledge_dbs(conn):
        """사용자별 기본 지식DB 표시명을 '일반문서'로 정규화"""
        tables = [row[0] for row in conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]

        if 'knowledge_dbs' not in tables:
            return

        conn.exec_driver_sql(
            "UPDATE knowledge_dbs SET name=?, updated_at=datetime('now') WHERE name=?",
            ("일반문서", "default"),
        )
        conn.exec_driver_sql(
            """
            UPDATE knowledge_dbs
            SET description=?, updated_at=datetime('now')
            WHERE name=? AND (
                description IS NULL OR
                TRIM(description) = '' OR
                description = ?
            )
            """,
            ("일반 문서를 모아두는 기본 지식베이스", "일반문서", "기본 지식DB"),
        )

    add_migration('20260420_02_rename_default_knowledge_dbs', m20260420_02_rename_default_knowledge_dbs)

    try:
        with engine.begin() as conn:
            conn.exec_driver_sql(
                "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            applied = {row[0] for row in conn.exec_driver_sql('SELECT id FROM schema_migrations').fetchall()}

            for migration_id, fn in migrations:
                if migration_id in applied:
                    continue
                fn(conn)
                conn.exec_driver_sql(
                    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))",
                    (migration_id,),
                )
    except Exception:
        # Do not block startup on migration issues
        pass


def create_tables():
    """모든 테이블 생성"""
    engine = get_engine()
    Base.metadata.create_all(bind=engine)
    run_sqlite_migrations(engine)
    print("데이터베이스 테이블 생성 완료")

SessionLocal = get_session_local()

def get_db():
    """데이터베이스 세션 의존성"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
