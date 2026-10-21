/**
 * 封面渐进加载器
 *
 * 封面地址由浏览器直连 GD 音乐台获取（`gd-api.js`），
 * 图片本身再从上游 CDN 直接加载，全过程不经过我们的服务端。
 *
 * 之所以要渐进加载：
 * 上游有 50 次 / 5 分钟的配额，且单次响应约 1.3 秒。
 * 一次性把 30 张封面全拉回来，既慢又会挤占播放地址与歌词的配额。
 *
 * 做法：
 * - 只加载"可视区域"内的封面（滚动列表时再补）
 * - 限制并发数
 * - 按优先级排序：当前播放 > 可视区域 > 列表其余部分
 */
import { gdApi } from './gd-api.js';

export class CoverLoader {
  constructor({ concurrency = 3 } = {}) {
    this.concurrency = concurrency;
    this.queue = [];
    this.active = 0;
    this._timer = null;
  }

  /**
   * @param {HTMLImageElement} img
   * @param {{source:string,pic_id:string}} track
   * @param {number} priority 数字越小越优先
   * @param {{removeOnError?:boolean}} opts
   */
  push(img, track, priority = 10, opts = {}) {
    if (!img || !track?.pic_id) return;
    if (img.dataset.coverState) return; // 已在队列或已加载
    img.dataset.coverState = 'queued';
    this.queue.push({ img, track, priority, removeOnError: opts.removeOnError !== false });
    this.queue.sort((a, b) => a.priority - b.priority);
    this._schedule();
  }

  _schedule() {
    if (this._timer) return;
    // 让出一帧，避免与播放/歌词请求争抢
    this._timer = setTimeout(() => {
      this._timer = null;
      this._drain();
    }, 100);
  }

  _drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const task = this.queue.shift();
      this.active++;
      this._load(task).finally(() => {
        this.active--;
        if (this.queue.length) this._schedule();
      });
    }
  }

  async _load({ img, track, removeOnError }) {
    const { source, pic_id: picId } = track;
    const size = track.size || 300;
    img.dataset.coverState = 'loading';
    img.onerror = () => {
      img.dataset.coverState = 'error';
      if (removeOnError) img.remove();
    };
    img.onload = () => {
      img.dataset.coverState = 'loaded';
    };
    try {
      // 浏览器直连上游取封面地址
      const { url } = await gdApi.getTrackPic({ source, id: picId, size });
      if (!url) throw new Error('no cover');
      img.src = url;
    } catch {
      img.dataset.coverState = 'error';
      if (removeOnError) img.remove();
    }
  }
}

/**
 * 判断元素是否在容器可视区域内。
 * 用 getBoundingClientRect 而不是 IntersectionObserver，
 * 因为后台标签页中 IntersectionObserver 回调可能不触发。
 */
export function isVisible(el, container, margin = 120) {
  if (!el || !container) return false;
  const r = el.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  return r.bottom >= c.top - margin && r.top <= c.bottom + margin;
}

export const coverLoader = new CoverLoader({ concurrency: 3 });
