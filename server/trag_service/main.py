"""
TRAG 检索微服务 —— 基于 trag_client.py 封装，提供 HTTP API
启动: uvicorn main:app --host 0.0.0.0 --port 9100

直接复用 trag_client.py 中的 TRAGClient、search_and_save 等实现，
保证微服务与 CLI 客户端使用完全一致的 SDK 调用逻辑。
"""
import os
import time
import json
import hashlib
import asyncio
import requests
from typing import Optional, List, Dict, Any
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime, timedelta

# 直接从 trag_client 导入核心实现
from trag_client import (
    TASK_META,
    TRAGClient,
    search_and_save,
    _build_filter_expr,
    _call_with_retry,
    _fetch_video_embedding_by_fingerprint,
    _decode_base64_vector,
    TRAG_API_KEY,
    TRAG_AVAILABLE,
)

app = FastAPI(title="TRAG Search Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# 线程池：用于执行阻塞的 TRAG SDK 调用，避免 time.sleep 重试阻塞 async 事件循环
_search_executor = ThreadPoolExecutor(max_workers=4)

# ===== MySQL 缓存配置 =====
# 通过环境变量配置，不硬编码
DB_HOST = os.environ.get("DB_HOST", "")
DB_PORT = os.environ.get("DB_PORT", "3306")
DB_USER = os.environ.get("DB_USER", "")
DB_PASS = os.environ.get("DB_PASS", "")
DB_NAME = os.environ.get("DB_NAME", "")

CACHE_TTL_HOURS = 24  # 缓存过期时间（小时）


def _get_db_conn():
    """获取 MySQL 连接（延迟导入 pymysql）"""
    import pymysql
    return pymysql.connect(
        host=DB_HOST,
        port=int(DB_PORT),
        user=DB_USER,
        password=DB_PASS,
        database=DB_NAME,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
    )


def _ensure_cache_table():
    """确保 trag_cache 表存在"""
    try:
        conn = _get_db_conn()
        with conn.cursor() as cursor:
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS trag_cache (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    cache_key VARCHAR(255) NOT NULL UNIQUE,
                    task VARCHAR(50) NOT NULL,
                    query_text TEXT,
                    filter_expr TEXT,
                    results JSON,
                    result_count INT DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_cache_key (cache_key),
                    INDEX idx_created (created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[TRAG Service] 缓存表初始化失败（非致命）: {e}")


def _get_cache(cache_key: str) -> Optional[Dict]:
    """读取缓存"""
    try:
        conn = _get_db_conn()
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT results, result_count, created_at FROM trag_cache WHERE cache_key = %s",
                (cache_key,),
            )
            row = cursor.fetchone()
        conn.close()
        if row:
            # 检查是否过期
            created = row["created_at"]
            if isinstance(created, str):
                created = datetime.fromisoformat(created)
            if datetime.now() - created < timedelta(hours=CACHE_TTL_HOURS):
                results = json.loads(row["results"]) if isinstance(row["results"], str) else row["results"]
                return {"results": results, "total": row["result_count"], "cached": True}
        return None
    except Exception as e:
        print(f"[TRAG Service] 读取缓存失败（非致命）: {e}")
        return None


def _set_cache(cache_key: str, task: str, query: str, filter_expr: str, results: List[Dict]):
    """写入缓存"""
    try:
        conn = _get_db_conn()
        with conn.cursor() as cursor:
            sql = """
                INSERT INTO trag_cache (cache_key, task, query_text, filter_expr, results, result_count)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    task=VALUES(task), query_text=VALUES(query_text),
                    filter_expr=VALUES(filter_expr), results=VALUES(results),
                    result_count=VALUES(result_count), created_at=CURRENT_TIMESTAMP
            """
            cursor.execute(sql, (
                cache_key, task, query[:1000], filter_expr or "",
                json.dumps(results, ensure_ascii=False), len(results)
            ))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[TRAG Service] 写入缓存失败（非致命）: {e}")


def _make_cache_key(task: str, query: str, filter_expr: str, limit: int, threshold: float) -> str:
    """生成缓存键"""
    raw = f"{task}|{query}|{filter_expr or ''}|{limit}|{threshold}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


# ===== 请求模型 =====

class SearchRequest(BaseModel):
    task: str
    query: str
    input_mode: str = "auto"
    tags: Optional[List[str]] = None
    first_industries: Optional[List[str]] = None
    second_industries: Optional[List[str]] = None
    filter_expr: Optional[str] = None
    limit: int = None
    threshold: float = 0.0
    group_by_video: bool = False


class WarmupRequest(BaseModel):
    """预热请求：批量样本 × 多任务类型"""
    samples: List[Dict[str, Any]] = []
    tasks: Optional[List[str]] = None  # 不传则全部7种任务
    limit: int = 10
    threshold: float = 0.0


class ClearCacheRequest(BaseModel):
    """清空缓存请求"""
    pass


# ===== API 路由 =====

@app.get("/trag/tasks")
async def get_tasks():
    """返回支持的任务类型列表"""
    return [
        {"task": k, "label": v["label"], "input_type": v["input_type"], "desc": v["desc"]}
        for k, v in TASK_META.items()
    ]


@app.post("/trag/search")
async def search(req: SearchRequest):
    """执行 TRAG 检索（带 MySQL 缓存）

    使用线程池执行阻塞的 SDK 调用，避免 time.sleep 重试阻塞 async 事件循环。
    """
    if req.task not in TASK_META:
        raise HTTPException(status_code=400, detail=f"不支持的任务类型: {req.task}")

    # 确定 limit
    if req.limit is None:
        req.limit = TASK_META[req.task]["default_limit"]

    # 构建 filter_expr
    final_filter = _build_filter_expr(
        req.tags, req.first_industries, req.second_industries, req.filter_expr
    )

    # 检查缓存
    cache_key = _make_cache_key(req.task, req.query, final_filter or "", req.limit, req.threshold)
    cached = _get_cache(cache_key)
    if cached:
        cached["task"] = req.task
        return cached

    # SDK 不可用时返回 503 降级（不进入线程池，避免 RuntimeError）
    if not TRAG_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="TRAG SDK 未安装，检索服务暂不可用。请联系管理员配置内网 PyPI 源。"
        )

    # 执行检索 —— 用线程池避免 time.sleep 阻塞事件循环
    # 对于视觉嵌入类任务（image_image/video_video/video_frame），Venus 模型服务可能不稳定，
    # 失败时自动降级到文本类检索（image_ocr/video_ocr/video_asr），使用 bge-large-zh 模型
    VISUAL_TASKS = {"image_image", "video_video", "video_frame"}
    FALLBACK_MAP = {
        "image_image": "image_ocr",
        "video_video": "video_ocr",
        "video_frame": "video_ocr",
    }

    loop = asyncio.get_event_loop()
    try:
        results, _ = await loop.run_in_executor(
            _search_executor,
            lambda: search_and_save(
                task=req.task,
                query=req.query,
                input_mode=req.input_mode,
                tags=req.tags,
                first_industries=req.first_industries,
                second_industries=req.second_industries,
                filter_expr=req.filter_expr,
                limit=req.limit,
                threshold=req.threshold,
                group_by_video=req.group_by_video,
                output_format="jsonl",
                output_dir="/tmp/trag_service_outputs",
            )
        )

        # 写入缓存
        _set_cache(cache_key, req.task, req.query, final_filter or "", results)

        return {
            "results": results,
            "total": len(results),
            "task": req.task,
            "cached": False,
        }
    except HTTPException:
        raise
    except Exception as e:
        err_msg = str(e)

        # 视觉嵌入类任务失败 → 自动降级到文本类检索
        if req.task in VISUAL_TASKS:
            fallback_task = FALLBACK_MAP[req.task]
            # 降级任务需要文本查询，从原始 query 中提取
            # image_image: query 是图片URL → 降级到 image_ocr 需要文本，但URL本身可以作为doc传入
            # video_video: query 是指纹 → 降级到 video_ocr 需要文本，指纹无法直接用
            # video_frame: query 是URL → 降级到 video_ocr 需要文本
            # 对于无法直接降级的情况（如 video_video 指纹），跳过降级
            can_fallback = True
            fallback_query = req.query
            if req.task == "video_video":
                # 指纹不是有效文本，无法降级
                can_fallback = False

            if can_fallback:
                print(f"[TRAG Service] {req.task} 检索失败，自动降级到 {fallback_task}: {err_msg[:200]}")
                try:
                    results, _ = await loop.run_in_executor(
                        _search_executor,
                        lambda: search_and_save(
                            task=fallback_task,
                            query=fallback_query,
                            input_mode="auto",
                            tags=req.tags,
                            first_industries=req.first_industries,
                            second_industries=req.second_industries,
                            filter_expr=req.filter_expr,
                            limit=req.limit,
                            threshold=req.threshold,
                            output_format="jsonl",
                            output_dir="/tmp/trag_service_outputs",
                        )
                    )
                    # 写入缓存（用降级后的 task 作为缓存 key 的一部分）
                    fb_cache_key = _make_cache_key(fallback_task, fallback_query, final_filter or "", req.limit, req.threshold)
                    _set_cache(fb_cache_key, fallback_task, fallback_query, final_filter or "", results)
                    # 同时缓存原 task 的结果，避免下次重复降级
                    _set_cache(cache_key, req.task, req.query, final_filter or "", results)

                    return {
                        "results": results,
                        "total": len(results),
                        "task": fallback_task,
                        "cached": False,
                        "degraded_from": req.task,
                    }
                except Exception as fb_err:
                    print(f"[TRAG Service] 降级检索 {fallback_task} 也失败: {str(fb_err)[:200]}")
                    # 降级也失败，继续到下面的错误处理

        import traceback
        traceback.print_exc()
        # ElementHub 不可达 + TRAG 降级也失败
        if "ElementHub" in err_msg and "TRAG" in err_msg:
            raise HTTPException(
                status_code=503,
                detail="视频→视频检索暂不可用（ElementHub 和 TRAG 降级均失败），建议切换为「视频OCR」或「视频ASR」检索。"
            )
        # ElementHub 不可达
        if "ElementHub" in err_msg or "NameResolution" in err_msg or "Failed to resolve" in err_msg:
            raise HTTPException(
                status_code=503,
                detail=f"视频检索服务(ElementHub)暂不可用，请稍后重试或使用其他检索方式。"
            )
        # 429 限流错误
        if "429" in err_msg or "rate limit" in err_msg.lower() or "too many requests" in err_msg.lower():
            raise HTTPException(
                status_code=429,
                detail=f"TRAG 检索服务限流中（too many requests），请稍后重试。"
            )
        # collection 不存在/已删除 —— 服务端索引库已变更，属外部数据问题
        if ("不存在或已删除" in err_msg) or ("Collection" in err_msg and ("not exist" in err_msg or "deleted" in err_msg.lower())):
            raise HTTPException(
                status_code=503,
                detail="TRAG 检索索引库暂不可用（Collection 不存在或已被服务端删除/重建），请联系管理员核对最新 collection code 后重试。"
            )
        raise HTTPException(status_code=500, detail=f"检索失败: {err_msg}")


@app.post("/trag/warmup")
async def warmup(req: WarmupRequest):
    """缓存预热：遍历所有样本 × 所有任务类型，批量执行检索并写入缓存

    此接口设计为异步调用（upload-finalize 后触发），响应包含预热统计。
    内部并发执行多个检索任务以加速。
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    tasks_to_run = list(TASK_META.keys()) if not req.tasks else [
        t for t in req.tasks if t in TASK_META
    ]
    if not tasks_to_run:
        raise HTTPException(status_code=400, detail="没有有效的任务类型")

    if not req.samples:
        return {"warmed": 0, "skipped": 0, "errors": 0, "message": "没有样本需要预热"}

    total = 0
    skipped = 0
    errors = 0

    def warmup_one(sample, task):
        """预热单个 sample × task"""
        query_text = _auto_fill_query(task, sample)
        if not query_text:
            return "skip"
        final_filter = _build_filter_expr(None, None, None, None)
        cache_key = _make_cache_key(task, query_text, final_filter or "", req.limit, req.threshold)
        cached = _get_cache(cache_key)
        if cached:
            return "skip"
        try:
            input_mode = TASK_META[task]["input_type"]
            results, _ = search_and_save(
                task=task,
                query=query_text,
                input_mode=input_mode,
                limit=req.limit,
                threshold=req.threshold,
                output_format="jsonl",
                output_dir="/tmp/trag_service_outputs",
            )
            _set_cache(cache_key, task, query_text, final_filter or "", results)
            return "ok"
        except Exception as e:
            print(f"[Warmup] 预热失败 sample={sample.get('id','?')} task={task}: {e}")
            return "error"

    # 限制最多 4 个并发线程（避免打爆 TRAG API 限流）
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = []
        for sample in req.samples:
            for task in tasks_to_run:
                futures.append(executor.submit(warmup_one, sample, task))

        for f in as_completed(futures):
            result = f.result()
            if result == "ok":
                total += 1
            elif result == "skip":
                skipped += 1
            else:
                errors += 1

    return {
        "warmed": total,
        "skipped": skipped,
        "errors": errors,
        "total_queries": len(tasks_to_run) * len(req.samples),
        "message": f"预热完成: {total} 条新缓存, {skipped} 条已存在, {errors} 条失败"
    }


@app.post("/trag/clear-cache")
async def clear_cache(req: ClearCacheRequest):
    """清空所有 trag_cache 表数据（上传新数据时调用）"""
    try:
        conn = _get_db_conn()
        with conn.cursor() as cursor:
            cursor.execute("TRUNCATE TABLE trag_cache")
        conn.commit()
        conn.close()
        return {"ok": True, "message": "缓存已清空"}
    except Exception as e:
        print(f"[TRAG Service] 清空缓存失败: {e}")
        raise HTTPException(status_code=500, detail=f"清空缓存失败: {str(e)}")


# ===== 图片上传（覆盖契约 3.5 节 POST /api/upload_image，供 TRAG_MODE=local 兜底） =====
# 返回可被 TRAG 回拉的 URL（可作为 image_image_shangshu / video_frame 的 query）
import os as _os

_ALLOWED_IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
_MAX_UPLOAD_BYTES = 20 * 1024 * 1024  # 单张 ≤ 20 MB


def _uploads_dir() -> str:
    d = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "uploads")
    _os.makedirs(d, exist_ok=True)
    return d


def _safe_filename(name: str) -> str:
    """文件名含 / \\ 或以 . 开头则拒绝；否则用安全名"""
    base = _os.path.basename(name or "").strip()
    if not base or base.startswith(".") or "/" in base or "\\" in base:
        return None
    ext = _os.path.splitext(base)[1].lower()
    if ext not in _ALLOWED_IMG_EXT:
        return None
    return base


@app.post("/trag/upload_image")
async def upload_image(request: Request):
    """上传本地图片，返回可回拉 URL

    支持两种上传方式（与正式契约一致）：
      1. multipart/form-data，字段名 file
      2. application/json + data_url（{ filename, data_url }）
    """
    content_type = request.headers.get("content-type", "")

    raw_bytes = None
    filename = None

    if "multipart/form-data" in content_type:
        form = await request.form()
        up = form.get("file")
        if up is None:
            raise HTTPException(status_code=400, detail="缺少 file 字段（multipart/form-data）")
        raw_bytes = await up.read()
        filename = getattr(up, "filename", None) or "upload.png"
    else:
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="请求体需为 JSON 或 multipart/form-data")
        data_url = body.get("data_url") or ""
        filename = body.get("filename") or "upload.png"
        if not data_url:
            raise HTTPException(status_code=400, detail="缺少 data_url（图片 base64 data URL）")
        # data:image/png;base64,xxxx
        try:
            header, b64 = data_url.split(",", 1)
            raw_bytes = base64.b64decode(b64)
        except Exception:
            raise HTTPException(status_code=400, detail="data_url 格式非法（应为 data:image/xxx;base64,...）")

    if raw_bytes is None:
        raise HTTPException(status_code=400, detail="未读取到图片数据")
    if len(raw_bytes) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="图片超过 20MB 上限")

    safe = _safe_filename(filename)
    if not safe:
        raise HTTPException(status_code=400, detail="非法文件名或扩展名（允许 jpg/jpeg/png/webp/gif/bmp）")

    # 避免重名：加时间戳前缀
    stored = f"{int(time.time() * 1000)}_{safe}"
    out_path = _os.path.join(_uploads_dir(), stored)
    with open(out_path, "wb") as f:
        f.write(raw_bytes)

    # 返回可回拉 URL：服务监听端口 + /uploads/{stored}
    port = int(os.environ.get("TRAG_PORT", "9100"))
    scheme = "http"
    url = f"{scheme}://127.0.0.1:{port}/uploads/{stored}"
    print(f"[TRAG Service] 图片已上传: {stored} ({len(raw_bytes)} bytes)")
    return {"url": url, "filename": stored, "size": len(raw_bytes)}


@app.get("/uploads/{filename}")
async def serve_upload(filename: str):
    """访问已上传图片（与契约 GET /uploads/{filename} 一致）"""
    if "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _os.path.join(_uploads_dir(), filename)
    if not _os.path.isfile(path):
        raise HTTPException(status_code=404, detail="文件不存在")
    from fastapi.responses import FileResponse
    return FileResponse(path)


def _auto_fill_query(task: str, sample: Dict[str, Any]) -> Optional[str]:
    """模拟前端 autoFillQuery 逻辑，从样本中提取检索内容

    样本字段与前端 TragSearchModal 中 autoFillQuery 对应：
      - text_text:     mediaUrl / ocrContent / asrContent
      - image_image / video_frame: mediaUrl
      - image_ocr / video_ocr:     ocrContent
      - video_asr:     asrContent
      - video_video:   elementFingerprint
    """
    media_url = sample.get("mediaUrl") or sample.get("media_url") or ""
    ocr = sample.get("ocrContent") or sample.get("ocr_content") or ""
    asr = sample.get("asrContent") or sample.get("asr_content") or ""
    fp = sample.get("elementFingerprint") or sample.get("element_fingerprint") or ""

    if task == "text_text":
        return media_url or ocr or asr or None
    elif task in ("image_image", "video_frame"):
        return media_url or None
    elif task in ("image_ocr", "video_ocr"):
        return ocr or None
    elif task == "video_asr":
        return asr or None
    elif task == "video_video":
        return fp or None
    return None


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "trag_api_key_set": bool(TRAG_API_KEY),
        "trag_available": TRAG_AVAILABLE,
    }


@app.on_event("startup")
async def startup_event():
    """启动时初始化缓存表"""
    _ensure_cache_table()
    print(f"[TRAG Service] 启动完成 — TRAG_API_KEY={'已设置' if TRAG_API_KEY else '未设置'}")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("TRAG_PORT", "9100"))
    uvicorn.run(app, host="0.0.0.0", port=port)