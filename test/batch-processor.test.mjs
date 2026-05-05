import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const moduleUrl = pathToFileURL(path.join(root, 'src/batch-processor.ts')).href;
const {processBatch} = await import(moduleUrl);

test('processes all items successfully with concurrency limit', async () => {
	const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
	const processedOrder = [];
	const concurrentCount = [];
	let currentConcurrent = 0;
	let maxConcurrent = 0;

	const result = await processBatch(items, {
		concurrency: 3,
		processItem: async (item) => {
			currentConcurrent++;
			maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
			concurrentCount.push(currentConcurrent);
			
			processedOrder.push(item);
			
			// Simulate async work
			await new Promise(resolve => setTimeout(resolve, 10));
			
			currentConcurrent--;
			return item * 2;
		}
	});

	assert.equal(result.successCount, 10);
	assert.equal(result.failureCount, 0);
	assert.equal(result.errors.length, 0);
	assert.equal(result.results.length, 10);
	
	// Verify all items were processed
	assert.deepEqual(result.results, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
	
	// Verify concurrency limit was respected
	assert.ok(maxConcurrent <= 3, `Max concurrent (${maxConcurrent}) should be <= 3`);
});

test('handles errors and continues processing other items', async () => {
	const items = [1, 2, 3, 4, 5];
	const errors = [];

	const result = await processBatch(items, {
		concurrency: 2,
		processItem: async (item) => {
			if (item === 2 || item === 4) {
				throw new Error(`Failed to process ${item}`);
			}
			return item * 2;
		},
		onError: (error, item, index) => {
			errors.push({item, index, message: error.message});
		}
	});

	assert.equal(result.successCount, 3);
	assert.equal(result.failureCount, 2);
	assert.equal(result.errors.length, 2);
	
	// Verify successful results
	assert.equal(result.results[0], 2);  // 1 * 2
	assert.equal(result.results[1], undefined);  // Failed
	assert.equal(result.results[2], 6);  // 3 * 2
	assert.equal(result.results[3], undefined);  // Failed
	assert.equal(result.results[4], 10); // 5 * 2
	
	// Verify error callback was called
	assert.equal(errors.length, 2);
	assert.equal(errors[0].item, 2);
	assert.equal(errors[0].index, 1);
	assert.equal(errors[1].item, 4);
	assert.equal(errors[1].index, 3);
});

test('reports progress correctly', async () => {
	const items = [1, 2, 3, 4, 5];
	const progressUpdates = [];

	const result = await processBatch(items, {
		concurrency: 2,
		processItem: async (item) => {
			await new Promise(resolve => setTimeout(resolve, 5));
			return item * 2;
		},
		onProgress: (completed, total) => {
			progressUpdates.push({completed, total});
		}
	});

	assert.equal(result.successCount, 5);
	assert.equal(progressUpdates.length, 5);
	
	// Verify progress updates
	assert.equal(progressUpdates[0].total, 5);
	assert.equal(progressUpdates[4].completed, 5);
	assert.equal(progressUpdates[4].total, 5);
});

test('handles empty array', async () => {
	const result = await processBatch([], {
		concurrency: 5,
		processItem: async (item) => item
	});

	assert.equal(result.successCount, 0);
	assert.equal(result.failureCount, 0);
	assert.equal(result.results.length, 0);
	assert.equal(result.errors.length, 0);
});

test('handles single item', async () => {
	const result = await processBatch([42], {
		concurrency: 5,
		processItem: async (item) => item * 2
	});

	assert.equal(result.successCount, 1);
	assert.equal(result.failureCount, 0);
	assert.deepEqual(result.results, [84]);
});

test('respects concurrency of 1 (sequential processing)', async () => {
	const items = [1, 2, 3, 4, 5];
	const processingOrder = [];
	let currentlyProcessing = 0;

	const result = await processBatch(items, {
		concurrency: 1,
		processItem: async (item) => {
			currentlyProcessing++;
			assert.equal(currentlyProcessing, 1, 'Should only process one item at a time');
			
			processingOrder.push(item);
			await new Promise(resolve => setTimeout(resolve, 5));
			
			currentlyProcessing--;
			return item;
		}
	});

	assert.equal(result.successCount, 5);
	assert.deepEqual(processingOrder, [1, 2, 3, 4, 5]);
});

test('handles high concurrency (more workers than items)', async () => {
	const items = [1, 2, 3];
	
	const result = await processBatch(items, {
		concurrency: 10,
		processItem: async (item) => item * 2
	});

	assert.equal(result.successCount, 3);
	assert.deepEqual(result.results, [2, 4, 6]);
});

test('collects all errors when onError is not provided', async () => {
	const items = [1, 2, 3, 4, 5];

	const result = await processBatch(items, {
		concurrency: 2,
		processItem: async (item) => {
			if (item % 2 === 0) {
				throw new Error(`Even number: ${item}`);
			}
			return item;
		}
	});

	assert.equal(result.successCount, 3);
	assert.equal(result.failureCount, 2);
	assert.equal(result.errors.length, 2);
	
	// Verify error details
	assert.equal(result.errors[0].index, 1); // item 2
	assert.match(result.errors[0].error.message, /Even number: 2/);
	assert.equal(result.errors[1].index, 3); // item 4
	assert.match(result.errors[1].error.message, /Even number: 4/);
});

// Made with Bob
