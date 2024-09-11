class DatabaseManager {
    constructor() {
        this.worker = new Worker('../wasm-sql/DBHelperWorker.js', { type: 'module' });
        this.pendingOperations = new Map(); // Track ongoing operations

        // Listen for messages from the worker
        this.worker.onmessage = (event) => {
            const { operationId, result, error } = event.data;

            // Find and resolve/reject the corresponding promise
            if (this.pendingOperations.has(operationId)) {
                const { resolve, reject } = this.pendingOperations.get(operationId);
                if (error) {
                    reject(error);  // Handle failure case
                } else {
                    resolve(result); // Handle success case
                }
                // Remove the operation from the pending map
                this.pendingOperations.delete(operationId);
            }
        };
    }

    // Utility method to generate unique operation IDs
    generateOperationId() {
        return Math.random().toString(36).substr(2, 9); // Generate a unique operation ID
    }

    // Method to send a message to the worker and track the operation with a promise
    postToWorker(action, data = {}) {
        const operationId = this.generateOperationId();

        return new Promise((resolve, reject) => {
            // Store the operation in the map
            this.pendingOperations.set(operationId, { resolve, reject });

            // Send the message to the worker along with the operationId
            this.worker.postMessage({ operationId, action, ...data });
        });
    }

    // Wrapper methods to interact with the worker via promises
    async createDBConnection(dbName) {
        return this.postToWorker('createDBConnection', { dbName });
    }

    async executeRawQuery(sql, selectionArgs) {
        return this.postToWorker('executeRawQuery', { sql, selectionArgs });
    }

    async executeQueries(queries, rollbackOnError = true) {
        return this.postToWorker('executeQueries', { queries, rollbackOnError });
    }

    async executePreparedStatements(statements, rollbackOnError = true) {
        return this.postToWorker('executePreparedStatements', { statements, rollbackOnError });
    }

    async executeSelectPreparedStatements(sql, selectionArgs) {
        return this.postToWorker('executeSelectPreparedStatements', { sql, selectionArgs });
    }

    async isTableFound(tableName) {
        return this.postToWorker('isTableFound', { dbName: tableName });
    }

    async closeDatabase() {
        return this.postToWorker('closeDatabase');
    }

    async exportDatabase() {
        const data = await this.postToWorker('exportDatabase');

        // Create download link and trigger download
        const { blob, databaseName } = data;
        const url = URL.createObjectURL(blob);

        const downloadLink = document.createElement('a');
        
        downloadLink.href = url;
        downloadLink.download = `${databaseName}.sqlite3`;

        // Trigger download
        document.body.appendChild(downloadLink);
        downloadLink.click();

        // Clean up
        document.body.removeChild(downloadLink);
        URL.revokeObjectURL(url);
    }

    terminateWorker() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null; // Reset the worker reference
            console.log("Worker thread terminated");
        } else {
            console.warn("No worker thread to terminate");
        }
    }    
}

// Example usage
(async () => {
    const dbManager = new DatabaseManager();

    try {
        // Create a new database connection
        await dbManager.createDBConnection('sync');

        // Execute raw query
        await dbManager.executeQueries(['CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);']);

        // Insert data using prepared statements
        await dbManager.executePreparedStatements([
            { query: 'INSERT INTO test_table (name) VALUES (?);', values: ['Alice'] },
            { query: 'INSERT INTO test_table (name) VALUES (?);', values: ['Bob'] }
        ]);

        // Check if the table exists
        const isFound = await dbManager.isTableFound('test_table');
        if (isFound) {
            console.log('Table found! Now selecting data.');
        }

        // Select data using prepared statement
        const selectResults = await dbManager.executeSelectPreparedStatements(
            'SELECT * FROM test_table WHERE name = ?;',
            ['Alice']
        );
        console.log('Selected data:', selectResults);

        try {
            // await dbManager.exportDatabase();

            console.log("Database exported successfully.");
        } catch (error) {
            console.error("Error exporting database:", error);
        }

        // Close the database connection
        await dbManager.closeDatabase();

    } catch (error) {
        console.error('Error during database operations:', error);
    } finally {
        // Terminate the worker when done
        dbManager.terminateWorker();
    }
})();