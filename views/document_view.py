from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel,
    QPushButton, QListWidget, QListWidgetItem,
    QLineEdit, QComboBox, QMessageBox, QAbstractItemView
)
from PyQt5.QtCore import Qt
from models.document import Document
from models.category import Category
from utils.helpers import open_file_with_default_app, format_datetime
from widgets.dialogs import ConfirmDialog, FilePicker
import os

class DocumentView(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setup_ui()
        self.load_categories()
        self.load_documents()

    def setup_ui(self):
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(20)

        header_layout = QHBoxLayout()
        header_layout.setSpacing(16)

        title = QLabel("📚 文献库")
        title.setObjectName("viewTitle")
        header_layout.addWidget(title)
        header_layout.addStretch()

        btn_upload = QPushButton("⬆️  上传 PDF")
        btn_upload.setObjectName("primaryBtn")
        btn_upload.clicked.connect(self.upload_documents)
        header_layout.addWidget(btn_upload)

        btn_manage_cats = QPushButton("📁  管理分类")
        btn_manage_cats.clicked.connect(self.manage_categories)
        header_layout.addWidget(btn_manage_cats)

        main_layout.addLayout(header_layout)

        filter_layout = QHBoxLayout()
        filter_layout.setSpacing(12)

        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("🔍 搜索文献...")
        self.search_input.setMinimumWidth(200)
        self.search_input.textChanged.connect(self.on_search)
        filter_layout.addWidget(self.search_input)

        self.category_filter = QComboBox()
        self.category_filter.setMinimumWidth(140)
        self.category_filter.currentIndexChanged.connect(self.on_category_filter_changed)
        filter_layout.addWidget(self.category_filter)

        filter_layout.addStretch()

        main_layout.addLayout(filter_layout)

        self.doc_list = QListWidget()
        self.doc_list.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.doc_list.itemDoubleClicked.connect(self.view_document)
        self.doc_list.setContextMenuPolicy(Qt.CustomContextMenu)
        self.doc_list.customContextMenuRequested.connect(self.show_context_menu)
        main_layout.addWidget(self.doc_list, 1)

    def load_categories(self):
        self.category_filter.blockSignals(True)
        self.category_filter.clear()
        self.category_filter.addItem("📂 全部分类", None)
        categories = Category.get_all()
        for cat in categories:
            icon = "📁" if cat.is_default else "📂"
            self.category_filter.addItem(f"{icon} {cat.name}", cat.id)
        self.category_filter.blockSignals(False)

    def load_documents(self, search=None, category_id=None):
        self.doc_list.clear()
        documents = Document.get_all(search=search, category_id=category_id)

        for doc in documents:
            item = QListWidgetItem()
            item.setData(Qt.UserRole, doc.id)
            item.setSizeHint(Qt.QSize(0, 64))
            self.doc_list.addItem(item)

        self.update_list_items()

    def update_list_items(self):
        for i in range(self.doc_list.count()):
            item = self.doc_list.item(i)
            doc_id = item.data(Qt.UserRole)
            doc = Document.get_by_id(doc_id)
            if doc:
                category = Category.get_by_id(doc.category_id) if doc.category_id else None
                category_name = category.name if category else "未分类"
                exists = "✅" if os.path.exists(doc.file_path) else "❌"
                created = format_datetime(doc.created_at)

                title_text = f"<b>{doc.name}</b>"
                meta_text = f"<span style='color: #888;'>分类: {category_name} · 添加: {created}</span>"

                item.setText(f"{title_text}\n{meta_text} {exists}")

    def on_search(self, text):
        category_id = self.category_filter.currentData()
        self.load_documents(search=text if text else None, category_id=category_id)

    def on_category_filter_changed(self, index):
        category_id = self.category_filter.currentData()
        search = self.search_input.text() if self.search_input.text() else None
        self.load_documents(search=search, category_id=category_id)

    def upload_documents(self):
        files = FilePicker.open_files(self, "选择 PDF 文件", "PDF 文件 (*.pdf)")
        if not files:
            return

        default_category = Category.get_default()
        category_id = default_category.id if default_category else None

        success_count = 0
        error_count = 0
        for filepath in files:
            try:
                name = os.path.splitext(os.path.basename(filepath))[0]
                Document.create(name, filepath, category_id)
                success_count += 1
            except Exception as e:
                error_count += 1

        if success_count > 0:
            ConfirmDialog.info(self, "提示", f"✅ 成功上传 {success_count} 个文件")
        if error_count > 0:
            ConfirmDialog.warning(self, "提示", f"⚠️ 有 {error_count} 个文件上传失败")

        self.load_documents()
        self.load_categories()

    def view_document(self, item):
        doc_id = item.data(Qt.UserRole)
        doc = Document.get_by_id(doc_id)
        if doc and os.path.exists(doc.file_path):
            success, msg = open_file_with_default_app(doc.file_path)
            if not success:
                ConfirmDialog.error(self, "错误", f"打开文件失败：{msg}")
        else:
            ConfirmDialog.error(self, "错误", "文献文件不存在或已被移动")

    def show_context_menu(self, position):
        from PyQt5.QtWidgets import QMenu
        item = self.doc_list.itemAt(position)
        if not item:
            return

        menu = QMenu(self)
        menu.setStyleSheet("""
            QMenu {
                background-color: #fff;
                border: 1px solid #e0e0e0;
                border-radius: 8px;
                padding: 4px;
            }
            QMenu::item {
                padding: 8px 20px;
                border-radius: 4px;
            }
        """)

        action_view = menu.addAction("👁️  查看")
        action_view.triggered.connect(lambda: self.view_document(item))

        action_rename = menu.addAction("✏️  重命名")
        action_rename.triggered.connect(lambda: self.rename_document(item))

        action_move = menu.addAction("📁  移动分类")
        action_move.triggered.connect(lambda: self.move_document(item))

        menu.addSeparator()

        action_delete = menu.addAction("🗑️  删除")
        action_delete.triggered.connect(lambda: self.delete_document(item))

        menu.exec_(self.doc_list.mapToGlobal(position))

    def rename_document(self, item):
        doc_id = item.data(Qt.UserRole)
        doc = Document.get_by_id(doc_id)
        if not doc:
            return

        from widgets.dialogs import RenameDialog
        dialog = RenameDialog(self, doc.name, "重命名文献")
        if dialog.exec_() == dialog.Accepted:
            new_name = dialog.get_result()
            if new_name and new_name != doc.name:
                Document.update(doc_id, new_name)
                self.load_documents()

    def move_document(self, item):
        doc_id = item.data(Qt.UserRole)
        doc = Document.get_by_id(doc_id)
        if not doc:
            return

        from widgets.dialogs import CategorySelectorDialog
        dialog = CategorySelectorDialog(self, doc.category_id)
        if dialog.exec_() == dialog.Accepted:
            new_category_id = dialog.get_selected_category_id()
            Document.move_to_category(doc_id, new_category_id)
            self.load_documents()
            self.load_categories()

    def delete_document(self, item):
        doc_id = item.data(Qt.UserRole)
        doc = Document.get_by_id(doc_id)
        if not doc:
            return

        if ConfirmDialog.confirm(self, "确认", f"确定要删除文献「{doc.name}」吗？\n\n⚠️ 注意：这将同时删除本地文件"):
            Document.delete(doc_id)
            self.load_documents()
            self.load_categories()
            ConfirmDialog.info(self, "提示", "删除成功")

    def manage_categories(self):
        from widgets.dialogs import CategorySelectorDialog
        from PyQt5.QtWidgets import QDialog, QVBoxLayout, QListWidget, QListWidgetItem, QPushButton

        dialog = QDialog(self)
        dialog.setWindowTitle("📁 管理分类")
        dialog.setMinimumSize(400, 450)

        layout = QVBoxLayout(dialog)

        cat_list = QListWidget()
        layout.addWidget(cat_list)

        categories = Category.get_all()
        for cat in categories:
            icon = "📂" if cat.is_default else "📁"
            item = QListWidgetItem(f"{icon} {cat.name}")
            item.setData(Qt.UserRole, cat.id)
            item.setData(Qt.UserRole + 1, cat.is_default)
            cat_list.addItem(item)

        btn_layout = QHBoxLayout()

        btn_add = QPushButton("➕ 新建")
        btn_add.clicked.connect(lambda: self.add_category(cat_list))
        btn_layout.addWidget(btn_add)

        btn_rename = QPushButton("✏️ 重命名")
        btn_rename.clicked.connect(lambda: self.rename_category(cat_list))
        btn_layout.addWidget(btn_rename)

        btn_delete = QPushButton("🗑️ 删除")
        btn_delete.clicked.connect(lambda: self.delete_category(cat_list))
        btn_layout.addWidget(btn_delete)

        layout.addLayout(btn_layout)

        btn_close = QPushButton("关闭")
        btn_close.clicked.connect(dialog.close)
        layout.addWidget(btn_close)

        dialog.exec_()
        self.load_categories()
        self.load_documents()

    def add_category(self, cat_list):
        from widgets.dialogs import InputDialog
        name, ok = InputDialog.get_text(self, "新建分类", "请输入分类名称：")
        if ok and name:
            if Category.name_exists(name):
                ConfirmDialog.warning(self, "提示", "分类名称已存在")
                return
            Category.create(name)
            self.refresh_category_list(cat_list)

    def rename_category(self, cat_list):
        current_item = cat_list.currentItem()
        if not current_item:
            return

        cat_id = current_item.data(Qt.UserRole)
        is_default = current_item.data(Qt.UserRole + 1)
        if is_default:
            ConfirmDialog.warning(self, "提示", "默认分类「未分类」不能重命名")
            return

        old_name = current_item.text().replace("📂 ", "").replace("📁 ", "")
        from widgets.dialogs import RenameDialog
        dialog = RenameDialog(self, old_name, "重命名分类")
        if dialog.exec_() == dialog.Accepted:
            new_name = dialog.get_result()
            if new_name and new_name != old_name:
                if Category.name_exists(new_name):
                    ConfirmDialog.warning(self, "提示", "分类名称已存在")
                    return
                Category.update(cat_id, new_name)
                self.refresh_category_list(cat_list)

    def delete_category(self, cat_list):
        current_item = cat_list.currentItem()
        if not current_item:
            return

        cat_id = current_item.data(Qt.UserRole)
        is_default = current_item.data(Qt.UserRole + 1)
        if is_default:
            ConfirmDialog.warning(self, "提示", "默认分类「未分类」不能删除")
            return

        if ConfirmDialog.confirm(self, "确认", "确定要删除此分类吗？\n⚠️ 注意：分类下的文献将移动到「未分类」"):
            Category.delete(cat_id)
            self.refresh_category_list(cat_list)

    def refresh_category_list(self, cat_list):
        cat_list.clear()
        categories = Category.get_all()
        for cat in categories:
            icon = "📂" if cat.is_default else "📁"
            item = QListWidgetItem(f"{icon} {cat.name}")
            item.setData(Qt.UserRole, cat.id)
            item.setData(Qt.UserRole + 1, cat.is_default)
            cat_list.addItem(item)