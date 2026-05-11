from PyQt5.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel,
    QPushButton, QListWidget, QListWidgetItem,
    QLineEdit, QComboBox, QMessageBox, QAbstractItemView
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
        main_layout.setContentsMargins(20, 20, 20, 20)
        main_layout.setSpacing(10)

        header_layout = QHBoxLayout()
        title = QLabel("探索报告")
        title.setObjectName("viewTitle")
        header_layout.addWidget(title)

        header_layout.addStretch()

        self.btn_new_blank = QPushButton("新建空白报告")
        self.btn_new_blank.clicked.connect(lambda: self.create_report(use_template=False))
        header_layout.addWidget(self.btn_new_blank)

        self.btn_new_template = QPushButton("新建模板报告")
        self.btn_new_template.clicked.connect(lambda: self.create_report(use_template=True))
        header_layout.addWidget(self.btn_new_template)

        main_layout.addLayout(header_layout)

        filter_layout = QHBoxLayout()
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("搜索报告...")
        self.search_input.textChanged.connect(self.on_search)
        filter_layout.addWidget(self.search_input)

        self.sort_combo = QComboBox()
        self.sort_combo.addItems(["按修改时间", "按创建时间", "按标题"])
        self.sort_combo.currentIndexChanged.connect(self.on_sort_changed)
        filter_layout.addWidget(self.sort_combo)

        main_layout.addLayout(filter_layout)

        self.report_list = QListWidget()
        self.report_list.setSelectionMode(QAbstractItemView.SingleSelection)
        self.report_list.itemDoubleClicked.connect(self.view_report)
        self.report_list.setContextMenuPolicy(Qt.CustomContextMenu)
        self.report_list.customContextMenuRequested.connect(self.show_context_menu)
        main_layout.addWidget(self.report_list, 1)

        main_layout.addWidget(self.btn_new_blank)
        main_layout.addWidget(self.btn_new_template)

    def load_reports(self, search=None, sort_by="modified_at"):
        self.report_list.clear()
        reports = Report.get_all(search=search, order_by=sort_by)

        for report in reports:
            doc_count = Report.get_document_count(report.id)
            display_text = f"{report.title}\n创建: {format_datetime(report.created_at)} | 修改: {format_datetime(report.modified_at)} | 关联文献: {doc_count}"
            item = QListWidgetItem(display_text)
            item.setData(Qt.UserRole, report.id)
            item.setData(Qt.UserRole + 1, report.title)
            item.setData(Qt.UserRole + 2, report.content)
            self.report_list.addItem(item)

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
        menu = QMenu(self)

        action_view = menu.addAction("查看")
        action_view.triggered.connect(lambda: self.open_editor(report_id, readonly=True))

        action_edit = menu.addAction("编辑")
        action_edit.triggered.connect(lambda: self.open_editor(report_id, readonly=False))

        action_export = menu.addAction("导出")
        action_export.triggered.connect(lambda: self.export_single_report(report_id))

        menu.addSeparator()

        action_delete = menu.addAction("删除")
        action_delete.triggered.connect(lambda: self.delete_report(report_id))

        menu.exec_(self.report_list.mapToGlobal(position))

    def open_editor(self, report_id, readonly=False):
        editor = ReportEditor(self, report_id)
        editor.set_readonly(readonly)
        from widgets.dialogs import FilePicker

        dialog = self._create_editor_dialog(editor)
        dialog.setWindowTitle("查看报告" if readonly else "编辑报告")
        dialog.resize(800, 600)
        dialog.exec_()
        self.load_reports()

    def _create_editor_dialog(self, editor):
        from PyQt5.QtWidgets import QDialog, QVBoxLayout
        dialog = QDialog(self, Qt.WindowMaximized | Qt.WindowCloseButtonHint)
        layout = QVBoxLayout(dialog)
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

        if ConfirmDialog.confirm(self, "确认", f"确定要删除报告「{report.title}」吗？\n注意：此操作不会删除已关联的PDF文献"):
            Report.delete(report_id)
            self.load_reports()
            ConfirmDialog.info(self, "提示", "删除成功")