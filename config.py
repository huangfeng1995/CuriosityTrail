import os
import json
from pathlib import Path

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
DOCUMENTS_DIR = BASE_DIR / "documents"

DATA_DIR.mkdir(exist_ok=True)
DOCUMENTS_DIR.mkdir(exist_ok=True)

CONFIG_FILE = DATA_DIR / "config.json"

DEFAULT_CONFIG = {
    "theme": "light",
    "db_path": str(DATA_DIR / "curiosity.db"),
    "docs_path": str(DOCUMENTS_DIR)
}

def load_config():
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return DEFAULT_CONFIG.copy()

def save_config(config):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=4)

def get_config():
    return load_config()

def update_config(key, value):
    config = load_config()
    config[key] = value
    save_config(config)

THEME_COLORS = {
    "light": {
        "primary": "#4A90D9",
        "secondary": "#6BB3F0",
        "background": "#F5F7FA",
        "card_background": "#FFFFFF",
        "text_primary": "#333333",
        "text_secondary": "#666666",
        "border": "#E0E4E8",
        "success": "#52C41A",
        "warning": "#FAAD14",
        "error": "#F5222D",
        "btn_primary_bg": "#4A90D9",
        "btn_primary_hover": "#5DADE2",
        "btn_secondary_bg": "#FFFFFF",
        "btn_secondary_border": "#E0E4E8",
        "btn_secondary_text": "#333333",
        "card_bg": "#FFFFFF",
        "card_border": "#E0E6ED"
    },
    "dark": {
        "primary": "#4A90D9",
        "secondary": "#6BB3F0",
        "background": "#1E1E1E",
        "card_background": "#2D2D2D",
        "text_primary": "#E8E8E8",
        "text_secondary": "#A0A0A0",
        "border": "#404040",
        "success": "#52C41A",
        "warning": "#FAAD14",
        "error": "#F5222D",
        "btn_primary_bg": "#4A90D9",
        "btn_primary_hover": "#5DADE2",
        "btn_secondary_bg": "#3D3D3D",
        "btn_secondary_border": "#505050",
        "btn_secondary_text": "#E8E8E8",
        "card_bg": "#2D2D2D",
        "card_border": "#3D3D3D"
    }
}

def get_btn_styles():
    colors = THEME_COLORS.get("light", {})
    return f"""
    QPushButton[objectName="primaryBtn"] {{
        background-color: {colors.get('btn_primary_bg', '#4A90D9')};
        color: white;
        border: none;
        border-radius: 8px;
        padding: 10px 20px;
        font-size: 13px;
        font-weight: 500;
    }}
    QPushButton[objectName="primaryBtn"]:hover {{
        background-color: {colors.get('btn_primary_hover', '#5DADE2')};
    }}
    QPushButton[objectName="secondaryBtn"] {{
        background-color: {colors.get('btn_secondary_bg', '#FFFFFF')};
        color: {colors.get('btn_secondary_text', '#333333')};
        border: 1px solid {colors.get('btn_secondary_border', '#E0E4E8')};
        border-radius: 8px;
        padding: 10px 20px;
        font-size: 13px;
        font-weight: 500;
    }}
    QPushButton[objectName="secondaryBtn"]:hover {{
        border-color: #4A90D9;
        color: #4A90D9;
    }}
    """

REPORT_TEMPLATE = """1. 探索主题

2. 背景介绍

3. 提出问题

4. 猜想与假设

5. 实验材料与工具

6. 实验步骤

7. 实验数据与现象

8. 分析与结论

9. 反思与改进

10. 参考文献

"""