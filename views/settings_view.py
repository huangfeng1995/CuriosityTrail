from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel,
    QPushButton, QMessageBox, QListWidget, QListWidgetItem,
    QFrame
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
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(20)

        title = QLabel("⚙️ 系统设置")
        title.setObjectName("viewTitle")
        main_layout.addWidget(title)

        content_layout = QVBoxLayout()
        content_layout.setSpacing(16)

        theme_card = self.create_card("🎨 主题设置")
        theme_layout = QHBoxLayout()
        theme_desc = QLabel("切换应用主题")
        theme_layout.addWidget(theme_desc)
        theme_layout.addStretch()

        self.btn_theme_toggle = QPushButton("🌙 浅色模式" if ThemeManager.is_dark() else "☀️ 深色模式")
        self.btn_theme_toggle.setObjectName("secondaryBtn")
        self.btn_theme_toggle.setCursor(Qt.PointingHandCursor)
        self.btn_theme_toggle.clicked.connect(self.toggle_theme)
        theme_layout.addWidget(self.btn_theme_toggle)
        theme_card.layout().addLayout(theme_layout)
        content_layout.addWidget(theme_card)

        backup_card = self.create_card("💾 数据备份与恢复")
        backup_layout = QVBoxLayout()

        btn_row = QHBoxLayout()
        btn_row.setSpacing(12)

        self.btn_backup = QPushButton("📦 创建备份")
        self.btn_backup.setObjectName("primaryBtn")
        self.btn_backup.clicked.connect(self.create_backup)
        btn_row.addWidget(self.btn_backup)

        self.btn_restore = QPushButton("📥 恢复备份")
        self.btn_restore.setObjectName("secondaryBtn")
        self.btn_restore.clicked.connect(self.restore_backup)
        btn_row.addWidget(self.btn_restore)

        btn_row.addStretch()
        backup_layout.addLayout(btn_row)

        self.backup_list = QListWidget()
        self.backup_list.setMinimumHeight(120)
        backup_layout.addWidget(self.backup_list)

        self.load_backup_list()

        backup_card.layout().addLayout(backup_layout)
        content_layout.addWidget(backup_card)

        path_card = self.create_card("📂 存储路径设置")
        path_layout = QVBoxLayout()
        path_layout.setSpacing(12)

        db_row = QHBoxLayout()
        db_label = QLabel("数据库路径：")
        db_label.setStyleSheet("color: #888;")
        self.db_path_value = QLabel()
        self.db_path_value.setStyleSheet("color: #666; font-size: 12px;")
        self.db_path_value.setWordWrap(True)
        btn_change_db = QPushButton("修改")
        btn_change_db.setObjectName("secondaryBtn")
        btn_change_db.setCursor(Qt.PointingHandCursor)
        btn_change_db.clicked.connect(self.change_db_path)
        db_row.addWidget(db_label)
        db_row.addWidget(self.db_path_value, 1)
        db_row.addWidget(btn_change_db)
        path_layout.addLayout(db_row)

        docs_row = QHBoxLayout()
        docs_label = QLabel("文献存储路径：")
        docs_label.setStyleSheet("color: #888;")
        self.docs_path_value = QLabel()
        self.docs_path_value.setStyleSheet("color: #666; font-size: 12px;")
        self.docs_path_value.setWordWrap(True)
        btn_change_docs = QPushButton("修改")
        btn_change_docs.setObjectName("secondaryBtn")
        btn_change_docs.setCursor(Qt.PointingHandCursor)
        btn_change_docs.clicked.connect(self.change_docs_path)
        docs_row.addWidget(docs_label)
        docs_row.addWidget(self.docs_path_value, 1)
        docs_row.addWidget(btn_change_docs)
        path_layout.addLayout(docs_row)

        self.update_path_display()

        path_card.layout().addLayout(path_layout)
        content_layout.addWidget(path_card)

        main_layout.addLayout(content_layout)
        main_layout.addStretch()

    def create_card(self, title):
        card = QFrame()
        card.setObjectName("settingsCard")
        layout = QVBoxLayout(card)
        layout.setContentsMargins(20, 16, 20, 16)
        layout.setSpacing(12)

        title_label = QLabel(title)
        title_label.setObjectName("cardTitle")
        layout.addWidget(title_label)

        return card

    def update_path_display(self):
        config = get_config()
        self.db_path_value.setText(config.get("db_path", ""))
        self.docs_path_value.setText(config.get("docs_path", str(DOCUMENTS_DIR)))

    def load_backup_list(self):
        self.backup_list.clear()
        backups = BackupService.list_backups()
        if not backups:
            item = QListWidgetItem("暂无备份记录")
            item.setFlags(item.flags() & ~Qt.ItemIsEnabled)
            self.backup_list.addItem(item)
            return

        for backup in backups:
            size_str = format_file_size(backup["size"])
            time_str = format_datetime(backup["created"].isoformat() if hasattr(backup["created"], 'isoformat') else str(backup["created"]))
            item = QListWidgetItem(f"📦 {backup['name']}  ({size_str})  -  {time_str}")
            item.setData(Qt.UserRole, backup["path"])
            self.backup_list.addItem(item)

    def toggle_theme(self):
        current = ThemeManager.get_current_theme_name()
        new_theme = "dark" if current == "light" else "light"
        ThemeManager.set_theme(new_theme)

        if ThemeManager.is_dark():
            self.btn_theme_toggle.setText("🌙 浅色模式")
        else:
            self.btn_theme_toggle.setText("☀️ 深色模式")

        from views.main_window import MainWindow
        for w in self.window().findChildren(MainWindow):
            w.apply_theme()

    def create_backup(self):
        from widgets.dialogs import FilePicker, ConfirmDialog
        backup_dir = FilePicker.select_directory(self, "选择备份保存位置")
        if not backup_dir:
            return

        try:
            backup_path = BackupService.create_backup(backup_dir)
            ConfirmDialog.info(self, "提示", f"✅ 备份创建成功！\n\n保存位置：{backup_path}")
            self.load_backup_list()
        except Exception as e:
            ConfirmDialog.error(self, "错误", f"备份创建失败：{str(e)}")

    def restore_backup(self):
        from widgets.dialogs import FilePicker, ConfirmDialog
        file_path = FilePicker.open_file(self, "选择备份文件", "ZIP 压缩包 (*.zip)")
        if not file_path:
            return

        if ConfirmDialog.confirm(self, "确认恢复", "⚠️ 恢复备份将覆盖当前所有数据！\n\n确定要继续吗？"):
            success, msg = BackupService.restore_backup(file_path)
            if success:
                ConfirmDialog.info(self, "提示", "✅ 恢复成功！请重启应用以加载新数据")
            else:
                ConfirmDialog.error(self, "错误", f"恢复失败：{msg}")

    def change_db_path(self):
        from widgets.dialogs import FilePicker, ConfirmDialog
        new_path = FilePicker.select_directory(self, "选择数据库存储位置")
        if not new_path:
            return

        config = get_config()
        old_path = config.get("db_path", "")

        if ConfirmDialog.confirm(self, "确认", "修改路径后，系统将自动迁移现有数据到新位置。\n\n确定继续吗？"):
            try:
                new_db_path = os.path.join(new_path, "curiosity.db")
                if os.path.exists(old_path):
                    import shutil
                    shutil.copy2(old_path, new_db_path)

                update_config("db_path", new_db_path)
                self.update_path_display()
                ConfirmDialog.info(self, "提示", "✅ 数据库路径已修改")
            except Exception as e:
                ConfirmDialog.error(self, "错误", f"修改失败：{str(e)}")

    def change_docs_path(self):
        from widgets.dialogs import FilePicker, ConfirmDialog
        new_path = FilePicker.select_directory(self, "选择文献存储位置")
        if not new_path:
            return

        config = get_config()
        old_path = config.get("docs_path", str(DOCUMENTS_DIR))

        if ConfirmDialog.confirm(self, "确认", "修改路径后，系统将自动迁移现有 PDF 文件到新位置。\n\n确定继续吗？"):
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
                ConfirmDialog.info(self, "提示", "✅ 文献存储路径已修改")
            except Exception as e:
                ConfirmDialog.error(self, "错误", f"修改失败：{str(e)}")