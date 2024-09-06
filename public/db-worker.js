import SQLiteESMFactory from '../wa-sqlite-async.mjs'; // Use async build
import { IDBBatchAtomicVFS as MyVFS } from '../src/vfs/IDBBatchAtomicVFS.js';
import * as SQLite from '../src/sqlite-api.js';
let dbInstance;
class DbHelper {
    #MAX_SQL_CACHE_SIZE = 100;

    constructor(databaseName) {
        this.databaseName = databaseName;

        // initializing the database asynchronously
        this.db = null; // will initialize this in async methods
    }

    static async createDBConnection(databaseName) {
        const dbInstance = new DbHelper(databaseName);
        await dbInstance.initializeDatabase();
        dbInstance.setMaxSqlCacheSize();
        return dbInstance;
    }

    async initializeDatabase() {
        const sqliteModule = await SQLiteESMFactory();
        this.sqlite3 = SQLite.Factory(sqliteModule);

        const vfs = await MyVFS.create('my_vfs', sqliteModule);
        this.sqlite3.vfs_register(vfs, true);

        this.db = await this.sqlite3.open_v2(this.databaseName, this.sqlite3.OPEN_READWRITE | this.sqlite3.OPEN_CREATE, 'my_vfs');
        console.log(`Database created`);
    }

    async executeRawQuery(sql, selectionArgs = []) {
        if (!this.db) throw new Error("Database not initialized");
        try {
            const results = [];
            await this.sqlite3.exec(this.db, sql, (row, columns) => {
                results.push({ row, columns });
            });
            return results;            
        } catch (error) {
            throw new Error(`Query failed: ${error}`);
        }
    }

    setMaxSqlCacheSize() {
        if (this.db) {
          this.sqlite3.exec(this.db, `PRAGMA cache_size = ${this.#MAX_SQL_CACHE_SIZE};`);
        }
    }

    async executeQueries(queries, rollbackOnError = true) {
        if (!this.db) throw new Error("Database not initialized");
        
        try {
            await this.sqlite3.exec(this.db, 'BEGIN TRANSACTION;');
            for (let query of queries) {
                await this.sqlite3.exec(this.db, query);
            }
            await this.sqlite3.exec(this.db, 'COMMIT;');
        } catch (error) {
            if (rollbackOnError) {
                await this.sqlite3.exec(this.db, 'ROLLBACK;');
                throw new Error(`Transaction failed, rolled back: ${error.message}`);
            } else {
                console.warn(`Query failed: ${error.message}, continuing...`);
            }
        }
    }
}

// Worker thread message handling
self.onmessage = async (event) => {
    const { action, dbName, encryptionKey, sql, queries, rollbackOnError } = event.data;
console.log({ action, dbName, encryptionKey, sql, queries, rollbackOnError });

    try {
        let result;
        switch (action) {
            case 'createDBConnection':
                dbInstance = await DbHelper.createDBConnection(dbName);
                result = { success: true, message: `Database created` };
                break;
            case 'executeRawQuery':
                result = await dbInstance.executeRawQuery(sql, []);
                console.log(`Query executed: ${sql}`);
                console.log({ result });
                
                break;
            case 'executeQueries':
                await dbInstance.executeQueries(queries, rollbackOnError);
                result = { success: true, message: 'Queries executed successfully' };
                break;
            default:
                result = { error: 'Unknown action' };
                break;
        }

        self.postMessage(result);
    } catch (error) {
        self.postMessage({ error: error.message });
    }
};
