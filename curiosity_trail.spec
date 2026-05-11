import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files

block_cipher = None

datas = [
    (str(Path(__file__).parent / 'config.py'), '.'),
]

a = Analysis(
    ['main.py'],
    pathex=[Path(__file__).parent],
    binaries=[],
    datas=datas,
    hiddenimports=['PyQt5', 'PyQt5.QtCore', 'PyQt5.QtGui', 'PyQt5.QtWidgets'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='CuriosityTrail',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='CuriosityTrail',
)

app = BUNDLE(
    coll,
    name='CuriosityTrail.app',
    info_plist={
        'CFBundleName': 'Curiosity Trail',
        'CFBundleDisplayName': 'Curiosity Trail 寻迹',
        'CFBundleIdentifier': 'com.curiositytrail.app',
        'CFBundleVersion': '1.0.0',
        'CFBundlePackageType': 'APPL',
        'CFBundleShortVersionString': '1.0.0',
        'LSMinimumSystemVersion': '10.13',
    },
    console=False,
    icon=None,
    bundle_identifier=None,
)