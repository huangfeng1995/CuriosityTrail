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
        text_primary = colors["text_primary"]
        text_secondary = colors["text_secondary"]
        border = colors["border"]
        primary = colors["primary"]

        stylesheet = f"""
        QMainWindow {{
            background-color: {bg_main};
        }}
        QWidget {{
            background-color: {bg_main};
            color: {text_primary};
        }}
        QFrame {{
            background-color: {bg_main};
            border: none;
        }}
        QLabel {{
            background-color: transparent;
            color: {text_primary};
        }}
        QPushButton {{
            background-color: {primary};
            color: white;
            border: none;
            border-radius: 4px;
            padding: 6px 16px;
            font-size: 12px;
        }}
        QPushButton:hover {{
            background-color: {colors["secondary"]};
        }}
        QPushButton:pressed {{
            background-color: {primary};
        }}
        QPushButton:disabled {{
            background-color: {border};
            color: {text_secondary};
        }}
        QLineEdit, QTextEdit, QPlainTextEdit {{
            background-color: {bg_card};
            color: {text_primary};
            border: 1px solid {border};
            border-radius: 4px;
            padding: 4px 8px;
        }}
        QLineEdit:focus, QTextEdit:focus, QPlainTextEdit:focus {{
            border: 1px solid {primary};
        }}
        QListWidget, QTableWidget {{
            background-color: {bg_card};
            color: {text_primary};
            border: 1px solid {border};
            border-radius: 4px;
            alternate-background-color: {bg_main};
        }}
        QListWidget::item:selected, QTableWidget::item:selected {{
            background-color: {primary};
            color: white;
        }}
        QListWidget::item:hover, QTableWidget::item:hover {{
            background-color: {border};
        }}
        QMenu {{
            background-color: {bg_card};
            color: {text_primary};
            border: 1px solid {border};
        }}
        QMenu::item:selected {{
            background-color: {primary};
            color: white;
        }}
        QComboBox {{
            background-color: {bg_card};
            color: {text_primary};
            border: 1px solid {border};
            border-radius: 4px;
            padding: 4px 8px;
        }}
        QComboBox:hover {{
            border: 1px solid {primary};
        }}
        QComboBox::drop-down {{
            border: none;
        }}
        QScrollBar:vertical {{
            background-color: {bg_main};
            width: 10px;
            border-radius: 5px;
        }}
        QScrollBar::handle:vertical {{
            background-color: {border};
            border-radius: 5px;
            min-height: 20px;
        }}
        QScrollBar::handle:vertical:hover {{
            background-color: {text_secondary};
        }}
        QScrollBar:horizontal {{
            background-color: {bg_main};
            height: 10px;
            border-radius: 5px;
        }}
        QScrollBar::handle:horizontal {{
            background-color: {border};
            border-radius: 5px;
            min-width: 20px;
        }}
        QScrollBar::handle:horizontal:hover {{
            background-color: {text_secondary};
        }}
        """

        if is_dark:
            stylesheet += """
            QInputDialog, QFileDialog, QMessageBox, QColorDialog {
                background-color: """ + bg_card + """;
            }
            """

        return stylesheet