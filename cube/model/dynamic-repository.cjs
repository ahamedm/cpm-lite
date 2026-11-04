/**
 * Dynamic Cube schema repository.
 *
 * Cube's default repository only reads hand-written files under `schemaPath`.
 * CPM Lite also publishes models at runtime. Two interchangeable transports
 * carry the generated schema (see apps/api/src/cube/store.ts):
 *
 * - `file` (default, single host):
 *     <schema dir>/current.json
 *     <schema dir>/versions/<schema_version>/<model code>.yml
 * - `valkey` (multi-pod):
 *     <prefix>:current
 *     <prefix>:versions/<schema_version>/<model code> (keys)
 *
 * Both report the snapshot hash as the schema version, so Cube recompiles when
 * a published model changes, without a restart.
 */

const fs = require('node:fs');
const path = require('node:path');
const { FileRepository } = require('@cubejs-backend/shared');

const SCHEMA_FORMAT_PREFIX = 'cpm-cube-schema/';
const VALKEY_POINTER_CACHE_MS = 1_000;
const WARN_INTERVAL_MS = 10_000;

function generatedSchemaDir() {
  const configured = process.env.CPM_CUBE_SCHEMA_DIR;
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  return path.join(__dirname, '..', '..', 'data', 'cube-schema');
}

function parseManifest(raw, label) {
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    console.warn(`[cube] Ignoring unreadable generated schema pointer ${label}: ${error.message}`);
    return null;
  }
  if (
    !manifest ||
    typeof manifest.schema_version !== 'string' ||
    typeof manifest.format !== 'string' ||
    !manifest.format.startsWith(SCHEMA_FORMAT_PREFIX) ||
    !Array.isArray(manifest.models)
  ) {
    console.warn(`[cube] Ignoring unrecognised generated schema manifest ${label}`);
    return null;
  }
  return manifest;
}

function manifestModels(manifest) {
  return manifest.models.filter(
    (model) => model && typeof model.file_name === 'string' && typeof model.cube_name === 'string'
  );
}

function createValkeyClient(url) {
  // Required lazily so file-backed deployments never load the Redis client.
  // eslint-disable-next-line global-require
  const { Redis } = require('ioredis');
  const client = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 2_000,
    commandTimeout: 2_500,
    enableReadyCheck: true,
  });
  // Command failures are surfaced by schemaVersion/dataSchemaFiles; keep the
  // connection error events from spamming the log on every retry.
  let lastReportedAt = 0;
  client.on('error', (error) => {
    const now = Date.now();
    if (now - lastReportedAt < WARN_INTERVAL_MS) return;
    lastReportedAt = now;
    console.warn(`[cube] Valkey connection error: ${error.message}`);
  });
  return client;
}

class DynamicSchemaRepository extends FileRepository {
  constructor(staticSchemaPath, schemaDir = generatedSchemaDir()) {
    super(staticSchemaPath);
    this.schemaDir = schemaDir;
    this.cached = null;
  }

  /**
   * Reads current.json, cached by mtime and size so a polling schemaVersion
   * check does not re-read files on every query.
   */
  loadSnapshot() {
    const pointer = path.join(this.schemaDir, 'current.json');
    let stat;
    try {
      stat = fs.statSync(pointer);
    } catch {
      return null;
    }

    if (this.cached && this.cached.mtimeMs === stat.mtimeMs && this.cached.size === stat.size) {
      return this.cached.snapshot;
    }

    let manifest;
    try {
      manifest = parseManifest(fs.readFileSync(pointer, 'utf8'), pointer);
    } catch (error) {
      console.warn(`[cube] Ignoring unreadable generated schema pointer ${pointer}: ${error.message}`);
      manifest = null;
    }
    if (!manifest) {
      this.cached = { mtimeMs: stat.mtimeMs, size: stat.size, snapshot: null };
      return null;
    }

    const files = [];
    for (const model of manifestModels(manifest)) {
      const fileName = path.basename(model.file_name);
      const filePath = path.join(this.schemaDir, 'versions', manifest.schema_version, fileName);
      try {
        files.push({
          fileName: path.join('generated', fileName),
          content: fs.readFileSync(filePath, 'utf8'),
        });
      } catch (error) {
        console.warn(`[cube] Generated cube file missing for ${model.cube_name}: ${error.message}`);
      }
    }

    const snapshot = { schemaVersion: `dynamic:${manifest.schema_version}`, files };
    this.cached = { mtimeMs: stat.mtimeMs, size: stat.size, snapshot };
    return snapshot;
  }

  async dataSchemaFiles(includeDependencies = false) {
    const staticFiles = await super.dataSchemaFiles(includeDependencies);
    const snapshot = this.loadSnapshot();
    return snapshot ? [...staticFiles, ...snapshot.files] : staticFiles;
  }

  schemaVersion() {
    const snapshot = this.loadSnapshot();
    return snapshot ? snapshot.schemaVersion : 'static';
  }
}

class ValkeySchemaRepository extends FileRepository {
  constructor(staticSchemaPath, { url, keyPrefix, client, subscriber, eventChannel } = {}) {
    super(staticSchemaPath);
    this.keyPrefix = keyPrefix || process.env.CPM_VALKEY_KEY_PREFIX || 'cpm:cube-schema';
    this.eventChannel = eventChannel || `${this.keyPrefix}:events`;
    this.client = client || createValkeyClient(url || process.env.CPM_VALKEY_URL);
    if (!this.client) {
      throw new Error('CPM_VALKEY_URL is required when CPM_CUBE_SCHEMA_STORE=valkey');
    }
    this.subscriber = subscriber || (url ? createValkeyClient(url) : null);
    if (this.subscriber) this.attachSubscriber(this.subscriber);
    this.pointer = { at: 0, raw: null };
    this.lastKnown = null;
    this.lastWarnAt = 0;
  }

  /**
   * A dedicated connection is required: a client in subscribe mode cannot run
   * commands. ioredis re-subscribes automatically after a reconnect.
   */
  attachSubscriber(subscriber) {
    if (typeof subscriber.on === 'function') {
      subscriber.on('message', (channel, message) => {
        if (channel === this.eventChannel) this.handleEvent(message);
      });
    }
    if (typeof subscriber.subscribe === 'function') {
      Promise.resolve(subscriber.subscribe(this.eventChannel)).catch((error) => this.warn(error));
    }
  }

  /**
   * Any commit or rollback invalidates the cached pointer. The next
   * `schemaVersion()` re-reads it, which makes Cube recompile on the new hash.
   * A missed message is repaired by the one-second pointer poll.
   */
  handleEvent(message) {
    this.pointer = { at: 0, raw: null };
    void message;
  }

  async readPointer() {
    const now = Date.now();
    if (this.pointer.at && now - this.pointer.at < VALKEY_POINTER_CACHE_MS) {
      return this.pointer.raw;
    }
    const raw = await this.client.get(`${this.keyPrefix}:current`);
    this.pointer = { at: now, raw: typeof raw === 'string' ? raw : null };
    return this.pointer.raw;
  }

  async loadSnapshot() {
    const raw = await this.readPointer();
    if (!raw) {
      this.lastKnown = null;
      return null;
    }
    const manifest = parseManifest(raw, `${this.keyPrefix}:current`);
    if (!manifest) return this.lastKnown;

    const models = manifestModels(manifest);
    const keys = models.map(
      (model) => `${this.keyPrefix}:versions:${manifest.schema_version}:${path.basename(model.file_name)}`
    );
    const values = keys.length > 0 ? await this.client.mget(...keys) : [];
    const missing = models.filter((_model, index) => typeof values[index] !== 'string');
    if (missing.length > 0) {
      console.warn(
        `[cube] Generated schema ${manifest.schema_version} is incomplete in Valkey ` +
          `(${missing.map((model) => model.cube_name).join(', ')}); keeping the last known schema`
      );
      return this.lastKnown;
    }

    const files = models.map((model, index) => ({
      fileName: path.join('generated', path.basename(model.file_name)),
      content: values[index],
    }));

    const snapshot = { schemaVersion: `valkey:${manifest.schema_version}`, files };
    this.lastKnown = snapshot;
    return snapshot;
  }

  async dataSchemaFiles(includeDependencies = false) {
    const staticFiles = await super.dataSchemaFiles(includeDependencies);
    try {
      const snapshot = await this.loadSnapshot();
      return snapshot ? [...staticFiles, ...snapshot.files] : staticFiles;
    } catch (error) {
      this.warn(error);
      return this.lastKnown ? [...staticFiles, ...this.lastKnown.files] : staticFiles;
    }
  }

  async schemaVersion() {
    try {
      const snapshot = await this.loadSnapshot();
      return snapshot ? snapshot.schemaVersion : (this.lastKnown && this.lastKnown.schemaVersion) || 'static';
    } catch (error) {
      this.warn(error);
      return (this.lastKnown && this.lastKnown.schemaVersion) || 'static';
    }
  }

  warn(error) {
    const now = Date.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    console.warn(`[cube] Valkey schema store unavailable: ${error.message}`);
  }
}

function createDynamicSchemaRepository({ staticSchemaPath, schemaDir, store, valkey } = {}) {
  const selected = (store || process.env.CPM_CUBE_SCHEMA_STORE || 'file').toLowerCase();
  if (selected === 'valkey') {
    return new ValkeySchemaRepository(staticSchemaPath, {
      url: valkey?.url,
      keyPrefix: valkey?.keyPrefix,
      client: valkey?.client,
      subscriber: valkey?.subscriber,
      eventChannel: valkey?.eventChannel,
    });
  }
  if (selected !== 'file') {
    throw new Error(`CPM_CUBE_SCHEMA_STORE must be "file" or "valkey" (got ${selected})`);
  }
  return new DynamicSchemaRepository(staticSchemaPath, schemaDir ?? generatedSchemaDir());
}

module.exports = {
  DynamicSchemaRepository,
  ValkeySchemaRepository,
  createDynamicSchemaRepository,
  generatedSchemaDir,
};
