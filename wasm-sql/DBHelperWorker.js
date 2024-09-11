import SQLiteESMFactory from '../wa-sqlite/src/dist/wa-sqlite-async.mjs';
import { IDBBatchAtomicVFS as MyVFS } from '../wa-sqlite/src/vfs/IDBBatchAtomicVFS.js';
import * as SQLite from '../wa-sqlite/src/sqlite-api.js';

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
        await dbInstance.setMaxSqlCacheSize();
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

    async setMaxSqlCacheSize() {
        if (this.db) {
            await this.sqlite3.exec(this.db, `PRAGMA cache_size = ${this.#MAX_SQL_CACHE_SIZE};`);
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
            console.log("Transaction completed successfully");
            console.log([null, transactionIDs]);
            
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
                lastID = await this.sqlite3.step(preparedStatement);
                console.log({lastID});
                
            } catch (error) {
                runError = error.message;
                console.error('Error inserting data:', error.message);
            } finally {
                await this.sqlite3.finalize(preparedStatement);
                resolve([runError, lastID]);
            }
        });
    }

    async compileAndBindSQLiteStatement(sqlQuery, values) {
        const preparedStatements = await this.sqlite3.statements(this.db, sqlQuery);
        const preparedStatementObj = await preparedStatements.next();

        const result = this.sqlite3.bind_collection(preparedStatementObj.value, values);
        
        console.log(`Prepared statement compiled and bound: ${result === SQLite.SQLITE_OK}`);
        

        return preparedStatementObj.value;
    }

    async executeSelectQuery(sql, callback) {
        try {
            const result = await this.sqlite3.exec(this.db, sql);
            callback(null, result);
        } catch (err) {
            callback(err, null);
        }
    }

    async executeSelectPreparedStatements(sql, selectionArgs) {
        try {
            return await this.executeRawQuery(sql, selectionArgs);
        } catch (error) {
            console.error("Error executing select prepared statement:", error);
            throw new Error("Database select query failed");
        }
    }

    async executeRawQuery(sql, selectionArgs) {
        const records = [];
        
        try {
            // Prepare the statement using ws-sqlite
            for await (const stmt of this.sqlite3.statements(this.db, sql)) {
                const columnCount = this.sqlite3.column_count(stmt);
                const columnNames = [];

                if (selectionArgs && selectionArgs?.length > 0)
                    this.sqlite3.bind_collection(stmt, selectionArgs);
                
                for (let i = 0; i < columnCount; i++) {
                    columnNames.push(this.sqlite3.column_name(stmt, i));
                }
            
                while (await this.sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
                    const row = {};
            
                    for (let i = 0; i < columnCount; i++) {
                        const columnType = this.sqlite3.column_type(stmt, i);
            
                        switch (columnType) {
                            case SQLite.SQLITE_INTEGER:
                                row[columnNames[i]] = this.sqlite3.column_int(stmt, i);
                                break;
                            case SQLite.SQLITE_FLOAT:
                                row[columnNames[i]] = this.sqlite3.column_float(stmt, i);
                                break;
                            case SQLite.SQLITE_BLOB:
                                row[columnNames[i]] =this.sqlite3.column_blob(stmt, i);  // Handle blobs separately if needed
                                break;
                            case SQLite.SQLITE_TEXT:
                            default:
                                row[columnNames[i]] = this.sqlite3.column_text(stmt, i);
                                break;
                        }
                    }

                    records.push(row);
                }
            }
            
            return records;
        } catch (error) {
            console.error("Failed to executeRawQuery. Error: ", error);
            throw new Error(`Database select query failed: ${error}`);
        }
    }

    async isTableFound(tableName, callback) {
        const query = `SELECT DISTINCT tbl_name FROM sqlite_master WHERE tbl_name = '${tableName}'`;
        try {
            const result = await this.sqlite3.exec(this.db, query);

            console.log(`Table ${tableName} found: ${result === SQLite.SQLITE_OK}`);
            
            callback(null, result === SQLite.SQLITE_OK);
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
