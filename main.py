import sys
import os
from PyQt5.QtWidgets import QApplication, QMessageBox
from PyQt5.QtCore import Qt
from database import init_database
from views.main_window import MainWindow
from utils.theme import ThemeManager

def main():
    QApplication.setAttribute(Qt.AA_EnableHighDpiScaling, True)
    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps, True)

    app = QApplication(sys.argv)

    app.setApplicationName("Curiosity Trail")
    app.setApplicationDisplayName("Curiosity Trail 寻迹")

    try:
        init_database()
    except Exception as e:
        QMessageBox.critical(None, "初始化错误", f"数据库初始化失败：\n{str(e)}")
        sys.exit(1)

    ThemeManager.load_saved_theme()

    main_window = MainWindow()
    main_window.setWindowTitle("Curiosity Trail 寻迹")
    main_window.setMinimumSize(800, 600)
    main_window.resize(1024, 700)

    style = ThemeManager.get_stylesheet()
    app.setStyleSheet(style)

    main_window.show()

    sys.exit(app.exec_())

if __name__ == "__main__":
    main()