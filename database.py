import sqlite3
from contextlib import contextmanager
from config import get_config

def get_db_connection():
    config = get_config()
    conn = sqlite3.connect(config["db_path"])
    conn.row_factory = sqlite3.Row
    return conn

@contextmanager
def get_db():
    conn = get_db_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

def init_database():
    with get_db() as conn:
        cursor = conn.cursor()

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(100) NOT NULL UNIQUE,
                is_default BOOLEAN DEFAULT FALSE
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title VARCHAR(200) NOT NULL UNIQUE,
                content TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                modified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_template BOOLEAN DEFAULT FALSE
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name VARCHAR(200) NOT NULL,
                file_path VARCHAR(500) NOT NULL,
                category_id INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (category_id) REFERENCES categories(id)
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS report_documents (
                report_id INTEGER,
                document_id INTEGER,
                PRIMARY KEY (report_id, document_id),
                FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
                FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(50) PRIMARY KEY,
                value TEXT
            )
        """)

        cursor.execute("SELECT COUNT(*) FROM categories WHERE is_default = 1")
        if cursor.fetchone()[0] == 0:
            cursor.execute(
                "INSERT INTO categories (name, is_default) VALUES (?, ?)",
                ("未分类", True)
            )

        conn.commit()

def execute_query(sql, params=None):
    with get_db() as conn:
        cursor = conn.cursor()
        if params:
            cursor.execute(sql, params)
        else:
            cursor.execute(sql)
        return cursor.fetchall()

def execute_insert(sql, params=None):
    with get_db() as conn:
        cursor = conn.cursor()
        if params:
            cursor.execute(sql, params)
        else:
            cursor.execute(sql)
        return cursor.lastrowid

def execute_update(sql, params=None):
    with get_db() as conn:
        cursor = conn.cursor()
        if params:
            cursor.execute(sql, params)
        else:
            cursor.execute(sql)
        return cursor.rowcount

def get_all_tables():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        return [row[0] for row in cursor.fetchall()] 