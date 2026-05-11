from PyQt5.QtWidgets import QWidget, QVBoxLayout, QPushButton, QLabel, QFrame, QSpacerItem, QSizePolicy
from PyQt5.QtCore import pyqtSignal, Qt
from utils.theme import ThemeManager

class Sidebar(QFrame):
    nav_clicked = pyqtSignal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.current_nav = "reports"
        self.setup_ui()
        self.apply_theme()

    def setup_ui(self):
        self.setObjectName("sidebar")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 20, 12, 20)
        layout.setSpacing(4)

        header_widget = QWidget()
        header_layout = QVBoxLayout(header_widget)
        header_layout.setContentsMargins(8, 0, 8, 16)

        title_label = QLabel("🔭")
        title_label.setObjectName("sidebarIcon")
        title_label.setAlignment(Qt.AlignCenter)
        header_layout.addWidget(title_label)

        title_text = QLabel("Curiosity Trail")
        title_text.setObjectName("sidebarTitle")
        title_text.setAlignment(Qt.AlignCenter)
        header_layout.addWidget(title_text)

        subtitle_label = QLabel("科学探索记录")
        subtitle_label.setObjectName("sidebarSubtitle")
        subtitle_label.setAlignment(Qt.AlignCenter)
        header_layout.addWidget(subtitle_label)

        layout.addWidget(header_widget)

        separator = QFrame()
        separator.setObjectName("separator")
        separator.setFixedHeight(1)
        layout.addWidget(separator)

        layout.addSpacing(16)

        nav_container = QWidget()
        nav_layout = QVBoxLayout(nav_container)
        nav_layout.setContentsMargins(4, 0, 4, 0)
        nav_layout.setSpacing(6)

        self.btn_reports = QPushButton("📝  报告库")
        self.btn_reports.setObjectName("navBtn")
        self.btn_reports.clicked.connect(lambda: self.on_nav_click("reports"))
        nav_layout.addWidget(self.btn_reports)

        self.btn_documents = QPushButton("📚  文献库")
        self.btn_documents.setObjectName("navBtn")
        self.btn_documents.clicked.connect(lambda: self.on_nav_click("documents"))
        nav_layout.addWidget(self.btn_documents)

        self.btn_settings = QPushButton("⚙️  系统设置")
        self.btn_settings.setObjectName("navBtn")
        self.btn_settings.clicked.connect(lambda: self.on_nav_click("settings"))
        nav_layout.addWidget(self.btn_settings)

        nav_layout.addStretch()
        layout.addWidget(nav_container, 1)

        footer_widget = QWidget()
        footer_layout = QVBoxLayout(footer_widget)
        footer_layout.setContentsMargins(8, 0, 8, 0)

        version_label = QLabel("v1.0.0 MVP")
        version_label.setObjectName("sidebarVersion")
        version_label.setAlignment(Qt.AlignCenter)
        footer_layout.addWidget(version_label)

        layout.addWidget(footer_widget)

        self.nav_buttons = [self.btn_reports, self.btn_documents, self.btn_settings]
        self.update_active_button()

    def apply_theme(self):
        colors = ThemeManager.get_theme()
        is_dark = ThemeManager.is_dark()

        bg_sidebar = "#2C3E50" if is_dark else "#34495E"
        bg_hover = "#3D566E"
        text_on_dark = "#ECF0F1"
        text_muted = "rgba(255,255,255,0.5)"
        primary = "#3498DB"
        primary_hover = "#5DADE2"
        separator_color = "rgba(255,255,255,0.1)"

        self.setStyleSheet(f"""
            QFrame#sidebar {{
                background-color: {bg_sidebar};
                border: none;
            }}
            #sidebarIcon {{
                font-size: 32px;
                background-color: transparent;
            }}
            #sidebarTitle {{
                font-size: 15px;
                font-weight: 700;
                color: white;
                background-color: transparent;
            }}
            #sidebarSubtitle {{
                font-size: 11px;
                color: {text_muted};
                background-color: transparent;
            }}
            #separator {{
                background-color: {separator_color};
            }}
            #navBtn {{
                background-color: transparent;
                color: {text_on_dark};
                border: none;
                border-radius: 8px;
                padding: 12px 16px;
                font-size: 14px;
                text-align: left;
                font-weight: 400;
            }}
            #navBtn:hover {{
                background-color: {bg_hover};
            }}
            #navBtn.active {{
                background-color: {primary};
                font-weight: 500;
            }}
            #sidebarVersion {{
                font-size: 11px;
                color: {text_muted};
                background-color: transparent;
            }}
        """)

    def on_nav_click(self, nav_type):
        self.current_nav = nav_type
        self.update_active_button()
        self.nav_clicked.emit(nav_type)

    def update_active_button(self):
        for btn in self.nav_buttons:
            btn.setProperty("class", "")
        if self.current_nav == "reports":
            self.btn_reports.setProperty("class", "active")
        elif self.current_nav == "documents":
            self.btn_documents.setProperty("class", "active")
        elif self.current_nav == "settings":
            self.btn_settings.setProperty("class", "active")

        for btn in self.nav_buttons:
            btn.style().unpolish(btn)
            btn.style().polish(btn)