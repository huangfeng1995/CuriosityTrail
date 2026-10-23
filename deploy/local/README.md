# 寻迹 · 本地版（给非技术用户用）

不想买服务器？把这个版本发给用的人，她在自己电脑上就能写。

数据全在她自己电脑上，不经过任何服务器，也就不花钱。

---

## 一、打包

在 Mac 上跑：

```bash
bash deploy/local/package-windows.sh
```

产物在 `dist-local/寻迹-windows.zip`（约 600KB）。

把这个 zip 发给她：微信、U 盘、网盘都行。

---

## 二、她需要做的

1. 解压到 `C:\寻迹`
2. 双击「启动寻迹.cmd」
3. 第一次会下载运行环境并装组件（需联网，2-4 分钟）
4. 之后每次双击都秒开，浏览器自动打开

完整的操作说明在 zip 里的「使用说明.txt」，那份是给她看的。

---

## 三、几个设计上的决定

**为什么自带 Node 运行时**

用官方的免安装版 Node（解压即用，不写系统 PATH，不进「程序和功能」列表）。
她电脑上不需要装任何东西，卸载就是删文件夹。

**为什么第一次要联网**

两个环节离不开网：下载 Node 运行时、装 npm 依赖。
装完之后就完全离线了，断网也能写。

**为什么 zip 里不带 node_modules**

服务器端有个原生模块（sqlite3），在 macOS 上编译的版本拿到 Windows 上会崩。
所以依赖留给她机器上现装——npm 会自动拉对应平台的预编译包。

`package.json` 里加了 `allowScripts` 配置。新版 npm 默认拦截依赖的安装脚本，
不放行的话 sqlite3 的原生模块装不上，服务会起不来。

**为什么 cookie 要单独设一个开关**

cookie 的 `secure` 标记只在 HTTPS 下才会被浏览器存下。
服务器部署走 HTTPS，必须开着；但本地版是 `http://127.0.0.1`，
开着就等于登录一次就得重新登一次。

所以加了个 `COOKIE_SECURE` 环境变量：显式设了才生效，没设仍按 `NODE_ENV` 走。
服务器部署的行为完全没变。

**数据放在哪**

`寻迹\data\` 下：

| 文件 | 内容 |
|------|------|
| `curiosity.db` | 小说、章节、人物卡、设定 |
| `uploads\` | 上传的图片 |
| `documents\` | 导入的 PDF/TXT 原文 |
| `backups\` | 每天凌晨 3 点自动备份，保留 7 份 |

备份最简单的办法：把整个「寻迹」文件夹复制到 U 盘或网盘。

---

## 四、验证

```bash
bash deploy/local/package-windows.sh    # 先打包
bash deploy/local/test/e2e-local.sh     # 再验证
```

覆盖：打包产物完整性 → 依赖安装 → 配置生成 → 服务启动 → 静态资源 →
登录与会话保持 → 建作品/写章节/保存 → 导出与备份 → 停服重启 → 数据留存。

脚本需要 `pwsh`（PowerShell 7+）来跑 `make-config.ps1`：

```bash
PWSH=/path/to/pwsh bash deploy/local/test/e2e-local.sh
```

没有 pwsh 会跳过配置生成那步，用手写 `.env` 继续跑完其余检查。

---

## 五、还没验证的部分

本机是 macOS，没有 Windows 环境，所以以下几项是按 Windows 行为设计的，
但没有在真机上跑过：

- `启动寻迹.cmd` / `停止寻迹.cmd` 的实际执行
- Node 免安装包在 Windows 上的解压与重命名
- sqlite3 的 Windows 预编译包能否顺利下载（`sqlite3-v5.1.7-napi-v6-win32-x64.tar.gz`，
  已确认在 GitHub 上存在）
- 中文路径、中文文件名在 Windows 上的显示

第一次交给她时，最好当面陪她点一遍。
