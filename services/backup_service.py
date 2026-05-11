import zipfile
import os
import shutil
from datetime import datetime
from config import get_config, DATA_DIR, DOCUMENTS_DIR

class BackupService:
    @staticmethod
    def create_backup(backup_dir=None):
        config = get_config()
        if backup_dir is None:
            backup_dir = DATA_DIR / "backups"
        else:
            backup_dir = os.path.abspath(backup_dir)

        os.makedirs(backup_dir, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_name = f"curiosity_backup_{timestamp}.zip"
        backup_path = os.path.join(backup_dir, backup_name)

        db_path = config.get("db_path")
        docs_path = config.get("docs_path", str(DOCUMENTS_DIR))

        with zipfile.ZipFile(backup_path, "w", zipfile.ZIP_DEFLATED) as zipf:
            if db_path and os.path.exists(db_path):
                zipf.write(db_path, "curiosity.db")

            if os.path.exists(docs_path):
                for root, dirs, files in os.walk(docs_path):
                    for file in files:
                        if file.endswith(".pdf"):
                            file_path = os.path.join(root, file)
                            arcname = os.path.join("documents", os.path.relpath(file_path, docs_path))
                            zipf.write(file_path, arcname)

        return backup_path

    @staticmethod
    def restore_backup(backup_path, target_db_path=None, target_docs_path=None):
        config = get_config()
        if target_db_path is None:
            target_db_path = config.get("db_path")
        if target_docs_path is None:
            target_docs_path = config.get("docs_path", str(DOCUMENTS_DIR))

        if not os.path.exists(backup_path):
            return False, "Backup file does not exist"

        try:
            target_db_dir = os.path.dirname(target_db_path)
            if target_db_dir and not os.path.exists(target_db_dir):
                os.makedirs(target_db_dir, exist_ok=True)

            target_docs_dir = os.path.dirname(target_docs_path)
            if target_docs_dir and not os.path.exists(target_docs_dir):
                os.makedirs(target_docs_dir, exist_ok=True)

            with zipfile.ZipFile(backup_path, "r") as zipf:
                zipf.extractall(os.path.dirname(target_db_path))

            return True, "Backup restored successfully"
        except Exception as e:
            return False, str(e)

    @staticmethod
    def list_backups(backup_dir=None):
        if backup_dir is None:
            backup_dir = DATA_DIR / "backups"
        else:
            backup_dir = os.path.abspath(backup_dir)

        if not os.path.exists(backup_dir):
            return []

        backups = []
        for filename in os.listdir(backup_dir):
            if filename.startswith("curiosity_backup_") and filename.endswith(".zip"):
                filepath = os.path.join(backup_dir, filename)
                stat = os.stat(filepath)
                backups.append({
                    "name": filename,
                    "path": filepath,
                    "size": stat.st_size,
                    "created": datetime.fromtimestamp(stat.st_mtime)
                })

        backups.sort(key=lambda x: x["created"], reverse=True)
        return backups

    @staticmethod
    def delete_backup(backup_path):
        if os.path.exists(backup_path):
            os.remove(backup_path)
            return True
        return False