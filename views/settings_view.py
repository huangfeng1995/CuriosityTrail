from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel,
    QPushButton, QMessageBox, QListWidget, QListWidgetItem
)
from PyQt5.QtCore import Qt
from config import get_config, update_config, DATA_DIR, DOCUMENTS_DIR
from utils.theme import ThemeManager
from services.backup_service import BackupService
from utils.helpers import format_file_size, format_datetime
import os

class SettingsView(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setup_ui()

    def setup_ui(self):
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(20, 20, 20, 20)
        main_layout.setSpacing(15)

        title = QLabel("系统设置")
        title.setObjectName("viewTitle")
        main_layout.addWidget(title)

        theme_section = self.create_section("主题设置")
        main_layout.addWidget(theme_section)

        backup_section = self.create_backup_section()
        main_layout.addWidget(backup_section)

        path_section = self.create_path_section()
        main_layout.addWidget(path_section)

        main_layout.addStretch()

    def create_section(self, title):
        from PyQt5.QtWidgets import QFrame, QVBoxLayout
        frame = QFrame()
        frame.setObjectName("settingsSection")
        layout = QVBoxLayout(frame)
        layout.setContentsMargins(15, 15, 15, 15)

        label = QLabel(title)
        label.setObjectName("sectionTitle")
        layout.addWidget(label)

        return frame

    def create_backup_section(self):
        from PyQt5.QtWidgets import QFrame, QVBoxLayout, QHBoxLayout, QTableWidget, QHeaderView
        frame = QFrame()
        frame.setObjectName("settingsSection")
        layout = QVBoxLayout(frame)
        layout.setContentsMargins(15, 15, 15, 15)

        section_title = QLabel("数据备份与恢复")
        section_title.setObjectName("sectionTitle")
        layout.addWidget(section_title)

        btn_layout = QHBoxLayout()

        self.btn_backup = QPushButton("创建备份")
        self.btn_backup.clicked.connect(self.create_backup)
        btn_layout.addWidget(self.btn_backup)

        self.btn_restore = QPushButton("恢复备份")
        self.btn_restore.clicked.connect(self.restore_backup)
        btn_layout.addWidget(self.btn_restore)

        layout.addLayout(btn_layout)

        self.backup_list = QListWidget()
        self.backup_list.setMaximumHeight(150)
        layout.addWidget(self.backup_list)

        self.load_backup_list()

        return frame

    def create_path_section(self):
        from PyQt5.QtWidgets import QFrame, QVBoxLayout, QHBoxLayout
        frame = QFrame()
        frame.setObjectName("settingsSection")
        layout = QVBoxLayout(frame)
        layout.setContentsMargins(15, 15, 15, 15)

        section_title = QLabel("存储路径设置")
        section_title.setObjectName("sectionTitle")
        layout.addWidget(section_title)

        db_path_layout = QHBoxLayout()
        db_path_label = QLabel("数据库路径：")
        self.db_path_value = QLabel()
        self.db_path_value.setWordWrap(True)
        btn_change_db = QPushButton("修改")
        btn_change_db.clicked.connect(self.change_db_path)
        db_path_layout.addWidget(db_path_label)
        db_path_layout.addWidget(self.db_path_value, 1)
        db_path_layout.addWidget(btn_change_db)
        layout.addLayout(db_path_layout)

        docs_path_layout = QHBoxLayout()
        docs_path_label = QLabel("文献存储路径：")
        self.docs_path_value = QLabel()
        self.docs_path_value.setWordWrap(True)
        btn_change_docs = QPushButton("修改")
        btn_change_docs.clicked.connect(self.change_docs_path)
        docs_path_layout.addWidget(docs_path_label)
        docs_path_layout.addWidget(self.docs_path_value, 1)
        docs_path_layout.addWidget(btn_change_docs)
        layout.addLayout(docs_path_layout)

        self.update_path_display()

        return frame

    def update_path_display(self):
        config = get_config()
        self.db_path_value.setText(config.get("db_path", ""))
        self.docs_path_value.setText(config.get("docs_path", str(DOCUMENTS_DIR)))

    def load_backup_list(self):
        self.backup_list.clear()
        backups = BackupService.list_backups()
        for backup in backups:
            size_str = format_file_size(backup["size"])
            time_str = format_datetime(backup["created"].isoformat() if hasattr(backup["created"], 'isoformat') else str(backup["created"]))
            item = QListWidgetItem(f"{backup['name']} ({size_str}) - {time_str}")
            item.setData(Qt.UserRole, backup["path"])
            self.backup_list.addItem(item)

    def create_backup(self):
        from widgets.dialogs import FilePicker, ConfirmDialog
        backup_dir = FilePicker.select_directory(self, "选择备份保存位置")
        if not backup_dir:
            return

        try:
            backup_path = BackupService.create_backup(backup_dir)
            ConfirmDialog.info(self, "提示", f"备份创建成功！\n保存位置：{backup_path}")
            self.load_backup_list()
        except Exception as e:
            ConfirmDialog.error(self, "错误", f"备份创建失败：{str(e)}")

    def restore_backup(self):
        from widgets.dialogs import FilePicker, ConfirmDialog
        file_path = FilePicker.open_file(self, "选择备份文件", "ZIP压缩包 (*.zip)")
        if not file_path:
            return

        if ConfirmDialog.confirm(self, "确认恢复", "恢复备份将覆盖当前所有数据！\n确定要继续吗？"):
            success, msg = BackupService.restore_backup(file_path)
            if success:
                ConfirmDialog.info(self, "提示", "恢复成功！请重启应用以加载新数据")
            else:
                ConfirmDialog.error(self, "错误", f"恢复失败：{msg}")

    def change_db_path(self):
        from widgets.dialogs import FilePicker, ConfirmDialog
        new_path = FilePicker.select_directory(self, "选择数据库存储位置")
        if not new_path:
            return

        config = get_config()
        old_path = config.get("db_path", "")

        if ConfirmDialog.confirm(self, "确认", "修改路径后，系统将自动迁移现有数据到新位置。确定继续吗？"):
            try:
                new_db_path = os.path.join(new_path, "curiosity.db")
                if os.path.exists(old_path):
                    import shutil
                    shutil.copy2(old_path, new_db_path)

                update_config("db_path", new_db_path)
                self.update_path_display()
                ConfirmDialog.info(self, "提示", "数据库路径已修改")
            except Exception as e:
                ConfirmDialog.error(self, "错误", f"修改失败：{str(e)}")

    def change_docs_path(self):
        from widgets.dialogs import FilePicker, ConfirmDialog
        new_path = FilePicker.select_directory(self, "选择文献存储位置")
        if not new_path:
            return

        config = get_config()
        old_path = config.get("docs_path", str(DOCUMENTS_DIR))

        if ConfirmDialog.confirm(self, "确认", "修改路径后，系统将自动迁移现有PDF文件到新位置。确定继续吗？"):
            try:
                if os.path.exists(old_path) and old_path != new_path:
                    import shutil
                    if os.path.exists(new_path):
                        for item in os.listdir(old_path):
                            src = os.path.join(old_path, item)
                            dst = os.path.join(new_path, item)
                            if os.path.isfile(src):
                                shutil.copy2(src, dst)
                    else:
                        shutil.copytree(old_path, new_path)

                update_config("docs_path", new_path)
                self.update_path_display()
                ConfirmDialog.info(self, "提示", "文献存储路径已修改")
            except Exception as e:
                ConfirmDialog.error(self, "错误", f"修改失败：{str(e)}")