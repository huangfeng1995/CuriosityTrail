from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel,
    QPushButton, QWidget, QLineEdit, QTextEdit,
    QListWidget, QFileDialog, QMessageBox, QInputDialog,
    QListWidgetItem, QAbstractItemView
)
from PyQt5.QtCore import Qt
from models import Document, Category
from utils.helpers import format_file_size
import os

class ConfirmDialog(QMessageBox):
    @staticmethod
    def confirm(parent, title, message):
        reply = QMessageBox.question(
            parent, title, message,
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No
        )
        return reply == QMessageBox.Yes

    @staticmethod
    def info(parent, title, message):
        QMessageBox.information(parent, title, message)

    @staticmethod
    def warning(parent, title, message):
        QMessageBox.warning(parent, title, message)

    @staticmethod
    def error(parent, title, message):
        QMessageBox.critical(parent, title, message)

class InputDialog(QInputDialog):
    @staticmethod
    def get_text(parent, title, label, default=""):
        text, ok = QInputDialog.getText(parent, title, label, text=default)
        return text, ok

    @staticmethod
    def get_multiline_text(parent, title, label, default=""):
        dialog = QInputDialog(parent)
        dialog.setWindowTitle(title)
        dialog.setLabelText(label)
        text_edit = QTextEdit()
        text_edit.setPlainText(default)
        dialog.setTextValue(default)
        ok = dialog.exec_() == QDialog.Accepted
        return dialog.textValue(), ok

class FilePicker:
    @staticmethod
    def open_file(parent, title, file_filter="所有文件 (*)"):
        filename, _ = QFileDialog.getOpenFileName(parent, title, "", file_filter)
        return filename

    @staticmethod
    def open_files(parent, title, file_filter="所有文件 (*)"):
        filenames, _ = QFileDialog.getOpenFileNames(parent, title, "", file_filter)
        return filenames

    @staticmethod
    def save_file(parent, title, default_name="", file_filter="所有文件 (*)"):
        filename, _ = QFileDialog.getSaveFileName(parent, title, default_name, file_filter)
        return filename

    @staticmethod
    def select_directory(parent, title):
        directory = QFileDialog.getExistingDirectory(parent, title)
        return directory

class DocumentSelectorDialog(QDialog):
    def __init__(self, parent=None, selected_ids=None):
        super().__init__(parent)
        self.selected_ids = selected_ids or []
        self.selected_documents = []
        self.init_ui()

    def init_ui(self):
        self.setWindowTitle("选择关联文献")
        self.setMinimumSize(500, 400)
        layout = QVBoxLayout(self)

        label = QLabel("选择要关联的文献（可多选）：")
        layout.addWidget(label)

        self.list_widget = QListWidget()
        self.list_widget.setSelectionMode(QAbstractItemView.MultiSelection)
        layout.addWidget(self.list_widget)

        self.load_documents()

        button_layout = QHBoxLayout()
        self.btn_ok = QPushButton("确定")
        self.btn_ok.clicked.connect(self.accept)
        self.btn_cancel = QPushButton("取消")
        self.btn_cancel.clicked.connect(self.reject)
        button_layout.addStretch()
        button_layout.addWidget(self.btn_ok)
        button_layout.addWidget(self.btn_cancel)
        layout.addLayout(button_layout)

    def load_documents(self):
        documents = Document.get_all()
        for doc in documents:
            item = QListWidgetItem(doc.name)
            item.setData(Qt.UserRole, doc.id)
            if doc.id in self.selected_ids:
                item.setSelected(True)
            self.list_widget.addItem(item)

    def get_selected_documents(self):
        selected = []
        for item in self.list_widget.selectedItems():
            doc_id = item.data(Qt.UserRole)
            doc = Document.get_by_id(doc_id)
            if doc:
                selected.append(doc)
        return selected

class LinkedDocumentsDialog(QDialog):
    def __init__(self, parent=None, report_id=None):
        super().__init__(parent)
        self.report_id = report_id
        self.init_ui()
        self.load_linked_documents()

    def init_ui(self):
        self.setWindowTitle("关联文献")
        self.setMinimumSize(450, 350)
        layout = QVBoxLayout(self)

        self.label = QLabel("当前报告关联的文献：")
        layout.addWidget(self.label)

        self.list_widget = QListWidget()
        layout.addWidget(self.list_widget)

        button_layout = QHBoxLayout()
        self.btn_add = QPushButton("添加关联")
        self.btn_add.clicked.connect(self.on_add)
        self.btn_remove = QPushButton("移除关联")
        self.btn_remove.clicked.connect(self.on_remove)
        self.btn_close = QPushButton("关闭")
        self.btn_close.clicked.connect(self.close)

        button_layout.addWidget(self.btn_add)
        button_layout.addWidget(self.btn_remove)
        button_layout.addStretch()
        button_layout.addWidget(self.btn_close)
        layout.addLayout(button_layout)

    def load_linked_documents(self):
        from models.report import Report
        self.list_widget.clear()
        linked_docs = Report.get_linked_documents(self.report_id)
        for doc in linked_docs:
            item = QListWidgetItem(doc.name)
            item.setData(Qt.UserRole, doc.id)
            self.list_widget.addItem(item)

    def on_add(self):
        dialog = DocumentSelectorDialog(self)
        if dialog.exec_() == QDialog.Accepted:
            selected_docs = dialog.get_selected_documents()
            from models.report import Report
            for doc in selected_docs:
                Report.link_document(self.report_id, doc.id)
            self.load_linked_documents()

    def on_remove(self):
        current_item = self.list_widget.currentItem()
        if not current_item:
            return
        doc_id = current_item.data(Qt.UserRole)
        from models.report import Report
        if ConfirmDialog.confirm(self, "确认", "确定要移除此关联吗？"):
            Report.unlink_document(self.report_id, doc_id)
            self.load_linked_documents()

class RenameDialog(QDialog):
    def __init__(self, parent=None, current_name="", title="重命名"):
        super().__init__(parent)
        self.result_name = current_name
        self.init_ui(current_name, title)

    def init_ui(self, current_name, title):
        self.setWindowTitle(title)
        self.setMinimumWidth(300)
        layout = QVBoxLayout(self)

        self.input = QLineEdit(current_name)
        layout.addWidget(self.input)

        button_layout = QHBoxLayout()
        self.btn_ok = QPushButton("确定")
        self.btn_ok.clicked.connect(self.accept)
        self.btn_cancel = QPushButton("取消")
        self.btn_cancel.clicked.connect(self.reject)
        button_layout.addStretch()
        button_layout.addWidget(self.btn_ok)
        button_layout.addWidget(self.btn_cancel)
        layout.addLayout(button_layout)

    def accept(self):
        self.result_name = self.input.text().strip()
        if self.result_name:
            super().accept()

    def get_result(self):
        return self.result_name

class CategorySelectorDialog(QDialog):
    def __init__(self, parent=None, current_category_id=None):
        super().__init__(parent)
        self.current_category_id = current_category_id
        self.selected_category_id = current_category_id
        self.init_ui()

    def init_ui(self):
        self.setWindowTitle("选择分类")
        self.setMinimumSize(300, 250)
        layout = QVBoxLayout(self)

        self.list_widget = QListWidget()
        layout.addWidget(self.list_widget)

        self.load_categories()

        button_layout = QHBoxLayout()
        self.btn_ok = QPushButton("确定")
        self.btn_ok.clicked.connect(self.accept)
        self.btn_cancel = QPushButton("取消")
        self.btn_cancel.clicked.connect(self.reject)
        button_layout.addStretch()
        button_layout.addWidget(self.btn_ok)
        button_layout.addWidget(self.btn_cancel)
        layout.addLayout(button_layout)

    def load_categories(self):
        categories = Category.get_all()
        for cat in categories:
            item = QListWidgetItem(cat.name)
            item.setData(Qt.UserRole, cat.id)
            if cat.id == self.current_category_id:
                item.setSelected(True)
            self.list_widget.addItem(item)

    def accept(self):
        current_item = self.list_widget.currentItem()
        if current_item:
            self.selected_category_id = current_item.data(Qt.UserRole)
        super().accept()

    def get_selected_category_id(self):
        return self.selected_category_id