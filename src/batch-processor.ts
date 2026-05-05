/**
 * Batch processor for concurrent API requests with concurrency limit.
 * Processes items in batches to avoid overwhelming the API or network.
 */

export interface BatchProcessorOptions<T, R> {
	/**
	 * Maximum number of concurrent operations
	 */
	concurrency: number;

	/**
	 * Function to process a single item
	 */
	processItem: (item: T, index: number) => Promise<R>;

	/**
	 * Optional callback for progress updates
	 */
	onProgress?: (completed: number, total: number) => void;

	/**
	 * Optional callback for individual item errors
	 * If not provided, errors will be collected and returned
	 */
	onError?: (error: unknown, item: T, index: number) => void;
}

export interface BatchResult<R> {
	/**
	 * Successfully processed results (may contain undefined for failed items)
	 */
	results: (R | undefined)[];

	/**
	 * Errors that occurred during processing
	 */
	errors: Array<{
		index: number;
		error: unknown;
	}>;

	/**
	 * Number of successfully processed items
	 */
	successCount: number;

	/**
	 * Number of failed items
	 */
	failureCount: number;
}

/**
 * Process items in batches with concurrency control.
 * 
 * @param items Items to process
 * @param options Processing options
 * @returns Batch processing results
 */
export async function processBatch<T, R>(
	items: T[],
	options: BatchProcessorOptions<T, R>
): Promise<BatchResult<R>> {
	const {concurrency, processItem, onProgress, onError} = options;
	const results: (R | undefined)[] = new Array(items.length);
	const errors: Array<{index: number; error: unknown}> = [];
	
	let completed = 0;
	let successCount = 0;
	let failureCount = 0;

	// Create a pool of workers
	const workers: Promise<void>[] = [];
	let nextIndex = 0;

	const processNext = async (): Promise<void> => {
		while (nextIndex < items.length) {
			const currentIndex = nextIndex++;
			const item = items[currentIndex];
			
			if (item === undefined) continue;

			try {
				const result = await processItem(item, currentIndex);
				results[currentIndex] = result;
				successCount++;
			} catch (error) {
				failureCount++;
				errors.push({index: currentIndex, error});
				
				if (onError) {
					onError(error, item, currentIndex);
				}
			}

			completed++;
			if (onProgress) {
				onProgress(completed, items.length);
			}
		}
	};

	// Start workers up to concurrency limit
	for (let i = 0; i < Math.min(concurrency, items.length); i++) {
		workers.push(processNext());
	}

	// Wait for all workers to complete
	await Promise.all(workers);

	return {
		results,
		errors,
		successCount,
		failureCount
	};
}

// Made with Bob
