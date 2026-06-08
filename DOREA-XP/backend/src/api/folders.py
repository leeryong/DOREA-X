# Folder Management Routes

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from typing import List

from models.database import get_db, User, Folder
from schemas.api_schemas import FolderCreateRequest, FolderResponse
from api.deps import get_current_user

router = APIRouter(prefix="/api/folders", tags=["Folders"])


@router.get("/")
async def list_folders(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    폴더 전체 목록 (평면 구조로 변환은 프론트엔드에서 처리)
    """
    folders = db.query(Folder).filter(
        Folder.user_id == current_user.id
    ).order_by(Folder.name).all()
    
    folder_responses = [
        FolderResponse(
            id=f.id,
            name=f.name,
            description=f.description,
            parent_id=f.parent_id,
            created_at=f.created_at
        )
        for f in folders
    ]
    
    return folder_responses


@router.post("/", response_model=FolderResponse)
async def create_folder(
    request: FolderCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    폴더 생성
    """
    new_folder = Folder(
        user_id=current_user.id,
        name=request.name,
        description=request.description,
        parent_id=request.parent_id
    )
    
    db.add(new_folder)
    db.commit()
    db.refresh(new_folder)
    
    return FolderResponse(
        id=new_folder.id,
        name=new_folder.name,
        description=new_folder.description,
        parent_id=new_folder.parent_id,
        created_at=new_folder.created_at
    )


@router.put("/{folder_id}", response_model=FolderResponse)
async def update_folder(
    folder_id: int,
    request: FolderCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    폴더 이름/설명 수정
    """
    folder = db.query(Folder).filter(
        Folder.id == folder_id,
        Folder.user_id == current_user.id
    ).first()
    
    if not folder:
        raise HTTPException(status_code=404, detail={"error_code": "FOLDERS_NOT_FOUND", "message": "폴더를 찾을 수 없습니다"})
    
    folder.name = request.name
    folder.description = request.description
    db.commit()
    
    return FolderResponse(
        id=folder.id,
        name=folder.name,
        description=folder.description,
        parent_id=folder.parent_id,
        created_at=folder.created_at
    )


@router.delete("/{folder_id}")
async def delete_folder(
    folder_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    폴더 삭제 (연관 파일들도 삭제됨)
    """
    folder = db.query(Folder).filter(
        Folder.id == folder_id,
        Folder.user_id == current_user.id
    ).first()
    
    if not folder:
        raise HTTPException(status_code=404, detail={"error_code": "FOLDERS_NOT_FOUND", "message": "폴더를 찾을 수 없습니다"})
    
    # cascade로 폴더 및 연관 파일 삭제
    db.delete(folder)
    db.commit()
    
    return {"message": "폴더가 삭제되었습니다"}
