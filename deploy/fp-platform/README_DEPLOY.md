# 误杀归因平台 · 云服务器部署说明

这是一个 **自包含** 的 Node + SQLite 应用：不依赖 Docker、不依赖 MySQL、不依赖任何内网服务。
只要有 Node 20+，解压后跑一条命令即可。

---

## 一、服务器准备

推荐配置（腾讯云 / 阿里云「轻量应用服务器」即可，约 ¥50–100/月）：

| 项目 | 建议 |
|------|------|
| 系统 | Ubuntu 22.04 / 20.04（或 CentOS 7+） |
| CPU / 内存 | 2 核 4G（最低 1 核 2G 也能跑） |
| 磁盘 | 40G 以上（当前数据库 14M，日志会增长） |
| 网络 | 需要**公网 IP** |

### 安装 Node 20+（Ubuntu 示例）

```bash
# 方式一：apt（简单，版本可能略旧但通常够用）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 验证
node -v   # 需 v20 或更高
npm -v
```

> 若 `deb.nodesource.com` 访问慢，可用国内镜像：
> `npmmirror` 提供 Node 二进制：`https://npmmirror.com/mirrors/node/`

---

## 二、上传并解压

在本机（你的电脑）执行：

```bash
scp fp-platform.zip root@<服务器公网IP>:/root/
```

在服务器上执行：

```bash
cd /root
unzip fp-platform.zip      # 若无 unzip：sudo apt install -y unzip
cd fp-platform
```

目录结构：

```
fp-platform/
├── server/              # 后端（Express + SQLite）
│   ├── src/
│   ├── data/fp_attribution.db   # 数据库（已含全部数据）
│   └── package.json
├── dist/                # 前端构建产物
├── start.sh             # 一键启动
├── stop.sh              # 停止服务
└── 部署说明.md
```

---

## 三、启动

```bash
bash start.sh
```

首次运行会自动安装依赖（约 1–3 分钟，已配置淘宝镜像加速）。
看到 `✔ 启动完成！` 即表示成功。

指定端口启动：

```bash
PORT=8080 bash start.sh
```

停止服务：

```bash
bash stop.sh
```

---

## 四、开放端口（关键！）

外网打不开，**99% 是端口没放行**。需要在两处放行（以 8787 为例）：

1. **云厂商安全组**（腾讯云/阿里云控制台 → 服务器 → 防火墙/安全组）
   → 添加规则：TCP `8787`，来源 `0.0.0.0/0`

2. **服务器本机防火墙**（若有）

```bash
# Ubuntu
sudo ufw allow 8787/tcp
# CentOS
sudo firewall-cmd --permanent --add-port=8787/tcp && sudo firewall-cmd --reload
```

然后浏览器访问：**`http://<服务器公网IP>:8787`**

> 用 `IP + 端口` 方式访问**无需备案**。
> 只有想绑定域名并用 80/443 端口访问时，才需要 ICP 备案。

---

## 五、设置开机自启（可选）

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

sudo systemctl daemon-reload
sudo systemctl enable --now fp-platform
sudo systemctl status fp-platform
```

之后可用 `sudo systemctl restart fp-platform` 重启。

---

## 六、常见问题

**Q1：`npm install` 时报 `better-sqlite3` 编译失败**

该模块是原生模块，通常会自动下载预编译包。若编译失败，安装编译工具后重试：

```bash
sudo apt install -y python3 make g++
cd server && rm -rf node_modules && npm install --omit=dev
```

**Q2：启动后访问空白 / 502**

- 检查端口是否放行（第四节）
- 看日志：`tail -50 server.log`
- 健康检查：`curl http://127.0.0.1:8787/api/health`，返回 `{"ok":true,...}` 即正常

**Q3：端口被占用**

换端口启动：`PORT=8080 bash start.sh`（记得同步放行新端口）

**Q4：数据在哪里？怎么备份？**

数据库是单文件：`server/data/fp_attribution.db`。
备份只需复制该文件；恢复只需把它放回原位置后重启服务。

**Q5：需要 HTTPS / 域名吗？**

不需要。若后续要绑域名 + HTTPS，建议用 Nginx 反向代理 + 免费证书（certbot）。

---

## 七、当前数据快照

| 指标 | 值 |
|------|-----|
| 大盘精度（全量 / 近7天） | 79.2% / 79% |
| 绝对精度（全量 / 近7天） | 79.4% / 81% |
| 标签数 / 聚类簇数 | 30 / 500 |
| 样本数 | 15,000 |
| 沉淀结论 | 180（真实误杀 113 / 机审正确 67 / 已更新 35） |
| 数据日期范围 | 2026-06-08 ~ 2026-09-03 |
