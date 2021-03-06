/* eslint-disable valid-jsdoc */
import { assert } from '@orbit/utils';
import Orbit, {
  serializeRecordIdentity,
  deserializeRecordIdentity,
  QueryOrExpression,
  Record,
  RecordIdentity,
  RecordOperation,
  TransformBuilderFunc
} from '@orbit/data';
import {
  RecordRelationshipIdentity,
  AsyncRecordCache,
  AsyncRecordCacheSettings,
  PatchResult,
  QueryResultData
} from '@orbit/record-cache';
import { supportsIndexedDB } from './lib/indexeddb';

const INVERSE_RELS = '__inverseRels__';

interface InverseRelationshipForIDB {
  id: string;
  recordIdentity: string;
  relationship: string;
  relatedIdentity: string;
  type: string;
  relatedType: string;
}

export interface IndexedDBCacheSettings extends AsyncRecordCacheSettings {
  namespace?: string;
}

/**
 * A cache used to access records in an IndexedDB database.
 *
 * Because IndexedDB access is async, this cache extends `AsyncRecordCache`.
 */
export default class IndexedDBCache extends AsyncRecordCache {
  protected _namespace: string;
  protected _db: any;

  constructor(settings: IndexedDBCacheSettings) {
    assert('Your browser does not support IndexedDB!', supportsIndexedDB());

    super(settings);

    this._namespace = settings.namespace || 'orbit';

    this.reset();
  }

  async query(queryOrExpression: QueryOrExpression, options?: object, id?: string): Promise<QueryResultData> {
    await this.openDB();
    return super.query(queryOrExpression, options, id);
  }

  async patch(operationOrOperations: RecordOperation | RecordOperation[] | TransformBuilderFunc): Promise<PatchResult> {
    await this.openDB();
    return super.patch(operationOrOperations);
  }

  get namespace(): string {
    return this._namespace;
  }

  async upgrade(): Promise<void> {
    await this.reopenDB();
    for (let processor of this._processors) {
      await processor.upgrade();
    }
  }

  async reset(): Promise<void> {
    await  this.deleteDB();

    for (let processor of this._processors) {
      await processor.reset();
    }
  }

  /**
   * The version to specify when opening the IndexedDB database.
   */
  get dbVersion(): number {
    return this._schema.version;
  }

  /**
   * IndexedDB database name.
   *
   * Defaults to the namespace of the app, which can be overridden in the constructor.
   */
  get dbName(): string {
    return this._namespace;
  }

  get isDBOpen(): boolean {
    return !!this._db;
  }

  openDB(): Promise<IDBDatabase> {
    return new Orbit.Promise((resolve, reject) => {
      if (this._db) {
        resolve(this._db);
      } else {
        let request = Orbit.globals.indexedDB.open(this.dbName, this.dbVersion);

        request.onerror = (/* event */) => {
          // console.error('error opening indexedDB', this.dbName);
          reject(request.error);
        };

        request.onsuccess = (/* event */) => {
          // console.log('success opening indexedDB', this.dbName);
          const db = this._db = request.result;
          resolve(db);
        };

        request.onupgradeneeded = (event) => {
          // console.log('indexedDB upgrade needed');
          const db = this._db = event.target.result;
          if (event && event.oldVersion > 0) {
            this.migrateDB(db, event);
          } else {
            this.createDB(db);
          }
        };
      }
    });
  }

  closeDB(): void {
    if (this.isDBOpen) {
      this._db.close();
      this._db = null;
    }
  }

  reopenDB(): Promise<IDBDatabase> {
    this.closeDB();
    return this.openDB();
  }

  createDB(db: IDBDatabase): void {
    // console.log('createDB');
    Object.keys(this.schema.models).forEach(model => {
      this.registerModel(db, model);
    });

    this.createInverseRelationshipStore(db);
  }

  createInverseRelationshipStore(db: IDBDatabase): void {
    let objectStore = db.createObjectStore(INVERSE_RELS, { keyPath: 'id' });
    objectStore.createIndex('type', 'type', { unique: false });
    objectStore.createIndex('relatedType', 'relatedType', { unique: false });
    objectStore.createIndex('relatedIdentity', 'relatedIdentity', { unique: false });
  }

  /**
   * Migrate database.
   */
  migrateDB(db: IDBDatabase, event: IDBVersionChangeEvent) {
    console.error('IndexedDBSource#migrateDB - should be overridden to upgrade IDBDatabase from: ', event.oldVersion, ' -> ', event.newVersion);
  }

  deleteDB(): Promise<void> {
    this.closeDB();

    return new Orbit.Promise((resolve, reject) => {
      let request = Orbit.globals.indexedDB.deleteDatabase(this.dbName);

      request.onerror = (/* event */) => {
        // console.error('error deleting indexedDB', this.dbName);
        reject(request.error);
      };

      request.onsuccess = (/* event */) => {
        // console.log('success deleting indexedDB', this.dbName);
        resolve();
      };
    });
  }

  registerModel(db, type) {
    // console.log('registerModel', type);
    db.createObjectStore(type, { keyPath: 'id' });
    // TODO - create indices
  }

  async clearRecords(type: string): Promise<void> {
    // console.log('clearRecords', type);

    return new Orbit.Promise((resolve, reject) => {
      const transaction = this._db.transaction([type], 'readwrite');
      const objectStore = transaction.objectStore(type);
      const request = objectStore.clear();

      request.onerror = function(/* event */) {
        // console.error('error - removeRecords', request.error);
        reject(request.error);
      };

      request.onsuccess = function(/* event */) {
        // console.log('success - removeRecords');
        resolve();
      };
    });
  }

  async getRecordAsync(record: RecordIdentity): Promise<Record> {
    // console.log('getRecordAsync', record);

    return new Orbit.Promise((resolve, reject) => {
      const transaction = this._db.transaction([record.type]);
      const objectStore = transaction.objectStore(record.type);
      const request = objectStore.get(record.id);

      request.onerror = function(/* event */) {
        // console.error('error - getRecord', request.error);
        reject(request.error);
      };

      request.onsuccess = (/* event */) => {
        // console.log('success - getRecord', request.result);
        let result = request.result;

        if (result) {
          if (this._keyMap) {
            this._keyMap.pushRecord(result);
          }
          resolve(result);
        } else {
          resolve();
        }
      };
    });
  }

  async getRecordsAsync(type: string): Promise<Record[]> {
    // console.log('getRecordsAsync', type);

    if (!type) {
      return this._getAllRecords();
    } else {
      return new Orbit.Promise((resolve, reject) => {
        const transaction = this._db.transaction([type]);
        const objectStore = transaction.objectStore(type);
        const request = objectStore.openCursor();
        const records = [];

        request.onerror = function(/* event */) {
          // console.error('error - getRecords', request.error);
          reject(request.error);
        };

        request.onsuccess = (event) => {
          // console.log('success - getRecords', request.result);
          const cursor = event.target.result;
          if (cursor) {
            let record = cursor.value;

            if (this._keyMap) {
              this._keyMap.pushRecord(record);
            }

            records.push(record);
            cursor.continue();
          } else {
            resolve(records);
          }
        };
      });
    }
  }

  async setRecordAsync(record: Record): Promise<void> {
    const transaction = this._db.transaction([record.type], 'readwrite');
    const objectStore = transaction.objectStore(record.type);

    return new Orbit.Promise((resolve, reject) => {
      const request = objectStore.put(record);

      request.onerror = function(/* event */) {
        // console.error('error - putRecord', request.error);
        reject(request.error);
      };

      request.onsuccess = (/* event */) => {
        // console.log('success - putRecord');
        if (this._keyMap) {
          this._keyMap.pushRecord(record);
        }

        resolve();
      };
    });
  }

  async setRecordsAsync(records: Record[]): Promise<void> {
    if (records.length > 0) {
      const types = [];
      for (let record of records) {
        if (!types.includes(record.type)) {
          types.push(record.type);
        }
      }
      const transaction = this._db.transaction(types, 'readwrite');

      return new Orbit.Promise((resolve, reject) => {
        let i = 0;

        let putNext = () => {
          if (i < records.length) {
            let record = records[i++];
            let objectStore = transaction.objectStore(record.type);
            let request = objectStore.put(record);
            request.onsuccess = putNext();
            request.onerror = function(/* event */) {
              // console.error('error - addInverseRelationshipsAsync', request.error);
              reject(request.error);
            };

          } else {
            resolve();
          }
        }

        putNext();
      });
    }
  }

  async removeRecordAsync(recordIdentity: RecordIdentity): Promise<Record> {
    return new Orbit.Promise((resolve, reject) => {
      const transaction = this._db.transaction([recordIdentity.type], 'readwrite');
      const objectStore = transaction.objectStore(recordIdentity.type);
      const request = objectStore.delete(recordIdentity.id);

      request.onerror = function(/* event */) {
        // console.error('error - removeRecord', request.error);
        reject(request.error);
      };

      request.onsuccess = function(/* event */) {
        // console.log('success - removeRecord');
        resolve();
      };
    });
  }

  async removeRecordsAsync(records: RecordIdentity[]): Promise<Record[]> {
    if (records.length > 0) {
      const types = [];
      for (let record of records) {
        if (!types.includes(record.type)) {
          types.push(record.type);
        }
      }
      const transaction = this._db.transaction(types, 'readwrite');

      return new Orbit.Promise((resolve, reject) => {
        let i = 0;

        let removeNext = () => {
          if (i < records.length) {
            let record = records[i++];
            let objectStore = transaction.objectStore(record.type);
            let request = objectStore.delete(record.id);
            request.onsuccess = removeNext();
            request.onerror = function(/* event */) {
              // console.error('error - addInverseRelationshipsAsync', request.error);
              reject(request.error);
            };

          } else {
            resolve();
          }
        }

        removeNext();
      });
    }
  }

  async getInverseRelationshipsAsync(recordIdentity: RecordIdentity): Promise<RecordRelationshipIdentity[]> {
    // console.log('getInverseRelationshipsAsync', recordIdentity);

    return new Orbit.Promise((resolve, reject) => {
      const transaction = this._db.transaction([INVERSE_RELS]);
      const objectStore = transaction.objectStore(INVERSE_RELS);
      const request = objectStore.openCursor();
      const records = [];

      request.onerror = function(/* event */) {
        // console.error('error - getRecords', request.error);
        reject(request.error);
      };

      request.onsuccess = (event) => {
        // console.log('success - getInverseRelationshipsAsync', request.result);
        const cursor = event.target.result;
        if (cursor) {
          let record = this._fromInverseRelationshipForIDB(cursor.value);
          records.push(record);
          cursor.continue();
        } else {
          resolve(records);
        }
      };
    });
  }

  async addInverseRelationshipsAsync(relationships: RecordRelationshipIdentity[]): Promise<void> {
    // console.log('addInverseRelationshipsAsync', relationships);

    if (relationships.length > 0) {
      const transaction = this._db.transaction([INVERSE_RELS], 'readwrite');
      const objectStore = transaction.objectStore(INVERSE_RELS);

      return new Orbit.Promise((resolve, reject) => {
        let i = 0;

        let putNext = () => {
          if (i < relationships.length) {
            let relationship = relationships[i++];
            let ir = this._toInverseRelationshipForIDB(relationship);
            let request = objectStore.put(ir);
            request.onsuccess = putNext();
            request.onerror = function(/* event */) {
              // console.error('error - addInverseRelationshipsAsync', request.error);
              reject(request.error);
            };

          } else {
            resolve();
          }
        }

        putNext();
      });
    }
  }

  async removeInverseRelationshipsAsync(relationships: RecordRelationshipIdentity[]): Promise<void> {
    // console.log('removeInverseRelationshipsAsync', relationships);

    if (relationships.length > 0) {
      const transaction = this._db.transaction([INVERSE_RELS], 'readwrite');
      const objectStore = transaction.objectStore(INVERSE_RELS);

      return new Orbit.Promise((resolve, reject) => {
        let i = 0;

        let removeNext = () => {
          if (i < relationships.length) {
            let relationship = relationships[i++];
            let id = this._serializeInverseRelationshipIdentity(relationship);
            let request = objectStore.delete(id);
            request.onsuccess = removeNext();
            request.onerror = function(/* event */) {
              // console.error('error - removeInverseRelationshipsAsync');
              reject(request.error);
            };

          } else {
            resolve();
          }
        }

        removeNext();
      });
    }
  }

  /////////////////////////////////////////////////////////////////////////////
  // Protected methods
  /////////////////////////////////////////////////////////////////////////////

  protected _getAllRecords(): Promise<Record[]> {
    const allRecords = [];

    const objectStoreNames = this._db.objectStoreNames;
    const types: string[] = [];
    for (let i = 0; i < objectStoreNames.length; i++) {
      let type = objectStoreNames.item(i);
      if (type !== INVERSE_RELS) {
        types.push(type);
      }
    }

    return types.reduce((chain, type) => {
      return chain.then(() => {
        return this.getRecordsAsync(type)
          .then(records => {
            Array.prototype.push.apply(allRecords, records);
          });
      });
    }, Orbit.Promise.resolve())
      .then(() => allRecords);
  }

  protected _serializeInverseRelationshipIdentity(ri: RecordRelationshipIdentity): string {
    return [
      serializeRecordIdentity(ri.record),
      ri.relationship,
      serializeRecordIdentity(ri.relatedRecord)
    ].join('::');
  }

  protected _toInverseRelationshipForIDB(ri: RecordRelationshipIdentity): InverseRelationshipForIDB {
    return {
      id: this._serializeInverseRelationshipIdentity(ri),
      recordIdentity: serializeRecordIdentity(ri.record),
      relationship: ri.relationship,
      relatedIdentity: serializeRecordIdentity(ri.relatedRecord),
      type: ri.record.type,
      relatedType: ri.relatedRecord.type
    };
  }

  protected _fromInverseRelationshipForIDB(ir: InverseRelationshipForIDB): RecordRelationshipIdentity {
    return {
      record: deserializeRecordIdentity(ir.recordIdentity),
      relatedRecord: deserializeRecordIdentity(ir.relatedIdentity),
      relationship: ir.relationship
    };
  }
}
