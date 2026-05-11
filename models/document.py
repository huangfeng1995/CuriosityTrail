from database import execute_query, execute_insert, execute_update, get_db
from config import get_config
import os
import shutil

class Document:
    def __init__(self, id=None, name="", file_path="", category_id=None, created_at=None):
        self.id = id
        self.name = name
        self.file_path = file_path
        self.category_id = category_id
        self.created_at = created_at

    @staticmethod
    def get_all(search=None, category_id=None, order_by="created_at", order_dir="DESC"):
        valid_orders = ["name", "created_at"]
        if order_by not in valid_orders:
            order_by = "created_at"
        order_dir = "DESC" if order_dir == "DESC" else "ASC"

        conditions = []
        params = []

        if search:
            conditions.append("name LIKE ?")
            params.append(f"%{search}%")

        if category_id is not None:
            conditions.append("category_id = ?")
            params.append(category_id)

        where_clause = " AND ".join(conditions) if conditions else "1=1"
        sql = f"SELECT * FROM documents WHERE {where_clause} ORDER BY {order_by} {order_dir}"

        results = execute_query(sql, params if params else None)

        docs = []
        for row in results:
            doc = Document(
                id=row["id"],
                name=row["name"],
                file_path=row["file_path"],
                category_id=row["category_id"],
                created_at=row["created_at"]
            )
            docs.append(doc)
        return docs

    @staticmethod
    def get_by_id(doc_id):
        sql = "SELECT * FROM documents WHERE id = ?"
        results = execute_query(sql, (doc_id,))
        if results:
            row = results[0]
            return Document(
                id=row["id"],
                name=row["name"],
                file_path=row["file_path"],
                category_id=row["category_id"],
                created_at=row["created_at"]
            )
        return None

    @staticmethod
    def create(name, source_path, category_id=None):
        config = get_config()
        docs_path = config.get("docs_path", str(config.get("DOCUMENTS_DIR", "documents")))

        if not os.path.exists(docs_path):
            os.makedirs(docs_path, exist_ok=True)

        dest_path = os.path.join(docs_path, f"{name}.pdf")
        if os.path.exists(dest_path):
            base_name = name
            counter = 1
            while os.path.exists(dest_path):
                dest_path = os.path.join(docs_path, f"{base_name}_{counter}.pdf")
                counter += 1

        shutil.copy2(source_path, dest_path)

        sql = "INSERT INTO documents (name, file_path, category_id) VALUES (?, ?, ?)"
        doc_id = execute_insert(sql, (name, dest_path, category_id))
        return doc_id

    @staticmethod
    def update(doc_id, name=None, category_id=None):
        if name is not None and category_id is not None:
            sql = "UPDATE documents SET name = ?, category_id = ? WHERE id = ?"
            execute_update(sql, (name, category_id, doc_id))
        elif name is not None:
            sql = "UPDATE documents SET name = ? WHERE id = ?"
            execute_update(sql, (name, doc_id))
        elif category_id is not None:
            sql = "UPDATE documents SET category_id = ? WHERE id = ?"
            execute_update(sql, (category_id, doc_id))

    @staticmethod
    def delete(doc_id):
        doc = Document.get_by_id(doc_id)
        if doc and os.path.exists(doc.file_path):
            try:
                os.remove(doc.file_path)
            except OSError:
                pass

        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM report_documents WHERE document_id = ?", (doc_id,))
            cursor.execute("DELETE FROM documents WHERE id = ?", (doc_id,))

    @staticmethod
    def move_to_category(doc_id, category_id):
        sql = "UPDATE documents SET category_id = ? WHERE id = ?"
        execute_update(sql, (category_id, doc_id))

    def exists(self):
        return os.path.exists(self.file_path) if self.file_path else False

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "file_path": self.file_path,
            "category_id": self.category_id,
            "created_at": self.created_at,
            "exists": self.exists()
        }