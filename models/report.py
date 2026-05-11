from database import execute_query, execute_insert, execute_update, get_db

class Report:
    def __init__(self, id=None, title="", content="", created_at=None, modified_at=None, is_template=False):
        self.id = id
        self.title = title
        self.content = content
        self.created_at = created_at
        self.modified_at = modified_at
        self.is_template = is_template

    @staticmethod
    def get_all(search=None, order_by="modified_at", order_dir="DESC"):
        valid_orders = ["title", "created_at", "modified_at"]
        if order_by not in valid_orders:
            order_by = "modified_at"
        order_dir = "DESC" if order_dir == "DESC" else "ASC"

        if search:
            sql = f"SELECT * FROM reports WHERE title LIKE ? ORDER BY {order_by} {order_dir}"
            results = execute_query(sql, (f"%{search}%",))
        else:
            sql = f"SELECT * FROM reports ORDER BY {order_by} {order_dir}"
            results = execute_query(sql)

        reports = []
        for row in results:
            report = Report(
                id=row["id"],
                title=row["title"],
                content=row["content"],
                created_at=row["created_at"],
                modified_at=row["modified_at"],
                is_template=bool(row["is_template"])
            )
            reports.append(report)
        return reports

    @staticmethod
    def get_by_id(report_id):
        sql = "SELECT * FROM reports WHERE id = ?"
        results = execute_query(sql, (report_id,))
        if results:
            row = results[0]
            return Report(
                id=row["id"],
                title=row["title"],
                content=row["content"],
                created_at=row["created_at"],
                modified_at=row["modified_at"],
                is_template=bool(row["is_template"])
            )
        return None

    @staticmethod
    def create(title, content="", is_template=False):
        sql = "INSERT INTO reports (title, content, is_template) VALUES (?, ?, ?)"
        return execute_insert(sql, (title, content, is_template))

    @staticmethod
    def update(report_id, title=None, content=None):
        from datetime import datetime
        if title is not None and content is not None:
            sql = "UPDATE reports SET title = ?, content = ?, modified_at = ? WHERE id = ?"
            execute_update(sql, (title, content, datetime.now().isoformat(), report_id))
        elif title is not None:
            sql = "UPDATE reports SET title = ?, modified_at = ? WHERE id = ?"
            execute_update(sql, (title, datetime.now().isoformat(), report_id))
        elif content is not None:
            sql = "UPDATE reports SET content = ?, modified_at = ? WHERE id = ?"
            execute_update(sql, (content, datetime.now().isoformat(), report_id))

    @staticmethod
    def delete(report_id):
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM report_documents WHERE report_id = ?", (report_id,))
            cursor.execute("DELETE FROM reports WHERE id = ?", (report_id,))

    @staticmethod
    def title_exists(title, exclude_id=None):
        if exclude_id:
            sql = "SELECT COUNT(*) FROM reports WHERE title = ? AND id != ?"
            result = execute_query(sql, (title, exclude_id))
        else:
            sql = "SELECT COUNT(*) FROM reports WHERE title = ?"
            result = execute_query(sql, (title,))
        return result[0][0] > 0

    @staticmethod
    def get_document_count(report_id):
        sql = "SELECT COUNT(*) FROM report_documents WHERE report_id = ?"
        result = execute_query(sql, (report_id,))
        return result[0][0] if result else 0

    @staticmethod
    def get_linked_documents(report_id):
        sql = """
            SELECT d.* FROM documents d
            INNER JOIN report_documents rd ON d.id = rd.document_id
            WHERE rd.report_id = ?
        """
        from models.document import Document
        results = execute_query(sql, (report_id,))
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
    def link_document(report_id, document_id):
        sql = "INSERT OR IGNORE INTO report_documents (report_id, document_id) VALUES (?, ?)"
        execute_insert(sql, (report_id, document_id))

    @staticmethod
    def unlink_document(report_id, document_id):
        sql = "DELETE FROM report_documents WHERE report_id = ? AND document_id = ?"
        execute_update(sql, (report_id, document_id))

    def to_dict(self):
        return {
            "id": self.id,
            "title": self.title,
            "content": self.content,
            "created_at": self.created_at,
            "modified_at": self.modified_at,
            "is_template": self.is_template,
            "document_count": self.get_document_count(self.id) if self.id else 0
        }