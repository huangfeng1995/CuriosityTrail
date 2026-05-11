from database import execute_query, execute_insert, execute_update, get_db

class Category:
    def __init__(self, id=None, name="", is_default=False):
        self.id = id
        self.name = name
        self.is_default = is_default

    @staticmethod
    def get_all():
        sql = "SELECT * FROM categories ORDER BY is_default DESC, name ASC"
        results = execute_query(sql)
        categories = []
        for row in results:
            cat = Category(
                id=row["id"],
                name=row["name"],
                is_default=bool(row["is_default"])
            )
            categories.append(cat)
        return categories

    @staticmethod
    def get_by_id(category_id):
        sql = "SELECT * FROM categories WHERE id = ?"
        results = execute_query(sql, (category_id,))
        if results:
            row = results[0]
            return Category(
                id=row["id"],
                name=row["name"],
                is_default=bool(row["is_default"])
            )
        return None

    @staticmethod
    def get_default():
        sql = "SELECT * FROM categories WHERE is_default = 1"
        results = execute_query(sql)
        if results:
            row = results[0]
            return Category(
                id=row["id"],
                name=row["name"],
                is_default=True
            )
        return None

    @staticmethod
    def create(name):
        sql = "INSERT INTO categories (name) VALUES (?)"
        return execute_insert(sql, (name,))

    @staticmethod
    def update(category_id, name):
        sql = "UPDATE categories SET name = ? WHERE id = ?"
        execute_update(sql, (name, category_id))

    @staticmethod
    def delete(category_id):
        default_cat = Category.get_default()
        if default_cat and default_cat.id == category_id:
            return False

        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE documents SET category_id = ? WHERE category_id = ?",
                (default_cat.id if default_cat else None, category_id)
            )
            cursor.execute("DELETE FROM categories WHERE id = ? AND is_default = 0", (category_id,))
        return True

    @staticmethod
    def name_exists(name, exclude_id=None):
        if exclude_id:
            sql = "SELECT COUNT(*) FROM categories WHERE name = ? AND id != ?"
            result = execute_query(sql, (name, exclude_id))
        else:
            sql = "SELECT COUNT(*) FROM categories WHERE name = ?"
            result = execute_query(sql, (name,))
        return result[0][0] > 0

    @staticmethod
    def get_document_count(category_id):
        sql = "SELECT COUNT(*) FROM documents WHERE category_id = ?"
        result = execute_query(sql, (category_id,))
        return result[0][0] if result else 0

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "is_default": self.is_default,
            "document_count": self.get_document_count(self.id) if self.id else 0
        }