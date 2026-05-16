/**
 * Virtual File System (VFS) with Bash-like Commands
 *
 * This script implements a simple key-value store using IndexedDB, which is a low-level API
 * for client-side storage of significant amounts of structured data, including files/blobs.
 * This API uses indexes to enable high-performance searches of this data.
 *
 * The VFS provides a set of methods for storing, retrieving, and deleting key-value pairs in an
 * IndexedDB object store, where keys represent paths in a file system-like structure.
 * Paths are delimited by a slash (/) and must start with a leading slash.
 * Paths ending with a slash are considered directories, while paths not ending with a slash are considered files.
 *
 * The VFS includes Bash-like commands for manipulating the virtual file system.
 *
 * Await window.vfsReady to initialize the VFS and expose it as window.vfs.
 */

let vfsReadyPromise;
Object.defineProperty(window, 'vfsReady', {
  get() {
    if (!vfsReadyPromise) vfsReadyPromise = initializeVfs();
    return vfsReadyPromise;
  }
});

async function initializeVfs() {
  try {
    if (window.susi?.files) {
      window.vfs = await createProjectVfs(window.susi.files);
      return window.vfs;
    }
    const db = await new Promise((resolve, reject) => {
      const request = window.indexedDB.open('vfs', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('keyValueStore')) {
          db.createObjectStore('keyValueStore', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    window.vfs = createIndexedVfs(db);
  } catch (error) {
    if (window.susi?.files || window.location.protocol !== 'file:') {
      vfsReadyPromise = undefined;
      throw error;
    }
    console.warn('Unable to open IndexedDB for this local file. Using temporary storage.', error);
    window.vfs = createMemoryVfs();
  }
  return window.vfs;
}

function createIndexedVfs(db) {
  return {
    put: function (key, value) {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['keyValueStore'], 'readwrite');
        const store = transaction.objectStore('keyValueStore');
        const putRequest = store.put({ id: key, value });

        // Handle the successful storage of a key-value pair
        putRequest.onsuccess = function (event) {
          console.log('Key-value pair stored successfully.');
          resolve();
        };
        // Handle errors
        putRequest.onerror = function (event) {
          console.error('Error storing key-value pair:', event.target.errorCode);
          reject(event.target.errorCode);
        };
      });
    },
    getasync: function (key) {
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(['keyValueStore'], 'readonly');
        const store = transaction.objectStore('keyValueStore');
        const getRequest = store.get(key);
        getRequest.onsuccess = function (event) {
          // Check if the key exists before resolving the promise
          if (event.target.result) {
            resolve(event.target.result.value);
          } else {
            reject('Key not found');
          }
        };
        getRequest.onerror = function (event) {
          reject(event.target.errorCode);
        };
      });
    },
    get: async function (key) {
      return await this.getasync(key);
    },
    rm: function (key) {
      const transaction = db.transaction(['keyValueStore'], 'readwrite');
      const store = transaction.objectStore('keyValueStore');
      const deleteRequest = store.delete(key);
      deleteRequest.onsuccess = function (event) {
        console.log('Entry removed successfully.');
      };
      deleteRequest.onerror = function (event) {
        console.error('Error removing entry:', event.target.errorCode);
      };
    },

    // the following methods all consider that keys are paths and have their proper shape:
    // - a path must have a leading slash
    // - a path ending with a slash is considered a directory
    // - a path not ending with a slash is considered a file
    // - directories cannot be created or removed directly,
    // - creating a file creates also the parent directory, removing all files removes the directory.
    touch: function (path) {
      // Create a file at the specified path.
      if (!path.startsWith('/') || path === '') {
        throw new Error('Invalid path');
      }
      const dirPath = path.substring(0, path.lastIndexOf('/')) + '/';
      const fileName = path.substring(path.lastIndexOf('/') + 1);
      const transaction = db.transaction(['keyValueStore'], 'readwrite');
      const store = transaction.objectStore('keyValueStore');
      const putRequest = store.put({ id: path, value: '' });
      putRequest.onsuccess = function (event) {
        console.log(`File created at ${path}`);
      };
      putRequest.onerror = function (event) {
        console.error(`Error creating file at ${path}: ${event.target.errorCode}`);
      };
    },
    rm: function (path) {
      // Remove a file or directory at the specified path.
      if (!path.startsWith('/') || path === '') {
        throw new Error('Invalid path');
      }
      const transaction = db.transaction(['keyValueStore'], 'readwrite');
      const store = transaction.objectStore('keyValueStore');
      const deleteRequest = store.delete(path);
      deleteRequest.onsuccess = function (event) {
        console.log(`Entry removed at ${path}`);
      };
      deleteRequest.onerror = function (event) {
        console.error(`Error removing entry at ${path}: ${event.target.errorCode}`);
      };
    },
    cp: function (srcPath, destPath) {
      // Copy a file or directory from one path to another.
      if (!srcPath.startsWith('/') || !destPath.startsWith('/') || srcPath === '' || destPath === '') {
        throw new Error('Invalid path');
      }
      const transaction = db.transaction(['keyValueStore'], 'readwrite');
      const store = transaction.objectStore('keyValueStore');
      const getRequest = store.get(srcPath);
      getRequest.onsuccess = function (event) {
        const value = event.target.result ? event.target.result.value : {};
        const putRequest = store.put({ id: destPath, value });
        putRequest.onsuccess = function (event) {
          console.log(`Entry copied from ${srcPath} to ${destPath}`);
        };
        putRequest.onerror = function (event) {
          console.error(`Error copying entry from ${srcPath} to ${destPath}: ${event.target.errorCode}`);
        };
      };
      getRequest.onerror = function (event) {
        console.error(`Error getting entry at ${srcPath}: ${event.target.errorCode}`);
      };
    },
    mv: function (srcPath, destPath) {
      // Move or rename a file or directory from one path to another.
      if (!srcPath.startsWith('/') || !destPath.startsWith('/') || srcPath === '' || destPath === '') {
        throw new Error('Invalid path');
      }
      const transaction = db.transaction(['keyValueStore'], 'readwrite');
      const store = transaction.objectStore('keyValueStore');
      const getRequest = store.get(srcPath);
      getRequest.onsuccess = function (event) {
        const value = event.target.result ? event.target.result.value : {};
        const deleteRequest = store.delete(srcPath);
        deleteRequest.onsuccess = function (event) {
          const putRequest = store.put({ id: destPath, value });
          putRequest.onsuccess = function (event) {
            console.log(`Entry moved from ${srcPath} to ${destPath}`);
          };
          putRequest.onerror = function (event) {
            console.error(`Error moving entry from ${srcPath} to ${destPath}: ${event.target.errorCode}`);
          };
        };
        deleteRequest.onerror = function (event) {
          console.error(`Error deleting entry at ${srcPath}: ${event.target.errorCode}`);
        };
      };
      getRequest.onerror = function (event) {
        console.error(`Error getting entry at ${srcPath}: ${event.target.errorCode}`);
      };
    },
    ls: function (path) {
      // List the contents of a directory at the specified path.
      if (!path.endsWith('/')) {
        throw new Error('Invalid directory path');
      }
      const transaction = db.transaction(['keyValueStore'], 'readonly');
      const store = transaction.objectStore('keyValueStore');
      const cursorRange = path === '/' ? IDBKeyRange.lowerBound(path) : IDBKeyRange.bound(path, path.substring(0, path.length - 1) + '\uffff', false, true);
    
      return new Promise((resolve, reject) => {
        const cursorRequest = store.openCursor(cursorRange);
        const contents = [];
        cursorRequest.onsuccess = function (event) {
          const cursor = event.target.result;
          if (cursor) {
            if (cursor.key.startsWith(path)) {
              contents.push(cursor.key.substring(path.length));
            }
            cursor.continue();
          } else {
            resolve(contents);
          }
        };
        cursorRequest.onerror = function (event) {
          reject(`Error listing directory at ${path}: ${event.target.errorCode}`);
        };
      });
    },    
    cat: function (path) {
      // Display the contents of a file at the specified path.
      if (path.endsWith('/')) {
        throw new Error('Invalid file path');
      }
      const transaction = db.transaction(['keyValueStore'], 'readonly');
      const store = transaction.objectStore('keyValueStore');
      const getRequest = store.get(path);
      getRequest.onsuccess = function (event) {
        console.log(event.target.result ? event.target.result.value : '');
      };
      getRequest.onerror = function (event) {
        console.error(`Error getting file at ${path}: ${event.target.errorCode}`);
      };
    },
    find: function (pattern) {
      // Search for files or directories matching a specified pattern.
      const transaction = db.transaction(['keyValueStore'], 'readonly');
      const store = transaction.objectStore('keyValueStore');
      const cursorRequest = store.openCursor();
      const matches = [];
      cursorRequest.onsuccess = function (event) {
        const cursor = event.target.result;
        if (cursor) {
          if (new RegExp(pattern).test(cursor.key)) {
            matches.push(cursor.key);
          }
          cursor.continue();
        } else {
          console.log(matches.join('\n'));
        }
      };
      cursorRequest.onerror = function (event) {
        console.error(`Error finding pattern ${pattern}: ${event.target.errorCode}`);
      };
    },

    du: function () {
      // Show the disk usage of files and directories.
      const transaction = db.transaction(['keyValueStore'], 'readonly');
      const store = transaction.objectStore('keyValueStore');
      let totalSize = 0;

      return new Promise((resolve, reject) => {
        const cursorRequest = store.openCursor();
        cursorRequest.onsuccess = function (event) {
          const cursor = event.target.result;
          if (cursor) {
            const keyLength = cursor.key ? cursor.key.length : 0;
            const valueLength = cursor.value ? cursor.value.length : 0;
            if (!isNaN(keyLength) && !isNaN(valueLength)) {
              totalSize += keyLength + valueLength;
            }
            cursor.continue();
          } else {
            resolve(totalSize);
          }
        };
        cursorRequest.onerror = function (event) {
          reject(`Error getting disk usage: ${event.target.errorCode}`);
        };
      });
    },
    df: function () {
      // Show the amount of disk space used and available on the file system.
      if (navigator.storage && navigator.storage.estimate) {
        return navigator.storage.estimate().then((estimate) => {
          const quota = Number.isFinite(estimate.quota) ? estimate.quota : 0;
          const usage = Number.isFinite(estimate.usage) ? estimate.usage : 0;
          const available = Math.max(0, quota - usage);
          return { quota, usage, available };
        });
      }
      return Promise.reject('Storage estimate not available');
    },
    grep: function (path, pattern) {
      // Search for a pattern in file content at the specified path.
      if (!path.startsWith('/') || path === '') {
        throw new Error('Invalid path');
      }
      const transaction = db.transaction(['keyValueStore'], 'readonly');
      const store = transaction.objectStore('keyValueStore');
      const getRequest = store.get(path);
      getRequest.onsuccess = function (event) {
        const content = event.target.result ? event.target.result.value : '';
        if (new RegExp(pattern).test(content)) {
          console.log(`${path}: ${content}`);
        }
      };
      getRequest.onerror = function (event) {
        console.error(`Error getting file at ${path}: ${event.target.errorCode}`);
      };
    }
  };
}

async function createProjectVfs(projectFiles) {
  const path = '.chat-terminal-vfs.json';
  async function load() {
    const file = await projectFiles.readFile(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const files = new Map();
    if (file) {
      for (const [key, entry] of JSON.parse(await file.text())) {
        if (entry.bytes === undefined) {
          files.set(key, entry.value);
          continue;
        }
        const bytes = Uint8Array.from(atob(entry.bytes), char => char.charCodeAt(0));
        files.set(key, entry.type === undefined ? bytes.buffer : new Blob([bytes], { type: entry.type }));
      }
    }
    return { file, files };
  }

  async function save({ file, files }, change) {
    change(files);
    const entries = [];
    for (const [key, value] of files) {
      const blob = value instanceof Blob;
      const bytes = blob ? new Uint8Array(await value.arrayBuffer())
        : value instanceof ArrayBuffer ? new Uint8Array(value)
        : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : null;
      if (bytes === null) {
        entries.push([key, { value }]);
        continue;
      }
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      entries.push([key, { bytes: btoa(binary), type: blob ? value.type : undefined }]);
    }
    await projectFiles.writeFile(path, JSON.stringify(entries), { ifUnchanged: file });
    return files;
  }

  return createMemoryVfs((await load()).files, async change => {
    const before = await load();
    try {
      return await save(before, change);
    } catch (error) {
      // A second preview may have saved while this one was writing. Reapply the change once.
      const latest = await load();
      if (latest.file?.lastModified === before.file?.lastModified) throw error;
      return save(latest, change);
    }
  });
}

function createMemoryVfs(files = new Map(), persist) {
  let pending = Promise.resolve();
  const read = action => persist ? pending.then(() => action(files)) : action(files);
  const update = change => {
    if (!persist) {
      change(files);
      return;
    }
    const write = pending.then(async () => { files = await persist(change); });
    // Older shell commands can schedule a write without awaiting it. Keep later operations ordered.
    pending = write.catch(error => console.error('Unable to save terminal files:', error));
    return write;
  };
  const get = async (key) => {
    return read(current => {
      if (!current.has(key)) throw 'Key not found';
      return structuredClone(current.get(key));
    });
  };
  const validatePath = (path) => {
    if (!path.startsWith('/')) throw new Error('Invalid path');
  };

  return {
    persistent: Boolean(persist),
    put(key, value) {
      const copy = structuredClone(value);
      return update(current => current.set(key, copy)) ?? Promise.resolve();
    },
    getasync: get,
    get,
    touch(path) {
      validatePath(path);
      return update(current => current.set(path, ''));
    },
    rm(path) {
      validatePath(path);
      return update(current => current.delete(path));
    },
    cp(srcPath, destPath) {
      validatePath(srcPath);
      validatePath(destPath);
      return update(current => current.set(destPath, current.has(srcPath) ? structuredClone(current.get(srcPath)) : {}));
    },
    mv(srcPath, destPath) {
      validatePath(srcPath);
      validatePath(destPath);
      return update(current => {
        const value = current.has(srcPath) ? current.get(srcPath) : {};
        current.delete(srcPath);
        current.set(destPath, value);
      });
    },
    async ls(path) {
      if (!path.endsWith('/')) throw new Error('Invalid directory path');
      return read(current => [...current.keys()].filter(key => key.startsWith(path)).sort()
        .map(key => key.slice(path.length)));
    },
    cat(path) {
      if (path.endsWith('/')) throw new Error('Invalid file path');
      return read(current => console.log(current.get(path) ?? ''));
    },
    find(pattern) {
      const regex = new RegExp(pattern);
      return read(current => console.log([...current.keys()].sort().filter(key => regex.test(key)).join('\n')));
    },
    async du() {
      return read(current => {
        let size = 0;
        for (const [key, value] of current) {
          size += key.length + (value?.byteLength ?? value?.size ?? value?.length ?? 0);
        }
        return size;
      });
    },
    async df() {
      throw new Error(persist ? 'Storage estimate not available in preview' : 'Storage estimate not available for temporary files');
    },
    grep(path, pattern) {
      validatePath(path);
      return read(current => {
        const content = current.get(path) ?? '';
        if (new RegExp(pattern).test(content)) console.log(`${path}: ${content}`);
      });
    }
  };
}
