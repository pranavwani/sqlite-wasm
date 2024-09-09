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

    async executeSelectPreparedStatements(sql, ...selectionArgs) {
        try {
            return await this.executeRawQuery(sql, ...selectionArgs);
        } catch (error) {
            console.error("Error executing select prepared statement:", error);
            throw new Error("Database select query failed");
        }
    }

    async executeRawQuery(sql, ...selectionArgs) {
        const records = [];
        
        try {
            console.debug(`Executing raw select query: ${sql}, with arguments: ${selectionArgs}`);
    
            // Prepare the statement using ws-sqlite
            for await (const stmt of this.sqlite3.statements(this.db, sql)) {
                console.log(`Executing statement: ${sql}`);
                // Bind the selection arguments if they exist
                if (selectionArgs && selectionArgs.length) {
                    console.log(`Binding selection arguments: ${selectionArgs}`);
                    console.log(stmt);
                    
                    await this.sqlite3.bind_collection(stmt, selectionArgs);
                }
                
                // Execute the statement and collect the results
                while (await this.sqlite3.step(stmt) === SQLite.SQLITE_ROW) {
                    const record = {};
    
                    // Retrieve the column names and values
                    const columnNames = await dbInstance.columnNames(stmt);
                    for (const columnName of columnNames) {
                        const columnIndex = await dbInstance.column(stmt, columnName);
    
                        // Switch case to determine column types and extract values
                        switch (await dbInstance.columnType(stmt, columnIndex)) {
                            case SQLite.SQLITE_BLOB:
                                record[columnName] = await dbInstance.columnBlob(stmt, columnIndex);
                                break;
                            case SQLite.SQLITE_FLOAT:
                                record[columnName] = await dbInstance.columnFloat(stmt, columnIndex);
                                break;
                            case SQLite.SQLITE_INTEGER:
                                record[columnName] = await dbInstance.columnInteger(stmt, columnIndex);
                                break;
                            case SQLite.SQLITE_TEXT:
                            default:
                                record[columnName] = await dbInstance.columnText(stmt, columnIndex);
                                break;
                        }
                    }
                    records.push(record);
                }
                
                // Reset the statement for further executions if needed
                await this.sqlite3.reset(stmt);
            }

            console.log("Select query executed successfully");
            console.log(records);
            
            return records;
        } catch (error) {
            console.error("Failed to executeRawQuery. Error: ", error);
            throw new Error(`Database select query failed: ${error}`);
        }
    
        return records;
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
