import SQLiteESMFactory from '../wasm/wa-sqlite-async.mjs';
import { IDBBatchAtomicVFS as MyVFS } from '../src/vfs/IDBBatchAtomicVFS.js';
import * as SQLite from '../src/sqlite-api.js';

let dbInstance;

class DbHelper {
    #MAX_SQL_CACHE_SIZE = 100;

    constructor(databaseName) {
        this.databaseName = databaseName;
        this.db = null;
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
        console.log(`Database created: ${this.databaseName}`);
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

    async executePreparedStatements(statements, rollbackOnError = true) {
        const transactionIDs = [];
        try {
            await this.sqlite3.exec(this.db, 'BEGIN TRANSACTION;');
            for (let statement of statements) {
                const [error, lastID] = await this.executePreparedStatement(statement.query, statement.values);
                if (error) throw error;
                transactionIDs.push(lastID);
            }
            await this.sqlite3.exec(this.db, 'COMMIT;');
            return [null, transactionIDs];
        } catch (error) {
            if (rollbackOnError) {
                await this.sqlite3.exec(this.db, 'ROLLBACK;');
            }
            return [error, null];
        }
    }

    executePreparedStatement(sqlQuery, values) {
        return new Promise(async (resolve) => {
            const preparedStatement = await this.compileAndBindSQLiteStatement(sqlQuery, values);
            let runError = null;
            let lastID = null;

            try {
                await preparedStatement.step();
                lastID = preparedStatement.lastInsertRowid();
            } catch (error) {
                runError = error.message;
                console.error('Error inserting data:', error.message);
            } finally {
                await preparedStatement.finalize();
                resolve([runError, lastID]);
            }
        });
    }

    async compileAndBindSQLiteStatement(sqlQuery, values) {
        const preparedStatement = await this.sqlite3.prepare(this.db, sqlQuery);
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            preparedStatement.bind_text(i + 1, value);
        }
        return preparedStatement;
    }

    async executeSelectQuery(sql, callback) {
        try {
            const result = await this.sqlite3.exec(this.db, sql);
            callback(null, result);
        } catch (err) {
            callback(err, null);
        }
    }

    async executeSelectPreparedStatements(sql, selectionArgs, callback) {
        const preparedStatement = await this.compileAndBindSQLiteStatement(sql, selectionArgs);
        try {
            const result = [];
            while (preparedStatement.step()) {
                result.push(preparedStatement.get());
            }
            callback(null, result);
        } catch (err) {
            callback(err, null);
        } finally {
            await preparedStatement.finalize();
        }
    }

    async isTableFound(tableName, callback) {
        const query = `SELECT DISTINCT tbl_name FROM sqlite_master WHERE tbl_name = '${tableName}'`;
        try {
            const result = await this.sqlite3.exec(this.db, query);
            callback(null, result.length > 0);
        } catch (err) {
            callback(err, false);
        }
    }

    async closeDatabase() {
        if (this.db) {
            await this.sqlite3.close(this.db);
            console.log("Database connection closed");
        }
    }
}

// Updated Worker thread message handling
self.onmessage = async (event) => {
    const { action, dbName, sql, queries, statements, selectionArgs, rollbackOnError, operationId } = event.data;
    let result;

    try {
        switch (action) {
            case 'createDBConnection':
                dbInstance = await DbHelper.createDBConnection(dbName);
                result = { success: true, message: `Database ${dbName} created` };
                break;
            case 'executeRawQuery':
                result = await dbInstance.executeRawQuery(sql);
                break;
            case 'executeQueries':
                await dbInstance.executeQueries(queries, rollbackOnError);
                result = { success: true, message: 'Queries executed successfully' };
                break;
            case 'executePreparedStatements':
                result = await dbInstance.executePreparedStatements(statements, rollbackOnError);
                break;
            case 'executeSelectPreparedStatements':
                result = await dbInstance.executeSelectPreparedStatements(sql, selectionArgs);
                break;
            case 'isTableFound':
                await dbInstance.isTableFound(dbName, (err, isFound) => {
                    result = { success: isFound };
                });
                break;
            case 'closeDatabase':
                await dbInstance.closeDatabase();
                result = { success: true, message: 'Database closed successfully' };
                break;
            default:
                result = { error: 'Unknown action' };
                break;
        }
        self.postMessage({ operationId, result });
    } catch (error) {
        self.postMessage({ operationId, error: error.message });
    }
};
