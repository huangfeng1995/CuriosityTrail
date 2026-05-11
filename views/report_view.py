from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel,
    QPushButton, QListWidget, QListWidgetItem,
    QLineEdit, QComboBox, QMessageBox, QAbstractItemView,
    QFrame
)
from PyQt5.QtCore import Qt
from models.report import Report
from models.document import Document
from utils.helpers import open_file_with_default_app, format_datetime
from widgets.dialogs import ConfirmDialog, FilePicker
from widgets.report_editor import ReportEditor
from config import REPORT_TEMPLATE
import os

class ReportView(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.current_report_id = None
        self.is_view_mode = False
        self.setup_ui()
        self.load_reports()

    def setup_ui(self):
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(20)

        header_layout = QHBoxLayout()
        header_layout.setSpacing(16)

        title = QLabel("📝 探索报告")
        title.setObjectName("viewTitle")
        header_layout.addWidget(title)
        header_layout.addStretch()

        btn_new_template = QPushButton("✨ 新建模板报告")
        btn_new_template.setObjectName("primaryBtn")
        btn_new_template.clicked.connect(lambda: self.create_report(use_template=True))
        header_layout.addWidget(btn_new_template)

        btn_new_blank = QPushButton("📄 新建空白报告")
        btn_new_blank.clicked.connect(lambda: self.create_report(use_template=False))
        header_layout.addWidget(btn_new_blank)

        main_layout.addLayout(header_layout)

        filter_layout = QHBoxLayout()
        filter_layout.setSpacing(12)

        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("🔍 搜索报告...")
        self.search_input.setMinimumWidth(250)
        self.search_input.textChanged.connect(self.on_search)
        filter_layout.addWidget(self.search_input)

        spacer = QWidget()
        spacer.setFixedWidth(20)
        filter_layout.addSpacerItem(spacer)

        self.sort_combo = QComboBox()
        self.sort_combo.setMinimumWidth(130)
        self.sort_combo.addItems(["🕐 修改时间", "🕓 创建时间", "📋 按标题"])
        self.sort_combo.currentIndexChanged.connect(self.on_sort_changed)
        filter_layout.addWidget(self.sort_combo)

        filter_layout.addStretch()

        main_layout.addLayout(filter_layout)

        self.report_list = QListWidget()
        self.report_list.setSelectionMode(QAbstractItemView.SingleSelection)
        self.report_list.itemDoubleClicked.connect(self.view_report)
        self.report_list.setContextMenuPolicy(Qt.CustomContextMenu)
        self.report_list.customContextMenuRequested.connect(self.show_context_menu)
        main_layout.addWidget(self.report_list, 1)

    def load_reports(self, search=None, sort_by="modified_at"):
        self.report_list.clear()
        reports = Report.get_all(search=search, order_by=sort_by)

        for report in reports:
            doc_count = Report.get_document_count(report.id)

            item = QListWidgetItem()
            item.setData(Qt.UserRole, report.id)
            item.setData(Qt.UserRole + 1, report.title)
            item.setData(Qt.UserRole + 2, report.content)

            created = format_datetime(report.created_at)
            modified = format_datetime(report.modified_at)

            item.setSizeHint(Qt.QSize(0, 72))

            self.report_list.addItem(item)

        self.update_list_items()

    def update_list_items(self):
        for i in range(self.report_list.count()):
            item = self.report_list.item(i)
            report_id = item.data(Qt.UserRole)
            report = Report.get_by_id(report_id)
            if report:
                doc_count = Report.get_document_count(report.id)
                created = format_datetime(report.created_at)
                modified = format_datetime(report.modified_at)

                title_text = f"<b>{report.title}</b>"
                meta_text = f"<span style='color: #888;'>创建: {created} · 修改: {modified}</span>"
                doc_text = f"<span style='color: #4A90D9;'>📎 {doc_count} 篇关联文献</span>"

                item.setText(f"{title_text}\n{meta_text} · {doc_text}")

    def on_search(self, text):
        sort_by = self.get_sort_field()
        self.load_reports(search=text if text else None, sort_by=sort_by)

    def on_sort_changed(self, index):
        sort_by = self.get_sort_field()
        search = self.search_input.text() if self.search_input.text() else None
        self.load_reports(search=search, sort_by=sort_by)

    def get_sort_field(self):
        index = self.sort_combo.currentIndex()
        if index == 0:
            return "modified_at"
        elif index == 1:
            return "created_at"
        elif index == 2:
            return "title"
        return "modified_at"

    def create_report(self, use_template=False):
        title, ok = self.get_report_title()
        if not ok or not title:
            return

        if Report.title_exists(title):
            ConfirmDialog.warning(self, "提示", "报告标题已存在")
            return

        content = REPORT_TEMPLATE if use_template else ""
        report_id = Report.create(title, content)
        self.load_reports()
        self.open_editor(report_id)

    def get_report_title(self):
        from widgets.dialogs import InputDialog
        return InputDialog.get_text(self, "新建报告", "请输入报告标题：")

    def view_report(self, item):
        report_id = item.data(Qt.UserRole)
        self.open_editor(report_id, readonly=True)

    def show_context_menu(self, position):
        from PyQt5.QtWidgets import QMenu
        item = self.report_list.itemAt(position)
        if not item:
            return

        report_id = item.data(Qt.UserRole)
        report = Report.get_by_id(report_id)
        if not report:
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

        action_view = menu.addAction("👁️  查看报告")
        action_view.triggered.connect(lambda: self.open_editor(report_id, readonly=True))

        action_edit = menu.addAction("✏️  编辑报告")
        action_edit.triggered.connect(lambda: self.open_editor(report_id, readonly=False))

        action_export = menu.addAction("📥  导出报告")
        action_export.triggered.connect(lambda: self.export_single_report(report_id))

        menu.addSeparator()

        action_delete = menu.addAction("🗑️  删除报告")
        action_delete.triggered.connect(lambda: self.delete_report(report_id))

        menu.exec_(self.report_list.mapToGlobal(position))

    def open_editor(self, report_id, readonly=False):
        editor = ReportEditor(self, report_id)
        editor.set_readonly(readonly)

        dialog = self._create_editor_dialog(editor)
        dialog.setWindowTitle("查看报告" if readonly else "编辑报告")
        dialog.resize(900, 700)
        dialog.exec_()
        self.load_reports()

    def _create_editor_dialog(self, editor):
        from PyQt5.QtWidgets import QDialog, QVBoxLayout
        dialog = QDialog(self, Qt.WindowMaximize | Qt.WindowCloseButtonHint)
        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(editor)
        return dialog

    def export_single_report(self, report_id):
        report = Report.get_by_id(report_id)
        if not report:
            return

        from widgets.dialogs import FilePicker
        from services.export_service import ExportService

        default_name = report.title
        file_path = FilePicker.save_file(self, "导出报告", default_name, "Word文档 (*.docx);;文本文件 (*.txt)")

        if file_path:
            try:
                if file_path.endswith(".txt"):
                    ExportService.export_to_txt(report, file_path)
                else:
                    ExportService.export_to_docx(report, file_path)
                ConfirmDialog.info(self, "提示", "导出成功")
            except Exception as e:
                ConfirmDialog.error(self, "错误", f"导出失败：{str(e)}")

    def delete_report(self, report_id):
        report = Report.get_by_id(report_id)
        if not report:
            return

        if ConfirmDialog.confirm(self, "确认", f"确定要删除报告「{report.title}」吗？\n\n注意：此操作不会删除已关联的PDF文献"):
            Report.delete(report_id)
            self.load_reports()
            ConfirmDialog.info(self, "提示", "删除成功")