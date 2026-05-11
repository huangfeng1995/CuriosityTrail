from PyQt5.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QFrame,
    QLabel, QPushButton, QLineEdit
)
from PyQt5.QtCore import Qt
from widgets.sidebar import Sidebar
from views.report_view import ReportView
from views.document_view import DocumentView
from views.settings_view import SettingsView
from utils.theme import ThemeManager
from config import get_config

class MainWindow(QFrame):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.current_view = "reports"
        self.views = {}
        self.setup_ui()
        self.apply_theme()
        self.switch_view("reports")

    def setup_ui(self):
        main_layout = QHBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)

        self.sidebar = Sidebar()
        self.sidebar.nav_clicked.connect(self.on_nav_clicked)
        main_layout.addWidget(self.sidebar)

        self.content_area = QFrame()
        content_layout = QVBoxLayout(self.content_area)
        content_layout.setContentsMargins(0, 0, 0, 0)
        content_layout.setSpacing(0)

        top_bar = self.create_top_bar()
        content_layout.addWidget(top_bar)

        self.stacked_widget = QWidget()
        self.stacked_layout = QVBoxLayout(self.stacked_widget)
        self.stacked_layout.setContentsMargins(0, 0, 0, 0)
        self.stacked_layout.setSpacing(0)
        content_layout.addWidget(self.stacked_widget, 1)

        main_layout.addWidget(self.content_area, 1)

        self.views["reports"] = ReportView()
        self.views["documents"] = DocumentView()
        self.views["settings"] = SettingsView()

        for view_name, view in self.views.items():
            self.stacked_layout.addWidget(view)
            view.setVisible(view_name == self.current_view)

    def create_top_bar(self):
        from PyQt5.QtWidgets import QFrame
        frame = QFrame()
        frame.setObjectName("topBar")
        layout = QHBoxLayout(frame)
        layout.setContentsMargins(15, 8, 15, 8)

        app_title = QLabel("Curiosity Trail 寻迹")
        app_title.setObjectName("appTitle")
        layout.addWidget(app_title)

        layout.addStretch()

        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("搜索...")
        self.search_input.setMaximumWidth(200)
        self.search_input.textChanged.connect(self.on_global_search)
        layout.addWidget(self.search_input)

        self.btn_theme = QPushButton("切换主题")
        self.btn_theme.clicked.connect(self.toggle_theme)
        layout.addWidget(self.btn_theme)

        return frame

    def apply_theme(self):
        colors = ThemeManager.get_theme()
        self.setStyleSheet(f"""
            QFrame#topBar {{
                background-color: {colors['card_background']};
                border-bottom: 1px solid {colors['border']};
            }}
            #appTitle {{
                font-size: 14px;
                font-weight: bold;
                color: {colors['primary']};
            }}
            QPushButton#themeToggle {{
                background-color: transparent;
                color: {colors['text_secondary']};
                border: 1px solid {colors['border']};
                border-radius: 4px;
                padding: 4px 12px;
                font-size: 11px;
            }}
            QPushButton#themeToggle:hover {{
                border-color: {colors['primary']};
                color: {colors['primary']};
            }}
        """)

        self.sidebar.apply_theme()
        for view in self.views.values():
            view.setStyleSheet(ThemeManager.get_stylesheet())

    def on_nav_clicked(self, nav_type):
        self.switch_view(nav_type)

    def switch_view(self, view_name):
        self.current_view = view_name
        for name, view in self.views.items():
            view.setVisible(name == view_name)

        if view_name == "reports":
            self.views["reports"].load_reports()
        elif view_name == "documents":
            self.views["documents"].load_documents()
            self.views["documents"].load_categories()

    def on_global_search(self, text):
        if self.current_view == "reports":
            self.views["reports"].on_search(text)
        elif self.current_view == "documents":
            self.views["documents"].on_search(text)

    def toggle_theme(self):
        current = ThemeManager.get_current_theme_name()
        new_theme = "dark" if current == "light" else "light"
        ThemeManager.set_theme(new_theme)
        self.apply_theme()

    def refresh_theme(self):
        ThemeManager.load_saved_theme()
        self.apply_theme()