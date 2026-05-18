# Curiosity Trail Web 版实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Curiosity Trail 从 PyQt5 桌面版迁移到 React + FastAPI Web 版，实现两人独立账户的探索报告和文献管理功能

**Architecture:** 前后端分离架构。前端 React + Vite + Tailwind CSS 实现简洁留白 UI；后端 FastAPI 提供 RESTful API，JWT 认证，用户数据完全隔离

**Tech Stack:** React 18, Vite, Tailwind CSS, FastAPI, SQLAlchemy, SQLite, JWT (python-jose), bcrypt, python-docx

---

## 文件结构

```
CuriosityTrail/
├── backend/
│   ├── main.py              # FastAPI 入口，路由注册
│   ├── database.py          # 数据库连接和初始化
│   ├── models.py             # SQLAlchemy 模型（User, Report, Document, Category, ReportDocument）
│   ├── auth.py              # JWT 认证工具
│   ├── routes/
│   │   ├── __init__.py
│   │   ├── auth.py          # 认证路由（注册/登录/获取用户）
│   │   ├── reports.py       # 报告 CRUD + 导出
│   │   ├── documents.py      # 文献管理 + 文件上传
│   │   └── categories.py    # 分类管理
│   └── requirements.txt     # Python 依赖
├── frontend/
│   ├── src/
│   │   ├── main.jsx         # React 入口
│   │   ├── App.jsx          # 路由和布局
│   │   ├── index.css        # Tailwind 入口
│   │   ├── api/
│   │   │   └── index.js     # API 调用封装
│   │   ├── components/
│   │   │   ├── Layout.jsx   # 页面布局（侧边栏+内容区）
│   │   │   ├── Sidebar.jsx  # 侧边导航
│   │   │   └── TopBar.jsx   # 顶部操作栏
│   │   ├── pages/
│   │   │   ├── Login.jsx    # 登录页
│   │   │   ├── Register.jsx # 注册页
│   │   │   ├── Reports.jsx  # 报告库
│   │   │   ├── ReportEditor.jsx # 报告编辑
│   │   │   ├── Documents.jsx # 文献库
│   │   │   └── Settings.jsx # 系统设置
│   │   └── context/
│   │       └── AuthContext.jsx # 认证上下文
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
└── docs/superpowers/plans/2026-05-12-curiosity-trail-web-plan.md
```

---

## Task 1: 后端项目初始化

**Files:**
- Create: `backend/requirements.txt`
- Create: `backend/main.py`
- Create: `backend/database.py`

- [ ] **Step 1: 创建 requirements.txt**

```txt
fastapi==0.109.0
uvicorn[standard]==0.27.0
sqlalchemy==2.0.25
python-jose[cryptography]==3.3.0
passlib[bcrypt]==1.7.4
python-multipart==0.0.6
python-docx==1.1.0
```

- [ ] **Step 2: 创建 database.py**

```python
from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./curiosity_trail.db")

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def init_db():
    from models import User, Report, Document, Category, ReportDocument
    Base.metadata.create_all(bind=engine)
```

- [ ] **Step 3: 创建 main.py**

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database import init_db
from routes import auth, reports, documents, categories

app = FastAPI(title="Curiosity Trail API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup():
    init_db()

app.include_router(auth.router, prefix="/api/auth", tags=["auth"])
app.include_router(reports.router, prefix="/api/reports", tags=["reports"])
app.include_router(documents.router, prefix="/api/documents", tags=["documents"])
app.include_router(categories.router, prefix="/api/categories", tags=["categories"])
```

- [ ] **Step 4: 创建 routes/__init__.py**

```python
from . import auth, reports, documents, categories
```

- [ ] **Step 5: 运行测试**

```bash
cd backend
pip install -r requirements.txt
python -c "from main import app; print('FastAPI app created successfully')"
```

Expected: FastAPI app created successfully

- [ ] **Step 6: Commit**

```bash
git add backend/requirements.txt backend/main.py backend/database.py backend/routes/
git commit -m "feat: initialize FastAPI backend project structure"
```

---

## Task 2: 数据库模型

**Files:**
- Create: `backend/models.py`

- [ ] **Step 1: 创建 models.py**

```python
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean, ForeignKey, Table
from sqlalchemy.orm import relationship
from datetime import datetime
from database import Base

report_documents = Table(
    'report_documents',
    Base.metadata,
    Column('report_id', Integer, ForeignKey('reports.id', ondelete='CASCADE'), primary_key=True),
    Column('document_id', Integer, ForeignKey('documents.id', ondelete='CASCADE'), primary_key=True)
)

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(200), unique=True, index=True, nullable=False)
    password_hash = Column(String(200), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    reports = relationship("Report", back_populates="user")
    documents = relationship("Document", back_populates="user")
    categories = relationship("Category", back_populates="user")

class Report(Base):
    __tablename__ = "reports"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    title = Column(String(200), nullable=False)
    content = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    modified_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="reports")
    documents = relationship("Document", secondary=report_documents, back_populates="reports")

class Document(Base):
    __tablename__ = "documents"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    name = Column(String(200), nullable=False)
    file_path = Column(String(500), nullable=False)
    category_id = Column(Integer, ForeignKey('categories.id'), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", back_populates="documents")
    category = relationship("Category", back_populates="documents")
    reports = relationship("Report", secondary=report_documents, back_populates="documents")

class Category(Base):
    __tablename__ = "categories"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    name = Column(String(100), nullable=False)
    is_default = Column(Boolean, default=False)

    user = relationship("User", back_populates="categories")
    documents = relationship("Document", back_populates="category")
```

- [ ] **Step 2: 验证模型**

```bash
cd backend
python -c "from models import User, Report, Document, Category; print('Models imported successfully')"
```

Expected: Models imported successfully

- [ ] **Step 3: Commit**

```bash
git add backend/models.py
git commit -m "feat: add SQLAlchemy models for User, Report, Document, Category"
```

---

## Task 3: JWT 认证

**Files:**
- Create: `backend/auth.py`

- [ ] **Step 1: 创建 auth.py**

```python
from datetime import datetime, timedelta
from typing import Optional
from jose import JWTError, jwt
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from database import get_db

SECRET_KEY = "curiosity-trail-secret-key-change-in-production"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_DAYS = 7

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer()

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(days=ACCESS_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def decode_token(token: str) -> Optional[dict]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        return None

async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db)
):
    from models import User
    token = credentials.credentials
    payload = decode_token(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    user_id = payload.get("sub")
    if user_id is None:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    
    return user
```

- [ ] **Step 2: 验证认证工具**

```bash
cd backend
python -c "
from auth import create_access_token, decode_token, get_password_hash, verify_password
hash = get_password_hash('test123')
print('Password hash created:', hash[:20] + '...')
print('Verify correct password:', verify_password('test123', hash))
print('Verify wrong password:', verify_password('wrong', hash))
token = create_access_token({'sub': 1})
print('Token created:', token[:20] + '...')
payload = decode_token(token)
print('Token decoded:', payload)
"
```

Expected: Password hash created, Verify correct password: True, Verify wrong password: False, Token created, Token decoded: {'sub': 1, 'exp': ...}

- [ ] **Step 3: Commit**

```bash
git add backend/auth.py
git commit -m "feat: add JWT authentication utilities"
```

---

## Task 4: 认证路由

**Files:**
- Create: `backend/routes/auth.py`

- [ ] **Step 1: 创建 auth.py 路由**

```python
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from database import get_db
from models import User
from auth import get_password_hash, verify_password, create_access_token, get_current_user

router = APIRouter()

class RegisterRequest(BaseModel):
    email: str
    password: str

class LoginRequest(BaseModel):
    email: str
    password: str

class UserResponse(BaseModel):
    id: int
    email: str
    class Config:
        from_attributes = True

@router.post("/register")
def register(request: RegisterRequest, db: Session = Depends(get_db)):
    existing_user = db.query(User).filter(User.email == request.email).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    hashed_password = get_password_hash(request.password)
    user = User(email=request.email, password_hash=hashed_password)
    db.add(user)
    db.commit()
    db.refresh(user)
    
    # Create default category for user
    from models import Category
    default_category = Category(user_id=user.id, name="未分类", is_default=True)
    db.add(default_category)
    db.commit()
    
    access_token = create_access_token({"sub": user.id})
    return {"access_token": access_token, "user": UserResponse.model_validate(user)}

@router.post("/login")
def login(request: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == request.email).first()
    if not user or not verify_password(request.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    
    access_token = create_access_token({"sub": user.id})
    return {"access_token": access_token, "user": UserResponse.model_validate(user)}

@router.get("/me")
def get_me(current_user: User = Depends(get_current_user)):
    return UserResponse.model_validate(current_user)
```

- [ ] **Step 2: 测试认证路由**

```bash
cd backend
python -c "
from routes.auth import router
print('Auth router loaded successfully')
"
```

Expected: Auth router loaded successfully

- [ ] **Step 3: Commit**

```bash
git add backend/routes/auth.py
git commit -m "feat: add auth routes (register, login, me)"
```

---

## Task 5: 报告路由

**Files:**
- Create: `backend/routes/reports.py`

- [ ] **Step 1: 创建 reports.py 路由**

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
from database import get_db
from models import Report, User, Document, report_documents
from auth import get_current_user

router = APIRouter()

class ReportCreate(BaseModel):
    title: str
    content: str = ""

class ReportUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None

class ReportResponse(BaseModel):
    id: int
    title: str
    content: str
    created_at: datetime
    modified_at: datetime
    class Config:
        from_attributes = True

@router.get("")
def list_reports(
    search: Optional[str] = None,
    order_by: str = "modified_at",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    query = db.query(Report).filter(Report.user_id == current_user.id)
    if search:
        query = query.filter(Report.title.contains(search))
    
    if order_by == "created_at":
        query = query.order_by(Report.created_at.desc())
    elif order_by == "title":
        query = query.order_by(Report.title)
    else:
        query = query.order_by(Report.modified_at.desc())
    
    reports = query.all()
    result = []
    for r in reports:
        doc_count = db.query(report_documents).filter(report_documents.c.report_id == r.id).count()
        result.append({
            **ReportResponse.model_validate(r).model_dump(),
            "document_count": doc_count
        })
    return result

@router.post("")
def create_report(
    report: ReportCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    existing = db.query(Report).filter(
        Report.user_id == current_user.id,
        Report.title == report.title
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Report title already exists")
    
    db_report = Report(
        user_id=current_user.id,
        title=report.title,
        content=report.content
    )
    db.add(db_report)
    db.commit()
    db.refresh(db_report)
    return ReportResponse.model_validate(db_report)

@router.get("/{report_id}")
def get_report(
    report_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    report = db.query(Report).filter(
        Report.id == report_id,
        Report.user_id == current_user.id
    ).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    
    docs = db.query(Document).join(report_documents).filter(report_documents.c.report_id == report_id).all()
    return {
        **ReportResponse.model_validate(report).model_dump(),
        "documents": [{"id": d.id, "name": d.name} for d in docs]
    }

@router.put("/{report_id}")
def update_report(
    report_id: int,
    report_update: ReportUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    report = db.query(Report).filter(
        Report.id == report_id,
        Report.user_id == current_user.id
    ).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    
    if report_update.title is not None:
        existing = db.query(Report).filter(
            Report.user_id == current_user.id,
            Report.title == report_update.title,
            Report.id != report_id
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Report title already exists")
        report.title = report_update.title
    
    if report_update.content is not None:
        report.content = report_update.content
    
    report.modified_at = datetime.utcnow()
    db.commit()
    db.refresh(report)
    return ReportResponse.model_validate(report)

@router.delete("/{report_id}")
def delete_report(
    report_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    report = db.query(Report).filter(
        Report.id == report_id,
        Report.user_id == current_user.id
    ).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    
    db.query(report_documents).filter(report_documents.c.report_id == report_id).delete()
    db.delete(report)
    db.commit()
    return {"message": "Report deleted"}

@router.get("/{report_id}/export")
def export_report(
    report_id: int,
    format: str = "txt",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    from services.export_service import ExportService
    
    report = db.query(Report).filter(
        Report.id == report_id,
        Report.user_id == current_user.id
    ).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    
    docs = db.query(Document).join(report_documents).filter(report_documents.c.report_id == report_id).all()
    report.documents = docs
    
    if format == "docx":
        return ExportService.export_to_docx_stream(report)
    else:
        content = ExportService.export_to_txt(report)
        from fastapi.responses import StreamingResponse
        from io import BytesIO
        buffer = BytesIO(content.encode('utf-8'))
        return StreamingResponse(buffer, media_type="text/plain", headers={
            "Content-Disposition": f"attachment; filename={report.title}.txt"
        })
```

- [ ] **Step 2: 创建 services/export_service.py**

```python
import io
from docx import Document as DocxDocument
from models import Report

class ExportService:
    @staticmethod
    def export_to_txt(report: Report) -> str:
        lines = [
            f"标题：{report.title}",
            f"创建时间：{report.created_at.strftime('%Y-%m-%d %H:%M:%S')}",
            f"修改时间：{report.modified_at.strftime('%Y-%m-%d %H:%M:%S')}",
            "",
            "=" * 50,
            "",
            report.content or "",
        ]
        
        if report.documents:
            lines.append("")
            lines.append("=" * 50)
            lines.append("关联文献：")
            for doc in report.documents:
                lines.append(f"- {doc.name}")
        
        return "\n".join(lines)
    
    @staticmethod
    def export_to_docx_stream(report: Report):
        doc = DocxDocument()
        doc.add_heading(report.title, 0)
        
        meta = doc.add_paragraph()
        meta.add_run(f"创建时间：{report.created_at.strftime('%Y-%m-%d %H:%M:%S')}\n")
        meta.add_run(f"修改时间：{report.modified_at.strftime('%Y-%m-%d %H:%M:%S')}")
        
        doc.add_heading("内容", level=1)
        doc.add_paragraph(report.content or "")
        
        if report.documents:
            doc.add_heading("关联文献", level=1)
            for doc_item in report.documents:
                doc.add_paragraph(f"- {doc_item.name}", style='List Bullet')
        
        buffer = io.BytesIO()
        doc.save(buffer)
        buffer.seek(0)
        
        from fastapi.responses import StreamingResponse
        return StreamingResponse(
            buffer,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f"attachment; filename={report.title}.docx"}
        )
```

- [ ] **Step 3: Commit**

```bash
git add backend/routes/reports.py backend/services/export_service.py
git commit -m "feat: add reports CRUD routes and export functionality"
```

---

## Task 6: 文献路由

**Files:**
- Create: `backend/routes/documents.py`

- [ ] **Step 1: 创建 documents.py 路由**

```python
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import os
import shutil
from database import get_db
from models import Document, Category, User, report_documents
from auth import get_current_user

router = APIRouter()

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")

class DocumentResponse(BaseModel):
    id: int
    name: str
    file_path: str
    category_id: Optional[int]
    created_at: datetime
    class Config:
        from_attributes = True

@router.get("")
def list_documents(
    search: Optional[str] = None,
    category_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    query = db.query(Document).filter(Document.user_id == current_user.id)
    
    if search:
        query = query.filter(Document.name.contains(search))
    if category_id is not None:
        query = query.filter(Document.category_id == category_id)
    
    return query.order_by(Document.created_at.desc()).all()

@router.post("")
async def upload_document(
    file: UploadFile = File(...),
    category_id: Optional[int] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are allowed")
    
    user_dir = os.path.join(UPLOAD_DIR, str(current_user.id))
    os.makedirs(user_dir, exist_ok=True)
    
    file_path = os.path.join(user_dir, file.filename)
    with open(file_path, "wb") as buffer:
        content = await file.read()
        buffer.write(content)
    
    doc = Document(
        user_id=current_user.id,
        name=file.filename.replace(".pdf", ""),
        file_path=file_path,
        category_id=category_id
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc

@router.get("/{document_id}")
def get_document(
    document_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    doc = db.query(Document).filter(
        Document.id == document_id,
        Document.user_id == current_user.id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc

@router.delete("/{document_id}")
def delete_document(
    document_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    doc = db.query(Document).filter(
        Document.id == document_id,
        Document.user_id == current_user.id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    
    # Delete file
    if os.path.exists(doc.file_path):
        os.remove(doc.file_path)
    
    # Remove associations
    db.query(report_documents).filter(report_documents.c.document_id == document_id).delete()
    
    db.delete(doc)
    db.commit()
    return {"message": "Document deleted"}

@router.get("/{document_id}/download")
def download_document(
    document_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    from fastapi.responses import FileResponse
    
    doc = db.query(Document).filter(
        Document.id == document_id,
        Document.user_id == current_user.id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    
    if not os.path.exists(doc.file_path):
        raise HTTPException(status_code=404, detail="File not found")
    
    return FileResponse(
        doc.file_path,
        media_type="application/pdf",
        filename=f"{doc.name}.pdf"
    )

@router.post("/{document_id}/link/{report_id}")
def link_document_to_report(
    document_id: int,
    report_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    doc = db.query(Document).filter(
        Document.id == document_id,
        Document.user_id == current_user.id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    
    from models import Report
    report = db.query(Report).filter(
        Report.id == report_id,
        Report.user_id == current_user.id
    ).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    
    # Check if already linked
    existing = db.query(report_documents).filter(
        report_documents.c.report_id == report_id,
        report_documents.c.document_id == document_id
    ).first()
    if existing:
        return {"message": "Already linked"}
    
    stmt = report_documents.insert().values(report_id=report_id, document_id=document_id)
    db.execute(stmt)
    db.commit()
    return {"message": "Document linked to report"}

@router.delete("/{document_id}/link/{report_id}")
def unlink_document_from_report(
    document_id: int,
    report_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    db.query(report_documents).filter(
        report_documents.c.report_id == report_id,
        report_documents.c.document_id == document_id
    ).delete()
    db.commit()
    return {"message": "Document unlinked from report"}
```

- [ ] **Step 2: 创建 services/__init__.py**

```python
# Services module
```

- [ ] **Step 3: Commit**

```bash
git add backend/routes/documents.py backend/services/
git commit -m "feat: add documents management routes with file upload/download"
```

---

## Task 7: 分类路由

**Files:**
- Create: `backend/routes/categories.py`

- [ ] **Step 1: 创建 categories.py 路由**

```python
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List
from database import get_db
from models import Category, User
from auth import get_current_user

router = APIRouter()

class CategoryCreate(BaseModel):
    name: str

class CategoryUpdate(BaseModel):
    name: str

class CategoryResponse(BaseModel):
    id: int
    name: str
    is_default: bool
    class Config:
        from_attributes = True

@router.get("")
def list_categories(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    return db.query(Category).filter(Category.user_id == current_user.id).all()

@router.post("")
def create_category(
    category: CategoryCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    existing = db.query(Category).filter(
        Category.user_id == current_user.id,
        Category.name == category.name
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Category name already exists")
    
    db_category = Category(user_id=current_user.id, name=category.name)
    db.add(db_category)
    db.commit()
    db.refresh(db_category)
    return db_category

@router.put("/{category_id}")
def update_category(
    category_id: int,
    category_update: CategoryUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    category = db.query(Category).filter(
        Category.id == category_id,
        Category.user_id == current_user.id
    ).first()
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    
    if category.is_default:
        raise HTTPException(status_code=400, detail="Cannot rename default category")
    
    existing = db.query(Category).filter(
        Category.user_id == current_user.id,
        Category.name == category_update.name,
        Category.id != category_id
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Category name already exists")
    
    category.name = category_update.name
    db.commit()
    db.refresh(category)
    return category

@router.delete("/{category_id}")
def delete_category(
    category_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    category = db.query(Category).filter(
        Category.id == category_id,
        Category.user_id == current_user.id
    ).first()
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")
    
    if category.is_default:
        raise HTTPException(status_code=400, detail="Cannot delete default category")
    
    # Move documents to default category
    default_category = db.query(Category).filter(
        Category.user_id == current_user.id,
        Category.is_default == True
    ).first()
    
    if default_category:
        from models import Document
        db.query(Document).filter(Document.category_id == category_id).update(
            {Document.category_id: default_category.id}
        )
    
    db.delete(category)
    db.commit()
    return {"message": "Category deleted"}
```

- [ ] **Step 2: Commit**

```bash
git add backend/routes/categories.py
git commit -m "feat: add categories CRUD routes"
```

---

## Task 8: 后端启动测试

**Files:**
- None (testing existing code)

- [ ] **Step 1: 测试后端启动**

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000 &
sleep 3
curl -s http://localhost:8000/api/auth/me | head -20
```

Expected: 返回 401 或正常响应（取决于是否有 token）

- [ ] **Step 2: 测试注册**

```bash
curl -s -X POST http://localhost:8000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123"}' | head -50
```

Expected: 返回 access_token 和 user 信息

- [ ] **Step 3: Commit backend completion**

```bash
git add -A
git commit -m "feat: complete backend API implementation"
```

---

## Task 9: 前端项目初始化

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.js`
- Create: `frontend/index.html`
- Create: `frontend/src/main.jsx`
- Create: `frontend/src/App.jsx`
- Create: `frontend/src/index.css`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "curiosity-trail-frontend",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.22.0",
    "axios": "^1.6.5"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.2.1",
    "vite": "^5.0.12",
    "tailwindcss": "^3.4.1",
    "postcss": "^8.4.33",
    "autoprefixer": "^10.4.17"
  }
}
```

- [ ] **Step 2: 创建 vite.config.js**

```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true
      }
    }
  }
})
```

- [ ] **Step 3: 创建 index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Curiosity Trail 寻迹</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

- [ ] **Step 4: 创建 src/index.css**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --color-primary: #4A90D9;
  --color-primary-hover: #6BB3F0;
  --color-bg: #F5F7FA;
  --color-card: #FFFFFF;
  --color-text: #333333;
  --color-text-secondary: #666666;
  --color-border: #E0E4E8;
}

.dark {
  --color-bg: #1E1E1E;
  --color-card: #2D2D2D;
  --color-text: #E8E8E8;
  --color-text-secondary: #A0A0A0;
  --color-border: #404040;
}

body {
  background-color: var(--color-bg);
  color: var(--color-text);
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
}
```

- [ ] **Step 5: 创建 src/main.jsx**

```jsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

- [ ] **Step 6: 创建 src/App.jsx**

```jsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import Login from './pages/Login'
import Register from './pages/Register'
import Reports from './pages/Reports'
import ReportEditor from './pages/ReportEditor'
import Documents from './pages/Documents'
import Settings from './pages/Settings'
import Layout from './components/Layout'

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <div>Loading...</div>
  if (!user) return <Navigate to="/login" />
  return children
}

function AppRoutes() {
  const { user } = useAuth()
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/reports" /> : <Login />} />
      <Route path="/register" element={user ? <Navigate to="/reports" /> : <Register />} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Navigate to="/reports" />} />
        <Route path="reports" element={<Reports />} />
        <Route path="reports/:id" element={<ReportEditor />} />
        <Route path="documents" element={<Documents />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
```

- [ ] **Step 7: 创建 tailwind.config.js**

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        primary: '#4A90D9',
        'primary-hover': '#6BB3F0',
      }
    },
  },
  plugins: [],
}
```

- [ ] **Step 8: 创建 postcss.config.js**

```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

- [ ] **Step 9: 安装依赖**

```bash
cd frontend
npm install
```

- [ ] **Step 10: Commit**

```bash
git add frontend/package.json frontend/vite.config.js frontend/index.html frontend/src/
git commit -m "feat: initialize React + Vite + Tailwind frontend project"
```

---

## Task 10: 前端认证模块

**Files:**
- Create: `frontend/src/api/index.js`
- Create: `frontend/src/context/AuthContext.jsx`
- Create: `frontend/src/pages/Login.jsx`
- Create: `frontend/src/pages/Register.jsx`

- [ ] **Step 1: 创建 src/api/index.js**

```javascript
import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json'
  }
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

export const authAPI = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  register: (email, password) => api.post('/auth/register', { email, password }),
  me: () => api.get('/auth/me')
}

export const reportsAPI = {
  list: (params) => api.get('/reports', { params }),
  get: (id) => api.get(`/reports/${id}`),
  create: (data) => api.post('/reports', data),
  update: (id, data) => api.put(`/reports/${id}`, data),
  delete: (id) => api.delete(`/reports/${id}`),
  export: (id, format) => api.get(`/reports/${id}/export?format=${format}`, { responseType: 'blob' }),
  linkDocument: (reportId, docId) => api.post(`/documents/${docId}/link/${reportId}`),
  unlinkDocument: (reportId, docId) => api.delete(`/documents/${docId}/link/${reportId}`)
}

export const documentsAPI = {
  list: (params) => api.get('/documents', { params }),
  upload: (formData) => api.post('/documents', formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  delete: (id) => api.delete(`/documents/${id}`),
  download: (id) => api.get(`/documents/${id}/download`, { responseType: 'blob' })
}

export const categoriesAPI = {
  list: () => api.get('/categories'),
  create: (name) => api.post('/categories', { name }),
  update: (id, name) => api.put(`/categories/${id}`, { name }),
  delete: (id) => api.delete(`/categories/${id}`)
}

export default api
```

- [ ] **Step 2: 创建 src/context/AuthContext.jsx**

```jsx
import { createContext, useContext, useState, useEffect } from 'react'
import { authAPI } from '../api'

const AuthContext = createContext()

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('token')
    const savedUser = localStorage.getItem('user')
    if (token && savedUser) {
      setUser(JSON.parse(savedUser))
      authAPI.me().then(res => {
        setUser(res.data)
        localStorage.setItem('user', JSON.stringify(res.data))
      }).catch(() => {
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        setUser(null)
      }).finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  }, [])

  const login = async (email, password) => {
    const res = await authAPI.login(email, password)
    localStorage.setItem('token', res.data.access_token)
    localStorage.setItem('user', JSON.stringify(res.data.user))
    setUser(res.data.user)
  }

  const register = async (email, password) => {
    const res = await authAPI.register(email, password)
    localStorage.setItem('token', res.data.access_token)
    localStorage.setItem('user', JSON.stringify(res.data.user))
    setUser(res.data.user)
  }

  const logout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)
```

- [ ] **Step 3: 创建 src/pages/Login.jsx**

```jsx
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { login } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(email, password)
      navigate('/reports')
    } catch (err) {
      setError(err.response?.data?.detail || '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-200 w-full max-w-md">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">登录</h1>
        <p className="text-gray-500 mb-6">欢迎回来</p>
        
        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">
            {error}
          </div>
        )}
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
        
        <p className="text-center text-sm text-gray-500 mt-4">
          还没有账户？<Link to="/register" className="text-primary hover:underline">注册</Link>
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 创建 src/pages/Register.jsx**

```jsx
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function Register() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { register } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }
    
    if (password.length < 6) {
      setError('密码至少6位')
      return
    }
    
    setLoading(true)
    try {
      await register(email, password)
      navigate('/reports')
    } catch (err) {
      setError(err.response?.data?.detail || '注册失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white p-8 rounded-xl shadow-sm border border-gray-200 w-full max-w-md">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">注册</h1>
        <p className="text-gray-500 mb-6">创建你的账户</p>
        
        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm">
            {error}
          </div>
        )}
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">确认密码</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
              required
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {loading ? '注册中...' : '注册'}
          </button>
        </form>
        
        <p className="text-center text-sm text-gray-500 mt-4">
          已有账户？<Link to="/login" className="text-primary hover:underline">登录</Link>
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/index.js frontend/src/context/AuthContext.jsx frontend/src/pages/Login.jsx frontend/src/pages/Register.jsx
git commit -m "feat: add authentication module (API, context, login, register pages)"
```

---

## Task 11: 前端布局组件

**Files:**
- Create: `frontend/src/components/Layout.jsx`
- Create: `frontend/src/components/Sidebar.jsx`
- Create: `frontend/src/components/TopBar.jsx`

- [ ] **Step 1: 创建 src/components/Layout.jsx**

```jsx
import { Outlet } from 'react-router-dom'
import Sidebar from './Sidebar'
import TopBar from './TopBar'

export default function Layout() {
  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 创建 src/components/Sidebar.jsx**

```jsx
import { NavLink } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

const navItems = [
  { path: '/reports', label: '报告库', icon: '📝' },
  { path: '/documents', label: '文献库', icon: '📚' },
  { path: '/settings', label: '系统设置', icon: '⚙️' }
]

export default function Sidebar() {
  const { logout, user } = useAuth()

  return (
    <aside className="w-56 bg-gray-900 text-white flex flex-col">
      <div className="p-6">
        <h1 className="text-xl font-bold">🔭 Curiosity Trail</h1>
        <p className="text-xs text-gray-400 mt-1">科学探索记录</p>
      </div>
      
      <nav className="flex-1 px-3">
        {navItems.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-3 rounded-lg mb-1 transition-colors ${
                isActive ? 'bg-primary' : 'hover:bg-gray-800'
              }`
            }
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      
      <div className="p-4 border-t border-gray-800">
        <div className="text-sm text-gray-400 mb-2">{user?.email}</div>
        <button
          onClick={logout}
          className="text-sm text-gray-400 hover:text-white transition-colors"
        >
          退出登录
        </button>
      </div>
    </aside>
  )
}
```

- [ ] **Step 3: 创建 src/components/TopBar.jsx**

```jsx
import { useLocation } from 'react-router-dom'

const pageTitles = {
  '/reports': '探索报告',
  '/documents': '文献库',
  '/settings': '系统设置'
}

export default function TopBar() {
  const location = useLocation()
  const title = pageTitles[location.pathname] || 'Curiosity Trail'

  return (
    <header className="h-14 bg-white border-b border-gray-200 px-6 flex items-center justify-between">
      <h2 className="text-lg font-medium text-gray-900">{title}</h2>
    </header>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Layout.jsx frontend/src/components/Sidebar.jsx frontend/src/components/TopBar.jsx
git commit -m "feat: add Layout, Sidebar, TopBar components"
```

---

## Task 12: 前端报告库页面

**Files:**
- Create: `frontend/src/pages/Reports.jsx`

- [ ] **Step 1: 创建 src/pages/Reports.jsx**

```jsx
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { reportsAPI } from '../api'
import ConfirmDialog from '../components/ConfirmDialog'

export default function Reports() {
  const [reports, setReports] = useState([])
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState('modified_at')
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  const loadReports = async () => {
    setLoading(true)
    try {
      const res = await reportsAPI.list({ search, order_by: sortBy })
      setReports(res.data)
    } catch (err) {
      console.error('Failed to load reports:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadReports()
  }, [search, sortBy])

  const handleCreate = async (useTemplate) => {
    const title = prompt('请输入报告标题：')
    if (!title) return
    
    try {
      const res = await reportsAPI.create({
        title,
        content: useTemplate ? getTemplate() : ''
      })
      navigate(`/reports/${res.data.id}`)
    } catch (err) {
      alert(err.response?.data?.detail || '创建失败')
    }
  }

  const handleDelete = async (id, title) => {
    if (!confirm(`确定要删除报告「${title}」吗？`)) return
    try {
      await reportsAPI.delete(id)
      loadReports()
    } catch (err) {
      alert(err.response?.data?.detail || '删除失败')
    }
  }

  const formatDate = (date) => {
    return new Date(date).toLocaleString('zh-CN')
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">探索报告</h1>
        <div className="flex gap-2">
          <button
            onClick={() => handleCreate(true)}
            className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
          >
            ✨ 新建模板报告
          </button>
          <button
            onClick={() => handleCreate(false)}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
          >
            📄 新建空白报告
          </button>
        </div>
      </div>

      <div className="flex gap-4 items-center">
        <input
          type="text"
          placeholder="搜索报告..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg w-64 focus:ring-2 focus:ring-primary focus:border-transparent"
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg"
        >
          <option value="modified_at">🕐 修改时间</option>
          <option value="created_at">🕓 创建时间</option>
          <option value="title">📋 按标题</option>
        </select>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">加载中...</div>
      ) : reports.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          {search ? '没有找到匹配的报告' : '还没有报告，点击上方按钮创建'}
        </div>
      ) : (
        <div className="grid gap-4">
          {reports.map(report => (
            <div
              key={report.id}
              className="bg-white p-4 rounded-xl border border-gray-200 hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => navigate(`/reports/${report.id}`)}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-medium text-gray-900">{report.title}</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    创建: {formatDate(report.created_at)} · 修改: {formatDate(report.modified_at)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-primary">
                    📎 {report.document_count || 0} 篇关联文献
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDelete(report.id, report.title)
                    }}
                    className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function getTemplate() {
  return `1. 探索主题

2. 背景介绍

3. 提出问题

4. 猜想与假设

5. 实验材料与工具

6. 实验步骤

7. 实验数据与现象

8. 分析与结论

9. 反思与改进

10. 参考文献
`
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/Reports.jsx
git commit -m "feat: add Reports list page"
```

---

## Task 13: 前端报告编辑页面

**Files:**
- Create: `frontend/src/pages/ReportEditor.jsx`

- [ ] **Step 1: 创建 src/pages/ReportEditor.jsx**

```jsx
import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { reportsAPI, documentsAPI } from '../api'

export default function ReportEditor() {
  const { id } = useParams()
  const navigate = useNavigate()
  const isNew = !id || id === 'new'
  
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(!isNew)
  const [saving, setSaving] = useState(false)
  const [reportId, setReportId] = useState(id)
  const [linkedDocs, setLinkedDocs] = useState([])

  useEffect(() => {
    if (!isNew) {
      loadReport()
    }
  }, [id])

  const loadReport = async () => {
    try {
      const res = await reportsAPI.get(id)
      setTitle(res.data.title)
      setContent(res.data.content || '')
      setLinkedDocs(res.data.documents || [])
    } catch (err) {
      alert('加载报告失败')
      navigate('/reports')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!title.trim()) {
      alert('报告标题不能为空')
      return
    }
    
    setSaving(true)
    try {
      if (isNew) {
        const res = await reportsAPI.create({ title, content })
        setReportId(res.data.id)
        navigate(`/reports/${res.data.id}`, { replace: true })
      } else {
        await reportsAPI.update(reportId, { title, content })
      }
      alert('保存成功')
    } catch (err) {
      alert(err.response?.data?.detail || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleExport = async (format) => {
    if (!reportId) {
      alert('请先保存报告')
      return
    }
    
    try {
      const res = await reportsAPI.export(reportId, format)
      const blob = new Blob([res.data], { type: format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain' })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title}.${format}`
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (err) {
      alert('导出失败')
    }
  }

  if (loading) {
    return <div className="text-center py-12">加载中...</div>
  }

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <button
          onClick={() => navigate('/reports')}
          className="text-gray-500 hover:text-gray-700"
        >
          ← 返回报告库
        </button>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {saving ? '保存中...' : '💾 保存'}
          </button>
        </div>
      </div>

      <div>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="报告标题"
          className="w-full px-4 py-3 text-xl font-medium border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent"
        />
      </div>

      <div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="报告内容..."
          className="w-full h-96 px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary focus:border-transparent resize-none"
        />
      </div>

      <div className="bg-gray-50 p-4 rounded-lg">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium">📎 关联文献 ({linkedDocs.length})</h3>
          <div className="flex gap-2">
            <button
              onClick={() => {/* TODO: Link document dialog */}}
              className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-100"
            >
              添加关联
            </button>
          </div>
        </div>
        
        {linkedDocs.length === 0 ? (
          <p className="text-gray-500 text-sm">暂无关联文献</p>
        ) : (
          <div className="space-y-2">
            {linkedDocs.map(doc => (
              <div key={doc.id} className="flex items-center justify-between bg-white p-2 rounded">
                <span>📄 {doc.name}</span>
                <button
                  onClick={async () => {
                    if (!confirm('确定要解除关联吗？')) return
                    await reportsAPI.unlinkDocument(reportId, doc.id)
                    loadReport()
                  }}
                  className="text-gray-400 hover:text-red-500"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-2 pt-4 border-t">
        <button
          onClick={() => handleExport('txt')}
          disabled={!reportId}
          className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
        >
          📄 导出 TXT
        </button>
        <button
          onClick={() => handleExport('docx')}
          disabled={!reportId}
          className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover disabled:opacity-50"
        >
          📝 导出 DOCX
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/ReportEditor.jsx
git commit -m "feat: add ReportEditor page with save and export functionality"
```

---

## Task 14: 前端文献库页面

**Files:**
- Create: `frontend/src/pages/Documents.jsx`

- [ ] **Step 1: 创建 src/pages/Documents.jsx**

```jsx
import { useState, useEffect } from 'react'
import { documentsAPI, categoriesAPI } from '../api'

export default function Documents() {
  const [documents, setDocuments] = useState([])
  const [categories, setCategories] = useState([])
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState(null)
  const [loading, setLoading] = useState(true)

  const loadDocuments = async () => {
    setLoading(true)
    try {
      const params = {}
      if (search) params.search = search
      if (categoryFilter) params.category_id = categoryFilter
      const res = await documentsAPI.list(params)
      setDocuments(res.data)
    } catch (err) {
      console.error('Failed to load documents:', err)
    } finally {
      setLoading(false)
    }
  }

  const loadCategories = async () => {
    try {
      const res = await categoriesAPI.list()
      setCategories(res.data)
    } catch (err) {
      console.error('Failed to load categories:', err)
    }
  }

  useEffect(() => {
    loadCategories()
    loadDocuments()
  }, [search, categoryFilter])

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files)
    if (!files.length) return

    for (const file of files) {
      if (!file.name.endsWith('.pdf')) {
        alert('只支持 PDF 格式')
        continue
      }
      
      const formData = new FormData()
      formData.append('file', file)
      if (categoryFilter) formData.append('category_id', categoryFilter)

      try {
        await documentsAPI.upload(formData)
      } catch (err) {
        alert(`上传失败: ${file.name}`)
      }
    }
    
    loadDocuments()
    e.target.value = ''
  }

  const handleDelete = async (doc) => {
    if (!confirm(`确定要删除文献「${doc.name}」吗？\n注意：这将同时删除本地文件`)) return
    
    try {
      await documentsAPI.delete(doc.id)
      loadDocuments()
    } catch (err) {
      alert(err.response?.data?.detail || '删除失败')
    }
  }

  const handleDownload = async (doc) => {
    try {
      const res = await documentsAPI.download(doc.id)
      const blob = new Blob([res.data], { type: 'application/pdf' })
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${doc.name}.pdf`
      a.click()
      window.URL.revokeObjectURL(url)
    } catch (err) {
      alert('下载失败')
    }
  }

  const handleAddCategory = async () => {
    const name = prompt('请输入分类名称：')
    if (!name) return
    
    try {
      await categoriesAPI.create(name)
      loadCategories()
    } catch (err) {
      alert(err.response?.data?.detail || '创建分类失败')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">文献库</h1>
        <div className="flex gap-2">
          <button
            onClick={handleAddCategory}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            📁 管理分类
          </button>
          <label className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-hover cursor-pointer">
            ⬆️ 上传 PDF
            <input
              type="file"
              accept=".pdf"
              multiple
              onChange={handleUpload}
              className="hidden"
            />
          </label>
        </div>
      </div>

      <div className="flex gap-4 items-center">
        <input
          type="text"
          placeholder="搜索文献..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-4 py-2 border border-gray-300 rounded-lg w-64 focus:ring-2 focus:ring-primary focus:border-transparent"
        />
        <select
          value={categoryFilter || ''}
          onChange={(e) => setCategoryFilter(e.target.value ? Number(e.target.value) : null)}
          className="px-4 py-2 border border-gray-300 rounded-lg"
        >
          <option value="">📂 全部分类</option>
          {categories.map(cat => (
            <option key={cat.id} value={cat.id}>
              {cat.is_default ? '📂' : '📁'} {cat.name}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="text-center py-12 text-gray-500">加载中...</div>
      ) : documents.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          {search || categoryFilter ? '没有找到匹配的文献' : '还没有文献，点击上方按钮上传'}
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {documents.map(doc => {
            const category = categories.find(c => c.id === doc.category_id)
            return (
              <div
                key={doc.id}
                className="bg-white p-4 rounded-xl border border-gray-200 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 cursor-pointer" onClick={() => handleDownload(doc)}>
                    <h3 className="font-medium text-gray-900 truncate">{doc.name}</h3>
                    <p className="text-sm text-gray-500 mt-1">
                      {category ? `📁 ${category.name}` : '📂 未分类'}
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      {new Date(doc.created_at).toLocaleString('zh-CN')}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDelete(doc)}
                    className="p-2 text-gray-400 hover:text-red-500"
                  >
                    🗑️
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/Documents.jsx
git commit -m "feat: add Documents page with upload and category filter"
```

---

## Task 15: 前端系统设置页面

**Files:**
- Create: `frontend/src/pages/Settings.jsx`

- [ ] **Step 1: 创建 src/pages/Settings.jsx**

```jsx
import { useState, useEffect } from 'react'

export default function Settings() {
  const [theme, setTheme] = useState('light')

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme') || 'light'
    setTheme(savedTheme)
    if (savedTheme === 'dark') {
      document.documentElement.classList.add('dark')
    }
  }, [])

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light'
    setTheme(newTheme)
    localStorage.setItem('theme', newTheme)
    if (newTheme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold text-gray-900">系统设置</h1>

      <div className="bg-white p-6 rounded-xl border border-gray-200">
        <h2 className="font-medium text-gray-900 mb-4">外观</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-gray-700">主题模式</p>
            <p className="text-sm text-gray-500">
              {theme === 'light' ? '浅色模式' : '深色模式'}
            </p>
          </div>
          <button
            onClick={toggleTheme}
            className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            {theme === 'light' ? '🌙 切换深色' : '☀️ 切换浅色'}
          </button>
        </div>
      </div>

      <div className="bg-white p-6 rounded-xl border border-gray-200">
        <h2 className="font-medium text-gray-900 mb-4">关于</h2>
        <div className="space-y-2 text-sm text-gray-500">
          <p>Curiosity Trail 寻迹</p>
          <p>版本: 1.0.0</p>
          <p>个人科学探索记录 + PDF 文献管理工具</p>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/Settings.jsx
git commit -m "feat: add Settings page with theme toggle"
```

---

## Task 16: 前后端联调测试

- [ ] **Step 1: 启动后端**

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000 &
sleep 3
```

- [ ] **Step 2: 启动前端**

```bash
cd frontend
npm run dev &
sleep 5
```

- [ ] **Step 3: 测试完整流程**

1. 打开 http://localhost:5173
2. 注册用户 A
3. 创建报告，关联文献
4. 导出报告
5. 登出，注册用户 B
6. 验证用户 B 看不到用户 A 的数据

- [ ] **Step 4: Commit 联调完成**

```bash
git add -A
git commit -m "feat: complete frontend and backend integration"
```

---

## 验收标准

1. ✅ 用户可以注册和登录
2. ✅ 登录后看到自己的报告列表
3. ✅ 可以创建/编辑/删除报告
4. ✅ 可以上传 PDF 文献
5. ✅ 可以为报告关联/解除关联文献
6. ✅ 可以导出报告为 TXT/DOCX
7. ✅ 可以切换浅色/深色主题
8. ✅ 用户 A 无法访问用户 B 的数据（数据隔离）
9. ✅ 部署到服务器后两人可以通过浏览器访问

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-12-curiosity-trail-web-plan.md`**

两个执行选项：

**1. Subagent-Driven (recommended)** — 我调度独立子代理逐任务执行，任务间审查，快速迭代

**2. Inline Execution** — 本会话内批量执行任务，带检查点审查

选择哪个？