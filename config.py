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
        "error": "#F5222D"
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
        "error": "#F5222D"
    }
}

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