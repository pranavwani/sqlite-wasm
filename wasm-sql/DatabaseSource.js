import * as VFS from "../wa-sqlite/src/VFS.js";

// This is a stateful source object for a ReadableStream.
export default class DatabaseSource {
  isDone;

  #vfs;
  #path;
  #fileId = Math.floor(Math.random() * 0x100000000);
  #iOffset = 0;
  #bytesRemaining = 0;

  #onDone = [];
  #resolve;
  #reject;

  constructor(vfs, path) {
    this.#vfs = vfs;
    this.#path = path;
    this.isDone = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    }).finally(async () => {
      while (this.#onDone.length) {
        await this.#onDone.pop()();
      }
    });
  }

  async start(controller) {
    try {
      // Open the file for reading.
      const flags = VFS.SQLITE_OPEN_MAIN_DB | VFS.SQLITE_OPEN_READONLY;
      await check(this.#vfs.jOpen(this.#path, this.#fileId, flags, {setInt32(){}}));
      this.#onDone.push(() => this.#vfs.jClose(this.#fileId));
      await check(this.#vfs.jLock(this.#fileId, VFS.SQLITE_LOCK_SHARED));
      this.#onDone.push(() => this.#vfs.jUnlock(this.#fileId, VFS.SQLITE_LOCK_NONE));

      // Get the file size.
      const fileSize = new DataView(new ArrayBuffer(8));
      await check(this.#vfs.jFileSize(this.#fileId, fileSize));
      this.#bytesRemaining = Number(fileSize.getBigUint64(0, true));
    } catch (e) {
      controller.error(e);
      this.#reject(e);
    }
  }

  async pull(controller) {
    try {
      const buffer = new Uint8Array(Math.min(this.#bytesRemaining, 65536));
      await check(this.#vfs.jRead(this.#fileId, buffer, this.#iOffset));
      controller.enqueue(buffer);

      this.#iOffset += buffer.byteLength;
      this.#bytesRemaining -= buffer.byteLength;
      if (this.#bytesRemaining === 0) {
        controller.close();
        this.#resolve();
      }
    } catch (e) {
      controller.error(e);
      this.#reject(e);
    }
  }

  cancel(reason) {
    this.#reject(new Error(reason));
  }
};

async function check(code) {
  if (await code !== VFS.SQLITE_OK) {
    throw new Error(`Error code: ${await code}`);
  }
}