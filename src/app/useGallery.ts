// 画廊服务端分页查询；搜索防抖 200ms，过期响应按纪元丢弃。

import { useCallback, useEffect, useRef, useState } from "react";
import { galleryFacets, galleryQuery } from "../lib/api";
import type {
  GalleryFacets,
  GalleryItem,
  GalleryQuery,
} from "../lib/types";

export const GALLERY_PAGE_SIZE = 120;

export interface GalleryData {
  items: GalleryItem[];
  total: number;
  facets: GalleryFacets;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

const keyWithoutPaging = (q: GalleryQuery, includeSearch: boolean) =>
  JSON.stringify({ ...q, search: includeSearch ? q.search : "", offset: 0, limit: 0 });

export function useGallery(query: GalleryQuery, revision: number): GalleryData {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<GalleryFacets>({ models: [], tags: [] });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [applied, setApplied] = useState(() => keyWithoutPaging(query, true));
  const appliedQuery = useRef(query);
  const epoch = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const totalRef = useRef(total);
  totalRef.current = total;
  const loadingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const lastApplied = useRef(applied);

  // 仅搜索内容变化时延迟应用，其余筛选立即生效并重置分页。
  useEffect(() => {
    const next = keyWithoutPaging(query, true);
    if (next === applied) {
      appliedQuery.current = query;
      return;
    }
    const sameFilters =
      keyWithoutPaging(query, false) ===
      keyWithoutPaging(appliedQuery.current, false);
    if (!sameFilters) {
      appliedQuery.current = query;
      setApplied(next);
      return;
    }
    const timer = setTimeout(() => {
      appliedQuery.current = query;
      setApplied(keyWithoutPaging(appliedQuery.current, true));
    }, 200);
    return () => clearTimeout(timer);
  }, [query, applied]);

  const pageSize = (q: GalleryQuery) =>
    Math.min(Math.max(q.limit || GALLERY_PAGE_SIZE, 1), GALLERY_PAGE_SIZE);

  useEffect(() => {
    const ticket = ++epoch.current;
    const queryChanged = applied !== lastApplied.current;
    lastApplied.current = applied;
    loadingRef.current = true;
    loadingMoreRef.current = false;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    if (queryChanged) {
      setItems([]);
      setTotal(0);
    }
    const q = appliedQuery.current;
    Promise.all([
      galleryQuery({ ...q, offset: 0, limit: pageSize(q) }),
      galleryFacets(),
    ])
      .then(([page, nextFacets]) => {
        if (ticket !== epoch.current) return;
        setItems(page.items);
        setTotal(page.total);
        setFacets(nextFacets);
      })
      .catch((e: unknown) => {
        if (ticket !== epoch.current) return;
        setError(String(e));
      })
      .finally(() => {
        if (ticket !== epoch.current) return;
        loadingRef.current = false;
        setLoading(false);
      });
    return () => {
      if (epoch.current === ticket) epoch.current += 1;
    };
  }, [applied, revision, nonce]);

  const loadMore = useCallback(() => {
    if (
      loadingRef.current ||
      loadingMoreRef.current ||
      itemsRef.current.length >= totalRef.current
    )
      return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const ticket = epoch.current;
    const q = appliedQuery.current;
    galleryQuery({ ...q, offset: itemsRef.current.length, limit: pageSize(q) })
      .then((page) => {
        if (ticket !== epoch.current) return;
        setItems((prev) => {
          const seen = new Set(prev.map((item) => item.id));
          return [
            ...prev,
            ...page.items.filter((item) => !seen.has(item.id)),
          ];
        });
        setTotal(page.total);
      })
      .catch((e: unknown) => {
        if (ticket === epoch.current) setError(String(e));
      })
      .finally(() => {
        if (ticket !== epoch.current) return;
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return {
    items,
    total,
    facets,
    loading,
    loadingMore,
    error,
    hasMore: items.length < total,
    loadMore,
    refresh,
  };
}
