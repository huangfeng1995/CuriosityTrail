import os
import subprocess
import platform

def open_file_with_default_app(filepath):
    if not os.path.exists(filepath):
        return False, "File does not exist"

    system = platform.system()
    try:
        if system == "Windows":
            os.startfile(filepath)
        elif system == "Darwin":
            subprocess.run(["open", filepath])
        else:
            subprocess.run(["xdg-open", filepath])
        return True, "File opened successfully"
    except Exception as e:
        return False, str(e)

def format_datetime(dt_string):
    if not dt_string:
        return ""
    if isinstance(dt_string, str):
        try:
            from datetime import datetime
            dt = datetime.fromisoformat(dt_string)
            return dt.strftime("%Y-%m-%d %H:%M")
        except:
            return dt_string
    return str(dt_string)

def format_file_size(size_bytes):
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 * 1024 * 1024:
        return f"{size_bytes / (1024 * 1024):.1f} MB"
    else:
        return f"{size_bytes / (1024 * 1024 * 1024):.1f} GB"

def validate_filename(filename):
    invalid_chars = '<>:"/\\|?*'
    for char in invalid_chars:
        if char in filename:
            return False, f"Filename contains invalid character: {char}"
    return True, "Valid filename"

def truncate_text(text, max_length=50):
    if len(text) <= max_length:
        return text
    return text[:max_length-3] + "..."