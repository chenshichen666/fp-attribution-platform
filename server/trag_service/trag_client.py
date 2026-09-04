#!/usr/bin/env python3
"""
TRAG 检索客户端 —— 独立脚本，不依赖项目内其他文件
仅依赖 trag SDK 和 requests（以及标准库）

封装 7 种检索任务的完整流程：
  1. 根据任务类型自动初始化对应的 TRAG collection
  2. 提供统一的检索接口
  3. 支持从命令行 / 交互式 / 代码三种方式调用

依赖:
  pip install trag requests

环境变量:
  TRAG_API_KEY       - TRAG API key（必需）
  TRAG_BASE_URL      - TRAG API 基础地址（可选，默认 http://trag.example.com）
  ELEMENTHUB_BASE    - ElementHub 地址，默认 "https://elementhub.knet.com"
  ELEMENTHUB_TOKEN   - ElementHub token（video_video 指纹模式需要）

用法示例:
  # 命令行
  python trag_client.py search --task text_text --query "棋牌游戏" --limit 5
  python trag_client.py interactive
  python trag_client.py example -t text_text

  # 代码调用
  from trag_client import TRAGClient
  client = TRAGClient(task='text_text')
  results = client.search(doc='棋牌游戏', limit=5)
"""
import os
import sys
import time
import json
import csv
import base64
import struct
import argparse
import datetime
import requests
from typing import Optional, List, Dict, Any, Tuple


# ===== 任务类型元信息 =====
TASK_META = {
    "text_text":   {
        "label": "文本 → 文本",
        "input_type": "text",
        "embedding_model": "bge-large-zh",
        "desc": "用文本查询文本 collection",
        "default_limit": 10,
    },
    "image_image": {
        "label": "图片 → 图片",
        "input_type": "url",
        "embedding_model": "youclip-visual-emb",
        "desc": "用图片 URL 查询图片 collection",
        "default_limit": 10,
    },
    "image_ocr":   {
        "label": "图片 OCR → 文本",
        "input_type": "text",
        "embedding_model": "bge-large-zh",
        "desc": "用文本查询图片 OCR collection",
        "default_limit": 10,
    },
    "video_video": {
        "label": "视频 → 视频",
        "input_type": "fingerprint",
        "embedding_model": "youclip-visual-emb",
        "desc": "输入视频指纹或 base64 向量，检索视频 collection（512 维）",
        "default_limit": 10,
    },
    "video_ocr":   {
        "label": "视频 OCR → 文本",
        "input_type": "text",
        "embedding_model": "bge-large-zh",
        "desc": "用文本查询视频 OCR collection",
        "default_limit": 10,
    },
    "video_asr":   {
        "label": "视频 ASR → 文本",
        "input_type": "text",
        "embedding_model": "bge-large-zh",
        "desc": "用文本查询视频 ASR collection",
        "default_limit": 10,
    },
    "video_frame": {
        "label": "图片 → 视频风险帧",
        "input_type": "url",
        "embedding_model": "youclip-visual-emb",
        "desc": "用风险帧 URL 查询视频风险帧 collection",
        "default_limit": 20,
    },
}

# ElementHub 配置（用于 video_video 指纹模式）
ELEMENTHUB_BASE = os.environ.get("ELEMENTHUB_BASE", "https://elementhub.knet.com")
ELEMENTHUB_TOKEN = os.environ.get("ELEMENTHUB_TOKEN", "")

# TRAG 配置
# 固定 token 与 namespace（可用环境变量覆盖）
TRAG_API_KEY = os.environ.get("TRAG_API_KEY", "062c92b9-f1cf-4056-b510-501bf06edbe2")
TRAG_BASE_URL = os.environ.get("TRAG_BASE_URL", "http://trag.example.com")

# 默认 namespace code（所有任务共用同一个 namespace）
TRAG_NAMESPACE_CODE = os.environ.get("TRAG_NAMESPACE_CODE", "ns-9554285c")

# 检测 trag SDK 是否可用（构建环境可能无内网源，安装失败时 stub 模块会抛 ImportError）
TRAG_AVAILABLE = False
try:
    import trag
    # 排除 Dockerfile 创建的 stub 模块
    if getattr(trag, '__trag_stub__', False):
        TRAG_AVAILABLE = False
        print("[TRAGClient] 警告: 检测到 trag stub 模块（SDK 未真正安装），检索功能将返回 503 降级响应")
    else:
        TRAG_AVAILABLE = True
except ImportError:
    TRAG_AVAILABLE = False
    print("[TRAGClient] 警告: trag SDK 未安装，检索功能将返回 503 降级响应")

# task → 真实 collection code 映射（7 个任务各自独立 collection）
TASK_COLLECTION = {
    "text_text":   "col-6df57a6d",
    "image_image": "col-cfa99956",
    "image_ocr":   "col-56969b4f",
    "video_video": "col-c8b1660a",
    "video_ocr":   "col-b789eb91",
    "video_asr":   "col-e0df54a3",
    "video_frame": "col-b622ef4f",
}


def _build_filter_expr(
    tags: Optional[List[str]] = None,
    first_industries: Optional[List[str]] = None,
    second_industries: Optional[List[str]] = None,
    custom_expr: Optional[str] = None,
) -> Optional[str]:
    """构建 filter_expr，关键字小写，字符串值用双引号

    筛选维度 → 对应字段：
      tags            → policy_list（array）
      first_industries → v6_level_name_1
      second_industries → v6_level_name_2

    不同维度间用 and 连接。
    custom_expr 优先，直接追加到末尾。
    """
    parts = []
    if tags:
        if len(tags) == 1:
            parts.append(f'policy_list = "{tags[0]}"')
        else:
            vals = ", ".join(f'"{t}"' for t in tags)
            parts.append(f'policy_list in ({vals})')
    if first_industries:
        if len(first_industries) == 1:
            parts.append(f'v6_level_name_1 = "{first_industries[0]}"')
        else:
            vals = ", ".join(f'"{v}"' for v in first_industries)
            parts.append(f'v6_level_name_1 in ({vals})')
    if second_industries:
        if len(second_industries) == 1:
            parts.append(f'v6_level_name_2 = "{second_industries[0]}"')
        else:
            vals = ", ".join(f'"{v}"' for v in second_industries)
            parts.append(f'v6_level_name_2 in ({vals})')
    if custom_expr:
        parts.append(custom_expr)
    return " and ".join(parts) if parts else None


def _call_with_retry(fn, *args, max_retries: int = 4, base_delay: float = 0.5, **kwargs):
    """429 限流自动重试：指数退避 0.5s→1s→2s→4s，最多4次

    覆盖 rag.namespace() / ns.collection() / coll.search_documents() 等调用。
    延迟已优化为短间隔，避免用户长时间等待。
    """
    delays = [base_delay * (2 ** i) for i in range(max_retries)]  # 0.5, 1, 2, 4
    last_err = None
    for attempt in range(max_retries + 1):  # 首次 + 4 次重试
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            last_err = e
            err_str = str(e).lower()
            if "429" in err_str or "rate limit" in err_str or "too many" in err_str:
                if attempt < max_retries:
                    wait = delays[attempt]
                    print(f"[TRAGClient] 触发限流(429)，{wait} 秒后进行第 {attempt + 1}/{max_retries} 次重试... (Error code: 429 - {e})")
                    time.sleep(wait)
                    continue
            raise
    raise last_err


def _fetch_video_embedding_by_fingerprint(fingerprint: str) -> Tuple[List[float], str]:
    """通过指纹获取视频 embedding（双通道：ElementHub → TRAG 原生降级）

    优先尝试 ElementHub 获取 embedding；若 ElementHub 不可达，
    自动降级到 TRAG 原生 query_documents(ids=fingerprint, retrieve_vector=True)
    直接从 TRAG collection 中查询文档向量。

    Args:
        fingerprint: 视频指纹（element_fingerprint / MD5 哈希）

    Returns:
        (vector, element_value) — 512 维 float 列表和元素值 URL

    Raises:
        ValueError: 两个通道都失败
    """
    # ---- 通道 1：ElementHub ----
    headers = {}
    if ELEMENTHUB_TOKEN:
        headers["Authorization"] = f"Bearer {ELEMENTHUB_TOKEN}"

    url = f"{ELEMENTHUB_BASE}/api/v1/elements/fingerprint/{fingerprint}/embedding"
    try:
        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        # 兼容多种返回格式
        embedding = data.get("embedding") or data.get("vector") or data.get("data", {}).get("embedding")
        element_value = data.get("element_value") or data.get("url") or data.get("data", {}).get("element_value", "")

        if embedding:
            # 如果返回 base64 字符串，解码为 float 列表
            if isinstance(embedding, str):
                raw = base64.b64decode(embedding)
                float_count = len(raw) // 4
                vector = list(struct.unpack(f"{float_count}f", raw))
            elif isinstance(embedding, list):
                vector = [float(x) for x in embedding]
            else:
                raise ValueError(f"ElementHub 返回的 embedding 格式未知: {type(embedding)}")
            return vector, element_value
    except requests.exceptions.ConnectionError as e:
        print(f"[TRAGClient] ElementHub 不可达（{ELEMENTHUB_BASE}），降级到 TRAG 原生查询: {e}")
    except requests.exceptions.Timeout:
        print(f"[TRAGClient] ElementHub 请求超时，降级到 TRAG 原生查询, fingerprint={fingerprint}")
    except Exception as e:
        print(f"[TRAGClient] ElementHub 异常，降级到 TRAG 原生查询: {e}")

    # ---- 通道 2：TRAG 原生 query_documents 降级 ----
    # video_video collection 中文档 ID = element_fingerprint，可直接用 ids 精确查询
    if not TRAG_AVAILABLE:
        raise ValueError(
            "ElementHub 不可达且 TRAG SDK 未安装，无法获取视频 embedding。"
        )
    try:
        rag = TRAGClient._get_rag()
        if TRAG_NAMESPACE_CODE not in TRAGClient._ns_cache:
            TRAGClient._ns_cache[TRAG_NAMESPACE_CODE] = _call_with_retry(
                rag.namespace, TRAG_NAMESPACE_CODE
            )
        ns = TRAGClient._ns_cache[TRAG_NAMESPACE_CODE]
        coll_code = TASK_COLLECTION["video_video"]
        if coll_code not in TRAGClient._coll_cache:
            TRAGClient._coll_cache[coll_code] = _call_with_retry(ns.collection, coll_code)
        coll = TRAGClient._coll_cache[coll_code]

        # 文档 ID = element_fingerprint，直接用 ids 查询并获取向量
        docs = _call_with_retry(
            coll.query_documents,
            ids=fingerprint,
            retrieve_vector=True,
            limit=1,
        )
        if not docs:
            raise ValueError(
                f"指纹 {fingerprint} 不在 TRAG video_video collection 中"
            )

        doc = docs[0]
        vec = getattr(doc, "vector", None) or getattr(doc, "embedding", None)
        if not vec:
            raise ValueError(f"TRAG query_documents 返回的文档无 vector 字段, fingerprint={fingerprint}")
        vector = [float(x) for x in vec]
        dkv = doc.doc_key_value or {}
        element_value = dkv.get("element_value", "") if isinstance(dkv, dict) else ""
        print(f"[TRAGClient] TRAG 原生降级成功，向量维度={len(vector)}, fingerprint={fingerprint}")
        return vector, element_value
    except Exception as e:
        raise ValueError(
            f"ElementHub 不可达且 TRAG 原生查询也失败，无法获取视频 embedding。"
            f"指纹: {fingerprint}，错误: {e}"
        )


def _decode_base64_vector(b64_str: str) -> List[float]:
    """解码 base64 编码的 float32 向量为 list[float]"""
    raw = base64.b64decode(b64_str)
    float_count = len(raw) // 4
    return list(struct.unpack(f"{float_count}f", raw))


class TRAGClient:
    """
    TRAG 检索客户端 —— 封装 7 种检索任务

    正确的 SDK 调用链：
      TRAG.from_api_key(api_key=...) → rag
      rag.namespace(namespace_code) → namespace
      namespace.collection(collection_code) → collection
      collection.search_documents(doc=..., embedding_model=..., limit=..., filter_expr=...) → List[Document]

    用法:
        client = TRAGClient(task='text_text')
        results = client.search(doc='棋牌游戏', limit=5)
        for r in results:
            print(r['id'], r['score'], r.get('element_value'))

    Namespace 缓存：同一进程内多次创建 TRAGClient 实例时，Namespace 对象会被缓存复用，
    避免重复构造 namespace 触发限流。
    """

    # 类级缓存：namespace 对象 & TRAG 单例 & collection 对象
    _ns_cache: Dict[str, Any] = {}
    _rag_cache: Any = None
    _coll_cache: Dict[str, Any] = {}

    def __init__(self, task: str):
        if task not in TASK_META:
            raise ValueError(
                f"不支持的任务类型: {task}\n"
                f"支持的任务: {', '.join(TASK_META.keys())}"
            )
        self.task = task
        self.meta = TASK_META[task]
        # 用真实 collection code（而非 task 名）
        self.collection_code = TASK_COLLECTION[task]
        self._rag = self._get_rag()
        self._namespace = self._get_namespace()
        self._collection = self._get_collection()

    @classmethod
    def _get_rag(cls):
        """延迟导入并缓存 TRAG 实例（单例）

        兼容 trag SDK 各版本 API：
        - 新版 (>=0.0.50): from trag import TRAG → TRAG.from_api_key(...)
        - 旧版 (<0.0.50):  from trag import TRAGClient → TRAGClient(...)
        - SDK 不可用:       抛出 RuntimeError，由调用方返回 503 降级
        """
        if not TRAG_AVAILABLE:
            raise RuntimeError("trag SDK 未安装，检索服务不可用")
        if cls._rag_cache is None:
            # 优先尝试新版 API
            try:
                from trag import TRAG
                kwargs = {}
                if TRAG_API_KEY:
                    kwargs["api_key"] = TRAG_API_KEY
                if TRAG_BASE_URL:
                    kwargs["base_url"] = TRAG_BASE_URL
                cls._rag_cache = TRAG.from_api_key(**kwargs)
            except ImportError:
                # 回退旧版 API（TRAGClient 直接实例化）
                from trag import TRAGClient as TragSDKClient
                cls._rag_cache = TragSDKClient(
                    api_key=TRAG_API_KEY,
                    base_url=TRAG_BASE_URL or "http://trag.example.com",
                )
        return cls._rag_cache

    def _get_namespace(self):
        """获取或缓存 namespace 对象（用 rag.namespace() 直接构造，避免 describe 限流）"""
        cache_key = TRAG_NAMESPACE_CODE
        if cache_key not in self._ns_cache:
            self._ns_cache[cache_key] = _call_with_retry(
                self._rag.namespace,
                cache_key,
            )
        return self._ns_cache[cache_key]

    def _get_collection(self):
        """获取或缓存 collection 对象（类级缓存，避免重复 API 调用触发限流）"""
        cache_key = self.collection_code
        if cache_key not in self._coll_cache:
            self._coll_cache[cache_key] = _call_with_retry(
                self._namespace.collection,
                self.collection_code,
            )
        return self._coll_cache[cache_key]

    def search(
        self,
        doc: Optional[str] = None,
        vector: Optional[List[float]] = None,
        limit: int = None,
        filter_expr: Optional[str] = None,
        retrieve_vector: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        执行检索（底层调用 collection.search_documents）

        Args:
            doc: 文本/URL 查询内容（用 doc 参数检索）
            vector: 向量查询内容（用 vector 参数检索，优先于 doc）
            limit: 返回数量（默认取 TASK_META 中的 default_limit）
            filter_expr: 自定义过滤表达式
            retrieve_vector: 是否返回文档 vector 字段

        Returns:
            归一化后的结果列表（dict），每条含 id/score/doc/doc_key_value 等字段

        Note:
            vector 和 doc 必须指定一个，同时指定时使用 vector 作检索条件。
        """
        if limit is None:
            limit = self.meta["default_limit"]

        kwargs = {
            "limit": limit,
            "embedding_model": self.meta["embedding_model"],
        }
        if vector is not None:
            kwargs["vector"] = vector
        elif doc is not None:
            kwargs["doc"] = doc
        else:
            raise ValueError("search() 需要至少提供 doc 或 vector 参数")

        if filter_expr:
            kwargs["filter_expr"] = filter_expr
        if retrieve_vector:
            kwargs["retrieve_vector"] = True

        raw_results = _call_with_retry(
            self._collection.search_documents,
            **kwargs,
        )
        return self._normalize_results(raw_results)

    def _normalize_results(self, raw_results) -> List[Dict[str, Any]]:
        """将 SDK 返回的 Document 对象列表归一化为 dict 列表"""
        normalized = []
        if not raw_results:
            return normalized

        for item in raw_results:
            if hasattr(item, "model_dump"):
                entry = item.model_dump(by_alias=False)
            elif hasattr(item, "dict"):
                entry = item.dict()
            elif isinstance(item, dict):
                entry = dict(item)
            else:
                entry = dict(getattr(item, "__dict__", {}))

            entry.setdefault("id", "")
            entry.setdefault("score", 0.0)
            entry.setdefault("doc", "")

            # 从 doc_key_value 提取业务字段
            dkv = entry.get("doc_key_value") or entry.get("docKeyValue") or {}
            if dkv:
                for k, v in dkv.items():
                    entry.setdefault(k, v)

            # 从 doc_fields 数组平铺字段到根级（TRAG SDK 标准字段格式）
            doc_fields = entry.get("doc_fields") or []
            for df in doc_fields:
                name = df.get("name", "")
                value = df.get("value", "")
                if name:
                    entry.setdefault(name, value)

            # 建立字段别名（兼容前端代码，doc_key_value 和 doc_fields 字段名可能不同）
            _alias_map = {
                "v6_first_level_industry_name": "v6_level_name_1",
                "v6_second_level_industry_name": "v6_level_name_2",
                "first_level_industry_name": "level_name_1",
                "second_level_industry_name": "level_name_2",
            }
            for src, dst in _alias_map.items():
                if src in entry and dst not in entry:
                    entry[dst] = entry[src]

            # 兼容字段别名
            entry.setdefault("element_value", dkv.get("element_value", ""))
            entry.setdefault("element_fingerprint", dkv.get("element_fingerprint", ""))
            entry.setdefault("ocr_text", dkv.get("ocr_text", dkv.get("ocr_content", "")))
            entry.setdefault("asr_text", dkv.get("asr_text", dkv.get("asr_content", "")))
            entry.setdefault("policy_list", dkv.get("policy_list", []))
            entry.setdefault("sample_id", dkv.get("sample_id", ""))
            entry.setdefault("cos_url", dkv.get("cos_url", ""))

            try:
                entry["score"] = float(entry["score"])
            except (TypeError, ValueError):
                entry["score"] = 0.0

            normalized.append(entry)
        return normalized


# ===== 高级检索函数 =====

def search_and_save(
    task: str,
    query: str,
    input_mode: str = "auto",
    tags: Optional[List[str]] = None,
    first_industries: Optional[List[str]] = None,
    second_industries: Optional[List[str]] = None,
    filter_expr: Optional[str] = None,
    limit: int = None,
    threshold: float = 0.0,
    group_by_video: bool = False,
    output_format: str = "jsonl",
    output_dir: str = "./outputs/trag_search",
) -> Tuple[List[Dict[str, Any]], str]:
    """一步完成检索 + 筛选 + 阈值过滤 + 保存

    Args:
        task: 任务类型
        query: 查询内容（文本/URL/视频指纹/base64 向量）
        input_mode: 输入模式 auto/fingerprint/base64/text/url
        tags: 违规标签 policy_id 列表
        first_industries: 一级行业列表
        second_industries: 二级行业列表
        filter_expr: 自定义过滤表达式（优先于 tags/industries 自动拼接）
        limit: 返回数量
        threshold: 分数阈值，低于此值的结果会被过滤
        group_by_video: video_frame 任务下按 element_fingerprint 去重
        output_format: jsonl 或 csv
        output_dir: 输出目录

    Returns:
        (results, output_path)
    """
    meta = TASK_META[task]
    if limit is None:
        limit = meta["default_limit"]

    if input_mode == "auto":
        input_mode = meta["input_type"]
        if task == "video_video":
            input_mode = "fingerprint"

    final_filter = _build_filter_expr(tags, first_industries, second_industries, filter_expr)

    client = TRAGClient(task=task)

    search_kwargs = {"limit": limit}
    if final_filter:
        search_kwargs["filter_expr"] = final_filter

    if task == "video_video":
        if input_mode == "fingerprint":
            vector, element_value = _fetch_video_embedding_by_fingerprint(query)
            search_kwargs["vector"] = vector
        elif input_mode == "base64":
            search_kwargs["vector"] = _decode_base64_vector(query)
        else:
            raise ValueError(f"video_video 不支持 input_mode={input_mode}")
    else:
        search_kwargs["doc"] = query

    results = client.search(**search_kwargs)

    if threshold > 0:
        results = [r for r in results if r.get("score", 0) >= threshold]

    if group_by_video and task == "video_frame":
        seen = set()
        deduped = []
        for r in results:
            fp = r.get("element_fingerprint", "")
            if fp and fp in seen:
                continue
            if fp:
                seen.add(fp)
            deduped.append(r)
        results = deduped

    output_path = _save_results(
        results, task, query, final_filter, threshold, group_by_video,
        output_format, output_dir,
    )

    return results, output_path


def _save_results(
    results: List[Dict],
    task: str,
    query: str,
    filter_expr: Optional[str],
    threshold: float,
    group_by_video: bool,
    output_format: str,
    output_dir: str,
) -> str:
    """保存检索结果到文件，返回文件路径

    文件命名: trag_<task>_<YYYYMMDD_HHMMSS>.<ext>
    """
    os.makedirs(output_dir, exist_ok=True)
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    ext = "jsonl" if output_format == "jsonl" else "csv"
    filename = f"trag_{task}_{timestamp}.{ext}"
    filepath = os.path.join(output_dir, filename)
    search_time = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if output_format == "jsonl":
        with open(filepath, "w", encoding="utf-8") as f:
            for i, r in enumerate(results, 1):
                record = {
                    "rank": i,
                    "task": task,
                    "query": query,
                    "filter_expr": filter_expr or "",
                    "threshold": threshold,
                    "group_by_video": group_by_video,
                    "search_time": search_time,
                    "id": r.get("id", ""),
                    "score": r.get("score", 0),
                    "element_value": r.get("element_value", ""),
                    "ocr_text": r.get("ocr_text", ""),
                    "asr_text": r.get("asr_text", ""),
                    "policy_list": r.get("policy_list", []),
                    "sample_id": r.get("sample_id", ""),
                }
                skip_keys = {"rank", "task", "query", "filter_expr", "threshold",
                             "group_by_video", "search_time", "id", "score",
                             "element_value", "ocr_text", "asr_text", "policy_list", "sample_id"}
                for k, v in r.items():
                    if k not in skip_keys and k not in {"vector", "embedding", "docFields", "doc_fields"}:
                        record[k] = v
                f.write(json.dumps(record, ensure_ascii=False) + "\n")

    elif output_format == "csv":
        base_cols = ["rank", "score", "id", "sample_id"]
        task_default_fields = {
            "text_text": ["doc"],
            "image_image": ["element_value"],
            "image_ocr": ["ocr_text", "element_value"],
            "video_video": ["element_value", "element_fingerprint"],
            "video_ocr": ["ocr_text", "element_value"],
            "video_asr": ["asr_text", "element_value"],
            "video_frame": ["frame_element_value", "frame_time", "element_fingerprint"],
        }
        default_fields = task_default_fields.get(task, [])
        common_fields = ["policy_list", "v6_level_name_1", "v6_level_name_2", "cos_url", "fine_data_result"]
        skip_keys = {"vector", "embedding", "docFields", "doc_fields", "docKeyValue", "doc_key_value"}

        all_keys = set()
        for r in results:
            for k in r.keys():
                if k not in skip_keys and k not in base_cols + default_fields + common_fields:
                    all_keys.add(k)

        all_cols = base_cols + default_fields + common_fields + sorted(all_keys)

        with open(filepath, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=all_cols, extrasaction="ignore")
            writer.writeheader()
            for i, r in enumerate(results, 1):
                row = {"rank": i}
                for col in all_cols:
                    if col == "rank":
                        continue
                    val = r.get(col, "")
                    if isinstance(val, (dict, list)):
                        val = json.dumps(val, ensure_ascii=False)
                    if col == "score":
                        try:
                            val = f"{float(val):.6f}"
                        except (TypeError, ValueError):
                            pass
                    row[col] = val
                writer.writerow(row)

    else:
        raise ValueError(f"不支持的输出格式: {output_format}")

    return filepath


# ===== CLI 工具函数 =====

def _format_result_terminal(r: Dict, idx: int, verbose: bool = False) -> str:
    """格式化单条结果用于终端输出"""
    score = r.get("score", 0)
    rid = r.get("id", "")
    element_value = r.get("element_value", "")
    ocr = r.get("ocr_text", "")
    asr = r.get("asr_text", "")
    policies = r.get("policy_list", [])
    sample_id = r.get("sample_id", "")
    fp = r.get("element_fingerprint", "")
    doc = r.get("doc", "")

    lines = [f"  [{idx}] score={score:.4f}  id={rid}"]
    if sample_id:
        lines.append(f"      sample_id:  {sample_id}")
    if element_value:
        ev_short = element_value[:120] + "..." if len(element_value) > 120 else element_value
        lines.append(f"      url:        {ev_short}")
    if doc and doc != element_value:
        doc_short = doc[:120] + "..." if len(doc) > 120 else doc
        lines.append(f"      doc:        {doc_short}")
    if ocr:
        ocr_short = ocr[:120] + "..." if len(ocr) > 120 else ocr
        lines.append(f"      ocr:        {ocr_short}")
    if asr:
        asr_short = asr[:120] + "..." if len(asr) > 120 else asr
        lines.append(f"      asr:        {asr_short}")
    if policies:
        lines.append(f"      policies:   {policies}")
    if fp:
        lines.append(f"      fingerprint: {fp}")
    if verbose:
        skip = {"score", "id", "element_value", "ocr_text", "asr_text",
                "policy_list", "sample_id", "element_fingerprint", "doc"}
        extra = {k: v for k, v in r.items() if k not in skip and k not in {"vector", "embedding"}}
        if extra:
            lines.append(f"      extra:      {json.dumps(extra, ensure_ascii=False)[:300]}")
    return "\n".join(lines)


# ===== CLI 模式 1: search =====

def run_search(args):
    """命令行 search 模式"""
    meta = TASK_META[args.task]
    print(f"\n[TRAGClient] 任务: {args.task}  ({meta['label']})")
    print(f"[TRAGClient] 描述: {meta['desc']}")

    if args.query_file:
        with open(args.query_file, "r", encoding="utf-8") as f:
            query = f.read().strip()
        print(f"[TRAGClient] 从文件读取查询内容: {args.query_file}")
    else:
        query = args.query

    if not query:
        print("[TRAGClient] 错误: 未提供查询内容（--query 或 --query-file）")
        sys.exit(1)

    tags = [t.strip() for t in args.tags.split(",")] if args.tags else None
    first_ind = [t.strip() for t in args.first_industries.split(",")] if args.first_industries else None
    second_ind = [t.strip() for t in args.second_industries.split(",")] if args.second_industries else None

    results, output_path = search_and_save(
        task=args.task,
        query=query,
        input_mode=args.input_mode,
        tags=tags,
        first_industries=first_ind,
        second_industries=second_ind,
        filter_expr=args.filter_expr,
        limit=args.limit,
        threshold=args.threshold,
        group_by_video=args.group_by_video,
        output_format=args.output_format,
        output_dir=args.output_dir,
    )

    print(f"\n[TRAGClient] 检索完成，共 {len(results)} 条结果\n")
    for i, r in enumerate(results, 1):
        print(_format_result_terminal(r, i, verbose=args.verbose))
        print()

    print(f"[TRAGClient] 结果已保存至: {output_path}")


# ===== CLI 模式 2: interactive =====

def run_interactive():
    """交互式模式（8 步引导）"""
    print("\n" + "=" * 60)
    print("  TRAG 检索客户端 — 交互模式")
    print("=" * 60)

    print(f"\n【1/8】选择任务类型：")
    task_keys = list(TASK_META.keys())
    for i, k in enumerate(task_keys, 1):
        v = TASK_META[k]
        emb = v.get("embedding_model", "")
        print(f"  {i}. {k}")
        print(f"     {v['label']} · 输入: {v['input_type']} · {v['desc']}（{emb} 嵌入）")

    while True:
        choice = input("\n请输入编号 (1-7): ").strip()
        try:
            task = task_keys[int(choice) - 1]
            break
        except (ValueError, IndexError):
            print(f"  ✗ 无效编号，请输入 1-{len(task_keys)}")

    meta = TASK_META[task]
    print(f"\n>> 已选择: {task} ({meta['label']})")

    print(f"\n【2/8】输入查询内容")
    input_mode = "auto"
    if task == "video_video":
        print("  video_video 支持两种输入模式：")
        print("    1. 视频指纹（element_fingerprint，自动从 ElementHub 获取 embedding）")
        print("    2. base64 向量（base64 编码的 float32 向量，直接解码检索）")
        mode_choice = input("  请选择输入模式 (1/2, 默认 1): ").strip()
        if mode_choice == "2":
            input_mode = "base64"
            print("  >> 已选择 base64 向量模式")
        else:
            input_mode = "fingerprint"
            print("  >> 已选择视频指纹模式")
            print(f"  提示: 输入视频指纹，例如：a2e9114b04e7dc66c5dd6e3dab995bc4")
    else:
        type_hint = "文本" if meta["input_type"] == "text" else "URL"
        print(f"  输入{type_hint}内容")

    query = input("  查询内容: ").strip()
    if not query:
        print("  ✗ 查询内容不能为空")
        sys.exit(1)

    print(f"\n【3/8】违规标签筛选（policy_id）")
    print("  输入 policy_id，多个用逗号分隔，如: 14749,14750")
    print("  直接回车跳过")
    tags_str = input("  policy_id: ").strip()
    tags = [t.strip() for t in tags_str.split(",")] if tags_str else None

    print(f"\n【4/8】一级行业筛选")
    print("  多个用逗号分隔，如: 电商服务,游戏")
    print("  直接回车跳过")
    l1_str = input("  一级行业: ").strip()
    first_industries = [t.strip() for t in l1_str.split(",")] if l1_str else None

    print(f"\n【5/8】二级行业筛选")
    print("  多个用逗号分隔，如: 综合电商,服饰鞋包")
    print("  直接回车跳过")
    l2_str = input("  二级行业: ").strip()
    second_industries = [t.strip() for t in l2_str.split(",")] if l2_str else None

    default_limit = meta["default_limit"]
    print(f"\n【6/8】返回数量（默认 {default_limit}）")
    limit_str = input(f"  数量 (1-500, 默认 {default_limit}): ").strip()
    try:
        limit = int(limit_str) if limit_str else default_limit
        limit = max(1, min(500, limit))
    except ValueError:
        limit = default_limit

    print(f"\n【7/8】分数阈值（0~1，低于此值的结果会被过滤）")
    threshold_str = input("  阈值 (默认 0，不过滤): ").strip()
    try:
        threshold = float(threshold_str) if threshold_str else 0.0
    except ValueError:
        threshold = 0.0

    print(f"\n【8/8】选择输出格式")
    print("  1. jsonl（每行一条 JSON，含元信息）")
    print("  2. csv（表格格式，兼容 Excel）")
    fmt_choice = input("  格式 (1/2, 默认 1): ").strip()
    output_format = "csv" if fmt_choice == "2" else "jsonl"

    output_dir = input(f"  输出目录 (默认 ./outputs/trag_search): ").strip()
    if not output_dir:
        output_dir = "./outputs/trag_search"

    print("\n" + "─" * 60)
    print(f"  任务:       {task}")
    print(f"  输入模式:   {input_mode}")
    print(f"  查询:       {query[:80]}{'...' if len(query) > 80 else ''}")
    print(f"  标签:       {tags}")
    print(f"  一级行业:   {first_industries}")
    print(f"  二级行业:   {second_industries}")
    print(f"  返回数量:   {limit}")
    print(f"  阈值:       {threshold}")
    print(f"  输出格式:   {output_format}")
    print(f"  输出目录:   {output_dir}")
    print("─" * 60)

    confirm = input("\n确认执行检索？(Y/n): ").strip().lower()
    if confirm == "n":
        print("[TRAGClient] 已取消")
        return

    print(f"\n[TRAGClient] 正在检索...")
    try:
        group_by_video = task == "video_frame"
        results, output_path = search_and_save(
            task=task,
            query=query,
            input_mode=input_mode,
            tags=tags,
            first_industries=first_industries,
            second_industries=second_industries,
            limit=limit,
            threshold=threshold,
            group_by_video=group_by_video,
            output_format=output_format,
            output_dir=output_dir,
        )

        print(f"\n[TRAGClient] 检索完成，共 {len(results)} 条结果\n")
        for i, r in enumerate(results, 1):
            print(_format_result_terminal(r, i))
            print()

        print(f"[TRAGClient] 结果已保存至: {output_path}")
    except Exception as e:
        print(f"\n[TRAGClient] 检索失败: {e}")


# ===== CLI 模式 3: example =====

EXAMPLES = {
    "text_text":   "请勿使用未经授权的第三方品牌信息",
    "image_image": "https://static.example.com/location/prod/example.jpeg",
    "image_ocr":   "请勿使用未经授权的第三方品牌信息",
    "video_video": "a2e9114b04e7dc66c5dd6e3dab995bc4",
    "video_ocr":   "请勿使用未经授权的第三方品牌信息",
    "video_asr":   "请勿使用未经授权的第三方品牌信息",
    "video_frame": "https://static.example.com/location/prod/1842ae2b4b3b33c45d39dc1b3c271489.jpeg",
}


def run_example(args):
    """快速示例模式，验证 SDK 连通性"""
    task = args.task or "video_asr"
    query = EXAMPLES.get(task, "测试查询")

    meta = TASK_META[task]
    print(f"\n[TRAGClient] 示例模式 — {task} ({meta['label']})")
    print(f"[TRAGClient] 查询内容: {query}")
    print(f"[TRAGClient] 正在检索...")

    try:
        results, output_path = search_and_save(
            task=task,
            query=query,
            limit=3,
            output_format="jsonl",
            output_dir="./outputs/trag_example",
        )

        print(f"\n[TRAGClient] 检索完成，共 {len(results)} 条结果\n")
        for i, r in enumerate(results, 1):
            print(_format_result_terminal(r, i))
            print()

        print(f"[TRAGClient] 结果已保存至: {output_path}")
    except Exception as e:
        print(f"\n[TRAGClient] 检索失败: {e}")
        import traceback
        traceback.print_exc()


# ===== 主入口 =====

def main():
    parser = argparse.ArgumentParser(
        description="TRAG 检索客户端 — 支持 7 种检索任务，3 种运行模式",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # search 模式 — 基础文本检索
  python trag_client.py search --task text_text --query "请勿使用未经授权的第三方品牌信息" --limit 10

  # search 模式 — 带筛选条件的视频 OCR 检索
  python trag_client.py search --task video_ocr --query "限时折扣" --tags 14749,14750 --output-format csv

  # search 模式 — 视频指纹检索
  python trag_client.py search --task video_video --query a2e9114b04e7dc66c5dd6e3dab995bc4

  # interactive 模式
  python trag_client.py interactive

  # example 模式 — 验证 SDK 连通性
  python trag_client.py example -t text_text
""",
    )
    subparsers = parser.add_subparsers(dest="mode", help="运行模式")

    p_search = subparsers.add_parser("search", help="脚本化批量检索，命令行传入所有参数")
    p_search.add_argument("--task", required=True, choices=list(TASK_META.keys()), help="任务类型")
    q_group = p_search.add_mutually_exclusive_group(required=True)
    q_group.add_argument("--query", help="查询内容（文本 / URL / 视频指纹 / base64 向量）")
    q_group.add_argument("--query-file", help="从文件读取查询内容（与 --query 二选一）")
    p_search.add_argument("--input-mode", default="auto", choices=["auto", "fingerprint", "base64", "text", "url"], help="输入模式 (默认 auto)")
    p_search.add_argument("--tags", help="违规标签 policy_id，逗号分隔")
    p_search.add_argument("--first-industries", help="一级行业，逗号分隔")
    p_search.add_argument("--second-industries", help="二级行业，逗号分隔")
    p_search.add_argument("--filter-expr", help="直接传入 filter_expr（优先于 tags/industries 自动拼接）")
    p_search.add_argument("--limit", type=int, default=None, help="返回数量，范围 1~500（默认取任务默认值）")
    p_search.add_argument("--threshold", type=float, default=0.0, help="分数阈值，低于此值的结果会被过滤")
    p_search.add_argument("--group-by-video", action="store_true", help="video_frame 任务下按 element_fingerprint 去重")
    p_search.add_argument("--output-format", default="jsonl", choices=["jsonl", "csv"], help="输出格式 (默认 jsonl)")
    p_search.add_argument("--output-dir", default="./outputs/trag_search", help="输出目录")
    p_search.add_argument("--verbose", "-v", action="store_true", help="显示详细信息")

    subparsers.add_parser("interactive", help="引导式输入，最贴近网页端体验")

    p_example = subparsers.add_parser("example", help="快速示例，验证 SDK 连通性")
    p_example.add_argument("-t", "--task", default="video_asr", choices=list(TASK_META.keys()), help="任务类型 (默认 video_asr)")

    args = parser.parse_args()

    if not TRAG_API_KEY:
        print("[警告] 未设置 TRAG_API_KEY 环境变量，SDK 可能无法初始化")
        print("       请设置: export TRAG_API_KEY=your_key_here")
        print("       获取地址: https://trag.example.com/#/instance/list\n")

    if args.mode == "search":
        run_search(args)
    elif args.mode == "interactive":
        run_interactive()
    elif args.mode == "example":
        run_example(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()