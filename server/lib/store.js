/**
 * 简单的 JSON 持久化存储（原子写入 + 内存缓存 + 写入串行化）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

export class JsonStore {
  /**
   * @param {string} file 目标文件
   * @param {any} fallback 文件不存在时的默认值
   */
  constructor(file, fallback) {
    this.file = file;
    this.fallback = fallback;
    this.data = null;
    this._writing = Promise.resolve();
    this._dirty = false;
  }

  async load() {
    if (this.data !== null) return this.data;
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      this.data = JSON.parse(text);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[store] 读取 ${this.file} 失败，使用默认值: ${err.message}`);
      }
      this.data = structuredClone(this.fallback);
    }
    return this.data;
  }

  /** 立即持久化当前数据 */
  async save() {
    const run = async () => {
      const dir = path.dirname(this.file);
      await fsp.mkdir(dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      await fsp.rename(tmp, this.file);
    };
    this._writing = this._writing.then(run, run);
    await this._writing;
    this._dirty = false;
  }

  /** 就地修改并保存 */
  async update(mutator) {
    await this.load();
    const result = await mutator(this.data);
    await this.save();
    return result;
  }

  /** 重新从磁盘载入 */
  async reload() {
    this.data = null;
    return this.load();
  }
}
