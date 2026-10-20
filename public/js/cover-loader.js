/**
 * 封面渐进加载器
 *
 * 上游 API 配额有限（50 次 / 5 分钟）且单次响应慢（~1s），
 * 不能一次性把所有封面都拉回来，否则会挤占播放地址与歌词的配额，
 * 用户也会等很久才看到第一张图。
 *
 * 做法：
 * - 只加载"可视区域"内的封面（滚动列表时再补）
 * - 限制并发数（默认 3）
 * - 按优先级排序：当前播放 > 可视区域 > 列表其余部分
 * - 服务端对封面请求走低优先级队列，播放/歌词请求可随时插队
 */
export class CoverLoader {
  constructor({ concurrency = 3 } = {}) {
    this.concurrency = concurrency;
    this.queue = [];
    this.active = 0;
    this._timer = null;
  }

  /**
   * @param {HTMLImageElement} img
   * @param {{source:string,pic_id:string,size?:number}} track
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
    const url = `/img/pic?source=${encodeURIComponent(source)}&id=${encodeURIComponent(picId)}&size=${size}`;
    img.dataset.coverState = 'loading';
    img.onerror = () => {
      img.dataset.coverState = 'error';
      if (removeOnError) img.remove();
    };
    img.onload = () => {
      img.dataset.coverState = 'loaded';
    };
    // 浏览器会自动跟随服务端的 302 跳转
    img.src = url;
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
