# TRAG 检索客户端使用文档

> **脚本路径**：`dataset_trag/trag_client.py`

## 1. 概述

`trag_client.py` 是一个独立的 TRAG 检索客户端脚本，**不依赖项目内其他文件**（仅依赖 `trag` SDK 和 `requests`）。

它封装了 7 种检索任务的完整流程：根据任务类型自动初始化对应的 TRAG collection，提供统一的检索接口，并支持从命令行 / 交互式 / 代码三种方式调用。

### 1.1 支持的 7 种任务类型

| 任务类型 | 标签 | 输入类型 | 嵌入模型 | 说明 |
|---------|------|---------|---------|------|
| `text_text` | 文本 → 文本 | text | bge-large-zh | 用文本查询文本 collection |
| `image_image` | 图片 → 图片 | url | youclip-visual-emb | 用图片 URL 查询图片 collection |
| `image_ocr` | 图片 OCR → 文本 | text | bge-large-zh | 用文本查询图片 OCR collection |
| `video_video` | 视频 → 视频 | fingerprint / base64 | youclip-visual-emb | 输入视频指纹或 base64 向量，检索视频 collection（512 维） |
| `video_ocr` | 视频 OCR → 文本 | text | bge-large-zh | 用文本查询视频 OCR collection |
| `video_asr` | 视频 ASR → 文本 | text | bge-large-zh | 用文本查询视频 ASR collection |
| `video_frame` | 视频风险帧 → 图片 | url | youclip-visual-emb | 用风险帧 URL 查询视频风险帧 collection |

### 1.2 三种运行模式

| 模式 | 命令 | 适用场景 |
|------|------|---------|
| `search` | `python trag_client.py search ...` | 脚本化批量检索，命令行传入所有参数 |
| `interactive` | `python trag_client.py interactive` | 引导式输入，最贴近网页端体验 |
| `example` | `python trag_client.py example -t <task>` | 快速示例，验证 SDK 连通性 |

### 1.3 限流（429）自动重试

脚本内置对 TRAG `RateLimitError`（HTTP 429）的自动重试机制，覆盖以下调用：

- `rag.namespace()` / `ns.collection()`（初始化 collection 时）
- `coll.search_documents()`（执行检索时）

遇到限流时会按指数退避策略等待后自动重试（默认 3s → 6s → 12s → 24s → 48s，最多重试 5 次），并打印提示：

```
[TRAGClient] 触发限流(429)，3 秒后进行第 1/5 次重试... (Error code: 429 - ...)
```

同一进程内多次创建 `TRAGClient` 实例时，Namespace 对象会被缓存复用，避免重复调用 `describe_namespace` 触发限流。

---

## 2. 环境准备

### 2.1 依赖安装

```bash
pip install trag requests
```

### 2.2 网络要求

- 脚本需要访问 TRAG 服务（内网），确保运行环境与 TRAG 服务网络可达。
- `video_video` 任务的指纹模式需要额外访问 ElementHub 接口。

---

## 3. 命令行模式：`search`

### 3.1 参数总览

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `--task` | str | 是 | — | 任务类型，见上方 7 种 |
| `--query` | str | 二选一 | — | 查询内容（文本 / URL / 视频指纹 / base64 向量） |
| `--query-file` | path | 二选一 | — | 从文件读取查询内容（与 `--query` 二选一） |
| `--input-mode` | str | 否 | `auto` | 输入模式：`auto` / `fingerprint` / `base64` / `text` / `url` |
| `--tags` | str | 否 | — | 违规标签 policy_id，逗号分隔 |
| `--first-industries` | str | 否 | — | 一级行业，逗号分隔 |
| `--second-industries` | str | 否 | — | 二级行业，逗号分隔 |
| `--filter-expr` | str | 否 | — | 直接传入 filter_expr（优先于 tags/industries 自动拼接） |
| `--limit` | int | 否 | 10（video_frame 为 20） | 返回数量，范围 1~500 |
| `--threshold` | float | 否 | 0.0 | 分数阈值，低于此值的结果会被过滤 |
| `--group-by-video` | flag | 否 | False | video_frame 任务下按 element_fingerprint 去重 |
| `--output-format` | str | 否 | `jsonl` | 输出格式：`jsonl` 或 `csv` |
| `--output-dir` | path | 否 | `./outputs/trag_search` | 输出目录 |

### 3.2 `--input-mode` 详解

| 值 | 说明 | 适用任务 |
|----|------|---------|
| `auto` | 按 `TASK_META` 的 `input_type` 自动选择 | 所有 |
| `fingerprint` | 视频指纹，通过 ElementHub 获取 embedding 后检索 | `video_video` |
| `base64` | base64 编码的 float32 向量，直接解码后检索 | `video_video` |
| `text` | 文本查询（用 `doc` 参数检索） | `text_text` / `image_ocr` / `video_ocr` / `video_asr` |
| `url` | URL 查询（用 `doc` 参数检索） | `image_image` / `video_frame` |

> `video_video` 任务下 `auto` 等价于 `fingerprint`，可通过指定 `base64` 改用向量输入。

### 3.3 调用示例

#### 示例 1：基础文本检索

```bash
python trag_client.py search \
    --task text_text \
    --query "请勿使用未经授权的第三方品牌信息" \
    --limit 10 \
    --output-format jsonl
```

#### 示例 2：带筛选条件的视频 OCR 检索

```bash
python trag_client.py search \
    --task video_ocr \
    --query "请勿使用未经授权的第三方品牌信息" \
    --tags 14749,14750 \
    --first-industries "电商服务" \
    --second-industries "综合电商,服饰鞋包" \
    --limit 20 \
    --threshold 0.5 \
    --output-format csv
```

#### 示例 3：视频指纹检索（video_video 默认模式）

```bash
python trag_client.py search \
    --task video_video \
    --query a2e9114b04e7dc66c5dd6e3dab995bc4 \
    --limit 10 \
    --output-format jsonl
```

#### 示例 4：base64 向量检索（video_video）

```bash
python trag_client.py search \
    --task video_video \
    --query <base64_str> \
    --input-mode base64 \
    --limit 10 \
    --output-format csv
```

#### 示例 5：从文件读取长查询内容

```bash
python trag_client.py search \
    --task video_ocr \
    --query-file ./query_text.txt \
    --limit 50 \
    --output-format jsonl \
    --output-dir ./results/text_search
```

> 检索直接用 `--query` 传入文本即可，`--query-file` 适用于超长文本或脚本化批量检索场景。

#### 示例 6：视频风险帧检索 + 去重

```bash
python trag_client.py search \
    --task video_frame \
    --query "https://static.example.com/location/prod/1842ae2b4b3b33c45d39dc1b3c271489.jpeg" \
    --limit 20 \
    --threshold 0.3 \
    --group-by-video \
    --output-format csv
```

#### 示例 7：直接传入 filter_expr（跳过自动拼接）

```bash
python trag_client.py search \
    --task video_ocr \
    --query "限时折扣" \
    --filter-expr 'policy_list in ("14749","14750") and v6_level_name_1 in ("电商服务","游戏")' \
    --limit 10 \
    --output-format jsonl
```

---

## 4. 交互模式：`interactive`

启动后逐步引导填写所有参数，最贴近网页端体验：

```bash
python trag_client.py interactive
```

交互流程（共 8 步）：

```
============================================================
  TRAG 检索客户端 — 交互模式
============================================================

【1/8】选择任务类型：
  1. text_text
     文本 → 文本 · 输入: text · 用文本查询文本 collection（bge-large-zh 嵌入）
  2. image_image
     ...
  7. video_frame
     ...
请输入编号 (1-7): 4

>> 已选择: video_video (视频 → 视频)

【2/8】输入查询内容
  video_video 支持两种输入模式：
    1. 视频指纹（element_fingerprint，自动从 ElementHub 获取 embedding）
    2. base64 向量（base64 编码的 float32 向量，直接解码检索）
  请选择输入模式 (1/2, 默认 1): 1
  >> 已选择视频指纹模式
  提示: 输入视频指纹（element_fingerprint），例如：a2e9114b04e7dc66c5dd6e3dab995bc4
  查询内容: a2e9114b04e7dc66c5dd6e3dab995bc4

【3/8】违规标签筛选（policy_id）
  输入 policy_id，多个用逗号分隔，如: 14749,14750
  直接回车跳过
  policy_id: 14749,14750

【4/8】一级行业筛选
  多个用逗号分隔，如: 电商服务,游戏
  直接回车跳过
  一级行业: 电商服务

【5/8】二级行业筛选
  多个用逗号分隔，如: 综合电商,服饰鞋包
  直接回车跳过
  二级行业: 综合电商

【6/8】返回数量（默认 10）
  数量 (1-500, 默认 10): 20

【7/8】分数阈值（0~1，低于此值的结果会被过滤）
  阈值 (默认 0，不过滤): 0.5

【8/8】选择输出格式
  1. jsonl（每行一条 JSON，含元信息）
  2. csv（表格格式，兼容 Excel）
  格式 (1/2, 默认 1): 1

  输出目录 (默认 ./outputs/trag_search):

────────────────────────────────────────────────────────────
  任务:       video_video
  输入模式:   fingerprint
  查询:       a2e9114b04e7dc66c5dd6e3dab995bc4
  标签:       ['14749', '14750']
  一级行业:   ['电商服务']
  二级行业:   ['综合电商']
  返回数量:   20
  阈值:       0.5
  输出格式:   jsonl
  输出目录:   ./outputs/trag_search
────────────────────────────────────────────────────────────

确认执行检索？(Y/n):
```

---

## 5. 快速示例模式：`example`

用于快速验证各任务的 SDK 连通性：

```bash
# 演示视频 ASR 检索（默认）
python trag_client.py example

# 指定任务类型
python trag_client.py example -t text_text
python trag_client.py example -t image_image
python trag_client.py example -t image_ocr
python trag_client.py example -t video_video
python trag_client.py example -t video_ocr
python trag_client.py example -t video_asr
python trag_client.py example -t video_frame
```

---

## 6. 代码调用

### 6.1 基础检索

```python
from trag_client import TRAGClient

# 初始化客户端
client = TRAGClient(task='video_ocr')

# 文本检索
results = client.search(
    doc='请勿使用未经授权的第三方品牌信息及版权广告',
    limit=5,
)

# 打印结果
for r in results:
    print(r['id'], r['score'], r.get('element_value'))
```

### 6.2 带 filter_expr 的检索

```python
from trag_client import TRAGClient

client = TRAGClient(task='video_ocr')
results = client.search(
    doc='请勿使用未经授权的第三方品牌信息及版权广告',
    limit=10,
    filter_expr='policy_list in ("14749","14750") and v6_level_name_1 in ("电商服务")',
)
```

### 6.3 向量检索（video_video）

```python
from trag_client import TRAGClient, _fetch_video_embedding_by_fingerprint

# 方式 1：视频指纹 → 自动获取 embedding
# 该方式需要在IDC环境执行
vector, element_value = _fetch_video_embedding_by_fingerprint('62393600b6697e3bfe14c843d0f012a7')
client = TRAGClient(task='video_video')
results = client.search(vector=vector, limit=10)

# 方式 2：直接传入 512 维向量
results = client.search(vector=[0.01] * 512, limit=10)
```

### 6.4 使用 `search_and_save` 一步完成检索 + 保存

```python
from trag_client import search_and_save

# 完整调用：检索 + 筛选 + 阈值 + 保存
results, output_path = search_and_save(
    task='video_ocr',
    query='请勿使用未经授权的第三方品牌信息',
    tags=['14749', '14750'],
    first_industries=['电商服务'],
    second_industries=['综合电商'],
    limit=20,
    threshold=0.5,
    output_format='csv',
    output_dir='./results/video_ocr',
)

print(f"结果已保存至: {output_path}")
```

### 6.5 video_video 使用 base64 向量

```python
from trag_client import search_and_save

# base64 编码的 float32 向量
base64_str = "AAAAgD9qR7w/..."  # 你的 base64 向量

results, output_path = search_and_save(
    task='video_video',
    query=base64_str,
    input_mode='base64',     # 指定 base64 模式
    limit=10,
    output_format='jsonl',
)
```

### 6.6 video_frame 去重检索

```python
from trag_client import search_and_save

results, output_path = search_and_save(
    task='video_frame',
    query='https://static.example.com/frame/prod/abc123.jpeg',
    limit=20,
    threshold=0.3,
    group_by_video=True,     # 按 element_fingerprint 去重
    output_format='csv',
)
```

---

## 7. 输出文件格式

### 7.1 JSONL 格式

每行一条 JSON 记录，包含元信息 + 检索结果字段：

```json
{
  "rank": 1,
  "task": "video_ocr",
  "query": "请勿使用未经授权的第三方品牌信息",
  "filter_expr": "policy_list in (\"14749\",\"14750\") and v6_level_name_1 in (\"电商服务\")",
  "threshold": 0.5,
  "group_by_video": false,
  "search_time": "2026-07-03 12:00:00",
  "id": "doc-xxxxx",
  "score": 0.8523,
  "element_value": "...",
  "ocr_text": "...",
  "policy_list": ["14749"],
  "sample_id": "..."
}
```

### 7.2 CSV 格式

- 编码：UTF-8 with BOM（Excel 直接打开中文不乱码）
- 列顺序：`rank` / `score` / `id` / `sample_id` + 任务默认字段 + 通用字段 + 其余字段
- 跳过 `vector` / `embedding` 等过大字段
- `dict` / `list` 字段统一序列化为 JSON 字符串

| 列名 | 说明 |
|------|------|
| `rank` | 排名（从 1 开始） |
| `score` | 相似度分数（保留 6 位小数） |
| `id` | 文档 ID |
| `sample_id` | 精标库原始 ID |
| `element_value` | 元素值（URL / 文本内容） |
| `ocr_text` | OCR 文本 |
| `asr_text` | ASR 文本 |
| `policy_list` | 命中的策略 ID 列表 |
| `fine_data_result` | 精标标签 JSON |
| `cos_url` | COS 下载地址 |
| ... | 其余动态字段 |

### 7.3 文件命名

```
trag_<task>_<YYYYMMDD_HHMMSS>.<ext>

# 示例
trag_video_ocr_20260703_120000.jsonl
trag_video_frame_20260703_120000.csv
```

---

## 8. 筛选条件说明

### 8.1 自动拼接（tags / industries）

当传入 `--tags` / `--first-industries` / `--second-industries` 时，脚本自动构建 TRAG filter_expr：

| 筛选维度 | 对应字段 | 语法 |
|---------|---------|------|
| 违规标签 | `policy_list`（array） | 单值 `policy_list = "14749"`；多值 `policy_list in ("14749","14750")` |
| 一级行业 | `v6_level_name_1` | 单值 `v6_level_name_1 = "电商服务"`；多值 `v6_level_name_1 in ("电商服务","游戏")` |
| 二级行业 | `v6_level_name_2` | 单值 `v6_level_name_2 = "综合电商"`；多值 `v6_level_name_2 in ("综合电商","服饰鞋包")` |

不同筛选维度间用 `and` 连接。

### 8.2 直接传入 filter_expr

通过 `--filter-expr` 或 `filter_expr=` 参数直接传入完整表达式，**优先于自动拼接**：

```bash
--filter-expr 'policy_list in ("14749","14750") and v6_level_name_1 in ("电商服务")'
```

> **注意**：TRAG filter_expr 语法中关键字必须**小写**（`and` / `or` / `in`），字符串值用双引号包裹。

---

## 9. 检索结果字段说明

每条检索结果（`dict`）可能包含以下字段（取决于 collection 中实际存储的数据）：

| 字段 | 说明 |
|------|------|
| `id` | TRAG 文档 ID |
| `score` | 相似度分数（0~1，越高越相似） |
| `element_value` | 元素值（视频 URL / 图片 URL / 文本内容） |
| `element_fingerprint` | 元素指纹 |
| `ocr_text` | OCR 识别文本 |
| `asr_text` | ASR 语音识别文本 |
| `cos_url` | COS 下载地址 |
| `sample_id` | 精标库原始 ID |
| `policy_list` | 命中的策略 ID 列表 |
| `fine_data_result` | 精标标签详情（JSON） |
| `v6_first_level_industry_name` | 一级行业名 |
| `v6_second_level_industry_name` | 二级行业名 |
| `frame_element_value` | 风险帧图片 URL（video_frame） |
| `frame_time` | 风险帧时间戳（video_frame） |
| `doc` | 违规详情 JSON |
| `vector` | embedding 向量（需 `retrieve_vector=True`） |

---

## 10. 与网页端（trag_app.py）的功能对齐

| 网页端功能 | 客户端对应 | 状态 |
|-----------|-----------|------|
| 任务选择 | `--task` | ✅ |
| 查询内容输入 | `--query` / `--query-file` | ✅ |
| 违规标签筛选 | `--tags` | ✅ |
| 一级行业筛选 | `--first-industries` | ✅ |
| 二级行业筛选 | `--second-industries` | ✅ |
| 返回数量 | `--limit` | ✅ |
| 阈值过滤 | `--threshold` | ✅ |
| 视频指纹检索 | `--input-mode fingerprint` | ✅ |
| base64 向量检索 | `--input-mode base64` | ✅ |
| 视频帧去重 | `--group-by-video` | ✅ |
| 结果导出 CSV | `--output-format csv` | ✅ |
| 结果导出 JSONL | `--output-format jsonl` | ✅ |
| 交互式输入 | `interactive` 模式 | ✅ |

> 网页端特有的图片上传、查询日志、Lightbox 预览等 UI 功能属于 Web 层，客户端作为 CLI 工具不涉及。

---

## 11. 常见问题

### Q1: `video_video` 任务报错 "指纹未查到数据"

视频指纹对应的视频可能尚未生成 embedding。可改用 `--input-mode base64` 直接传入向量。

### Q2: 筛选条件不生效，返回结果为 0 条

存量数据可能未写入 `v6_level_name_1` / `v6_level_name_2` 等行业字段，server 端按这些字段过滤会命中 0 条。建议先不加筛选条件检索，确认数据是否存在。

### Q3: CSV 打开中文乱码

CSV 文件已写入 UTF-8 BOM。如果仍有问题，请用支持 UTF-8 的编辑器（如 VS Code）打开，或在 Excel 中选择"数据 → 从文本/CSV"导入并选择 UTF-8 编码。

### Q4: 报错 `RateLimitError: Error code: 429 ... too many requests, rag code:is-83108979 rate limit`

TRAG 接口触发了限流。脚本已内置自动重试（见 [1.3 节](#13-限流429自动重试)），一般会在几十秒内自动恢复，无需手动处理。若重试 5 次后仍失败：

- 降低并发/调用频率，避免短时间内在多个进程/终端同时批量调用脚本
- 稍等几分钟后再重试
- 如果需要更长的重试等待时间，可修改 `trag_client.py` 中 `_call_with_retry` 的 `max_retries` / `base_delay` 参数

### Q5: 如何获取视频指纹

视频指纹（`element_fingerprint`）是视频内容的 MD5 哈希，通常从精标库或 ElementHub 获取。也可在网页端检索结果中查看 `element_fingerprint` 字段。

### Q6: `--query` 和 `--query-file` 可以同时使用吗

不可以。`--query-file` 优先级更高，如果同时指定，`--query` 会被忽略。
