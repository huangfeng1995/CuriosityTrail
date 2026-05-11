from PyQt5.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QFrame,
    QLabel, QPushButton, QLineEdit, QScrollArea
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

        self.content_container = QFrame()
        self.content_container.setObjectName("contentContainer")
        self.content_layout_inner = QVBoxLayout(self.content_container)
        self.content_layout_inner.setContentsMargins(24, 24, 24, 24)
        self.content_layout_inner.setSpacing(16)
        content_layout.addWidget(self.content_container, 1)

        main_layout.addWidget(self.content_area, 1)

        self.views["reports"] = ReportView()
        self.views["documents"] = DocumentView()
        self.views["settings"] = SettingsView()

        for view_name, view in self.views.items():
            self.content_layout_inner.addWidget(view)
            view.setVisible(view_name == self.current_view)

    def create_top_bar(self):
        frame = QFrame()
        frame.setObjectName("topBar")
        layout = QHBoxLayout(frame)
        layout.setContentsMargins(20, 12, 20, 12)

        app_title = QLabel("🔬 Curiosity Trail")
        app_title.setObjectName("appTitle")
        layout.addWidget(app_title)

        layout.addStretch()

        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("🔍 搜索...")
        self.search_input.setMaximumWidth(280)
        self.search_input.textChanged.connect(self.on_global_search)
        layout.addWidget(self.search_input)

        spacer = QWidget()
        spacer.setFixedWidth(12)
        layout.addWidget(spacer)

        self.btn_theme = QPushButton("🌙")
        self.btn_theme.setFixedSize(40, 40)
        self.btn_theme.setCursor(Qt.PointingHandCursor)
        self.btn_theme.clicked.connect(self.toggle_theme)
        layout.addWidget(self.btn_theme)

        return frame

    def apply_theme(self):
        colors = ThemeManager.get_theme()
        is_dark = ThemeManager.is_dark()

        bg_main = colors["background"]
        bg_card = colors["card_background"]
        bg_topbar = bg_card
        border = colors["border"]
        primary = colors["primary"]
        text_primary = colors["text_primary"]
        text_secondary = colors["text_secondary"]

        self.setStyleSheet(f"""
            QFrame#topBar {{
                background-color: {bg_topbar};
                border-bottom: 1px solid {border};
            }}
            #appTitle {{
                font-size: 16px;
                font-weight: 700;
                color: {text_primary};
            }}
            QFrame#contentContainer {{
                background-color: {bg_main};
            }}
            QPushButton#themeToggleBtn {{
                background-color: transparent;
                border: none;
                font-size: 18px;
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

        if ThemeManager.is_dark():
            self.btn_theme.setText("☀️")
        else:
            self.btn_theme.setText("🌙")

    def refresh_theme(self):
        ThemeManager.load_saved_theme()
        self.apply_theme()