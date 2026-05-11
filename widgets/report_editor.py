from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel,
    QPushButton, QTextEdit, QLineEdit, QMessageBox,
    QListWidget, QListWidgetItem, QAbstractItemView
)
from PyQt5.QtCore import Qt, QTimer
from config import REPORT_TEMPLATE
from models.report import Report
from models.document import Document
from utils.helpers import open_file_with_default_app
from widgets.dialogs import ConfirmDialog, LinkedDocumentsDialog
import os

class ReportEditor(QWidget):
    def __init__(self, parent=None, report_id=None):
        super().__init__(parent)
        self.report_id = report_id
        self.report = None
        self.is_modified = False
        self.auto_save_timer = QTimer()
        self.auto_save_timer.timeout.connect(self.auto_save)
        self.setup_ui()
        if report_id:
            self.load_report(report_id)
        self.auto_save_timer.start(5 * 60 * 1000)

    def setup_ui(self):
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(20, 20, 20, 20)
        main_layout.setSpacing(10)

        title_layout = QHBoxLayout()
        title_label = QLabel("报告标题：")
        self.title_input = QLineEdit()
        self.title_input.textChanged.connect(self.on_content_changed)
        title_layout.addWidget(title_label)
        title_layout.addWidget(self.title_input)
        main_layout.addLayout(title_layout)

        content_label = QLabel("报告内容：")
        main_layout.addWidget(content_label)

        self.content_edit = QTextEdit()
        self.content_edit.textChanged.connect(self.on_content_changed)
        main_layout.addWidget(self.content_edit, 1)

        linked_docs_label = QLabel("关联文献：")
        main_layout.addWidget(linked_docs_label)

        docs_layout = QHBoxLayout()
        self.linked_docs_list = QListWidget()
        self.linked_docs_list.setMaximumHeight(100)
        self.linked_docs_list.itemDoubleClicked.connect(self.open_linked_document)
        docs_layout.addWidget(self.linked_docs_list)

        docs_btn_layout = QVBoxLayout()
        self.btn_manage_links = QPushButton("管理关联")
        self.btn_manage_links.clicked.connect(self.manage_linked_documents)
        docs_btn_layout.addWidget(self.btn_manage_links)
        docs_btn_layout.addStretch()
        docs_layout.addLayout(docs_btn_layout)
        main_layout.addLayout(docs_layout)

        actions_layout = QHBoxLayout()
        self.btn_save = QPushButton("保存")
        self.btn_save.clicked.connect(self.save_report)
        self.btn_export_txt = QPushButton("导出TXT")
        self.btn_export_txt.clicked.connect(lambda: self.export_report("txt"))
        self.btn_export_docx = QPushButton("导出DOCX")
        self.btn_export_docx.clicked.connect(lambda: self.export_report("docx"))

        actions_layout.addWidget(self.btn_save)
        actions_layout.addStretch()
        actions_layout.addWidget(self.btn_export_txt)
        actions_layout.addWidget(self.btn_export_docx)
        main_layout.addLayout(actions_layout)

    def load_report(self, report_id):
        self.report = Report.get_by_id(report_id)
        if self.report:
            self.report_id = report_id
            self.title_input.setText(self.report.title)
            self.content_edit.setPlainText(self.report.content or "")
            self.is_modified = False
            self.update_linked_docs_list()

    def update_linked_docs_list(self):
        self.linked_docs_list.clear()
        if self.report_id:
            linked_docs = Report.get_linked_documents(self.report_id)
            for doc in linked_docs:
                item = QListWidgetItem(doc.name)
                item.setData(Qt.UserRole, doc.id)
                self.linked_docs_list.addItem(item)

    def open_linked_document(self, item):
        doc_id = item.data(Qt.UserRole)
        doc = Document.get_by_id(doc_id)
        if doc and os.path.exists(doc.file_path):
            open_file_with_default_app(doc.file_path)
        else:
            ConfirmDialog.error(self, "错误", "文献文件不存在或已被移动")

    def manage_linked_documents(self):
        if not self.report_id:
            ConfirmDialog.warning(self, "提示", "请先保存报告后再管理关联")
            return
        dialog = LinkedDocumentsDialog(self, self.report_id)
        dialog.exec_()
        self.update_linked_docs_list()

    def on_content_changed(self):
        self.is_modified = True

    def auto_save(self):
        if self.is_modified and self.report_id:
            self.save_report(show_message=False)

    def save_report(self, show_message=True):
        title = self.title_input.text().strip()
        if not title:
            ConfirmDialog.warning(self, "提示", "报告标题不能为空")
            return False

        if Report.title_exists(title, exclude_id=self.report_id):
            ConfirmDialog.warning(self, "提示", "报告标题已存在，请使用其他名称")
            return False

        content = self.content_edit.toPlainText()

        if self.report_id:
            Report.update(self.report_id, title, content)
            self.report = Report.get_by_id(self.report_id)
        else:
            report_id = Report.create(title, content)
            self.report_id = report_id
            self.report = Report.get_by_id(report_id)

        self.is_modified = False
        if show_message:
            ConfirmDialog.info(self, "提示", "保存成功")
        return True

    def export_report(self, export_type):
        if not self.save_report(show_message=False):
            return

        from widgets.dialogs import FilePicker
        from services.export_service import ExportService

        default_name = self.title_input.text().strip() or "report"
        if export_type == "txt":
            file_path = FilePicker.save_file(self, "导出TXT", default_name, "文本文件 (*.txt)")
            if file_path:
                try:
                    ExportService.export_to_txt(self.report, file_path)
                    ConfirmDialog.info(self, "提示", "导出成功")
                except Exception as e:
                    ConfirmDialog.error(self, "错误", f"导出失败：{str(e)}")
        elif export_type == "docx":
            file_path = FilePicker.save_file(self, "导出DOCX", default_name, "Word文档 (*.docx)")
            if file_path:
                try:
                    ExportService.export_to_docx(self.report, file_path)
                    ConfirmDialog.info(self, "提示", "导出成功")
                except Exception as e:
                    ConfirmDialog.error(self, "错误", f"导出失败：{str(e)}")

    def set_readonly(self, readonly=True):
        self.title_input.setReadOnly(readonly)
        self.content_edit.setReadOnly(readonly)

    def closeEvent(self, event):
        if self.is_modified:
            reply = ConfirmDialog.confirm(
                self, "确认",
                "有未保存的更改，是否保存？"
            )
            if reply:
                self.save_report(show_message=False)
        event.accept()