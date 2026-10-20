# 项目长期约定

## PDF 拆分工作台（pdf_workbench/）

- **运行本项目一律显式使用 `D:/miniconda/python.exe`**，不要用裸 `python`。
  本机 PATH 第一个 `python` 是 WorkBuddy 托管 Python，**没有 PyMuPDF**；只有 miniconda 那个装了（fitz 1.27.2.3）。
- 用户使用方式是**双击 `start.bat`**，所以启动器必须自己把解释器找对：优先挑已装 PyMuPDF 的，找不到才 pip install 并复验。
- `.bat` 文件必须 **CRLF + GBK(cp936)** 编码，不要用 LF 或 `chcp 65001`（cmd 会解析错乱）。
- 服务端口 8765–8785；`allow_reuse_address` 必须为 False，否则 Windows 下两进程会同绑一端口，浏览器可能命中残留旧实例。
- 定位"用户那边有 bug、我这边测试全过"的问题时，优先怀疑：启动路径（而不是业务逻辑）、旧进程残留、以及测试所用解释器与用户实际解释器不一致。
