from PyQt5.QtWidgets import QWidget, QVBoxLayout, QPushButton, QLabel, QFrame
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
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 20, 0, 20)
        layout.setSpacing(8)

        title_label = QLabel("Curiosity Trail")
        title_label.setObjectName("sidebarTitle")
        layout.addWidget(title_label)

        subtitle_label = QLabel("寻迹")
        subtitle_label.setObjectName("sidebarSubtitle")
        layout.addWidget(subtitle_label)

        layout.addSpacing(20)

        self.btn_reports = QPushButton("报告库")
        self.btn_reports.setObjectName("navBtn")
        self.btn_reports.clicked.connect(lambda: self.on_nav_click("reports"))
        layout.addWidget(self.btn_reports)

        self.btn_documents = QPushButton("文献库")
        self.btn_documents.setObjectName("navBtn")
        self.btn_documents.clicked.connect(lambda: self.on_nav_click("documents"))
        layout.addWidget(self.btn_documents)

        self.btn_settings = QPushButton("系统设置")
        self.btn_settings.setObjectName("navBtn")
        self.btn_settings.clicked.connect(lambda: self.on_nav_click("settings"))
        layout.addWidget(self.btn_settings)

        layout.addStretch()

        self.nav_buttons = [self.btn_reports, self.btn_documents, self.btn_settings]

    def apply_theme(self):
        colors = ThemeManager.get_theme()
        self.setStyleSheet(f"""
            QFrame#sidebar {{
                background-color: {colors['card_background']};
                border-right: 1px solid {colors['border']};
            }}
            #sidebarTitle {{
                font-size: 16px;
                font-weight: bold;
                color: {colors['primary']};
                padding: 0px 10px;
            }}
            #sidebarSubtitle {{
                font-size: 12px;
                color: {colors['text_secondary']};
                padding: 0px 10px;
                margin-bottom: 10px;
            }}
            #navBtn {{
                background-color: transparent;
                color: {colors['text_primary']};
                border: none;
                text-align: left;
                padding: 10px 15px;
                border-radius: 4px;
                font-size: 13px;
            }}
            #navBtn:hover {{
                background-color: {colors['border']};
            }}
            #navBtn.active {{
                background-color: {colors['primary']};
                color: white;
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