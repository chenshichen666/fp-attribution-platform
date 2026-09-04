# 误杀归因平台 · 部署操作手册（手把手版）

全程约 **20 分钟**。不需要懂 Docker、不需要懂 Linux，照着复制粘贴命令即可。
遇到任何报错，直接跳到文末「第八步 · 出问题怎么办」。

---

## 第 0 步：买一台服务器

以**腾讯云轻量应用服务器**为例（阿里云操作几乎一样）。

1. 打开 https://cloud.tencent.com/product/lighthouse ，点「立即购买」
2. 按下面选：

| 选项 | 选什么 | 说明 |
|------|--------|------|
| 地域 | **上海** 或 **广州** | 选离你近的，速度快 |
| 镜像 | **系统镜像 → Ubuntu Server 22.04 LTS** | ⚠️ 一定要 Ubuntu，不要选 Windows |
| 套餐 | 2核 4G（或最低配 2核 2G 也行） | 约 ¥50–100/月 |
| 时长 | 1 个月起 | 可随时续费 |

3. 付款完成后，进入**控制台 → 轻量应用服务器**，能看到你的服务器，记下两样东西：

- **公网 IP**：形如 `129.204.xxx.xxx`（后面到处要用，下面用 `<你的IP>` 代替）
- **状态**：应为「运行中」

> 阿里云对应产品叫「轻量应用服务器」，入口：https://www.aliyun.com/product/swas

---

## 第 1 步：登录服务器（不用装任何软件）

腾讯云控制台里自带网页版终端，直接在浏览器里敲命令，最省事。

1. 控制台 → 轻量应用服务器 → 点你的服务器
2. 点右上角「**登录**」按钮（有的版本叫「一键登录」「WebShell」）
3. 会弹出一个**黑色窗口**，这就是服务器终端

> 首次登录可能要求设置密码：按提示在控制台「重置密码」，重置后**重启服务器**再登录。

**验证成功标志**：黑色窗口里显示类似
```
ubuntu@VM-xx-xx-ubuntu:~$
```

---

## 第 2 步：安装 Node（复制粘贴即可）

在黑色窗口里，**逐行**复制粘贴下面命令，每粘贴一行按一次回车：

```bash
sudo apt update
```

（会滚动一堆文字，等它停下来出现 `$` 提示符再继续）

```bash
sudo apt install -y curl wget unzip
```

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
```

```bash
sudo apt install -y nodejs
```

最后验证：

```bash
node -v
```

**验证成功标志**：输出 `v20.x.x`（如 `v20.18.0`）。必须是 **v20 或更高**。

### ⚠️ 如果上面速度很慢或卡住（国内常见）

用国内镜像装，改用下面这串命令（**从第 2 步重新开始，不要混用**）：

```bash
cd /tmp
wget https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-linux-x64.tar.xz
```

```bash
tar -xf node-v20.18.0-linux-x64.tar.xz
```

```bash
sudo mv node-v20.18.0-linux-x64 /opt/node
```

```bash
sudo ln -sf /opt/node/bin/node /usr/bin/node
```

```bash
sudo ln -sf /opt/node/bin/npm /usr/bin/npm
```

```bash
node -v
```

同样要求输出 `v20.18.0`。

---

## 第 3 步：把部署包传到服务器

### 方法 A（推荐，最简单）：用控制台自带的文件上传

1. 在黑色窗口（WebShell）的**右上角或顶部菜单**，找「**上传文件**」按钮
   - 腾讯云：WebShell 窗口右上角有个上传图标
   - 若找不到，看窗口菜单里有没有「文件管理 / 上传」
2. 选择你电脑上的 **`fp-platform.zip`**
3. 上传位置默认在你的用户目录（`/home/ubuntu` 或 `/root`）

上传后在窗口里执行：

```bash
ls -lh fp-platform.zip
```

**验证成功标志**：显示 `fp-platform.zip`，大小约 `3.7M`。

### 方法 B：在你自己电脑的终端里用 scp

如果你会用 Mac 的「终端」或 Windows 的 PowerShell：

```bash
scp /path/to/fp-platform.zip ubuntu@<你的IP>:/home/ubuntu/
```

（把 `/path/to/` 换成你电脑上 zip 的实际路径，输入服务器密码即可）

> 提示：不知道 zip 在你电脑哪个位置？在访达/Finder 里右键文件 → 按住 Option 选「拷贝为路径名」。

---

## 第 4 步：解压

```bash
cd ~
```

```bash
unzip fp-platform.zip
```

```bash
cd fp-platform
```

```bash
ls
```

**验证成功标志**：显示三个东西 —— `server`、`dist`、`start.sh`（还有 `部署说明.md`）

---

## 第 5 步：一键启动

```bash
bash start.sh
```

首次运行会**自动安装依赖，约 1–3 分钟**，你会看到：

```
== 1/4 检查 Node ==
   Node v20.x.x  ✓
== 2/4 安装依赖（首次运行约 1-3 分钟）==
   ...
== 3/4 停止旧进程（如有）==
== 4/4 启动服务（端口 8787）==

== 健康检查 ==
   服务正常：{"ok":true,"db":"up",...}

✔ 启动完成！
  外网访问： http://<你的服务器公网IP>:8787
```

**验证成功标志**：看到 `✔ 启动完成！` 和健康检查返回 `{"ok":true,...}`。

---

## 第 6 步：放行端口（不做这步外网打不开！）

这是**最常见的"打不开"原因**，务必做。

1. 回到**云厂商控制台**（不是黑色窗口）
2. 点你的服务器 → 找「**防火墙**」标签页
   - 腾讯云轻量：服务器详情页里就有「防火墙」tab
   - 阿里云轻量：叫「防火墙」或「安全组」
3. 点「**添加规则**」，填：

| 字段 | 填什么 |
|------|--------|
| 应用类型 / 协议 | **TCP** |
| 端口 | **8787** |
| 来源 / 授权对象 | **0.0.0.0/0** |
| 策略 | 允许 |

4. 保存（通常立即生效）

> ⚠️ 如果你在第 5 步用了别的端口（如 8080），这里就填那个端口。

---

## 第 7 步：打开验证

在你**自己电脑的浏览器**地址栏输入：

```
http://<你的IP>:8787
```

例如：`http://129.204.12.34:8787`

**验证成功标志**：
- 页面正常显示误杀归因平台
- 顶部 KPI 卡片显示 **大盘精度 79% / 绝对精度 81%**
- 各页面有数据，不是空白

🎉 **到这里就部署完成了！这个地址不依赖你本机、不依赖腾讯内网，任何网络都能直接打开。**

---

## 第 8 步：出问题怎么办

### ❌ 网页打不开 / 一直转圈 / 连接超时

按顺序排查：

1. **端口没放行** → 回到第 6 步确认防火墙规则已加
2. **服务没起来** → 在黑色窗口执行：
   ```bash
   tail -50 ~/fp-platform/server.log
   ```
   看最后几行有没有报错
3. **健康检查**：
   ```bash
   curl http://127.0.0.1:8787/api/health
   ```
   返回 `{"ok":true,...}` 说明服务正常，那就是端口/防火墙问题

### ❌ 启动时报 `better-sqlite3` 编译失败

```bash
sudo apt install -y python3 make g++
cd ~/fp-platform/server && rm -rf node_modules && npm install --omit=dev
```

装完再 `cd ~/fp-platform && bash start.sh`

### ❌ 提示端口被占用

换个端口启动（记得防火墙也要放行新端口）：

```bash
PORT=8080 bash start.sh
```

### ❌ 想重启 / 停止服务

```bash
cd ~/fp-platform
bash stop.sh      # 停止
bash start.sh     # 再次启动（含重启效果）
```

### ❌ 想换回端口 8787 或看日志

```bash
tail -f ~/fp-platform/server.log
```

（按 `Ctrl + C` 退出实时日志）

---

## 附：设置开机自启（可选，服务器重启后自动恢复）

如果你希望服务器重启后平台自动运行，执行：

```bash
sudo tee /etc/systemd/system/fp-platform.service > /dev/null <<'EOF'
[Unit]
Description=FP Attribution Platform
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/fp-platform/server
Environment=PORT=8787
ExecStart=/usr/bin/node /root/fp-platform/server/src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

```bash
sudo systemctl daemon-reload
```

```bash
sudo systemctl enable --now fp-platform
```

```bash
sudo systemctl status fp-platform
```

> ⚠️ 注意：上面配置里写的是 `/root/fp-platform`，如果你实际解压在 `/home/ubuntu/fp-platform`，需要把这一行改掉：
> ```
> sudo sed -i 's|/root/fp-platform|/home/ubuntu/fp-platform|g' /etc/systemd/system/fp-platform.service
> ```
> 然后重新执行 `daemon-reload` 和 `enable --now`。

---

## 快速命令速查

| 想做什么 | 命令 |
|---------|------|
| 启动 | `cd ~/fp-platform && bash start.sh` |
| 停止 | `cd ~/fp-platform && bash stop.sh` |
| 看日志 | `tail -50 ~/fp-platform/server.log` |
| 健康检查 | `curl http://127.0.0.1:8787/api/health` |
| 换端口启动 | `PORT=8080 bash start.sh` |

**数据备份**：只需复制 `~/fp-platform/server/data/fp_attribution.db` 这一个文件即可。
