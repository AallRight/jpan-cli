# jpan-cli

上海交通大学云盘的非官方跨平台命令行客户端，支持 Linux、macOS 和 Windows。

项目地址：<https://github.com/AallRight/jpan-cli>

功能：

- 保存 `USER_TOKEN` 或整段 Cookie，并自动换取短期访问令牌
- `ls`、`cd`、`pwd` 和持久化远端当前目录
- 单文件上传、文件夹递归上传
- 单文件下载、文件夹递归下载
- 文件夹并发传输
- 下载断点续传（`.part` 文件）
- `skip`、`overwrite`、`rename` 同名策略
- 交互式 shell 和一次性命令两种用法

## 环境要求

Node.js 20 或更高版本。程序只使用 Node.js 标准库，没有第三方运行时依赖。

## 安装

### Linux / macOS

```bash
git clone https://github.com/AallRight/jpan-cli.git
cd jpan-cli
npm link
jpan --help
```

如果没有全局 npm 目录的写权限，可以跳过 `npm link`，直接运行：

```bash
node ./bin/jpan.js shell
```

### Windows（PowerShell）

```powershell
git clone https://github.com/AallRight/jpan-cli.git
Set-Location jpan-cli
npm link
jpan --help
```

## 快速开始

```bash
jpan login
jpan status
jpan ls /
jpan shell
```

## 登录

1. 在浏览器中登录 <https://pan.sjtu.edu.cn/>。
2. 打开开发者工具的 Application/应用 → Cookies。
3. 找到 `USER_TOKEN`，复制它的值；也可以复制包含 `USER_TOKEN` 的整段 Cookie 或 `Cookie:` 请求头。
4. 执行：

```bash
jpan login
```

输入会以星号显示。凭据存放在：

- Linux/macOS：`${XDG_CONFIG_HOME:-~/.config}/jpan/config.json`
- Windows：`%APPDATA%\jpan\config.json`

Unix 下配置文件权限会设置为 `0600`。服务器或 CI 也可以临时使用环境变量，避免写盘：

```bash
read -rsp 'USER_TOKEN: ' JPAN_USER_TOKEN
export JPAN_USER_TOKEN
jpan ls /
unset JPAN_USER_TOKEN
```

不要把 token 写入脚本、Git 仓库或公开日志。

更新凭据时重新运行 `jpan login`；清除本机凭据时运行：

```bash
jpan logout
```

## 使用

直接执行命令：

```bash
jpan ls /
jpan ls -l
jpan cd /课程资料
jpan pwd
jpan mkdir backups/2026

jpan upload ./report.pdf
jpan upload ./report.pdf /documents/final-report.pdf
jpan upload ./photos /backup --jobs 4

jpan download /documents/final-report.pdf .
jpan download /photos ./restore --jobs 4
```

或者进入交互模式：

```text
$ jpan shell
jpan:/> ls
jpan:/> cd 课程资料
jpan:/课程资料> upload "./实验 报告.pdf"
jpan:/课程资料> download slides ./downloads
jpan:/课程资料> exit
```

### 路径语义

- 远端相对路径基于 `jpan pwd` 显示的当前目录。
- 上传单文件时，如果目标已是目录，则保留本地文件名；否则目标作为完整文件路径。
- 上传文件夹时，会在目标目录下创建一个与本地文件夹同名的目录。
- 下载文件夹时，会在本地目标下创建一个与远端文件夹同名的目录。
- 符号链接会被跳过，避免递归逃出所选的本地目录。

### 同名处理

默认跳过已存在文件：

```bash
jpan upload file.bin /backup --conflict skip
```

覆盖或让服务端自动改名：

```bash
jpan upload file.bin /backup --conflict overwrite
jpan upload file.bin /backup --conflict rename
```

下载支持 `skip` 和 `overwrite`。未完成下载保存在 `.part` 文件中，下次执行同一命令会继续下载。

## 命令一览

| 命令 | 说明 |
| --- | --- |
| `jpan login` | 输入或更新 Cookie / `USER_TOKEN` |
| `jpan logout` | 删除本机保存的凭据 |
| `jpan status` | 检查凭据并显示当前空间 |
| `jpan shell` | 进入交互模式 |
| `jpan pwd` | 显示远端当前目录 |
| `jpan cd <目录>` | 切换并保存远端当前目录 |
| `jpan ls [目录] [-l]` | 列出远端文件 |
| `jpan mkdir <目录>` | 递归创建远端目录 |
| `jpan upload <本地> [远端]` | 上传文件或文件夹 |
| `jpan download <远端> [本地]` | 下载文件或文件夹 |

完整的内置帮助：

```bash
jpan --help
```

## 测试

```bash
npm test
```

测试使用本地模拟服务器，不需要真实交大账号，也不会上传或下载云盘数据。

## 注意

交大云盘没有公开面向最终用户的稳定 CLI API。本程序使用网页端背后的 SJTU 网关和腾讯云 SMH/COS 协议，若网站升级，接口可能需要同步调整。

- 本项目与上海交通大学网络信息中心、腾讯云没有官方关联。
- 请遵守学校相关规定，仅操作自己有权访问的数据。
- 带签名的 COS 地址、`USER_TOKEN` 和短期 `accessToken` 均不会主动输出到日志。
- 遇到问题时可在 <https://github.com/AallRight/jpan-cli/issues> 提交反馈，但不要粘贴 Cookie、token 或带签名的下载地址。
