## Usage

```js
const dbManager = new DatabaseManager();

try {
    // Create a new database connection
    await dbManager.createDBConnection('my_database.db');

    // Execute raw query
    await dbManager.executeQueries([
        'CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);',
    ]);

    // Insert data using prepared statements
    await dbManager.executePreparedStatements([
        {
            query: 'INSERT INTO test_table (name) VALUES (?);',
            values: ['Alice'],
        },
        { query: 'INSERT INTO test_table (name) VALUES (?);', values: ['Bob'] },
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

   
    // Exporting a database into file: sync.sqlite3
    await dbManager.exportDatabase();

    console.log("Database exported successfully.");
   
    // Close the database connection
    await dbManager.closeDatabase();
} catch (error) {
    console.error('Error during database operations:', error);
} finally {
    // Terminate the worker when done
    dbManager.terminateWorker();
}
```
