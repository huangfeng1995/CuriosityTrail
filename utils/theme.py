from config import THEME_COLORS, get_config, update_config

class ThemeManager:
    _current_theme = "light"

    @classmethod
    def get_theme(cls):
        if cls._current_theme == "light":
            return THEME_COLORS["light"]
        return THEME_COLORS["dark"]

    @classmethod
    def set_theme(cls, theme_name):
        if theme_name in THEME_COLORS:
            cls._current_theme = theme_name
            update_config("theme", theme_name)
            return True
        return False

    @classmethod
    def load_saved_theme(cls):
        config = get_config()
        theme = config.get("theme", "light")
        cls._current_theme = theme
        return theme

    @classmethod
    def get_current_theme_name(cls):
        return cls._current_theme

    @classmethod
    def is_dark(cls):
        return cls._current_theme == "dark"

    @classmethod
    def get_stylesheet(cls):
        colors = cls.get_theme()
        is_dark = cls.is_dark()

        bg_main = colors["background"]
        bg_card = colors["card_background"]
        bg_sidebar = "#2C3E50" if is_dark else "#34495E"
        text_primary = colors["text_primary"]
        text_secondary = colors["text_secondary"]
        text_on_dark = "#ECF0F1"
        border = colors["border"]
        primary = colors["primary"]
        primary_hover = "#5DADE2"
        success = colors["success"]
        warning = colors["warning"]
        error = colors["error"]
        shadow = "rgba(0,0,0,0.1)" if is_dark else "rgba(0,0,0,0.15)"

        stylesheet = f"""
        QMainWindow, QWidget {{
            background-color: {bg_main};
            color: {text_primary};
            font-family: "SF Pro Display", "Segoe UI", "Microsoft YaHei", sans-serif;
        }}

        QLabel {{
            background-color: transparent;
            color: {text_primary};
            font-size: 13px;
        }}

        #viewTitle {{
            font-size: 22px;
            font-weight: 600;
            color: {text_primary};
            padding: 5px 0;
        }}

        #sectionTitle {{
            font-size: 15px;
            font-weight: 600;
            color: {text_primary};
            padding-bottom: 8px;
        }}

        QPushButton {{
            background-color: {primary};
            color: white;
            border: none;
            border-radius: 8px;
            padding: 10px 20px;
            font-size: 13px;
            font-weight: 500;
        }}
        QPushButton:hover {{
            background-color: {primary_hover};
        }}
        QPushButton:pressed {{
            background-color: {primary};
            padding-top: 11px;
        }}
        QPushButton:disabled {{
            background-color: {border};
            color: {text_secondary};
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
            background-color: rgba(255,255,255,0.1);
        }}
        #navBtn.active {{
            background-color: {primary};
            font-weight: 500;
        }}

        QLineEdit, QTextEdit, QPlainTextEdit {{
            background-color: {bg_card};
            color: {text_primary};
            border: 2px solid {border};
            border-radius: 8px;
            padding: 10px 14px;
            font-size: 13px;
        }}
        QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus {{
            border: 2px solid {primary};
        }}
        QLineEdit {{ padding: 8px 12px; }}

        QListWidget {{
            background-color: {bg_card};
            color: {text_primary};
            border: none;
            border-radius: 12px;
            padding: 8px;
            font-size: 13px;
            outline: none;
        }}
        QListWidget::item {{
            background-color: transparent;
            border-radius: 8px;
            padding: 12px;
            margin: 4px 0;
        }}
        QListWidget::item:selected {{
            background-color: {primary};
            color: white;
        }}
        QListWidget::item:hover {{
            background-color: rgba(74,144,217,0.1);
        }}

        QComboBox {{
            background-color: {bg_card};
            color: {text_primary};
            border: 2px solid {border};
            border-radius: 8px;
            padding: 8px 12px;
            font-size: 13px;
        }}
        QComboBox:hover {{
            border: 2px solid {primary};
        }}
        QComboBox::drop-down {{
            border: none;
            padding-right: 8px;
        }}
        QComboBox::down-arrow {{
            image: none;
            border-left: 5px solid transparent;
            border-right: 5px solid transparent;
            border-top: 6px solid {text_secondary};
        }}
        QComboBox QAbstractItemView {{
            background-color: {bg_card};
            color: {text_primary};
            border: 1px solid {border};
            border-radius: 8px;
            selection-background-color: {primary};
            padding: 6px;
        }}

        QMenu {{
            background-color: {bg_card};
            color: {text_primary};
            border: 1px solid {border};
            border-radius: 10px;
            padding: 6px;
        }}
        QMenu::item {{
            background-color: transparent;
            border-radius: 6px;
            padding: 10px 20px;
        }}
        QMenu::item:selected {{
            background-color: {primary};
            color: white;
        }}

        QScrollBar:vertical {{
            background-color: transparent;
            width: 8px;
            border-radius: 4px;
            margin: 4px 0;
        }}
        QScrollBar::handle:vertical {{
            background-color: {border};
            border-radius: 4px;
            min-height: 30px;
        }}
        QScrollBar::handle:vertical:hover {{
            background-color: {text_secondary};
        }}
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{
            height: 0;
        }}

        QScrollBar:horizontal {{
            background-color: transparent;
            height: 8px;
            border-radius: 4px;
            margin: 0 4px;
        }}
        QScrollBar::handle:horizontal {{
            background-color: {border};
            border-radius: 4px;
            min-width: 30px;
        }}
        QScrollBar::handle:horizontal:hover {{
            background-color: {text_secondary};
        }}
        QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{
            width: 0;
        }}

        QDialog {{
            background-color: {bg_main};
            border-radius: 16px;
        }}

        QMessageBox {{
            background-color: {bg_card};
            border-radius: 12px;
        }}
        """

        return stylesheet

    @classmethod
    def get_sidebar_stylesheet(cls):
        is_dark = cls.is_dark()
        bg_sidebar = "#2C3E50" if is_dark else "#34495E"
        bg_sidebar_hover = "#3D566E" if is_dark else "#3D566E"
        text_on_dark = "#ECF0F1"
        primary = "#3498DB"

        return f"""
        QFrame#sidebar {{
            background-color: {bg_sidebar};
            border: none;
        }}
        #sidebarTitle {{
            font-size: 18px;
            font-weight: 700;
            color: white;
            padding: 20px 16px 4px;
        }}
        #sidebarSubtitle {{
            font-size: 12px;
            color: rgba(255,255,255,0.6);
            padding: 0px 16px 20px;
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
            margin: 2px 8px;
        }}
        #navBtn:hover {{
            background-color: rgba(255,255,255,0.1);
        }}
        #navBtn.active {{
            background-color: {primary};
        }}
        """

    @classmethod
    def get_card_stylesheet(cls):
        colors = cls.get_theme()
        bg_card = colors["card_background"]
        border = colors["border"]
        shadow = "rgba(0,0,0,0.08)" if cls.is_dark() else "rgba(0,0,0,0.08)"

        return f"""
        QFrame.card {{
            background-color: {bg_card};
            border-radius: 12px;
            border: 1px solid {border};
        }}
        """