/**
 * 服务端日志
 *
 * 特性：
 * - 分级：debug / info / warn / error，各级别可独立开关
 * - 按天分文件：logs/server-YYYY-MM-DD.log
 * - 自动轮转：单个文件超过 maxSize 就切到 .1、.2 …（最多 maxFiles 份）
 * - 自动清理：超过 maxDays 的旧日志文件会被删除
 * - 控制台同步输出：便于 `docker logs` 查看
 * - 容器友好：日志目录可用环境变量覆盖（默认挂载卷即可持久化）
 *
 * 环境变量：
 *   LOG_LEVEL     最低输出级别，默认 info（debug/info/warn/error）
 *   LOG_DIR       日志目录，默认 <项目根>/logs
 *   LOG_MAX_SIZE  单文件大小上限（字节），默认 10MB
 *   LOG_MAX_FILES 每个日期保留的份数，默认 5
 *   LOG_MAX_DAYS  保留天数，默认 7
 *   LOG_CONSOLE   是否同时输出到控制台，默认 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 把 'YYYY-MM-DD' 转成 'YYYYMMDD'（用于文件名排序） */
function compactDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** 本地时区的日期字符串 */
function dateStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * 把任意值转成可读字符串。
 * Error 会带上堆栈，其余对象走 JSON 序列化。
 */
function stringify(value) {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export class Logger {
  constructor(options = {}) {
    this.level = options.level ?? process.env.LOG_LEVEL ?? 'info';
    this.minLevel = LEVELS[this.level] ?? LEVELS.info;
    this.dir = options.dir ?? process.env.LOG_DIR ?? path.join(ROOT, 'logs');
    this.maxSize = options.maxSize ?? Number(process.env.LOG_MAX_SIZE ?? 10 * 1024 * 1024);
    this.maxFiles = options.maxFiles ?? Number(process.env.LOG_MAX_FILES ?? 5);
    this.maxDays = options.maxDays ?? Number(process.env.LOG_MAX_DAYS ?? 7);
    this.console =
      options.console ?? (process.env.LOG_CONSOLE ? process.env.LOG_CONSOLE !== '0' : true);
    this.prefix = options.prefix ?? 'server';
    /** date -> 当前写入的文件路径 */
    this._files = new Map();
    /** 已写入的字节数（按文件路径） */
    this._sizes = new Map();
    this._ensureDir();
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      // 目录创建失败时退回到不写文件，避免影响服务运行
      this._fileError = err;
      console.error('[logger] 无法创建日志目录:', err?.message);
    }
  }

  _fileFor(dateKey) {
    if (this._files.has(dateKey)) return this._files.get(dateKey);
    const file = path.join(this.dir, `${this.prefix}-${dateKey}.log`);
    this._files.set(dateKey, file);
    this._sizes.set(file, this._fileSize(file));
    return file;
  }

  _fileSize(file) {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  }

  /**
   * 轮转：当前文件超过 maxSize 时，把它改名成 .1、.2 …
   */
  _rotate(file) {
    try {
      // 先删掉最老的一份
      const oldest = `${file}.${this.maxFiles}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

      // 依次后移：.N-1 -> .N
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = `${file}.${i}`;
        const to = `${file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      // 当前 -> .1
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
      this._sizes.set(file, 0);
    } catch (err) {
      console.error('[logger] 轮转失败:', err?.message);
    }
  }

  /**
   * 清理过期日志：删除 maxDays 天前的文件，以及超量的轮转文件
   */
  cleanup() {
    try {
      if (!fs.existsSync(this.dir)) return;
      const now = Date.now();
      const cutoff = now - this.maxDays * 24 * 60 * 60 * 1000;
      const names = fs.readdirSync(this.dir);
      let removed = 0;

      for (const name of names) {
        if (!name.startsWith(`${this.prefix}-`)) continue;
        if (!name.endsWith('.log') && !/\.log\.\d+$/.test(name)) continue;

        const file = path.join(this.dir, name);
        try {
          const stat = fs.statSync(file);
          // 主日志文件按文件名里的日期判断过期
          const dateMatch = name.match(/-(\d{4}-\d{2}-\d{2})\.log/);
          if (dateMatch) {
            const day = new Date(`${dateMatch[1]}T00:00:00`);
            if (day.getTime() < cutoff) {
              fs.unlinkSync(file);
              removed++;
              continue;
            }
          }
          // 轮转出来的文件按修改时间判断
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(file);
            removed++;
          }
        } catch {
          /* 单个文件失败不影响其他清理 */
        }
      }
      return removed;
    } catch (err) {
      console.error('[logger] 清理失败:', err?.message);
      return 0;
    }
  }

  /** 写一条日志 */
  write(level, message, meta) {
    const lv = LEVELS[level];
    if (lv === undefined || lv < this.minLevel) return;

    const now = new Date();
    const time = formatTime(now);
    const extra = meta === undefined ? '' : ` ${stringify(meta)}`;
    const line = `[${time}] [${level.toUpperCase().padEnd(5)}] ${stringify(message)}${extra}\n`;

    if (this.console) {
      const stream = lv >= LEVELS.warn ? process.stderr : process.stdout;
      try {
        stream.write(line);
      } catch {
        /* ignore */
      }
    }

    // 写文件
    const dateKey = dateStamp(now);
    const file = this._fileFor(dateKey);
    try {
      const size = (this._sizes.get(file) ?? 0) + Buffer.byteLength(line);
      if (size > this.maxSize) {
        this._rotate(file);
      }
      fs.appendFileSync(file, line, 'utf8');
      this._sizes.set(file, this._fileSize(file));
    } catch (err) {
      // 磁盘满 / 权限问题等：降级为只打控制台，不影响服务
      if (!this._fileError) {
        this._fileError = err;
        console.error('[logger] 写入日志文件失败:', err?.message);
      }
    }
  }

  debug(msg, meta) {
    this.write('debug', msg, meta);
  }
  info(msg, meta) {
    this.write('info', msg, meta);
  }
  warn(msg, meta) {
    this.write('warn', msg, meta);
  }
  error(msg, meta) {
    this.write('error', msg, meta);
  }

  /** 当前日志文件路径（便于在 /api/health 里暴露） */
  currentFile() {
    return this._fileFor(dateStamp());
  }

  /** 日志目录概况 */
  stats() {
    try {
      const files = fs.readdirSync(this.dir).filter((n) => n.startsWith(`${this.prefix}-`));
      let bytes = 0;
      for (const n of files) {
        try {
          bytes += fs.statSync(path.join(this.dir, n)).size;
        } catch {
          /* ignore */
        }
      }
      return { dir: this.dir, files: files.length, bytes, level: this.level };
    } catch {
      return { dir: this.dir, files: 0, bytes: 0, level: this.level };
    }
  }
}

/** 全局单例 */
export const logger = new Logger();

/**
 * 捕获未处理的异常与 Promise 拒绝，写入日志。
 * 不让这些异常静默丢失 —— 它们往往正是线上问题的线索。
 */
export function installGlobalHandlers(log = logger) {
  process.on('uncaughtException', (err) => {
    log.error('未捕获的异常 (uncaughtException)', err);
    // 记录后仍要退出，否则进程状态不可信
    setTimeout(() => process.exit(1), 100).unref();
  });

  process.on('unhandledRejection', (reason) => {
    log.error('未处理的 Promise 拒绝 (unhandledRejection)', reason);
  });

  process.on('warning', (warning) => {
    log.warn(`Node 警告: ${warning.name} ${warning.message}`);
  });
}

export { LEVELS, dateStamp, compactDate, formatTime };
