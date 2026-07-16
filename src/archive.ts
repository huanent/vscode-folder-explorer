import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as vscode from 'vscode';
import * as yauzl from 'yauzl';
import * as yazl from 'yazl';
import { confirmOverwrite, getDisplayName } from './fileOperations';

const progressIntervalMs = 50;

export interface ArchiveOperation {
	cancelled: boolean;
}

export class OperationCancelledError extends Error {
	constructor() {
		super('Operation cancelled.');
	}
}

export async function compressEntries(
	sourceUris: vscode.Uri[],
	destinationDirectoryUri: vscode.Uri,
	operation: ArchiveOperation,
	onProgress: (progress: { percent: number; detail: string }) => void
): Promise<void> {
	if (sourceUris.length === 0) {
		return;
	}
	assertFileUris([...sourceUris, destinationDirectoryUri]);
	const destinationStat = await vscode.workspace.fs.stat(destinationDirectoryUri);
	if (!(destinationStat.type & vscode.FileType.Directory)) {
		throw new Error('Archives can only be created in a folder.');
	}

	const zip = new yazl.ZipFile();
	let totalBytes = 0;
	let processedBytes = 0;
	let lastProgressTime = 0;
	onProgress({ percent: 0, detail: 'Collecting files...' });
	const singleStat = sourceUris.length === 1 ? await vscode.workspace.fs.stat(sourceUris[0]) : undefined;
	if (sourceUris.length === 1 && singleStat && singleStat.type & vscode.FileType.Directory) {
		totalBytes = await addDirectoryToZip(zip, sourceUris[0], '', operation, reportFileProgress);
	} else {
		for (const sourceUri of sourceUris) {
			totalBytes += await addEntryToZip(zip, sourceUri, getDisplayName(sourceUri), operation, reportFileProgress);
		}
	}

	const defaultName = sourceUris.length === 1 ? `${getDisplayName(sourceUris[0])}.zip` : 'Archive.zip';
	const archiveUri = await getAvailableChildUri(destinationDirectoryUri, defaultName);
	const archiveStream = createWriteStream(archiveUri.fsPath, { flags: 'wx' });
	zip.on('error', error => archiveStream.destroy(error));
	try {
		const completion = pipeline(zip.outputStream, archiveStream);
		zip.end();
		await completion;
		assertNotCancelled(operation);
		onProgress({ percent: 100, detail: 'Archive created.' });
	} catch (error) {
		archiveStream.destroy();
		await deleteIfExists(archiveUri);
		throw error;
	}

	function reportFileProgress(zipPath: string): Transform {
		return new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				try {
					assertNotCancelled(operation);
					processedBytes += chunk.length;
					const now = Date.now();
					if (now - lastProgressTime >= progressIntervalMs) {
						lastProgressTime = now;
						onProgress({
							percent: totalBytes === 0 ? 99 : Math.min((processedBytes / totalBytes) * 99, 99),
							detail: `Compressing ${zipPath}`
						});
					}
					callback(null, chunk);
				} catch (error) {
					callback(error instanceof Error ? error : new Error(String(error)));
				}
			}
		});
	}
}

async function addEntryToZip(
	zip: yazl.ZipFile,
	sourceUri: vscode.Uri,
	zipPath: string,
	operation: ArchiveOperation,
	createProgressStream: (zipPath: string) => Transform
): Promise<number> {
	assertNotCancelled(operation);
	const stat = await vscode.workspace.fs.stat(sourceUri);
	if (stat.type & vscode.FileType.SymbolicLink) {
		return 0;
	}
	if (stat.type & vscode.FileType.Directory) {
		return addDirectoryToZip(zip, sourceUri, zipPath, operation, createProgressStream);
	}
	zip.addReadStreamLazy(
		zipPath,
		{ mtime: new Date(stat.mtime), size: stat.size, compressionLevel: 3 },
		callback => {
			try {
				assertNotCancelled(operation);
				const sourceStream = createReadStream(sourceUri.fsPath);
				const progressStream = createProgressStream(zipPath);
				sourceStream.on('error', error => progressStream.destroy(error));
				progressStream.on('close', () => sourceStream.destroy());
				callback(null, sourceStream.pipe(progressStream));
			} catch (error) {
				callback(error, undefined as never);
			}
		}
	);
	return stat.size;
}

async function addDirectoryToZip(
	zip: yazl.ZipFile,
	directoryUri: vscode.Uri,
	zipPath: string,
	operation: ArchiveOperation,
	createProgressStream: (zipPath: string) => Transform
): Promise<number> {
	const entries = await vscode.workspace.fs.readDirectory(directoryUri);
	if (entries.length === 0 && zipPath) {
		zip.addEmptyDirectory(zipPath);
	}
	let totalBytes = 0;
	for (const [name] of entries) {
		assertNotCancelled(operation);
		const entryPath = zipPath ? `${zipPath}/${name}` : name;
		totalBytes += await addEntryToZip(zip, vscode.Uri.joinPath(directoryUri, name), entryPath, operation, createProgressStream);
	}
	return totalBytes;
}

export async function extractArchive(
	archiveUri: vscode.Uri,
	operation: ArchiveOperation,
	onProgress: (progress: { percent: number; detail: string }) => void
): Promise<boolean> {
	if (!getDisplayName(archiveUri).toLowerCase().endsWith('.zip')) {
		throw new Error('Only ZIP archives can be extracted.');
	}
	assertFileUris([archiveUri]);
	const archiveStat = await vscode.workspace.fs.stat(archiveUri);
	if (!(archiveStat.type & vscode.FileType.File)) {
		throw new Error('Only ZIP files can be extracted.');
	}

	const parentUri = vscode.Uri.joinPath(archiveUri, '..');
	const folderName = getDisplayName(archiveUri).slice(0, -4);
	const destinationUri = vscode.Uri.joinPath(parentUri, folderName);
	const stagingUri = vscode.Uri.joinPath(parentUri, `.${folderName}.extract-${randomUUID()}`);
	const mergedUri = vscode.Uri.joinPath(parentUri, `.${folderName}.merge-${randomUUID()}`);
	try {
		await vscode.workspace.fs.createDirectory(stagingUri);
		onProgress({ percent: 0, detail: 'Reading archive...' });
		const zip = await yauzl.openPromise(archiveUri.fsPath, { validateEntrySizes: true });
		let fileCount = 0;
		let singleFileParts: string[] | undefined;
		try {
			for await (const entry of zip.eachEntry()) {
				assertNotCancelled(operation);
				const safeParts = getSafeArchivePathParts(entry.fileName);
				if (safeParts.length === 0) {
					continue;
				}
				const targetUri = vscode.Uri.joinPath(stagingUri, ...safeParts);
				if (entry.fileName.endsWith('/')) {
					await vscode.workspace.fs.createDirectory(targetUri);
					continue;
				}
				fileCount += 1;
				singleFileParts = fileCount === 1 ? safeParts : undefined;
				await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(targetUri, '..'));
				const readStream = await zip.openReadStreamPromise(entry);
				let extractedBytes = 0;
				let lastProgressTime = 0;
				const progressStream = new Transform({
					transform(chunk: Buffer, _encoding, callback) {
						try {
							assertNotCancelled(operation);
							extractedBytes += chunk.length;
							const now = Date.now();
							if (now - lastProgressTime >= progressIntervalMs) {
								lastProgressTime = now;
								const entryProgress = entry.uncompressedSize === 0 ? 1 : extractedBytes / entry.uncompressedSize;
								onProgress({
									percent: Math.min(((zip.entriesRead - 1 + entryProgress) / Math.max(zip.entryCount, 1)) * 80, 80),
									detail: `Extracting ${entry.fileName}`
								});
							}
							callback(null, chunk);
						} catch (error) {
							callback(error instanceof Error ? error : new Error(String(error)));
						}
					}
				});
				await pipeline(readStream, progressStream, createWriteStream(targetUri.fsPath, { flags: 'wx' }));
			}
		} finally {
			zip.close();
		}

		assertNotCancelled(operation);
		if (fileCount === 1 && singleFileParts) {
			const sourceUri = vscode.Uri.joinPath(stagingUri, ...singleFileParts);
			const targetUri = vscode.Uri.joinPath(parentUri, singleFileParts[singleFileParts.length - 1]);
			const targetType = await getFileType(targetUri);
			if (targetType !== undefined && !(await confirmOverwrite(targetUri))) {
				return false;
			}
			onProgress({ percent: 98, detail: 'Finishing extraction...' });
			await vscode.workspace.fs.rename(sourceUri, targetUri, { overwrite: targetType !== undefined });
			return true;
		}

		let destinationExists = false;
		try {
			const destinationStat = await vscode.workspace.fs.stat(destinationUri);
			if (!(destinationStat.type & vscode.FileType.Directory)) {
				throw new Error(`Cannot extract because "${folderName}" already exists and is not a folder.`);
			}
			destinationExists = true;
			const choice = await vscode.window.showWarningMessage(
				`The folder "${folderName}" already exists. Merge into it?`,
				{ modal: true, detail: 'Existing files with the same names will be replaced.' },
				'Merge'
			);
			if (choice !== 'Merge') {
				return false;
			}
		} catch (error) {
			if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
				throw error;
			}
		}

		if (!destinationExists) {
			onProgress({ percent: 98, detail: 'Finishing extraction...' });
			await vscode.workspace.fs.rename(stagingUri, destinationUri, { overwrite: false });
			return true;
		}

		await vscode.workspace.fs.createDirectory(mergedUri);
		let completedEntries = 0;
		const totalEntries = await countDirectoryEntries(destinationUri, operation) + await countDirectoryEntries(stagingUri, operation);
		const reportMergeProgress = (detail: string) => {
			completedEntries += 1;
			onProgress({
				percent: 80 + (completedEntries / Math.max(totalEntries, 1)) * 18,
				detail
			});
		};
		onProgress({ percent: 80, detail: 'Preparing merged folder...' });
		await mergeDirectory(destinationUri, mergedUri, operation, reportMergeProgress);
		await mergeDirectory(stagingUri, mergedUri, operation, reportMergeProgress);
		assertNotCancelled(operation);
		onProgress({ percent: 98, detail: 'Applying merged folder...' });
		await replaceDirectory(destinationUri, mergedUri, parentUri, folderName);
		return true;
	} finally {
		await deleteIfExists(stagingUri);
		await deleteIfExists(mergedUri);
	}
}

async function countDirectoryEntries(directoryUri: vscode.Uri, operation: ArchiveOperation): Promise<number> {
	let count = 0;
	for (const [name, fileType] of await vscode.workspace.fs.readDirectory(directoryUri)) {
		assertNotCancelled(operation);
		count += 1;
		if (fileType & vscode.FileType.Directory) {
			count += await countDirectoryEntries(vscode.Uri.joinPath(directoryUri, name), operation);
		}
	}
	return count;
}

async function mergeDirectory(
	sourceUri: vscode.Uri,
	destinationUri: vscode.Uri,
	operation: ArchiveOperation,
	onEntry: (detail: string) => void
): Promise<void> {
	for (const [name, fileType] of await vscode.workspace.fs.readDirectory(sourceUri)) {
		assertNotCancelled(operation);
		const sourceEntryUri = vscode.Uri.joinPath(sourceUri, name);
		const destinationEntryUri = vscode.Uri.joinPath(destinationUri, name);
		if (fileType & vscode.FileType.Directory) {
			const destinationType = await getFileType(destinationEntryUri);
			if (destinationType !== undefined && !(destinationType & vscode.FileType.Directory)) {
				await vscode.workspace.fs.delete(destinationEntryUri);
			}
			await vscode.workspace.fs.createDirectory(destinationEntryUri);
			onEntry(`Merging ${name}`);
			await mergeDirectory(sourceEntryUri, destinationEntryUri, operation, onEntry);
		} else {
			const destinationType = await getFileType(destinationEntryUri);
			if (destinationType !== undefined && destinationType & vscode.FileType.Directory) {
				await vscode.workspace.fs.delete(destinationEntryUri, { recursive: true });
			}
			await vscode.workspace.fs.copy(sourceEntryUri, destinationEntryUri, { overwrite: true });
			onEntry(`Merging ${name}`);
		}
	}
}

async function getFileType(uri: vscode.Uri): Promise<vscode.FileType | undefined> {
	try {
		return (await vscode.workspace.fs.stat(uri)).type;
	} catch (error) {
		if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
			return undefined;
		}
		throw error;
	}
}

async function replaceDirectory(
	destinationUri: vscode.Uri,
	mergedUri: vscode.Uri,
	parentUri: vscode.Uri,
	folderName: string
): Promise<void> {
	const backupUri = vscode.Uri.joinPath(parentUri, `.${folderName}.backup-${randomUUID()}`);
	await vscode.workspace.fs.rename(destinationUri, backupUri, { overwrite: false });
	try {
		await vscode.workspace.fs.rename(mergedUri, destinationUri, { overwrite: false });
	} catch (error) {
		await vscode.workspace.fs.rename(backupUri, destinationUri, { overwrite: false });
		throw error;
	}
	await vscode.workspace.fs.delete(backupUri, { recursive: true });
}

async function deleteIfExists(uri: vscode.Uri): Promise<void> {
	try {
		await vscode.workspace.fs.delete(uri, { recursive: true });
	} catch (error) {
		if (!(error instanceof vscode.FileSystemError && error.code === 'FileNotFound')) {
			throw error;
		}
	}
}

function assertNotCancelled(operation: ArchiveOperation): void {
	if (operation.cancelled) {
		throw new OperationCancelledError();
	}
}

function assertFileUris(uris: vscode.Uri[]): void {
	if (uris.some(uri => uri.scheme !== 'file')) {
		throw new Error('Streaming archive operations are only supported for local files.');
	}
}

function getSafeArchivePathParts(relativePath: string): string[] {
	const normalized = relativePath.replaceAll('\\', '/');
	const parts = normalized.split('/').filter(Boolean);
	if (normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || parts.some(part => part === '.' || part === '..')) {
		throw new Error(`The archive contains an unsafe path: ${relativePath}`);
	}
	return parts;
}

async function getAvailableChildUri(parentUri: vscode.Uri, requestedName: string): Promise<vscode.Uri> {
	const extensionIndex = requestedName.toLowerCase().endsWith('.zip') ? requestedName.length - 4 : requestedName.length;
	const baseName = requestedName.slice(0, extensionIndex);
	const extension = requestedName.slice(extensionIndex);
	let index = 1;
	let candidate = vscode.Uri.joinPath(parentUri, requestedName);
	while (await uriExists(candidate)) {
		index += 1;
		candidate = vscode.Uri.joinPath(parentUri, `${baseName} ${index}${extension}`);
	}
	return candidate;
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch (error) {
		if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
			return false;
		}
		throw error;
	}
}